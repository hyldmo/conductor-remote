
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

on pressStatusMenu(rowEl, wanted)
	-- Scroll it into view first. A row that exists in the AX tree but sits outside
	-- the sidebar's visible strip accepts AXShowMenu and draws nothing — which is
	-- exactly what happens right after a status change moves it to another group.
	tell application "System Events" to tell process "Conductor"
		try
			perform action "AXScrollToVisible" of rowEl
		end try
	end tell
	delay 0.4
	-- Clear anything already open (a picker, or a menu a previous run left behind)
	-- so the sweep below can only match the one this right-click draws.
	tell application "System Events" to key code 53
	delay 0.3
	tell application "System Events" to tell process "Conductor"
		perform action "AXShowMenu" of rowEl
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
end pressStatusMenu

on setWorkspaceStatus()
	-- Conductor has no menu-bar or palette command for this, so the only lever is
	-- the sidebar row's own context menu (Mark as unread / Pin / Set status /
	-- Rename / Copy link / Archive). Right-clicking the row needs no focus change,
	-- so unlike a send this never disturbs which workspace is on screen.
	set wanted to system attribute "RELAY_SET_STATUS"
	if wanted is "" then error "no status requested"
	set theRow to my findSidebarRow()
	set opened to {}
	if theRow is missing value then
		-- A folded section renders no rows, so the row may simply not be in the tree
		-- yet. There is no palette command to fall back to, so open the sections
		-- ourselves and look again — then fold them back, since the one thing this
		-- write promises is that the sidebar is where you left it.
		set opened to my expandSections()
		if (count of opened) > 0 then set theRow to my findSidebarRow()
	end if
	if theRow is missing value then
		my restoreSections(opened)
		error "couldn't find this workspace in the sidebar"
	end if
	try
		my pressStatusMenu(theRow, wanted)
	on error errMsg
		my restoreSections(opened)
		error errMsg
	end try
	my restoreSections(opened)
end setWorkspaceStatus
