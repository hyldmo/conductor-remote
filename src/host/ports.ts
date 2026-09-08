import { execFileSync } from 'node:child_process'
import net from 'node:net'

/**
 * Port knobs arrive as free text — a `--port` flag, a plist entry, an ambient shell variable — and every
 * one of them is handed straight to `server.listen`, which rejects a non-number with a bare
 * ERR_SOCKET_BAD_PORT inside the daemon. Reject it here instead, where a person is reading the output.
 */
export function parsePortValue(raw: string | undefined | null): number | null {
	if (raw === undefined || raw === null) return null
	const text = raw.trim()
	if (!/^\d+$/.test(text)) return null
	const port = Number(text)
	return port >= 1 && port <= 65535 ? port : null
}

export interface PortHolder {
	command: string
	pid: number
}

/**
 * Parse `lsof -Fpcn` field output into one entry per listening process. The field form is used rather
 * than the default table because lsof's COMMAND column carries spaces ("Google Chrome H"), so a column
 * split names the wrong holder. Process fields are printed once per process, ahead of its file blocks,
 * which is what keeps a process holding several matching descriptors from being reported several times.
 */
export function parseLsofListeners(out: string): PortHolder[] {
	const holders: PortHolder[] = []
	let pid: number | null = null
	for (const line of out.split('\n')) {
		if (line.startsWith('p')) {
			const parsed = Number(line.slice(1))
			pid = Number.isInteger(parsed) ? parsed : null
		} else if (line.startsWith('c') && pid !== null) {
			holders.push({ command: line.slice(1), pid })
			pid = null
		}
	}
	return holders
}

/** Who is listening on `port`, best-effort — this only ever decorates a message that has already failed. */
export function listenersOn(port: number): PortHolder[] {
	try {
		const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpcn'], {
			encoding: 'utf8',
			stdio: 'pipe'
		})
		return parseLsofListeners(out)
	} catch {
		// lsof exits non-zero when nothing matches, and it may not be installed at all.
		return []
	}
}

/**
 * Can this process bind `host:port`? Answered by binding it, because that is the only test that agrees
 * with the real listen in every case that matters: a wildcard listener blocks a loopback bind, a
 * privileged port is refused rather than busy, and a host the machine does not hold fails on its own.
 * Resolves the error code, or null when the port is free. The socket never accepts, so it leaves no
 * TIME_WAIT behind and the port is free again the moment this resolves.
 */
export function probeListen(host: string, port: number): Promise<string | null> {
	return new Promise(resolve => {
		const probe = net.createServer()
		probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? 'EUNKNOWN'))
		probe.listen(port, host, () => probe.close(() => resolve(null)))
	})
}

export function describeHolders(holders: PortHolder[]): string {
	if (!holders.length) return 'an unidentified process'
	return holders.map(holder => `${holder.command} (pid ${holder.pid})`).join(', ')
}

/**
 * The two lines a failed bind prints, shared by the install preflight and the running relay so both name
 * the same port and the same knob. `config set` is the hint in both because it is the one lever that
 * works against an installed daemon, which is where this failure is otherwise invisible.
 */
export function bindFailureLines(
	what: string,
	host: string,
	port: number,
	code: string | null,
	setting: 'port' | 'voice-port'
): string[] {
	const cause = code === 'EADDRINUSE' ? `held by ${describeHolders(listenersOn(port))}` : (code ?? 'unknown error')
	return [
		`✗ ${what} cannot bind ${host}:${port} — ${cause}.`,
		`  Free that port, or move it: conductor-remote config set ${setting} <port>`
	]
}
