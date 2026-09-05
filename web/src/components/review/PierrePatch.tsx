import { EXTENSION_TO_FILE_FORMAT, setCustomExtension, type ThemeTypes } from '@pierre/diffs'
import { PatchDiff } from '@pierre/diffs/react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../lib/cn.ts'
import { preparePatch } from '../../lib/diff.ts'
import { PIERRE_SYNTAX_LANGUAGES } from '../../lib/syntax/pierre-shiki.ts'
import type { PatchProps } from './Patch.tsx'

const BASE_OPTIONS = {
	diffStyle: 'unified',
	overflow: 'scroll',
	preferredHighlighter: 'shiki-js'
} as const

// Pierre knows hundreds of filename mappings, while this build deliberately
// carries the source grammars the relay supports. Preserve Pierre's diff UI for
// every other format and ask it to render those bodies as plain text.
for (const [extension, language] of Object.entries(EXTENSION_TO_FILE_FORMAT)) {
	if (!language || !PIERRE_SYNTAX_LANGUAGES.has(language)) setCustomExtension(extension, 'text')
}

/** Keep Pierre's Shiki theme aligned with the app's explicit theme override. */
function currentTheme(): ThemeTypes {
	if (typeof document === 'undefined') return 'system'
	const theme = document.documentElement.dataset.theme
	return theme === 'light' || theme === 'dark' ? theme : 'system'
}

function useTheme(): ThemeTypes {
	const [theme, setTheme] = useState(currentTheme)
	useEffect(() => {
		const root = document.documentElement
		const observer = new MutationObserver(() => setTheme(currentTheme()))
		observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
		return () => observer.disconnect()
	}, [])
	return theme
}

export default function PierrePatch({ patch, fileName, hideFileHeader, truncated, className }: PatchProps) {
	const prepared = useMemo(() => preparePatch(patch, fileName), [patch, fileName])
	const themeType = useTheme()
	const options = useMemo(
		() => ({ ...BASE_OPTIONS, themeType, disableFileHeader: hideFileHeader }),
		[themeType, hideFileHeader]
	)

	return (
		<div className={cn('min-w-0', className)}>
			{prepared.preamble ? (
				<pre className="mb-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11.5px] leading-[1.5] text-faint">
					{prepared.preamble}
				</pre>
			) : null}
			<PatchDiff
				patch={prepared.patch}
				options={options}
				className="min-w-0 [--diffs-font-family:var(--font-mono)] [--diffs-font-size:11.5px] [--diffs-line-height:17.25px]"
			/>
			{truncated ? <div className="mt-2 font-mono text-[11.5px] text-faint">… diff truncated …</div> : null}
		</div>
	)
}
