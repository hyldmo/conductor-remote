import { LoaderCircle, Paperclip, X } from 'lucide-react'
import type { ClipboardEventHandler, ComponentProps, RefObject } from 'react'
import { useCallback, useRef, useState } from 'react'
import { pastedAttachments } from '../../lib/clipboard.ts'
import type { DraftAttachment } from '../../lib/types.ts'

export const EMPTY_ATTACHMENTS: readonly DraftAttachment[] = []

type PendingAttachment =
	| { draftKey: string; id: string; name: string; status: 'uploading' }
	| { draftKey: string; id: string; name: string; status: 'error'; error: string }

type AttachmentItem =
	| { id: string; name: string; status: 'ready' }
	| { id: string; name: string; status: 'uploading' }
	| { id: string; name: string; status: 'error'; error: string }

type DropTargetProps = Pick<ComponentProps<'fieldset'>, 'onDragEnter' | 'onDragLeave' | 'onDragOver' | 'onDrop'>

interface AttachmentUploadOptions {
	draftKey: string
	ready: readonly DraftAttachment[]
	enabled: boolean
	upload: (draftKey: string, file: File) => Promise<DraftAttachment>
	accept: (draftKey: string, attachment: DraftAttachment) => void
	removeReady: (draftKey: string, path: string) => void
	discard?: (attachment: DraftAttachment) => void
}

interface AttachmentUploads {
	items: AttachmentItem[]
	uploading: boolean
	hasError: boolean
	dragging: boolean
	inputRef: RefObject<HTMLInputElement | null>
	dropTargetProps: DropTargetProps
	onPaste: ClipboardEventHandler<HTMLTextAreaElement>
	chooseFiles: (files: FileList | File[] | null) => void
	remove: (id: string) => void
	clearPending: () => void
	cancelPending: () => void
}

export function useAttachmentUploads({
	draftKey,
	ready,
	enabled,
	upload,
	accept,
	removeReady,
	discard
}: AttachmentUploadOptions): AttachmentUploads {
	const inputRef = useRef<HTMLInputElement>(null)
	const cancelled = useRef(new Set<string>())
	const dragDepth = useRef(0)
	const [pending, setPending] = useState<PendingAttachment[]>([])
	const [dragging, setDragging] = useState(false)
	const activePending = pending.filter(attachment => attachment.draftKey === draftKey)

	const addFiles = async (picked: FileList | File[]) => {
		if (!enabled) return
		const uploadDraftKey = draftKey
		for (const file of Array.from(picked)) {
			const id = crypto.randomUUID()
			setPending(current => [
				...current,
				{ draftKey: uploadDraftKey, id, name: file.name || 'attachment', status: 'uploading' }
			])
			try {
				const attachment = await upload(uploadDraftKey, file)
				if (cancelled.current.delete(id)) {
					discard?.(attachment)
					continue
				}
				accept(uploadDraftKey, attachment)
				setPending(current => current.filter(candidate => candidate.id !== id))
			} catch (error) {
				if (cancelled.current.delete(id)) continue
				setPending(current =>
					current.map(candidate =>
						candidate.id === id
							? {
									...candidate,
									status: 'error',
									error: error instanceof Error ? error.message : 'Upload failed'
								}
							: candidate
					)
				)
			}
		}
	}

	const chooseFiles = (files: FileList | File[] | null) => {
		if (files?.length) void addFiles(files)
	}
	const isFileDrag = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes('Files')
	const dropTargetProps: DropTargetProps = {
		onDragEnter: event => {
			if (!isFileDrag(event)) return
			event.preventDefault()
			dragDepth.current += 1
			setDragging(true)
		},
		onDragLeave: event => {
			if (!isFileDrag(event)) return
			dragDepth.current -= 1
			if (dragDepth.current <= 0) {
				dragDepth.current = 0
				setDragging(false)
			}
		},
		onDragOver: event => {
			if (!isFileDrag(event)) return
			event.preventDefault()
			event.dataTransfer.dropEffect = 'copy'
		},
		onDrop: event => {
			if (!isFileDrag(event)) return
			event.preventDefault()
			dragDepth.current = 0
			setDragging(false)
			chooseFiles(event.dataTransfer.files)
		}
	}
	const onPaste: ClipboardEventHandler<HTMLTextAreaElement> = event => {
		// Offline text must still reach the editor: there is no upload to take ownership of it.
		if (!enabled) return
		const files = pastedAttachments(event.clipboardData)
		if (!files.length) return
		event.preventDefault()
		chooseFiles(files)
	}
	const cancelPending = useCallback(() => {
		for (const attachment of pending) {
			if (attachment.draftKey === draftKey) cancelled.current.add(attachment.id)
		}
	}, [draftKey, pending])

	return {
		items: [
			...ready.map(({ path, name }) => ({ id: path, name, status: 'ready' as const })),
			...activePending.map(({ draftKey: _, ...attachment }) => attachment)
		],
		uploading: activePending.some(attachment => attachment.status === 'uploading'),
		hasError: activePending.some(attachment => attachment.status === 'error'),
		dragging,
		inputRef,
		dropTargetProps,
		onPaste,
		chooseFiles,
		remove: id => {
			if (ready.some(attachment => attachment.path === id)) {
				removeReady(draftKey, id)
				return
			}
			cancelled.current.add(id)
			setPending(current => current.filter(attachment => attachment.id !== id))
		},
		clearPending: () => setPending(current => current.filter(attachment => attachment.draftKey !== draftKey)),
		cancelPending
	}
}

export function AttachmentTray({ uploads }: { uploads: AttachmentUploads }) {
	return (
		<>
			<input
				ref={uploads.inputRef}
				type="file"
				multiple
				className="hidden"
				onChange={event => {
					uploads.chooseFiles(event.target.files)
					event.target.value = ''
				}}
			/>
			{uploads.items.length ? (
				<div className="flex flex-wrap gap-1 px-2 pb-1">
					{uploads.items.map(attachment => (
						<div
							key={attachment.id}
							title={attachment.status === 'error' ? attachment.error : attachment.name}
							className="flex max-w-full items-center gap-1 rounded-lg bg-surface-2 py-1 pl-2 pr-1 text-xs text-muted"
						>
							{attachment.status === 'uploading' ? <LoaderCircle size={12} className="shrink-0 animate-spin" /> : null}
							<span className="truncate">
								{attachment.status === 'error' ? `${attachment.name}: ${attachment.error}` : attachment.name}
							</span>
							<button
								type="button"
								onClick={() => uploads.remove(attachment.id)}
								aria-label={`Remove ${attachment.name}`}
								className="flex size-5 shrink-0 items-center justify-center rounded active:bg-surface"
							>
								<X size={13} />
							</button>
						</div>
					))}
				</div>
			) : null}
			{uploads.dragging ? (
				<div className="pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-xl border border-dashed border-accent bg-accent-soft/90 text-sm font-medium text-accent">
					Drop files to attach
				</div>
			) : null}
		</>
	)
}

export function AttachmentPickerButton({ uploads, disabled }: { uploads: AttachmentUploads; disabled: boolean }) {
	return (
		<button
			type="button"
			onClick={() => uploads.inputRef.current?.click()}
			disabled={disabled}
			aria-label="Attach files"
			className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition active:bg-surface-2 active:text-text disabled:text-faint"
		>
			<Paperclip size={17} />
		</button>
	)
}
