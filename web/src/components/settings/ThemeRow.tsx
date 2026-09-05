import { FileDiff, SunMoon } from 'lucide-react'
import { useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { readThemePreference, type ThemePreference, writeThemePreference } from '../../lib/theme.ts'
import { useApp } from '../../store.ts'

const THEMES: [ThemePreference, string][] = [
	['system', 'System'],
	['light', 'Light'],
	['dark', 'Dark']
]

/** This device's appearance; it stays local rather than following another connected phone. */
export function ThemeRow() {
	const [theme, setTheme] = useState(readThemePreference)
	const showDiffs = useApp(s => s.view.showDiffs)
	const setView = useApp(s => s.setView)
	const choose = (next: ThemePreference) => {
		setTheme(next)
		writeThemePreference(next)
	}

	return (
		<div className="w-full shrink-0 rounded-xl border border-border bg-surface-2 px-3 py-2.5">
			<fieldset className="flex w-full items-center justify-between gap-3 border-0 p-0">
				<legend className="sr-only">Theme</legend>
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<SunMoon size={16} className="shrink-0 text-muted" />
					<span>Theme</span>
				</div>
				<div className="flex shrink-0 rounded-lg border border-border bg-surface p-0.5">
					{THEMES.map(([value, label]) => (
						<button
							key={value}
							type="button"
							aria-pressed={theme === value}
							onClick={() => choose(value)}
							className={cn(
								'rounded-md px-2 py-1 text-xs transition focus-visible:outline-2 focus-visible:outline-accent',
								theme === value ? 'bg-accent-soft text-accent' : 'text-muted active:bg-surface-2'
							)}
						>
							{label}
						</button>
					))}
				</div>
			</fieldset>
			<div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border pt-2.5">
				<div className="flex min-w-0 items-center gap-2 text-sm">
					<FileDiff size={16} className="shrink-0 text-muted" />
					<span>Sidebar diffs</span>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={showDiffs}
					aria-label="Show line changes in workspace rows"
					onClick={() => setView({ showDiffs: !showDiffs })}
					className={cn(
						'relative h-6 w-11 shrink-0 rounded-full transition-colors',
						showDiffs ? 'bg-accent' : 'border border-border bg-surface'
					)}
				>
					<span
						className={cn(
							'absolute left-0.5 top-0.5 size-5 rounded-full bg-white transition-transform',
							showDiffs ? 'translate-x-5' : 'translate-x-0'
						)}
					/>
				</button>
			</div>
			<p className="mt-1 text-xs text-muted">Show line additions and deletions in workspace rows.</p>
		</div>
	)
}
