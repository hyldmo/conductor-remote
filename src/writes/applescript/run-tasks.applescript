
-- The workspace toolbar's run process. This is deliberately separate from the
-- chat-strip targeting above: the terminal strip is the sibling AXTabGroup whose
-- direct radio buttons include Setup / Run / Terminal, and its task button is
-- named "Run <task>" or "Stop <task>". Conductor may add more terminal tabs, so
-- identify the strip by the Run radio rather than by its position.
on runStrip()
	set matches to {}
	repeat with entry in my tabGroups()
		set tg to contents of entry
		set hasRunTab to false
		repeat with r in my stripRadios(tg)
			if (my axName(contents of r)) is "Run" then set hasRunTab to true
		end repeat
		if hasRunTab then set end of matches to tg
	end repeat
	if (count of matches) is 0 then error "couldn't find Conductor's Run panel"
	if (count of matches) > 1 then error "can't tell which panel holds Conductor's Run task"
	return item 1 of matches
end runStrip

on runTaskButton(tg)
	set matches to {}
	tell application "System Events" to tell process "Conductor"
		repeat with entry in (get UI elements of tg whose role is "AXButton")
			set node to contents of entry
			set label to my axName(node)
			if label starts with "Run " or label starts with "Stop " then set end of matches to node
		end repeat
	end tell
	if (count of matches) is 0 then error "this workspace has no selected Run task"
	if (count of matches) > 1 then error "Conductor exposed more than one selected Run task"
	return item 1 of matches
end runTaskButton

on runTaskChooser(tg)
	set found to {}
	tell application "System Events" to tell process "Conductor"
		repeat with entry in (get UI elements of tg whose role is "AXPopUpButton")
			set node to contents of entry
			if (my axName(node)) is "Select task" then set end of found to node
		end repeat
	end tell
	if (count of found) is 0 then return missing value
	if (count of found) > 1 then error "Conductor exposed more than one Run task chooser"
	return item 1 of found
end runTaskChooser

on openRunTaskMenu(tg)
	-- Multiple Run configs live behind a Radix pop-up. AXPress is advertised but
	-- does nothing on this control; focusing it and pressing Space opens the real
	-- AXMenu. Choosing an item starts the task immediately — there is no second
	-- press on the primary Run button. "Configure" is Conductor's own trailing
	-- command, not a task choice.
	set chooser to my runTaskChooser(tg)
	if chooser is missing value then error "this workspace has no Run config chooser"
	tell application "System Events" to tell process "Conductor"
		set value of attribute "AXFocused" of chooser to true
	end tell
	tell application "System Events" to key code 49
	delay 0.4
	set choices to {}
	set wa to my webArea()
	tell application "System Events" to tell process "Conductor"
		repeat with m in (get UI elements of wa whose role is "AXMenu")
			repeat with entry in (get UI elements of m whose role is "AXMenuItem")
				set node to contents of entry
				set label to my axName(node)
				if label is not "" and label is not "Configure" then set end of choices to node
			end repeat
		end repeat
	end tell
	return choices
end openRunTaskMenu

on startRunTaskNamed(tg, wantedTask)
	try
		set matches to {}
		repeat with entry in my openRunTaskMenu(tg)
			set node to contents of entry
			if (my axName(node)) is wantedTask then set end of matches to node
		end repeat
		if (count of matches) is 0 then error "no Run config named " & wantedTask
		if (count of matches) > 1 then error "several Run configs match " & wantedTask
		tell application "System Events" to tell process "Conductor"
			perform action "AXPress" of item 1 of matches
		end tell
	on error errText number errNum
		tell application "System Events" to key code 53
		error errText number errNum
	end try
end startRunTaskNamed

on startSoleRunTask(tg)
	try
		set choices to my openRunTaskMenu(tg)
		if (count of choices) is 0 then error "Conductor's Run menu contains no tasks"
		if (count of choices) > 1 then error "choose which Run config to start"
		tell application "System Events" to tell process "Conductor"
			perform action "AXPress" of item 1 of choices
		end tell
	on error errText number errNum
		tell application "System Events" to key code 53
		error errText number errNum
	end try
end startSoleRunTask

on runTaskState(btn)
	set label to my axName(btn)
	if label starts with "Stop " then return "running"
	if label starts with "Run " then return "stopped"
	error "couldn't read Conductor's Run task state"
end runTaskState

on runTaskName(btn)
	set label to my axName(btn)
	if label starts with "Stop " then return text 6 thru -1 of label
	if label starts with "Run " then return text 5 thru -1 of label
	return label
end runTaskName

on linkDestination(controlEl)
	tell application "System Events" to tell process "Conductor"
		try
			return value of attribute "AXURL" of controlEl as text
		on error
			return ""
		end try
	end tell
end linkDestination

on openRunTargets(tg)
	set foundPorts to {}
	set foundLinks to {}
	tell application "System Events" to tell process "Conductor"
		set controls to UI elements of tg
	end tell
	repeat with entry in controls
		set node to contents of entry
		tell application "System Events" to tell process "Conductor"
			set nodeRole to role of node
		end tell
		if nodeRole is "AXButton" or nodeRole is "AXLink" then
			set label to my axName(node)
			if label starts with "Open" then
				set destination to my linkDestination(node)
				if destination starts with "http://" or destination starts with "https://" then set end of foundLinks to destination
				if label starts with "Open :" then set end of foundPorts to text 7 thru -1 of label
			end if
		end if
	end repeat
	return {foundPorts, foundLinks}
end openRunTargets

on setRunTask(wantRunning, wantedTask)
	my activateConductor()
	my focusWorkspace()
	set tg to my runStrip()
	my assertWorkspace(tg)
	set btn to my runTaskButton(tg)
	set beforeState to my runTaskState(btn)
	set taskName to my runTaskName(btn)
	set wantedState to "stopped"
	if wantRunning then set wantedState to "running"
	set changed to "false"
	if wantRunning and wantedTask is not "" and beforeState is "running" and taskName is not wantedTask then error taskName & " is already running; stop it before starting " & wantedTask

	if beforeState is not wantedState then
		if wantRunning and wantedTask is not "" then
			my startRunTaskNamed(tg, wantedTask)
		else if wantRunning and (my runTaskChooser(tg)) is not missing value then
			-- Legacy settings carry no name to the relay. Preserve their one-tap
			-- behavior only when the live menu independently confirms one choice.
			my startSoleRunTask(tg)
		else
			tell application "System Events" to tell process "Conductor"
				perform action "AXPress" of btn
			end tell
		end if
		set changed to "true"
	end if

	-- The panel re-renders after the press, invalidating every old AX handle.
	-- Re-find it on each poll and require the opposite label before reporting the
	-- action as complete. A started web server gets a short second window in which
	-- Conductor can surface its Open control. New controls may expose their exact
	-- AXURL; current builds expose only "Open :<port>". Non-server tasks return
	-- with both lists empty.
	set currentState to beforeState
	set ports to {}
	set previewURLs to {}
	repeat with attempt from 1 to 44
		set tg to my runStrip()
		set btn to my runTaskButton(tg)
		set currentState to my runTaskState(btn)
		set taskName to my runTaskName(btn)
		if currentState is wantedState then
			if wantRunning and wantedTask is not "" and taskName is not wantedTask then error "Conductor started " & taskName & " instead of " & wantedTask
			set runTargets to my openRunTargets(tg)
			set ports to item 1 of runTargets
			set previewURLs to item 2 of runTargets
			if not wantRunning or (count of ports) > 0 or (count of previewURLs) > 0 or attempt > 20 then exit repeat
		end if
		delay 0.25
	end repeat
	if currentState is not wantedState then error "Conductor's Run task did not switch to " & wantedState
	return currentState & tab & taskName & tab & changed & tab & my joinList(ports, ",") & tab & my joinList(previewURLs, ASCII character 30)
end setRunTask
