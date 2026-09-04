import type { LucideIcon } from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { queryTokens } from './format.ts'

/**
 * The command palette's registry: what ⌘K can run besides finding a chat.
 *
 * Commands are registered by the component that owns them, for as long as it is
 * mounted (`useRegisterCommands`), rather than declared in one central list. The
 * sidebar owns the sheets it opens and the view preferences it edits; the session view
 * owns "Show changes", "New chat" and the workspace's status; and each already holds
 * the setters those need. A central list would have to import every sheet and every
 * piece of state to know whether "New chat" is allowed right now, and it would list
 * workspace actions on a screen with no workspace. The palette reads a flat list from
 * the store and knows nothing about where a command came from.
 *
 * Keys are stable ids, never labels: a label changes with its state ("Show changes"
 * becomes "Hide changes") and is what a person searches by, not what code addresses.
 *
 * Matching uses the app's one tokenizer (`queryTokens`), with the same every-token
 * rule as the live workspace filter: "hide merged" must find the toggle, and so must
 * "merged hide". A label that *starts* with the first word outranks one that merely
 * contains it, and a keyword-only hit comes last, so "logs" lists Relay logs before
 * anything that mentions logs in passing.
 *
 * Shortcuts are matched by one window listener (`useCommandShortcuts`) against this
 * same list, so a chord and a palette row are the same command and cannot disagree.
 * `mod` is ⌘ on Apple platforms and Ctrl elsewhere — and only that one: Ctrl+K on a
 * Mac is the emacs "kill line" a textarea already honours, and the old ⌘K handler took
 * both without meaning to.
 */
export interface Shortcut {
	/** A `KeyboardEvent.key` value, compared case-insensitively. */
	key: string
	/** ⌘ on Apple platforms, Ctrl elsewhere. */
	mod?: boolean
	shift?: boolean
	alt?: boolean
}

export interface Command {
	/** Stable id — `view.hideMerged`, `app.connect`, `workspace.status.done`. */
	id: string
	label: string
	/** Breadcrumb prefix ("View › Hide merged") and section heading; see `GROUP_ORDER`. */
	group?: string
	/** Extra search terms: ['filter', 'pull request', 'pr'] on Hide merged. */
	keywords?: string[]
	icon?: LucideIcon
	shortcut?: Shortcut
	/** Toggle or choice state. Set, the row draws a check and reads as a checkbox item. */
	checked?: boolean
	/** A short note beside the label. */
	detail?: string
	/** False omits the row and silences its shortcut. Default true. */
	enabled?: boolean
	/** Registered for its shortcut alone — the Search command itself is one. */
	hidden?: boolean
	run: () => void | Promise<void>
}

/** Section order in the palette; a group not named here sorts after these. */
export const GROUP_ORDER = ['Workspace', 'View', 'App']

interface CommandState {
	/** Whether the palette (the search sheet) is open. */
	open: boolean
	setOpen: (open: boolean | ((open: boolean) => boolean)) => void
	/** Commands by the source that registered them, in registration order. */
	sources: Record<string, Command[]>
	register: (source: string, commands: Command[]) => void
	unregister: (source: string) => void
}

export const useCommandStore = create<CommandState>(set => ({
	open: false,
	setOpen: open => set(state => ({ open: typeof open === 'function' ? open(state.open) : open })),
	sources: {},
	register: (source, commands) => set(state => ({ sources: { ...state.sources, [source]: commands } })),
	unregister: source =>
		set(state => {
			const { [source]: _gone, ...sources } = state.sources
			return { sources }
		})
}))

function groupRank(command: Command): number {
	const index = GROUP_ORDER.indexOf(command.group ?? '')
	return index === -1 ? GROUP_ORDER.length : index
}

/** Every registered command, sections in `GROUP_ORDER`, registration order within one. */
export function listCommands(sources: Record<string, Command[]>): Command[] {
	return Object.values(sources)
		.flat()
		.map((command, index) => ({ command, index }))
		.sort((a, b) => groupRank(a.command) - groupRank(b.command) || a.index - b.index)
		.map(entry => entry.command)
}

export function useCommands(): Command[] {
	const sources = useCommandStore(s => s.sources)
	return useMemo(() => listCommands(sources), [sources])
}

/**
 * Own `commands` while mounted. Pass a memoised array: the effect keys on its identity,
 * and a fresh array every render would re-register on every poll. Handlers that close
 * over changing state belong behind a ref, not in the memo's dependencies.
 */
export function useRegisterCommands(source: string, commands: Command[]): void {
	const register = useCommandStore(s => s.register)
	const unregister = useCommandStore(s => s.unregister)
	useEffect(() => {
		register(source, commands)
		return () => unregister(source)
	}, [source, commands, register, unregister])
}

/** A leading `>` (the VS Code convention) asks for actions only, and no chat search. */
export function parsePaletteQuery(raw: string): { commandsOnly: boolean; query: string } {
	const trimmed = raw.trimStart()
	if (trimmed.startsWith('>')) return { commandsOnly: true, query: trimmed.slice(1).trim() }
	return { commandsOnly: false, query: raw }
}

/** What a command can be found by. */
function haystack(command: Command): string {
	return [command.group, command.label, ...(command.keywords ?? [])].filter(Boolean).join(' ').toLowerCase()
}

/**
 * The listed commands that match `query`, best first. An empty query lists everything
 * that can be shown — that is the browsable menu. Hidden and disabled commands never
 * appear, whatever the query.
 */
export function matchCommands(commands: Command[], query: string): Command[] {
	const listed = commands.filter(command => !command.hidden && command.enabled !== false)
	const tokens = queryTokens(query)
	if (!tokens.length) return listed
	const ranked: { command: Command; rank: number }[] = []
	for (const command of listed) {
		if (!tokens.every(token => haystack(command).includes(token))) continue
		const label = command.label.toLowerCase()
		const rank = label.startsWith(tokens[0]) ? 0 : tokens.every(token => label.includes(token)) ? 1 : 2
		ranked.push({ command, rank })
	}
	// `sort` is stable, so equal ranks keep the registry's own order.
	return ranked.sort((a, b) => a.rank - b.rank).map(entry => entry.command)
}

/** The modifier state of a keydown, without dragging the DOM's KeyboardEvent into tests. */
export interface KeyChord {
	key: string
	metaKey: boolean
	ctrlKey: boolean
	shiftKey: boolean
	altKey: boolean
}

export function matchesShortcut(chord: KeyChord, shortcut: Shortcut, apple: boolean): boolean {
	if (chord.key.toLowerCase() !== shortcut.key.toLowerCase()) return false
	const mod = !!shortcut.mod
	return (
		chord.metaKey === (apple && mod) &&
		chord.ctrlKey === (!apple && mod) &&
		chord.shiftKey === !!shortcut.shift &&
		chord.altKey === !!shortcut.alt
	)
}

/** The first enabled command — hidden ones included — whose shortcut is this chord. */
export function shortcutTarget(commands: Command[], chord: KeyChord, apple: boolean): Command | undefined {
	return commands.find(
		command => command.enabled !== false && !!command.shortcut && matchesShortcut(chord, command.shortcut, apple)
	)
}

/**
 * Key-cap glyphs for a `<kbd>` row. Apple's own order is ⌃ ⌥ ⇧ ⌘; everything else
 * spells the words out, Ctrl first.
 */
export function formatShortcut(shortcut: Shortcut, apple: boolean): string[] {
	const key = shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key
	if (apple)
		return [...(shortcut.alt ? ['⌥'] : []), ...(shortcut.shift ? ['⇧'] : []), ...(shortcut.mod ? ['⌘'] : []), key]
	return [
		...(shortcut.mod ? ['Ctrl'] : []),
		...(shortcut.alt ? ['Alt'] : []),
		...(shortcut.shift ? ['Shift'] : []),
		key
	]
}

/** Mac, iPhone or iPad — where ⌘ exists. Read off the platform string, guarded for tests. */
export function isApplePlatform(
	nav: { platform?: string; userAgent?: string } | undefined = typeof navigator === 'undefined' ? undefined : navigator
): boolean {
	return /Mac|iPhone|iPad|iPod/i.test(`${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`)
}

function isEditable(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

/**
 * One window listener for every registered shortcut, mounted once at the app shell.
 * A chord carrying ⌘/Ctrl/⌥ fires anywhere, the composer included — that is how ⌘K
 * always behaved. A bare key fires only outside editable elements, or typing "k" into
 * a prompt would open something. The store is read inside the handler, so the listener
 * never rebinds as commands come and go.
 */
export function useCommandShortcuts(): void {
	useEffect(() => {
		const apple = isApplePlatform()
		const onKey = (e: KeyboardEvent) => {
			if (e.isComposing || e.repeat) return
			if (!(e.metaKey || e.ctrlKey || e.altKey) && isEditable(e.target)) return
			const hit = shortcutTarget(listCommands(useCommandStore.getState().sources), e, apple)
			if (!hit) return
			e.preventDefault()
			void hit.run()
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])
}
