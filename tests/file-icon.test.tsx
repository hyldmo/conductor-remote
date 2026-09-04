import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { FileIcon } from '../web/src/components/FileIcon.tsx'
import { fileIconForPath } from '../web/src/lib/file-icons.ts'

describe('file icon resolver', () => {
	test.each([
		['src/App.tsx', 'react'],
		['src/server.MTS', 'typescript'],
		['scripts/release.mjs', 'javascript'],
		['styles/app.scss', 'sass'],
		['schema.graphql', 'graphql'],
		['public/mark.svg', 'svg'],
		['db/schema.prisma', 'prisma']
	])('maps %s to the %s icon', (path, name) => {
		expect(fileIconForPath(path).name).toBe(name)
	})

	test.each([
		['vite.config.ts', 'vite'],
		['configs/tsconfig.web.json', 'typescript'],
		['pnpm-lock.yaml', 'pnpm'],
		['docker/Dockerfile.dev', 'docker'],
		['docs/README', 'info'],
		['.env.local', 'env'],
		['Cargo.lock', 'rust']
	])('lets the filename-specific %s rule override its extension', (path, name) => {
		expect(fileIconForPath(path).name).toBe(name)
	})

	test('returns a stable neutral fallback for unknown and extensionless files', () => {
		expect(fileIconForPath('NOTICE.custom-extension')).toMatchObject({ name: 'file', glyph: '\uE023' })
		expect(fileIconForPath('src/mystery')).toBe(fileIconForPath('NOTICE.custom-extension'))
	})

	test('uses VS Code Seti glyphs and its light/dark palette', () => {
		expect(fileIconForPath('src/App.tsx')).toMatchObject({
			glyph: '\uE07D',
			color: 'light-dark(#498ba7, #519aba)'
		})
		expect(fileIconForPath('src/index.ts').glyph).toBe('\uE099')
	})
})

describe('FileIcon', () => {
	test('renders a compact decorative icon that callers can size', () => {
		const html = renderToStaticMarkup(<FileIcon path="src/index.ts" className="size-4 extra" />)

		expect(html).toContain('data-file-icon="typescript"')
		expect(html).toContain('aria-hidden="true"')
		expect(html).toContain('seti-file-icon')
		expect(html).toContain('size-4 extra')
		expect(html).toContain(`>${'\uE099'}</span>`)
	})
})
