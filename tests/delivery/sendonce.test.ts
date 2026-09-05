import { describe, expect, test } from 'vitest'
import { SendOnce } from '../../src/delivery/sendonce.ts'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface Answer {
	status: number
	tag: string
}

const memo = (ttlMs = 400) =>
	new SendOnce<Answer>({ keep: answer => answer.status === 200 || answer.status === 202, ttlMs })

describe('send memo', () => {
	test('returns a delivered result for repeated keys without sending twice', async () => {
		const once = memo()
		let runs = 0
		const send = async (): Promise<Answer> => ({ status: 200, tag: `run-${++runs}` })
		const first = await once.run('tap-1', send)
		const second = await once.run('tap-1', send)
		expect(runs).toBe(1)
		expect(second).toEqual(first)
	})

	test('treats different keys as different user actions', async () => {
		const once = memo()
		let runs = 0
		const send = async (): Promise<Answer> => ({ status: 200, tag: `run-${++runs}` })
		await once.run('tap-1', send)
		await once.run('tap-2', send)
		expect(runs).toBe(2)
	})

	test('does not remember failed sends', async () => {
		const once = memo()
		let runs = 0
		const send = async (): Promise<Answer> =>
			++runs === 1 ? { status: 502, tag: 'failed' } : { status: 200, tag: 'landed' }
		expect(await once.run('tap-1', send)).toEqual({ status: 502, tag: 'failed' })
		expect(await once.run('tap-1', send)).toEqual({ status: 200, tag: 'landed' })
		expect(runs).toBe(2)
	})

	test('remembers a parked send', async () => {
		const once = memo()
		let runs = 0
		const send = async (): Promise<Answer> => ({ status: 202, tag: `park-${++runs}` })
		await once.run('tap-1', send)
		await once.run('tap-1', send)
		expect(runs).toBe(1)
	})

	test('joins an in-flight send for the same key', async () => {
		const once = memo()
		let runs = 0
		const send = async (): Promise<Answer> => {
			runs++
			await sleep(20)
			return { status: 200, tag: `run-${runs}` }
		}
		const [first, second] = await Promise.all([once.run('tap-1', send), once.run('tap-1', send)])
		expect(runs).toBe(1)
		expect(first).toEqual(second)
	})

	test('releases a key after a throw', async () => {
		const once = memo()
		let runs = 0
		const send = async (): Promise<Answer> => {
			if (++runs === 1) throw new Error('conductor went away')
			return { status: 200, tag: 'landed' }
		}
		await expect(once.run('tap-1', send)).rejects.toThrow('conductor went away')
		expect(await once.run('tap-1', send)).toEqual({ status: 200, tag: 'landed' })
	})

	test('expires remembered results', async () => {
		const once = memo(20)
		let runs = 0
		const send = async (): Promise<Answer> => ({ status: 200, tag: `run-${++runs}` })
		await once.run('tap-1', send)
		expect(once.recall('tap-1')).not.toBeNull()
		await sleep(30)
		expect(once.recall('tap-1')).toBeNull()
		await once.run('tap-1', send)
		expect(runs).toBe(2)
	})

	test('never deduplicates unkeyed callers', async () => {
		const once = memo()
		let runs = 0
		const send = async (): Promise<Answer> => ({ status: 200, tag: `run-${++runs}` })
		await once.run(undefined, send)
		await once.run(undefined, send)
		expect(runs).toBe(2)
	})
})
