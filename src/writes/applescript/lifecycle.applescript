
on cancelAgent()
	-- Stop the answer this chat is streaming: Conductor's own "Cancel agent"
	-- command, Command-Shift-Delete (key code 51). Taken from its Keyboard
	-- shortcuts dialog (Command-slash, section "Chat"), not guessed - and it is
	-- the only lever there is. The menu bar carries no stop command and neither
	-- does the palette, and the composer's stop BUTTON is unnamed to
	-- Accessibility: no title, no description, no help, no identifier, telling
	-- itself apart from the send button beside it only by its Tailwind classes.
	-- Which is a distinction worth nothing at the moment it matters, because
	-- while a chat is working with a draft in the composer BOTH buttons are on
	-- screen - stop on the left, send on the right - so "press the last button"
	-- steers the running agent with whatever was half-typed instead of stopping
	-- it. A keystroke can't confuse the two.
	--
	-- The keystroke lands wherever focus is, so this asserts the pane first, the
	-- same check a send makes before typing. Cancelling the wrong agent destroys
	-- work that was running fine, which is the same class of damage as landing a
	-- prompt in the wrong chat and gets the same answer: error out, never guess.
	set strips to my tabGroups()
	if (count of strips) is 0 then error "couldn't find the chat pane to cancel in"
	my assertWorkspace(item 1 of strips)
	-- Command-L ("Focus chat input") first, so the shortcut is delivered inside the
	-- chat view rather than to a terminal panel that had focus, where the terminal
	-- would swallow it. It also parks focus somewhere harmless: the composer keeps
	-- its draft, since Conductor binds this chord to Cancel agent rather than to any
	-- text-deletion the field would otherwise do with it.
	tell application "System Events"
		keystroke "l" using {command down}
		delay 0.2
		key code 51 using {command down, shift down}
	end tell
	delay 0.3
end cancelAgent

on closeChatTab()
	-- Hide the selected chat through Conductor's own Close tab shortcut, Command-W.
	-- The same chord closes a terminal tab when the terminal has focus, so Command-L
	-- first is load-bearing: it moves focus into the chat whose workspace and tab were
	-- asserted immediately above this handler.
	set strips to my tabGroups()
	if (count of strips) is 0 then error "couldn't find the chat pane to close from"
	my assertWorkspace(item 1 of strips)
	tell application "System Events"
		keystroke "l" using {command down}
		delay 0.2
		keystroke "w" using {command down}
	end tell

	-- Conductor asks "Close anyway" when the chat's agent is still running. The
	-- server normally catches that from sessions.status before touching the UI, but
	-- a turn can start in the gap between that read and this keystroke. Detect the
	-- live dialog too, and never infer permission to hide a running conversation.
	set confirmEl to missing value
	set checks to 1
	if (system attribute "RELAY_CLOSE_RUNNING") is "1" then set checks to 4
	repeat with attempt from 1 to checks
		delay 0.25
		set confirmEl to my closeConfirmButton()
		if confirmEl is not missing value then exit repeat
	end repeat
	if confirmEl is missing value then return "closed"
	if (system attribute "RELAY_CLOSE_RUNNING") is not "1" then
		tell application "System Events" to key code 53
		error "the agent started working before the tab closed - closing it now needs confirmation"
	end if
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of confirmEl
	end tell
	delay 0.5
	return "closed"
end closeChatTab

on buttonsUnder(root, maxDepth)
	-- Every AXButton at or below root, level-order and bounded. Depth is the whole
	-- cost here: the transcript hangs off the same web area as anything Conductor
	-- portals into it, so each extra level multiplies the round trips and the sweep
	-- gets slower the longer the chat is. That is why the callers below pass the
	-- shallow depth that fits the thing they are looking for rather than one big cap.
	set acc to {}
	set level to {root}
	set depth to 0
	tell application "System Events" to tell process "Conductor"
		repeat while (count of level) > 0 and depth < maxDepth
			set nextLevel to {}
			repeat with entry in level
				set node to contents of entry
				try
					set acc to acc & (get UI elements of node whose role is "AXButton")
					set nextLevel to nextLevel & (get UI elements of node)
				end try
			end repeat
			set level to nextLevel
			set depth to depth + 1
		end repeat
	end tell
	return acc
end buttonsUnder

on shallowButtonsNamed(root, maxDepth, wanted)
	-- Exact-name buttons at the first depth that contains one. Continue lives in
	-- Conductor's workspace action bar, while a chat transcript hangs much deeper
	-- off the same web area. Stopping at the shallowest hit both avoids walking a
	-- long transcript and keeps a similarly named control inside a message from
	-- impersonating the workspace action.
	set level to {root}
	set depth to 0
	tell application "System Events" to tell process "Conductor"
		repeat while (count of level) > 0 and depth < maxDepth
			set found to {}
			set nextLevel to {}
			repeat with entry in level
				set node to contents of entry
				try
					repeat with candidate in (get UI elements of node whose role is "AXButton")
						set controlEl to contents of candidate
						if (my axName(controlEl)) is wanted then set end of found to controlEl
					end repeat
					set nextLevel to nextLevel & (get UI elements of node)
				end try
			end repeat
			if (count of found) > 0 then return found
			set level to nextLevel
			set depth to depth + 1
		end repeat
	end tell
	return {}
end shallowButtonsNamed

on hasSiblingButtonNamed(controlEl, wanted)
	-- The live merged action is the pair Continue + Archive. Requiring that pair
	-- prevents a generic Continue in a modal from impersonating it while the
	-- asserted workspace pane remains visible behind the modal.
	try
		tell application "System Events" to tell process "Conductor"
			set actionRow to value of attribute "AXParent" of controlEl
			repeat with peer in (get UI elements of actionRow whose role is "AXButton")
				if (my axName(contents of peer)) is wanted then return true
			end repeat
		end tell
	end try
	return false
end hasSiblingButtonNamed

on continueWorkspaceOnNewBranch()
	-- Press Conductor's own merged-workspace action. Its handler owns all of the
	-- state that cannot be reproduced safely from the relay: it checks out a fresh
	-- branch at the PR's target, updates the workspace row, keeps every chat, and
	-- stages Branch continued.md in the selected chat. The relay never writes the
	-- database; server.ts watches `workspaces.branch` for the receipt.
	set strips to my tabGroups()
	if (count of strips) is 0 then error "couldn't find the chat pane to continue from"
	my assertWorkspace(item 1 of strips)
	set found to my shallowButtonsNamed(my webArea(), 10, "Continue")
	if (count of found) is 0 then error "Conductor isn't offering Continue for this workspace - it appears after its pull request is merged and refreshed"
	if (count of found) > 1 then error "more than one Continue button is visible - close any dialog and try again"
	set continueEl to item 1 of found
	if not (my hasSiblingButtonNamed(continueEl, "Archive")) then error "couldn't verify Conductor's merged-workspace Continue action - close any dialog and try again"
	set canPress to true
	try
		tell application "System Events" to tell process "Conductor"
			set canPress to (value of attribute "AXEnabled" of continueEl) as boolean
		end tell
	end try
	if not canPress then error "Conductor's Continue button is still busy - try again shortly"
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of continueEl
	end tell
	delay 0.4
end continueWorkspaceOnNewBranch

on dialogButtons()
	-- Both places Conductor could be drawing a confirmation, each at the depth that
	-- shape actually sits at. A real sheet hangs off the window a level or two down;
	-- an in-webview dialog is a shallow portal near the top of the web area. Its
	-- buttons are inside depth 3; going to 4 reaches the transcript and made an idle
	-- close spend its whole 28-second budget proving that no dialog existed.
	my requireWindow()
	set fromWindow to {}
	tell application "System Events" to tell process "Conductor"
		set fromWindow to my buttonsUnder(window 1, 4)
	end tell
	return fromWindow & (my buttonsUnder(my webArea(), 3))
end dialogButtons

on closeConfirmButton()
	-- The running-chat dialog has exactly Cancel + "Close anyway". Require the
	-- pair so an unrelated destructive dialog can never donate a similarly named
	-- button to this run.
	set found to missing value
	set sawCancel to false
	repeat with entry in my dialogButtons()
		set node to contents of entry
		set label to my axName(node)
		if label is "Cancel" then set sawCancel to true
		if label starts with "Close anyway" then set found to node
	end repeat
	if sawCancel then return found
	return missing value
end closeConfirmButton

on archiveConfirmButton()
	-- Conductor asks before archiving a workspace whose agents are still running:
	-- "Archive workspace?" over Cancel and "Stop agents and archive". Identified by
	-- the *pair* - a button naming the verb, with a Cancel somewhere beside it -
	-- rather than by the archive one alone, which is the same rule waitForMenuWith
	-- follows: press nothing that has not proved which thing it belongs to.
	-- "Unarchive" is excluded by name, since AppleScript's contains ignores case
	-- and would otherwise read that as a confirmation of this.
	set found to missing value
	set sawCancel to false
	repeat with entry in my dialogButtons()
		set node to contents of entry
		set label to my axName(node)
		if label is "Cancel" then set sawCancel to true
		if label contains "archive" and label does not contain "unarchive" then set found to node
	end repeat
	if sawCancel then return found
	return missing value
end archiveConfirmButton

on archiveWorkspace()
	-- Put this workspace away: Conductor's own "Archive workspace", Command-Shift-A.
	-- A keystroke on purpose, like cancelAgent - the sidebar row menu carries an
	-- Archive item, but reaching it costs a sidebar scan plus two menu waits, and
	-- this chord acts on the workspace the pane is already showing.
	--
	-- Which is also the danger: it archives whatever is on screen, so the pane
	-- assertion is the whole guard. Archiving the wrong workspace deletes a worktree
	-- and kills a turn that was running fine, so a pane that cannot be checked is
	-- refused rather than aimed at (writes.ts requires the branch for that reason).
	--
	-- Command-L ("Focus chat input") first, exactly as cancelAgent does: the chord
	-- lands wherever focus is, and a focused terminal panel swallows it.
	set strips to my tabGroups()
	if (count of strips) is 0 then error "couldn't find the chat pane to archive from"
	my assertWorkspace(item 1 of strips)
	tell application "System Events"
		keystroke "l" using {command down}
		delay 0.2
		keystroke "a" using {command down, shift down}
	end tell
	-- A workspace with agents still working draws a confirmation; an idle one is
	-- archived by the chord alone. Both are live, so this waits a bounded moment for
	-- the dialog and treats its absence as the second case - the DB is the receipt
	-- either way (server.ts watches for state 'archived'), so nothing here has to
	-- decide whether the archive landed.
	set confirmEl to missing value
	repeat with attempt from 1 to 5
		delay 0.3
		set confirmEl to my archiveConfirmButton()
		if confirmEl is not missing value then exit repeat
	end repeat
	if confirmEl is missing value then return "archived"
	-- The caller has to have opted into the damage before we press this: stopping
	-- other people's agents is not something to infer from a tap that said Archive.
	if (system attribute "RELAY_ARCHIVE_AGENTS") is not "1" then
		tell application "System Events" to key code 53
		error "agents are still running in this workspace - archiving would stop them"
	end if
	tell application "System Events" to tell process "Conductor"
		perform action "AXPress" of confirmEl
	end tell
	delay 0.5
	return "archived"
end archiveWorkspace
