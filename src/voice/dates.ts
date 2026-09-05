/** Named days use the Mac's calendar, shared by workspace and call-history filters. */
export function parseVoiceDate(value: string, now: number, field: string): number {
	const normalized = value.trim().toLowerCase()
	if (
		normalized === 'today' ||
		normalized === 'yesterday' ||
		normalized === 'this-week' ||
		normalized === 'this-month'
	) {
		const current = new Date(now)
		const boundary = new Date(current.getFullYear(), current.getMonth(), current.getDate())
		if (normalized === 'yesterday') boundary.setDate(boundary.getDate() - 1)
		if (normalized === 'this-week') {
			const daysSinceMonday = (boundary.getDay() + 6) % 7
			boundary.setDate(boundary.getDate() - daysSinceMonday)
		}
		if (normalized === 'this-month') boundary.setDate(1)
		return boundary.getTime()
	}
	const relative = /^(\d+)(h|d|w)$/.exec(normalized)
	if (relative) {
		const amount = Number(relative[1])
		const unit = relative[2]
		const multiplier = unit === 'h' ? 60 * 60 * 1000 : unit === 'd' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
		if (amount > 0 && amount <= 10_000) return now - amount * multiplier
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
		const [year, month, day] = normalized.split('-').map(Number)
		const date = new Date(year, month - 1, day)
		if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date.getTime()
	}
	const parsed = Date.parse(value)
	if (Number.isFinite(parsed)) return parsed
	throw new Error(
		`${field} must be today, yesterday, this-week, this-month, a duration like 24h or 7d, or an ISO date/time`
	)
}
