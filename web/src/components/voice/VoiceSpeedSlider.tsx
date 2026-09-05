import { type KeyboardEvent, useId } from 'react'
import { cn } from '../../lib/cn.ts'
import { VOICE_SPEED_STEP } from '../../lib/voice/connection.ts'
import './voice-speed.css'

const MIN_SPEED = 0.25
const MAX_SPEED = 1.5
const MARKS = Array.from({ length: Math.round((MAX_SPEED - MIN_SPEED) / VOICE_SPEED_STEP) + 1 }, (_, index) =>
	Number((MIN_SPEED + index * VOICE_SPEED_STEP).toFixed(2))
)
const position = (speed: number) => `${((speed - MIN_SPEED) / (MAX_SPEED - MIN_SPEED)) * 100}%`
const speedLabel = (speed: number) => `${Number(speed.toFixed(2))}×`

export function VoiceSpeedSlider({ value: speed, onChange }: { value: number; onChange: (speed: number) => void }) {
	const id = useId()
	const chooseSpeed = (next: number) => onChange(Math.max(MIN_SPEED, Math.min(MAX_SPEED, Number(next.toFixed(2)))))
	const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		const increments: Record<string, number> = {
			ArrowRight: VOICE_SPEED_STEP,
			ArrowUp: VOICE_SPEED_STEP,
			ArrowLeft: -VOICE_SPEED_STEP,
			ArrowDown: -VOICE_SPEED_STEP,
			PageUp: 0.25,
			PageDown: -0.25
		}
		const increment = increments[event.key]
		if (event.key === 'Home') chooseSpeed(MIN_SPEED)
		else if (event.key === 'End') chooseSpeed(MAX_SPEED)
		else if (increment !== undefined) chooseSpeed(speed + increment)
		else return
		event.preventDefault()
	}

	return (
		<div className="col-span-2 mt-2 rounded-xl border border-border-soft bg-surface p-4 text-left">
			<div className="flex items-center justify-between gap-3">
				<label htmlFor={id} className="text-xs font-medium text-muted">
					Speech speed
				</label>
				<span
					aria-hidden="true"
					className="min-w-16 rounded-full bg-voice-soft px-2.5 py-1 text-center text-sm font-semibold tabular-nums text-voice"
				>
					{speedLabel(speed)}
				</span>
			</div>

			<div className="relative mt-2 h-11">
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-3 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-border"
				>
					<div className="absolute inset-y-0 left-0 rounded-full bg-voice" style={{ width: position(speed) }} />
					{MARKS.map((mark, index) => (
						<span
							key={mark}
							className={cn(
								'absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted',
								index % 5 === 0 ? 'size-1' : 'size-0.5 opacity-60',
								mark <= speed && 'bg-voice-soft'
							)}
							style={{ left: position(mark) }}
						/>
					))}
				</div>
				<input
					id={id}
					type="range"
					min={MIN_SPEED}
					max={MAX_SPEED}
					step={VOICE_SPEED_STEP}
					value={speed}
					onChange={event => chooseSpeed(event.currentTarget.valueAsNumber)}
					onKeyDown={onKeyDown}
					aria-valuetext={`${speed} times normal speed`}
					className="voice-speed-range"
				/>
			</div>
			<div aria-hidden="true" className="flex justify-between px-0.5 text-[11px] text-muted">
				<span>0.25× · Slower</span>
				<span>Faster · 1.5×</span>
			</div>
		</div>
	)
}
