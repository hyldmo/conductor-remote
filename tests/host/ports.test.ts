/**
 * Install used to write the plist, reload launchd, and print a phone URL for a relay that could never
 * come up: nothing asked whether `RELAY_PORT`/`VOICE_PORT` were bindable, and `server.listen`'s failure
 * reached launchd as an unhandled 'error' event, so the whole story was a stack trace in relay.err.log.
 *
 * These cover the pure halves of the preflight, which is where the silent failures live. `parsePortValue`
 * is the only thing between a typo and ERR_SOCKET_BAD_PORT inside the daemon. `parseLsofListeners` reads
 * lsof's field output rather than its table because the COMMAND column carries spaces, and a column split
 * names the wrong process in exactly the case where a person is trying to find what holds their port.
 * `probeListen` is exercised against a real socket: an unreachable code path here reports every port free.
 */
import net from 'node:net'
import { describe, expect, it } from 'vitest'
import {
	bindFailureLines,
	describeHolders,
	parseLsofListeners,
	parsePortValue,
	probeListen
} from '../../src/host/ports.ts'

describe('parsePortValue', () => {
	it('accepts the whole legal range', () => {
		expect(parsePortValue('1')).toBe(1)
		expect(parsePortValue('8787')).toBe(8787)
		expect(parsePortValue('65535')).toBe(65535)
		expect(parsePortValue(' 8788 ')).toBe(8788)
	})

	it('rejects everything a port is not', () => {
		for (const bad of ['', '   ', 'abc', '0', '65536', '80.5', '-1', '8787x', '0x1f90', undefined, null])
			expect(parsePortValue(bad)).toBeNull()
	})
})

describe('parseLsofListeners', () => {
	it('keeps a command containing spaces intact', () => {
		const out = 'p4242\ncGoogle Chrome H\nf12\nn127.0.0.1:8787\n'
		expect(parseLsofListeners(out)).toEqual([{ command: 'Google Chrome H', pid: 4242 }])
	})

	it('reports one entry per process, not per descriptor', () => {
		const out = 'p1\ncnode\nf10\nn*:8787\nf11\nn[::1]:8787\np2\ncother\nf7\nn127.0.0.1:8787\n'
		expect(parseLsofListeners(out)).toEqual([
			{ command: 'node', pid: 1 },
			{ command: 'other', pid: 2 }
		])
	})

	it('answers empty for the no-match output lsof gives alongside a non-zero exit', () => {
		expect(parseLsofListeners('')).toEqual([])
	})
})

describe('probeListen', () => {
	it('reports a free port free and a held port busy', async () => {
		const held = net.createServer()
		const port = await new Promise<number>(resolve => {
			held.listen(0, '127.0.0.1', () => resolve((held.address() as net.AddressInfo).port))
		})
		try {
			expect(await probeListen('127.0.0.1', port)).toBe('EADDRINUSE')
		} finally {
			await new Promise(resolve => held.close(resolve))
		}
		// The same port, now released: the probe must not leave its own socket behind either.
		expect(await probeListen('127.0.0.1', port)).toBeNull()
	})

	it('names a host this machine does not hold rather than calling it free', async () => {
		expect(await probeListen('192.0.2.1', 8787)).not.toBeNull()
	})
})

describe('bindFailureLines', () => {
	it('names the port, the cause and the knob that moves it', () => {
		const lines = bindFailureLines('the voice listener', '127.0.0.1', 8788, 'EACCES', 'voice-port')
		expect(lines[0]).toContain('127.0.0.1:8788')
		expect(lines[0]).toContain('EACCES')
		expect(lines[1]).toContain('config set voice-port')
	})

	it('falls back rather than claiming a cause it does not have', () => {
		expect(bindFailureLines('the relay', '127.0.0.1', 8787, null, 'port')[0]).toContain('unknown error')
		expect(describeHolders([])).toBe('an unidentified process')
	})
})
