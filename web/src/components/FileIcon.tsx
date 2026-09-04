import type { SVGAttributes } from 'react'
import { cn } from '../lib/cn.ts'
import { fileIconForPath, folderIconForPath, type VscodeIconData } from '../lib/file-icons.ts'

interface ArtworkProps extends Omit<SVGAttributes<SVGSVGElement>, 'children'> {
	artwork: VscodeIconData
}

function Artwork({ artwork, className, ...props }: ArtworkProps) {
	const width = artwork.width ?? 16
	const height = artwork.height ?? 16
	const left = artwork.left ?? 0
	const top = artwork.top ?? 0

	return (
		<svg
			{...props}
			aria-hidden="true"
			focusable="false"
			viewBox={`${left} ${top} ${width} ${height}`}
			className={cn('inline-block size-4 shrink-0', className)}
			// biome-ignore lint/security/noDangerouslySetInnerHtml: artwork is static SVG markup from the pinned vscode-icons package.
			dangerouslySetInnerHTML={{ __html: artwork.body }}
		/>
	)
}

export interface FileIconProps extends Omit<SVGAttributes<SVGSVGElement>, 'children'> {
	path: string
}

/** The real vscode-icons artwork for this file name or extension. */
export function FileIcon({ path, ...props }: FileIconProps) {
	const definition = fileIconForPath(path)
	return <Artwork {...props} artwork={definition.icon} data-file-icon={definition.name} />
}

export interface FolderIconProps extends Omit<SVGAttributes<SVGSVGElement>, 'children'> {
	expanded: boolean
	path: string
}

/** The real vscode-icons closed/opened artwork for this folder name. */
export function FolderIcon({ expanded, path, ...props }: FolderIconProps) {
	const definition = folderIconForPath(path)
	return (
		<Artwork
			{...props}
			artwork={expanded ? definition.openedIcon : definition.closedIcon}
			data-folder-expanded={expanded}
			data-folder-icon={definition.name}
		/>
	)
}
