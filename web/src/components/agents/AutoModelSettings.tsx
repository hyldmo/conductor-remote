import { useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useAutoModelConfig, useModelCatalog } from '../../hooks/agents.ts'
import { client } from '../../lib/api.ts'
import type { AutoModelConfig, AutoModelTuple } from '../../lib/types.ts'
import { RoleEditorCard, roleModelProblem } from '../orchestration/RolesSettings.tsx'

const inputClass =
	'w-full rounded-xl border border-border bg-bg px-3 py-2 text-base outline-none focus:border-accent/60'

export function AutoModelSettings({ onClose }: { onClose: () => void }) {
	const query = useAutoModelConfig()
	const catalog = useModelCatalog()
	const queryClient = useQueryClient()
	const [edited, setEdited] = useState<AutoModelConfig>()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const config = edited ?? query.data?.config
	const groups = catalog.data?.groups ?? []
	const models = [...new Set(groups.flatMap(group => group.models))]
	const routerModels = models.filter(
		model =>
			/^(?:GPT-)?\d[\d.]*(?: (?:Luna|Terra|Sol|Astra))?$/.test(model) ||
			/^opencode(?:-go)?\/muse-spark-[a-z0-9.-]+-contributor(?:-free)?$/.test(model)
	)
	const save = async () => {
		if (!config || busy) return
		setBusy(true)
		setError(undefined)
		try {
			const saved = await client.updateAutoModelConfig(config)
			queryClient.setQueryData(['auto-model-config'], saved)
			onClose()
		} catch (error) {
			setError(error instanceof Error ? error.message : 'Could not save Auto settings.')
		} finally {
			setBusy(false)
		}
	}
	const tuple = (role: AutoModelTuple): AutoModelTuple => ({ model: role.model, effort: role.effort, fast: role.fast })
	return createPortal(
		<div
			className="fixed inset-0 z-[70] flex flex-col bg-bg"
			role="dialog"
			aria-modal="true"
			aria-label="Auto model settings"
		>
			<header className="pt-safe flex items-center gap-3 border-b border-border p-3">
				<span className="flex-1 font-semibold">Auto models</span>
				<button type="button" onClick={() => void save()} disabled={!config || busy} className="ctl text-accent">
					{busy ? 'Saving…' : 'Save'}
				</button>
				<button type="button" onClick={onClose} aria-label="Close Auto settings" className="ctl">
					<X size={18} />
				</button>
			</header>
			<div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-4 overflow-y-auto p-4 pb-safe">
				<p className="text-sm text-muted">
					Auto reads your first message and attachments, then selects a model once. You can change the model afterward.
				</p>
				{error || query.isError ? <p className="text-sm text-del">{error ?? 'Could not load Auto settings.'}</p> : null}
				{config ? (
					<>
						<label className="flex items-center gap-3 text-sm">
							<input
								type="checkbox"
								checked={config.defaultAuto}
								onChange={event => setEdited({ ...config, defaultAuto: event.target.checked })}
							/>
							Use Auto by default for new workspaces and chats
						</label>
						<RoleEditorCard
							name="Router"
							role={config.router}
							models={routerModels}
							invalid={roleModelProblem(config.router, groups)}
							onChange={role => setEdited({ ...config, router: tuple(role) })}
							canRemove={false}
							onRemove={() => undefined}
							showPreamble={false}
						/>
						<p className="text-xs text-muted">
							Luna is the initial router. Muse Spark’s free and contributor options remain separate choices.
						</p>
						{config.profiles.map(profile => (
							<div key={profile.id} className="space-y-2">
								<RoleEditorCard
									name={profile.id}
									role={profile}
									models={models}
									invalid={roleModelProblem(profile, groups)}
									onChange={role =>
										setEdited({
											...config,
											profiles: config.profiles.map(p => (p.id === profile.id ? { ...p, ...tuple(role) } : p))
										})
									}
									canRemove={config.profiles.length > 1 && profile.id !== config.fallback}
									showPreamble={false}
									onRemove={() => setEdited({ ...config, profiles: config.profiles.filter(p => p.id !== profile.id) })}
								/>
								<label className="block text-xs text-muted">
									When to use {profile.id}
									<textarea
										className={`${inputClass} mt-1`}
										rows={2}
										maxLength={1000}
										value={profile.description}
										onChange={event =>
											setEdited({
												...config,
												profiles: config.profiles.map(p =>
													p.id === profile.id ? { ...p, description: event.target.value } : p
												)
											})
										}
									/>
								</label>
							</div>
						))}
						<button
							type="button"
							className="ctl self-start"
							disabled={config.profiles.length >= 16}
							onClick={() => {
								let index = 1
								while (config.profiles.some(p => p.id === `profile${index}`)) index++
								setEdited({
									...config,
									profiles: [
										...config.profiles,
										{
											id: `profile${index}`,
											model: models[0] ?? '',
											description: 'Describe the tasks this profile should handle.'
										}
									]
								})
							}}
						>
							Add profile
						</button>
						<label className="block text-sm">
							Fallback profile
							<select
								className={`${inputClass} mt-1`}
								value={config.fallback}
								onChange={event => setEdited({ ...config, fallback: event.target.value })}
							>
								{config.profiles.map(profile => (
									<option key={profile.id} value={profile.id}>
										{profile.id} · {profile.model}
									</option>
								))}
							</select>
						</label>
						<p className="text-xs text-muted">
							Used when the router times out, returns an invalid choice, or lacks essential context.
						</p>
						<label className="block text-sm">
							Routing rules
							<textarea
								className={`${inputClass} mt-1`}
								rows={8}
								maxLength={12000}
								value={config.rules}
								onChange={event => setEdited({ ...config, rules: event.target.value })}
							/>
						</label>
						<label className="block text-sm">
							Maximum selection time (seconds)
							<input
								className={`${inputClass} mt-1`}
								type="number"
								min={2}
								max={30}
								value={config.timeoutMs / 1000}
								onChange={event => setEdited({ ...config, timeoutMs: Number(event.target.value) * 1000 })}
							/>
						</label>
					</>
				) : query.isLoading ? (
					<p className="text-muted">Loading…</p>
				) : null}
			</div>
		</div>,
		document.body
	)
}
