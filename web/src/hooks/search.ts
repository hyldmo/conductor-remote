import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { client } from '../lib/api.ts'

/**
 * Search workspace names and chat transcripts (src/search/coordinator.ts).
 *
 * Not polled: the answer only changes when the query does, and a phone typing into
 * a search box is already making enough requests. `keepPreviousData` is what stops
 * the list blanking between keystrokes — a result flashing away and back reads as a
 * broken search, and on a phone it also moves the row under your thumb.
 *
 * Two characters is the floor. One letter matches thousands of chunks, so it costs
 * a real query to return a list nobody wants.
 */
export function useSearch(query: string, repos: string[] = [], includeArchived = true) {
	const trimmed = query.trim()
	return useQuery({
		queryKey: ['search', trimmed, repos, includeArchived],
		queryFn: () => client.search(trimmed, repos, includeArchived),
		enabled: trimmed.length >= 2,
		staleTime: 30_000,
		placeholderData: keepPreviousData
	})
}
