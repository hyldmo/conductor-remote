import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

// Rasterize public/icon.svg into the PNG sizes the PWA manifest + iOS need.
const pub = path.join(import.meta.dirname, '..', 'public')
const svg = await readFile(path.join(pub, 'icon.svg'))

/**
 * The source SVG rounds its own background (`rx="112"`). That radius is right for an
 * icon a browser draws as-is and wrong for one its consumer masks itself — and the two
 * ways it goes wrong are different. Transparent corners under someone else's mask
 * double-round: a visible bite where the two radii disagree. Corners *flattened* for
 * iOS, which composites a transparent home-screen icon onto black, stop being corners at
 * all and become four opaque wedges — which is what read as a black edge on the logo,
 * because `resolveRepoIcon` (src/files/icons.ts) serves `public/apple-touch-icon.png` as this
 * repo's own sidebar avatar and the phone clips it to `rounded-lg`. It was hidden while
 * the tile inset the image by 6px and showed the moment that padding came off.
 *
 * So a masked target is rendered full-bleed and left to its consumer for the shape. The
 * bars sit 167px from the centre against a 205px safe radius, so nothing is cropped.
 */
const rounded = svg.toString()
const square = rounded.replace('<rect width="512" height="512" rx="112"', '<rect width="512" height="512" rx="0"')
// Fail loud: a rename of that rect would otherwise ship rounded corners again in silence.
if (square === rounded)
	throw new Error('icon.svg: background rect not found, so the full-bleed variant is still rounded')
const squareSvg = Buffer.from(square)

const targets: { name: string; size: number; background?: string; fullBleed?: boolean }[] = [
	// `purpose: any` (vite.config.ts) — drawn as-is, so these keep the icon's own shape.
	{ name: 'icon-192.png', size: 192 },
	{ name: 'icon-512.png', size: 512 },
	// `purpose: maskable` — Android crops this to whatever shape it likes.
	{ name: 'icon-maskable-512.png', size: 512, fullBleed: true },
	// iOS squircles the home-screen icon and rejects transparency, hence both flags.
	{ name: 'apple-touch-icon.png', size: 180, background: '#0a0b0e', fullBleed: true }
]

for (const t of targets) {
	let pipe = sharp(t.fullBleed ? squareSvg : svg, { density: 384 }).resize(t.size, t.size, { fit: 'contain' })
	if (t.background) pipe = pipe.flatten({ background: t.background })
	const out = await pipe.png().toBuffer()
	await writeFile(path.join(pub, t.name), out)
	console.info(`wrote ${t.name} (${t.size}px)`)
}
