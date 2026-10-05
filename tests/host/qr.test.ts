import { describe, expect, test } from 'vitest'
import { qrLines, qrMatrix } from '../../scripts/qr.ts'

const URL = 'https://my-mac.tail0000.ts.net/#token=0123456789abcdef0123456789abcdef'
const DARK = '\x1b[40m  '
const LIGHT = '\x1b[107m  '
const RESET = '\x1b[0m'

/** Decode one rendered line back into modules (`true` = dark); throws on anything but whole cells. */
function cells(line: string): boolean[] {
	const out: boolean[] = []
	let rest = line.endsWith(RESET) ? line.slice(0, -RESET.length) : line
	while (rest) {
		if (rest.startsWith(DARK)) {
			out.push(true)
			rest = rest.slice(DARK.length)
		} else if (rest.startsWith(LIGHT)) {
			out.push(false)
			rest = rest.slice(LIGHT.length)
		} else throw new Error(`unexpected output: ${JSON.stringify(rest.slice(0, 12))}`)
	}
	return out
}

describe('terminal QR', () => {
	test('draws one line per module row from background-coloured cells, no glyphs', () => {
		const size = qrMatrix(URL).length
		const lines = qrLines(URL, '')
		expect(lines).toHaveLength(size + 8)
		for (const line of lines) {
			// Half blocks leave seams between lines that break scanning.
			expect(line).not.toMatch(/[▀▄█]/)
			expect(cells(line)).toHaveLength(size + 8)
		}
	})

	test('cells mirror the module matrix inside a light quiet zone', () => {
		const m = qrMatrix(URL)
		const rows = qrLines(URL, '').map(cells)
		for (let r = 0; r < rows.length; r++)
			for (let c = 0; c < rows[r].length; c++) {
				const inside = r >= 4 && r < m.length + 4 && c >= 4 && c < m.length + 4
				expect(rows[r][c]).toBe(inside ? m[r - 4][c - 4] : false)
			}
	})
})
