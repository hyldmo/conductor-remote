import type { z } from 'zod'

/** Invalid caller input, distinguished from failures inside the relay. */
export class InputError extends Error {}

export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
	const result = schema.safeParse(input)
	if (result.success) return result.data
	throw new InputError(
		result.error.issues
			.map(issue => {
				const message =
					issue.code === 'unrecognized_keys'
						? `unknown ${issue.keys.length === 1 ? 'field' : 'fields'}: ${issue.keys.join(', ')}`
						: issue.message
				return issue.path.length ? `${issue.path.join('.')}: ${message}` : message
			})
			.join('; ')
	)
}
