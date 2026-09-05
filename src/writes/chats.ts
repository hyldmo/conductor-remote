import type { Workspace } from '../reads/types.ts'
import { MAC_LOCKED } from '../shared.ts'
import { screenLocked } from './guards.ts'
import { CONDUCTOR_HANDLERS, osaError, SEND_ATTEMPT_MS } from './runner.ts'
import { focusQuery, withTargetEnvironment, workspaceLink } from './targeting.ts'
import type { SendResult, SendTarget } from './types.ts'
import { exec, uiTurn } from './ui-lock.ts'

/**
 * Stop the answer a chat is streaming — the desktop app's stop button, reached
 * through the same focus-and-assert path as a send and then Conductor's own
 * "Cancel agent" shortcut (see `cancelAgent` in src/writes/applescript/lifecycle.applescript for why a
 * keystroke rather than the button).
 *
 * The branch is required rather than optional. Everywhere else a workspace with
 * no branch merely loses the pane assertion; here that assertion is the only thing
 * standing between "stop this agent" and "throw away a different agent's turn", so
 * a target that can't be checked is refused instead of aimed.
 *
 * Nothing is confirmed here: `sessions.status` leaving `working` is the receipt and
 * src/http/routes/sessions.ts waits for it, the same way agent settings are confirmed against the DB
 * rather than against the UI that was just driven.
 */
export async function stopTurn(target: SendTarget): Promise<SendResult> {
	if (!target.workspace.branch) {
		return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my cancelAgent()
return "ok"`.trim()
	try {
		await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Hide one chat through Conductor's own Close tab action (Command-W).
 *
 * Like `stopTurn`, the branch is required because Command-W acts on whatever has
 * keyboard focus. `selectChatTab` proves the target and `closeChatTab` moves focus
 * back out of the terminal before pressing it. Closing is reversible in Conductor,
 * but a running chat still gets its desktop confirmation: `closeRunning` is the
 * caller's explicit answer to that prompt, never something this layer infers.
 *
 * The script only reports that it pressed the action. `sessions.is_hidden` is the
 * receipt; src/http/routes/sessions.ts waits until `Reads.listSessions` no longer returns this id.
 */
export async function closeChat(target: SendTarget, closeRunning: boolean): Promise<SendResult> {
	if (!target.workspace.branch) {
		return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my closeChatTab()
return "ok"`.trim()
	try {
		await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: {
						...process.env,
						...targetEnvironment,
						RELAY_CLOSE_RUNNING: closeRunning ? '1' : ''
					},
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/**
 * Conductor's workspace route restores a hidden session before selecting it.
 * Keep the UI lease through the DB receipt: another focus operation must not
 * navigate away while Conductor's asynchronous route handler is unhiding it.
 * The callback is deliberately exact-id and read-only, supplied by the server.
 */
export async function restoreChat(
	workspaceId: string,
	sessionId: string,
	isVisible: () => boolean
): Promise<SendResult & { alreadyOpen?: boolean }> {
	return uiTurn(async () => {
		if (isVisible()) return { ok: true, strategy: 'deep-link', alreadyOpen: true }
		if ((await screenLocked()) === true) {
			return { ok: false, strategy: 'deep-link', error: `${MAC_LOCKED}. Unlock it, then try again.` }
		}
		try {
			await exec('open', [workspaceLink(workspaceId, sessionId)], { timeout: 5_000 })
			for (let attempt = 0; attempt < 40; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 250))
				if (isVisible()) return { ok: true, strategy: 'deep-link' }
			}
			return {
				ok: false,
				strategy: 'deep-link',
				error: 'Conductor has not restored this tab yet. Try again, or update Conductor on your Mac.'
			}
		} catch (error) {
			return { ok: false, strategy: 'deep-link', error: osaError(error) }
		}
	})
}

/**
 * Open a new chat in the target workspace — Conductor's "New chat, same files"
 * (Cmd+T). Focuses the workspace first (its own link, see `workspaceLink`), then
 * Cmd+T; the caller detects the freshly-created session id from the DB.
 *
 * The pane is asserted before the keystroke for the same reason a send asserts before
 * typing: `focusWorkspace` confirms every route it takes except its last one, the
 * palette, and Cmd+T against an unconfirmed pane opens a tab in someone else's
 * workspace. Nothing catches that afterwards — the caller looks for the new session in
 * *this* workspace's tab list, so a stray tab reads as "the id could not be read back"
 * while sitting in a conversation nobody asked to change.
 *
 * Cmd+L ("Focus chat input") goes first for the reason `cancelAgent` does the same: a
 * keystroke lands wherever focus is, and a focused terminal panel swallows this one.
 * Measured live before the fix — the run reported success, `sessions` gained nothing,
 * and `terminal_sessions` gained a row in this very workspace at the second the chord
 * was sent. Both chords are Conductor's own, confirmed against its Cmd+/ dialog.
 */
export async function newChat(workspace: Workspace): Promise<SendResult> {
	if (!focusQuery(workspace)) return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
set strips to my tabGroups()
if (count of strips) is 0 then error "couldn't find the chat pane to open a tab in"
my assertWorkspace(item 1 of strips)
tell application "System Events"
	keystroke "l" using {command down}
	delay 0.2
	keystroke "t" using {command down}
end tell`.trim()
	try {
		// Shares the focus path with a send, so it needs the same ceiling: 15s was under
		// the cost of activating a cold Conductor and finding the row on its own.
		await withTargetEnvironment({ workspace, sessionId: null }, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}
