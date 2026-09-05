import { ImageIcon, ImageOff } from 'lucide-react'
import { useState } from 'react'
import { useLocalImage } from '../../hooks/images.ts'

export function ImageThumbnail({
	reference = null,
	file,
	name
}: {
	reference?: string | null
	file?: File
	name: string
}) {
	const { objectUrl, error } = useLocalImage(reference, file)
	const [failedUrl, setFailedUrl] = useState<string | null>(null)
	const unavailable = !!error || (!!objectUrl && failedUrl === objectUrl)

	return (
		<span className="relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border-soft bg-surface-2 text-muted">
			{objectUrl && !unavailable ? (
				<img
					src={objectUrl}
					alt={name}
					className="m-0 size-full rounded-none object-cover"
					onError={() => setFailedUrl(objectUrl)}
				/>
			) : (
				<span
					className="flex min-w-0 flex-col items-center gap-1 px-1"
					title={unavailable ? 'Image unavailable' : name}
				>
					{unavailable ? <ImageOff size={20} /> : <ImageIcon size={20} />}
					<span className="w-full truncate text-center text-[10px]">{name}</span>
				</span>
			)}
		</span>
	)
}
