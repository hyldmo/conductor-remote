/** Durable role identity shown on a tab even after its successful job file is gone. */
export function RoleChip({ name }: { name: string }) {
	return (
		<span className="max-w-20 shrink-0 truncate rounded bg-accent/10 px-1 py-0.5 font-mono text-[9px] uppercase tracking-wide text-accent">
			{name}
		</span>
	)
}
