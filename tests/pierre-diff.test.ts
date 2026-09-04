import { describe, expect, test } from 'vitest'
import { bundledLanguages, createHighlighter } from '../web/src/lib/pierre-shiki.ts'
import { pierreThemes } from '../web/src/lib/pierre-themes.ts'

describe('Pierre diff syntax highlighting', () => {
	test('loads a scoped grammar and emits themed TypeScript tokens', async () => {
		const highlighter = await createHighlighter({ themes: [], langs: ['text'] })
		try {
			const descriptor = pierreThemes.getTheme('pierre-dark')
			expect(descriptor).toBeDefined()
			const [{ default: typescript }, loadedTheme] = await Promise.all([
				bundledLanguages.typescript(),
				descriptor!.load()
			])
			const theme = 'default' in loadedTheme ? loadedTheme.default : loadedTheme
			highlighter.loadLanguageSync(typescript)
			highlighter.loadThemeSync(theme)

			const html = highlighter.codeToHtml('const answer: number = 42', {
				lang: 'typescript',
				theme: 'pierre-dark'
			})

			expect(html).toMatch(/<span style="color:[^"]+">const<\/span>/)
			expect(html.match(/<span style="color:/g)?.length).toBeGreaterThan(2)
		} finally {
			highlighter.dispose()
		}
	})
})
