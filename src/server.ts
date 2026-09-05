import { startAutoUpdate } from './host/autoupdate.ts'

import { startFunnelWatchdog } from './host/funnel-watchdog.ts'
import { watchNoSleepExpiry } from './host/nosleep.ts'
import { driftWarningLines, tailscaleBin } from './host/tailscale.ts'
import { createRelayServer } from './http/router.ts'
import { createRelayServices } from './http/services.ts'
import { startNotifier } from './notifications/notify.ts'
import { voicePort } from './voice/config.ts'

const services = createRelayServices()
const {
	cfg,
	voiceServer,
	voiceBroker,
	voiceHistory,
	orchestration,
	relayIdentity,
	recoverUiLease,
	wakeWorkflows,
	actuator,
	firstPrompts,
	autoModels,
	sweepStagedAttachments,
	STAGED_ATTACHMENT_SWEEP_MS,
	parkedPrompts,
	delegationQueue,
	liveDelegationStores,
	devServers,
	reads,
	sessionPoller
} = services
const server = createRelayServer(services)

server.listen(cfg.port, cfg.host, () => {
	voiceServer.listen(voicePort(), '127.0.0.1', () => {
		console.info(`  voice:      127.0.0.1:${voicePort()}${voiceBroker ? '' : ' (waiting for OpenAI config)'}`)
		void voiceBroker?.restore()
		if (!voiceBroker) voiceHistory.recover()
	})
	if (orchestration.writable) {
		setInterval(() => orchestration.heartbeatRelayInstance(relayIdentity), 2_000).unref()
		setInterval(() => void recoverUiLease(), 2_000).unref()
		setInterval(wakeWorkflows, 2_000).unref()
		setInterval(
			() => orchestration.compactTerminalRuns({ olderThan: Date.now() - 30 * 24 * 60 * 60_000 }),
			24 * 60 * 60_000
		).unref()
		queueMicrotask(() => void recoverUiLease().finally(wakeWorkflows))
	}
	// Under `yarn dev` the app comes from Vite and only /api comes from here, so the URL worth
	// printing is Vite's — carrying the token, which Vite itself has no way to print.
	const dev = cfg.devWebPort !== undefined
	console.info(
		[
			'conductor-remote relay up',
			`  db:         ${cfg.dbPath}`,
			`  worktrees:  ${cfg.workspacesRoot}`,
			`  actuator:   ${actuator.name}`,
			`  bound:      ${cfg.host}:${cfg.port}${dev ? '  (/api only — Vite serves the app)' : ''}`,
			'',
			dev
				? `  Local:  http://localhost:${cfg.devWebPort}/#token=${cfg.token}`
				: `  Local:  http://${cfg.host}:${cfg.port}/#token=${cfg.token}`,
			dev
				? "  Phone:  same URL with this Mac's tailnet IP in place of localhost (Vite prints it as `Network:`)"
				: '  Phone:  fronted by `tailscale funnel`/`serve` — run `yarn service status` for the HTTPS URL'
		].join('\n')
	)
	// Loud, actionable warning in relay.log if the node's MagicDNS name drifted from the saved phone URL's host
	// (a renamed node silently bricks the installed PWA). No-ops until a drift-aware deploy recorded a baseline.
	const tsBin = tailscaleBin()
	if (tsBin) {
		const drift = driftWarningLines(tsBin)
		if (drift.length) console.info(`\n${drift.join('\n')}`)
	}
	// Pick up any first prompt the previous process was still holding — an auto-update
	// restart lands mid-setup often enough that this is the normal path, not a rare one.
	firstPrompts.start()
	autoModels.start()
	// New Workspace uploads are host-side so another device can restore their pills.
	// Sweep only week-old directories absent from both a draft and the delivery queue.
	sweepStagedAttachments()
	setInterval(sweepStagedAttachments, STAGED_ATTACHMENT_SWEEP_MS).unref()
	// Same for prompts parked behind the lock screen — a lock outlives relay restarts.
	parkedPrompts.start()
	// Active/failed delegation state lives in each live worktree. Register every
	// store on startup; the queue resumes side-effect stages at least once.
	delegationQueue.resume(liveDelegationStores())
	// A launchd/self-update restart kills the loopback bridge but not Tailscale's
	// persisted Serve mapping. Rebuild bridges for dev servers that are still up,
	// and remove this relay's stale mappings for ones that are not.
	void devServers.restore()
	// Keep the managed global daemon current — no-ops for dev checkouts / unmanaged runs (see src/host/autoupdate.ts).
	startAutoUpdate()
	// Keep the phone's public URL reachable — re-registers Funnel when its ingress goes stale after a
	// network change. No-ops unless managed + public (Funnel) posture (see src/host/funnel-watchdog.ts).
	startFunnelWatchdog()
	// One base DB read fans out to notification and orchestration listeners. Push can
	// be disabled or have zero devices without stopping the clock delegated jobs need.
	startNotifier(reads, sessionPoller)
	sessionPoller.start()
	// Watch armed keep-awake windows for their recorded expiry: the helper's restore only
	// re-allows sleep, so a lid still shut at expiry needs the relay's `pmset sleepnow`
	// (see src/host/nosleep.ts). Also picks a window back up after the relay's own restarts.
	watchNoSleepExpiry()
})
