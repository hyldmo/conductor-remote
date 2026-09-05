import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ApiError, client } from '../lib/api.ts'
import { useApp } from '../store.ts'
import { useOnline } from './browser.ts'

export function useWorkspaces() {
	const report = useOnline()
	const setUpdate = useApp(s => s.setUpdate)
	const query = useQuery({
		queryKey: ['state'],
		queryFn: () => client.state(),
		refetchInterval: 2500
	})
	useEffect(() => {
		if (query.isSuccess) {
			report(true)
			setUpdate(query.data.update ?? null)
		}
		if (query.isError) report(false, query.error)
	}, [query.isSuccess, query.isError, query.error, query.data, report, setUpdate])
	return query
}

/** All (non-hidden) sessions in a workspace — the desktop app's "tabs". */
/** Repos Conductor knows about — static enough to fetch once per app load. */
export function useRepos() {
	return useQuery({ queryKey: ['repos'], queryFn: () => client.repos(), staleTime: 60_000 })
}

/**
 * One workspace by id, whatever state it is in — the read that opens an archived chat.
 *
 * Not polled, and not merged into the `['state']` cache: this answers for workspaces
 * `/api/state` deliberately leaves out, and an archived one cannot change. The state
 * poll is still what notices if it comes *back* — an unarchived workspace reappears in
 * the live list and the caller stops needing this at all.
 */
export function useAnyWorkspace(workspaceId: string | undefined, enabled: boolean) {
	const report = useOnline()
	const query = useQuery({
		queryKey: ['workspace', workspaceId],
		queryFn: () => client.workspace(workspaceId as string),
		enabled: enabled && !!workspaceId,
		staleTime: Number.POSITIVE_INFINITY,
		// A 404 is this route's real answer for a stale link, so it is not worth a retry.
		retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 1
	})
	useEffect(() => {
		// 404 means the relay answered — the workspace is gone. Reporting that as offline
		// would raise the red strip for two seconds over a link that is simply dead.
		if (query.isError && !(query.error instanceof ApiError && query.error.status === 404)) report(false, query.error)
	}, [query.isError, query.error, report])
	return query
}

/** All visible chats in a workspace; `poll: false` for an archived workspace's static tab list. */
export function useSessions(workspaceId: string | undefined, poll = true) {
	const report = useOnline()
	const query = useQuery({
		queryKey: ['sessions', workspaceId],
		queryFn: () => client.sessions(workspaceId as string),
		enabled: !!workspaceId,
		refetchInterval: poll ? 2000 : false
	})
	useEffect(() => {
		if (query.isError) report(false, query.error)
	}, [query.isError, query.error, report])
	return query
}

/**
 * A repo's icon as an object URL, fetched with the auth header so the token stays out of the image URL
 * (query strings can leak into proxy/Funnel logs). Deduped and cached for the session across every card
 * that shares the repo — icons rarely change, so it never refetches or revokes within a session.
 */
export function useRepoIcon(repoName: string | null | undefined) {
	return useQuery({
		queryKey: ['repoIcon', repoName],
		queryFn: () => client.repoIcon(repoName as string),
		enabled: !!repoName,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: false
	})
}
