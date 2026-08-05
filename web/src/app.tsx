import { useRef } from 'react'
import { Navigate, Outlet, Route, Routes, useMatch } from 'react-router'
import { ReloadPrompt } from './components/ReloadPrompt.tsx'
import { SessionView } from './components/SessionView.tsx'
import { TokenGate } from './components/TokenGate.tsx'
import { WorkspaceList } from './components/WorkspaceList.tsx'
import { useEdgeSwipeDrawer, usePushRouting, usePushSync, useVisualViewportHeight } from './hooks.ts'
import { cn } from './lib/cn.ts'
import { useApp } from './store.ts'

export function App() {
	useVisualViewportHeight()
	const token = useApp(s => s.token)
	// ReloadPrompt sits above the token gate so SW updates apply on every screen.
	return (
		<>
			<ReloadPrompt />
			{!token ? (
				<TokenGate />
			) : (
				<Routes>
					<Route element={<Shell />}>
						<Route index element={<HomePane />} />
						<Route path="/w/:workspaceId" element={<SessionView />} />
					</Route>
					<Route path="*" element={<Navigate to="/" replace />} />
				</Routes>
			)}
		</>
	)
}

/**
 * Two-pane shell. On md+ the workspace list is a persistent left rail. On
 * phones it is a floating drawer over the session — toggled from the header,
 * closed by picking a workspace or tapping the scrim — so switching
 * workspaces never round-trips through a separate screen.
 */
function Shell() {
	const match = useMatch('/w/:workspaceId')
	const sidebarOpen = useApp(s => s.sidebarOpen)
	const setSidebarOpen = useApp(s => s.setSidebarOpen)
	const drawerRef = useRef<HTMLElement>(null)
	useEdgeSwipeDrawer(drawerRef)
	// A tapped notification arrives as a message from the service worker, on whichever
	// screen the app happens to be showing — so the listener lives with the router.
	usePushRouting()
	// Re-register this device's push subscription with the relay on every load.
	// Shell-level, not the Connect sheet: a subscription the relay has lost still looks
	// fine from here, so waiting for someone to open a sheet and look would mean it is
	// usually never repaired.
	usePushSync()
	return (
		<div className="flex h-full overflow-hidden">
			{sidebarOpen ? (
				<div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} aria-hidden />
			) : null}
			<aside
				ref={drawerRef}
				className={cn(
					'fixed inset-y-0 left-0 z-50 flex w-[85%] max-w-80 flex-col border-r border-border-soft bg-bg transition-transform duration-200 ease-out',
					'md:static md:z-auto md:w-72 md:max-w-none md:shrink-0 md:translate-x-0 md:transition-none lg:w-80',
					sidebarOpen ? 'translate-x-0' : '-translate-x-full'
				)}
			>
				<WorkspaceList selectedId={match?.params.workspaceId} />
			</aside>
			<main className="flex min-w-0 flex-1 flex-col">
				<Outlet />
			</main>
		</div>
	)
}

/** Shown at `/` until a workspace is picked (the drawer opens itself on phones). */
function HomePane() {
	const setSidebarOpen = useApp(s => s.setSidebarOpen)
	return (
		<div className="grid h-full place-items-center">
			<button type="button" onClick={() => setSidebarOpen(true)} className="pill pill-active md:hidden">
				Browse workspaces
			</button>
			<span className="hidden text-sm text-muted md:block">Select a workspace</span>
		</div>
	)
}
