
on sidebarLinks()
	-- The sidebar rows are AXLinks named "<repo> <title> +adds -dels". They live
	-- two levels under the web area; collect them wherever they are at that depth.
	--
	-- `get` in front of each `whose` clause is load-bearing, and it is the whole
	-- cost of this handler. Without it the clause stays a *reference*, so pulling
	-- the elements out of it one at a time re-runs the filter against the live tree
	-- for each one: measured on a 45-row sidebar, walking the references cost
	-- 10.8s against 0.9s for the same query forced to a list once. That is paid by
	-- every send the deep link doesn't answer and by every status change, which has
	-- no path but this one.
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		set out to {}
		repeat with a in (UI elements of wa)
			try
				set out to out & (get UI elements of a whose role is "AXLink")
				repeat with b in (UI elements of a)
					set out to out & (get UI elements of b whose role is "AXLink")
				end repeat
			end try
		end repeat
		return out
	end tell
end sidebarLinks

on findSidebarRowOnce()
	set titles to my targetSidebarTitles()
	if (count of titles) is 0 then return missing value
	set repoName to system attribute "RELAY_WS_REPO"
	set pair to my sidebarRowsAndNames()
	set refs to item 1 of pair
	set nms to item 2 of pair
	set total to count of refs
	if total is 0 or (count of nms) is not total then return missing value
	repeat with candidate in titles
		set needle to candidate as text
		if needle is not "" then
			set hits to {}
			repeat with i from 1 to total
				set rowName to my textOrEmpty(item i of nms)
				if rowName contains needle then
					if repoName is "" or rowName contains repoName then set end of hits to i
				end if
			end repeat
			if (count of hits) is 1 then
				set idx to item 1 of hits
				set hit to item idx of refs
				-- The references and the names are two reads, so a sidebar that
				-- re-rendered between them (every commit rewrites a row's
				-- "+adds -dels") would have shifted the index under us — and pressing
				-- the neighbour sets the wrong workspace's status, which is the one
				-- failure this whole file is built to refuse. Confirm the element
				-- still carries the name it was picked for.
				if (my axName(hit)) is (my textOrEmpty(item idx of nms)) then return hit
				return missing value
			end if
		end if
	end repeat
	return missing value
end findSidebarRowOnce

on findSidebarRow()
	-- The workspace's own sidebar row. Only rows that are actually rendered exist
	-- in the AX tree (a collapsed section has none — expandSections is what opens
	-- those), and the title follows Conductor's precedence, so we try each
	-- candidate and require a *unique* hit — anything ambiguous returns nothing
	-- rather than guessing at a neighbour. Two passes because the only thing that
	-- fails the check inside is a sidebar that moved mid-read, and that is worth
	-- one cheap retry.
	set hit to my findSidebarRowOnce()
	if hit is not missing value then return hit
	return my findSidebarRowOnce()
end findSidebarRow

on textOrEmpty(v)
	try
		if v is missing value then return ""
		return v as text
	on error
		return ""
	end try
end textOrEmpty

on childRoles(el)
	-- Every child's role in *one* Apple event. Every AX read here is a round trip
	-- to another process, so asking element by element is what turned a sidebar
	-- scan into 15 seconds — more, by itself, than this write's whole budget.
	tell application "System Events" to tell process "Conductor"
		try
			return role of (UI elements of el)
		on error
			return {}
		end try
	end tell
end childRoles

on childRolesAndNames(el)
	tell application "System Events" to tell process "Conductor"
		try
			return {role of (UI elements of el), name of (UI elements of el)}
		on error
			return {{}, {}}
		end try
	end tell
end childRolesAndNames

on looksLikeSidebarList(el)
	-- The sidebar's workspace list is one flat run of section headers
	-- (AXStaticText) and workspace rows (AXLink), with nothing else beside them.
	-- That shape is the whole test, because the *transcript* hangs off the same
	-- web area and holds AXLinks of its own — "the element with links in it"
	-- would happily hand back a message bubble, and every press below would then
	-- land in one.
	set roleList to my childRoles(el)
	if (count of roleList) is 0 then return false
	set seenLink to false
	repeat with r in roleList
		set rt to my textOrEmpty(contents of r)
		if rt is "AXLink" then
			set seenLink to true
		else if rt is not "AXStaticText" then
			return false
		end if
	end repeat
	return seenLink
end looksLikeSidebarList

on sidebarList()
	-- Found by that shape rather than by an index, since the chrome above it
	-- (project pickers, the resource-usage button) comes and goes. Two levels
	-- deep, the same reach sidebarLinks() uses.
	set wa to my webArea()
	repeat with a in (my axKids(wa))
		set nodeA to contents of a
		if my looksLikeSidebarList(nodeA) then return nodeA
		repeat with b in (my axKids(nodeA))
			set nodeB to contents of b
			if my looksLikeSidebarList(nodeB) then return nodeB
		end repeat
	end repeat
	return missing value
end sidebarList

on sidebarRowsAndNames()
	-- Every sidebar row paired with its name. Two Apple events off the list found
	-- above, against one per row before.
	set listEl to my sidebarList()
	if listEl is not missing value then
		tell application "System Events" to tell process "Conductor"
			try
				return {(UI elements of listEl whose role is "AXLink"), name of (UI elements of listEl whose role is "AXLink")}
			end try
		end tell
	end if
	-- No list matched the shape, so Conductor has reorganised its sidebar. Fall
	-- back to the broad two-level sweep and one name read per row: slow, and the
	-- reason the fast path exists, but it assumes nothing about the layout.
	set refs to my sidebarLinks()
	set nms to {}
	repeat with entry in refs
		set end of nms to my axName(contents of entry)
	end repeat
	return {refs, nms}
end sidebarRowsAndNames

on looksNumeric(t)
	-- A folded section draws its row count where its rows would be. That number is
	-- a sibling of the header, not a child of it, so it has to be told apart from a
	-- header by hand — digits only, which no status or repo name is.
	if t is "" then return false
	repeat with c in (characters of t)
		if "0123456789" does not contain (c as text) then return false
	end repeat
	return true
end looksNumeric

on collapsedSectionNames()
	-- The sections someone has folded shut. A section's rows are *siblings* of
	-- its header, so an expanded one is followed by an AXLink and a collapsed one
	-- by its count, by the next header, or by nothing — and a collapsed section
	-- renders no rows at all, which is why its workspaces are invisible to
	-- Accessibility. Names, not element references: everything below re-finds the
	-- header when it needs it, because the list re-renders under us (a status
	-- change moves a row to another group) and a System Events reference is an
	-- index into a tree that has already changed.
	set listEl to my sidebarList()
	if listEl is missing value then return {}
	set pair to my childRolesAndNames(listEl)
	set roleList to item 1 of pair
	set nameList to item 2 of pair
	set total to count of roleList
	if total is 0 or (count of nameList) is not total then return {}
	set out to {}
	repeat with i from 1 to total
		if (my textOrEmpty(item i of roleList)) is "AXStaticText" then
			set nm to my textOrEmpty(item i of nameList)
			if nm is not "" and not (my looksNumeric(nm)) then
				set nextRole to ""
				if i < total then set nextRole to my textOrEmpty(item (i + 1) of roleList)
				if nextRole is not "AXLink" then set end of out to nm
			end if
		end if
	end repeat
	return out
end collapsedSectionNames

on sectionHeaderNamed(wanted)
	-- Unique or nothing, like every other lookup here: two sections cannot share
	-- a name, so an ambiguous hit means we are reading the wrong list.
	set listEl to my sidebarList()
	if listEl is missing value then return missing value
	tell application "System Events" to tell process "Conductor"
		try
			set hits to (UI elements of listEl whose role is "AXStaticText" and name is wanted)
		on error
			return missing value
		end try
	end tell
	if (count of hits) is 1 then return item 1 of hits
	return missing value
end sectionHeaderNamed

on toggleSection(headerName)
	set head to my sectionHeaderNamed(headerName)
	if head is missing value then return false
	tell application "System Events" to tell process "Conductor"
		try
			perform action "AXScrollToVisible" of head
		end try
		try
			perform action "AXPress" of head
			return true
		on error
			return false
		end try
	end tell
end toggleSection

on expandSections()
	-- Open every folded section and report which ones we opened, so the caller can
	-- put the sidebar back the way it found it. The header is the whole control —
	-- it carries AXPress and toggles the group — so this needs no chevron, which
	-- the webview does not expose anyway.
	set opened to {}
	repeat with nm in (my collapsedSectionNames())
		if my toggleSection(nm as text) then set end of opened to (nm as text)
	end repeat
	if (count of opened) > 0 then delay 0.6
	return opened
end expandSections

on restoreSections(names)
	-- Fold back exactly what we opened. Best-effort on purpose: this runs after
	-- the write has already landed, so a header that moved or vanished must not
	-- turn a status change that worked into a reported failure.
	repeat with nm in names
		try
			my toggleSection(nm as text)
		end try
	end repeat
end restoreSections

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
		keystroke (my targetField(2))
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
	-- measured 5-7s, and ~1s since that scan went to bulk reads — still the larger
	-- cost of the two: a phone sends to the same workspace over and over, and
	-- Conductor stays where it was left. Safe as a shortcut because it *is* the
	-- assertion the send makes before typing anyway.
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
	if (my targetField(2)) is "" then return
	if my openViaDeepLink() then return
	if my atTargetWorkspace() then return
	if my focusViaSidebar() then
		if my paneAgrees() then return
	end if
	my focusViaPalette()
end focusWorkspace
