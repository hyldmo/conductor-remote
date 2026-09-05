import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { describe, expect, test } from 'vitest'
import { readConductorAppleScript } from '../../src/writes/applescript/source.ts'
import { withTargetEnvironment } from '../../src/writes/targeting.ts'
import type { SendTarget } from '../../src/writes/types.ts'

const appleScript = readConductorAppleScript()
const target = {
	workspace: {
		id: 'workspace-1',
		workspace_name: 'Palette — query',
		pr_title: 'Sidebar — title',
		branch: 'feature/utf8-query',
		directory_name: 'unicode-ø',
		repo_name: 'repo-name'
	} as SendTarget['workspace'],
	sessionId: 'session-1',
	tab: { index: 2, count: 3, title: 'Chat — title' }
} satisfies SendTarget

const targetText = [
	'Chat — title',
	'feature/utf8-query',
	'Palette — query',
	'Sidebar — title',
	'Utf8 query',
	'unicode-ø'
].join('\n')

describe('UTF-8 AppleScript target transport', () => {
	test('writes non-ASCII labels to a temporary target file and cleans it up', async () => {
		let targetFile = ''
		await withTargetEnvironment(target, async environment => {
			targetFile = environment.RELAY_TARGET_FILE
			expect(targetFile).not.toBe('')
			expect(fs.readFileSync(targetFile, 'utf8')).toBe(targetText)
			for (const name of ['RELAY_TAB_TITLE', 'RELAY_WS_QUERY', 'RELAY_WS_TITLES']) {
				expect(environment[name]).toBeUndefined()
			}
			expect(environment).toMatchObject({
				RELAY_WS_BRANCH: 'feature/utf8-query',
				RELAY_WS_REPO: 'repo-name',
				RELAY_TAB_INDEX: '2'
			})
			expect(environment.RELAY_WS_LINK).toMatch(/^conductor:\/\//)

			if (process.platform === 'darwin') {
				const output = execFileSync(
					'osascript',
					['-e', 'return do shell script "cat " & quoted form of (system attribute "RELAY_TARGET_FILE")'],
					{ encoding: 'utf8', env: { ...process.env, RELAY_TARGET_FILE: targetFile } }
				)
					.replace(/\r\n?/g, '\n')
					.trimEnd()
				expect(output).toBe(targetText)

				const readField = (expression: string): string =>
					execFileSync('osascript', ['-e', `${appleScript}\nreturn ${expression}`], {
						encoding: 'utf8',
						env: { ...process.env, RELAY_TARGET_FILE: targetFile }
					})
						.replace(/\r\n?/g, '\n')
						.trimEnd()
				expect(readField('my targetField(1)')).toBe('Chat — title')
				expect(readField('my targetField(2)')).toBe('feature/utf8-query')
				expect(readField('item 1 of (my targetSidebarTitles())')).toBe('Palette — query')
			}
		})
		expect(fs.existsSync(targetFile)).toBe(false)
	})

	test('cleans the target file after a failed UI action', async () => {
		let targetFile = ''
		await expect(
			withTargetEnvironment(target, async environment => {
				targetFile = environment.RELAY_TARGET_FILE
				throw new Error('test failure')
			})
		).rejects.toThrow('test failure')
		expect(fs.existsSync(targetFile)).toBe(false)
	})

	test('keeps non-ASCII labels out of AppleScript environment attributes', () => {
		expect(appleScript).toMatch(/system attribute "RELAY_TARGET_FILE"/)
		for (const name of ['RELAY_TAB_TITLE', 'RELAY_WS_QUERY', 'RELAY_WS_TITLES']) {
			expect(appleScript).not.toMatch(new RegExp(`system attribute "${name}"`))
		}
		for (const name of ['RELAY_WS_BRANCH', 'RELAY_WS_REPO']) {
			expect(appleScript).toMatch(new RegExp(`system attribute "${name}"`))
		}
	})
})
