import { describe, expect, test } from 'vitest'
import { isRoute, type Route0, type Route1, routeParam, routes } from '../../src/routes.ts'

const entries = Object.entries(routes)
const isParam = (route: Route0 | Route1): route is Route1 => 're' in route
const samples = ['9008e4f4-9d58-4dbf-8c8e-6df0b618c2d0', 'conductor-remote', 'my repo', 'a/b', 'Ünicode name']

describe('route table', () => {
	test('is populated entirely by API paths', () => {
		expect(entries.length).toBeGreaterThan(20)
		expect(entries.every(([, route]) => route.pattern.startsWith('/api/'))).toBe(true)
	})

	test('round-trips every built path and parameter', () => {
		for (const [name, route] of entries) {
			if (!isParam(route)) {
				expect(isRoute(route, route.method, route.path()), name).toBe(true)
				continue
			}
			for (const sample of samples) {
				expect(routeParam(route, route.method, route.path(sample)), `${name}: ${sample}`).toBe(sample)
			}
		}
	})

	test('does not let a route match another route with the same method', () => {
		for (const [name, route] of entries) {
			const path = isParam(route) ? route.path(samples[0]) : route.path()
			for (const [otherName, other] of entries) {
				if (otherName === name || other.method !== route.method) continue
				const matches = isParam(other)
					? routeParam(other, route.method, path) !== null
					: isRoute(other, route.method, path)
				expect(matches, `${name} also matched ${otherName}`).toBe(false)
			}
		}
	})

	test('treats the HTTP method as part of route identity', () => {
		for (const [name, route] of entries) {
			const path = isParam(route) ? route.path(samples[0]) : route.path()
			for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
				if (method === route.method) continue
				const matches = isParam(route) ? routeParam(route, method, path) !== null : isRoute(route, method, path)
				expect(matches, `${name} also answered ${method}`).toBe(false)
			}
		}
	})
})
