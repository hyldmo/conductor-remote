import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { routerProvider } from './config.ts'
import { ROUTER_INSTRUCTIONS } from './decision.ts'
import type { AutoModelTuple } from './types.ts'

/** Picker labels and CLI IDs are distinct. Restrict routing to known label shapes. */
export function codexRouterId(label: string): string {
	if (!/^(?:GPT-)?\d[\d.]*(?: (?:Luna|Terra|Sol|Astra))?$/.test(label)) throw new Error('Unsupported Codex router.')
	return `gpt-${label.replace(/^GPT-/, '').toLowerCase().replaceAll(' ', '-')}`
}

function codexBinary(): string {
	const root = path.join(os.homedir(), 'Library/Application Support/com.conductor.app/agent-binaries/codex')
	try {
		for (const version of fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
			const file = path.join(root, version, 'codex')
			try {
				fs.accessSync(file, fs.constants.X_OK)
				return file
			} catch {}
		}
	} catch {}
	return 'codex'
}

export interface RouterCommand {
	binary: string
	args: string[]
	cwd: string
	env: NodeJS.ProcessEnv
	stdin: string
}

/** Build an isolated classifier invocation; no workspace instructions or editing tools. */
export function routerCommand(
	router: AutoModelTuple,
	prompt: string,
	images: string[],
	directory: string
): RouterCommand {
	const provider = routerProvider(router)
	if (provider === 'codex') {
		const instructions = path.join(directory, 'instructions.txt')
		const schema = path.join(directory, 'output-schema.json')
		fs.writeFileSync(instructions, ROUTER_INSTRUCTIONS)
		fs.writeFileSync(
			schema,
			JSON.stringify({
				type: 'object',
				additionalProperties: false,
				required: ['profile', 'reason', 'missingContext'],
				properties: { profile: { type: 'string' }, reason: { type: 'string' }, missingContext: { type: 'boolean' } }
			})
		)
		return {
			binary: codexBinary(),
			cwd: directory,
			env: { ...process.env },
			stdin: prompt,
			args: [
				'exec',
				'--ephemeral',
				'--ignore-user-config',
				'--ignore-rules',
				'--skip-git-repo-check',
				'--sandbox',
				'read-only',
				'--json',
				'--output-schema',
				schema,
				'-m',
				codexRouterId(router.model),
				'-c',
				`model_instructions_file=${JSON.stringify(instructions)}`,
				'-c',
				'approval_policy="never"',
				'-c',
				'web_search="disabled"',
				'-c',
				'agents.enabled=false',
				...[
					'shell_tool',
					'apply_patch_freeform',
					'code_mode',
					'apps',
					'plugins',
					'hooks',
					'codex_hooks',
					'multi_agent',
					'multi_agent_v2',
					'browser_use',
					'computer_use',
					'image_generation',
					'memories'
				].flatMap(name => ['-c', `features.${name}=false`]),
				'-c',
				`model_reasoning_effort=${JSON.stringify(router.effort ?? 'low')}`,
				'-c',
				`service_tier=${JSON.stringify(router.fast ? 'priority' : 'default')}`,
				...images.flatMap(file => ['--image', file]),
				'-'
			]
		}
	}
	if (provider !== 'opencode') throw new Error('Unsupported Auto router.')
	const configDir = path.join(directory, 'config')
	fs.mkdirSync(configDir)
	const config = path.join(configDir, 'opencode.json')
	fs.writeFileSync(
		config,
		JSON.stringify({
			share: 'disabled',
			autoupdate: false,
			permission: { '*': 'deny' },
			agent: {
				'auto-model-router': {
					description: 'Select a model profile',
					mode: 'primary',
					prompt: ROUTER_INSTRUCTIONS,
					permission: { '*': 'deny' },
					steps: 1
				}
			}
		})
	)
	return {
		binary: 'opencode',
		cwd: directory,
		stdin: prompt,
		env: {
			...process.env,
			XDG_CONFIG_HOME: configDir,
			OPENCODE_CONFIG: config,
			OPENCODE_CONFIG_DIR: configDir,
			OPENCODE_CONFIG_CONTENT: '{}',
			OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
			OPENCODE_DISABLE_CLAUDE_CODE: 'true'
		},
		args: [
			'--pure',
			'run',
			'--format',
			'json',
			'--model',
			router.model,
			'--agent',
			'auto-model-router',
			'--dir',
			directory,
			...images.flatMap(file => ['--file', file])
		]
	}
}

export function runRouterCommand(command: RouterCommand, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		signal.throwIfAborted()
		const child = spawn(command.binary, command.args, {
			cwd: command.cwd,
			env: command.env,
			detached: true,
			stdio: ['pipe', 'pipe', 'pipe']
		})
		let stdout = ''
		let failure: Error | undefined
		const stop = () => {
			failure ??= new Error('Router cancelled or timed out.')
			try {
				if (child.pid) process.kill(-child.pid, 'SIGKILL')
			} catch {}
		}
		signal.addEventListener('abort', stop, { once: true })
		child.stdout.setEncoding('utf8')
		child.stdout.on('data', chunk => {
			stdout += chunk
			if (stdout.length > 512_000) stop()
		})
		// Provider diagnostics can contain the prompt or authentication details.
		child.stderr.resume()
		child.stdin.on('error', () => undefined)
		child.on('error', () => {
			failure = new Error('The router CLI could not start.')
		})
		child.on('close', code => {
			signal.removeEventListener('abort', stop)
			if (failure || code !== 0) reject(failure ?? new Error('The router CLI failed.'))
			else resolve(stdout)
		})
		child.stdin.end(command.stdin)
	})
}

export function routerOutput(output: string, provider: 'codex' | 'opencode'): string {
	const events = output
		.split('\n')
		.filter(line => line.trim())
		.map(line => JSON.parse(line))
	if (events.some(event => event.type === 'error' || event.type === 'turn.failed' || event.type === 'tool_use'))
		throw new Error('Router failed.')
	return events
		.flatMap(event => {
			if (provider === 'codex' && event.type === 'item.completed' && event.item?.type === 'agent_message')
				return [event.item.text]
			if (provider === 'opencode' && event.type === 'text' && event.part?.type === 'text') return [event.part.text]
			return []
		})
		.join('')
}

/** Authentication stays owned by the installed CLIs; no credential files are read here. */
export async function runRouter(
	router: AutoModelTuple,
	prompt: string,
	images: string[],
	signal: AbortSignal
): Promise<string> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-auto-model-'))
	try {
		const command = routerCommand(router, prompt, images, directory)
		const output = await runRouterCommand(command, signal)
		const provider = routerProvider(router)
		if (!provider) throw new Error('Unsupported router.')
		if (provider === 'opencode') {
			const sessionId = output
				.split('\n')
				.filter(Boolean)
				.map(line => {
					try {
						return JSON.parse(line).sessionID
					} catch {
						return undefined
					}
				})
				.find(id => typeof id === 'string' && /^ses_[a-zA-Z0-9]+$/.test(id))
			if (sessionId) {
				await runRouterCommand(
					{ ...command, args: ['--pure', 'session', 'delete', sessionId], stdin: '' },
					AbortSignal.timeout(2000)
				).catch(() => undefined)
			}
		}
		return routerOutput(output, provider)
	} finally {
		fs.rmSync(directory, { recursive: true, force: true })
	}
}
