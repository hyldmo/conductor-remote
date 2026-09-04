import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { FileIcon, FolderIcon } from '../web/src/components/FileIcon.tsx'
import { fileIconForPath, folderIconForPath } from '../web/src/lib/file-icons.ts'

describe('file icon resolver', () => {
	test.each([
		['src/App.tsx', 'react-typescript'],
		['src/Legacy.jsx', 'react-javascript'],
		['src/server.MTS', 'typescript'],
		['src/globals.d.ts', 'typescript-definition'],
		['scripts/release.mjs', 'javascript'],
		['styles/app.scss', 'sass'],
		['schema.graphql', 'graphql'],
		['public/mark.svg', 'svg'],
		['db/schema.prisma', 'prisma'],
		['infra/main.tf', 'terraform']
	])('maps %s to the %s icon', (path, name) => {
		expect(fileIconForPath(path).name).toBe(name)
	})

	test.each([
		['vite.config.ts', 'vite'],
		['vitest.config.ts', 'vitest'],
		['configs/tsconfig.web.json', 'typescript'],
		['pnpm-lock.yaml', 'pnpm'],
		['docker/Dockerfile.dev', 'docker'],
		['docs/README', 'markdown'],
		['.env.local', 'env'],
		['Cargo.lock', 'cargo'],
		['biome.json', 'biome'],
		['CMakeLists.txt', 'cmake']
	])('lets the filename-specific %s rule override its extension', (path, name) => {
		expect(fileIconForPath(path).name).toBe(name)
	})

	test('returns the packaged default artwork for unknown and extensionless files', () => {
		const unknown = fileIconForPath('NOTICE.custom-extension')
		expect(unknown.name).toBe('file')
		expect(unknown.icon.body).toContain('<path')
		expect(fileIconForPath('src/mystery')).toBe(unknown)
	})

	test('uses the multicolor vscode-icons SVG data', () => {
		const typescript = fileIconForPath('src/index.ts').icon
		expect(typescript).toMatchObject({ width: 32, height: 32 })
		expect(typescript.body.toLowerCase()).toContain('#007acc')
	})
})

describe('folder icon resolver', () => {
	test.each([
		['web/src', 'src'],
		['web/components', 'component'],
		['tests', 'test'],
		['public', 'public'],
		['.github', 'github'],
		['src/hooks', 'hook'],
		['src/lib', 'library']
	])('maps %s to the %s folder artwork', (path, name) => {
		expect(folderIconForPath(path).name).toBe(name)
	})

	test('has distinct open and closed artwork with a stable fallback', () => {
		const src = folderIconForPath('src')
		expect(src.closedIcon.body).not.toBe(src.openedIcon.body)
		expect(folderIconForPath('something-unusual').name).toBe('folder')
	})
})

describe('icon components', () => {
	test('renders a compact decorative SVG that callers can size', () => {
		const html = renderToStaticMarkup(<FileIcon path="src/index.ts" className="size-5 extra" />)

		expect(html).toContain('<svg')
		expect(html).toContain('data-file-icon="typescript"')
		expect(html).toContain('aria-hidden="true"')
		expect(html).toContain('size-5 extra')
		expect(html).toContain('<path')
		expect(html).not.toContain('seti-file-icon')
	})

	test('selects opened folder artwork from component state', () => {
		const html = renderToStaticMarkup(<FolderIcon path="src" expanded />)

		expect(html).toContain('data-folder-icon="src"')
		expect(html).toContain('data-folder-expanded="true"')
		expect(html).toContain('<path')
	})
})
