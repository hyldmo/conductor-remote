import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { App } from './app.tsx'
import './index.css'
import { watchSystemTheme } from './lib/theme.ts'

// The service worker is registered by ReloadPrompt via `useRegisterSW` (it needs the
// registration handle for its update poll), so there's no manual registerSW() here.

// Ask the browser to keep our storage (the access token) from being evicted — best-effort, no-op where unsupported.
if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {})

// CSS follows the OS without JavaScript in system mode; this listener keeps the
// browser chrome's theme-color in step too. The early head script prevents a flash
// before this module and its stylesheet have loaded.
watchSystemTheme()

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 1000, retry: 1, refetchOnWindowFocus: true }
	}
})

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

createRoot(root).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<BrowserRouter>
				<App />
			</BrowserRouter>
		</QueryClientProvider>
	</StrictMode>
)
