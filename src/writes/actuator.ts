import { CONDUCTOR_HANDLERS, osaError, runCeiling, SEND_ATTEMPT_MS } from './runner.ts'
import { sidecarAvailable, sidecarSendUserMessage } from './sidecar.ts'
import { withTargetEnvironment } from './targeting.ts'
import type { Actuator, ActuatorInfo, PromptSendOptions, SendResult, SendTarget, WriteStrategy } from './types.ts'
import { exec, uiTurn } from './ui-lock.ts'

/**
 * The sidecar IPC path — the precise, per-session write. Delivers straight to
 * `sessionId` over Conductor's own dispatch socket (see src/writes/sidecar.ts), so it needs
 * no window focus and the app UI reflects the turn correctly.
 *
 * Opt-in (WRITE_STRATEGY=sidecar) because it speaks a private, versioned IPC and
 * hasn't been validated by an automated live send (that would inject a prompt
 * into a running agent). It is the intended default once you've confirmed it on
 * your setup.
 */
export class SidecarActuator implements Actuator {
	readonly name = 'sidecar'
	readonly caveat =
		'Delivered straight to the target session over Conductor’s dispatch socket — precise per-workspace targeting.'
	readonly precise = true

	available(): Promise<boolean> {
		return sidecarAvailable()
	}

	/** `deadline` is ignored — the sidecar is one socket write, with no UI to wait on. */
	async send(target: SendTarget, text: string, options: PromptSendOptions = {}): Promise<SendResult> {
		const sessionId = target.sessionId ?? target.workspace.active_session_id
		if (!sessionId) return { ok: false, strategy: this.name, error: 'no session id to target' }
		try {
			await sidecarSendUserMessage(sessionId, text, options.queue ? 'queue' : 'default')
			return { ok: true, strategy: this.name }
		} catch (err) {
			return { ok: false, strategy: this.name, error: err instanceof Error ? err.message : String(err) }
		}
	}
}

/**
 * Drives Conductor's real send path via macOS Accessibility (AppleScript): focus
 * the target workspace, paste the prompt, press Enter. Uses whatever model /
 * permission mode the session already has (zero risk of altering the agent),
 * which is why it's the default.
 *
 * Precise targeting comes from opening Conductor's own workspace link first
 * (`conductor://workspace?id=…&session=…`, see `workspaceLink`) and then
 * confirming the pane and the chat tab through Accessibility (see
 * src/writes/applescript/), so the prompt lands in the right session regardless
 * of what was focused. The link is public and id-addressed; the AX reads only
 * check it, and pressing the sidebar row or the command palette remains the
 * fallback for a Conductor that doesn't answer it.
 */
export class AppleScriptActuator implements Actuator {
	readonly name = 'applescript'
	readonly caveat = "Opens the target workspace's own Conductor link, then confirms the chat tab before sending."
	readonly precise = true

	async send(target: SendTarget, text: string, options: PromptSendOptions = {}): Promise<SendResult> {
		const deadline = options.deadline ?? Date.now() + SEND_ATTEMPT_MS
		// Open the target workspace's own link, confirm its chat tab, fill the composer, send.
		// Filling is an Accessibility write (no keystrokes, no clipboard); the
		// clipboard paste is kept only as a fallback, and stashes/restores around it.
		//
		// The send is then read back rather than assumed (`submitComposer`): Conductor
		// consumes the draft when it takes a prompt, so a composer that still holds the
		// text is an Enter that went nowhere, and pressing again inside this run costs
		// under a second. Left to `deliverPrompt` the same failure costs the 6s confirm
		// window plus a whole second run, which is the ~10s of prompt-sitting-on-screen
		// this Mac's logs recorded. A composer that survives three presses is stuck on
		// something the script can't see, so it errors and lets that retry take over.
		const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
set promptText to my normalizeNewlines(do shell script "cat" & " " & quoted form of (system attribute "RELAY_PROMPT_FILE"))
set textBox to my composerField()
if not (my fillComposer(textBox, promptText)) then
	set savedClipboard to the clipboard
	my pasteComposer()
	delay 0.1
	set the clipboard to savedClipboard
end if
set presses to my submitComposer(textBox, promptText, (system attribute "RELAY_QUEUE_PROMPT") is "1")
if presses is 0 then error "Conductor ignored Enter - the prompt is still sitting in its composer"
return "presses:" & presses
`.trim()
		// Pass the prompt via a temp file + env to avoid AppleScript string escaping.
		const os = await import('node:os')
		const fs = await import('node:fs/promises')
		const path = await import('node:path')
		const tmp = path.join(os.tmpdir(), `relay-prompt-${process.pid}-${Date.now()}.txt`)
		await fs.writeFile(tmp, text, 'utf8')
		try {
			const { stdout } = await withTargetEnvironment(target, targetEnvironment =>
				uiTurn(() =>
					exec('osascript', ['-e', script], {
						env: {
							...process.env,
							RELAY_PROMPT_FILE: tmp,
							RELAY_QUEUE_PROMPT: options.queue ? '1' : '',
							...targetEnvironment
						},
						timeout: runCeiling(deadline)
					})
				)
			)
			// A rescued send is otherwise indistinguishable from one that worked first
			// time, so the failure would leave the log whether it was fixed or hidden.
			const presses = Number(stdout.match(/presses:(\d+)/)?.[1] ?? 1)
			if (presses > 1) {
				console.warn(`[relay] Conductor ignored Enter — the composer cleared on press ${presses}`)
			}
			return { ok: true, strategy: this.name }
		} catch (err) {
			return { ok: false, strategy: this.name, error: osaError(err) }
		} finally {
			await fs.rm(tmp, { force: true }).catch(() => undefined)
		}
	}
}

export function pickActuator(strategy: WriteStrategy): Actuator {
	return strategy === 'sidecar' ? new SidecarActuator() : new AppleScriptActuator()
}

/** Effective actuator description for the UI, factoring in runtime availability. */
export async function describeActuator(actuator: Actuator): Promise<ActuatorInfo> {
	const available = actuator.available ? await actuator.available().catch(() => false) : true
	return { name: actuator.name, caveat: actuator.caveat, precise: actuator.precise, available }
}
