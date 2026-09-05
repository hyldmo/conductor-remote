import { Clock, RotateCcw, Sun, Wifi } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { parseDurationSeconds } from '../../../../src/shared.ts'
import { ApiError, client } from '../../lib/api.ts'
import { cn } from '../../lib/cn.ts'
import { isLockedError } from '../../lib/lock.ts'
import type { SettingsResponse } from '../../lib/types.ts'
import { UnlockLink } from '../ui.tsx'

const AWAKE_CHOICES: { label: string; seconds: number; className?: string }[] = [
	{ label: '1h', seconds: 3600 },
	{ label: '4h', seconds: 4 * 3600, className: 'hidden min-[400px]:block' },
	{ label: '10h', seconds: 10 * 3600 }
]

/** "until 21:45", weekday-prefixed when the window crosses midnight — same rule the CLI prints. */
function untilLabel(until: number | null): string {
	if (!until) return 'until you turn it off'
	const d = new Date(until)
	const sameDay = d.toDateString() === new Date().toDateString()
	const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
	return sameDay ? `until ${time}` : `until ${d.toLocaleDateString([], { weekday: 'short' })} ${time}`
}

/**
 * The three things about the *Mac* a phone can usefully change: keep it awake with the lid
 * shut, name a network to fall back to when it loses the one it's on, and restart Conductor.
 *
 * Both are opt-in on the Mac side and say so rather than appearing broken. Keeping the Mac
 * awake needs `nosleep setup` (a scoped sudoers rule — a daemon has no TTY to answer a
 * password prompt), and with none installed the relay reports `available: false`, which is
 * what the copy explains instead of a dead button.
 *
 * By default the same window blocks the idle screen saver, because Accessibility writes
 * need an unlocked session. The Mac CLI owns that configuration.
 */
export function MacRow() {
	const [data, setData] = useState<SettingsResponse | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	// The disarm answer said the lid is shut and the Mac is about to be *put* to sleep — the
	// relay goes unreachable seconds after the tap, and copy that still read "stops the Mac
	// sleeping when you shut the lid" made that look like the app breaking.
	const [goingToSleep, setGoingToSleep] = useState(false)
	const [pickingAwakeDuration, setPickingAwakeDuration] = useState(false)
	const [awakeDuration, setAwakeDuration] = useState('')
	const [awakeDurationError, setAwakeDurationError] = useState<string | null>(null)
	// Restarting quits the app, so it is two taps like Disconnect above — and the second
	// tap has a second form: 'agents' is the relay having refused because chats are
	// mid-turn, which is a different sentence and a different consent.
	const [restart, setRestart] = useState<'idle' | 'confirm' | 'agents'>('idle')
	const [restartedMs, setRestartedMs] = useState<number | null>(null)

	const load = useCallback(async () => {
		try {
			setData(await client.settings())
			setError(null)
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
	}, [])

	useEffect(() => {
		void load()
	}, [load])

	const act = async (fn: () => Promise<unknown>) => {
		setBusy(true)
		setError(null)
		try {
			await fn()
			await load()
			return true
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
			return false
		} finally {
			setBusy(false)
		}
	}

	const doRestart = async (stopAgents: boolean) => {
		setBusy(true)
		setError(null)
		try {
			const result = await client.restartConductor(stopAgents)
			setRestartedMs(result.ms ?? 0)
			setRestart('idle')
			await load()
		} catch (err) {
			// 409 is this route's one refusal with a second half — agents are still working,
			// and ending them is its own yes. The relay's sentence carries the count, which is
			// why it is shown rather than a number this sheet would have to guess at.
			if (err instanceof ApiError && err.status === 409) setRestart('agents')
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setBusy(false)
		}
	}

	const setCustomAwakeDuration = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const seconds = parseDurationSeconds(awakeDuration)
		if (seconds === null) {
			setAwakeDurationError('Use a duration like 80h, 90m, or a number of seconds.')
			return
		}
		if (seconds < 1) {
			setAwakeDurationError('Choose a duration longer than zero.')
			return
		}
		const maxSeconds = data?.nosleep.maxSeconds ?? 7 * 24 * 3600
		if (seconds > maxSeconds) {
			setAwakeDurationError(`Choose a duration up to ${Math.round(maxSeconds / 3600)}h.`)
			return
		}

		setAwakeDurationError(null)
		setGoingToSleep(false)
		if (await act(() => client.armNoSleep(seconds))) setPickingAwakeDuration(false)
	}

	const nosleep = data?.nosleep
	// The one thing that stops every write, and the one the card used to talk over: a
	// keep-awake window blocks the idle lock, so it cannot lift a lock already up and
	// does not survive a lid close or a manual lock.
	const locked = data?.screenLocked === true
	const known = data?.wifi.known ?? []
	const fallback = data?.settings.fallbackSsids[0] ?? ''

	return (
		<div className="flex w-full shrink-0 flex-col gap-2.5 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<Sun size={16} className={cn('shrink-0', nosleep?.armed ? 'text-accent' : 'text-muted')} />
					<span>Keep the Mac awake</span>
				</div>
				{nosleep?.armed ? (
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							void act(async () => {
								const r = await client.disarmNoSleep()
								setGoingToSleep(r.willSleep === true)
							})
						}
						className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs active:bg-surface disabled:opacity-50"
					>
						Let it sleep
					</button>
				) : (
					<div className="flex shrink-0 gap-1">
						{AWAKE_CHOICES.map(c => (
							<button
								key={c.seconds}
								type="button"
								disabled={busy || !nosleep?.available}
								onClick={() =>
									void act(() => {
										setPickingAwakeDuration(false)
										setAwakeDurationError(null)
										setGoingToSleep(false)
										return client.armNoSleep(c.seconds)
									})
								}
								className={cn(
									'rounded-lg border border-border px-2.5 py-1 text-xs active:bg-surface disabled:opacity-40',
									c.className
								)}
							>
								{c.label}
							</button>
						))}
						<button
							type="button"
							disabled={busy || !nosleep?.available}
							aria-label="Choose a custom keep-awake duration"
							aria-expanded={pickingAwakeDuration}
							onClick={() => {
								setAwakeDurationError(null)
								setPickingAwakeDuration(open => !open)
							}}
							className={cn(
								'grid size-[30px] place-items-center rounded-lg border border-border active:bg-surface disabled:opacity-40',
								pickingAwakeDuration && 'bg-surface text-accent'
							)}
						>
							<Clock size={14} />
						</button>
					</div>
				)}
			</div>
			{!nosleep?.armed && pickingAwakeDuration ? (
				<form onSubmit={setCustomAwakeDuration} className="fade-in flex items-center justify-end gap-1.5">
					<label htmlFor="awake-duration" className="text-xs text-muted">
						Keep awake for
					</label>
					<input
						id="awake-duration"
						type="text"
						required
						value={awakeDuration}
						disabled={busy}
						placeholder="e.g. 80h"
						autoCapitalize="none"
						autoCorrect="off"
						onChange={event => {
							setAwakeDuration(event.target.value)
							setAwakeDurationError(null)
						}}
						className="h-[30px] w-[6.5rem] rounded-lg border border-border bg-surface px-2 text-xs text-text disabled:opacity-40"
					/>
					<button
						type="submit"
						disabled={busy || !awakeDuration.trim()}
						className="h-[30px] rounded-lg bg-accent px-2.5 text-xs font-medium text-on-solid active:opacity-80 disabled:opacity-40"
					>
						{busy ? 'Setting…' : 'Set'}
					</button>
				</form>
			) : null}
			{awakeDurationError ? <p className="text-right text-xs text-del">{awakeDurationError}</p> : null}
			<p className="text-xs text-muted">
				{!data
					? 'Checking…'
					: !nosleep?.available
						? 'Run `conductor-remote nosleep setup` on the Mac to install or refresh the helper.'
						: nosleep.armed
							? nosleep.preventsScreenLock
								? locked
									? `Awake ${untilLabel(nosleep.until)}, lid closed. It blocks the idle screen lock from starting; it can’t lift one already up.`
									: `Awake ${untilLabel(nosleep.until)}, lid closed. The idle screen lock is off; anyone at the Mac can use it.`
								: `Awake ${untilLabel(nosleep.until)}, lid closed. Sends park if macOS locks.`
							: goingToSleep
								? 'The lid is shut, so the Mac is going to sleep now — this app will be unreachable until you wake it.'
								: 'Stops system sleep. Screen-lock behavior follows the Mac CLI configuration.'}
			</p>
			{locked ? (
				<p className="text-xs text-del">
					The Mac is locked right now, so writes park until it’s unlocked. <UnlockLink />
				</p>
			) : null}

			<div className="border-t border-border pt-2.5">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2 text-sm">
						<Wifi size={16} className={cn('shrink-0', data?.settings.autoRejoin ? 'text-accent' : 'text-muted')} />
						<span>Fallback network</span>
					</div>
					{fallback ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => void act(() => client.patchSettings({ fallbackSsids: [], autoRejoin: false }))}
							className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs active:bg-surface disabled:opacity-50"
						>
							Turn off
						</button>
					) : null}
				</div>

				{fallback ? (
					<p className="mt-1 text-xs text-muted">
						Auto-joins <span className="text-fg">{fallback}</span> when the primary network drops.
					</p>
				) : (
					<NetworkPicker
						known={known}
						hotspots={data?.wifi.likelyHotspots ?? []}
						busy={busy}
						onPick={ssid => void act(() => client.patchSettings({ fallbackSsids: [ssid], autoRejoin: true }))}
					/>
				)}

				{/* The one hotspot fact macOS will actually tell us, and it decides whether any of
				    this can help the case it exists for. On Never the Mac won't reach for the phone
				    on its own, and no relay code substitutes for that. */}
				{data?.wifi.autoJoinHotspot === 'Never' ? (
					<p className="mt-1 text-xs text-faint">
						Auto-join Hotspot is off on this Mac (System Settings ▸ Wi-Fi). Your hotspot has to be on and broadcasting
						before the Mac can join it.
					</p>
				) : null}
			</div>

			{/* Third, and the only one whose subject is Conductor rather than the machine. It is
			    last because it is the heaviest: it quits the app. It exists because the failure it
			    answers is invisible from everywhere else — chats keep accepting prompts and no
			    agent answers, so nothing on screen looks broken (measured 2026-09-02: two and a
			    half hours of prompts landing with no agent output behind any of them). */}
			<div className="border-t border-border pt-2.5">
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-center gap-2 text-sm">
						<RotateCcw size={16} className="shrink-0 text-muted" />
						<span>Restart Conductor</span>
					</div>
					{restart === 'idle' ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								setRestartedMs(null)
								setError(null)
								setRestart('confirm')
							}}
							className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs active:bg-surface disabled:opacity-50"
						>
							Restart
						</button>
					) : null}
				</div>
				{restartedMs !== null ? (
					<p className="mt-1 text-xs text-muted">
						Quit and reopened in {(restartedMs / 1000).toFixed(1)}s. Send a prompt to check an agent answers.
					</p>
				) : null}
				{restart !== 'idle' ? (
					<div className="fade-in mt-2 rounded-xl border border-del/40 bg-del/10 px-3 py-2.5 text-left">
						<p className="text-sm font-medium">
							{restart === 'agents' ? 'Agents are still working' : 'Restart Conductor?'}
						</p>
						<p className="mt-1 text-xs text-muted">
							{restart === 'agents'
								? 'Restarting ends their turns. Everything they have already written stays in the chat.'
								: 'The app closes and opens again, which takes about ten seconds. Anything mid-turn stops.'}
						</p>
						<div className="mt-2.5 flex gap-2">
							<button
								type="button"
								onClick={() => {
									setRestart('idle')
									setError(null)
								}}
								className="flex-1 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm active:bg-surface"
							>
								Cancel
							</button>
							<button
								type="button"
								disabled={busy}
								onClick={() => void doRestart(restart === 'agents')}
								className="flex-1 rounded-lg bg-del px-3 py-2 text-sm font-semibold text-on-solid active:opacity-80 disabled:opacity-50"
							>
								{busy ? 'Restarting…' : restart === 'agents' ? 'Stop agents and restart' : 'Restart'}
							</button>
						</div>
					</div>
				) : null}
			</div>

			{error ? (
				<p className="text-xs text-del">
					{error} {isLockedError(error) ? <UnlockLink /> : null}
				</p>
			) : null}
		</div>
	)
}

/**
 * Choosing one network out of everything this Mac has ever joined — 135 of them on the
 * machine this was built against, which is why a bare `<select>` was the wrong control.
 *
 * **The short list the macOS Wi-Fi menu draws cannot be had.** That menu is a live scan
 * plus a Personal Hotspot learned over Continuity, and both are shut: `system_profiler
 * SPAirPortDataType` does scan and reports every neighbour's channel, security and signal,
 * but prints `<redacted>` for the name without Location Services — it can count them, never
 * name them — the hotspot arrives over private BLE and touches no file, and the store that
 * would at least date each network (`com.apple.wifi.known-networks.plist`, `LastAssociatedAt`)
 * is `-rw------- root`. The world-readable airport prefs keep a `PreferredOrder` array, and
 * on this Mac it is empty. So the saved list is the only list, and it arrives whole.
 *
 * What rescues it is that the list is not arbitrary: `known` comes in macOS's own preference
 * order, which tracks how recently each network was joined, so its head *is* what the menu
 * shows — here `vafler` (associated) then `Han Høyes iPhone` (the hotspot), in that order.
 * Hence only the first hotspot guess is promoted. Sorting every guess to the front instead
 * filled all eight visible slots with iPhones — six of them other people's, ranked 25th to
 * 130th — and buried the office Wi-Fi sitting at rank 3. The guess reads the SSID text alone
 * (`looksLikeHotspot` in src/host/wifi.ts), so it stays labelled "likely" and stays cheap: it may
 * lift one row, and decide nothing.
 */
function NetworkPicker({
	known,
	hotspots,
	busy,
	onPick
}: {
	known: string[]
	hotspots: string[]
	busy: boolean
	onPick: (ssid: string) => void
}) {
	const [query, setQuery] = useState('')

	if (known.length === 0) return <p className="mt-1 text-xs text-muted">No saved Wi-Fi networks to offer.</p>

	const hot = new Set(hotspots)
	const q = query.trim().toLowerCase()
	const found = known.filter(s => !q || s.toLowerCase().includes(q))
	const phone = found.find(s => hot.has(s))
	const matches = (phone ? [phone, ...found.filter(s => s !== phone)] : found).slice(0, 6)

	return (
		<>
			<p className="mt-1 text-xs text-muted">
				Turn your hotspot on before you leave, and the Mac can move to it if the office Wi-Fi drops.
			</p>
			<input
				type="search"
				value={query}
				disabled={busy}
				onChange={e => setQuery(e.target.value)}
				placeholder={`Search ${known.length} saved networks`}
				className="mt-2 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-xs disabled:opacity-40"
			/>
			<div className="mt-1.5 flex flex-col gap-1">
				{matches.map(ssid => (
					<button
						key={ssid}
						type="button"
						disabled={busy}
						onClick={() => onPick(ssid)}
						className="flex items-center justify-between gap-2 rounded-lg border border-border px-2.5 py-1.5 text-left text-xs active:bg-surface disabled:opacity-50"
					>
						<span className="truncate">{ssid}</span>
						{hot.has(ssid) ? <span className="shrink-0 text-faint">likely hotspot</span> : null}
					</button>
				))}
				{matches.length === 0 ? <p className="text-xs text-faint">Nothing matches “{query}”.</p> : null}
			</div>
			{/* Says what the six are, so a short list off a 135-network Mac doesn't read as arbitrary. */}
			{!q && known.length > matches.length ? (
				<p className="mt-1 text-xs text-faint">
					Most recently joined. Search to reach the other {known.length - matches.length}.
				</p>
			) : null}
		</>
	)
}
