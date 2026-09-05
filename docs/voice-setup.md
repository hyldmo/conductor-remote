# Voice setup

## PWA fleet call over WebRTC

The workspace-list phone opens a fleet-wide control room. In the
workspace-list header, tap the phone immediately left of **+**, then start the
call. Each new call opens with a neutral greeting and waits for your topic.
Ask for a workspace overview, one decision at a time, or a recap of a previous
call. It can also create new workspaces and queue exact prompts. Both writes happen
only after it reads the target and text back and you confirm. It is not owned by
the chat currently on screen: hide the sheet or move between workspaces and the
same call continues.

To call the current chat, tap the phone on the right side of the chat composer,
immediately left of the context control, then **Start workspace call**.
**Call this workspace** for the active chat is also available in the command menu.
The call starts with that chat's recent
conversation already loaded, so you can discuss the task or ask for an update.
The sheet names both the workspace and chat. Browsing another tab keeps the call
on its original conversation; end it before starting a call for another chat.

Both call modes open with a brief acknowledgement and wait for you. Ask for a
recap, fleet overview, or the next decision when you need one. Interrupting the
greeting moves to what you said. Read results are explained in natural language;
action previews still read back the exact target and text before confirmation.

The relay reads up to 24 recent user and assistant messages, capped at 16,000
characters, keeping the latest user request even after a long run. Queued prompts,
reasoning, tool output, and native child-agent messages are excluded. These messages
are sent to OpenAI with the call; an update request reads the chat again. Sending a
prompt back still requires spoken confirmation.

Live captions keep both sides readable, and the text box in the call sheet is a
fallback when speaking is inconvenient. The available actions are roll
call, fresh workspace overview, chat context, next decision, call-history list,
search and read, repository list, workspace-create
preview and confirmed creation, plus send preview and confirmed send. The two
writes use the same persisted, one-use preview/confirmation gate as the dial-in
orchestrator.

A requested roll call, its counts, the decision queue, and ordinary overviews
exclude workspaces marked **Done** or whose pull request is merged. The queue
also skips work completed during a call. Ask for an overview including completed
work when it is relevant. Overview requests can also filter by repository,
live agent status, workspace status, PR
status, and an `updated_since`/`updated_before` time window; each spoken row says
how recently its selected chat changed.

Overviews distinguish workspaces from chats: one workspace can have several
running chats and several waiting for input. Every waiting sibling is reachable
when you ask to continue through the questions, independently of the newest
activity pages. **Needs input** means an explicit live input or plan request;
an idle reply that asks a question is a **possible follow-up**, not a confirmed
blocker. Unread updates alone do not count as input requests.

When Compact continues a conversation in a new chat, the overview suppresses its
older context only after a successor turn has been dispatched. An unsent handoff
keeps the predecessor visible. Independent siblings, running predecessors, and
predecessors messaged after the successor was created remain visible. These
replacement rules apply before status and date filters, so filtering for waiting
work cannot bring an obsolete question back. Cached decisions also skip chats
that were replaced, resumed, closed, or updated since the roll call.

Past calls are available only when you ask. After reconnecting, ask **“What did
we just talk about?”** to read the preceding call, or **“What did we talk about
yesterday?”** to look up calls by date. You can also search a remembered topic.
The live call is excluded from history lookups, and yesterday uses the Mac's
calendar. A saved confirmation is part of that old conversation; a new action
still needs confirmation in the current call.

The text archive lives in
`~/Library/Application Support/conductor-remote/voice-history.db`, a separate
SQLite database from Conductor's coding chats. It stores spoken and typed text,
timestamps, and markers for partial or interrupted replies; it does not store
audio recordings. Transcripts are saved during the call, so captured text remains
available after a dropped connection. New calls do not preload this archive or
resume a previous discussion automatically. The Call history button can also
open, copy, and download saved transcripts.

This path needs the managed relay, its usual private phone URL, and an OpenAI API
key. It does **not** need a phone number, SIP, a webhook, Funnel, or any other
public endpoint. The permanent key stays on the Mac: the relay creates the
WebRTC call, then executes those tools over its private sideband connection.

Store the key without leaving it in shell history:

```bash
read -rs "OPENAI_KEY?OpenAI API key: "; echo
conductor-remote config set voice.openai-key "$OPENAI_KEY"
unset OPENAI_KEY
```

On the phone:

1. Open the workspace drawer and tap the phone immediately left of **+**.
2. Choose a voice and **Auto detect**, **Norsk**, or **English**, then tap
   **Start fleet call** and grant microphone access the first time.
3. Speak naturally. Server-side voice activity detection turns each pause into a
   turn; mute the microphone when needed.
4. Follow the live captions, or type into the call sheet when audio input is not
   convenient.
5. Close the sheet to keep browsing while the call continues. Reopen it from the
   same phone button; use the red handset to actually end the call.

The audio is AI-generated. Input captions use `gpt-live-transcribe`; the
configured Realtime model produces the answer and its audio. The PWA path is
foreground-only: mobile browsers cannot promise native-call continuity with the
screen locked, so use the optional dial-in transport for a pocketed commute.

## Optional dial-in orchestrator

The optional voice listener turns a phone call into a small Conductor control room: hear a bounded fleet tally, walk one decision at a time, create a workspace, and dispatch an exact prompt after a spoken read-back and explicit confirmation. It does not expose the PWA or the relay API publicly.

The scoped endpoint has the same twelve tools as the PWA: roll call, a fresh paged
workspace overview, chat context, next decision, call-history list/search/read,
repository list, create preview, confirmed create, send preview, and confirmed
send. Dial-in calls also start fresh and wait for your topic.
Forward-to-owner answers, artifact pushes, and voice grooming
remain later milestones.

## What you need

- The managed `conductor-remote` service and Tailscale on the Mac.
- Tailscale Funnel enabled for the tailnet. OpenAI's SIP sender must reach HTTPS port 443; 8443 and 10000 do not work for this webhook.
- An OpenAI API project with billing, an API key, its `proj_…` project ID, and a webhook signing secret.
- A Twilio account, auth token, and voice-capable phone number.
- The caller numbers to allow, in E.164 form, and a private 4–12 digit PIN.

OpenAI's [SIP guide](https://developers.openai.com/api/docs/guides/realtime-sip) documents the project-addressed SIP URI, `realtime.call.incoming` webhook, accept API, and the EU SIP host. Twilio's [incoming-call guide](https://www.twilio.com/docs/voice/tutorials/how-to-respond-to-incoming-phone-calls) describes the phone-number webhook/TwiML flow.

## 1. Install the service

```bash
conductor-remote service install --expose tailnet
conductor-remote service status
```

Voice always keeps the main relay tailnet-only. Its dedicated listener binds `127.0.0.1:8788`; the installer moves the relay off HTTPS 443 when necessary, publishes only `/voice` on 443, verifies the live Tailscale state, and records a 0600 ownership receipt. It refuses to replace a manual or foreign mount.

Use `--voice-port <port>` or `conductor-remote config set voice-port <port>` only if 8788 is occupied.

## 2. Store the local gate and provider settings

The commands below keep literal secrets out of shell history by reading them into temporary shell variables. They still exist briefly in this local process tree, like any CLI argument.

```bash
read -rs "OPENAI_KEY?OpenAI API key: "; echo
conductor-remote config set voice.openai-key "$OPENAI_KEY"
unset OPENAI_KEY

read -rs "TWILIO_TOKEN?Twilio auth token: "; echo
conductor-remote config set voice.twilio-auth-token "$TWILIO_TOKEN"
unset TWILIO_TOKEN

conductor-remote config set voice.project-id 'proj_your_project_id'
conductor-remote config set voice.allowed-callers '+4712345678,+15551234567'

read -rs "VOICE_PIN?Voice PIN: "; echo
conductor-remote config set voice.pin "$VOICE_PIN"
unset VOICE_PIN
```

Global residency is the default:

```bash
conductor-remote config set voice.sip-host sip.api.openai.com
```

Use `sip-eu.api.openai.com` only when **Project Settings → General → Project
Residency** says Europe. The relay then uses `eu.api.openai.com` for call accept
and its sideband WebSocket as well; mixing EU SIP ingress with global call
control makes the webhook's `call_id` invisible to the accept request.

## 3. Give the listener its permanent public URL

Replace the hostname with this Mac's MagicDNS name. Keep `/voice` exactly once.

```bash
conductor-remote config set voice.public-url 'https://your-mac.your-tailnet.ts.net/voice'
conductor-remote service status
```

Expected status has two different routes:

```text
Phone URL: https://your-mac.your-tailnet.ts.net:<port>/…  (same Tailnet only)
voice:     https://your-mac.your-tailnet.ts.net/voice (public) → 127.0.0.1:8788
```

The public root should stay closed while the signed webhook path answers:

```bash
curl -i 'https://your-mac.your-tailnet.ts.net/'
curl -i -X POST 'https://your-mac.your-tailnet.ts.net/voice'
```

The first request should get a Tailscale-layer 404. The second should reach the listener and reject the unsigned body; a rejection proves routing, not provider authentication.

## 4. Configure the OpenAI incoming-call webhook

In the OpenAI dashboard, open **Settings → Project → Webhooks** for the same project ID used above:

1. Create an endpoint with the exact URL `https://your-mac.your-tailnet.ts.net/voice`.
2. Subscribe it to `realtime.call.incoming`.
3. Copy the `whsec_…` signing secret and store it:

```bash
read -rs "OPENAI_WEBHOOK_SECRET?OpenAI webhook secret: "; echo
conductor-remote config set voice.webhook-secret "$OPENAI_WEBHOOK_SECRET"
unset OPENAI_WEBHOOK_SECRET
```

The relay accepts a valid incoming call through `POST /v1/realtime/calls/{call_id}/accept`, attaches an authenticated sideband WebSocket, and gives the session only the scoped remote MCP tools. Remote MCP follow-up responses are driven by the broker only after both the response and every tool call in it have finished, as required by OpenAI's [Realtime MCP guide](https://developers.openai.com/api/docs/guides/realtime-mcp).

## 5. Configure the Twilio number

In the Twilio Console, open the voice-capable number. For **A call comes in**, select **Webhook**, set:

```text
URL:    https://your-mac.your-tailnet.ts.net/voice/twiml
Method: HTTP POST
```

Save it, then call from an allowlisted number. Twilio signs the exact configured URL and form fields; even a harmless URL spelling change breaks validation. See Twilio's [webhook security guide](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

The expected path is:

1. An unlisted caller is rejected before the bridge.
2. An allowed caller hears the PIN prompt.
3. A wrong PIN is rejected.
4. A correct PIN bridges to the case-sensitive OpenAI project SIP URI with a short-lived HMAC marker.
5. The OpenAI webhook verifies its own signature, replay ID, and that marker before accepting the call.

## Verify and operate

```bash
conductor-remote config
conductor-remote service status
conductor-remote service logs
```

`config` prints only `(set)` for secrets. The files below are mode 0600:

```text
~/Library/Application Support/conductor-remote/voice.json
~/Library/Application Support/conductor-remote/voice-funnel.json
~/Library/Application Support/conductor-remote/voice-calls.json
~/Library/Application Support/conductor-remote/voice-previews.json
~/Library/Application Support/conductor-remote/voice-history.db
```

A requested roll call starts with the Mac's lock state. A confirmed send returns to the voice session immediately and reuses the relay's existing transcript receipt, retry, idempotency, and parked-prompt path. A landed send stays silent; a locked or failed send is announced. Merely hearing a decision does not clear it—dispatching it or explicitly skipping it advances the read mark.

### Saved transcripts

New browser and dial-in calls are saved automatically on the Mac. Open **Control room → Call history** to read a past call, copy its text, or export a `.txt` file. Hanging up a browser call opens its saved transcript. History is available to every device authenticated to this relay, including when voice calling is no longer configured.

The archive lives at `~/Library/Application Support/conductor-remote/voice-history.db`, with owner-only file permissions. It is a separate SQLite database owned by the relay; Conductor's database remains read-only. Back it up using SQLite's backup facility, or stop the relay before copying it, since an active database can have a `-wal` file alongside it. Calls are kept indefinitely.

The relay saves caller transcriptions, typed messages, assistant text, tool names, and call timestamps through its existing OpenAI sideband connection. Completed utterances are committed immediately; partial captions are checkpointed every half-second and flushed on shutdown. Audio recordings, raw event payloads, tool arguments and authentication headers are not archived. Saving works while the call panel is hidden and does not depend on a final upload from the phone.

Transcription can finish out of order, so the archive follows conversation item IDs and predecessor links rather than the arrival order of captions. See OpenAI's [transcription events](https://developers.openai.com/api/docs/guides/realtime-transcription) and [sideband controls](https://developers.openai.com/api/docs/guides/realtime-server-controls).

An interrupted reply is labeled because generated text can include words that were never played. Failed transcription is shown explicitly. A lost observer connection or relay restart marks possible gaps; reconnecting does not promise to recover events missed while disconnected. Previously completed calls that were never captured cannot be backfilled. Storage failures appear in the call panel and history, with details in the relay logs.

Authenticated reads are `GET /api/voice/history?limit=30&offset=0` for call summaries and `GET /api/voice/history/:callId` for one complete transcript. `?summary=1` reads its recording status without transferring the conversation.

The standard conductor-remote MCP server exposes the same archive over both stdio and HTTP:

- `list_voice_calls` lists recent calls with previews and call IDs. Use `limit` and `offset` to page through older calls.
- `search_voice_calls` searches caller and assistant text, with the same words/quoted-phrase grammar as `search_chats`. Each hit includes a call ID and an item ID; `call_id` can restrict the search to one call. Partial captions are searchable and are replaced when their corrected final text arrives.
- `read_voice_call` reads a call's latest entries, or a window around `near` (an item ID from search). `before`, `after`, `limit`, and `max_chars` bound the result. `older_item` and `newer_item` let the agent continue through the conversation. Gaps, failed transcription and interrupted replies remain explicit in MCP output.

For example, an agent can call `search_voice_calls({"query":"\"release Friday\""})`, then `read_voice_call({"call_id":"rtc_…","near":"item_…","before":4,"after":4})` with IDs from the result. These tools only read the archive through authenticated relay routes and never drive Conductor's UI or start a call. They are part of the main MCP server; the live voice session's scoped action tools remain separate. After installing the release, reconnect an existing MCP client so it discovers the new tools.

Search uses `GET /api/voice/search?q=…&limit=12&offset=0`, optionally with `callId=…`. Its local full-text index contains only caller and assistant text; tool payloads and internal relay nudges are excluded. Existing archives are indexed automatically without replacing their saved transcripts.

### Cost

The default is `gpt-realtime-2.1`. Existing installations keep their saved model; switch them with:

```bash
conductor-remote config set voice.model gpt-realtime-2.1
```

This restarts the relay; start a new call to use the new model. OpenAI currently publishes these per-million-token prices for GPT-Realtime-2.1:

| Modality | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Text | $4.00 | $0.40 | $24.00 |
| Audio | $32.00 | $0.40 | $64.00 |

The broker logs actual token usage and an estimate for every completed response. Use those lines for this workflow's real per-call cost; Twilio phone-number and PSTN charges are separate and depend on the account/country. The rate source is the [GPT-Realtime-2.1 model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1). `gpt-realtime-2.1-mini` remains available through `voice.model`, with its own cost estimates using the [Mini model rates](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).

### Reasoning effort

GPT-Realtime-2.1 defaults to **medium reasoning in this relay**, for both WebRTC
and SIP calls. Earlier relay versions omitted the setting and used the API's
unspecified default. A saved effort choice survives relay updates.

```bash
conductor-remote config set voice.reasoning-effort medium
```

The supported choices are `minimal`, `low`, `medium`, `high`, and `xhigh`.
`conductor-remote config` shows the configured choice. Changing it restarts the
relay; begin a new call to compare settings. The model stays the same. Older
non-reasoning voice models omit this option from their API requests.

Higher effort can increase response latency and cost. Compare how well the
assistant answers your questions and the delay before useful speech; a quick
acknowledgement alone does not measure answer latency. See OpenAI's
[reasoning guidance](https://developers.openai.com/api/docs/guides/realtime-models-prompting#set-reasoning-effort).

### Speech speed and workspace summaries

Browser calls start at **1.25× speech speed**. The Call
setup screen has a **Speech speed** slider below Voice and Language. Drag or use
the arrow keys to choose 0.25–1.5× in 0.05× steps before starting a fleet or
workspace call; the last speed you choose is saved in localStorage on that device
and used for your next call.

SIP calls also default to 1.25×. To tune the SIP default:

```bash
conductor-remote config set voice.speed 1.4
```

The supported range is 0.25–1.5; `unset` restores 1.25. Changing it restarts the
relay, so begin a new call. This uses OpenAI's
[audio output speed setting](https://developers.openai.com/api/reference/resources/realtime/subresources/calls/methods/create),
which changes playback speed after generation. It does not change reasoning effort
or the delay before the first audio arrives.

Requested workspace summaries list the most recently updated work first and identify
chats waiting for your answer, including a waiting sibling of a running chat. An unread
completion alone is not a request for input. The decision queue halves relevance each
day and gives questions and errors a modest boost; yesterday's error no longer always
outranks fresh work. Inactive chats leave the default summary and queue after three
days, including old errors and input waits. Running chats remain visible.

Ask to include older work to use `include_dormant`, or request a date range. These are
briefing filters; they do not archive workspaces or clear questions. Merged and Done
workspaces still require their explicit completion filters.

### Disable or rotate

This removes only the receipt-owned public voice mount and leaves the relay tailnet-only:

```bash
conductor-remote config set voice.public-url unset
```

Clear a credential the same way, for example:

```bash
conductor-remote config set voice.openai-key unset
conductor-remote config set voice.webhook-secret unset
```

Rotating a value through `config set` restarts the managed service. The relay token, generated MCP token, and trunk marker secret are separate; neither relay token nor provider secrets are returned by `config` or the log API.

## Troubleshooting

### Browser echo and interruptions

WebRTC calls emit `[voice-diagnostics]` metadata into the relay log. After reproducing,
use `relay_logs` with `contains: "voice-diagnostics"` (or the call ID from
`list_voice_calls`). For a managed relay, `file: "relay.log"` also reaches entries
from before a restart. Inspect promptly: the live log is a bounded ring, not a
permanent diagnostic archive. Both the PWA and relay must run the updated build.

Browser `capture` and five-second `sample` events report actual microphone settings,
support flags, mute state, playback state and available WebRTC audio levels/energy.
A null setting means the browser did not report it; `echoCancellation: true` means
enabled, not proof that all echo was removed. Missing echo-loss statistics mean
unsupported/unreported, not zero echo. Browser events use monotonic `atMs` since
diagnostics started for that call; `receivedAt` is the relay's receipt time, which
may lag after buffering or a network delay. Speech-start, playback-buffer and
response events carry item/response IDs to correlate with the saved transcript.
Server events provide a second timeline even when browser uploads fail.

Diagnostics never mute the microphone, change speech thresholds or disable
interruptions. They store no raw audio, captions, device identifiers, SDP or tools.
Uploads are bounded and best-effort; `dropped` counts discarded metadata events.
Background suspension, disconnection or process exit can still leave gaps.

The user bubbles come from a separate transcription model. The Realtime model
consumes audio directly, so a wrong caption can accompany a correctly understood
command; see the [Realtime API reference](https://platform.openai.com/docs/api-reference/realtime).

### Connection and configuration

- **The call rings and then fails with no relay log:** confirm the public endpoint is on 443 and is exactly `/voice`. OpenAI does not deliver this webhook through Funnel 8443 or 10000.
- **Twilio gets 403:** check the allowlist, the account's primary auth token, and that `voice.public-url + /twiml` is byte-for-byte the URL configured on the number.
- **OpenAI gets 400:** check the webhook signing secret and the Mac's clock.
- **Accept returns `call_id_not_found`:** confirm `voice.sip-host` matches the
  project residency. Global projects use `sip.api.openai.com`; EU-resident
  projects use `sip-eu.api.openai.com`.
- **OpenAI accepts but the voice does not start:** inspect `service logs` for MCP import or observer socket errors. The broker waits for `mcp_list_tools.completed` before the greeting.
- **A send parks:** unlock the Mac. The same parked queue used by the PWA delivers it after unlock.
- **The installer refuses Funnel changes:** `tailscale serve status --json` contains a mount that has no matching conductor-remote ownership receipt. Move that mount yourself; the installer will not overwrite it.

### Draft cards and interruptions

Browser calls show full draft cards with their destination, Edit, and Send or Create workspace controls. Jarvis gives a brief spoken cue after the visible card acknowledges its exact revision. Enable **Hands-free: read drafts aloud** to use spoken review. A hidden sheet or unavailable visual receipt also falls back to reading the full preview. This follows OpenAI's tool-driven [conversation flow](https://developers.openai.com/api/docs/guides/realtime-conversations).

Editing or renewing a draft creates a new one-use token and invalidates the previous revision. Expiring the two-minute approval does not delete the text. Drafts and action receipts are retained for 30 days in `voice-previews.json`, independently of speech and transcripts; old records are pruned when another draft is created. Call history shows the saved result and an Open workspace/chat link. A parked receipt records the handoff to the unlock queue; open the chat for its current delivery status. A lost receipt is marked unknown, and a restart never retries a claimed action automatically.

Typed corrections work while listening, thinking, or speaking. The browser call uses VAD for segmentation and interruption, while the relay starts responses after committed input and schedules typed corrections and tool continuations. Playback completion is tracked separately from response generation. A disconnected observer ends the local call visibly even if the media connection is still alive. The last 100 terminal response statuses and sanitized error codes are saved with call history; relay logs also include time to first output.

For a real-call acceptance pass: request a long draft, interrupt its brief cue, edit and approve it, and confirm that the created workspace stays linked after hang-up. Repeat with the sheet hidden and hands-free enabled, then type a correction during speech. Compare natural pauses and background noise only after these paths work; this change leaves the existing 650 ms VAD silence threshold in place.
