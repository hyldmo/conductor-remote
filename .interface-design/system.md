# Conductor Remote Interface System

## Direction and feel

Conductor Remote is a developer's phone-side control surface for agents running on a Mac. It should feel like a compact instrument panel: calm enough to scan during a long run, dense enough to make a decision without opening another screen, and technical without resembling a generic analytics dashboard.

Domain cues to preserve are context windows, compaction seams, transcript strata, tool churn, running state, and fork handoff. Prefer language from that world—context, reasoning, tools, transcript, fork—over generic dashboard labels.

The signature pattern is a source-to-fork comparison: one stacked meter shows what occupies the current context, then cumulative bars reuse the same colors to show what each fork carries forward. This pattern belongs anywhere the app compares an agent's current state with a smaller handoff payload.

## Depth strategy

Use border-led depth. Graphite surfaces should differ quietly through `bg-bg`, `bg-surface`, and `bg-surface-2`, separated by `border-border-soft` or `border-border`. Do not add shadows to ordinary cards or data regions. A modal sheet may use the app's existing backdrop and one restrained outer shadow because it sits above the whole workspace.

Use rounded containers consistently with the app: full sheets at `rounded-3xl`, grouped data at `rounded-xl`, and compact inline controls as full pills. Avoid thick borders, gradients, and decorative elevation.

## Color semantics

- `context-initial` adaptive silver/ink: initial context and provider-owned overhead, kept distinct from the unused track.
- `context-chat` magenta: human/assistant chat, separate from interactive-selection violet.
- `working` amber: thinking/reasoning and caution near context pressure.
- `context-tools` teal: tool calls and tool-derived payload, separate from completion blue.
- `accent`, `done`, and `faint` retain their app-level meanings for selection, completion, and inactive structure.
- `muted` and `text`: explanatory and primary copy respectively.

These colors encode transcript strata, not decoration. Reuse them in a comparison only when the meaning remains identical. Never substitute arbitrary hex values for the existing light/dark tokens.

## Spacing and type

Use a 4px base unit, with 8px for tight relationships, 12px for compact rows, 16px for sheet padding, and 20px between major sections. Keep padding symmetrical unless safe-area or scrolling behavior requires otherwise.

Use the existing system sans family for copy and tabular numerals for token counts and percentages. Typical hierarchy:

- 16px semibold sheet title.
- 14px semibold section label and primary total.
- 12px category or fork label.
- 11px secondary explanation and estimation caveats.

## Key component patterns

### Context trigger

The percentage beside each chat tab is its own button, not part of the tab-selection target. Keep it compact, tabular, and amber from 80% usage onward. Its accessible name must identify both the chat and the used percentage.

Repeat the trigger in the composer immediately left of Attachments as an 18px donut inside the standard 32px control target. Its total filled arc shows overall context pressure, and that arc is subdivided in the sheet's fixed order and colors: adaptive silver/ink `context-initial`, magenta `context-chat`, amber `working`, and teal `context-tools`. `border` remains the unused context-window track. While its on-demand composition loads—or if that read fails—fall back to a single `accent` arc (`working` at 80%+) so the exact provider usage remains visible. The donut and tab percentage open the same sheet.

### Context strata meter

Lead with the exact provider-persisted total and usage percentage. Follow with a single stacked bar in the fixed order initial → chat → thinking → tools, then a two-column legend with token estimate and share. Show a nonzero sub-1% share as `<1%`, never `0%`.

Explain estimation in place. Chat means user prompts and visible replies; initial context is the residual containing system/developer prompts, project instructions, skills, tool definitions, attachments, compaction summaries, and provider overhead.

### Fork ladder

Order choices from least to most context: Last message only, Concise, With reasoning, Full transcript. Scale all full-history bars against the largest fork and build them cumulatively with the context colors. State that source initial context is not copied and that estimates use the full saved transcript. If the provider persisted no reasoning, explain why Concise and With reasoning are equal.

### Context sheet

Use the shared bottom-sheet form: portalled to `body`, capped at 85dvh, independently scrollable, bottom-anchored on phones, and centered on wider screens. The header stays fixed while content scrolls. Preserve loading, recoverable error, retry, backdrop-dismiss, and explicit close states.

## Data honesty

Exact provider values and transcript-derived estimates must be visually and verbally distinct. Prefix estimated token values with `≈`, call the section estimated, and preserve the exact total when fitting category proportions. Exclude opaque signatures, encoded binary payloads, incomplete turns, and mirrored child-agent internals from category estimates.
