
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

on composerField()
	-- The composer's AXTextArea: an AXGroup named "composer" in the chat pane, one
	-- text area inside it. Resolved once and handed to both the fill and the send
	-- confirm below, because reaching it means walking the pane from the tab strip
	-- and that walk measured ~0.5s on a live window. Returns missing value when the
	-- composer isn't there at all, which is the caller's cue to fall back to pasting.
	set strips to my tabGroups()
	if (count of strips) is 0 then return missing value
	try
		tell application "System Events" to tell process "Conductor"
			set pane to value of attribute "AXParent" of (item 1 of strips)
			set composerBox to item 1 of (UI elements of pane whose name is "composer")
			return item 1 of (UI elements of composerBox whose role is "AXTextArea")
		end tell
	end try
	return missing value
end composerField

on composerTextOf(textBox)
	-- What the box holds now, or missing value when it cannot be read at all. A pane
	-- that re-rendered leaves the old reference pointing at a dead element, and
	-- "can't read it" must never be reported as "still holding the prompt": that is
	-- the one state that presses Enter again, and it would do so at the moment the
	-- box may already be empty.
	try
		tell application "System Events" to tell process "Conductor"
			return (value of textBox) as text
		end tell
	end try
	return missing value
end composerTextOf

on fillComposer(textBox, promptText)
	-- Write the prompt straight into the composer's AXTextArea instead of
	-- stashing the clipboard, pressing Cmd+L and pasting. AXFocused and AXValue
	-- are both settable, so this needs no keystrokes and no clipboard hijack.
	-- Returns false (→ caller falls back to pasting) if anything looks off, but
	-- *clears whatever it wrote first*: leaving half a prompt behind would make
	-- the fallback paste append to it and send a garbled prompt.
	if promptText is "" then return false
	if textBox is missing value then return false
	try
		tell application "System Events" to tell process "Conductor"
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
			my clearComposer(textBox)
		end try
		return false
	end try
	return true
end fillComposer

on clearComposer(textBox)
	if textBox is missing value then return
	tell application "System Events" to tell process "Conductor"
		set value of textBox to ""
	end tell
end clearComposer

on pressSend(queueIt)
	-- Return sends, Command-Return queues the prompt behind the running answer.
	-- The choice is made out here because inside a System Events tell an ordinary
	-- parameter name can resolve as one of its own terms.
	if queueIt then
		tell application "System Events" to key code 36 using {command down}
	else
		tell application "System Events" to key code 36
	end if
end pressSend

on submitComposer(textBox, promptText, queueIt)
	-- Press Enter, then read the composer back. Conductor consumes the draft when it
	-- accepts a prompt, so a box still holding the text is a keystroke that did
	-- nothing — and that read is the only receipt a run can collect about its own
	-- send.
	--
	-- Why it earns its place: the caller's other receipt is the transcript row, which
	-- costs a 6s watch (CONFIRM_WINDOW_MS in server.ts) and then a whole second run
	-- through activate, focus, tab and fill. Measured from this Mac's own relay logs,
	-- a send whose single fault was a first Enter Conductor ignored took ~10s from the
	-- prompt appearing in the composer to it being sent, with the text sitting on
	-- screen the whole way. Exactly one user row was written, so the keystroke was
	-- lost rather than delayed.
	--
	-- Pressing again is safe *because* of the read, not in spite of it: the prompt is
	-- still in the box, so nothing was consumed, so there is nothing to duplicate.
	-- The one state that would break that is a Conductor which queues on Command-Return
	-- and *keeps* the draft, since the box would then read as unsent after a send that
	-- worked. Unverified against the live app, and the only path that could reach it is
	-- Command-Return in the phone's composer (Composer.tsx, a hardware keyboard); a tap
	-- always sends. Worth checking before anything else starts queueing.
	-- A Conductor too busy to have handled the first Enter is also too busy to answer
	-- an AX read, which blocks here rather than handing back stale text.
	--
	-- **Two presses, not three, and the second one is on probation.** The first
	-- occurrence in the wild (2026-09-01 16:59:57) had the box survive all three, and
	-- no send has ever been recorded as rescued by a later press — so the value here
	-- is the *detection*, which lets the caller stop watching for a row that cannot
	-- come (`sendNeverStarted` in writes.ts) rather than spending the 6s window on it.
	-- Every press past the first that doesn't work is pure delay added to a send that
	-- is already failing, which is why the budget shrank from 3×1.2s to 2×0.8s.
	--
	-- Returns the press that cleared the box, or 0 for a box that never cleared. The
	-- count is the point: a rescued send is otherwise indistinguishable from one that
	-- worked first time, so the failure this handler exists for would stop appearing
	-- in the log the day it stopped costing 10s, and nobody could tell whether it was
	-- fixed or merely hidden.
	if promptText is "" then
		my pressSend(queueIt)
		return 1
	end if
	repeat with pressCount from 1 to 2
		my pressSend(queueIt)
		if textBox is missing value then return pressCount
		repeat with tick from 1 to 4
			delay 0.2
			set seen to my composerTextOf(textBox)
			if seen is missing value then return pressCount
			if seen does not contain promptText then return pressCount
		end repeat
	end repeat
	return 0
end submitComposer

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
	set wantTitle to my targetField(1)
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
