import { X } from 'lucide-react'
import type { ReactNode } from 'react'

/** Shared chrome for source previews and the in-chat diff viewer. */
export function ViewerHeader({
	title,
	subtitle,
	actions,
	onClose,
	closeLabel
}: {
	title: ReactNode
	subtitle?: ReactNode
	actions?: ReactNode
	onClose: () => void
	closeLabel: string
}) {
	return (
		<header className="flex shrink-0 items-center gap-3 border-b border-border-soft bg-bg px-4 py-3">
			<div className="min-w-0 flex-1">
				<h2 className="text-base font-semibold">{title}</h2>
				{subtitle ? <p className="truncate font-mono text-xs text-muted">{subtitle}</p> : null}
			</div>
			{actions}
			<button
				type="button"
				onClick={onClose}
				aria-label={closeLabel}
				className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent active:bg-surface-2"
			>
				<X size={18} />
			</button>
		</header>
	)
}
