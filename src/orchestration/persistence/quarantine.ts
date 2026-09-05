import { eq } from 'drizzle-orm'
import type { PersistenceConnection } from './connection.ts'
import { OrchestrationError } from './errors.ts'
import { uiQuarantine, uiQuarantineSelectSchema } from './schema.ts'
import type { ProcessIdentity, RelayIdentity, UiQuarantineRecord } from './types.ts'
import { externalFromColumns, nonEmpty, ownerFromColumns } from './values.ts'

export function activateUiQuarantine(
	context: PersistenceConnection,
	input: {
		actionId: string
		effectId?: string
		reason: string
		owner?: RelayIdentity
		externalProcess?: ProcessIdentity & { processGroup?: number }
	}
): UiQuarantineRecord {
	return context.immediate(() => {
		const current = getUiQuarantine(context)
		if (current.active) return current
		const at = context.now()
		context.db
			.prepare(
				`UPDATE ui_quarantine SET active = 1, action_id = ?, effect_id = ?, reason = ?,
					owner_instance_id = ?, owner_pid = ?, owner_process_started_at = ?, owner_protocol_version = ?,
					external_pid = ?, external_process_started_at = ?, external_process_group = ?,
					created_at = ?, cleared_at = NULL, cleared_by = NULL WHERE id = 1`
			)
			.run(
				input.actionId,
				input.effectId ?? null,
				nonEmpty(input.reason, 'quarantine reason'),
				input.owner?.instanceId ?? null,
				input.owner?.pid ?? null,
				input.owner?.processStartedAt ?? null,
				input.owner?.protocolVersion ?? null,
				input.externalProcess?.pid ?? null,
				input.externalProcess?.processStartedAt ?? null,
				input.externalProcess?.processGroup ?? null,
				at
			)
		return getUiQuarantine(context)
	})
}

export function clearUiQuarantine(context: PersistenceConnection, clearedBy: string): boolean {
	return context.immediate(() => {
		const result = context.db
			.prepare('UPDATE ui_quarantine SET active = 0, cleared_at = ?, cleared_by = ? WHERE id = 1 AND active = 1')
			.run(context.now(), nonEmpty(clearedBy, 'quarantine clearer'))
		return Number(result.changes) === 1
	})
}

export function getUiQuarantine(context: PersistenceConnection): UiQuarantineRecord {
	const candidate = context.orm.select().from(uiQuarantine).where(eq(uiQuarantine.id, 1)).get()
	if (!candidate) throw new OrchestrationError('orchestration UI quarantine singleton is missing')
	const row = uiQuarantineSelectSchema.parse(candidate)
	const owner = ownerFromColumns(row)
	const externalProcess = externalFromColumns(row)
	return {
		active: row.active,
		...(row.actionId === null ? {} : { actionId: row.actionId }),
		...(row.effectId === null ? {} : { effectId: row.effectId }),
		...(row.reason === null ? {} : { reason: row.reason }),
		...(owner ? { owner } : {}),
		...(externalProcess ? { externalProcess } : {}),
		...(row.createdAt === null ? {} : { createdAt: row.createdAt }),
		...(row.clearedAt === null ? {} : { clearedAt: row.clearedAt }),
		...(row.clearedBy === null ? {} : { clearedBy: row.clearedBy })
	}
}
