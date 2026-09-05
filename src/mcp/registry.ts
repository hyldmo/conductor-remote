/**
 * The MCP tools, and the JSON-RPC dispatcher that serves them.
 *
 * Shared by both transports, which is the only reason they can't drift: `src/mcp.ts`
 * runs this over stdio as a separate process, and `src/http/router.ts` mounts the same
 * dispatcher at `POST /mcp` for clients that can only reach a URL.
 *
 * The tool set tracks `/api`, minus the routes that only exist to back a button on the
 * phone. An agent needs no `merge` (it holds `gh`, and `send_prompt` can ask the agent
 * that owns the branch), no push subscription, and no settings editor. What it does need
 * is everything it cannot reach any other way: the model/effort/plan/fast controls, which
 * live in Conductor's UI and nowhere else, the prompts the relay is holding on its behalf,
 * the sleep window that keeps this Mac reachable at all, and the relay's own log.
 *
 * Every tool is an HTTP call to the relay, injected as `call`, and that is the
 * load-bearing decision rather than a convenience. Conductor has one shared window,
 * so the only thing that makes writes safe is `src/writes/ui-lock.ts` ▸ `uiTurn`, backed by the
 * coordinator's relay-shared mutex. A tool that drove AppleScript itself would sit
 * outside it, and two agents focusing different workspaces would land each other's
 * prompts — the exact failure every fail-closed assertion cannot catch. Routed through
 * the relay, the phone, delivery queues and every agent share the same gate.
 *
 * The in-relay transport calls the relay's own API over loopback rather than reaching
 * into `reads`/`writes` directly. That is a sub-millisecond hop that keeps
 * one HTTP code path for the phone and tools:
 * a tool cannot behave differently over HTTP than it does over stdio.
 */

import { createListModelsTool, createSetAgentOptionsTool, createSetDefaultModelTool } from './tools/agent-options.ts'
import {
	createCloseChatTool,
	createSendPromptTool,
	createSplitChatTool,
	createStopTurnTool
} from './tools/chat-actions.ts'
import { createListChatsTool, createReadChatTool, createSearchChatsTool } from './tools/chats.ts'
import { createDelegateTaskTool, createListDelegationsTool, createListRolesTool } from './tools/delegation.ts'
import {
	createDismissPromptTool,
	createKeepAwakeTool,
	createPlanUsageTool,
	createRelayLogsTool
} from './tools/system.ts'
import { createListVoiceCallsTool, createReadVoiceCallTool, createSearchVoiceCallsTool } from './tools/voice.ts'
import {
	createArchiveWorkspaceTool,
	createCreateWorkspaceTool,
	createDevServerTool,
	createListReposTool,
	createListWorkspacesTool,
	createSetWorkspaceStatusTool,
	createWorkspaceDiffTool
} from './tools/workspaces.ts'
import type { RelayCall, Tool } from './types.ts'

/** Build the tool set against a given relay transport. */
export function createTools(call: RelayCall): Tool[] {
	return [
		createSearchChatsTool(call),
		createReadChatTool(call),
		createListVoiceCallsTool(call),
		createSearchVoiceCallsTool(call),
		createReadVoiceCallTool(call),
		createListWorkspacesTool(call),
		createListChatsTool(call),
		createListRolesTool(call),
		createDelegateTaskTool(call),
		createListDelegationsTool(call),
		createWorkspaceDiffTool(call),
		createListReposTool(call),
		createPlanUsageTool(call),
		createCreateWorkspaceTool(call),
		createSendPromptTool(call),
		createSplitChatTool(call),
		createStopTurnTool(call),
		createCloseChatTool(call),
		createListModelsTool(call),
		createSetDefaultModelTool(call),
		createSetAgentOptionsTool(call),
		createSetWorkspaceStatusTool(call),
		createDevServerTool(call),
		createArchiveWorkspaceTool(call),
		createDismissPromptTool(call),
		createKeepAwakeTool(call),
		createRelayLogsTool(call)
	]
}
