import { afterEach, describe, expect, test } from 'vitest'
import {
	configureSharedUiLeaseProvider,
	UiBusyError,
	uiQueueDepth,
	uiTurn,
	withGatedUiCommand,
	withUiDispatchHook,
	withUiPriority
} from '../src/writes.ts'

const order: string[] = []
const hold = (name: string, ms: number) => (): Promise<string> =>
	new Promise(resolve => {
		setTimeout(() => {
			order.push(name)
			resolve(name)
		}, ms)
	})

const idle = (): boolean => uiQueueDepth().waiting === 0 && !uiQueueDepth().busy

afterEach(() => configureSharedUiLeaseProvider(null))

describe.sequential('UI lock', () => {
	test('serializes operations in arrival order', async () => {
		order.length = 0
		const runs = [uiTurn(hold('a', 40)), uiTurn(hold('b', 5)), uiTurn(hold('c', 5))]
		expect(uiQueueDepth()).toMatchObject({ waiting: 2, busy: true })
		await Promise.all(runs)
		expect(order).toEqual(['a', 'b', 'c'])
		expect(idle()).toBe(true)
	})

	test('prioritizes a person over queued background work', async () => {
		order.length = 0
		await Promise.all([
			withUiPriority('background', () => uiTurn(hold('bg-running', 30))),
			withUiPriority('background', () => uiTurn(hold('bg-1', 5))),
			withUiPriority('background', () => uiTurn(hold('bg-2', 5))),
			withUiPriority('interactive', () => uiTurn(hold('phone', 5)))
		])
		expect(order).toEqual(['bg-running', 'phone', 'bg-1', 'bg-2'])
	})

	test('releases after rejected and synchronously thrown operations', async () => {
		order.length = 0
		await uiTurn(hold('never', 1))
			.then(() => uiTurn(() => Promise.reject(new Error('nope'))))
			.catch(() => order.push('rejected'))
		await uiTurn(hold('after', 1))
		expect(order).toEqual(['never', 'rejected', 'after'])

		await expect(
			uiTurn(() => {
				throw new Error('sync throw')
			})
		).rejects.toThrow('sync throw')
		await uiTurn(hold('still-works', 1))
		expect(idle()).toBe(true)
	})

	test('refuses a fifth waiter without damaging the queue', async () => {
		const runs = [uiTurn(hold('holding', 25))]
		for (let index = 0; index < 4; index++) runs.push(uiTurn(hold(`queued-${index}`, 1)))
		expect(uiQueueDepth().waiting).toBe(4)

		const refused = await uiTurn(hold('over-the-cap', 1)).catch(error => error as unknown)
		expect(refused).toBeInstanceOf(UiBusyError)
		expect((refused as UiBusyError).waiting).toBe(4)

		await Promise.all(runs)
		expect(idle()).toBe(true)
		await uiTurn(hold('recovered', 1))
		expect(idle()).toBe(true)
	})

	test('holds one shared lease through every operation and the durable effect callback', async () => {
		const events: string[] = []
		configureSharedUiLeaseProvider({
			acquire: async request => {
				events.push(`acquire:${request.priority}:${request.actionId}`)
				return {
					markMayExecute: async () => {
						events.push('may-execute')
					},
					release: async () => {
						events.push('release')
					}
				}
			}
		})

		await withUiDispatchHook(
			async () => {
				events.push('dispatched')
			},
			async () => {
				await uiTurn(async () => events.push('first operation'))
				await uiTurn(async () => events.push('second operation'))
				events.push('effect committed')
			},
			'effect-1'
		)

		expect(events).toEqual([
			'acquire:interactive:effect-1',
			'dispatched',
			'may-execute',
			'first operation',
			'may-execute',
			'second operation',
			'effect committed',
			'release'
		])
		expect(idle()).toBe(true)
	})

	test('does not mark or execute an effect when shared lease acquisition fails', async () => {
		const events: string[] = []
		configureSharedUiLeaseProvider({
			acquire: async () => {
				throw new Error('shared lease unavailable')
			}
		})

		await expect(
			withUiDispatchHook(
				async () => {
					events.push('dispatched')
				},
				() => uiTurn(async () => events.push('operation')),
				'effect-2'
			)
		).rejects.toThrow('shared lease unavailable')
		expect(events).toEqual([])
		expect(idle()).toBe(true)
	})

	test('awaits the shared release before resolving and freeing the local lock', async () => {
		let released = false
		configureSharedUiLeaseProvider({
			acquire: async () => ({
				markMayExecute: () => undefined,
				release: async () => {
					await Promise.resolve()
					released = true
				}
			})
		})

		await uiTurn(async () => 'done')
		expect(released).toBe(true)
		expect(idle()).toBe(true)
	})

	test('persists each gated wrapper identity before sequential external commands execute', async () => {
		const events: string[] = []
		const effectPids: number[] = []
		const leasePids: number[] = []
		configureSharedUiLeaseProvider({
			acquire: async () => {
				events.push('acquire')
				return {
					markMayExecute: process => {
						leasePids.push(process?.pid ?? 0)
						events.push('lease-may-execute')
					},
					release: () => {
						events.push('release')
					}
				}
			}
		})

		const output = await withUiDispatchHook(
			async () => {
				events.push('dispatched')
			},
			() =>
				withGatedUiCommand(
					async process => {
						effectPids.push(process.pid)
						events.push('effect-may-execute')
					},
					execute =>
						uiTurn(async () => {
							const first = (await execute('/usr/bin/printf', ['gated'])).stdout
							const second = await uiTurn(async () => (await execute('/usr/bin/printf', [' twice'])).stdout)
							return first + second
						})
				),
			'effect-gated'
		)

		expect(output).toBe('gated twice')
		expect(effectPids).toHaveLength(2)
		expect(effectPids.every(pid => pid > 1)).toBe(true)
		expect(leasePids).toEqual(effectPids)
		expect(events).toEqual([
			'acquire',
			'dispatched',
			'effect-may-execute',
			'lease-may-execute',
			'effect-may-execute',
			'lease-may-execute',
			'release'
		])
		expect(idle()).toBe(true)
	})
})
