import { Worker } from 'node:worker_threads'
import type { ToolUsageRange, ToolUsageSnapshot } from './tool-usage.ts'

const CACHE_MS = 60_000
const READ_TIMEOUT_MS = 60_000

/**
 * History can be large: keep SQLite and JSON parsing off the HTTP event loop.
 * One disposable worker at a time reads a range; cached/in-flight reads are shared
 * across phones. Nothing runs until Models requests it, and no index is persisted.
 */
export class ToolUsageService {
	private readonly dbPath: string
	private readonly cache = new Map<ToolUsageRange, ToolUsageSnapshot>()
	private readonly pending = new Map<ToolUsageRange, Promise<ToolUsageSnapshot>>()
	private queue: Promise<unknown> = Promise.resolve()

	constructor(dbPath: string) {
		this.dbPath = dbPath
	}

	read(range: ToolUsageRange, refresh = false): Promise<ToolUsageSnapshot> {
		const running = this.pending.get(range)
		if (running) return running
		const cached = this.cache.get(range)
		if (!refresh && cached && Date.now() - cached.fetchedAt < CACHE_MS) return Promise.resolve(cached)
		const read = this.queue.then(() => this.scan(range))
		this.pending.set(range, read)
		this.queue = read.catch(() => {})
		void read.then(
			data => {
				this.cache.set(range, data)
				this.pending.delete(range)
			},
			() => this.pending.delete(range)
		)
		return read
	}

	private scan(range: ToolUsageRange): Promise<ToolUsageSnapshot> {
		return new Promise((resolve, reject) => {
			const module = import.meta.url.endsWith('.ts') ? './tool-usage-worker.ts' : './tool-usage-worker.js'
			const worker = new Worker(new URL(module, import.meta.url), {
				workerData: { dbPath: this.dbPath, range },
				// Node's watch supervisor expands process flags that workers reject.
				// These modules need only Node's built-in type stripping, not the
				// parent's process-level V8, inspector, or watch configuration.
				execArgv: ['--disable-warning=ExperimentalWarning']
			})
			let settled = false
			const finish = (error?: Error, data?: ToolUsageSnapshot) => {
				if (settled) return
				settled = true
				clearTimeout(timeout)
				void worker.terminate()
				if (error) reject(error)
				else if (data) resolve(data)
			}
			const timeout = setTimeout(
				() => finish(new Error('Tool usage took too long to read. Try a shorter range.')),
				READ_TIMEOUT_MS
			)
			worker.once('message', (data: ToolUsageSnapshot) => finish(undefined, data))
			worker.once('error', error => finish(error))
			worker.once('exit', () => finish(new Error('Could not read tool usage. Try again.')))
		})
	}
}
