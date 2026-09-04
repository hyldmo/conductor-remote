import { createThemeCollection, type ThemeDescriptor, type ThemeLike, type ThemeLoader } from '@pierre/theming'
import { normalizeTheme } from 'shiki/core'

type NormalizedTheme = ReturnType<typeof normalizeTheme>

interface CreateThemeOptions {
	name: string
	load: ThemeLoader
	colorScheme?: 'light' | 'dark'
	collection?: string
	displayName?: string
}

/** The small public helper Pierre also imports from its bundled theme catalog. */
export function createTheme({
	name,
	load,
	colorScheme,
	collection,
	displayName
}: CreateThemeOptions): ThemeDescriptor<NormalizedTheme> {
	return {
		name,
		colorScheme,
		collection,
		displayName,
		load: async () => normalizeTheme(unwrapDefault(await load()) as Parameters<typeof normalizeTheme>[0])
	}
}

function unwrapDefault(value: ThemeLike | { default: ThemeLike }): ThemeLike {
	return 'default' in value ? value.default : value
}

const descriptors = [
	createTheme({
		name: 'pierre-light',
		displayName: 'Pierre Light',
		collection: 'pierre',
		colorScheme: 'light',
		load: () => import('@pierre/theme/pierre-light')
	}),
	createTheme({
		name: 'pierre-dark',
		displayName: 'Pierre Dark',
		collection: 'pierre',
		colorScheme: 'dark',
		load: () => import('@pierre/theme/pierre-dark')
	})
] as const

/** Pierre's defaults are the only themes the app selects. */
export const pierreThemes = createThemeCollection({ themes: descriptors })

/** No alternate Shiki theme is selectable in the app. */
export const shikiThemes = createThemeCollection({ themes: [] as ThemeDescriptor[] })

export const themes = createThemeCollection({ themes: [pierreThemes, shikiThemes] })
