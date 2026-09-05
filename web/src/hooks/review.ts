import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { client } from '../lib/api.ts'
import { useOnline } from './browser.ts'

/**
 * The worktree's previewable file list, used by the All-files review rail and to turn
 * a file an agent named in prose into a link (`web/src/lib/fileMentions.ts`).
 *
 * Normally polled by nothing: a message says `src/foo.ts` about a file that already exists,
 * and a file created a minute ago is picked up the next time this goes stale. The all-files
 * review mode is the exception and opts into polling while open. It matters that the
 * array identity holds still across those refetches — every inline code span in the chat
 * reads the resolver built from it, so a new array on each poll would re-render all of them
 * for nothing. React Query's structural sharing is what keeps it, and the long `staleTime`
 * is what makes the ordinary mention-link question rare in the first place.
 */
export function useWorkspaceFiles(workspaceId: string | undefined, enabled: boolean, poll = false) {
	return useQuery({
		queryKey: ['workspaceFiles', workspaceId],
		queryFn: () => client.workspaceFiles(workspaceId as string),
		enabled: enabled && !!workspaceId,
		staleTime: 120_000,
		refetchInterval: poll ? 5000 : false,
		retry: false
	})
}

/** The Conductor Run choices and their configured tailnet-only preview URLs. */
export function useDevServer(workspaceId: string | undefined) {
	return useQuery({
		queryKey: ['dev-server', workspaceId],
		queryFn: () => client.devServer(workspaceId as string),
		enabled: !!workspaceId,
		refetchInterval: 2500
	})
}

export function useDiff(workspaceId: string | undefined, enabled: boolean) {
	const report = useOnline()
	const query = useQuery({
		queryKey: ['diff', workspaceId],
		queryFn: () => client.diff(workspaceId as string),
		enabled: enabled && !!workspaceId,
		refetchInterval: 5000
	})
	useEffect(() => {
		if (query.isError) report(false, query.error)
	}, [query.isError, query.error, report])
	return query
}

/** A selected file's complete patch when the bounded workspace response omitted it. */
export function useFileDiff(workspaceId: string | undefined, filePath: string | null, enabled: boolean) {
	return useQuery({
		queryKey: ['fileDiff', workspaceId, filePath],
		queryFn: () => client.fileDiff(workspaceId as string, filePath as string),
		enabled: enabled && !!workspaceId && !!filePath,
		refetchInterval: 5000,
		retry: false
	})
}

/** A source file selected from the workspace rail, refreshed while it stays on screen. */
export function useFilePreview(reference: string | null, enabled: boolean) {
	return useQuery({
		queryKey: ['filePreview', reference],
		queryFn: () => client.filePreview(reference as string),
		enabled: enabled && !!reference,
		refetchInterval: 5000,
		retry: false
	})
}
