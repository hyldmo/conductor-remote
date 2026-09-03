function planWords(plan: string): string {
	return plan.replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase())
}

/** Provider plan ids are machine-shaped; keep the common ones readable on a phone. */
export function planName(plan: string): string {
	const known: Record<string, string> = {
		free: 'Free',
		go: 'Go',
		plus: 'Plus',
		pro: 'Pro',
		prolite: 'Pro Lite',
		max: 'Max',
		team: 'Team',
		business: 'Business',
		enterprise: 'Enterprise',
		edu: 'Education',
		self_serve_business_usage_based: 'Business',
		enterprise_cbp_usage_based: 'Enterprise'
	}
	return known[plan] ?? planWords(plan)
}

/** Stable clock copy for every provider's reset timestamp. */
export function resetLabel(resetsAt: number | null, now = Date.now()): string {
	if (resetsAt === null) return 'Reset time unavailable'
	const remaining = resetsAt - now
	if (remaining > 0 && remaining < 60 * 60 * 1000) return `Resets in ${Math.max(1, Math.round(remaining / 60_000))}m`
	if (remaining > 0 && remaining < 24 * 60 * 60 * 1000)
		return `Resets in ${Math.max(1, Math.round(remaining / 3_600_000))}h`
	return `Resets ${new Date(resetsAt).toLocaleString([], {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit'
	})}`
}
