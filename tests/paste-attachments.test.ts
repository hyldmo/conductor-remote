import { describe, expect, it, vi } from 'vitest'
import { pastedAttachments } from '../web/src/lib/clipboard.ts'

function clipboard(text: string, files: File[] = []): Pick<DataTransfer, 'files' | 'getData'> {
	return {
		files: Object.assign([...files], { item: (index: number) => files[index] ?? null }),
		getData: vi.fn((format: string) => (format === 'text/plain' ? text : '<p>Rich text</p>'))
	}
}

describe('pasted attachments', () => {
	it.each([0, 1, 1_999, 2_000])('leaves a %i-character paste to the editor', length => {
		expect(pastedAttachments(clipboard('x'.repeat(length)))).toEqual([])
	})

	it('turns a paste over 2,000 characters into a readable text attachment', async () => {
		const text = 'x'.repeat(2_001)
		const files = pastedAttachments(clipboard(text))

		expect(files).toHaveLength(1)
		expect(files[0].name).toBe('pasted-text.txt')
		expect(files[0].type).toBe('text/plain')
		expect(await files[0].text()).toBe(text)
	})

	it('preserves Unicode, indentation, line endings and surrounding whitespace byte for byte', async () => {
		const text = `  \r\n${'\tArchitecture — æøå 🧪 漢字\r\n'.repeat(100)}\n  `
		const [file] = pastedAttachments(clipboard(text))

		expect(await file.text()).toBe(text)
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(new TextEncoder().encode(text))
	})

	it('uses plain text from a rich-text paste', async () => {
		const text = '# Heading\n'.repeat(250)
		const data = clipboard(text)
		const [file] = pastedAttachments(data)

		expect(data.getData).toHaveBeenCalledWith('text/plain')
		expect(await file.text()).toBe(text)
	})

	it('keeps pasted files and images without also attaching their text representation', () => {
		const files = [
			new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' }),
			new File(['notes'], 'notes.txt', { type: 'text/plain' })
		]
		const data = clipboard('x'.repeat(3_000), files)

		expect(pastedAttachments(data)).toEqual(files)
		expect(data.getData).not.toHaveBeenCalled()
	})
})
