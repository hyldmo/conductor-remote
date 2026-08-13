(*
	Everything the relay drives Conductor's UI with, in one place.

	Loaded verbatim by src/writes.ts, which appends a few lines naming the
	handlers to run and hands the result to `osascript`. It lives in its own file
	rather than a TypeScript template literal for three reasons: an editor can
	highlight it, `yarn verify` can compile-check it (scripts/check-applescript.ts,
	which is the only automated test this code has), and a backtick in a comment
	no longer terminates the string it used to sit inside — so this sentence,
	which contains `one`, is now harmless.

	The target rides in on the environment (RELAY_WS_*, RELAY_TAB_*, RELAY_SET_*,
	RELAY_PROMPT_FILE) rather than being interpolated, which keeps AppleScript
	string escaping out of the picture entirely.

	Two traps to respect when editing:

	 - Inside a `tell application "System Events"` block, ordinary-looking variable
	   names resolve as System Events terms. `tabs` and `groups` become "every
	   tab/group of the process", so a loop over your own list quietly iterates the
	   wrong thing and the handler returns nothing. Keep logic outside the tell and
	   reach in through one-line helpers, or name the variables `strip` and `pane`.
	 - Every read is rooted at `window 1`, and Conductor keeps running with its
	   windows closed. Go through `requireWindow` / `webArea` so a window that
	   closed mid-run says so in words.

	How the chat targeting works, and why each step is here:

	`openViaDeepLink` normally selects the chat already, by id. The handlers below
	are what confirm that, and what still does the work for the fallback focus
	paths, which only reach the right workspace. A workspace holds several chats
	and Conductor keeps typing in whichever tab is already active, so a send
	addressed to a non-active chat would land in the wrong agent.

	Conductor's webview exposes its whole tree through macOS Accessibility. The
	chat strip is an AXTabGroup whose AXRadioButtons are the tabs (AXValue marks
	the selected one, AXPress switches to it and does *not* close the chat). The
	strip's order matches reads.listSessions (created_at ASC), so the caller
	addresses a tab by 1-based index and we cross-check the label.

	Three traps that targeting has to survive:

	 - The tabs are not the strip's direct children. Each sits one AXGroup deep and
	   is named for its own close action ("Close chat <title>"), while a "Close file
	   view" radio button, which is not a chat, *is* a direct child. Reading the
	   direct children and stopping there made every chat strip look like a one-tab
	   strip called "Close file view", which then lost the scoring below to the
	   terminal panel and failed every send with "chat tab 1 not found". So
	   `stripRadios` reads both levels and `chatTabs` keeps the "Close chat" ones.
	 - The terminal panel is an AXTabGroup too (radio buttons named Setup / Run /
	   Terminal 1), a sibling of the chat strip in the same pane. Picking "the first
	   tab group" would sometimes press a terminal tab, so candidates are *scored*
	   on tab count plus label and a tie refuses to act.
	 - The palette can land on the wrong workspace (a loose query matches a command;
	   a deleted branch opens a modal). The pane header carries the branch and repo,
	   so we read them back and bail if they disagree.

	Target is read from RELAY_TAB_{INDEX,COUNT,TITLE} and RELAY_WS_{BRANCH,REPO};
	index 0 disables the tab step. Every failure path errors out so the caller
	aborts *before* typing — landing in the wrong chat is worse than not sending.
*)

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
	try
		tell application "Conductor" to activate
	on error errText
		error "couldn't bring Conductor to the front: " & errText
	end try
	delay 0.4
	-- Patience sized to what we're waiting for. An app that already shows a window
	-- returns from waitForWindow immediately, so the short budget only ever times a
	-- redraw (~4s is plenty). Zero windows gets the cold-launch budget (~9s) even
	-- when the process exists: the restart below is fire-and-forget, so the *next*
	-- attempt arrives while Conductor is still drawing its first window — "process
	-- exists, no window yet" — and a 4s wait there quits it again mid-launch,
	-- which is how one restart becomes a loop that never lets it come up. ~9s
	-- still fits the 28s script budget once the send's own delays are counted.
	set patience to 16
	if (item 1 of firstProbe) < 1 then set patience to 36
	if my waitForWindow(patience) then return
	-- Running, readable, and still zero windows: reopen and the Dock click have
	-- both drawn nothing, so a restart is the only thing left. "Open it on your
	-- Mac" is not advice a phone can act on — that is the whole point of this app.
	if (system attribute "RELAY_ALLOW_RESTART") is "1" and (item 1 of my windowProbe()) is 0 then
		-- Evidence before the restart tears the state down: which processes match
		-- Conductor and who owns a window is the one fact that separates "genuinely
		-- windowless" (a locked or unattended Mac) from "we're addressing the wrong
		-- process" — and after the relaunch it would describe the new process, not
		-- the state that failed. windowFailure() already carries it; this branch
		-- used to drop it, which made a repeating no-window failure undebuggable
		-- from the log alone.
		set ev to my windowEvidence()
		set restartError to my restartConductor()
		if restartError is not "" then error restartError & ev
		error "Conductor was running with no window and ignored both reopen and a Dock click, so the relay restarted it. Give it a few seconds and send again." & ev
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

on findSidebarRow()
	-- The workspace's own sidebar row. Only rows that are actually rendered exist
	-- in the AX tree (a collapsed section has none), and the title follows
	-- Conductor's precedence, so we try each candidate and require a *unique* hit —
	-- anything ambiguous returns nothing rather than guessing at a neighbour.
	set titles to my splitLines(system attribute "RELAY_WS_TITLES")
	if (count of titles) is 0 then return missing value
	set repoName to system attribute "RELAY_WS_REPO"
	set rows to my sidebarLinks()
	repeat with candidate in titles
		if (candidate as text) is not "" then
			set matches to {}
			repeat with entry in rows
				set row to contents of entry
				-- Guarded read: the sidebar re-renders constantly (every commit
				-- changes a row's "+adds -dels"), and one row that goes stale
				-- mid-scan must not take the whole search down with it.
				set rowName to my axName(row)
				if rowName contains (candidate as text) then
					if repoName is "" or rowName contains repoName then set end of matches to row
				end if
			end repeat
			if (count of matches) is 1 then return item 1 of matches
		end if
	end repeat
	return missing value
end findSidebarRow

on focusViaSidebar()
	-- Press that row: no keystrokes at all, so nothing can be swallowed by a
	-- focused field or fire a palette *command*. Being wrong is survivable here —
	-- assertWorkspace re-checks before we type — and a miss falls back to the palette.
	set hit to my findSidebarRow()
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

on paneAgrees()
	-- Nothing in the open pane contradicts the target: a chat pane is there and its
	-- header assertion passed (which is a no-op when there's no branch to check it
	-- against). This is what confirms a sidebar press landed.
	try
		set strips to my tabGroups()
		if (count of strips) is 0 then return false
		my assertWorkspace(item 1 of strips)
		return true
	end try
	return false
end paneAgrees

on atTargetWorkspace()
	-- "Are we already there?" — the *strict* form of the question, so it needs a
	-- branch to have been checked and not merely skipped. Worth asking first because
	-- the pane header answers in ~0.5s where reading the sidebar's rows to press one
	-- measured 5-7s, the single largest cost in a send: a phone sends to the same
	-- workspace over and over, and Conductor stays where it was left. Safe as a
	-- shortcut because it *is* the assertion the send makes before typing anyway.
	if (system attribute "RELAY_WS_BRANCH") is "" then return false
	return my paneAgrees()
end atTargetWorkspace

on openViaDeepLink()
	-- Conductor's *own* workspace link, the one its sidebar row menu copies under
	-- "Copy link" (Cmd+Shift+C): one URL carrying the workspace id and the chat id,
	-- addressed the way the relay already reads them rather than by any label a
	-- release can rename. It replaces the entire focus dance below - no sidebar
	-- scan, no palette keystrokes, no title precedence to reproduce - and measures
	-- ~0.6s against the 5-10s the row press costs on a 30-workspace sidebar.
	--
	-- Two things it fixes outright rather than merely speeding up. It navigates by
	-- *id*, so a collapsed sidebar section (which hides the row from Accessibility
	-- entirely) stops mattering; and it opens the chat tab explicitly, so a pane
	-- left on a file view or a terminal - where the chat strip does not exist in
	-- the AX tree at all, and every send failed with "couldn't identify the chat
	-- tab strip" - comes back to the composer on its own.
	--
	-- Still fail-closed: the URL is fire-and-forget, so what counts as success is
	-- the same pane assertion every other path here has to pass. A Conductor
	-- without the route (before 0.71) ignores it silently, and a scheme macOS
	-- can't resolve fails the "open" outright - both fall through to the sidebar.
	set linkURL to system attribute "RELAY_WS_LINK"
	if linkURL is "" then return false
	try
		do shell script "open " & quoted form of linkURL
	on error
		return false
	end try
	-- Bounded on purpose: this poll is also the cost of *not* having the route, and
	-- the fallback below still has to run inside the same budget afterwards.
	repeat with attempt from 1 to 10
		delay 0.15
		if my paneAgrees() then return true
	end repeat
	return false
end openViaDeepLink

on focusWorkspace()
	if (system attribute "RELAY_WS_QUERY") is "" then return
	if my openViaDeepLink() then return
	if my atTargetWorkspace() then return
	if my focusViaSidebar() then
		if my paneAgrees() then return
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

on stripRadios(tg)
	-- Every radio button in a tab strip, whether it is a direct child or sits one
	-- group deep, in tree order. Both shapes are live at once: the terminal strip's
	-- tabs are direct children, while a chat tab is wrapped in its own AXGroup with
	-- the file-view toggle beside it as a plain child. Reading only the direct ones
	-- (and stopping as soon as any turned up) is what made a chat strip look like a
	-- one-tab strip called "Close file view".
	tell application "System Events" to tell process "Conductor"
		set acc to {}
		repeat with k in (UI elements of tg)
			set node to contents of k
			if (role of node) is "AXRadioButton" then
				set end of acc to node
			else
				try
					repeat with r in (UI elements of node whose role is "AXRadioButton")
						set end of acc to contents of r
					end repeat
				end try
			end if
		end repeat
		return acc
	end tell
end stripRadios

on chatTabs(tg)
	-- Of those, a chat tab is the one whose accessible name is its own close action,
	-- "Close chat <title>". The strip's other radio button is "Close file view",
	-- which is not a chat and must not shift the indices this file addresses tabs
	-- by — off by one is how a prompt lands in the wrong conversation. Falls back to
	-- every radio button when none carries the prefix, so a renamed label costs the
	-- filter rather than emptying the strip.
	set radios to my stripRadios(tg)
	set chats to {}
	repeat with entry in radios
		set node to contents of entry
		if (my axName(node)) starts with "Close chat" then set end of chats to node
	end repeat
	if (count of chats) > 0 then return chats
	return radios
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
end applyAgentOptions

on axRole(el)
	tell application "System Events" to tell process "Conductor"
		try
			return role of el
		on error
			return ""
		end try
	end tell
end axRole

on axKids(el)
	tell application "System Events" to tell process "Conductor"
		try
			return UI elements of el
		on error
			return {}
		end try
	end tell
end axKids

on menusUnder(root, maxDepth)
	-- Every AXMenu at or below root, breadth-first and bounded. The status
	-- submenu opens *nested inside* the row menu rather than beside it, so a
	-- search that stops at the first hit (the way setModel scans the web area's
	-- direct children) never sees it.
	set level to {root}
	set found to {}
	set depth to 0
	repeat while (count of level) > 0 and depth < maxDepth
		set nextLevel to {}
		repeat with entry in level
			set node to contents of entry
			if (my axRole(node)) is "AXMenu" then set end of found to node
			set nextLevel to nextLevel & (my axKids(node))
		end repeat
		set level to nextLevel
		set depth to depth + 1
	end repeat
	return found
end menusUnder

on axName(el)
	-- Guarded: a menu re-renders under us, and reading the name of an element that
	-- has since gone throws an object-specifier error from wherever we happened to be.
	tell application "System Events" to tell process "Conductor"
		try
			set n to name of el
			if n is missing value then return ""
			return n as text
		on error
			return ""
		end try
	end tell
end axName

on menuItemNamed(m, wanted)
	repeat with mi in (my axKids(m))
		set node to contents of mi
		if (my axRole(node)) is "AXMenuItem" and (my axName(node)) is wanted then return node
	end repeat
	return missing value
end menuItemNamed

on waitForMenuWith(root, maxDepth, itemName, attempts)
	-- Identify the menu by an item it *contains*, never as "the first AXMenu on
	-- screen": a model picker left open, or a menu from the run before, is also an
	-- AXMenu, and picking it produced "no Set status item" on a menu that had never
	-- been the workspace's. A menu is drawn by the webview, not by us, so how long
	-- it takes varies with what Conductor is busy doing — poll rather than guess
	-- one delay; the common case costs a single sweep.
	repeat with i from 1 to attempts
		repeat with entry in my menusUnder(root, maxDepth)
			set node to contents of entry
			if (my menuItemNamed(node, itemName)) is not missing value then return node
		end repeat
		delay 0.5
	end repeat
	return missing value
end waitForMenuWith

on dismissMenus()
	-- Two escapes: one for the submenu, one for the row menu. Leaving either open
	-- would swallow the next run's keystrokes.
	tell application "System Events"
		key code 53
		delay 0.25
		key code 53
	end tell
end dismissMenus

on setWorkspaceStatus()
	-- Conductor has no menu-bar or palette command for this, so the only lever is
	-- the sidebar row's own context menu (Mark as unread / Pin / Set status /
	-- Rename / Copy link / Archive). Right-clicking the row needs no focus change,
	-- so unlike a send this never disturbs which workspace is on screen.
	set wanted to system attribute "RELAY_SET_STATUS"
	if wanted is "" then error "no status requested"
	set theRow to my findSidebarRow()
	if theRow is missing value then
		error "couldn't find this workspace in the sidebar — a collapsed section hides its row from Accessibility"
	end if
	-- Scroll it into view first. A row that exists in the AX tree but sits outside
	-- the sidebar's visible strip accepts AXShowMenu and draws nothing — which is
	-- exactly what happens right after a status change moves it to another group.
	tell application "System Events" to tell process "Conductor"
		try
			perform action "AXScrollToVisible" of theRow
		end try
	end tell
	delay 0.4
	-- Clear anything already open (a picker, or a menu a previous run left behind)
	-- so the sweep below can only match the one this right-click draws.
	tell application "System Events" to key code 53
	delay 0.3
	tell application "System Events" to tell process "Conductor"
		perform action "AXShowMenu" of theRow
	end tell
	-- Depth 4, not the whole tree: the row menu is a portal near the top of the web
	-- area, and the *transcript* hangs off that same root — a deep sweep walks every
	-- message bubble and costs more than the rest of this write put together (it
	-- grows with the conversation, so it degrades as you use the app).
	set rowMenu to my waitForMenuWith(my webArea(), 4, "Set status", 6)
	if rowMenu is missing value then
		my dismissMenus()
		error "the workspace's menu didn't open — or it no longer offers Set status"
	end if
	set statusItem to my menuItemNamed(rowMenu, "Set status")
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of statusItem
	end tell
	-- The submenu is an AXMenu nested a few levels *inside* the row menu (Conductor
	-- expands it in place rather than opening a sibling), so search from that menu —
	-- searching the web area again would re-walk the world. Two things make this a
	-- poll rather than a read: the row-menu handle goes stale across the expansion
	-- (it reports no children instead of erroring), so it is re-found each pass; and
	-- the submenu's *items* arrive a beat after the submenu itself, so the thing we
	-- wait for is the wanted status, not the container that will hold it.
	set subMenu to missing value
	repeat with attempt from 1 to 8
		set liveMenu to my waitForMenuWith(my webArea(), 4, "Set status", 1)
		if liveMenu is not missing value then
			set subMenu to my waitForMenuWith(liveMenu, 5, wanted, 1)
		end if
		if subMenu is not missing value then exit repeat
		delay 0.4
	end repeat
	if subMenu is missing value then
		my dismissMenus()
		error "Conductor never offered a status called " & wanted
	end if
	set choice to my menuItemNamed(subMenu, wanted)
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of choice
	end tell
	delay 0.6
end setWorkspaceStatus
