# Voice setup

## PWA fleet call over WebRTC

The primary foreground voice mode is one fleet-wide control room. In the
workspace-list header, tap the phone immediately left of **+**, then start the
call. The orchestrator surveys every workspace, presents one bounded decision
at a time, creates new workspaces, and queues exact prompts. Both writes happen
only after it reads the target and text back and you confirm. It is not owned by
the chat currently on screen: hide the sheet or move between workspaces and the
same call continues.

Live captions keep both sides readable, and the text box in the call sheet is a
fallback when speaking is inconvenient. The eight available actions are roll
call, fresh workspace overview, next decision, repository list, workspace-create
preview and confirmed creation, plus send preview and confirmed send. The two
writes use the same persisted, one-use preview/confirmation gate as the dial-in
orchestrator.

An ordinary overview excludes workspaces marked **Done** or whose pull request
is merged. Ask to include either when completed work is relevant. Overview
requests can also filter by repository, live agent status, workspace status, PR
status, and an `updated_since`/`updated_before` time window; each spoken row says
how recently its selected chat changed.

This path needs the managed relay, its usual private phone URL, and an OpenAI API
key. It does **not** need a phone number, SIP, a webhook, Funnel, or any other
public endpoint. The permanent key stays on the Mac: the relay creates the
WebRTC call, then executes those eight tools over its private sideband connection.

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

The scoped endpoint has eight tools: roll call, a fresh paged workspace overview,
next decision, repository list, create preview, confirmed create, send preview,
and confirmed send. Forward-to-owner answers, artifact pushes, and voice grooming
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

The relay accepts a valid incoming call through `POST /v1/realtime/calls/{call_id}/accept`, attaches an authenticated sideband WebSocket, and gives the session only the eight scoped remote MCP tools. Remote MCP follow-up responses are driven by the broker only after both the response and every tool call in it have finished, as required by OpenAI's [Realtime MCP guide](https://developers.openai.com/api/docs/guides/realtime-mcp).

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
```

Each call starts with the Mac's lock state. A confirmed send returns to the voice session immediately and reuses the relay's existing transcript receipt, retry, idempotency, and parked-prompt path. A landed send stays silent; a locked or failed send is announced. Merely hearing a decision does not clear it—dispatching it or explicitly skipping it advances the read mark.

### Cost

The default is `gpt-realtime-2.1-mini`. OpenAI currently publishes these per-million-token prices:

| Modality | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Text | $0.60 | $0.06 | $2.40 |
| Audio | $10.00 | $0.30 | $20.00 |

The broker logs actual token usage and an estimate for every completed response. Use those lines for this workflow's real per-call cost; Twilio phone-number and PSTN charges are separate and depend on the account/country. The rate source is the [GPT-Realtime-2.1 Mini model page](https://developers.openai.com/api/docs/models/gpt-realtime-2.1-mini).

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

- **The call rings and then fails with no relay log:** confirm the public endpoint is on 443 and is exactly `/voice`. OpenAI does not deliver this webhook through Funnel 8443 or 10000.
- **Twilio gets 403:** check the allowlist, the account's primary auth token, and that `voice.public-url + /twiml` is byte-for-byte the URL configured on the number.
- **OpenAI gets 400:** check the webhook signing secret and the Mac's clock.
- **Accept returns `call_id_not_found`:** confirm `voice.sip-host` matches the
  project residency. Global projects use `sip.api.openai.com`; EU-resident
  projects use `sip-eu.api.openai.com`.
- **OpenAI accepts but the voice does not start:** inspect `service logs` for MCP import or observer socket errors. The broker waits for `mcp_list_tools.completed` before the greeting.
- **A send parks:** unlock the Mac. The same parked queue used by the PWA delivers it after unlock.
- **The installer refuses Funnel changes:** `tailscale serve status --json` contains a mount that has no matching conductor-remote ownership receipt. Move that mount yourself; the installer will not overwrite it.
