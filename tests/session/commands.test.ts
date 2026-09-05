import { describe, expect, test } from 'vitest'
import {
	type Command,
	formatShortcut,
	GROUP_ORDER,
	listCommands,
	matchCommands,
	matchesShortcut,
	parsePaletteQuery,
	shortcutTarget,
	useCommandStore
} from '../../web/src/lib/commands.ts'

/**
 * The command palette's pure half (web/src/lib/commands.ts). Every failure here is
 * silent on screen: a matcher that drops the every-token rule still lists *something*
 * for "hide merged", a shortcut matcher that accepts Ctrl where ⌘ was meant opens the
 * palette on the emacs kill-line a Mac textarea honours, and a registry that forgets
 * `GROUP_ORDER` shuffles the sections without an error anywhere. Chords are plain
 * objects rather than KeyboardEvents so the platform answer can be injected.
 */
const cmd = (over: Partial<Command> & Pick<Command, 'id' | 'label'>): Command => ({ run: () => {}, ...over })

const commands: Command[] = [
	cmd({ id: 'workspace.diff', label: 'Show changes', group: 'Workspace', keywords: ['diff', 'files'] }),
	cmd({
		id: 'view.hideMerged',
		label: 'Hide merged',
		group: 'View',
		keywords: ['filter', 'pull request', 'pr'],
		checked: false
	}),
	cmd({ id: 'view.hideDone', label: 'Hide done', group: 'View', keywords: ['filter', 'status'], checked: true }),
	cmd({ id: 'app.logs', label: 'Relay logs', group: 'App', keywords: ['diagnostics'] }),
	cmd({ id: 'app.search', label: 'Search', group: 'App', hidden: true, shortcut: { key: 'k', mod: true } }),
	cmd({ id: 'view.repos.all', label: 'Show all repos', group: 'View', enabled: false })
]

const chord = (over: Partial<Parameters<typeof matchesShortcut>[0]> = {}) => ({
	key: 'k',
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	...over
})

describe('matchCommands', () => {
	test('an empty query is the menu: every listed command, hidden and disabled left out', () => {
		expect(matchCommands(commands, '').map(c => c.id)).toEqual([
			'workspace.diff',
			'view.hideMerged',
			'view.hideDone',
			'app.logs'
		])
	})

	test('every token must appear, in any order, through any punctuation', () => {
		expect(matchCommands(commands, 'hide merged').map(c => c.id)).toEqual(['view.hideMerged'])
		expect(matchCommands(commands, 'merged hide').map(c => c.id)).toEqual(['view.hideMerged'])
		expect(matchCommands(commands, 'hide-merged').map(c => c.id)).toEqual(['view.hideMerged'])
		expect(matchCommands(commands, 'hide').map(c => c.id)).toEqual(['view.hideMerged', 'view.hideDone'])
		expect(matchCommands(commands, 'hide nothing')).toEqual([])
	})

	test('keywords and the group find a command its label does not name', () => {
		expect(matchCommands(commands, 'pr').map(c => c.id)).toEqual(['view.hideMerged'])
		expect(matchCommands(commands, 'view').map(c => c.id)).toEqual(['view.hideMerged', 'view.hideDone'])
	})

	test('a label that starts with the word outranks one that contains it, which outranks a keyword', () => {
		const list = [
			cmd({ id: 'b', label: 'Hide merged', keywords: ['filter'] }),
			cmd({ id: 'c', label: 'Repo filter' }),
			cmd({ id: 'a', label: 'Filter workspaces' })
		]
		expect(matchCommands(list, 'filter').map(c => c.id)).toEqual(['a', 'c', 'b'])
	})

	test('hidden and disabled commands never match, whatever is typed', () => {
		expect(matchCommands(commands, 'search')).toEqual([])
		expect(matchCommands(commands, 'all repos')).toEqual([])
	})
})

describe('parsePaletteQuery', () => {
	test('a leading > asks for actions only and drops itself from the query', () => {
		expect(parsePaletteQuery('> hide')).toEqual({ commandsOnly: true, query: 'hide' })
		expect(parsePaletteQuery('>')).toEqual({ commandsOnly: true, query: '' })
		expect(parsePaletteQuery('  >logs')).toEqual({ commandsOnly: true, query: 'logs' })
	})

	test('anything else is passed through untouched for the chat search', () => {
		expect(parsePaletteQuery('hide merged ')).toEqual({ commandsOnly: false, query: 'hide merged ' })
		expect(parsePaletteQuery('a > b')).toEqual({ commandsOnly: false, query: 'a > b' })
	})
})

describe('shortcuts', () => {
	const cmdK = { key: 'k', mod: true }

	test('mod is ⌘ on Apple and Ctrl elsewhere, and only that one', () => {
		expect(matchesShortcut(chord({ metaKey: true }), cmdK, true)).toBe(true)
		expect(matchesShortcut(chord({ ctrlKey: true }), cmdK, true)).toBe(false)
		expect(matchesShortcut(chord({ ctrlKey: true }), cmdK, false)).toBe(true)
		expect(matchesShortcut(chord({ metaKey: true }), cmdK, false)).toBe(false)
		expect(matchesShortcut(chord({ metaKey: true, ctrlKey: true }), cmdK, true)).toBe(false)
	})

	test('an extra modifier is a different chord, and the key is case-insensitive', () => {
		expect(matchesShortcut(chord({ metaKey: true, shiftKey: true }), cmdK, true)).toBe(false)
		expect(matchesShortcut(chord({ metaKey: true, key: 'K' }), cmdK, true)).toBe(true)
		expect(matchesShortcut(chord({ metaKey: true, key: 'j' }), cmdK, true)).toBe(false)
	})

	test('a hidden command answers to its chord; a disabled one does not', () => {
		expect(shortcutTarget(commands, chord({ metaKey: true }), true)?.id).toBe('app.search')
		expect(shortcutTarget(commands, chord({ ctrlKey: true }), true)).toBeUndefined()
		const disabled = [cmd({ id: 'x', label: 'X', enabled: false, shortcut: cmdK })]
		expect(shortcutTarget(disabled, chord({ metaKey: true }), true)).toBeUndefined()
	})

	test('key caps follow the platform', () => {
		expect(formatShortcut(cmdK, true)).toEqual(['⌘', 'K'])
		expect(formatShortcut(cmdK, false)).toEqual(['Ctrl', 'K'])
		expect(formatShortcut({ key: 'k', mod: true, shift: true, alt: true }, true)).toEqual(['⌥', '⇧', '⌘', 'K'])
		expect(formatShortcut({ key: 'k', mod: true, shift: true, alt: true }, false)).toEqual([
			'Ctrl',
			'Alt',
			'Shift',
			'K'
		])
		expect(formatShortcut({ key: 'Escape' }, true)).toEqual(['Escape'])
	})
})

describe('registry', () => {
	test('sections follow GROUP_ORDER whatever registered first, then registration order', () => {
		expect(GROUP_ORDER).toEqual(['Workspace', 'View', 'App'])
		const sidebar = [
			cmd({ id: 'app.a', label: 'A', group: 'App' }),
			cmd({ id: 'view.a', label: 'A', group: 'View' }),
			cmd({ id: 'view.b', label: 'B', group: 'View' }),
			cmd({ id: 'misc', label: 'M', group: 'Elsewhere' })
		]
		const workspace = [cmd({ id: 'workspace.a', label: 'A', group: 'Workspace' })]
		expect(listCommands({ sidebar, workspace }).map(c => c.id)).toEqual([
			'workspace.a',
			'view.a',
			'view.b',
			'app.a',
			'misc'
		])
	})

	test('a source owns its commands only while registered', () => {
		const store = useCommandStore.getState()
		store.register('one', [cmd({ id: 'one.a', label: 'A' })])
		store.register('two', [cmd({ id: 'two.a', label: 'A' })])
		expect(listCommands(useCommandStore.getState().sources).map(c => c.id)).toEqual(['one.a', 'two.a'])
		store.register('one', [cmd({ id: 'one.b', label: 'B' })])
		expect(listCommands(useCommandStore.getState().sources).map(c => c.id)).toEqual(['one.b', 'two.a'])
		store.unregister('one')
		expect(listCommands(useCommandStore.getState().sources).map(c => c.id)).toEqual(['two.a'])
		store.unregister('two')
		expect(useCommandStore.getState().sources).toEqual({})
	})

	test('open takes a value or a toggler', () => {
		const store = useCommandStore.getState()
		store.setOpen(true)
		expect(useCommandStore.getState().open).toBe(true)
		useCommandStore.getState().setOpen(open => !open)
		expect(useCommandStore.getState().open).toBe(false)
	})
})
