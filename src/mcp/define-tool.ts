import { z } from 'zod'
import { parseInput } from '../contracts/validation.ts'
import type { Tool } from './types.ts'

/** Export the caller's input shape and validate it before the tool can make an HTTP call. */
export function defineTool<S extends z.ZodObject>(definition: {
	name: string
	description: string
	inputSchema: S
	run: (args: z.output<S>) => Promise<string>
}): Tool {
	const { inputSchema, run, ...metadata } = definition
	return {
		...metadata,
		inputSchema: z.toJSONSchema(inputSchema, { io: 'input' }),
		run: async args => run(parseInput(inputSchema, args))
	}
}
