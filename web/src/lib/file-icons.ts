/**
 * A focused subset of VS Code's built-in Seti file icon theme. The private-use
 * glyphs come from the vendored Seti font; filename rules precede extensions in
 * the same way VS Code resolves an icon theme.
 */

const definition = <Name extends string>(
	name: Name,
	glyph: string,
	lightColor: `#${string}`,
	darkColor: `#${string}`
) => ({ name, glyph, color: `light-dark(${lightColor}, ${darkColor})` }) as const

export const FILE_ICON_DEFINITIONS = {
	file: definition('file', '\uE023', '#bfc2c1', '#d4d7d6'),
	typescript: definition('typescript', '\uE099', '#498ba7', '#519aba'),
	react: definition('react', '\uE07D', '#498ba7', '#519aba'),
	javascript: definition('javascript', '\uE051', '#b7b73b', '#cbcb41'),
	json: definition('json', '\uE055', '#b7b73b', '#cbcb41'),
	html: definition('html', '\uE048', '#498ba7', '#519aba'),
	css: definition('css', '\uE01D', '#498ba7', '#519aba'),
	sass: definition('sass', '\uE084', '#dd4b78', '#f55385'),
	vue: definition('vue', '\uE09D', '#7fae42', '#8dc149'),
	svelte: definition('svelte', '\uE090', '#b8383d', '#cc3e44'),
	markdown: definition('markdown', '\uE060', '#498ba7', '#519aba'),
	info: definition('info', '\uE04D', '#498ba7', '#519aba'),
	config: definition('config', '\uE019', '#627379', '#6d8086'),
	env: definition('env', '\uE019', '#627379', '#6d8086'),
	yaml: definition('yaml', '\uE0A7', '#9068b0', '#a074c4'),
	shell: definition('shell', '\uE089', '#7fae42', '#8dc149'),
	powershell: definition('powershell', '\uE074', '#498ba7', '#519aba'),
	docker: definition('docker', '\uE025', '#498ba7', '#519aba'),
	git: definition('git', '\uE034', '#3b4b52', '#41535b'),
	npm: definition('npm', '\uE067', '#3b4b52', '#41535b'),
	yarn: definition('yarn', '\uE0A6', '#498ba7', '#519aba'),
	pnpm: definition('pnpm', '\uE067', '#3b4b52', '#41535b'),
	bun: definition('bun', '\uE023', '#bfc2c1', '#d4d7d6'),
	vite: definition('vite', '\uE09C', '#b7b73b', '#cbcb41'),
	lint: definition('lint', '\uE02C', '#9068b0', '#a074c4'),
	format: definition('format', '\uE019', '#627379', '#6d8086'),
	tailwind: definition('tailwind', '\uE01D', '#498ba7', '#519aba'),
	image: definition('image', '\uE04C', '#9068b0', '#a074c4'),
	svg: definition('svg', '\uE091', '#9068b0', '#a074c4'),
	audio: definition('audio', '\uE005', '#9068b0', '#a074c4'),
	media: definition('media', '\uE09B', '#dd4b78', '#f55385'),
	font: definition('font', '\uE033', '#b8383d', '#cc3e44'),
	database: definition('database', '\uE022', '#dd4b78', '#f55385'),
	prisma: definition('prisma', '\uE075', '#498ba7', '#519aba'),
	graphql: definition('graphql', '\uE03E', '#dd4b78', '#f55385'),
	python: definition('python', '\uE07B', '#498ba7', '#519aba'),
	ruby: definition('ruby', '\uE081', '#b8383d', '#cc3e44'),
	go: definition('go', '\uE039', '#498ba7', '#519aba'),
	rust: definition('rust', '\uE082', '#627379', '#6d8086'),
	java: definition('java', '\uE050', '#b8383d', '#cc3e44'),
	kotlin: definition('kotlin', '\uE058', '#cc6d2e', '#e37933'),
	swift: definition('swift', '\uE092', '#cc6d2e', '#e37933'),
	c: definition('c', '\uE00C', '#498ba7', '#519aba'),
	cpp: definition('cpp', '\uE01A', '#498ba7', '#519aba'),
	csharp: definition('csharp', '\uE00B', '#498ba7', '#519aba'),
	php: definition('php', '\uE070', '#9068b0', '#a074c4'),
	lua: definition('lua', '\uE05E', '#498ba7', '#519aba'),
	dart: definition('dart', '\uE021', '#498ba7', '#519aba'),
	elixir: definition('elixir', '\uE028', '#9068b0', '#a074c4'),
	wasm: definition('wasm', '\uE09E', '#9068b0', '#a074c4'),
	proto: definition('proto', '\uE019', '#627379', '#6d8086'),
	xml: definition('xml', '\uE0A5', '#cc6d2e', '#e37933'),
	terraform: definition('terraform', '\uE093', '#9068b0', '#a074c4'),
	notebook: definition('notebook', '\uE066', '#498ba7', '#519aba'),
	text: definition('text', '\uE023', '#bfc2c1', '#d4d7d6'),
	csv: definition('csv', '\uE01E', '#7fae42', '#8dc149'),
	pdf: definition('pdf', '\uE06D', '#b8383d', '#cc3e44'),
	archive: definition('archive', '\uE0A9', '#b8383d', '#cc3e44'),
	lock: definition('lock', '\uE05D', '#7fae42', '#8dc149'),
	license: definition('license', '\uE05A', '#b7b73b', '#cbcb41'),
	build: definition('build', '\uE05F', '#cc6d2e', '#e37933')
} as const

export type FileIconName = keyof typeof FILE_ICON_DEFINITIONS
export type FileIconDefinition = (typeof FILE_ICON_DEFINITIONS)[FileIconName]

const fileNameRules: readonly (readonly [RegExp, FileIconName])[] = [
	[/^(?:package|package-lock|npm-shrinkwrap)\.json$/, 'npm'],
	[/^(?:pnpm-lock|pnpm-workspace)\.ya?ml$/, 'pnpm'],
	[/^yarn\.lock$|^\.yarnrc(?:\.ya?ml)?$/, 'yarn'],
	[/^bun\.lockb?$|^bunfig\.toml$/, 'bun'],
	[/^tsconfig(?:\..+)?\.json$/, 'typescript'],
	[/^jsconfig(?:\..+)?\.json$|^deno\.jsonc?$/, 'javascript'],
	[/^(?:vite|vitest)\.config\./, 'vite'],
	[/^tailwind\.config\./, 'tailwind'],
	[/^eslint\.config\.|^\.eslintrc(?:\..+)?$/, 'lint'],
	[/^prettier\.config\.|^\.prettierrc(?:\..+)?$|^\.prettierignore$/, 'format'],
	[/^biome\.jsonc?$/, 'format'],
	[/^dockerfile(?:\..+)?$|^(?:docker-)?compose(?:\.[^.]+)?\.ya?ml$/, 'docker'],
	[/^\.git(?:ignore|attributes|modules|keep)$|^codeowners$/, 'git'],
	[/^\.env(?:\..+)?$/, 'env'],
	[/^(?:readme|changelog|changes|contributing|security|code_of_conduct)(?:\..+)?$/, 'info'],
	[/^(?:license|licence|copying)(?:\..+)?$/, 'license'],
	[/^cargo\.(?:toml|lock)$/, 'rust'],
	[/^go\.(?:mod|sum|work)$/, 'go'],
	[/^(?:gemfile|rakefile)(?:\.lock)?$/, 'ruby'],
	[/^(?:podfile|package\.swift)(?:\.lock)?$/, 'swift'],
	[/^pyproject\.toml$|^poetry\.lock$|^pipfile(?:\.lock)?$|^requirements(?:\.[^.]+)?\.txt$/, 'python'],
	[/^composer\.(?:json|lock)$/, 'php'],
	[/^pom\.xml$|^(?:build|settings)\.gradle(?:\.kts)?$|^gradlew(?:\.bat)?$/, 'java'],
	[/^(?:makefile|cmakelists\.txt|justfile|taskfile\.ya?ml)$/, 'build'],
	[/^\.(?:bash|zsh|fish)(?:rc|_profile)?$/, 'shell'],
	[/\.lock$/, 'lock']
]

const extensionGroups: readonly (readonly [FileIconName, readonly string[]])[] = [
	['typescript', ['ts', 'mts', 'cts']],
	['react', ['tsx', 'jsx']],
	['javascript', ['js', 'mjs', 'cjs']],
	['json', ['json', 'jsonc', 'json5', 'geojson', 'map']],
	['html', ['html', 'htm', 'astro', 'ejs', 'hbs', 'handlebars', 'liquid', 'njk', 'nunjucks', 'pug']],
	['css', ['css', 'pcss', 'less', 'styl', 'stylus']],
	['sass', ['scss', 'sass']],
	['vue', ['vue']],
	['svelte', ['svelte']],
	['markdown', ['md', 'mdx', 'markdown', 'mdown']],
	['yaml', ['yaml', 'yml']],
	['config', ['toml', 'ini', 'cfg', 'conf', 'config', 'properties']],
	['shell', ['sh', 'bash', 'zsh', 'fish']],
	['powershell', ['ps1', 'psm1', 'psd1']],
	['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'tif', 'tiff']],
	['svg', ['svg']],
	['audio', ['mp3', 'm4a', 'wav', 'ogg', 'flac']],
	['media', ['mp4', 'm4v', 'mov', 'webm']],
	['font', ['woff', 'woff2', 'ttf', 'otf', 'eot']],
	['database', ['sql', 'sqlite', 'sqlite3', 'db']],
	['prisma', ['prisma']],
	['graphql', ['graphql', 'graphqls', 'gql']],
	['python', ['py', 'pyi', 'pyw']],
	['ruby', ['rb', 'erb']],
	['go', ['go']],
	['rust', ['rs']],
	['java', ['java', 'class', 'jar', 'gradle']],
	['kotlin', ['kt', 'kts']],
	['swift', ['swift']],
	['c', ['c', 'h', 'm']],
	['cpp', ['cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'mm']],
	['csharp', ['cs', 'csx']],
	['php', ['php', 'phtml']],
	['lua', ['lua']],
	['dart', ['dart']],
	['elixir', ['ex', 'exs', 'heex']],
	['wasm', ['wasm', 'wat']],
	['proto', ['proto']],
	['xml', ['xml', 'xsl', 'xslt', 'plist', 'csproj', 'fsproj', 'vbproj']],
	['terraform', ['tf', 'tfvars', 'hcl']],
	['notebook', ['ipynb']],
	['text', ['txt', 'log']],
	['csv', ['csv', 'tsv']],
	['pdf', ['pdf']],
	['archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']],
	['license', ['license']],
	['build', ['mk', 'cmake']]
]

const extensionIcons = new Map<string, FileIconName>(
	extensionGroups.flatMap(([icon, extensions]) => extensions.map(extension => [extension, icon] as const))
)

export function fileIconForPath(path: string): FileIconDefinition {
	const fileName = path.split(/[/\\]/).at(-1)?.toLowerCase() ?? ''
	for (const [pattern, icon] of fileNameRules) {
		if (pattern.test(fileName)) return FILE_ICON_DEFINITIONS[icon]
	}

	const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''
	const icon = extensionIcons.get(extension)
	if (icon) return FILE_ICON_DEFINITIONS[icon]

	// Unrecognised dotfiles are overwhelmingly tool configuration rather than source.
	if (fileName.startsWith('.') && fileName.length > 1) return FILE_ICON_DEFINITIONS.config
	return FILE_ICON_DEFINITIONS.file
}
