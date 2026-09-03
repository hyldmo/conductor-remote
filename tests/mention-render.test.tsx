import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

/**
 * That a file an agent named in a message actually reaches the reader as a link.
 *
 * The matcher next door is pure and pinned; what this covers is the one step between it
 * and the screen, which is a fact about `react-markdown` rather than about our code:
 * inline code arrives at `ChatCode` with **no class**, which is how a mention is told
 * apart from a fenced block. An upgrade that starts labelling inline spans would leave
 * every other test passing and quietly stop linking anything, with nothing on screen to
 * say so.
 *
 * The three browser globals are stubbed rather than pulled in with a DOM package: the
 * chat imports the app's token store, which reads the URL on load, and that is the whole
 * of what this needs a browser for. Static markup, so nothing here needs a document.
 */
const WORKTREE = '/Users/someone/conductor/workspaces/project/berlin'

Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '', pathname: '/', search: '' } })
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
})
Object.defineProperty(globalThis, 'history', { configurable: true, value: { replaceState: () => {} } })

const { Markdown } = await import('../web/src/components/Markdown.tsx')
const { buildResolver, MentionResolverProvider } = await import('../web/src/lib/fileMentions.ts')
const resolve = buildResolver(WORKTREE, ['src/git.ts'])

function render(markdown: string, mentions = true) {
	const chat = <Markdown>{markdown}</Markdown>
	return renderToStaticMarkup(
		mentions ? (
			<MentionResolverProvider value={{ resolveMention: resolve, worktree: WORKTREE }}>{chat}</MentionResolverProvider>
		) : (
			chat
		)
	)
}

describe('a file mention in a message', () => {
	it('renders as a button that opens the source, still drawn as code', () => {
		const html = render('we updated `src/git.ts` today')
		expect(html).toContain(`title="Open ${WORKTREE}/src/git.ts"`)
		expect(html).toContain('<code')
	})

	it('leaves a fenced block alone, even one whose only line is a path', () => {
		// A fence with no info string carries no class either, so its trailing newline is
		// the whole of what tells the two apart.
		expect(render('```\nsrc/git.ts\n```')).not.toContain('title="Open')
		expect(render('```ts\nsrc/git.ts\n```')).not.toContain('title="Open')
	})

	it('resolves only absolute paths where no workspace is on screen', () => {
		// An archived chat, whose worktree is deleted: `~/plan.md` is as readable as ever.
		expect(render('we updated `src/git.ts` today', false)).not.toContain('title="Open')
		expect(render('plan written to `~/plan.md`', false)).toContain('title="Open ~/plan.md"')
	})
})

describe('a link the URL sanitiser emptied', () => {
	// gstack appends `<gstack-qid:{id}>` to a review question believing the angle brackets
	// hide it. CommonMark reads `<scheme:rest>` as an autolink, react-markdown blanks the
	// href because the scheme is unknown, and `href=""` follows to the current page. Both
	// halves of that are facts about other people's code, so this pins the visible result.
	it('is text rather than a tap that reloads the app', () => {
		const html = render('D4 — a question <gstack-qid:plan-eng-review-voice-endpoint>')
		expect(html).toContain('gstack-qid:plan-eng-review-voice-endpoint')
		expect(html).not.toContain('<a')
	})

	it('still draws a link that goes somewhere', () => {
		expect(render('see [the docs](https://conductor.build/docs)')).toContain('href="https://conductor.build/docs"')
	})
})

describe('a local image in Markdown', () => {
	it('marks a project-relative image link for the authenticated preview', () => {
		const html = render('[Desktop QA screenshot](.context/qa/wide.png)')
		expect(html).toContain(`title="Open image ${WORKTREE}/.context/qa/wide.png"`)
	})

	it('intercepts the absolute workspace link agents commonly emit', () => {
		const image = '/Users/someone/conductor/workspaces/project/berlin/.context/qa/desktop.png'
		expect(render(`[Desktop QA screenshot](${image})`)).toContain(`title="Open image ${image}"`)
	})

	it('leaves a remote image link in the browser', () => {
		const html = render('[Screenshot](https://example.com/wide.png)')
		expect(html).toContain('href="https://example.com/wide.png"')
		expect(html).not.toContain('title="Open image')
	})

	it('keeps an archived relative image out of the PWA router', () => {
		const html = render('[Old screenshot](.context/qa/wide.png)', false)
		expect(html).toContain('title="Open image .context/qa/wide.png"')
	})
})
