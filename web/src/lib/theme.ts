export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

/** Device-local by design: each phone follows its own display preference. */
export const THEME_STORAGE_KEY = 'conductor-remote-theme'

const THEME_COLORS: Record<ResolvedTheme, string> = {
	light: '#f5f6f8',
	dark: '#0a0b0e'
}

export function parseThemePreference(value: unknown): ThemePreference {
	return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function readThemePreference(storage?: Pick<Storage, 'getItem'>): ThemePreference {
	try {
		return parseThemePreference((storage ?? localStorage).getItem(THEME_STORAGE_KEY))
	} catch {
		return 'system'
	}
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
	return preference === 'system' ? (systemDark ? 'dark' : 'light') : preference
}

function systemPrefersDark(): boolean {
	return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Apply both browser chrome and CSS color-scheme without requiring a React render. */
export function applyTheme(preference: ThemePreference, systemDark = systemPrefersDark()): void {
	if (typeof document === 'undefined') return

	// No attribute is the system mode: CSS's `color-scheme: light dark` then follows
	// the device by itself, including native form controls.
	if (preference === 'system') delete document.documentElement.dataset.theme
	else document.documentElement.dataset.theme = preference

	const resolved = resolveTheme(preference, systemDark)
	document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[resolved])
}

export function writeThemePreference(preference: ThemePreference, storage?: Pick<Storage, 'setItem'>): void {
	try {
		;(storage ?? localStorage).setItem(THEME_STORAGE_KEY, preference)
	} catch {
		// Storage can be denied in private contexts; the in-memory choice still applies.
	}
	applyTheme(preference)
}

/** Keep system mode and the browser's surrounding chrome current while the app is open. */
export function watchSystemTheme(): () => void {
	if (typeof window === 'undefined') return () => {}
	const media = window.matchMedia('(prefers-color-scheme: dark)')
	const update = () => applyTheme(readThemePreference(), media.matches)
	media.addEventListener('change', update)
	update()
	return () => media.removeEventListener('change', update)
}
