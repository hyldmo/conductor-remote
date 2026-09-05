import { describe, expect, test, vi } from 'vitest'
import { createTools } from '../../src/mcp/registry.ts'
import {
	PlanUsageService,
	type ProviderPlanUsage,
	parseClaudePlanUsage,
	parseCodexPlanUsage
} from '../../src/usage/plan-usage.ts'
import { resetLabel } from '../../web/src/lib/usage.ts'

describe('plan usage', () => {
	test('normalizes every Codex app-server rate-limit bucket', () => {
		const usage = parseCodexPlanUsage({
			id: 2,
			result: {
				rateLimits: { limitId: 'legacy-that-must-not-be-duplicated' },
				rateLimitsByLimitId: {
					codex: {
						limitId: 'codex',
						limitName: null,
						planType: 'pro',
						primary: { usedPercent: 6, windowDurationMins: 10_080, resetsAt: 1_788_970_276 },
						secondary: null
					},
					codex_spark: {
						limitId: 'codex_spark',
						limitName: 'GPT-5.3-Codex-Spark',
						planType: 'pro',
						primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_788_412_239 },
						secondary: { usedPercent: 34, windowDurationMins: 10_080, resetsAt: null }
					}
				}
			}
		})

		expect(usage.status).toBe('available')
		expect(usage.plan).toBe('pro')
		expect(usage.buckets.map(bucket => bucket.label)).toEqual(['Codex', 'GPT-5.3-Codex-Spark'])
		expect(usage.buckets.flatMap(bucket => bucket.windows.map(window => window.label))).toEqual([
			'Weekly limit',
			'5-hour limit',
			'Weekly limit'
		])
		expect(usage.buckets[0]?.windows[0]?.resetsAt).toBe(1_788_970_276_000)
	})

	test('reads Claude structured limits and ignores spend-shaped records', () => {
		const usage = parseClaudePlanUsage({
			type: 'control_response',
			response: {
				subtype: 'success',
				request_id: 'plan-usage',
				response: {
					subscription_type: 'max',
					rate_limits_available: true,
					rate_limits: {
						limits: [
							{
								kind: 'session',
								percent: 17,
								resets_at: '2026-09-03T01:19:59Z',
								is_active: false
							},
							{
								kind: 'weekly_all',
								percent: 55,
								resets_at: '2026-09-07T08:59:59Z'
							},
							{
								kind: 'weekly_scoped',
								percent: 75,
								resets_at: null,
								is_active: true,
								scope: { model: { display_name: 'Fable' } }
							},
							{ kind: 'spend', percent: 90 }
						]
					}
				}
			}
		})

		expect(usage.status).toBe('available')
		expect(usage.plan).toBe('max')
		expect(usage.buckets[0]?.windows.map(window => [window.label, window.usedPercent, window.active])).toEqual([
			['Current session', 17, false],
			['Current week', 55, false],
			['Current week (Fable)', 75, true]
		])
	})

	test('keeps the named Claude window fallback and explains accounts without plan limits', () => {
		const fallback = parseClaudePlanUsage({
			subscription_type: 'team',
			rate_limits_available: true,
			rate_limits: {
				five_hour: { utilization: 123, resets_at: 'bad timestamp' },
				seven_day: { utilization: 20, resets_at: null },
				model_scoped: [{ display_name: 'Opus', utilization: 40, resets_at: null }]
			}
		})
		expect(fallback.buckets[0]?.windows.map(window => [window.label, window.usedPercent, window.resetsAt])).toEqual([
			['Current session', 100, null],
			['Current week', 20, null],
			['Current week (Opus)', 40, null]
		])

		const apiKey = parseClaudePlanUsage({ subscription_type: null, rate_limits_available: false })
		expect(apiKey).toMatchObject({ status: 'unavailable', plan: null, buckets: [] })
		expect(apiKey.message).toMatch(/API-key/)
	})

	test('coalesces concurrent reads and caches the completed snapshot', async () => {
		let now = 1_000
		let reads = 0
		const available: ProviderPlanUsage = {
			provider: 'codex',
			label: 'Codex',
			status: 'available',
			plan: 'pro',
			buckets: []
		}
		const service = new PlanUsageService({
			cacheMs: 100,
			now: () => now,
			readers: [
				{
					provider: 'codex',
					label: 'Codex',
					read: async () => {
						reads++
						await Promise.resolve()
						return available
					}
				}
			]
		})

		const [first, joined] = await Promise.all([service.read(), service.read()])
		expect(joined).toBe(first)
		expect(reads).toBe(1)
		expect((await service.read()).fetchedAt).toBe(1_000)
		expect(reads).toBe(1)

		now = 1_101
		await service.read()
		expect(reads).toBe(2)
		expect(first.providers.map(provider => provider.provider)).toEqual(['codex', 'cursor', 'opencode'])
	})

	test('contains reader failures and formats nearby reset times', async () => {
		const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const service = new PlanUsageService({
			readers: [{ provider: 'claude', label: 'Claude Code', read: async () => Promise.reject(new Error('secret')) }]
		})
		const result = await service.read()
		expect(result.providers[0]).toMatchObject({ provider: 'claude', status: 'error' })
		expect(result.providers[0]?.message).not.toContain('secret')
		expect(warning).toHaveBeenCalledOnce()
		warning.mockRestore()

		const now = Date.UTC(2026, 8, 3, 10)
		expect(resetLabel(now + 29 * 60_000, now)).toBe('Resets in 29m')
		expect(resetLabel(now + 3 * 3_600_000, now)).toBe('Resets in 3h')
		expect(resetLabel(null, now)).toBe('Reset time unavailable')
	})

	test('formats the read-only MCP tool with exact provider reset instants', async () => {
		const tool = createTools(
			async <T>() =>
				({
					fetchedAt: Date.UTC(2026, 8, 3, 10),
					providers: [
						{
							provider: 'codex',
							label: 'Codex',
							status: 'available',
							plan: 'pro',
							buckets: [
								{
									id: 'codex',
									label: 'Codex',
									windows: [
										{
											id: 'codex:primary',
											label: 'Weekly limit',
											usedPercent: 6,
											resetsAt: Date.UTC(2026, 8, 9, 10)
										}
									]
								}
							]
						},
						{
							provider: 'cursor',
							label: 'Cursor Agent',
							status: 'unavailable',
							plan: null,
							buckets: [],
							message: 'No plan limits.'
						}
					]
				}) as T
		).find(candidate => candidate.name === 'plan_usage')
		const output = await tool?.run({})
		expect(output).toContain('## Codex · pro')
		expect(output).toContain('Weekly limit: 6% used · resets 2026-09-09T10:00:00.000Z')
		expect(output).toContain('## Cursor Agent\nNo plan limits.')
	})
})
