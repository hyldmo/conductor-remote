
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
	-- identified by that label rather than a stable name. Claude calls its top
	-- level Ultracode while Codex calls the corresponding level Ultra. Codex's
	-- None state is the exception: its button has no accessible name at all, so
	-- accept one (and only one) unnamed button *after* the proven model picker.
	-- The main composer also contains unnamed attachment/stop buttons before that
	-- picker, and pressing one of those would be worse than failing.
	set levels to {"Light", "Low", "Medium", "High", "Extra high", "Max", "Ultracode", "Ultra"}
	set sawModel to false
	set unnamed to {}
	repeat with entry in my composerControls()
		set c to contents of entry
		if (my axRole(c)) is "AXPopUpButton" and (my axName(c)) contains "Change agent" then
			set sawModel to true
		else if sawModel and (my axRole(c)) is "AXButton" then
			set label to my axName(c)
			if label is in levels then return c
			if label is "" then set end of unnamed to c
		end if
	end repeat
	if (count of unnamed) is 1 then return item 1 of unnamed
	return missing value
end effortButton

on setEffort(wanted)
	-- Claude owns a six-value ring ending in Ultracode; Codex adds None and ends
	-- in Ultra. Step around either ring once and confirm the label landed.
	set btn to my effortButton()
	if btn is missing value then error "couldn't find the effort control"
	repeat 8 times
		set currentLabel to my axName(btn)
		if currentLabel is wanted or (wanted is "__UNNAMED_EFFORT__" and currentLabel is "") then return
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

on pickerShowsModel(popup, wanted)
	set pickerLabel to my tabLabel(popup)
	if pickerLabel contains ("(" & wanted & ")") then return true
	-- The menu can label a newly released model "Opus 5 NEW", while the
	-- composer deliberately drops that temporary badge and says "Opus 5".
	-- Treat that exact display form as the same choice; the surrounding
	-- parentheses keep "Opus 5" distinct from a longer model name.
	if wanted ends with " NEW" then
		set baseName to text 1 thru -5 of wanted
		if pickerLabel contains ("(" & baseName & ")") then return true
	end if
	return false
end pickerShowsModel

on modelMenuItem(wanted)
	-- Resolve one model from the picker that is already open. The menu can append
	-- `NEW` to a freshly released model while the relay deliberately exposes the
	-- stable name without it, so the same unique-prefix rule as setModel applies.
	set chosen to missing value
	set loose to {}
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		repeat with m in (get UI elements of wa whose role is "AXMenu")
			repeat with mi in (get UI elements of m whose role is "AXMenuItem")
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
		if (count of loose) > 1 then error "several models match " & wanted
		error "no model named " & wanted
	end if
	return chosen
end modelMenuItem

on modelDefaultButton(menuItem)
	-- Every non-default row has a child star button named "Set <model> as
	-- default and select". The starred row has no button at all. Read the role and
	-- label together so an unrelated control a future picker grows cannot be
	-- mistaken for a global preference write.
	repeat with childNode in my axKids(menuItem)
		set childEl to contents of childNode
		if (my axRole(childEl)) is "AXButton" and (my axName(childEl)) contains " as default" then return childEl
	end repeat
	return missing value
end modelDefaultButton

on modelMenuItems()
	set found to {}
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		repeat with m in (get UI elements of wa whose role is "AXMenu")
			set found to found & (get UI elements of m whose role is "AXMenuItem")
		end repeat
	end tell
	return found
end modelMenuItems

on defaultModelInOpenPicker()
	-- The selected star is exposed by *removing* the star button from that row.
	-- Require exactly one such row. If managed settings disable every star, or a
	-- Conductor release changes this tree, failing closed is safer than reporting
	-- that whichever model was requested became the user's global default.
	set defaults to {}
	repeat with mi in my modelMenuItems()
		set menuItem to contents of mi
		if (my modelDefaultButton(menuItem)) is missing value then set end of defaults to my firstLine(my tabLabel(menuItem))
	end repeat
	if (count of defaults) is not 1 then error "couldn't identify Conductor's default model"
	return item 1 of defaults
end defaultModelInOpenPicker

on modelPickerButton()
	set popup to missing value
	repeat with entry in my composerControls()
		set c to contents of entry
		if my tabLabel(c) contains "Change agent" then set popup to c
	end repeat
	if popup is missing value then error "couldn't find the model picker"
	return popup
end modelPickerButton

on openModelPicker()
	set popup to my modelPickerButton()
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of popup
	end tell
	delay 1.0
end openModelPicker

on setDefaultModel(wanted)
	-- Conductor's star is one combined action: its accessible name is "Set … as
	-- default and select". Mirror that rather than pretending this only changes a
	-- preference — the target chat switches model too, and the picker label is
	-- read back below as the receipt for that half.
	set initialPopup to my modelPickerButton()
	set alreadySelected to my pickerShowsModel(initialPopup, wanted)
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of initialPopup
	end tell
	delay 1.0
	try
		set chosen to my modelMenuItem(wanted)
		set chosenLabel to my firstLine(my tabLabel(chosen))
		set currentDefault to my defaultModelInOpenPicker()
		if currentDefault is chosenLabel then
			if alreadySelected then
				tell application "System Events" to key code 53
				return chosenLabel
			end if
			-- The star is already selected, but this chat is not. Its row is now
			-- the remaining half of Conductor's combined action.
			tell application "System Events" to tell process "Conductor"
				perform action "AXPress" of chosen
			end tell
			delay 0.8
			set selectedPopup to my modelPickerButton()
			if not my pickerShowsModel(selectedPopup, chosenLabel) then error "the model didn't switch to " & chosenLabel
			return chosenLabel
		end if
		set starButton to my modelDefaultButton(chosen)
		if starButton is missing value then error "the default-model star is missing for " & chosenLabel
		tell application "System Events" to tell process "Conductor"
			perform action "AXPress" of starButton
		end tell
		delay 0.8
		set selectedPopup to my modelPickerButton()
		if not my pickerShowsModel(selectedPopup, chosenLabel) then error "the model didn't switch to " & chosenLabel
		-- Re-open and read the star back. Pressing is fire-and-forget; the only safe
		-- success is the requested row becoming the unique one with no star button.
		my openModelPicker()
		set verified to my modelMenuItem(wanted)
		set verifiedLabel to my firstLine(my tabLabel(verified))
		set currentDefault to my defaultModelInOpenPicker()
		tell application "System Events" to key code 53
		if currentDefault is not verifiedLabel then error "Conductor didn't mark " & verifiedLabel & " as the default model"
		return verifiedLabel
	on error errText number errNum
		tell application "System Events" to key code 53
		error errText number errNum
	end try
end setDefaultModel

on setModel(wanted)
	set popup to missing value
	repeat with entry in my composerControls()
		set c to contents of entry
		if my tabLabel(c) contains "Change agent" then set popup to c
	end repeat
	if popup is missing value then error "couldn't find the model picker"
	if my pickerShowsModel(popup, wanted) then return
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of popup
	end tell
	delay 1.0
	-- The relay removes a temporary `NEW` badge before it sends this label back,
	-- so a prefix match resolves that menu item. It is accepted only when unique:
	-- "Sonnet 4.6" would
	-- otherwise also match "Sonnet 4.6 1M"), which must fail rather than guess.
	set chosen to missing value
	set loose to {}
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		repeat with m in (get UI elements of wa whose role is "AXMenu")
			repeat with mi in (get UI elements of m whose role is "AXMenuItem")
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
	set chosenLabel to my firstLine(my tabLabel(chosen))
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
	if not my pickerShowsModel(popup, chosenLabel) then error "the model didn't switch to " & chosenLabel
end setModel

on listModels()
	-- Enumerate the picker rather than hard-coding a model list that would rot on
	-- every Conductor release. The first tagged line carries the unique starred
	-- row, followed by the ordinary labels. Opens the menu, reads, closes it again.
	my openModelPicker()
	try
		set labels to {}
		repeat with mi in my modelMenuItems()
			set end of labels to my firstLine(my tabLabel(mi))
		end repeat
		set defaultLabel to my defaultModelInOpenPicker()
		tell application "System Events" to key code 53
		set saved to AppleScript's text item delimiters
		set AppleScript's text item delimiters to linefeed
		set joined to labels as text
		set AppleScript's text item delimiters to saved
		return "__CONDUCTOR_DEFAULT_MODEL__" & tab & defaultLabel & linefeed & joined
	on error errText number errNum
		tell application "System Events" to key code 53
		error errText number errNum
	end try
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
