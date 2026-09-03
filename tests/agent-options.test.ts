import { describe, expect, test } from 'vitest'
import { planSettingForUi } from '../src/writes.ts'

describe('agent option UI changes', () => {
	test('leaves an already-off Plan setting untouched', () => {
		expect(planSettingForUi(false, 'default')).toBeUndefined()
	})

	test('leaves an already-on Plan setting untouched', () => {
		expect(planSettingForUi(true, 'plan')).toBeUndefined()
	})

	test('keeps a requested Plan transition when the state differs', () => {
		expect(planSettingForUi(false, 'plan')).toBe(false)
		expect(planSettingForUi(true, 'default')).toBe(true)
	})

	test('does not invent a setting or assume an unknown state', () => {
		expect(planSettingForUi(undefined, 'default')).toBeUndefined()
		expect(planSettingForUi(false, null)).toBe(false)
	})
})
