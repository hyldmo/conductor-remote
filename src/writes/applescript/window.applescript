(*
	Everything the relay drives Conductor's UI with, in one place.

	Loaded verbatim by src/writes.ts, which appends a few lines naming the
	handlers to run and hands the result to `osascript`. It lives in its own file
	rather than a TypeScript template literal for three reasons: an editor can
	highlight it, `yarn verify` can compile-check it (scripts/check-applescript.ts,
	the repository validator for this language), and a backtick in a comment
	no longer terminates the string it used to sit inside — so this sentence,
	which contains `one`, is now harmless.

	The target rides in on the environment (RELAY_WS_*, RELAY_TAB_*, RELAY_SET_*,
	RELAY_PROMPT_FILE) rather than being interpolated, which keeps AppleScript
	string escaping out of the picture entirely. The three matching labels use a
	UTF-8 temporary file because `system attribute` decodes text as MacRoman.

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
	-- `do shell script` converts the file's LF separators to AppleScript returns.
	-- `paragraphs` handles that form and keeps empty fields between separators.
	return paragraphs of s
end splitLines

-- The target file's first two lines are tab title and palette query. The
-- remaining lines are sidebar-title candidates. The path is ASCII; the file
-- contents reach AppleScript through `do shell script` as UTF-8.
on targetField(fieldIndex)
	set fields to my splitLines(do shell script "cat " & quoted form of (system attribute "RELAY_TARGET_FILE"))
	if fieldIndex > (count of fields) then return ""
	return item fieldIndex of fields
end targetField

on targetSidebarTitles()
	set fields to my splitLines(do shell script "cat " & quoted form of (system attribute "RELAY_TARGET_FILE"))
	if (count of fields) < 3 then return {}
	set titles to {}
	repeat with fieldIndex from 3 to (count of fields)
		set end of titles to item fieldIndex of fields
	end repeat
	return titles
end targetSidebarTitles

on windowProbe()
	-- One read, three outcomes, none of them guessed: {count, errNum, errText}.
	-- count is -1 when macOS refused the read at all. Everything that wants to
	-- know about windows goes through here, because "returned 0" and "refused to
	-- answer" are different facts and only this handler still has both.
	-- The timeout is load-bearing: a wedged Conductor (seen live after a restart
	-- collided with a relaunch) answers deep links but hangs every AX read, and
	-- without a cap this call blocks until the node-side ceiling kills the whole
	-- run as "took too long" — 28s of silence instead of a named cause. 6s turns
	-- that into error -1712, which refusalReason maps to words.
	try
		with timeout of 6 seconds
			tell application "System Events" to tell process "Conductor"
				set winCount to (count of windows)
			end tell
		end timeout
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
	if errNum is -1712 then return "Conductor stopped answering UI reads (the Accessibility query timed out) - the app looks wedged even though it may still process deep links. Force-quit Conductor on your Mac and open it again; if it repeats with a healthy Conductor, System Events is stuck - run: killall 'System Events'"
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

on serverWindowCount()
	-- Second opinion from the window server, because the Accessibility tree only
	-- shows windows on the *current* Space: a full-screen Conductor (which owns its
	-- own Space) or a Mac sitting at the lock screen reads as "no window" from AX
	-- while the window very much exists — and acting on the AX answer alone once
	-- quit a Conductor whose window the user had left open all along.
	-- CGWindowListCopyWindowInfo(kCGWindowListOptionAll) sees every Space; owner
	-- name and layer are readable without the Screen Recording grant (only window
	-- *titles* are gated). Layer 0 keeps it to real windows. -1 = the probe itself
	-- failed, which callers must treat as "no opinion", never as "no window".
	-- The bindFunction is the load-bearing part, twice over: as shipped this read
	-- "$.CFBridgingRelease(...)", which is an *inline*, not a symbol, and calling it
	-- through JXA segfaults the osascript child (measured: exit 139) — so this probe
	-- returned -1 on every call and the veto it feeds never once fired. And without
	-- the rebind, JXA types the CF return as a bare pointer that deepUnwrap answers
	-- with undefined — same wrong verdict, silently. Rebinding the function to
	-- return 'id' makes the array real (verified live: 12 windows, behind a lock).
	set jxa to "ObjC.import('CoreGraphics'); ObjC.bindFunction('CGWindowListCopyWindowInfo', ['id', ['unsigned int', 'unsigned int']]); const w = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(0, 0)) || []; w.filter(x => x.kCGWindowOwnerName === 'Conductor' && x.kCGWindowLayer === 0).length"
	try
		return (do shell script "osascript -l JavaScript -e " & quoted form of jxa) as integer
	on error
		return -1
	end try
end serverWindowCount

on screenLocked()
	-- "locked" / "unlocked" / "unknown". CGSessionCopyCurrentDictionary carries
	-- CGSSessionScreenIsLocked = 1 while the lock screen is up and omits the key
	-- entirely when it is not — same stdlib JXA channel as serverWindowCount.
	-- This matters because the lock screen is the product's home ground: sends
	-- come from a phone precisely when nobody is at the Mac, so "is the lock up"
	-- is the difference between a state a restart can fix and one it provably
	-- makes worse (see the restart gate in activateConductor).
	-- Same two traps as serverWindowCount: $.CFBridgingRelease segfaults under JXA,
	-- and without the rebind deepUnwrap reads the CF dictionary as undefined — which
	-- the "|| {}" then turned into a confident "unlocked" on a locked Mac. The fixed
	-- probe was verified against a genuinely locked screen (CGSSessionScreenIsLocked
	-- true, every session key present).
	set jxa to "ObjC.import('CoreGraphics'); ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []]); const d = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary()) || {}; d.CGSSessionScreenIsLocked ? 'locked' : 'unlocked'"
	try
		return do shell script "osascript -l JavaScript -e " & quoted form of jxa
	on error
		return "unknown"
	end try
end screenLocked

on windowEvidence()
	-- Zero windows is a dead end without knowing what the AX tree *does* show, and
	-- guessing the next thing to press has already cost a round trip (there is no
	-- "New Window" item — Conductor is single-window). So the error carries the
	-- evidence instead: who macOS thinks Conductor is, what its menus offer, how
	-- many windows the window server counts across all Spaces (AX only sees the
	-- current one), and whether the lock screen is up.
	set procs to my processWindowCounts()
	set titles to my menuTitles()
	set ev to " [window server: " & my serverWindowCount() & "; screen: " & my screenLocked() & "]"
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

on restartApp()
	-- The restart the phone asks for (POST /api/conductor/restart), as opposed to
	-- the one activateConductor falls back to on its own. Same lever, different
	-- entry, and the second entry is the whole point: that fallback fires only when
	-- a *running* Conductor draws no window, so it is unreachable for the failure
	-- this exists for — a Conductor whose window, sidebar and composer are all fine
	-- while its agent runtime has stopped producing output. Measured live
	-- (2026-09-02): prompts kept landing as `session_messages` rows for hours after
	-- the last agent frame, so every window probe here would have said "healthy".
	--
	-- RELAY_ALLOW_RESTART is deliberately NOT consulted. That flag exists so the
	-- fallback never destroys work the caller didn't ask about; here the caller is
	-- a person who pressed a button, and server.ts has already counted the working
	-- chats from the DB and refused without `stopAgents`.
	set refusal to my refusalReason(my windowProbe())
	if refusal is not "" then error refusal
	-- Behind the lock screen a relaunch comes up windowless, and once came up
	-- wedged (answering deep links, hanging every AX read) — the same reason the
	-- fallback refuses there. The sentence starts with the phrase both sides match
	-- on (MAC_LOCKED in src/shared.ts) so the phone draws its unlock link.
	if my screenLocked() is "locked" then error "The Mac is locked - relaunching Conductor behind the lock screen is what leaves it wedged, so the relay won't. Unlock the Mac and try again." & my windowEvidence()
	set restartError to my restartConductor()
	if restartError is not "" then error restartError & my windowEvidence()
	-- The fallback returns the moment the relaunch starts, because it is spending a
	-- *send's* budget and a cold launch doesn't fit beside one. This run has nothing
	-- else to do with its budget, so it waits for the window and the phone hears
	-- what actually happened instead of "try again": ~5-10s for a cold launch here.
	if not my waitForWindow(60) then error "Conductor was relaunched but hasn't drawn a window yet. Give it a few seconds, then try again." & my windowEvidence()
	return "ok"
end restartApp

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
	-- The lock ahead of everything else: the lock screen hides the whole session
	-- from Accessibility, so a locked Mac reads "no window" from every probe below
	-- and the ladder spends the patience budget, the Dock click and the evidence
	-- sweeps discovering what one read already knew — measured live (2026-08-14),
	-- the attempt died at the node-side ceiling as "took too long" and the phone
	-- never heard the word "locked". Asking here also stops "activate" from
	-- launching Conductor behind the lock screen, which is where the windowless
	-- launches that wedged it came from. A probe that already shows a window
	-- proves the session is unlocked (AX can't see into a locked one), so the
	-- happy path pays nothing. The error stays retryable on purpose: the caller's
	-- retry loop polls this cheaply until its deadline, so an unlock mid-budget
	-- lands the send by itself — that is the observed recovery, not a theory.
	if (item 1 of firstProbe) < 1 and my screenLocked() is "locked" then
		error "The Mac is locked - the lock screen hides Conductor from the relay, so nothing can be sent or pressed. Unlock the Mac and try again." & my windowEvidence()
	end if
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
		set lockState to my screenLocked()
		-- AX saying "no window" is not the same as there being no window: full
		-- screen on another Space and the lock screen both hide a live window from
		-- AX, and restarting then destroys a window the user left open (measured
		-- live: exactly that loop wedged Conductor for a whole evening). Only the
		-- window server can tell the difference, so a window it CAN see blocks the
		-- restart — this is a human's problem, said in words, not the relay's.
		if my serverWindowCount() > 0 then
			if lockState is "locked" then error "The Mac is locked - Conductor's window is open behind the lock screen, where the relay can't reach it. Unlock the Mac and try again." & ev
			error "Conductor's window exists but is not reachable - it is probably full screen on another Space. Take Conductor out of full screen, then send again." & ev
		end if
		-- No window anywhere and the lock screen up: don't restart. Every relaunch
		-- fired behind the lock screen in the live incident came up windowless, and
		-- the last one came up wedged — answering deep links, hanging every AX
		-- read. A restart here is not a lever, it is how the wreckage happened.
		if lockState is "locked" then error "The Mac is locked and Conductor has no window. Relaunching behind the lock screen is what leaves it wedged, so the relay won't - unlock the Mac and try again." & ev
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
