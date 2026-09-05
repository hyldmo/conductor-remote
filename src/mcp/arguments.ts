export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function need(args: Record<string, unknown>, key: string): string {
	const v = str(args[key])
	if (!v) throw new Error(`${key} is required`)
	return v
}

export function rejectUnknown(args: Record<string, unknown>, allowed: readonly string[]): void {
	const accepted = new Set(allowed)
	const unknown = Object.keys(args).filter(key => !accepted.has(key))
	if (unknown.length) throw new Error(`unknown ${unknown.length === 1 ? 'field' : 'fields'}: ${unknown.join(', ')}`)
}
