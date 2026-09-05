
(* -- Instant Hotspot ----------------------------------------------------------
   The funnel watchdog's last resort when this Mac has no route: press the row
   for a personal hotspot in Control Center's Wi-Fi popover. networksetup can
   only join a network that is broadcasting, and a personal hotspot usually
   is not - the row in the Wi-Fi menu is fed by Continuity over Bluetooth, and
   pressing it asks the phone to wake its hotspot, exactly like a human
   clicking the Wi-Fi menu. Everything here targets process "ControlCenter",
   not Conductor - same Accessibility grant, different process, which is why
   the refusal mapping below skips refusalReason's -1712 branch (its words are
   about a wedged Conductor).
   Addressed by AXIdentifier throughout ("com.apple.menuextra.wifi",
   "wifi-network-<name>", "wifi-header") - the items' names are missing value
   and any visible text is localized, the identifiers are neither (measured
   live on macOS 26.5, 2026-08). A "whose value of attribute ..." filter fails
   wholesale (-1728) when any element lacks the attribute - several menu bar
   items do - so every lookup here walks with a per-item try instead.
   The SE-terms trap at the top of CLAUDE.md's applescript section bit this
   code through a HANDLER PARAMETER: findAxId's first argument was once named
   `container`, a System Events dictionary word, so inside the tell it
   resolved as the term and the walk found nothing - through an error-eating
   try, so a provably open popover read as "no popover" for a whole debugging
   session while every direct read worked. osacompile accepts it, the handler
   check can't see it. Keep every identifier in these handlers boring and
   un-dictionary-like.
   The menu bar item is a TOGGLE: the same press opens and closes the
   popover, so nothing here presses it without first checking which state the
   popover is in (wifiPopoverWindow), and an already-open popover aborts the
   run - a human may be mid-gesture in it, and their next click kills an
   automated run anyway (contention looks exactly like the status-row menu's:
   fails while someone uses the Mac, clean when it is unattended). *)

on wifiMenuBarItem()
	try
		with timeout of 6 seconds
			tell application "System Events" to tell process "ControlCenter"
				repeat with mi in menu bar items of menu bar 1
					try
						if (value of attribute "AXIdentifier" of mi) is "com.apple.menuextra.wifi" then return contents of mi
					end try
				end repeat
			end tell
		end timeout
	on error errText number errNum
		if errNum is not -1712 then
			set refusal to my refusalReason({-1, errNum, errText})
			if refusal is not "" then error refusal
		end if
		error "reading the menu bar failed (" & errNum & "): " & errText
	end try
	error "the Wi-Fi control is not in the menu bar - turn on Show in Menu Bar for Wi-Fi in System Settings > Control Center"
end wifiMenuBarItem

on findAxId(parentEl, wantedId, depth)
	-- Depth-capped even though the popover is small: the cap is what keeps a
	-- macOS reshuffle of this tree from turning one lookup into a full crawl.
	-- `parentEl` is deliberately not `container` - see the section comment.
	tell application "System Events"
		try
			set kids to UI elements of parentEl
		on error
			return missing value
		end try
	end tell
	repeat with el in kids
		try
			tell application "System Events"
				if (value of attribute "AXIdentifier" of el) is wantedId then return contents of el
			end tell
		end try
		if depth > 1 then
			set hit to my findAxId(el, wantedId, depth - 1)
			if hit is not missing value then return hit
		end if
	end repeat
	return missing value
end findAxId

on wifiPopoverWindow()
	-- The popover is whichever ControlCenter window carries the "wifi-header"
	-- id. Existence is read fresh on every call: pressing a network row can
	-- close the popover by itself, and the menu bar item is a toggle, so a
	-- blind second press would reopen what just closed.
	tell application "System Events" to tell process "ControlCenter"
		try
			set wins to windows
		on error
			return missing value
		end try
	end tell
	repeat with w in wins
		if my findAxId(w, "wifi-header", 3) is not missing value then return contents of w
	end repeat
	return missing value
end wifiPopoverWindow

on closeWifiPopover(wifiItem)
	if my wifiPopoverWindow() is not missing value then
		try
			tell application "System Events" to perform action "AXPress" of wifiItem
		end try
	end if
end closeWifiPopover

on joinInstantHotspot()
	-- The name arrives via a file, like RELAY_PROMPT_FILE: do shell script
	-- output is decoded as UTF-8, so a name with non-ASCII letters survives
	-- where a system attribute read may not. AppleScript's default nonliteral
	-- text comparison then treats composed and decomposed accents as equal,
	-- which matters because the AX identifier uses whatever normalization
	-- macOS chose.
	set hotspotName to do shell script "cat " & quoted form of (system attribute "RELAY_HOTSPOT_FILE")
	if hotspotName is "" then error "no hotspot name provided"
	-- The lock screen hides the session from Accessibility, so behind it this
	-- press has nothing to land on. Named up front, in the same words the send
	-- path uses, instead of surfacing later as a popover that never opened.
	if my screenLocked() is "locked" then error "The Mac is locked - the Wi-Fi menu can't be pressed until it unlocks"
	set wifiItem to my wifiMenuBarItem()
	if my wifiPopoverWindow() is not missing value then error "the Wi-Fi popover is already open - someone may be using it, so nothing was pressed"
	tell application "System Events" to perform action "AXPress" of wifiItem
	-- The popover renders in its own time (measured 1-2s), and a human's click
	-- anywhere on the Mac closes it, so poll rather than sleep once.
	set pop to missing value
	repeat 8 times
		delay 0.5
		set pop to my wifiPopoverWindow()
		if pop is not missing value then exit repeat
	end repeat
	if pop is missing value then error "pressing the Wi-Fi control opened no popover - someone clicking on the Mac closes it the moment it opens (contention, not a fault); otherwise Control Center is not answering"
	set rowEl to missing value
	repeat 4 times
		set rowEl to my findAxId(pop, "wifi-network-" & hotspotName, 6)
		if rowEl is not missing value then exit repeat
		delay 0.5
	end repeat
	if rowEl is missing value then
		my closeWifiPopover(wifiItem)
		error quote & hotspotName & quote & " is not in the Wi-Fi menu - the iPhone is out of Bluetooth range, has Bluetooth off, or Personal Hotspot is off in its Settings"
	end if
	-- The row is a toggle too: value 1 means already connected, and pressing
	-- it then would DISCONNECT - the one outcome worse than doing nothing.
	-- Only a read of exactly 1 skips the press; an unreadable value presses.
	set rowValue to 0
	try
		tell application "System Events" to set rowValue to value of rowEl
	end try
	if rowValue is 1 then
		my closeWifiPopover(wifiItem)
		return "already-connected"
	end if
	tell application "System Events" to perform action "AXPress" of rowEl
	delay 1
	my closeWifiPopover(wifiItem)
	return "pressed"
end joinInstantHotspot
