# Auto model selection

Choose **Auto** at the top of the model picker in New workspace or before a chat's first message. Its settings button edits the router, task profiles, routing rules, fallback, and the default for future workspaces and chats. Workflow and Auto are mutually exclusive. Auto controls the initial model, effort, and Fast setting; selecting a concrete model returns to manual selection.

The initial router is **5.6 Luna, low effort**. Both exact Muse Spark options are supported: `opencode-go/muse-spark-1.3-contributor` and `opencode/muse-spark-1.3-contributor-free`. They remain separate choices. Router calls use the installed CLIs' authentication, run outside worktrees with tools disabled, and create no Conductor chat. Codex calls are ephemeral; successful OpenCode classifier sessions are deleted afterward.

| Profile | Initial model | Tasks |
| --- | --- | --- |
| quick | Luna · low | Explicit local edits, copy, mechanical changes |
| exploration | Muse Spark contributor | Focused searches and read-only exploration |
| standard | Terra · medium | Bounded UI work and conventional features |
| complex | Sol · high | Diagnosis, integrations, interacting modules |
| deep | Astra · high | Difficult concurrency, recovery, authorization, major changes |
| design | Fable 5.1 · high | Product and architecture tradeoffs |

The classifier receives the first message, repository name, and bounded submitted attachments. It returns a profile ID and a short reason. It cannot supply arbitrary model settings. Missing essential context, invalid output, unavailable authentication, or a timeout selects the configured fallback (initially Sol). An unavailable fallback blocks acceptance. Later messages do not trigger routing again; the selected model and reason remain visible, and manual changes work normally after delivery.

Settings live in `stateDir()/auto-model.json`. The relay owns accepted submissions in `stateDir()/auto-model-prompts/`, independently of the phone connection. It saves the exact profile settings and transcript/outbox cursor before applying settings or sending. Retries reuse that decision; after a restart a matching Conductor receipt completes the job without another send. One lease per submission prevents an installed and development relay from classifying simultaneously. Failed submissions remain visible with Retry and Dismiss. Dismiss during selection prevents its late result from sending; once UI delivery has started, the response asks the caller to wait for the receipt.

Auto never writes Conductor's database. Settings and prompt delivery use the existing UI mutex and verified actuator path, with fresh checks for first-message and Workflow/delegation ownership. Submitted attachment paths are resolved within the worktree's attachment directory; unknown binary formats or omitted context select the fallback.
