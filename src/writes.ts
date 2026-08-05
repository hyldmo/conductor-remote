import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Workspace } from './reads.ts'
import { sidecarAvailable, sidecarSendUserMessage } from './sidecar.ts'

const exec = promisify(execFile)

/**
 * One UI operation at a time.
 *
 * Every script below drives Conductor's *shared, single* window — focus a
 * workspace, select a tab, write the composer — so two of them overlapping
 * interleaves their steps and lands a prompt in whatever the other one focused.
 * That is the exact failure the whole fail-closed AX design exists to prevent,
 * and no amount of per-step assertion catches it, because each script's reads
 * are true at the moment it makes them.
 *
 * It was unreachable while every write was one person tapping one button. It
 * stopped being unreachable when the relay grew a first-prompt queue that sends
 * on its own schedule (`firstprompt.ts`), so the queue can now fire while the
 * phone is mid-send. Cheap insurance either way: these run for seconds, the
 * caller is already awaiting, and there is never a real queue of them.
 */
let uiTail: Promise<unknown> = Promise.resolve()
function uiTurn<T>(op: () => Promise<T>): Promise<T> {
	// `.then(op, op)` so a previous failure doesn't skip the next turn.
	const turn = uiTail.then(op, op)
	uiTail = turn.catch(() => undefined)
	return turn
}

export interface SendResult {
	ok: boolean
	strategy: string
	warning?: string
	error?: string
}

/**
 * Where the target chat sits in Conductor's tab strip. `index` is 1-based in
 * `reads.listSessions` order (created_at ASC) — verified to match the strip's
 * left-to-right order — and `title` is the tab label used as a sanity check.
 */
export interface ChatTab {
	index: number
	count: number
	title: string
}

/** Who to deliver a prompt to. `sessionId` is the precise target; `workspace` carries the worktree + focus context. */
export interface SendTarget {
	workspace: Workspace
	sessionId: string | null
	/** Which chat tab to select once the workspace is focused. Omitted → whichever tab is already active. */
	tab?: ChatTab
}

export interface Actuator {
	readonly name: string
	/** Human-readable note about this strategy's limits, surfaced in the UI. */
	readonly caveat: string
	/** True when delivery is addressed to a specific session (no window-focus dependency). */
	readonly precise: boolean
	send: (target: SendTarget, text: string) => Promise<SendResult>
	/** Runtime availability check (e.g. the sidecar socket must be reachable). */
	available?: () => Promise<boolean>
}

/**
 * The sidecar IPC path — the precise, per-session write. Delivers straight to
 * `sessionId` over Conductor's own dispatch socket (see sidecar.ts), so it needs
 * no window focus and the app UI reflects the turn correctly.
 *
 * Opt-in (WRITE_STRATEGY=sidecar) because it speaks a private, versioned IPC and
 * hasn't been validated by an automated live send (that would inject a prompt
 * into a running agent). It is the intended default once you've confirmed it on
 * your setup.
 */
export class SidecarActuator implements Actuator {
	readonly name = 'sidecar'
	readonly caveat =
		'Delivered straight to the target session over Conductor’s dispatch socket — precise per-workspace targeting.'
	readonly precise = true

	available(): Promise<boolean> {
		return sidecarAvailable()
	}

	async send(target: SendTarget, text: string): Promise<SendResult> {
		const sessionId = target.sessionId ?? target.workspace.active_session_id
		if (!sessionId) return { ok: false, strategy: this.name, error: 'no session id to target' }
		try {
			await sidecarSendUserMessage(sessionId, text)
			return { ok: true, strategy: this.name }
		} catch (err) {
			return { ok: false, strategy: this.name, error: err instanceof Error ? err.message : String(err) }
		}
	}
}

/**
 * AppleScript handlers that pin down *which chat* the prompt goes to.
 *
 * The palette (Cmd+K) only gets us to the right workspace — a workspace holds
 * several chats, and Conductor keeps typing in whichever tab is already active.
 * So a send addressed to a non-active chat would land in the wrong agent.
 *
 * Conductor's webview exposes the whole tree through macOS Accessibility. The
 * chat strip is an AXTabGroup whose AXRadioButtons are the tabs (`AXValue`
 * marks the selected one, `AXPress` switches to it — it does *not* close the
 * chat). The strip's order matches `reads.listSessions` (created_at ASC), so
 * the caller addresses a tab by 1-based index and we cross-check the label.
 *
 * Two traps this has to survive:
 *  - **The terminal panel is an AXTabGroup too** (radio buttons named Setup /
 *    Run / Terminal 1), a sibling of the chat strip in the same pane. Picking
 *    "the first tab group" would sometimes press a terminal tab, so we *score*
 *    the candidates on tab count + label and refuse to act on a tie.
 *  - **The palette can land on the wrong workspace** (a loose query matches a
 *    command; a deleted branch opens a modal). The pane header carries the
 *    branch and repo, so we read them back and bail if they disagree.
 *
 * Target is read from RELAY_TAB_{INDEX,COUNT,TITLE} + RELAY_WS_{BRANCH,REPO};
 * index 0 disables the step. Every failure path errors out so the caller aborts
 * *before* pasting — landing in the wrong chat is worse than not sending.
 */
const SELECT_CHAT_TAB_HANDLERS = `
on splitLines(s)
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set parts to text items of s
	set AppleScript's text item delimiters to saved
	return parts
end splitLines

on windowProbe()
	-- One read, three outcomes, none of them guessed: {count, errNum, errText}.
	-- count is -1 when macOS refused the read at all. Everything that wants to
	-- know about windows goes through here, because "returned 0" and "refused to
	-- answer" are different facts and only this handler still has both.
	try
		tell application "System Events" to tell process "Conductor"
			set winCount to (count of windows)
		end tell
		return {winCount, 0, ""}
	on error errText number errNum
		return {-1, errNum, errText}
	end try
end windowProbe

on hasWindow()
	-- Also false when the process is gone or macOS refused: callers that only
	-- need a boolean keep getting one. windowFailure() is what tells them why.
	return (item 1 of my windowProbe()) > 0
end hasWindow

on refusalReason(probe)
	-- macOS's own words, matched on the error it actually returned rather than on
	-- a capability flag we hope is accurate. "UI elements enabled" was the earlier
	-- attempt at this and is not trustworthy — it can report true for a process
	-- that is not itself trusted, and then the refusal reappears downstream as
	-- "no open window". These strings are the two grants the write path needs.
	set errNum to item 2 of probe
	set errText to item 3 of probe
	if errText contains "assistive access" then return "the relay is not trusted for Accessibility - grant it to the node binary running the relay in System Settings > Privacy & Security > Accessibility, then restart the relay (upgrading node silently revokes it). macOS said: " & errText
	if errNum is -1743 or errText contains "Not authorized" then return "macOS blocked the relay from controlling the UI - grant Automation permission to the node binary running the relay in System Settings > Privacy & Security > Automation. macOS said: " & errText
	return ""
end refusalReason

on conductorRunning()
	try
		tell application "System Events" to return (exists process "Conductor")
	on error
		return false
	end try
end conductorRunning

on joinList(lst, sep)
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to sep
	set out to lst as text
	set AppleScript's text item delimiters to saved
	return out
end joinList

on processWindowCounts()
	-- Every process whose name looks like Conductor, with its window count. If the
	-- app is visibly on screen while "process Conductor" reports zero, the windows
	-- belong to a process we are not addressing — and that only shows up here.
	set out to {}
	try
		tell application "System Events"
			repeat with proc in (every process whose name contains "Conductor")
				set end of out to ((name of proc) & "=" & (count of windows of proc))
			end repeat
		end tell
	end try
	return out
end processWindowCounts

on menuTitles()
	try
		tell application "System Events" to tell process "Conductor"
			return name of every menu bar item of menu bar 1
		end tell
	on error
		return {}
	end try
end menuTitles

on windowEvidence()
	-- Zero windows is a dead end without knowing what the AX tree *does* show, and
	-- guessing the next thing to press has already cost a round trip (there is no
	-- "New Window" item — Conductor is single-window). So the error carries the
	-- evidence instead: who macOS thinks Conductor is, and what its menus offer.
	set procs to my processWindowCounts()
	set titles to my menuTitles()
	set ev to ""
	if (count of procs) > 0 then set ev to ev & " [processes: " & my joinList(procs, ", ") & "]"
	if (count of titles) > 0 then set ev to ev & " [menus: " & my joinList(titles, ", ") & "]"
	return ev
end windowEvidence

on windowFailure()
	-- "" when a window is there; otherwise why not, in words the phone can act on.
	-- ASCII on purpose: these reach the phone, and osascript decodes -e by the
	-- caller's locale, which a LaunchAgent doesn't set. The last branch carries
	-- the raw error number and text on purpose — an unrecognised refusal must
	-- arrive as itself, not as the most plausible-sounding of the known causes.
	set probe to my windowProbe()
	set winCount to item 1 of probe
	if winCount > 0 then return ""
	if winCount is 0 then return "Conductor is running but exposes no window - reopen and a Dock click both drew nothing. Open or restart it on your Mac and try again." & my windowEvidence()
	set refusal to my refusalReason(probe)
	if refusal is not "" then return refusal
	if not (my conductorRunning()) then return "Conductor is not running - the relay started it, but it did not come up in time. Try again in a few seconds."
	return "couldn't read Conductor's windows (" & (item 2 of probe) & "): " & (item 3 of probe)
end windowFailure

on requireWindow()
	set reason to my windowFailure()
	if reason is not "" then error reason
end requireWindow

on dockClick()
	-- Last resort when the "reopen" AppleEvent draws nothing: click the app's Dock
	-- tile. Same intent, different delivery — the Dock raises it through the app's
	-- own event loop rather than as an Apple event we send, which is what an app
	-- that never wired up reopen can still answer. (There is no "New Window" menu
	-- item to press: Conductor is single-window and single-instance.)
	try
		tell application "System Events" to tell application process "Dock"
			click UI element "Conductor" of list 1
		end tell
		return true
	on error
		return false
	end try
end dockClick

on restartConductor()
	-- The last lever: Conductor is single-window and single-instance, so when a
	-- running app answers neither reopen nor a Dock click there is nothing left to
	-- press. Deliberately fire-and-forget — a cold launch is 5-10s on its own,
	-- past what the phone's budget leaves once the send's own delays are counted —
	-- so this returns as soon as the relaunch is under way and the caller tells the
	-- phone to send again into a warm app. Gated by RELAY_ALLOW_RESTART, which the
	-- relay only sets when the DB says no session is mid-turn.
	try
		tell application "Conductor" to quit
	on error errText
		return "couldn't quit Conductor to restart it: " & errText
	end try
	repeat with attempt from 1 to 16
		if not (my conductorRunning()) then exit repeat
		delay 0.25
	end repeat
	if my conductorRunning() then return "Conductor ignored the quit, so the relay left it alone - quit it on your Mac and try again."
	try
		tell application "Conductor" to activate
	on error errText
		return "quit Conductor but couldn't start it again: " & errText
	end try
	return ""
end restartConductor

on waitForWindow(attempts)
	-- "reopen" is the dock-click Apple event, and for most apps that is what
	-- recreates a closed window ("activate" on its own does not). Nudge a few times
	-- across the wait: a cold launch can reach "process exists" long before it
	-- draws anything. If reopen has drawn nothing by ~3s the app isn't answering
	-- that event, so escalate to a real Dock click rather than repeating what has
	-- already failed twice.
	repeat with attempt from 1 to attempts
		if my hasWindow() then return true
		if attempt is 2 or attempt is 8 or attempt is 20 then
			try
				tell application "Conductor" to reopen
				tell application "Conductor" to activate
			end try
		end if
		if attempt is 12 or attempt is 28 then my dockClick()
		delay 0.25
	end repeat
	return false
end waitForWindow

on activateConductor()
	-- Conductor keeps running with every window closed (standard macOS: the red
	-- button doesn't quit), and it may not be running at all. Both used to surface
	-- as "Can't get window 1 of process Conductor. Invalid index." from whichever
	-- handler happened to run first. So: launch-or-front it ("activate" starts it
	-- when it isn't running), wait for a real window, then say what actually went
	-- wrong in words the phone can act on.
	-- Permissions first: a refusal reads as "no process, no window" from every
	-- probe below, and waiting out the patience budget to say the wrong thing
	-- helps nobody. A refusal is the one failure launching can't fix.
	set firstProbe to my windowProbe()
	set refusal to my refusalReason(firstProbe)
	if refusal is not "" then error refusal
	set wasRunning to (item 1 of firstProbe) >= 0
	try
		tell application "Conductor" to activate
	on error errText
		error "couldn't bring Conductor to the front: " & errText
	end try
	delay 0.4
	-- Patience sized to what we're waiting for. A running app only has to redraw a
	-- window (~4s is plenty, and the caller's osascript timeout still needs room
	-- for the send itself). A cold launch is a whole app start, so it gets ~9s —
	-- still inside the 20s script budget once the send's own delays are counted.
	-- Anything slower fails with the message above and finds a warm app on retry.
	set patience to 16
	if not wasRunning then set patience to 36
	if my waitForWindow(patience) then return
	-- Running, readable, and still zero windows: reopen and the Dock click have
	-- both drawn nothing, so a restart is the only thing left. "Open it on your
	-- Mac" is not advice a phone can act on — that is the whole point of this app.
	if (system attribute "RELAY_ALLOW_RESTART") is "1" and (item 1 of my windowProbe()) is 0 then
		set restartError to my restartConductor()
		if restartError is not "" then error restartError
		error "Conductor was running with no window and ignored both reopen and a Dock click, so the relay restarted it. Give it a few seconds and send again."
	end if
	my requireWindow()
end activateConductor

on webArea()
	-- The webview root: the window, then four nested containers. Guarded, or a
	-- window that closed mid-run reappears as an "Invalid index" from a caller
	-- that has nothing to do with windows.
	my requireWindow()
	tell application "System Events" to tell process "Conductor"
		return UI element 1 of UI element 1 of UI element 1 of UI element 1 of window 1
	end tell
end webArea

on sidebarLinks()
	-- The sidebar rows are AXLinks named "<repo> <title> +adds -dels". They live
	-- two levels under the web area; collect them wherever they are at that depth.
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		set out to {}
		repeat with a in (UI elements of wa)
			try
				repeat with l in (UI elements of a whose role is "AXLink")
					set end of out to contents of l
				end repeat
				repeat with b in (UI elements of a)
					repeat with l in (UI elements of b whose role is "AXLink")
						set end of out to contents of l
					end repeat
				end repeat
			end try
		end repeat
		return out
	end tell
end sidebarLinks

on focusViaSidebar()
	-- Press the workspace's sidebar row: no keystrokes at all, so nothing can be
	-- swallowed by a focused field or fire a palette *command*. Only rows that are
	-- actually rendered exist in the AX tree (a collapsed section has none), and
	-- the title precedence is Conductor's, so we try each candidate and require a
	-- unique hit — anything ambiguous falls back to the palette. Being wrong is
	-- survivable here: assertWorkspace re-checks before we type.
	set titles to my splitLines(system attribute "RELAY_WS_TITLES")
	if (count of titles) is 0 then return false
	set repoName to system attribute "RELAY_WS_REPO"
	set rows to my sidebarLinks()
	set hit to missing value
	repeat with candidate in titles
		if (candidate as text) is not "" then
			set matches to {}
			repeat with entry in rows
				set row to contents of entry
				set rowName to my tabLabel(row)
				if rowName contains (candidate as text) then
					if repoName is "" or rowName contains repoName then set end of matches to row
				end if
			end repeat
			if (count of matches) is 1 then
				set hit to item 1 of matches
				exit repeat
			end if
		end if
	end repeat
	if hit is missing value then return false
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of hit
	end tell
	delay 0.9
	return true
end focusViaSidebar

on focusViaPalette()
	tell application "System Events"
		key code 53
		delay 0.25
		keystroke "k" using {command down}
		delay 0.7
		keystroke (system attribute "RELAY_WS_QUERY")
		delay 0.9
		key code 36
		delay 1.3
	end tell
end focusViaPalette

on focusWorkspace()
	if (system attribute "RELAY_WS_QUERY") is "" then return
	if my focusViaSidebar() then
		try
			set strips to my tabGroups()
			if (count of strips) > 0 then
				my assertWorkspace(item 1 of strips)
				return
			end if
		end try
	end if
	my focusViaPalette()
end focusWorkspace

on tabGroups()
	-- Level-order search, returning every tab group at the shallowest depth that
	-- has one (the chat strip and the terminal strip are siblings). Bounded: the
	-- pane sits ~5 levels down, and we must never descend into the transcript.
	my requireWindow()
	tell application "System Events" to tell process "Conductor"
		set level to {window 1}
		set depth to 0
		repeat while (count of level) > 0 and depth < 8
			set found to {}
			set nextLevel to {}
			repeat with entry in level
				set node to contents of entry
				try
					repeat with h in (UI elements of node whose role is "AXTabGroup")
						set end of found to contents of h
					end repeat
					set nextLevel to nextLevel & (UI elements of node)
				end try
			end repeat
			if (count of found) > 0 then return found
			set level to nextLevel
			set depth to depth + 1
		end repeat
	end tell
	return {}
end tabGroups

on chatTabs(tg)
	tell application "System Events" to tell process "Conductor"
		set direct to (UI elements of tg whose role is "AXRadioButton")
		if (count of direct) > 0 then return direct
		set nested to {}
		repeat with g in (UI elements of tg)
			repeat with r in (UI elements of g whose role is "AXRadioButton")
				set end of nested to contents of r
			end repeat
		end repeat
		return nested
	end tell
end chatTabs

on tabLabel(t)
	tell application "System Events" to tell process "Conductor"
		return (name of t) as text
	end tell
end tabLabel

on pickChatStrip(strips, wantCount, wantTitle)
	-- Score each candidate strip: a label match outweighs a tab-count match, and
	-- a tie means we cannot tell the chat strip from the terminal strip.
	set best to missing value
	set bestTabs to {}
	set bestScore to 0
	set tied to false
	repeat with entry in strips
		set tg to contents of entry
		set strip to my chatTabs(tg)
		set score to 0
		if wantCount > 0 and (count of strip) is wantCount then set score to score + 1
		if wantTitle is not "" then
			repeat with t in strip
				if (my tabLabel(t)) contains wantTitle then
					set score to score + 2
					exit repeat
				end if
			end repeat
		end if
		if score > bestScore then
			set bestScore to score
			set best to tg
			set bestTabs to strip
			set tied to false
		else if score is bestScore and score > 0 then
			set tied to true
		end if
	end repeat
	if bestScore is 0 then error "couldn't identify the chat tab strip"
	if tied then error "can't tell which tab strip holds the target chat"
	return {best, bestTabs}
end pickChatStrip

on lastPathSegment(s)
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to "/"
	set parts to text items of s
	set AppleScript's text item delimiters to saved
	return item -1 of parts
end lastPathSegment

on paneLabels(tg, wantRole)
	-- Kept out of the caller's scope on purpose: inside a System Events tell,
	-- ordinary-looking names (tabs, count) resolve as app terms instead of vars.
	tell application "System Events" to tell process "Conductor"
		set pane to value of attribute "AXParent" of tg
		return (name of (UI elements of pane whose role is wantRole))
	end tell
end paneLabels

on anyContains(haystack, needle)
	repeat with entry in haystack
		try
			if (entry as text) contains needle then return true
		end try
	end repeat
	return false
end anyContains

on assertWorkspace(tg)
	-- The pane holding the chat strip also labels the open workspace: an
	-- AXStaticText with the branch (sans owner prefix) and a repo popup button.
	set wantBranch to system attribute "RELAY_WS_BRANCH"
	if wantBranch is "" then return
	set tail to my lastPathSegment(wantBranch)
	if not (my anyContains(my paneLabels(tg, "AXStaticText"), tail)) then
		error "the palette didn't land on " & tail
	end if
	set wantRepo to system attribute "RELAY_WS_REPO"
	if wantRepo is not "" then
		if not (my anyContains(my paneLabels(tg, "AXPopUpButton"), wantRepo)) then
			error "the palette didn't land in " & wantRepo
		end if
	end if
end assertWorkspace

on normalizeNewlines(s)
	-- "do shell script" hands back CR-delimited text; the composer reads back LF.
	-- Without this the verification below never matches a multi-line prompt.
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to return
	set parts to text items of s
	set AppleScript's text item delimiters to linefeed
	set joined to parts as text
	set AppleScript's text item delimiters to saved
	return joined
end normalizeNewlines

on fillComposer(promptText)
	-- Write the prompt straight into the composer's AXTextArea instead of
	-- stashing the clipboard, pressing Cmd+L and pasting. AXFocused and AXValue
	-- are both settable, so this needs no keystrokes and no clipboard hijack.
	-- Returns false (→ caller falls back to pasting) if anything looks off, but
	-- *clears whatever it wrote first*: leaving half a prompt behind would make
	-- the fallback paste append to it and send a garbled prompt.
	if promptText is "" then return false
	set strips to my tabGroups()
	if (count of strips) is 0 then return false
	try
		tell application "System Events" to tell process "Conductor"
			set pane to value of attribute "AXParent" of (item 1 of strips)
			set composerBox to item 1 of (UI elements of pane whose name is "composer")
			set textBox to item 1 of (UI elements of composerBox whose role is "AXTextArea")
			set value of attribute "AXFocused" of textBox to true
			set value of textBox to promptText
			delay 0.25
			if ((value of textBox) as text) does not contain promptText then
				set value of textBox to ""
				return false
			end if
		end tell
	on error
		try
			my clearComposer()
		end try
		return false
	end try
	return true
end fillComposer

on clearComposer()
	set strips to my tabGroups()
	if (count of strips) is 0 then return
	tell application "System Events" to tell process "Conductor"
		set pane to value of attribute "AXParent" of (item 1 of strips)
		set composerBox to item 1 of (UI elements of pane whose name is "composer")
		set value of (item 1 of (UI elements of composerBox whose role is "AXTextArea")) to ""
	end tell
end clearComposer

on pasteComposer()
	-- Fallback for when the composer isn't reachable: Cmd+L focuses it (after the
	-- palette, focus sits on a button, not the text box), then paste.
	tell application "System Events"
		set the clipboard to (do shell script "cat" & " " & quoted form of (system attribute "RELAY_PROMPT_FILE"))
		keystroke "l" using {command down}
		delay 0.3
		keystroke "v" using {command down}
		delay 0.15
	end tell
end pasteComposer

on selectChatTab()
	set wantIndex to (system attribute "RELAY_TAB_INDEX") as integer
	if wantIndex is 0 then return
	set wantCount to (system attribute "RELAY_TAB_COUNT") as integer
	set wantTitle to system attribute "RELAY_TAB_TITLE"
	set strips to my tabGroups()
	if (count of strips) is 0 then
		-- A lone chat has no ambiguity to resolve; more than one and we must not guess.
		if wantCount <= 1 then return
		error "couldn't find the chat tab strip"
	end if
	-- Assert the workspace first: every strip lives in the same pane, so this
	-- reports "wrong workspace" rather than a confusing "no chat strip".
	my assertWorkspace(item 1 of strips)
	set picked to my pickChatStrip(strips, wantCount, wantTitle)
	set tabs to item 2 of picked
	tell application "System Events" to tell process "Conductor"
		set target to missing value
		if wantIndex <= (count of tabs) then
			set candidate to contents of (item wantIndex of tabs)
			if wantTitle is "" or (name of candidate) contains wantTitle then set target to candidate
		end if
		if target is missing value and wantTitle is not "" then
			repeat with t in tabs
				if (name of t) contains wantTitle then
					if target is not missing value then error "several chat tabs match " & wantTitle
					set target to contents of t
				end if
			end repeat
		end if
		if target is missing value then error "chat tab " & wantIndex & " not found"
		if (value of target) is not true then
			perform action "AXPress" of target
			delay 0.5
		end if
		if (value of target) is not true then error "couldn't switch to the target chat tab"
	end tell
end selectChatTab

on composerControls()
	set strips to my tabGroups()
	if (count of strips) is 0 then error "couldn't find the composer"
	tell application "System Events" to tell process "Conductor"
		set pane to value of attribute "AXParent" of (item 1 of strips)
		set composerBox to item 1 of (UI elements of pane whose name is "composer")
		set out to {}
		repeat with e in (UI elements of composerBox)
			set end of out to contents of e
			repeat with e2 in (UI elements of e)
				set end of out to contents of e2
			end repeat
		end repeat
		return out
	end tell
end composerControls

on controlNamed(wanted)
	repeat with entry in my composerControls()
		set c to contents of entry
		if my tabLabel(c) is wanted then return c
	end repeat
	return missing value
end controlNamed

on effortButton()
	-- The effort control is a button whose *label is its current value*, so it is
	-- identified by that label rather than a stable name.
	set levels to {"Low", "Medium", "High", "Extra high", "Max", "Ultracode"}
	repeat with entry in my composerControls()
		set c to contents of entry
		if my tabLabel(c) is in levels then return c
	end repeat
	return missing value
end effortButton

on setEffort(wanted)
	-- Pressing cycles Low → Medium → High → Extra high → Max → Ultracode → wrap,
	-- so step around the ring at most one full turn and confirm the label landed.
	set btn to my effortButton()
	if btn is missing value then error "couldn't find the effort control"
	repeat 7 times
		if my tabLabel(btn) is wanted then return
		tell application "System Events" to tell process "Conductor"
			perform action "AXPress" of btn
		end tell
		delay 0.35
		set btn to my effortButton()
		if btn is missing value then error "the effort control vanished mid-cycle"
	end repeat
	error "couldn't set effort to " & wanted
end setEffort

on setPlan(wanted)
	set box to my controlNamed("Plan")
	if box is missing value then error "couldn't find the Plan toggle"
	tell application "System Events" to tell process "Conductor"
		set current to ((value of box) as text)
		if (wanted is "1" and current is "0") or (wanted is "0" and current is not "0") then
			perform action "AXPress" of box
			delay 0.4
			if ((value of box) as text) is current then error "the Plan toggle didn't change"
		end if
	end tell
end setPlan

on pressFast()
	-- Fast has no AX state to read (its label is always "Fast"), so the caller
	-- decides whether a press is needed and re-checks the DB afterwards.
	set btn to my controlNamed("Fast")
	if btn is missing value then error "this model has no Fast toggle"
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of btn
	end tell
	delay 0.4
end pressFast

on firstLine(s)
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set parts to text items of s
	set AppleScript's text item delimiters to saved
	return item 1 of parts
end firstLine

on setModel(wanted)
	set popup to missing value
	repeat with entry in my composerControls()
		set c to contents of entry
		if my tabLabel(c) contains "Change agent" then set popup to c
	end repeat
	if popup is missing value then error "couldn't find the model picker"
	if (my tabLabel(popup)) contains ("(" & wanted & ")") then return
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of popup
	end tell
	delay 1.0
	-- Menu labels carry badges ("Opus 5 NEW"), so an exact match is preferred but a
	-- prefix match is accepted — except when it is ambiguous ("Sonnet 4.6" would
	-- otherwise also match "Sonnet 4.6 1M"), which must fail rather than guess.
	set chosen to missing value
	set loose to {}
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		repeat with m in (UI elements of wa whose role is "AXMenu")
			repeat with mi in (UI elements of m whose role is "AXMenuItem")
				set label to my firstLine(my tabLabel(mi))
				if label is wanted then
					set chosen to contents of mi
				else if label starts with wanted then
					set end of loose to contents of mi
				end if
			end repeat
		end repeat
	end tell
	if chosen is missing value and (count of loose) is 1 then set chosen to item 1 of loose
	if chosen is missing value then
		tell application "System Events" to key code 53
		if (count of loose) > 1 then error "several models match " & wanted
		error "no model named " & wanted
	end if
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of chosen
	end tell
	delay 0.8
	set popup to missing value
	repeat with entry in my composerControls()
		set c to contents of entry
		if my tabLabel(c) contains "Change agent" then set popup to c
	end repeat
	if popup is missing value then error "the model picker vanished"
	if (my tabLabel(popup)) does not contain ("(" & wanted & ")") then error "the model didn't switch to " & wanted
end setModel

on listModels()
	-- Enumerate the picker rather than hard-coding a model list that would rot on
	-- every Conductor release. Opens the menu, reads the labels, closes it again.
	set popup to missing value
	repeat with entry in my composerControls()
		set c to contents of entry
		if my tabLabel(c) contains "Change agent" then set popup to c
	end repeat
	if popup is missing value then error "couldn't find the model picker"
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of popup
	end tell
	delay 1.0
	set labels to {}
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		repeat with m in (UI elements of wa whose role is "AXMenu")
			repeat with mi in (UI elements of m whose role is "AXMenuItem")
				set end of labels to my firstLine(my tabLabel(mi))
			end repeat
		end repeat
	end tell
	tell application "System Events" to key code 53
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to linefeed
	set joined to labels as text
	set AppleScript's text item delimiters to saved
	return joined
end listModels

on applyAgentOptions()
	set wantEffort to system attribute "RELAY_SET_EFFORT"
	set wantPlan to system attribute "RELAY_SET_PLAN"
	set wantFast to system attribute "RELAY_SET_FAST"
	set wantModel to system attribute "RELAY_SET_MODEL"
	if wantModel is not "" then my setModel(wantModel)
	if wantEffort is not "" then my setEffort(wantEffort)
	if wantPlan is not "" then my setPlan(wantPlan)
	if wantFast is "1" then my pressFast()
end applyAgentOptions`

/** Conductor's command palette matches workspaces by branch — its unique key. A
 * looser query (directory name) can match a command like unarchive, so prefer
 * branch and only fall back when it's absent. */
function focusQuery(ws: Workspace): string {
	return ws.branch || ws.workspace_name || ws.directory_name || ''
}

/**
 * Every title Conductor might be showing for this workspace in the sidebar
 * (its precedence: manual name → PR title → humanized branch → codename). The
 * sidebar press tries each and requires a unique row; a miss just means we fall
 * back to the palette, so this doesn't have to reproduce the precedence exactly.
 */
function sidebarTitles(ws: Workspace): string[] {
	const slug = ws.branch?.includes('/') ? ws.branch.slice(ws.branch.indexOf('/') + 1) : ws.branch
	const humanized = slug?.replace(/[-_]/g, ' ').trim()
	return [
		ws.workspace_name,
		ws.pr_title,
		humanized ? humanized[0].toUpperCase() + humanized.slice(1) : '',
		ws.directory_name
	].filter((t): t is string => Boolean(t))
}

/**
 * May the actuator restart Conductor to force a window into existence?
 *
 * Restarting is the only lever left when a running, windowless Conductor ignores
 * both `reopen` and a Dock click — it is single-window and single-instance, so
 * there is nothing else to press. It is also the one step here that can destroy
 * work: quitting takes any agent mid-turn down with it. "Nothing is running" is a
 * fact only the read side has, so server.ts wires this to a DB read rather than
 * writes.ts guessing. Unset → never restart, which is the safe default for any
 * caller that hasn't opted in.
 */
let restartGuard: (() => boolean) | null = null

export function setRestartGuard(guard: (() => boolean) | null): void {
	restartGuard = guard
}

function restartAllowed(): boolean {
	try {
		return restartGuard?.() ?? false
	} catch {
		return false
	}
}

/** The target rides in on the environment, like RELAY_WS_QUERY, to dodge AppleScript escaping. */
function targetEnv(target: SendTarget): Record<string, string> {
	return {
		RELAY_ALLOW_RESTART: restartAllowed() ? '1' : '',
		RELAY_TAB_INDEX: String(target.tab?.index ?? 0),
		RELAY_TAB_COUNT: String(target.tab?.count ?? 0),
		RELAY_TAB_TITLE: target.tab?.title ?? '',
		RELAY_WS_BRANCH: target.workspace.branch ?? '',
		RELAY_WS_REPO: target.workspace.repo_name ?? '',
		RELAY_WS_QUERY: focusQuery(target.workspace),
		RELAY_WS_TITLES: sidebarTitles(target.workspace).join('\n')
	}
}

/** osascript echoes the whole failing script back; keep just the reason for the phone. */
function osaError(err: unknown): string {
	const raw = err instanceof Error ? err.message : String(err)
	// A timeout kill carries no execution error at all — its first line is
	// "Command failed: osascript -e" plus the whole script, which is useless here.
	if (err && typeof err === 'object' && 'killed' in err && (err as { killed?: boolean }).killed) {
		return 'Conductor took too long to respond'
	}
	return raw.match(/execution error: (.+?) \(-?\d+\)/)?.[1] ?? raw.split('\n')[0]
}

/**
 * Drives Conductor's real send path via macOS Accessibility (AppleScript): focus
 * the target workspace, paste the prompt, press Enter. Uses whatever model /
 * permission mode the session already has (zero risk of altering the agent),
 * which is why it's the default.
 *
 * Precise targeting comes from focusing the intended workspace first through
 * Conductor's command palette (Cmd+K → branch → Enter) and then selecting the
 * target chat's tab (Accessibility, see SELECT_CHAT_TAB_HANDLERS), so the prompt
 * lands in the right session regardless of what was focused — no private IPC and
 * nothing to rebreak on a Conductor update (unlike the sidecar).
 */
export class AppleScriptActuator implements Actuator {
	readonly name = 'applescript'
	readonly caveat = 'Focuses the target workspace (Cmd+K) and its chat tab before sending.'
	readonly precise = true

	async send(target: SendTarget, text: string): Promise<SendResult> {
		// Focus the target workspace, select its chat tab, fill the composer, send.
		// Filling is an Accessibility write (no keystrokes, no clipboard); the
		// clipboard paste is kept only as a fallback, and stashes/restores around it.
		const script = `
${SELECT_CHAT_TAB_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
set promptText to my normalizeNewlines(do shell script "cat" & " " & quoted form of (system attribute "RELAY_PROMPT_FILE"))
if not (my fillComposer(promptText)) then
	set savedClipboard to the clipboard
	my pasteComposer()
	delay 0.1
	set the clipboard to savedClipboard
end if
tell application "System Events"
	key code 36
end tell
`.trim()
		// Pass the prompt via a temp file + env to avoid AppleScript string escaping.
		const os = await import('node:os')
		const fs = await import('node:fs/promises')
		const path = await import('node:path')
		const tmp = path.join(os.tmpdir(), `relay-prompt-${process.pid}-${Date.now()}.txt`)
		await fs.writeFile(tmp, text, 'utf8')
		try {
			await uiTurn(() =>
				exec('osascript', ['-e', script], {
					env: { ...process.env, RELAY_PROMPT_FILE: tmp, ...targetEnv(target) },
					timeout: 20000
				})
			)
			return { ok: true, strategy: this.name }
		} catch (err) {
			return { ok: false, strategy: this.name, error: osaError(err) }
		} finally {
			await fs.rm(tmp, { force: true }).catch(() => undefined)
		}
	}
}

/**
 * Conductor stores the effort level as `sessions.claude_effort_level`, but the
 * composer button is labelled with the human name and *cycles* through them in
 * this order. Both directions are needed: the label to press toward, and the DB
 * value to confirm against.
 */
export const EFFORT_LABELS: Record<string, string> = {
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	xhigh: 'Extra high',
	max: 'Max',
	ultracode: 'Ultracode'
}

/** What a phone can change about the agent before (or instead of) sending a prompt. */
export interface AgentOptions {
	/** A `claude_effort_level` value (low…ultracode), not the UI label. */
	effort?: string
	plan?: boolean
	/** Fast mode exposes no readable state, so pass `true` only when it must flip. */
	toggleFast?: boolean
	/** The model picker's menu label, e.g. "Opus 5" or "Sonnet 4.6". */
	model?: string
}

/**
 * Apply agent settings to a specific chat: focus its workspace and tab (same
 * verified path as a send), then drive the composer's own controls. Every step
 * confirms the control landed on the requested value and errors out otherwise,
 * so a half-applied change is reported rather than assumed.
 */
export async function setAgentOptions(target: SendTarget, opts: AgentOptions): Promise<SendResult> {
	if (opts.effort && !EFFORT_LABELS[opts.effort]) {
		return { ok: false, strategy: 'applescript', error: `unknown effort level ${opts.effort}` }
	}
	const script = `
${SELECT_CHAT_TAB_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
my applyAgentOptions()
return "ok"`.trim()
	try {
		await uiTurn(() =>
			exec('osascript', ['-e', script], {
				env: {
					...process.env,
					...targetEnv(target),
					RELAY_SET_EFFORT: opts.effort ? EFFORT_LABELS[opts.effort] : '',
					RELAY_SET_PLAN: opts.plan === undefined ? '' : opts.plan ? '1' : '0',
					RELAY_SET_FAST: opts.toggleFast ? '1' : '',
					RELAY_SET_MODEL: opts.model ?? ''
				},
				timeout: 25000
			})
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

/** The model labels Conductor is currently offering, read off the live picker. */
export async function listAgentModels(target: SendTarget): Promise<{ ok: boolean; models?: string[]; error?: string }> {
	const script = `
${SELECT_CHAT_TAB_HANDLERS}

my activateConductor()
my focusWorkspace()
my selectChatTab()
return my listModels()`.trim()
	try {
		const { stdout } = await uiTurn(() =>
			exec('osascript', ['-e', script], {
				env: { ...process.env, ...targetEnv(target) },
				timeout: 25000
			})
		)
		const models = stdout
			.split('\n')
			.map(s => s.trim())
			.filter(Boolean)
		return { ok: true, models }
	} catch (err) {
		return { ok: false, error: osaError(err) }
	}
}

/**
 * Create a *new workspace*, optionally with a first prompt, via Conductor's
 * deep-link scheme (conductor.build/docs/reference/deep-links).
 *
 * This is the one write here that touches no UI at all: no Accessibility, no
 * keystrokes, no focus dependency — macOS hands the URL to Conductor and it
 * creates the worktree. Nothing to rebreak on an update, unlike every other
 * path in this file.
 *
 * Three things the scheme dictates:
 *  - Parameters sit *flat* after the scheme (`conductor://prompt=…&path=…`), not
 *    behind a `?`, and every value must be URL-encoded — which is also what stops
 *    a prompt containing `&path=` from redirecting the workspace to another repo.
 *  - **An unmatched (or absent) `path` silently falls back to the first repo**, so
 *    the caller resolves a real `root_path` first rather than trusting a name.
 *  - **`prompt` is optional**: a bare `conductor://path=…` opens an empty
 *    workspace, same as Conductor's own New workspace. That form isn't in the
 *    docs (every documented route carries a prompt) but is verified against the
 *    live app — so if it ever stops working, this is the line to suspect.
 *
 * The link is fire-and-forget: it reports that Conductor was *handed* the URL,
 * never that a workspace appeared. The caller watches the DB for that.
 */
export async function createWorkspace(prompt: string, repoPath: string | null): Promise<SendResult> {
	if (!prompt.trim() && !repoPath) {
		return { ok: false, strategy: 'deeplink', error: 'a new workspace needs a repo or a first prompt' }
	}
	const query = [
		prompt.trim() ? `prompt=${encodeURIComponent(prompt)}` : '',
		repoPath ? `path=${encodeURIComponent(repoPath)}` : ''
	]
		.filter(Boolean)
		.join('&')
	try {
		// Serialized with the AX writes: creating a workspace pulls Conductor forward and
		// switches which one is showing, which is precisely what a concurrent send assumes.
		await uiTurn(() => exec('open', [`conductor://${query}`], { timeout: 15000 }))
		return { ok: true, strategy: 'deeplink' }
	} catch (err) {
		return { ok: false, strategy: 'deeplink', error: osaError(err) }
	}
}

/**
 * Open a new chat in the target workspace — Conductor's "New chat, same files"
 * (Cmd+T). Focuses the workspace first (command palette → branch), then Cmd+T; the
 * caller detects the freshly-created session id from the DB.
 */
export async function newChat(workspace: Workspace): Promise<SendResult> {
	if (!focusQuery(workspace)) return { ok: false, strategy: 'applescript', error: 'workspace has no branch to focus' }
	const script = `
${SELECT_CHAT_TAB_HANDLERS}

my activateConductor()
my focusWorkspace()
tell application "System Events"
	keystroke "t" using {command down}
end tell`.trim()
	try {
		await uiTurn(() =>
			exec('osascript', ['-e', script], {
				env: { ...process.env, ...targetEnv({ workspace, sessionId: null }) },
				timeout: 15000
			})
		)
		return { ok: true, strategy: 'applescript' }
	} catch (err) {
		return { ok: false, strategy: 'applescript', error: osaError(err) }
	}
}

export type WriteStrategy = 'applescript' | 'sidecar'

export function pickActuator(strategy: WriteStrategy): Actuator {
	return strategy === 'sidecar' ? new SidecarActuator() : new AppleScriptActuator()
}

/** Effective actuator description for the UI, factoring in runtime availability. */
export async function describeActuator(
	actuator: Actuator
): Promise<{ name: string; caveat: string; precise: boolean; available: boolean }> {
	const available = actuator.available ? await actuator.available().catch(() => false) : true
	return { name: actuator.name, caveat: actuator.caveat, precise: actuator.precise, available }
}
