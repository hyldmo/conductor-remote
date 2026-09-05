import { asc } from 'drizzle-orm'
import type { PersistenceConnection } from './connection.ts'
import { OrchestrationError } from './errors.ts'
import { relayInstanceSelectSchema, relayInstances } from './schema.ts'
import type { ProcessProbe, RelayIdentity, RelayInstanceRecord } from './types.ts'
import { jsonProperty, optionalJson, probeAlive, sameOwner, validateRelayIdentity } from './values.ts'

export function registerRelayInstance(
	context: PersistenceConnection,
	input: RelayIdentity & { canDriveUi?: boolean; metadata?: unknown }
): RelayInstanceRecord {
	validateRelayIdentity(input)
	return context.immediate(() => {
		const at = context.now()
		context.db
			.prepare(
				`INSERT INTO relay_instances (
					instance_id, pid, process_started_at, protocol_version, can_drive_ui,
					heartbeat_at, registered_at, metadata_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(instance_id) DO UPDATE SET
					pid = excluded.pid,
					process_started_at = excluded.process_started_at,
					protocol_version = excluded.protocol_version,
					can_drive_ui = excluded.can_drive_ui,
					heartbeat_at = excluded.heartbeat_at,
					registered_at = CASE
						WHEN relay_instances.pid = excluded.pid
						 AND relay_instances.process_started_at = excluded.process_started_at
						THEN relay_instances.registered_at ELSE excluded.registered_at END,
					metadata_json = excluded.metadata_json`
			)
			.run(
				input.instanceId,
				input.pid,
				input.processStartedAt,
				input.protocolVersion,
				input.canDriveUi === false ? 0 : 1,
				at,
				at,
				optionalJson(input.metadata)
			)
		return requireRelayInstance(context, input.instanceId)
	})
}

export function heartbeatRelayInstance(context: PersistenceConnection, identity: RelayIdentity): boolean {
	return context.immediate(() => {
		const result = context.db
			.prepare(
				`UPDATE relay_instances SET heartbeat_at = ?
				 WHERE instance_id = ? AND pid = ? AND process_started_at = ? AND protocol_version = ?`
			)
			.run(context.now(), identity.instanceId, identity.pid, identity.processStartedAt, identity.protocolVersion)
		return Number(result.changes) === 1
	})
}

export function listRelayInstances(context: PersistenceConnection): RelayInstanceRecord[] {
	return context.orm
		.select()
		.from(relayInstances)
		.orderBy(asc(relayInstances.registeredAt), asc(relayInstances.instanceId))
		.all()
		.map(candidate => {
			const row = relayInstanceSelectSchema.parse(candidate)
			return {
				instanceId: row.instanceId,
				pid: row.pid,
				processStartedAt: row.processStartedAt,
				protocolVersion: row.protocolVersion,
				canDriveUi: row.canDriveUi,
				heartbeatAt: row.heartbeatAt,
				registeredAt: row.registeredAt,
				...jsonProperty('metadata', row.metadata)
			}
		})
}

export function findIncompatibleRelayInstances(
	context: PersistenceConnection,
	current: RelayIdentity,
	probe: ProcessProbe = context.processProbe
): RelayInstanceRecord[] {
	return listRelayInstances(context).filter(instance => {
		if (!instance.canDriveUi || sameOwner(instance, current) || instance.protocolVersion === current.protocolVersion)
			return false
		return probeAlive(instance, probe)
	})
}

export function requireRelayInstance(context: PersistenceConnection, instanceId: string): RelayInstanceRecord {
	const instance = listRelayInstances(context).find(entry => entry.instanceId === instanceId)
	if (!instance) throw new OrchestrationError(`relay instance ${instanceId} does not exist`)
	return instance
}

export function assertRelayRegistered(context: PersistenceConnection, owner: RelayIdentity): void {
	const row = context.db
		.prepare(
			`SELECT 1 present FROM relay_instances
			 WHERE instance_id = ? AND pid = ? AND process_started_at = ? AND protocol_version = ? AND can_drive_ui = 1`
		)
		.get(owner.instanceId, owner.pid, owner.processStartedAt, owner.protocolVersion) as { present: number } | undefined
	if (!row) throw new OrchestrationError(`relay ${owner.instanceId} is not registered as this live UI-driving process`)
}
