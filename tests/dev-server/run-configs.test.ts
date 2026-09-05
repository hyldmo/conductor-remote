import { describe, expect, test } from 'vitest'
import { resolveRunConfigs } from '../../src/dev-server/run-configs.ts'

describe('Conductor Run configs', () => {
	test('lists visible local named scripts in settings order', () => {
		expect(
			resolveRunConfigs([
				`[scripts.run.web]
command = "pnpm web"
default = true

[scripts.run."api-worker"]
command = "pnpm worker"
available_in = [
  "local",
  "cloud",
]

[scripts.run.cloud]
command = "pnpm cloud"
available_in = "cloud"

[scripts.run.hidden]
command = "pnpm hidden"
hide = true
`
			])
		).toEqual([
			{ id: 'web', name: 'Web' },
			{ id: 'api-worker', name: 'Api Worker' }
		])
	})

	test('merges matching IDs across settings layers', () => {
		expect(
			resolveRunConfigs([
				`[scripts.run.web]
command = "pnpm web"

[scripts.run.test]
command = "pnpm test"
`,
				`[scripts.run.web]
hide = true

[scripts.run.worker]
command = "pnpm worker"
`
			])
		).toEqual([
			{ id: 'test', name: 'Test' },
			{ id: 'worker', name: 'Worker' }
		])
	})

	test('ignores table-looking shell lines inside multiline commands', () => {
		expect(
			resolveRunConfigs([
				`[scripts.run.dev]
command = """
echo ready
[scripts.run.not-a-task]
command = "also shell text"
"""
`
			])
		).toEqual([{ id: 'dev', name: 'Dev' }])
	})

	test('accepts one-line multiline strings and comments inside arrays', () => {
		expect(
			resolveRunConfigs([
				`[scripts.run.web]
command = """pnpm web"""
available_in = [
  "local", # this task is visible here
  "cloud",
]
`
			])
		).toEqual([{ id: 'web', name: 'Web' }])
	})

	test('a higher named setting replaces a legacy run string', () => {
		expect(
			resolveRunConfigs([
				`[scripts]
run = "pnpm dev"
`,
				`[scripts.run.web]
command = "pnpm web"
`
			])
		).toEqual([{ id: 'web', name: 'Web' }])
	})

	test('legacy and absent settings keep the existing implicit Run behavior', () => {
		expect(resolveRunConfigs(['[scripts]\nrun = "pnpm dev"\n'])).toEqual([])
		expect(resolveRunConfigs(['[scripts]\nsetup = "pnpm install"\n'])).toEqual([])
	})
})
