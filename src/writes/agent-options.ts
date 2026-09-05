import { modelPickerLabel } from '../shared.ts'
import { CONDUCTOR_HANDLERS, osaError, SEND_ATTEMPT_MS } from './runner.ts'
import { withTargetEnvironment } from './targeting.ts'
import type { SendResult, SendTarget } from './types.ts'
import { exec, uiTurn } from './ui-lock.ts'

/**
 * Conductor stores the effort level in a provider-specific session column
 * (`codex_thinking_level` or `claude_effort_level`), normalized by Reads onto the
 * relay's stable wire field. The composer button is labelled with the human name
 * and *cycles* through these values, so both directions are needed: the label to
 * press toward, and the normalized DB value to confirm against.
 */
export const EFFORT_LABELS: Record<string, string> = {
	none: 'None',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
	ultracode: 'Ultracode'
}

const CODEX_EFFORT_LABELS: Record<string, string> = {
	none: '__UNNAMED_EFFORT__',
	low: 'Light',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
	ultracode: 'Ultra'
}

/** Translate the stable wire value to the provider's measured composer label. */
export function effortUiLabel(effort: string, agentType?: string | null): string | undefined {
	if (agentType === 'codex') return CODEX_EFFORT_LABELS[effort]
	if (agentType === 'claude' && effort !== 'none') return EFFORT_LABELS[effort]
	return undefined
}

/** What a phone can change about the agent before (or instead of) sending a prompt. */
export interface AgentOptions {
	/** A normalized effort value (none, low…ultracode), not the UI label. */
	effort?: string
	plan?: boolean
	/** Fast mode exposes no readable state, so pass `true` only when it must flip. */
	toggleFast?: boolean
	/** The model picker's menu label, e.g. "Opus 5" or "Sonnet 4.6". */
	model?: string
	/** Current provider after any model-only pass; used for provider-specific labels. */
	agentType?: string | null
}

/**
 * A boolean patch says what state the caller wants, not that the matching UI
 * control must be pressed. Avoid looking for Plan when Conductor already records
 * the requested mode — some models do not render that control at all when it is
 * off. Unknown state remains fail-closed and is sent through to the actuator.
 */
export function planSettingForUi(
	wanted: boolean | undefined,
	currentPermissionMode: string | null | undefined
): boolean | undefined {
	if (wanted === undefined) return undefined
	return currentPermissionMode === (wanted ? 'plan' : 'default') ? undefined : wanted
}

/**
 * Apply agent settings to a specific chat: focus its workspace and tab (same
 * verified path as a send), then drive the composer's own controls. Every step
 * confirms the control landed on the requested value and errors out otherwise,
 * so a half-applied change is reported rather than assumed.
 */
export async function setAgentOptions(target: SendTarget, opts: AgentOptions): Promise<SendResult> {
	if (opts.effort && !effortUiLabel(opts.effort, opts.agentType)) {
		return { ok: false, strategy: 'applescript', error: `unknown effort level ${opts.effort}` }
	}
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my applyAgentOptions()
return "ok"`.trim()
	try {
		await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: {
						...process.env,
						...targetEnvironment,
						RELAY_SET_EFFORT: opts.effort ? effortUiLabel(opts.effort, opts.agentType) : '',
						RELAY_SET_PLAN: opts.plan === undefined ? '' : opts.plan ? '1' : '0',
						RELAY_SET_FAST: opts.toggleFast ? '1' : '',
						RELAY_SET_MODEL: opts.model ?? ''
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

export interface DefaultModelResult extends SendResult {
	/** The exact picker label Conductor starred (temporary NEW badge removed). */
	model?: string
}

/**
 * Star one picker row as Conductor's user-wide default model.
 *
 * The desktop exposes this as a child button named "Set … as default and select",
 * so this deliberately has both effects: it changes the global default and selects
 * that model for `target`. The AppleScript reopens the picker and reads the unique
 * starred row back before this reports success.
 */
export async function setDefaultModel(target: SendTarget, model: string): Promise<DefaultModelResult> {
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
return my setDefaultModel(system attribute "RELAY_DEFAULT_MODEL")`.trim()
	try {
		const { stdout } = await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment, RELAY_DEFAULT_MODEL: model },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		const selected = modelPickerLabel(stdout.trim())
		if (!selected) return { ok: false, strategy: 'applescript', error: 'Conductor returned no default model' }
		return { ok: true, strategy: 'applescript', model: selected }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

export interface ModelMenuResult {
	ok: boolean
	models?: string[]
	/** The picker row whose star is selected. */
	defaultModel?: string
	error?: string
}

const DEFAULT_MODEL_LINE = '__CONDUCTOR_DEFAULT_MODEL__\t'

/** Turn listModels' tagged line protocol into the live picker state. Exported for its parser tests. */
export function parseModelMenuOutput(stdout: string): Pick<ModelMenuResult, 'models' | 'defaultModel'> {
	let defaultModel: string | undefined
	const models: string[] = []
	for (const raw of stdout.split('\n')) {
		const line = raw.trim()
		if (!line) continue
		if (line.startsWith(DEFAULT_MODEL_LINE)) {
			defaultModel = modelPickerLabel(line.slice(DEFAULT_MODEL_LINE.length).trim()) || undefined
			continue
		}
		models.push(modelPickerLabel(line))
	}
	return { models: [...new Set(models.filter(Boolean))], defaultModel }
}

/** The model labels Conductor is currently offering, plus its starred default. */
export async function listAgentModels(target: SendTarget): Promise<ModelMenuResult> {
	const script = `
${CONDUCTOR_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
return my listModels()`.trim()
	try {
		const { stdout } = await withTargetEnvironment(target, targetEnvironment =>
			uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, ...targetEnvironment },
					timeout: SEND_ATTEMPT_MS
				})
			)
		)
		return { ok: true, ...parseModelMenuOutput(stdout) }
	} catch (err) {
		return { ok: false, error: osaError(err) }
	}
}
