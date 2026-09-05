import { qrMatrix } from '../../../../scripts/qr.ts'

/**
 * Render a QR of `text` as a crisp SVG — forced black-on-white (like the terminal encoder) so it scans
 * regardless of the app theme, with the spec's 4-module quiet zone. Reuses the dependency-free encoder in
 * scripts/qr.ts, so the PWA gains QR rendering without adding a runtime dependency to the bundle.
 */
export function QRCode({ text, size = 220, className }: { text: string; size?: number; className?: string }) {
	const m = qrMatrix(text)
	const n = m.length
	const quiet = 4
	const dim = n + quiet * 2
	// One path of unit squares for the dark modules — far fewer nodes than a <rect> per module.
	let path = ''
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`
	return (
		<svg
			width={size}
			height={size}
			viewBox={`0 0 ${dim} ${dim}`}
			shapeRendering="crispEdges"
			className={className}
			role="img"
			aria-label="QR code"
		>
			<title>QR code</title>
			<rect width={dim} height={dim} fill="#fff" />
			<path d={path} fill="#000" />
		</svg>
	)
}
