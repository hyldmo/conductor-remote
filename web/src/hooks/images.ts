import { useEffect, useState } from 'react'
import { client } from '../lib/api.ts'

/** Picked files preview immediately; saved images use the relay's authenticated URL cache. */
export function useLocalImage(
	reference: string | null,
	file?: File
): { objectUrl: string | null; error: string | null } {
	const source = file ?? reference
	const [image, setImage] = useState<{ source: typeof source; objectUrl: string | null; error: string | null } | null>(
		null
	)

	useEffect(() => {
		if (!source) return
		if (typeof source !== 'string') {
			const objectUrl = URL.createObjectURL(source)
			setImage({ source, objectUrl, error: null })
			return () => URL.revokeObjectURL(objectUrl)
		}
		let disposed = false
		void client.localImage(source).then(
			objectUrl => {
				if (!disposed) setImage({ source, objectUrl, error: null })
			},
			err => {
				if (!disposed)
					setImage({ source, objectUrl: null, error: err instanceof Error ? err.message : 'Image unavailable' })
			}
		)
		return () => {
			disposed = true
		}
	}, [source])

	return image?.source === source ? image : { objectUrl: null, error: null }
}
