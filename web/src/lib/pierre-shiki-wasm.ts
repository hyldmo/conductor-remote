/**
 * Diffs defaults to Shiki's JavaScript regex engine, which is also pinned in
 * PierrePatch. Keeping this unused dynamic import resolvable prevents Vite from
 * shipping the 600 kB Oniguruma binary solely for an unreachable option.
 */
export default async function loadWasm(): Promise<never> {
	throw new Error('The diff viewer is configured to use the Shiki JavaScript engine')
}
