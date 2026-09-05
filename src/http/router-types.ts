import type { IncomingMessage, ServerResponse } from 'node:http'

/** Distinguishes an unmatched route from a handled streaming or empty response. */
export const NOT_HANDLED = Symbol('route not handled')
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<unknown>
