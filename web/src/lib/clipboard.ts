const PASTE_ATTACHMENT_THRESHOLD = 2_000

/** Files take priority over their clipboard text; large text keeps its exact contents in a plain-text file. */
export function pastedAttachments(clipboard: Pick<DataTransfer, 'files' | 'getData'>): File[] {
	if (clipboard.files.length) return Array.from(clipboard.files)
	const text = clipboard.getData('text/plain')
	if (text.length <= PASTE_ATTACHMENT_THRESHOLD) return []
	return [new File([text], 'pasted-text.txt', { type: 'text/plain' })]
}

export async function copyText(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text)
	const input = document.createElement('textarea')
	input.value = text
	input.setAttribute('readonly', '')
	input.style.cssText = 'position:fixed;opacity:0'
	document.body.append(input)
	input.select()
	const copied = document.execCommand('copy')
	input.remove()
	if (!copied) throw new Error('Clipboard unavailable')
}
