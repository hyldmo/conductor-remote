import { describe, expect, test } from 'vitest'
import { modelLabel } from '../../web/src/lib/format.ts'

/**
 * What the composer's model pill says (web/src/lib/format.ts ▸ `modelLabel`). The
 * DB keeps an id and Conductor's menu shows a name it chooses, and the two drift:
 * `opus-5-1m` is "Opus 5" on the live menu while `opus-4-8-1m` is "Opus 4.8 1M".
 * A pill that disagrees with the menu is not only a wrong word — the picker checks
 * the row whose label matches it, so a disagreeing pill opens a menu with nothing
 * marked as current.
 *
 * Both directions are silent. Match too loosely and the pill names a model the chat
 * is not running on, which is the mistake worth failing on; match too tightly and
 * the renamed model reads wrong forever. So the ambiguous ids are pinned too.
 */
const CATALOG = [
	'5.4',
	'5.5',
	'5.6 Luna',
	'5.6 Sol',
	'5.6 Terra',
	'Fable 5',
	'Haiku 4.5',
	'Opus 4.6 1M',
	'Opus 4.7 1M',
	'Opus 4.8 1M',
	'Opus 5',
	'Sonnet 4.6',
	'Sonnet 4.6 1M',
	'Sonnet 5 1M'
]

describe('modelLabel', () => {
	test('takes Conductor’s own label when one resolves the id', () => {
		expect(modelLabel('opus-5-1m', CATALOG)).toBe('Opus 5')
		expect(modelLabel('opus-4-8-1m', CATALOG)).toBe('Opus 4.8 1M')
		expect(modelLabel('sonnet-5-1m', CATALOG)).toBe('Sonnet 5 1M')
		expect(modelLabel('sonnet-4-6', CATALOG)).toBe('Sonnet 4.6')
	})

	test('leaves an ambiguous id to the derivation rather than guessing', () => {
		// Four Opus labels, and `Sonnet 4.6` / `Sonnet 4.6 1M` differ only by the suffix
		// that is dropped to compare — neither may name a chat.
		expect(modelLabel('opus', CATALOG)).toBe('Opus')
		expect(modelLabel('opus-1m', CATALOG)).toBe('Opus 1M')
		expect(modelLabel('sonnet-4-6-500k', CATALOG)).toBe('Sonnet 4.6 500k')
	})

	test('reads the version as one number with no catalog to read', () => {
		expect(modelLabel('opus-4-8-1m')).toBe('Opus 4.8 1M')
		expect(modelLabel('gpt-5.6-sol')).toBe('5.6 Sol')
		expect(modelLabel('fable-5')).toBe('Fable 5')
	})

	test('leaves an id it does not recognise alone', () => {
		expect(modelLabel('composer-2.5', CATALOG)).toBe('composer-2.5')
		expect(modelLabel('opencode:opencode-go/kimi-k3', CATALOG)).toBe('kimi-k3')
		expect(modelLabel(null)).toBe('')
	})
})
