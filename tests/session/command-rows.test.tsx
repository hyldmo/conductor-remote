import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { CommandResults } from '../../web/src/components/search/CommandResults.tsx'
import type { Command } from '../../web/src/lib/commands.ts'

/**
 * What a palette row says about itself (web/src/components/search/CommandResults.tsx). The
 * sheet's arrow keys find rows by `data-palette-row`, a screen reader tells a toggle
 * from an action by its role and checked state, and the key caps are how anyone learns
 * a shortcut exists. None of that is visible in a screenshot, and all of it typechecks
 * whichever way it is wrong. Static markup, so nothing here needs a document.
 */
const cmd = (over: Partial<Command> & Pick<Command, 'id' | 'label'>): Command => ({ run: () => {}, ...over })

const commands: Command[] = [
	cmd({ id: 'view.hideMerged', label: 'Hide merged', group: 'View', checked: true }),
	cmd({ id: 'view.hideDone', label: 'Hide done', group: 'View', checked: false }),
	cmd({ id: 'app.usage', label: 'Plan usage', group: 'App', shortcut: { key: 'u', mod: true, shift: true } })
]

const render = (grouped: boolean, apple = true) =>
	renderToStaticMarkup(<CommandResults commands={commands} grouped={grouped} apple={apple} onRun={vi.fn()} />)

describe('palette rows', () => {
	test('every row is a focus target the sheet can walk with the arrow keys', () => {
		expect(render(true).match(/data-palette-row=""/g)).toHaveLength(commands.length)
	})

	test('a toggle reads as a checkbox item with its state; an action reads as a plain item', () => {
		const html = render(true)
		expect(html).toContain('role="menuitemcheckbox" aria-checked="true"')
		expect(html).toContain('role="menuitemcheckbox" aria-checked="false"')
		expect(html).toContain('role="menuitem" data-palette-row')
	})

	test('browsing draws one section per group; searching draws the group as a breadcrumb', () => {
		const grouped = render(true)
		expect(grouped.indexOf('>View<')).toBeGreaterThan(-1)
		expect(grouped.indexOf('>View<')).toBeLessThan(grouped.indexOf('>App<'))
		expect(grouped).not.toContain('View › ')
		const flat = render(false)
		expect(flat).toContain('>Actions<')
		expect(flat).toContain('View › ')
		expect(flat).not.toContain('>View<')
	})

	test('key caps follow the platform', () => {
		expect(render(true)).toContain('<kbd')
		expect(render(true)).toMatch(/⇧<\/kbd>.*⌘<\/kbd>.*U<\/kbd>/)
		expect(render(true, false)).toMatch(/Ctrl<\/kbd>.*Shift<\/kbd>.*U<\/kbd>/)
	})

	test('nothing renders for an empty list', () => {
		expect(renderToStaticMarkup(<CommandResults commands={[]} grouped apple onRun={vi.fn()} />)).toBe('')
	})
})
