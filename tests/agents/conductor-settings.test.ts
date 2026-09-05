import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readDefaultEfforts, writeDefaultEfforts } from '../../src/agents/conductor-settings.ts'

const temporaryDirectories: string[] = []

function settingsFile(): string {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-remote-settings-'))
	temporaryDirectories.push(directory)
	return path.join(directory, '.conductor', 'settings.toml')
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true })
})

describe('Conductor default efforts', () => {
	test('reads provider-specific values from ordinary and quoted tables', () => {
		const file = settingsFile()
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(
			file,
			`["models"."claude_code"]
default_effort_level = "max" # keep this note

[models.codex]
default_thinking_level = 'xhigh'
`
		)

		expect(readDefaultEfforts(file)).toEqual({ claude: 'max', codex: 'xhigh' })
	})

	test('updates only the requested values and preserves unrelated settings, comments, and mode', () => {
		const file = settingsFile()
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(
			file,
			`"$schema" = "https://conductor.build/schemas/settings.schema.json"

[models]
default = "codex:gpt-5.6-sol"

[models.codex]
default_thinking_level = "high" # phone default
review_thinking_level = "max"

[models.claude_code]
default_effort_level = 'medium'
review_effort_level = "xhigh"
`
		)
		fs.chmodSync(file, 0o640)

		expect(writeDefaultEfforts({ claude: 'max', codex: 'ultracode' }, file)).toEqual({
			claude: 'max',
			codex: 'ultracode'
		})
		const saved = fs.readFileSync(file, 'utf8')
		expect(saved).toContain('default = "codex:gpt-5.6-sol"')
		expect(saved).toContain('default_thinking_level = "ultracode" # phone default')
		expect(saved).toContain('review_thinking_level = "max"')
		expect(saved).toContain('default_effort_level = "max"')
		expect(saved).toContain('review_effort_level = "xhigh"')
		expect(fs.statSync(file).mode & 0o777).toBe(0o640)
	})

	test('creates a valid user settings file and adds a missing provider table', () => {
		const file = settingsFile()
		writeDefaultEfforts({ claude: 'high', codex: 'xhigh' }, file)

		const saved = fs.readFileSync(file, 'utf8')
		expect(saved).toContain('"$schema" = "https://conductor.build/schemas/settings.schema.json"')
		expect(saved).toContain('[models.claude_code]\ndefault_effort_level = "high"')
		expect(saved).toContain('[models.codex]\ndefault_thinking_level = "xhigh"')
		expect(readDefaultEfforts(file)).toEqual({ claude: 'high', codex: 'xhigh' })
		expect(fs.statSync(file).mode & 0o777).toBe(0o600)
	})

	test('rejects an unknown value without changing the file', () => {
		const file = settingsFile()
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, '[models.codex]\ndefault_thinking_level = "high"\n')
		const before = fs.readFileSync(file, 'utf8')

		expect(() =>
			writeDefaultEfforts({ codex: 'invented' as Parameters<typeof writeDefaultEfforts>[0]['codex'] }, file)
		).toThrow(/unknown Codex default effort/i)
		expect(fs.readFileSync(file, 'utf8')).toBe(before)
	})

	test('fails closed instead of duplicating a key it cannot safely preserve', () => {
		const file = settingsFile()
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, '[models.codex]\ndefault_thinking_level = value_from_somewhere\n')

		expect(() => writeDefaultEfforts({ codex: 'high' }, file)).toThrow(/could not safely update/)
		expect(fs.readFileSync(file, 'utf8')).toContain('value_from_somewhere')
	})
})
