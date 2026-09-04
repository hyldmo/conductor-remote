import { Workflow } from 'lucide-react'
import { cn } from '../lib/cn.ts'
import { BetaBadge } from './BetaBadge.tsx'

/** The reversible first-message mode switch; all agent controls around it may be disabled. */
export function WorkflowModePill({ active, onChange }: { active: boolean; onChange: (active: boolean) => void }) {
	return (
		<button
			type="button"
			onClick={() => onChange(!active)}
			title="Run this task through your configured delegated roles"
			aria-label={`Workflow mode ${active ? 'on' : 'off'}`}
			aria-pressed={active}
			className={cn(
				'flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-[13px] font-medium text-muted transition active:bg-surface-2 active:text-text',
				active && 'bg-accent/10 text-accent'
			)}
		>
			<Workflow size={15} />
			<span>Workflow</span>
			<BetaBadge className="-mr-0.5" />
		</button>
	)
}
