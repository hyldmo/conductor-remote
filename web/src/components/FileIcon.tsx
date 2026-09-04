import type { HTMLAttributes } from 'react'
import { cn } from '../lib/cn.ts'
import { fileIconForPath } from '../lib/file-icons.ts'
import './seti-file-icon.css'

export interface FileIconProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
	path: string
}

/** The actual Seti file-type glyph VS Code shows beside an Explorer filename. */
export function FileIcon({ path, className, style, ...props }: FileIconProps) {
	const icon = fileIconForPath(path)

	return (
		<span
			{...props}
			aria-hidden="true"
			data-file-icon={icon.name}
			className={cn('seti-file-icon inline-flex size-[15px] shrink-0 items-center justify-center', className)}
			style={{ color: icon.color, ...style }}
		>
			{icon.glyph}
		</span>
	)
}
