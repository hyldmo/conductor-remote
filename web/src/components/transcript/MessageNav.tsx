import { ChevronDown, ChevronUp, List, X } from 'lucide-react'
import type { RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { relativeTime } from '../../lib/format.ts'
import { hasSelection } from '../../lib/selection.ts'

/**
 * Jump back to your own prompts.
 *
 * The first cut of this drew Conductor's minimap — tick marks down a scrollbar-thin
 * rail — and it was wrong for a thumb: 3px of ink is not a target, and a mark tells
 * you a message is *there* without telling you which one, so you scrub and read and
 * scrub again. What a phone wants is a control with a name on it.
 *
 * So: one pill above the composer. Its arrows step a prompt at a time, which is the
 * common case and needs no aim at all; its middle opens a sheet listing every prompt
 * with two lines of preview, which is the "which one was it?" case. The counter on
 * the pill (`3/12`) is the third thing — it says where you are without being asked.
 *
 * Two behaviours carry the rest:
 *
 * 1. **It wakes on a gesture that actually moves the view.** Waking on the `scroll`
 *    event alone would light it every time the agent streams a line, because the
 *    transcript auto-pins to the bottom — a control that blinks through a whole turn
 *    is worse than none. But waking on `touchmove`/`wheel` alone was wrong the other
 *    way: a long press to select text jitters enough to fire `touchmove` without
 *    moving anything, so the pill appeared under the very words being selected, over
 *    the callout bar, every time. So a gesture only arms the wake and the scroll it
 *    causes spends it, selected text blocks it outright, and once lit any scrolling
 *    keeps it lit — which covers iOS momentum running long after the finger left.
 *    At rest it's gone: no ink over the chat, nothing to mis-tap.
 * 2. **Positions are measured from the DOM, not from the entry list.** A step group
 *    opening, an image loading, a markdown table reflowing all move a message without
 *    changing the list, and the transcript is the one place where "how tall is it
 *    really" is the only honest answer. Hence `[data-user-msg]` + `getBoundingClientRect`,
 *    re-measured while awake (and never while asleep, so an idle chat costs nothing).
 */

/** How long the pill stays up after the last scroll — long enough to reach for it. */
const IDLE_MS = 1500
/** How long after a touch or wheel a scroll still counts as that person's doing. */
const GESTURE_MS = 400
/** Breathing room above the message we land on, so it isn't flush against the tab strip. */
const HEADROOM = 12
/** Below this there's nothing to navigate — one prompt is already on screen. */
const MIN_MARKS = 2
/** A prompt this close to the top of the view is the one you're reading. */
const AT_TOP = HEADROOM + 8
/** Slack on "we're at the end": subpixel heights and iOS rubber-band never land on it exactly. */
const END_SLACK = 2
/** The glide: every jump ends with about this much of a screen travelling under you. */
const APPROACH_VIEWPORTS = 1.1
/** Duration bounds. A hop shouldn't be instant; a long jump shouldn't be a wait. */
const MIN_SCROLL_MS = 200
const MAX_SCROLL_MS = 420
/** Milliseconds per pixel between those bounds — a longer glide takes a little longer. */
const MS_PER_PX = 0.6

type Mark = {
	top: number
	preview: string
	/** ISO timestamp, or null for a prompt that hasn't landed in the transcript yet. */
	ts: string | null
	/** `sending` / `queueing` for optimistic prompts, `queued` after acceptance. */
	state: string | null
	node: HTMLElement
}

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * The line a prompt has to sit above to count as the one you're reading.
 *
 * Just under the top of the view, until the scroll runs out. The last prompts of a chat
 * can never *reach* the top — there's no content left below to push them up — so the plain
 * rule pins the counter one short of the end (`12/13` with the 13th on screen) and leaves
 * the down arrow lit over a jump that can't move anything. At the end of the range the
 * line drops to the bottom of the view instead, so whatever is on screen counts.
 */
const readAnchor = (el: HTMLElement) =>
	el.scrollHeight - el.clientHeight - el.scrollTop <= END_SLACK ? el.scrollTop + el.clientHeight : el.scrollTop + AT_TOP

const sameMarks = (a: Mark[], b: Mark[]) =>
	a.length === b.length &&
	a.every((m, i) => m.top === b[i].top && m.preview === b[i].preview && m.state === b[i].state && m.ts === b[i].ts)

/**
 * Glide to `to`, and call `onArrive` when we get there.
 *
 * Two things `scrollTo({behavior:'smooth'})` won't do, and both matter here:
 *
 * - **A long jump skips its own middle.** Twelve screens of markdown animated past you
 *   is twelve screens the phone has to paint, for a stretch nobody reads. So anything
 *   past ~one screen teleports to a screen short of the target first and glides only
 *   that last stretch — every jump costs the same paint budget and arrives the same way,
 *   whether it moved 300px or 30,000.
 * - **The user can take it back.** A native smooth scroll ignores a finger landing
 *   mid-flight; this one stops dead, because a view that keeps moving after you grab it
 *   is the thing that makes people distrust a jump control.
 *
 * Returns its own canceller so a second jump can call off the first.
 */
function glideTo(el: HTMLElement, to: number, onArrive: () => void): () => void {
	const target = clamp(to, 0, el.scrollHeight - el.clientHeight)
	if (reduceMotion()) {
		el.scrollTop = target
		onArrive()
		return () => {}
	}

	const approach = el.clientHeight * APPROACH_VIEWPORTS
	if (Math.abs(target - el.scrollTop) > approach) {
		el.scrollTop = clamp(target + Math.sign(el.scrollTop - target) * approach, 0, el.scrollHeight - el.clientHeight)
	}

	const from = el.scrollTop
	const delta = target - from
	if (!delta) {
		onArrive()
		return () => {}
	}
	const duration = clamp(Math.abs(delta) * MS_PER_PX, MIN_SCROLL_MS, MAX_SCROLL_MS)
	const start = performance.now()
	let raf = 0
	let done = false

	const stop = () => {
		if (done) return
		done = true
		cancelAnimationFrame(raf)
		el.removeEventListener('touchstart', stop)
		el.removeEventListener('wheel', stop)
	}
	// Passive: we never prevent the gesture, we just get out of its way.
	el.addEventListener('touchstart', stop, { passive: true })
	el.addEventListener('wheel', stop, { passive: true })

	const tick = (now: number) => {
		const t = Math.min(1, (now - start) / duration)
		// Ease-out-quint: leaves fast, settles slowly, no overshoot.
		el.scrollTop = from + delta * (1 - (1 - t) ** 5)
		if (t < 1) {
			raf = requestAnimationFrame(tick)
			return
		}
		stop()
		onArrive()
	}
	raf = requestAnimationFrame(tick)
	return stop
}

export function MessageNav({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
	const [marks, setMarks] = useState<Mark[]>([])
	const [anchor, setAnchor] = useState(0)
	const [awake, setAwake] = useState(false)
	const [open, setOpen] = useState(false)

	// Refs shadow the state the listeners read, so a wake acts on what was just measured
	// rather than on last render's closure.
	const marksRef = useRef<Mark[]>([])
	const awakeRef = useRef(false)
	const openRef = useRef(false)
	const sleepTimer = useRef(0)
	const gestureAt = useRef(0)
	const frame = useRef(0)
	const cancelGlide = useRef<() => void>(() => {})

	const sleep = useCallback(() => {
		// The sheet outlives every reason to sleep; closing it re-arms them.
		if (openRef.current) return
		clearTimeout(sleepTimer.current)
		awakeRef.current = false
		setAwake(false)
	}, [])

	const wake = useCallback(() => {
		awakeRef.current = true
		setAwake(true)
		clearTimeout(sleepTimer.current)
		sleepTimer.current = window.setTimeout(sleep, IDLE_MS)
	}, [sleep])

	const measure = useCallback(() => {
		const el = scroller.current
		if (!el) return
		// Content-space offsets: rect-relative, so no positioned-ancestor assumptions.
		const base = el.getBoundingClientRect().top - el.scrollTop
		const next = Array.from(el.querySelectorAll<HTMLElement>('[data-user-msg]'), node => ({
			top: node.getBoundingClientRect().top - base,
			preview: node.dataset.userMsg ?? '',
			ts: node.dataset.msgTs ?? null,
			state: node.dataset.msgState ?? null,
			node
		}))
		marksRef.current = sameMarks(marksRef.current, next) ? marksRef.current : next
		setMarks(marksRef.current)
		setAnchor(readAnchor(el))
	}, [scroller])

	const schedule = useCallback(() => {
		if (frame.current) return
		frame.current = requestAnimationFrame(() => {
			frame.current = 0
			measure()
		})
	}, [measure])

	useEffect(() => {
		const el = scroller.current
		if (!el) return
		// A finger on the glass is not yet a scroll, so a gesture only arms the wake.
		const onGesture = () => {
			gestureAt.current = performance.now()
		}
		// A person moving the view is what reveals the pill — never the transcript
		// scrolling itself, or it would blink through every streamed message. Once up,
		// any scrolling keeps it up: momentum, and the jump we just made.
		const onScroll = () => {
			if (!awakeRef.current && performance.now() - gestureAt.current > GESTURE_MS) return
			if (hasSelection()) return
			wake()
			schedule()
		}
		// Selecting text is the phone's gesture, not ours: get out from under it.
		const onSelectionChange = () => {
			if (hasSelection()) sleep()
		}
		el.addEventListener('touchmove', onGesture, { passive: true })
		el.addEventListener('wheel', onGesture, { passive: true })
		el.addEventListener('scroll', onScroll, { passive: true })
		document.addEventListener('selectionchange', onSelectionChange)
		// Both observers only cost anything while the pill is on screen. The mutation one
		// is what catches a step group being opened under it.
		const whileAwake = () => {
			if (awakeRef.current) schedule()
		}
		const ro = new ResizeObserver(whileAwake)
		ro.observe(el)
		const mo = new MutationObserver(whileAwake)
		mo.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] })
		return () => {
			el.removeEventListener('touchmove', onGesture)
			el.removeEventListener('wheel', onGesture)
			el.removeEventListener('scroll', onScroll)
			document.removeEventListener('selectionchange', onSelectionChange)
			ro.disconnect()
			mo.disconnect()
			cancelGlide.current()
			if (frame.current) cancelAnimationFrame(frame.current)
			clearTimeout(sleepTimer.current)
		}
	}, [scroller, wake, sleep, schedule])

	const jumpTo = (i: number) => {
		const el = scroller.current
		const mark = marksRef.current[i]
		if (!(el && mark)) return
		// Tapping through the list shouldn't leave two glides fighting over one scrollTop.
		cancelGlide.current()
		cancelGlide.current = glideTo(el, mark.top - HEADROOM, () => {
			// Flash on arrival, not on departure: it's the "you're here" and it has to land
			// with you. Reduced motion skips it — the jump was instant, nothing to catch up on.
			if (reduceMotion()) return
			mark.node.firstElementChild?.animate(
				[{ boxShadow: '0 0 0 2px var(--color-accent)' }, { boxShadow: '0 0 0 2px transparent' }],
				{ duration: 700, easing: 'ease-out' }
			)
		})
		wake()
	}

	const close = useCallback(() => {
		openRef.current = false
		setOpen(false)
		wake()
	}, [wake])

	if (marks.length < MIN_MARKS) return null

	// Which prompt you're reading: the last one above the anchor line. Above the first one
	// there's no current, so `next` is the first rather than the second.
	let current = -1
	for (let i = 0; i < marks.length; i++) if (marks[i].top <= anchor) current = i
	const prev = current > 0 ? current - 1 : null
	const next = current + 1 < marks.length ? current + 1 : null
	const show = awake || open

	return (
		<>
			<div
				className={cn(
					'pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-3 transition duration-200 ease-out motion-reduce:transition-none',
					show ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0'
				)}
			>
				{/* Opaque, not translucent: it floats over prose, and 95%-plus-a-blur reads as a
				    smudge where a solid chip reads as a control. A keyboard never fires the
				    gestures that reveal it, so focus reveals it too — otherwise Tab lands on a
				    control nobody can see. */}
				<nav
					aria-label="Jump to your messages"
					onFocus={wake}
					className={cn(
						'flex h-12 items-stretch overflow-hidden rounded-full border border-border bg-surface-2 shadow-lg shadow-black/60',
						show ? 'pointer-events-auto' : 'pointer-events-none'
					)}
				>
					<Step dir="up" onClick={() => prev !== null && jumpTo(prev)} disabled={prev === null} />
					<button
						type="button"
						onClick={() => {
							measure()
							openRef.current = true
							setOpen(true)
							wake()
						}}
						aria-haspopup="dialog"
						aria-expanded={open}
						aria-label={`Your messages — ${marks.length} in this chat`}
						className="flex items-center gap-1.5 border-border-soft border-x px-3.5 text-muted transition active:bg-surface active:text-text focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
					>
						<List size={16} className="shrink-0" />
						<span className="font-mono text-[13px] tabular-nums">
							<span className="text-text">{current + 1 || '–'}</span>
							<span className="text-muted">/{marks.length}</span>
						</span>
					</button>
					<Step dir="down" onClick={() => next !== null && jumpTo(next)} disabled={next === null} />
				</nav>
			</div>

			{open ? (
				<MessageSheet
					marks={marks}
					current={current}
					onPick={i => {
						close()
						jumpTo(i)
					}}
					onClose={close}
				/>
			) : null}
		</>
	)
}

/**
 * The row's right edge: when it was sent, or why it hasn't been. A prompt that failed
 * says so here — it's the one you're most likely to be hunting for, and finding it as
 * an ordinary grey timestamp would be a lie.
 */
function RowMeta({ mark }: { mark: Mark }) {
	if (mark.state === 'failed') return <span className="shrink-0 text-[11px] text-del">didn’t send</span>
	const label =
		mark.state === 'sending'
			? 'sending…'
			: mark.state === 'queueing'
				? 'queueing…'
				: mark.state === 'queued'
					? 'queued'
					: mark.ts && relativeTime(mark.ts)
	if (!label) return null
	return <span className="shrink-0 text-[11px] text-muted tabular-nums">{label}</span>
}

/** One arrow of the pill: a 48px target, dimmed and inert at either end of the chat. */
function Step({ dir, onClick, disabled }: { dir: 'up' | 'down'; onClick: () => void; disabled: boolean }) {
	const Icon = dir === 'up' ? ChevronUp : ChevronDown
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={dir === 'up' ? 'Jump to your previous message' : 'Jump to your next message'}
			className="flex w-12 items-center justify-center text-muted transition active:bg-surface active:text-text disabled:text-faint/40 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
		>
			<Icon size={19} />
		</button>
	)
}

/**
 * The list. A sheet rather than a popover because it's the app's existing vocabulary for
 * "pick one of these" (ConnectSheet, LogsSheet) and because a row you can read two lines
 * of needs the width. Rows are real buttons, so this is also the keyboard path the rail
 * never had.
 */
function MessageSheet({
	marks,
	current,
	onPick,
	onClose
}: {
	marks: Mark[]
	current: number
	onPick: (i: number) => void
	onClose: () => void
}) {
	const panel = useRef<HTMLDivElement>(null)
	const currentRow = useRef<HTMLButtonElement>(null)

	// Open on the message you're reading, not on the top of a list you have to scroll.
	// Focus the panel rather than the row: a row focused programmatically draws a ring
	// on touch, where a phone user hasn't asked for one.
	useEffect(() => {
		panel.current?.focus({ preventScroll: true })
		currentRow.current?.scrollIntoView({ block: 'center' })
	}, [])

	return (
		<>
			{/* Tap-to-dismiss surface. Keyboard gets Escape and the close button, so it stays hidden. */}
			<div className="fixed inset-0 z-50 bg-black/60" onClick={onClose} aria-hidden />
			<div
				ref={panel}
				role="dialog"
				aria-modal="true"
				aria-label="Your messages"
				tabIndex={-1}
				onKeyDown={e => e.key === 'Escape' && onClose()}
				className="fade-in pb-safe fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[70%] max-w-md flex-col rounded-t-3xl border border-border-soft bg-surface shadow-xl outline-none md:mb-6 md:rounded-3xl"
			>
				<header className="flex shrink-0 items-center gap-2 border-b border-border-soft px-4 py-2.5">
					<h2 className="flex-1 text-[15px] font-semibold">Your messages</h2>
					<span className="font-mono text-[12px] text-faint tabular-nums">{marks.length}</span>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="-mr-2 flex size-11 items-center justify-center rounded-full text-muted transition active:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2"
					>
						<X size={19} />
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
					{marks.map((m, i) => (
						<button
							key={m.top}
							ref={i === current ? currentRow : undefined}
							type="button"
							onClick={() => onPick(i)}
							aria-current={i === current ? 'true' : undefined}
							className={cn(
								// Centred, not top-aligned: a one-line prompt in a 56px row would
								// otherwise hang from the top with its own number floating beside it.
								'flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition active:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
								i === current && 'bg-surface-2/60'
							)}
						>
							<span
								className={cn(
									'w-5 shrink-0 text-right font-mono text-[11px] tabular-nums',
									i === current ? 'text-accent' : 'text-muted'
								)}
							>
								{i + 1}
							</span>
							<span className="line-clamp-2 min-w-0 flex-1 text-[13.5px] leading-snug text-text [overflow-wrap:anywhere]">
								{m.preview || 'Empty message'}
							</span>
							<RowMeta mark={m} />
						</button>
					))}
				</div>
			</div>
		</>
	)
}
