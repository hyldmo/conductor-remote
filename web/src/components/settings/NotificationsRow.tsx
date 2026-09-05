import { Bell } from 'lucide-react'
import { usePush } from '../../hooks/push.ts'
import { cn } from '../../lib/cn.ts'

/**
 * Push notifications for this device. Lives on the Connect sheet because that is
 * where everything about *this phone's* relationship with the relay already is —
 * its token, its QR, its logs.
 *
 * The copy carries the fix, not just the state: on iOS the common answer is "add
 * it to your Home Screen" (Safari exposes no push API in a tab) and the second is
 * "you denied it once, so the browser will never ask again" — neither of which a
 * greyed-out switch would explain.
 */
export function NotificationsRow() {
	const push = usePush()
	const blocked = push.permission === 'denied'
	const unavailable = push.support !== 'ok' || push.relayDisabled

	const explain = push.relayDisabled
		? 'Turned off on the relay (PUSH_NOTIFY=off).'
		: push.support === 'needs-install'
			? 'Add this to your Home Screen first — iOS only allows notifications for installed apps.'
			: push.support === 'insecure'
				? 'Needs a secure connection — open the app on its https:// Tailscale URL.'
				: push.support === 'unsupported'
					? 'This browser can’t receive push notifications.'
					: blocked
						? 'Blocked for this app — allow notifications in your device settings, then come back.'
						: push.enabled
							? `On for this device${push.devices > 1 ? ` · ${push.devices} devices subscribed` : ''}.`
							: 'Get a ping when an agent finishes its turn or hits an error.'

	return (
		<div className="w-full shrink-0 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<Bell size={16} className={cn('shrink-0', push.enabled ? 'text-accent' : 'text-muted')} />
					<span>Notifications</span>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={push.enabled}
					aria-label="Notifications on this device"
					disabled={unavailable || blocked || push.busy}
					onClick={() => void (push.enabled ? push.disable() : push.enable())}
					className={cn(
						'relative h-6 w-11 shrink-0 rounded-full transition-colors',
						push.enabled ? 'bg-accent' : 'border border-border bg-surface',
						(unavailable || blocked || push.busy) && 'opacity-40'
					)}
				>
					{/* `left-0.5` is load-bearing: without an inset the absolute knob resolves to its
					    static position, which a button centres — so the "off" state drew mid-pill. */}
					<span
						className={cn(
							'absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform',
							push.enabled ? 'translate-x-5' : 'translate-x-0'
						)}
					/>
				</button>
			</div>
			<p className="mt-1 text-xs text-muted">{explain}</p>
			{push.error ? <p className="mt-1 text-xs text-del">{push.error}</p> : null}
			{push.enabled ? (
				<button
					type="button"
					onClick={() => void push.test()}
					disabled={push.busy}
					className="mt-1.5 text-xs text-muted underline-offset-2 hover:underline disabled:opacity-50"
				>
					Send a test notification
				</button>
			) : null}
		</div>
	)
}
