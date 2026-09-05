import { execFileSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { readConductorAppleScript } from '../../src/writes/applescript/source.ts'

interface Control {
	id: string
	role: string
	name: string
	children: Control[]
}

const button = (id: string, name: string): Control => ({ id, name, role: 'AXButton', children: [] })
const group = (id: string, children: Control[], name = ''): Control => ({ id, name, role: 'AXGroup', children })

function literal(node: Control): string {
	const text = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
	return `{nodeId:${text(node.id)}, nodeRole:${text(node.role)}, nodeName:${text(node.name)}, nodeChildren:{${node.children.map(literal).join(',')}}}`
}

const source = readConductorAppleScript()
const lookup = source.match(/^on workspaceActionButtons\([\s\S]*?^end workspaceActionButtons$/m)?.[0]
if (!lookup) throw new Error('Missing workspace action lookup')

/**
 * Run the shipped traversal with an in-memory AX fixture. None of these scripts
 * talks to System Events or Conductor. Enumerating beyond the pane is forbidden:
 * that is the expensive walk which exhausted the real 28-second action budget.
 */
function findButtons(pane: Control): string[] {
	const result = execFileSync(
		'osascript',
		[
			'-e',
			`${lookup}

on axKids(node)
	if nodeId of node is not "pane" then error "descended beyond the workspace pane"
	return nodeChildren of node
end axKids

on axRole(node)
	return nodeRole of node
end axRole

on axName(node)
	return nodeName of node
end axName

on childButtonsNamed(node, wanted)
	if nodeName of node is "composer" then error "searched the composer"
	set found to {}
	repeat with entry in nodeChildren of node
		set childNode to contents of entry
		if nodeRole of childNode is "AXButton" and nodeName of childNode is wanted then
			set end of found to childNode
		end if
	end repeat
	return found
end childButtonsNamed

set found to my workspaceActionButtons(${literal(pane)}, "Continue")
set identifiers to {}
repeat with entry in found
	set end of identifiers to nodeId of (contents of entry)
end repeat
set AppleScript's text item delimiters to ","
return identifiers as text`
		],
		{ encoding: 'utf8', timeout: 3000 }
	).trim()
	return result ? result.split(',') : []
}

describe.runIf(process.platform === 'darwin')('Continue workspace action lookup', () => {
	test('finds the header action when the right sidebar is hidden', () => {
		expect(findButtons(group('pane', [button('continue', 'Continue'), button('archive', 'Archive')]))).toEqual([
			'continue'
		])
	})

	test('finds the git action bar inside a pane group', () => {
		const actionBar = group('actions', [button('continue', 'Continue'), button('archive', 'Archive')])
		expect(findButtons(group('pane', [actionBar]))).toEqual(['continue'])
	})

	test('an absent action never descends into the transcript or searches the composer', () => {
		const transcript = group('transcript', [
			group('message', [button('decoy', 'Continue'), button('decoy-archive', 'Archive')])
		])
		const composer = group('draft', [button('draft-continue', 'Continue')], 'composer')
		expect(findButtons(group('pane', [transcript, composer, button('create', 'Create PR')]))).toEqual([])
	})

	test('a long transcript does not hide the workspace action', () => {
		const transcript = group(
			'transcript',
			Array.from({ length: 600 }, (_, i) => group(`message-${i}`, [button(`decoy-${i}`, 'Continue')]))
		)
		const actions = group('actions', [button('continue', 'Continue'), button('archive', 'Archive')])
		expect(findButtons(group('pane', [transcript, actions]))).toEqual(['continue'])
	})

	test('preserves all matches at the same depth so the caller can refuse ambiguity', () => {
		expect(
			findButtons(
				group('pane', [
					group('first', [button('continue-1', 'Continue')]),
					group('second', [button('continue-2', 'Continue')])
				])
			)
		).toEqual(['continue-1', 'continue-2'])
	})

	test('keeps the shallow action ahead of a deeper duplicate', () => {
		expect(
			findButtons(group('pane', [button('continue', 'Continue'), group('nested', [button('deeper', 'Continue')])]))
		).toEqual(['continue'])
	})
})
