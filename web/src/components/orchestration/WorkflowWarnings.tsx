import { AlertTriangle, Loader2, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useConfirmUiStable } from '../../hooks/workflows.ts'
import { cn } from '../../lib/cn.ts'
import type { UiQuarantineWire } from '../../lib/types.ts'

/**
 * Relay-wide safety hold, intentionally separate from a Workflow card: its
 * originating run may already be cancelled while the shared Conductor window
 * still needs a human stability acknowledgement.
 */
export function UiQuarantineBanner({ quarantine, className }: { quarantine?: UiQuarantineWire; className?: string }) {
	const confirmUiStable = useConfirmUiStable()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	if (!quarantine) return null

	const confirm = async () => {
		if (busy) return
		setBusy(true)
		setError(null)
		try {
			await confirmUiStable(quarantine)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		} finally {
			setBusy(false)
		}
	}

	return (
		<section
			aria-label="Conductor UI safety hold"
			role="alert"
			className={cn('shrink-0 border-b border-del/40 bg-del/10 px-3 py-2.5 text-xs', className)}
		>
			<div className="flex items-start gap-2">
				<AlertTriangle size={16} className="mt-0.5 shrink-0 text-del" />
				<div className="min-w-0 flex-1">
					<div className="font-semibold text-del">Automated Conductor UI writes are paused</div>
					<p className="mt-0.5 text-text">{quarantine.reason}</p>
					<p className="mt-1 text-muted">
						Inspect Conductor on your Mac. Continue only when its window is stable and no UI action is still in flight.
					</p>
					<div className="mt-1 flex min-w-0 flex-wrap gap-x-2 text-[10px] text-faint">
						<span>{new Date(quarantine.createdAt).toLocaleString()}</span>
						{quarantine.actionId ? <span className="max-w-full truncate">Action · {quarantine.actionId}</span> : null}
						{quarantine.effectId ? <span className="max-w-full truncate">Effect · {quarantine.effectId}</span> : null}
					</div>
					<button
						type="button"
						disabled={busy}
						onClick={() => void confirm()}
						className="mt-2 flex min-h-9 items-center gap-1.5 rounded-lg bg-del px-3 py-1.5 font-semibold text-white disabled:opacity-50"
					>
						{busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}I checked — Conductor is
						stable
					</button>
					{error ? (
						<p className="mt-1.5 text-del" role="alert">
							{error}
						</p>
					) : null}
				</div>
			</div>
		</section>
	)
}

/** Workflow must fail visibly when its durable state cannot be opened safely. */
export function WorkflowWarningBanner({ warning }: { warning?: string }) {
	if (!warning) return null
	return (
		<section
			aria-label="Workflow unavailable"
			role="alert"
			className="shrink-0 border-b border-del/40 bg-del/10 px-3 py-2.5 text-xs"
		>
			<div className="flex items-start gap-2">
				<AlertTriangle size={16} className="mt-0.5 shrink-0 text-del" />
				<div className="min-w-0">
					<div className="font-semibold text-del">Workflow is unavailable</div>
					<p className="mt-0.5 text-text">{warning}</p>
				</div>
			</div>
		</section>
	)
}
