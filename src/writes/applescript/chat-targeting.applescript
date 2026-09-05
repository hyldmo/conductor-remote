
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
					set found to found & (get UI elements of node whose role is "AXTabGroup")
					set nextLevel to nextLevel & (get UI elements of node)
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
					set acc to acc & (get UI elements of node whose role is "AXRadioButton")
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
