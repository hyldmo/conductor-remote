import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Keep either dropdown inside a narrow phone viewport and outside the transcript's clipping scroller. */
export function TranscriptMenu({
	label,
	anchor,
	onClose,
	children
}: {
	label: string
	anchor: RefObject<HTMLButtonElement | null>
	onClose: () => void
	children: ReactNode
}) {
	const menu = useRef<HTMLDivElement>(null)
	const [position, setPosition] = useState({ top: 0, left: 0 })
	useLayoutEffect(() => {
		const trigger = anchor.current?.getBoundingClientRect()
		const bounds = menu.current?.getBoundingClientRect()
		if (!trigger || !bounds) return
		const above = trigger.top - bounds.height - 4
		setPosition({
			top: Math.max(8, above >= 8 ? above : Math.min(trigger.bottom + 4, window.innerHeight - bounds.height - 8)),
			left: Math.max(8, Math.min(trigger.left, window.innerWidth - bounds.width - 8))
		})
		menu.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus({ preventScroll: true })
	}, [anchor])
	useEffect(() => {
		const dismiss = (event: Event) => {
			if (event.target instanceof Node && menu.current?.contains(event.target)) return
			onClose()
		}
		window.addEventListener('resize', dismiss)
		document.addEventListener('scroll', dismiss, true)
		return () => {
			window.removeEventListener('resize', dismiss)
			document.removeEventListener('scroll', dismiss, true)
		}
	}, [onClose])
	const close = () => {
		onClose()
		anchor.current?.focus({ preventScroll: true })
	}
	return createPortal(
		<>
			<div className="fixed inset-0 z-40" onClick={close} aria-hidden />
			<div
				ref={menu}
				role="menu"
				aria-label={label}
				style={position}
				onKeyDown={event => {
					if (event.key === 'Escape' || event.key === 'Tab') {
						if (event.key === 'Escape') event.preventDefault()
						close()
						return
					}
					const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]'))
					const current = items.indexOf(document.activeElement as HTMLElement)
					const next = {
						ArrowDown: (current + 1) % items.length,
						ArrowUp: (current - 1 + items.length) % items.length,
						Home: 0,
						End: items.length - 1
					}[event.key]
					if (next === undefined) return
					event.preventDefault()
					items[next]?.focus()
				}}
				className="fixed z-50 max-h-[calc(100dvh-1rem)] w-60 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface py-1 shadow-xl"
			>
				{children}
			</div>
		</>,
		document.body
	)
}

export interface TranscriptCut {
	thinking: boolean
	tools: boolean
	only?: boolean
}

export function TranscriptOptions({ onSelect }: { onSelect: (cut: TranscriptCut) => void }) {
	return (
		<>
			<TranscriptOption
				label="Last message only"
				detail="This response, without history"
				onClick={() => onSelect({ thinking: false, tools: false, only: true })}
			/>
			<TranscriptOption
				label="Concise"
				detail="Messages only"
				onClick={() => onSelect({ thinking: false, tools: false })}
			/>
			<TranscriptOption
				label="With reasoning"
				detail="Messages and reasoning"
				onClick={() => onSelect({ thinking: true, tools: false })}
			/>
			<TranscriptOption
				label="Full transcript"
				detail="Messages, reasoning, and tools"
				onClick={() => onSelect({ thinking: true, tools: true })}
			/>
		</>
	)
}

function TranscriptOption({ label, detail, onClick }: { label: string; detail: string; onClick: () => void }) {
	return (
		<button
			type="button"
			role="menuitem"
			onClick={onClick}
			className="flex w-full flex-col px-3 py-2 text-left active:bg-surface-2"
		>
			<span className="text-[12px] font-medium text-text">{label}</span>
			<span className="text-[11px] text-faint">{detail}</span>
		</button>
	)
}
