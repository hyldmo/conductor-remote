/**
 * The Run-wrapper process read behind the sidebar's Run badge (src/run-activity.ts).
 *
 * The whole signal is one `ps` line, and both ways of misreading it are silent. Match
 * too loosely and a `run-setup:` wrapper or a command that merely names a run file
 * lights the badge on a workspace with nothing running. Match too tightly and a real
 * Run — one whose worktree path carries a space, so the wrapper directory does too —
 * shows no badge. So the parser is pinned against a wrapper line in Conductor's own
 * shape, the key mapping is pinned to the slash→`--` rule the wrapper directory uses,
 * and the negatives that share the same directory (setup wrapper, a `tail` that names
 * the file) are pinned as misses.
 */

import { describe, expect, test } from 'vitest'
import type { Workspace } from '../src/reads.ts'
import { attachRunActivity, parseRunWrappers, runWrapperKey } from '../src/run-activity.ts'

const WORKTREE = '/Users/hyldmo/conductor/workspaces/conductor-remote/praia'
const KEY = '--Users--hyldmo--conductor--workspaces--conductor-remote--praia'
const PROJECTS_DIR = '/Users/hyldmo/.conductor/projects'
const wrapper = (key: string, n = 10, script = 'run-run') => `/bin/zsh ${PROJECTS_DIR}/${key}/${script}:${n}.sh`
const parse = (ps: string, projectsDir = PROJECTS_DIR) => parseRunWrappers(ps, projectsDir)

describe('runWrapperKey', () => {
	test('every slash becomes -- including the leading one', () => {
		expect(runWrapperKey(WORKTREE)).toBe(KEY)
	})

	test('a space in the worktree path survives into the key', () => {
		expect(runWrapperKey('/Users/hyldmo/my projects/repo/berlin')).toBe('--Users--hyldmo--my projects--repo--berlin')
	})
})

describe('parseRunWrappers', () => {
	test('a live zsh run-run wrapper is captured by its key', () => {
		expect(parse(wrapper(KEY))).toEqual(new Set([KEY]))
	})

	test('spaces and regex punctuation in the projects directory and key still resolve', () => {
		const projectsDir = '/Volumes/Work Disk/hyldmo+dev/.conductor/projects'
		const spaced = '--Users--hyldmo--my projects--repo--berlin'
		const ps = `/bin/zsh ${projectsDir}/${spaced}/run-run:1.sh`
		expect(parse(ps, projectsDir)).toEqual(new Set([spaced]))
	})

	test('two wrappers for one workspace — a restart, or two run ids — fold to one key', () => {
		const ps = [wrapper(KEY, 10), wrapper(KEY, 11)].join('\n')
		expect(parse(ps)).toEqual(new Set([KEY]))
	})

	test('trailing arguments after the wrapper do not break the match', () => {
		expect(parse(`${wrapper(KEY)} --flag`)).toEqual(new Set([KEY]))
	})

	test('a run-setup wrapper beside it is not an active Run', () => {
		expect(parse(wrapper(KEY, 1, 'run-setup'))).toEqual(new Set())
	})

	test('a non-zsh command that merely names the run file is not an active Run', () => {
		const ps = `tail -f ${PROJECTS_DIR}/${KEY}/run-run:10.sh`
		expect(parse(ps)).toEqual(new Set())
	})

	test('a zsh -c command that only echoes the run file is not an active Run', () => {
		const path = `${PROJECTS_DIR}/${KEY}/run-run:1.sh`
		expect(parse(`/bin/zsh -c echo ${path}`)).toEqual(new Set())
		expect(parse(`/bin/zsh -c 'echo ${path}'`)).toEqual(new Set())
	})

	test('zsh -c with the wrapper directly after -c is not the exec form and does not count', () => {
		const path = `${PROJECTS_DIR}/${KEY}/run-run:1.sh`
		expect(parse(`/bin/zsh -c ${path}`)).toEqual(new Set())
	})

	test('the wrapper as a later argument (zsh runs another program) does not count', () => {
		const path = `${PROJECTS_DIR}/${KEY}/run-run:1.sh`
		expect(parse(`/bin/zsh /bin/echo ${path}`)).toEqual(new Set())
	})

	test('an unrelated process listing produces no keys', () => {
		const ps = ['/usr/sbin/mDNSResponder', 'node /Users/hyldmo/app/server.js', '/bin/zsh -il'].join('\n')
		expect(parse(ps)).toEqual(new Set())
	})
})

describe('attachRunActivity', () => {
	const ws = (id: string, worktree: string | null): Workspace => ({ id, worktree }) as Workspace

	test('flags only the workspaces whose worktree key is live', () => {
		const other = '/Users/hyldmo/conductor/workspaces/conductor-remote/berlin'
		const workspaces = [ws('a', WORKTREE), ws('b', other), ws('c', null)]
		attachRunActivity(workspaces, () => new Set([KEY]))
		expect(workspaces.map(w => w.run_active)).toEqual([true, false, false])
	})

	test('an empty live set clears every flag', () => {
		const workspaces = [ws('a', WORKTREE)]
		attachRunActivity(workspaces, () => new Set())
		expect(workspaces[0].run_active).toBe(false)
	})
})
