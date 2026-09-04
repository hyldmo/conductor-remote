import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// `.context/` is Conductor's gitignored scratch space and can contain probes
		// written for Node's own test runner. Product tests live here exclusively;
		// constraining discovery keeps a local experiment from breaking `yarn verify`.
		include: ['tests/**/*.test.{ts,tsx}'],
		// The optional live-corpus file contains a wall-clock latency assertion against
		// Conductor's real SQLite database. Run it after the parallel unit workers so
		// test-runner contention cannot impersonate phone latency.
		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/**/*.test.{ts,tsx}'],
					exclude: ['tests/voice-corpus.test.ts'],
					testTimeout: 20_000,
					sequence: { groupOrder: 0 }
				}
			},
			{
				test: {
					name: 'live corpus',
					include: ['tests/voice-corpus.test.ts'],
					fileParallelism: false,
					testTimeout: 20_000,
					sequence: { groupOrder: 1 }
				}
			}
		],
		coverage: {
			exclude: ['dist/**', 'dist-node/**', 'scripts/**', 'tests/**'],
			include: ['src/**/*.ts', 'web/src/**/*.{ts,tsx}'],
			provider: 'v8',
			reporter: ['text', 'html']
		},
		testTimeout: 20_000
	}
})
