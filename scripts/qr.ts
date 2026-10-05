/**
 * Dependency-free QR encoder — just enough to render the phone URL in the terminal.
 *
 * Scope is deliberately narrow: byte mode, error-correction level M, versions 1–10 (≈120 bytes max,
 * and the phone URL is ~70). That keeps the version/EC tables small and hand-verifiable while covering
 * every URL this relay can produce. Kept strip-clean like the rest of the repo (no enums/namespaces/
 * param-property constructors) so it runs under plain `node` type-stripping with zero deps.
 *
 * References the ISO/IEC 18004 QR Code spec; placement/format math mirrors Nayuki's reference encoder.
 */

// ── Galois field GF(256), primitive polynomial 0x11d ────────────────────────────────────────────────
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
let gfx = 1
for (let i = 0; i < 255; i++) {
	EXP[i] = gfx
	LOG[gfx] = i
	gfx <<= 1
	if (gfx & 0x100) gfx ^= 0x11d
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]

function gfMul(a: number, b: number): number {
	return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]
}

/** Reed–Solomon generator polynomial of the given degree; coeff[0] is the leading (highest) term. */
function rsGenerator(degree: number): number[] {
	let poly = [1]
	for (let i = 0; i < degree; i++) {
		const next = new Array(poly.length + 1).fill(0)
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= poly[j]
			next[j + 1] ^= gfMul(poly[j], EXP[i])
		}
		poly = next
	}
	return poly
}

/** The `ecLen` error-correction codewords for one data block (polynomial remainder). */
function rsRemainder(data: number[], ecLen: number): number[] {
	const gen = rsGenerator(ecLen)
	const res = new Array(ecLen).fill(0)
	for (const d of data) {
		const factor = d ^ res[0]
		res.shift()
		res.push(0)
		if (factor !== 0) for (let i = 0; i < ecLen; i++) res[i] ^= gfMul(gen[i + 1], factor)
	}
	return res
}

// ── Version tables (level M only) ───────────────────────────────────────────────────────────────────
type Group = [number, number] // [block count, data codewords per block]
type VersionInfo = { align: number[]; ec: number; groups: Group[] }

const VERSIONS: Record<number, VersionInfo> = {
	1: { align: [], ec: 10, groups: [[1, 16]] },
	2: { align: [6, 18], ec: 16, groups: [[1, 28]] },
	3: { align: [6, 22], ec: 26, groups: [[1, 44]] },
	4: { align: [6, 26], ec: 18, groups: [[2, 32]] },
	5: { align: [6, 30], ec: 24, groups: [[2, 43]] },
	6: { align: [6, 34], ec: 16, groups: [[4, 27]] },
	7: { align: [6, 22, 38], ec: 18, groups: [[4, 31]] },
	8: {
		align: [6, 24, 42],
		ec: 22,
		groups: [
			[2, 38],
			[2, 39]
		]
	},
	9: {
		align: [6, 26, 46],
		ec: 22,
		groups: [
			[3, 36],
			[2, 37]
		]
	},
	10: {
		align: [6, 28, 50],
		ec: 26,
		groups: [
			[4, 43],
			[1, 44]
		]
	}
}

function dataCodewords(v: number): number {
	return VERSIONS[v].groups.reduce((sum, [count, per]) => sum + count * per, 0)
}

function countBits(v: number): number {
	return v <= 9 ? 8 : 16
}

// ── Bit helpers ─────────────────────────────────────────────────────────────────────────────────────
function pushBits(bits: number[], value: number, len: number): void {
	for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1)
}

// ── Data encoding: text → interleaved data+EC bitstream for the smallest fitting version ─────────────
function encodeText(text: string): { version: number; bits: number[] } {
	const bytes = Array.from(new TextEncoder().encode(text))
	let version = 0
	for (let v = 1; v <= 10; v++) {
		if (4 + countBits(v) + 8 * bytes.length <= dataCodewords(v) * 8) {
			version = v
			break
		}
	}
	if (version === 0) throw new Error(`data too long for a v1–10 QR (${bytes.length} bytes)`)

	const capacityBits = dataCodewords(version) * 8
	const bits: number[] = []
	pushBits(bits, 0b0100, 4) // byte mode
	pushBits(bits, bytes.length, countBits(version))
	for (const b of bytes) pushBits(bits, b, 8)
	for (let i = 0, n = Math.min(4, capacityBits - bits.length); i < n; i++) bits.push(0) // terminator
	while (bits.length % 8 !== 0) bits.push(0)
	const pad = [0xec, 0x11]
	for (let i = 0; bits.length < capacityBits; i++) pushBits(bits, pad[i % 2], 8)

	const dataCw: number[] = []
	for (let i = 0; i < bits.length; i += 8) {
		let cw = 0
		for (let b = 0; b < 8; b++) cw = (cw << 1) | bits[i + b]
		dataCw.push(cw)
	}

	const { ec, groups } = VERSIONS[version]
	const blocks: { data: number[]; ec: number[] }[] = []
	let idx = 0
	for (const [count, per] of groups) {
		for (let b = 0; b < count; b++) {
			const data = dataCw.slice(idx, idx + per)
			idx += per
			blocks.push({ data, ec: rsRemainder(data, ec) })
		}
	}

	const out: number[] = []
	const maxData = Math.max(...blocks.map(bl => bl.data.length))
	for (let i = 0; i < maxData; i++) for (const bl of blocks) if (i < bl.data.length) out.push(bl.data[i])
	for (let i = 0; i < ec; i++) for (const bl of blocks) out.push(bl.ec[i])

	const dataBits: number[] = []
	for (const cw of out) pushBits(dataBits, cw, 8)
	return { version, bits: dataBits }
}

// ── Matrix construction ─────────────────────────────────────────────────────────────────────────────
function buildMatrix(version: number, dataBits: number[]): boolean[][] {
	const size = version * 4 + 17
	const m: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false))
	const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false))

	const finder = (r0: number, c0: number) => {
		for (let r = -1; r <= 7; r++)
			for (let c = -1; c <= 7; c++) {
				const rr = r0 + r
				const cc = c0 + c
				if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
				const border = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6))
				const center = r >= 2 && r <= 4 && c >= 2 && c <= 4
				m[rr][cc] = border || center
				reserved[rr][cc] = true
			}
	}
	finder(0, 0)
	finder(0, size - 7)
	finder(size - 7, 0)

	// Timing patterns
	for (let i = 8; i < size - 8; i++) {
		const v = i % 2 === 0
		if (!reserved[6][i]) {
			m[6][i] = v
			reserved[6][i] = true
		}
		if (!reserved[i][6]) {
			m[i][6] = v
			reserved[i][6] = true
		}
	}

	// Alignment patterns (skip the three that collide with finders)
	const pos = VERSIONS[version].align
	for (let i = 0; i < pos.length; i++)
		for (let j = 0; j < pos.length; j++) {
			const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)
			if (corner) continue
			const cr = pos[i]
			const cc = pos[j]
			for (let r = -2; r <= 2; r++)
				for (let c = -2; c <= 2; c++) {
					m[cr + r][cc + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1
					reserved[cr + r][cc + c] = true
				}
		}

	// Reserve format-info strips and (v≥7) version-info blocks — filled after masking.
	for (let i = 0; i <= 8; i++) {
		if (i !== 6) {
			reserved[8][i] = true
			reserved[i][8] = true
		}
	}
	for (let i = 0; i < 8; i++) {
		reserved[8][size - 1 - i] = true
		reserved[size - 1 - i][8] = true
	}
	reserved[size - 8][8] = true // dark module
	if (version >= 7)
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3)
			const b = Math.floor(i / 3)
			reserved[b][a] = true
			reserved[a][b] = true
		}

	// Data placement: two-column zigzag from bottom-right, skipping the timing column.
	let bit = 0
	let upward = true
	for (let col = size - 1; col > 0; col -= 2) {
		if (col === 6) col--
		for (let i = 0; i < size; i++) {
			const row = upward ? size - 1 - i : i
			for (let k = 0; k < 2; k++) {
				const c = col - k
				if (reserved[row][c]) continue
				m[row][c] = bit < dataBits.length ? dataBits[bit] === 1 : false
				bit++
			}
		}
		upward = !upward
	}

	if (version >= 7) drawVersion(m, version, size)

	// Try every mask, keep the lowest-penalty one.
	let best: boolean[][] | null = null
	let bestScore = Number.POSITIVE_INFINITY
	for (let mask = 0; mask < 8; mask++) {
		const cand = m.map(row => row.slice())
		for (let r = 0; r < size; r++)
			for (let c = 0; c < size; c++) if (!reserved[r][c] && maskBit(mask, r, c)) cand[r][c] = !cand[r][c]
		drawFormat(cand, mask, size)
		const score = penalty(cand)
		if (score < bestScore) {
			bestScore = score
			best = cand
		}
	}
	return best as boolean[][]
}

function maskBit(mask: number, r: number, c: number): boolean {
	switch (mask) {
		case 0:
			return (r + c) % 2 === 0
		case 1:
			return r % 2 === 0
		case 2:
			return c % 3 === 0
		case 3:
			return (r + c) % 3 === 0
		case 4:
			return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
		case 5:
			return ((r * c) % 2) + ((r * c) % 3) === 0
		case 6:
			return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
		default:
			return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
	}
}

/** 15-bit format info (level M = 00) with BCH(15,5) and the 0x5412 mask. */
function drawFormat(m: boolean[][], mask: number, size: number): void {
	const data = (0b00 << 3) | mask
	let rem = data
	for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0)
	const bits = (((data << 10) | (rem & 0x3ff)) ^ 0x5412) & 0x7fff
	const get = (i: number) => ((bits >> i) & 1) === 1
	for (let i = 0; i <= 5; i++) m[i][8] = get(i)
	m[7][8] = get(6)
	m[8][8] = get(7)
	m[8][7] = get(8)
	for (let i = 9; i < 15; i++) m[8][14 - i] = get(i)
	for (let i = 0; i < 8; i++) m[8][size - 1 - i] = get(i)
	for (let i = 8; i < 15; i++) m[size - 15 + i][8] = get(i)
	m[size - 8][8] = true // dark module
}

/** 18-bit version info (v≥7), BCH(18,6) with 0x1f25. */
function drawVersion(m: boolean[][], version: number, size: number): void {
	let rem = version
	for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) & 1 ? 0x1f25 : 0)
	const bits = (version << 12) | (rem & 0xfff)
	for (let i = 0; i < 18; i++) {
		const b = ((bits >> i) & 1) === 1
		const a = size - 11 + (i % 3)
		const d = Math.floor(i / 3)
		m[d][a] = b
		m[a][d] = b
	}
}

// ── Mask penalty (ISO/IEC 18004 §8.8.2) — only used to pick the mask, so exactness isn't critical ────
function penalty(m: boolean[][]): number {
	const n = m.length
	let score = 0
	const runScore = (get: (i: number) => boolean) => {
		let color = get(0)
		let len = 1
		for (let i = 1; i < n; i++) {
			if (get(i) === color) len++
			else {
				if (len >= 5) score += len - 2
				color = get(i)
				len = 1
			}
		}
		if (len >= 5) score += len - 2
	}
	for (let r = 0; r < n; r++) runScore(i => m[r][i])
	for (let c = 0; c < n; c++) runScore(i => m[i][c])

	for (let r = 0; r < n - 1; r++)
		for (let c = 0; c < n - 1; c++) {
			const v = m[r][c]
			if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3
		}

	const a = [true, false, true, true, true, false, true, false, false, false, false]
	const b = [false, false, false, false, true, false, true, true, true, false, true]
	const match = (get: (i: number) => boolean, start: number, pat: boolean[]) => {
		for (let i = 0; i < 11; i++) if (get(start + i) !== pat[i]) return false
		return true
	}
	for (let r = 0; r < n; r++)
		for (let c = 0; c <= n - 11; c++) {
			if (match(i => m[r][i], c, a) || match(i => m[r][i], c, b)) score += 40
		}
	for (let c = 0; c < n; c++)
		for (let r = 0; r <= n - 11; r++) {
			if (match(i => m[i][c], r, a) || match(i => m[i][c], r, b)) score += 40
		}

	let dark = 0
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) dark++
	score += Math.floor(Math.abs((dark / (n * n)) * 100 - 50) / 5) * 10
	return score
}

// ── Terminal rendering ──────────────────────────────────────────────────────────────────────────────
/**
 * Render the matrix as half-block lines (two modules per character row, ~square modules) with a forced
 * black-on-white style so it scans correctly regardless of the terminal theme, plus the 4-module quiet
 * zone the spec requires. `indent` is prepended (outside the styled region) to align with other output.
 */
// Each module is two background-coloured spaces on one line. Cell backgrounds fill the whole cell,
// including the terminal's line spacing, so the code has no gaps whatever the font or line height;
// half-block glyphs (▀▄) leave white seams between lines that break scanning. Bright white (107)
// rather than white (47), which many themes render as grey.
const DARK = '\x1b[40m  '
const LIGHT = '\x1b[107m  '

function render(m: boolean[][], indent: string): string[] {
	const size = m.length
	const quiet = 4
	const dark = (r: number, c: number) => r >= 0 && r < size && c >= 0 && c < size && m[r][c]
	const lines: string[] = []
	for (let r = -quiet; r < size + quiet; r++) {
		let line = indent
		for (let c = -quiet; c < size + quiet; c++) line += dark(r, c) ? DARK : LIGHT
		lines.push(`${line}\x1b[0m`)
	}
	return lines
}

/** Encode `text` into its QR module matrix (`true` = dark). Shared by the terminal and web SVG renderers. */
export function qrMatrix(text: string): boolean[][] {
	const { version, bits } = encodeText(text)
	return buildMatrix(version, bits)
}

/** Encode `text` and return the terminal lines that draw its QR code (each already indented). */
export function qrLines(text: string, indent = '    '): string[] {
	return render(qrMatrix(text), indent)
}
