import { describe, expect, test } from 'vitest'
import { parseThemePreference, readThemePreference, resolveTheme, THEME_STORAGE_KEY } from '../../web/src/lib/theme.ts'

describe('theme preference', () => {
	test('accepts the three choices and defaults unknown values to system', () => {
		expect(parseThemePreference('system')).toBe('system')
		expect(parseThemePreference('light')).toBe('light')
		expect(parseThemePreference('dark')).toBe('dark')
		expect(parseThemePreference('sepia')).toBe('system')
		expect(parseThemePreference(null)).toBe('system')
	})

	test('only resolves system from the device preference', () => {
		expect(resolveTheme('system', false)).toBe('light')
		expect(resolveTheme('system', true)).toBe('dark')
		expect(resolveTheme('light', true)).toBe('light')
		expect(resolveTheme('dark', false)).toBe('dark')
	})

	test('defaults to system and reads defensively when storage is unavailable', () => {
		expect(readThemePreference({ getItem: () => null })).toBe('system')
		expect(readThemePreference({ getItem: key => (key === THEME_STORAGE_KEY ? 'light' : null) })).toBe('light')
		expect(
			readThemePreference({
				getItem: () => {
					throw new Error('denied')
				}
			})
		).toBe('system')
	})
})
