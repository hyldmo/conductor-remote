import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { isAllowedPreviewPath, parseFileReference, parseImageReference } from '../../src/files/file-preview.ts'

describe('file references', () => {
	test('parses absolute macOS paths and locations', () => {
		expect(
			parseFileReference(
				'/Users/hyldmo/conductor/workspaces/conductor-remote/yeosu/web/src/components/WorkspaceList.tsx:468'
			)
		).toEqual({
			path: '/Users/hyldmo/conductor/workspaces/conductor-remote/yeosu/web/src/components/WorkspaceList.tsx',
			line: 468
		})
		expect(parseFileReference('/Users/hyldmo/conductor/workspaces/conductor-remote/yeosu/package.json')).toEqual({
			path: '/Users/hyldmo/conductor/workspaces/conductor-remote/yeosu/package.json',
			line: null
		})
		expect(parseFileReference('/Users/hyldmo/project/src/app.tsx:19:7')).toEqual({
			path: '/Users/hyldmo/project/src/app.tsx',
			line: 19
		})
	})

	test('expands the home path an agent writes, which the phone cannot', () => {
		expect(parseFileReference('~/.gstack/plan.md:12')).toEqual({
			path: path.join(os.homedir(), '.gstack/plan.md'),
			line: 12
		})
	})

	test.each([
		'/w/a-workspace',
		// Another account's home is not this relay's to expand — and unexpanded it is not a path.
		'~someone/notes.md',
		'~/notes.md/../../../etc/hosts',
		'web/src/app.tsx:19',
		'/Users/hyldmo/project/.env:1',
		'/Users/hyldmo/file.ts:0',
		'/Users/hyldmo/file.ts:9007199254740992'
	])('rejects unsafe or non-file reference %s', reference => {
		expect(parseFileReference(reference)).toBeNull()
	})
})

describe('image references', () => {
	test('accepts absolute raster paths and expands the current home', () => {
		expect(parseImageReference('/Users/hyldmo/conductor/workspaces/project/qa/wide.PNG')).toBe(
			'/Users/hyldmo/conductor/workspaces/project/qa/wide.PNG'
		)
		expect(parseImageReference('~/.context/qa/result.webp')).toBe(path.join(os.homedir(), '.context/qa/result.webp'))
	})

	test.each([
		'qa/result.png',
		'/Users/hyldmo/project/qa/result.svg',
		'/Users/hyldmo/project/qa/result.pdf',
		'/Users/hyldmo/project/qa/result.png:12'
	])('rejects non-raster or non-absolute reference %s', reference => {
		expect(parseImageReference(reference)).toBeNull()
	})
})

describe('preview path access', () => {
	const workspaces = '/Users/hyldmo/conductor/workspaces'
	const home = '/Users/hyldmo'
	const bundledSkills = '/Applications/Conductor.app/Contents/Resources/conductor-skill/skills'

	test('allows workspace files in public mode', () => {
		expect(
			isAllowedPreviewPath(
				'/Users/hyldmo/conductor/workspaces/conductor-remote/yeosu/src/server.ts',
				workspaces,
				home,
				'public'
			)
		).toBe(true)
	})

	test('limits home and bundled skill files to tailnet mode', () => {
		expect(isAllowedPreviewPath('/Users/hyldmo/.gstack/builder-journey.md', workspaces, home, 'public')).toBe(false)
		expect(isAllowedPreviewPath('/Users/hyldmo/.gstack/builder-journey.md', workspaces, home, 'tailnet')).toBe(true)
		expect(
			isAllowedPreviewPath(
				'/Applications/Conductor.app/Contents/Resources/conductor-skill/skills/conductor/SKILL.md',
				workspaces,
				home,
				'tailnet',
				bundledSkills
			)
		).toBe(true)
		expect(
			isAllowedPreviewPath(
				'/Applications/Conductor.app/Contents/Resources/conductor-skill/skills/conductor/SKILL.md',
				workspaces,
				home,
				'public',
				bundledSkills
			)
		).toBe(false)
	})

	test('rejects lookalike workspace prefixes and system files', () => {
		expect(
			isAllowedPreviewPath('/Users/hyldmo-conductor/workspaces/project/src/app.ts', workspaces, home, 'tailnet')
		).toBe(false)
		expect(isAllowedPreviewPath('/etc/config.ts', workspaces, home, 'tailnet')).toBe(false)
	})
})
