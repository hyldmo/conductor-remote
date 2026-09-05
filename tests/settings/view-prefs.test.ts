import { beforeEach, describe, expect, test, vi } from 'vitest'

const values = new Map<string, string>()

Object.defineProperty(globalThis, 'location', {
	configurable: true,
	value: { hash: '', pathname: '/', search: '' }
})
Object.defineProperty(globalThis, 'localStorage', {
	configurable: true,
	value: {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, String(value)),
		removeItem: (key: string) => values.delete(key)
	}
})
Object.defineProperty(globalThis, 'history', {
	configurable: true,
	value: { replaceState: () => {} }
})

beforeEach(() => {
	values.clear()
	vi.resetModules()
})

describe('global view preferences', () => {
	test('restores the file rail folder choice from localStorage after a reload', async () => {
		const { useApp } = await import('../../web/src/store.ts')

		expect(useApp.getState().view.showFolders).toBe(true)
		useApp.getState().setView({ showFolders: false })
		expect(JSON.parse(values.get('conductor-remote-view') ?? '{}')).toMatchObject({ showFolders: false })

		vi.resetModules()
		const { useApp: reloadedApp } = await import('../../web/src/store.ts')
		expect(reloadedApp.getState().view.showFolders).toBe(false)
	})
})
