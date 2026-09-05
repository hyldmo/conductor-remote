import jsQR from 'jsqr'
import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

/**
 * In-app QR scanner — opens the device camera and decodes a QR entirely inside the PWA. An installed,
 * standalone app has no address bar, and the phone's native camera app would open the scanned URL in
 * Safari (a separate storage sandbox), not this app — so re-provisioning the access token has to happen
 * in-app. The TokenGate uses this to grab the token from the relay's printed QR by scanning it.
 *
 * Decoding is jsQR (BarcodeDetector is unsupported on iOS Safari/standalone). getUserMedia needs a secure
 * context — the tailnet HTTPS URL satisfies it. The camera stream is always stopped on unmount.
 */
export function QRScanner({ onResult, onClose }: { onResult: (text: string) => void; onClose: () => void }) {
	const videoRef = useRef<HTMLVideoElement>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		let stream: MediaStream | null = null
		let raf = 0
		let stopped = false
		const canvas = document.createElement('canvas')
		const ctx = canvas.getContext('2d', { willReadFrequently: true })

		const tick = () => {
			const video = videoRef.current
			if (stopped || !video || !ctx) return
			if (video.readyState >= video.HAVE_ENOUGH_DATA && video.videoWidth) {
				canvas.width = video.videoWidth
				canvas.height = video.videoHeight
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
				const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height)
				const code = jsQR(data, width, height, { inversionAttempts: 'dontInvert' })
				if (code?.data) {
					stopped = true
					onResult(code.data)
					return
				}
			}
			raf = requestAnimationFrame(tick)
		}

		navigator.mediaDevices
			?.getUserMedia({ video: { facingMode: 'environment' } })
			.then(s => {
				if (stopped) {
					for (const t of s.getTracks()) t.stop()
					return
				}
				stream = s
				const video = videoRef.current
				if (!video) return
				video.srcObject = s
				void video.play()
				raf = requestAnimationFrame(tick)
			})
			.catch(e => setError(cameraError(e)))

		return () => {
			stopped = true
			cancelAnimationFrame(raf)
			if (stream) for (const t of stream.getTracks()) t.stop()
		}
	}, [onResult])

	return (
		<div className="fixed inset-0 z-[60] bg-black">
			<video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
			{/* Framing reticle: a clear square punched into a dimmed overlay via a huge box-shadow spread. */}
			<div className="pointer-events-none absolute inset-0 grid place-items-center">
				<div className="size-60 max-w-[70vw] rounded-3xl border-2 border-white/80 shadow-[0_0_0_100vmax_rgba(0,0,0,0.5)]" />
			</div>
			<div className="pt-safe absolute inset-x-0 top-0 flex items-center justify-between p-4">
				<span className="rounded-full bg-black/50 px-3 py-1 text-sm text-white">Point at the relay QR</span>
				<button
					type="button"
					onClick={onClose}
					aria-label="Cancel scan"
					className="flex size-9 items-center justify-center rounded-full bg-black/50 text-white active:bg-black/70"
				>
					<X size={20} />
				</button>
			</div>
			{error ? (
				<div className="pb-safe absolute inset-x-0 bottom-0 bg-black/75 p-4 text-center text-sm leading-relaxed text-white">
					{error}
				</div>
			) : null}
		</div>
	)
}

/** Human-readable reason the camera couldn't start, always ending with the paste fallback. */
function cameraError(e: unknown): string {
	const name = e instanceof DOMException ? e.name : ''
	if (name === 'NotAllowedError') return 'Camera permission denied. Allow camera access, or paste the token instead.'
	if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found — paste the token instead.'
	if (!window.isSecureContext) return 'The camera needs HTTPS. Open the relay’s https:// URL, or paste the token.'
	return `Camera unavailable (${e instanceof Error ? e.message : String(e)}). Paste the token instead.`
}
