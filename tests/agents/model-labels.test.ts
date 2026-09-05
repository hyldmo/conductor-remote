import { describe, expect, test } from 'vitest'
import {
	displayedModelPickerLabel,
	groupModelPickerLabels,
	modelAgentType,
	modelCatalogIncludes,
	modelPickerLabel
} from '../../src/shared.ts'

describe('model picker labels', () => {
	test.each([
		['Opus 5 NEW', 'Opus 5'],
		['Sonnet 4.6', 'Sonnet 4.6'],
		['Sonnet 4.6 1M', 'Sonnet 4.6 1M'],
		['NEW Model', 'NEW Model']
	])('normalizes %s to %s', (input, expected) => {
		expect(modelPickerLabel(input)).toBe(expected)
	})

	test('shortens the redundant OpenCode prefix for display only', () => {
		expect(displayedModelPickerLabel('opencode-go/grok-4.6')).toBe('go/grok-4.6')
		expect(displayedModelPickerLabel('opencode/muse-space')).toBe('opencode/muse-space')
	})

	test('groups models by provider', () => {
		const groups = groupModelPickerLabels([
			'5.6 Terra',
			'Auto',
			'Composer 2.5',
			'Fable 5',
			'Grok 4.6',
			'Haiku 4.5',
			'Opus 5',
			'Sonnet 4.6',
			'opencode-go/grok-4.5',
			'openai/gpt-5.4',
			'unknown-model'
		])
		expect(Object.fromEntries(groups.map(group => [group.label, group.models]))).toEqual({
			Anthropic: ['Fable 5', 'Haiku 4.5', 'Opus 5', 'Sonnet 4.6'],
			Cursor: ['Composer 2.5', 'Grok 4.6'],
			OpenAI: ['5.6 Terra', 'Auto', 'openai/gpt-5.4'],
			OpenCode: ['opencode-go/grok-4.5'],
			Other: ['unknown-model']
		})
	})

	test.each([
		['Fable 5', 'claude'],
		['5.6 Terra', 'codex'],
		['Composer 2.5', 'cursor'],
		['opencode-go/grok-4.5', 'acp'],
		['unknown-model', undefined]
	])('maps %s to its stored agent type', (model, expected) => {
		expect(modelAgentType(model)).toBe(expected)
	})

	test('finds one label across repeated whole-picker cache snapshots', () => {
		const models = ['Fable 5.1', '5.6 Sol']
		const groups = [
			{ agentType: 'claude', models },
			{ agentType: 'codex', models }
		]
		expect(modelCatalogIncludes('Fable 5.1', groups)).toBe(true)
		expect(modelCatalogIncludes('Opus 5', groups)).toBe(false)
	})
})
