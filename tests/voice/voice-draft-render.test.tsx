import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { expect, it } from 'vitest'
import type { WorkspacePreview } from '../../src/voice/preview.ts'
import { VoiceDraftCard } from '../../web/src/components/voice/VoiceDraftCards.tsx'

const draft: WorkspacePreview = {
	kind: 'create_workspace',
	callId: 'call',
	token: 'revision',
	repo: 'conductor-remote',
	prompt: 'First line\nLast line of the full draft',
	status: 'ready',
	createdAt: Date.now(),
	expiresAt: Date.now() + 120_000
}
function render(value: WorkspacePreview, active = true) {
	return renderToStaticMarkup(
		<MemoryRouter>
			<VoiceDraftCard draft={value} active={active} handsFree={false} refresh={() => {}} />
		</MemoryRouter>
	)
}
it('renders the full review text with edit and explicit creation controls', () => {
	const html = render(draft)
	expect(html).toContain('First line\nLast line of the full draft')
	expect(html).toContain('Create workspace')
	expect(html).toContain('Edit')
})
it('keeps a completed workspace link after the call ends without another create button', () => {
	const html = render(
		{ ...draft, status: 'claimed', outcome: { state: 'completed', workspaceId: 'created-id' } },
		false
	)
	expect(html).toContain('Created')
	expect(html).toContain('href="/w/created-id"')
	expect(html).not.toContain('Create workspace</button>')
})
it('renews expired approval without immediately dispatching it', () => {
	const html = render({ ...draft, expiresAt: 1 })
	expect(html).toContain('Renew approval')
	expect(html).not.toContain('Create workspace</button>')
})
