import { Check } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '../lib/cn.ts'
import { type Command, formatShortcut } from '../lib/commands.ts'

/**
 * The palette's action rows, above the chat results in the search sheet.
 *
 * Two shapes. Browsing (no query, or a `>` query) draws one section per group, headed
 * by the group's name, so the list reads as the menus it replaces: Workspace, View,
 * App. Searching draws one "Actions" section and puts the group on the row as a
 * breadcrumb ("View › Hide merged"), because a hit from three groups at once needs to
 * say where each came from.
 *
 * Rows are real buttons carrying `data-palette-row`, which is all the sheet's arrow
 * keys need: focus moves between rows, Enter is the button's own click, and a screen
 * reader hears a menu item with a checked state where there is one.
 *
 * The key caps are hidden on narrow screens. A phone without a keyboard has nothing
 * to press, and "⌘K" beside every row is noise on the one screen where width is short.
 */
export function CommandResults({
	commands,
	grouped,
	apple,
	onRun
}: {
	commands: Command[]
	grouped: boolean
	/** Draw ⌘ rather than Ctrl. */
	apple: boolean
	onRun: (command: Command) => void
}) {
	if (!commands.length) return null
	const sections = grouped ? groupSections(commands) : [{ label: 'Actions', commands }]
	return (
		<div className="flex flex-col gap-2 pb-2">
			{sections.map(section => (
				<section key={section.label} aria-label={section.label}>
					<PaletteHeading>{section.label}</PaletteHeading>
					<div role="menu" aria-label={section.label} className="flex flex-col">
						{section.commands.map(command => (
							<CommandRow key={command.id} command={command} apple={apple} breadcrumb={!grouped} onRun={onRun} />
						))}
					</div>
				</section>
			))}
		</div>
	)
}

/** One heading style for every section of the sheet, actions and chats alike. */
export function PaletteHeading({ children }: { children: ReactNode }) {
	return <h3 className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{children}</h3>
}

function groupSections(commands: Command[]): { label: string; commands: Command[] }[] {
	const sections = new Map<string, Command[]>()
	for (const command of commands) {
		const label = command.group ?? 'Actions'
		const section = sections.get(label)
		if (section) section.push(command)
		else sections.set(label, [command])
	}
	return [...sections].map(([label, list]) => ({ label, commands: list }))
}

export function CommandRow({
	command,
	apple,
	breadcrumb,
	onRun
}: {
	command: Command
	apple: boolean
	breadcrumb: boolean
	onRun: (command: Command) => void
}) {
	const Icon = command.icon
	const toggle = command.checked !== undefined
	return (
		<button
			type="button"
			{...(toggle ? { role: 'menuitemcheckbox', 'aria-checked': !!command.checked } : { role: 'menuitem' })}
			data-palette-row=""
			onClick={() => onRun(command)}
			className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left text-sm text-text focus-visible:bg-surface-2 focus-visible:outline-none active:bg-surface-2"
		>
			{Icon ? (
				<Icon size={16} className="shrink-0 text-muted" aria-hidden />
			) : (
				<span className="size-4 shrink-0" aria-hidden />
			)}
			<span className="min-w-0 flex-1 truncate">
				{breadcrumb && command.group ? <span className="text-muted">{command.group} › </span> : null}
				{command.label}
				{command.detail ? <span className="ml-2 text-xs text-faint">{command.detail}</span> : null}
			</span>
			{command.shortcut ? <KeyCaps parts={formatShortcut(command.shortcut, apple)} /> : null}
			{toggle ? <CheckMark checked={!!command.checked} /> : null}
		</button>
	)
}

function KeyCaps({ parts }: { parts: string[] }) {
	return (
		<span className="hidden shrink-0 items-center gap-0.5 md:flex">
			{parts.map(part => (
				<kbd
					key={part}
					className="min-w-5 rounded border border-border bg-surface-2 px-1 py-0.5 text-center font-sans text-[11px] text-muted"
				>
					{part}
				</kbd>
			))}
		</span>
	)
}

/** The same square the repo filter draws, so "on" reads the same in both lists. */
function CheckMark({ checked }: { checked: boolean }) {
	return (
		<span
			aria-hidden
			className={cn(
				'flex size-4 shrink-0 items-center justify-center rounded border',
				checked ? 'border-accent bg-accent text-on-solid' : 'border-faint bg-surface'
			)}
		>
			{checked ? <Check size={12} strokeWidth={3} /> : null}
		</span>
	)
}
