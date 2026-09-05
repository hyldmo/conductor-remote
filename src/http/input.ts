import { InputError } from '../contracts/validation.ts'

export function parseJsonBody(text: string): unknown {
	try {
		return JSON.parse(text || '{}')
	} catch {
		throw new InputError('request body must be valid JSON')
	}
}
