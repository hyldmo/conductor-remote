import { parentPort, workerData } from 'node:worker_threads'
import { ConductorDb } from '../db.ts'
import { readToolUsage, type ToolUsageRange } from './tool-usage.ts'

const { dbPath, range } = workerData as { dbPath: string; range: ToolUsageRange }
const db = new ConductorDb(dbPath)
parentPort?.postMessage(readToolUsage(db, range))
