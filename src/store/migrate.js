import { DISTILL_RETENTION, PREFIX } from './contract.js'

/**
 * Migration flag key stored in localStorage when migration completes.
 */
export const MIGRATED_FLAG_KEY = `${PREFIX}migrated`

/**
 * Check if the given storage has already completed migration to host storage.
 * @param {{ getItem: (key: string) => string|null }} storage
 * @returns {boolean}
 */
export function isLocalStorageMigrated(storage) {
  if (!storage || typeof storage.getItem !== 'function') return true
  try {
    return Boolean(storage.getItem(MIGRATED_FLAG_KEY))
  } catch {
    return true
  }
}

/**
 * PromptLog-retention window mirrored from the Host store. Legacy logs older
 * than this are intentionally dropped by the Host on import, so verification
 * must not expect them back.
 */
const PROMPT_LOG_RETENTION_MS = 30 * 24 * 3600 * 1000

/**
 * List legacy data keys still present in the given storage. The migration flag
 * itself is excluded: it is bookkeeping, not user data.
 * @param {{ getItem: (key: string) => string|null, length?: number, key?: (i: number) => string|null }} storage
 * @returns {string[]}
 */
export function listLegacyDataKeys(storage) {
  const keys = []
  if (!storage || typeof storage.getItem !== 'function') return keys
  try {
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        if (k && k.startsWith(PREFIX) && k !== MIGRATED_FLAG_KEY) keys.push(k)
      }
    } else {
      for (const k of Object.keys(storage)) {
        if (k.startsWith(PREFIX) && k !== MIGRATED_FLAG_KEY) keys.push(k)
      }
    }
  } catch {}
  return keys
}

/**
 * Whether any legacy Punch Desk payload is still readable from localStorage.
 * A stale migration flag must never hide real user data from the retry path.
 * @param {object} storage
 * @returns {boolean}
 */
export function hasLegacyLocalStorageData(storage) {
  return listLegacyDataKeys(storage).length > 0
}

/**
 * Read-back verification: make sure every item that should have survived import
 * is actually present in a Host store export. Entries, groups, workspace
 * records and handoffs are verified strictly; prompt logs older than the Host
 * retention window are allowed to be pruned.
 * @param {object} state Host store export ({ entries, promptLogs, groups, workspaceRecords, handoffs })
 * @param {object} dump Legacy dump produced by `dumpLocalStorage`
 * @param {{ now?: number }} [options]
 * @returns {boolean}
 */
export function verifyStateContainsDump(state, dump, { now = Date.now() } = {}) {
  if (!state || typeof state !== 'object') return false
  if (!dump || typeof dump !== 'object') return true

  const entries = state.entries && typeof state.entries === 'object' ? state.entries : {}
  for (const [workspaceKey, items] of Object.entries(dump.entries || {})) {
    if (!Array.isArray(items) || items.length === 0) continue
    const storedIds = new Set((Array.isArray(entries[workspaceKey]) ? entries[workspaceKey] : []).map(item => item?.id))
    for (const item of items) {
      if (item?.id && !storedIds.has(item.id)) return false
    }
  }

  const promptLogs = state.promptLogs && typeof state.promptLogs === 'object' ? state.promptLogs : {}
  const recentCutoff = now - PROMPT_LOG_RETENTION_MS + 24 * 3600 * 1000
  for (const [workspaceKey, items] of Object.entries(dump.promptLogs || {})) {
    if (!Array.isArray(items) || items.length === 0) continue
    const stored = Array.isArray(promptLogs[workspaceKey]) ? promptLogs[workspaceKey] : []
    const storedIds = new Set(stored.map(item => item?.messageId || item?.id))
    for (const item of items) {
      const id = item?.messageId || item?.id
      const timestamp = typeof item?.time === 'number'
        ? item.time
        : (typeof item?.createdAt === 'number' ? item.createdAt : 0)
      if (id && timestamp >= recentCutoff && !storedIds.has(id)) return false
    }
  }

  const groups = state.groups && typeof state.groups === 'object' ? state.groups : {}
  for (const [sessionId, groupList] of Object.entries(dump.groups || {})) {
    if (!Array.isArray(groupList) || groupList.length === 0) continue
    const cleanId = String(sessionId).startsWith('session:') ? String(sessionId).slice('session:'.length) : String(sessionId)
    const storedIds = new Set()
    for (const candidate of [groups[sessionId], groups[cleanId], groups[`session:${cleanId}`]]) {
      if (!Array.isArray(candidate)) continue
      for (const group of candidate) {
        if (group?.id) storedIds.add(group.id)
      }
    }
    for (const group of groupList) {
      if (group?.id && !storedIds.has(group.id)) return false
    }
  }

  const storedRecordIds = new Set(
    (Array.isArray(state.workspaceRecords) ? state.workspaceRecords : []).map(record => record?.id),
  )
  for (const record of dump.workspaceRecords || []) {
    if (record?.id && !storedRecordIds.has(record.id)) return false
  }

  const handoffs = state.handoffs && typeof state.handoffs === 'object' ? state.handoffs : {}
  for (const [sessionId, value] of Object.entries(dump.handoffs || {})) {
    if (value == null) continue
    if (handoffs[sessionId] == null) return false
  }

  /**
   * Timestamp used to exempt pruned distillation rows from verification.
   * @param {object} item
   * @returns {number}
   */
  const distillTime = item => {
    if (!item || typeof item !== 'object') return 0
    if (typeof item.updatedAt === 'number') return item.updatedAt
    if (typeof item.createdAt === 'number') return item.createdAt
    if (typeof item.appliedAt === 'number') return item.appliedAt
    return 0
  }

  const distillRuns = state.distillRuns && typeof state.distillRuns === 'object' ? state.distillRuns : {}
  const runCutoff = now - DISTILL_RETENTION.runs.maxAgeMs
  for (const [bucketKey, items] of Object.entries(dump.distillRuns || {})) {
    if (!Array.isArray(items) || items.length === 0) continue
    const workspaceId = String(bucketKey).startsWith('ws:')
      ? String(bucketKey).slice('ws:'.length)
      : String(bucketKey)
    const stored = Array.isArray(distillRuns[bucketKey])
      ? distillRuns[bucketKey]
      : (Array.isArray(distillRuns[`ws:${workspaceId}`]) ? distillRuns[`ws:${workspaceId}`] : [])
    const storedIds = new Set(stored.map(item => item?.id))
    for (const item of items) {
      if (!item?.id) continue
      if ((distillTime(item) === 0 || distillTime(item) >= runCutoff) && !storedIds.has(item.id)) {
        return false
      }
    }
  }

  const distillPlans = state.distillPlans && typeof state.distillPlans === 'object' ? state.distillPlans : {}
  const runIds = new Set()
  for (const list of Object.values(distillRuns)) {
    if (!Array.isArray(list)) continue
    for (const run of list) if (run?.id) runIds.add(run.id)
  }
  for (const [rawKey, plan] of Object.entries(dump.distillPlans || {})) {
    if (!plan || typeof plan !== 'object') continue
    const runId = typeof plan.runId === 'string' && plan.runId
      ? plan.runId
      : (String(rawKey).startsWith('run:') ? String(rawKey).slice('run:'.length) : String(rawKey))
    // A plan follows its run: when the run itself was retention-pruned the plan
    // is legitimately absent, so only verify plans whose run survived.
    if (!runIds.has(runId)) continue
    if (!distillPlans[`run:${runId}`]) return false
  }

  const distillFingerprints = state.distillFingerprints && typeof state.distillFingerprints === 'object'
    ? state.distillFingerprints
    : {}
  const fingerprintCutoff = now - DISTILL_RETENTION.fingerprints.maxAgeMs
  for (const [bucketKey, items] of Object.entries(dump.distillFingerprints || {})) {
    if (!Array.isArray(items) || items.length === 0) continue
    const workspaceId = String(bucketKey).startsWith('ws:')
      ? String(bucketKey).slice('ws:'.length)
      : String(bucketKey)
    const stored = Array.isArray(distillFingerprints[bucketKey])
      ? distillFingerprints[bucketKey]
      : (Array.isArray(distillFingerprints[`ws:${workspaceId}`]) ? distillFingerprints[`ws:${workspaceId}`] : [])
    const storedIds = new Set(stored.map(item => item?.id))
    for (const item of items) {
      if (!item?.id) continue
      if ((distillTime(item) === 0 || distillTime(item) >= fingerprintCutoff) && !storedIds.has(item.id)) {
        return false
      }
    }
  }

  const commitTraces = state.commitTraces && typeof state.commitTraces === 'object' ? state.commitTraces : {}
  const traceCutoff = now - (30 * 24 * 3600 * 1000)
  for (const [sessionKey, items] of Object.entries(dump.commitTraces || {})) {
    if (!Array.isArray(items) || items.length === 0) continue
    const cleanId = String(sessionKey).startsWith('session:')
      ? String(sessionKey).slice('session:'.length)
      : String(sessionKey)
    const stored = Array.isArray(commitTraces[sessionKey])
      ? commitTraces[sessionKey]
      : (Array.isArray(commitTraces[`session:${cleanId}`]) ? commitTraces[`session:${cleanId}`] : [])
    const storedIds = new Set(stored.map(item => item?.id))
    for (const item of items) {
      if (!item?.id) continue
      const timestamp = typeof item.capturedAt === 'number'
        ? item.capturedAt
        : (typeof item.updatedAt === 'number' ? item.updatedAt : (typeof item.time === 'number' ? item.time : 0))
      if ((timestamp === 0 || timestamp >= traceCutoff) && !storedIds.has(item.id)) {
        return false
      }
    }
  }

  return true
}

/**
 * Extract a complete data dump from legacy localStorage.
 * @param {{ length: number, key: (i: number) => string|null, getItem: (key: string) => string|null }} storage
 * @returns {{
 *   entries: Record<string, object[]>,
 *   promptLogs: Record<string, object[]>,
 *   groups: Record<string, object[]>,
 *   workspaceRecords: object[],
 *   handoffs: Record<string, object>,
 *   prefs: object,
 *   workspaces: string[],
 * }}
 */
export function dumpLocalStorage(storage) {
  const dump = {
    entries: {},
    promptLogs: {},
    groups: {},
    workspaceRecords: [],
    handoffs: {},
    prefs: {},
    workspaces: [],
    // Keys this dump actually consumed. Cleanup must only delete these (and
    // only while their raw value is unchanged); unrecognized or unparseable
    // leftovers stay for manual recovery.
    consumedKeys: [],
  }

  if (!storage || typeof storage.getItem !== 'function') return dump

  try {
    const keys = []
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        if (k && k.startsWith(PREFIX)) keys.push(k)
      }
    } else {
      // Fallback for object-like storage maps
      for (const k of Object.keys(storage)) {
        if (k.startsWith(PREFIX)) keys.push(k)
      }
    }

    for (const key of keys) {
      if (key === MIGRATED_FLAG_KEY) continue
      const raw = storage.getItem(key)
      if (!raw) continue

      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }

      if (key.startsWith(`${PREFIX}entries.`)) {
        const encodedWs = key.slice(`${PREFIX}entries.`.length)
        const wsKey = decodeURIComponent(encodedWs)
        const list = Array.isArray(parsed?.entries) ? parsed.entries : (Array.isArray(parsed) ? parsed : [])
        dump.consumedKeys.push(key)
        if (list.length > 0) dump.entries[wsKey] = list
      } else if (key.startsWith(`${PREFIX}prompt-log.`) || key.startsWith(`${PREFIX}promptlog.`)) {
        // The client store writes `promptlog.` while the historical dump only
        // understood `prompt-log.`. Accept both spellings so legacy audit rows
        // are not silently dropped during migration.
        const prefix = key.startsWith(`${PREFIX}prompt-log.`) ? `${PREFIX}prompt-log.` : `${PREFIX}promptlog.`
        const encodedWs = key.slice(prefix.length)
        const wsKey = decodeURIComponent(encodedWs)
        const list = Array.isArray(parsed?.entries) ? parsed.entries : (Array.isArray(parsed) ? parsed : [])
        dump.consumedKeys.push(key)
        if (list.length > 0) dump.promptLogs[wsKey] = list
      } else if (key.startsWith(`${PREFIX}groups.`)) {
        const sessionId = decodeURIComponent(key.slice(`${PREFIX}groups.`.length))
        const list = Array.isArray(parsed?.groups) ? parsed.groups : (Array.isArray(parsed) ? parsed : [])
        dump.consumedKeys.push(key)
        if (list.length > 0) dump.groups[sessionId] = list
      } else if (key.startsWith(`${PREFIX}handoff.`)) {
        const sessionId = decodeURIComponent(key.slice(`${PREFIX}handoff.`.length))
        dump.consumedKeys.push(key)
        if (parsed) dump.handoffs[sessionId] = parsed
      } else if (key === `${PREFIX}workspace-records` || key === `${PREFIX}workspace_records`) {
        // Same spelling drift as prompt logs: the store writes
        // `workspace_records`, the original dump expected `workspace-records`.
        dump.consumedKeys.push(key)
        if (Array.isArray(parsed)) dump.workspaceRecords = parsed
      } else if (key === `${PREFIX}prefs`) {
        dump.consumedKeys.push(key)
        if (parsed && typeof parsed === 'object') dump.prefs = parsed
      } else if (key === `${PREFIX}workspaces`) {
        dump.consumedKeys.push(key)
        if (Array.isArray(parsed)) dump.workspaces = parsed
      }
    }
  } catch {}

  return dump
}

/**
 * Remove legacy data keys from localStorage and mark migration flag.
 * @param {{ removeItem: (key: string) => void, setItem: (key: string, value: string) => void, length?: number, key?: (i: number) => string|null }} storage
 */
export function clearLegacyLocalStorage(storage) {
  if (!storage || typeof storage.setItem !== 'function') return

  try {
    const keysToRemove = []
    if (typeof storage.length === 'number' && typeof storage.key === 'function') {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        if (k && k.startsWith(PREFIX) && k !== MIGRATED_FLAG_KEY) {
          keysToRemove.push(k)
        }
      }
    } else {
      for (const k of Object.keys(storage)) {
        if (k.startsWith(PREFIX) && k !== MIGRATED_FLAG_KEY) {
          keysToRemove.push(k)
        }
      }
    }

    for (const k of keysToRemove) {
      try { storage.removeItem(k) } catch {}
    }

    storage.setItem(MIGRATED_FLAG_KEY, String(Date.now()))
  } catch {}
}

/**
 * Remove only the legacy keys that a verified migration actually consumed.
 * Unrecognized/malformed rows and keys written by another tab after the
 * snapshot survive; the stale-marker retry path imports them on a later start.
 * @param {object} storage
 * @param {object} dump result of `dumpLocalStorage`
 * @param {Map<string, string>} [snapshot] raw values captured before the dump
 */
export function clearMigratedLegacyStorage(storage, dump, snapshot) {
  if (!storage || typeof storage.removeItem !== 'function') return
  const consumed = new Set(Array.isArray(dump?.consumedKeys) ? dump.consumedKeys : [])
  for (const key of consumed) {
    let current
    try {
      current = storage.getItem(key)
    } catch {
      continue
    }
    if (current === null) continue
    if (snapshot && snapshot.has(key) && snapshot.get(key) !== current) continue
    try { storage.removeItem(key) } catch {}
  }
  try { storage.setItem(MIGRATED_FLAG_KEY, String(Date.now())) } catch {}
}

/**
 * Migrate legacy localStorage data into Host Store.
 * @param {object} input
 * @param {object} [input.storage]
 * @param {object} [input.hostStore]
 * @param {Function} [input.fetch]
 * @returns {Promise<{ ok: boolean, migrated?: boolean, skipped?: boolean, error?: string, counts?: object }>}
 */
export async function migrateLocalStorageIfNeeded({
  storage = globalThis.localStorage,
  hostStore = null,
  fetch = globalThis.fetch,
  now = Date.now,
} = {}) {
  if (!storage || typeof storage.getItem !== 'function') {
    return { ok: true, skipped: true }
  }

  const alreadyMigrated = isLocalStorageMigrated(storage)
  const legacyKeys = listLegacyDataKeys(storage)
  const snapshot = new Map()
  for (const key of legacyKeys) {
    try { snapshot.set(key, storage.getItem(key)) } catch {}
  }

  // A completed migration leaves no payload keys behind. When the marker exists
  // but payload keys survive (a failed purge, or an older buggy bridge), retry
  // the import instead of trusting the marker and hiding real user data.
  if (alreadyMigrated && legacyKeys.length === 0) {
    return { ok: true, skipped: true }
  }

  const dump = dumpLocalStorage(storage)
  const hasData = Object.keys(dump.entries).length > 0 ||
    Object.keys(dump.promptLogs).length > 0 ||
    Object.keys(dump.groups).length > 0 ||
    dump.workspaceRecords.length > 0 ||
    Object.keys(dump.handoffs).length > 0 ||
    Object.keys(dump.prefs).length > 0 ||
    dump.workspaces.length > 0

  if (!hasData) {
    // Only mark migration complete when there is truly nothing readable left;
    // unparseable leftovers stay where they are for manual recovery.
    if (legacyKeys.length === 0) clearLegacyLocalStorage(storage)
    return { ok: true, skipped: true, empty: true }
  }

  // 1. Direct host store migration (in-process / Node / test)
  if (hostStore && typeof hostStore.importDump === 'function') {
    let result
    try {
      result = await hostStore.importDump(dump)
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
    if (!result?.ok) {
      return { ok: false, error: result?.error || 'Direct hostStore import failed' }
    }
    // Never trust the transport's own "verified" flag alone. Read the Host
    // state back and confirm every expected row physically landed before the
    // only copy in localStorage is removed.
    let state = null
    try {
      state = await hostStore.exportDump?.()
    } catch {}
    if (!verifyStateContainsDump(state, dump, { now: now() })) {
      return { ok: false, error: 'Host import could not be verified; keeping local data for retry' }
    }
    clearMigratedLegacyStorage(storage, dump, snapshot)
    return { ok: true, migrated: true, counts: result.counts }
  }

  // 2. HTTP fetch migration (Web client calling Host RPC)
  if (typeof fetch === 'function') {
    try {
      const res = await fetch('api/punch-desk/store-migrate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dump }),
      })
      if (!res.ok) {
        return { ok: false, error: `HTTP migration failed: status ${res.status}` }
      }
      const data = await res.json().catch(() => null)
      if (!data?.ok) {
        return { ok: false, error: data?.error || 'Remote migration rejected the dump' }
      }

      // Independent read-back over the same authenticated channel: a stale or
      // partial Host must never be able to confirm an import it did not keep.
      const readBackRes = await fetch('api/punch-desk/store', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'dump' }),
      })
      if (!readBackRes?.ok) {
        return { ok: false, error: `Migration read-back failed: status ${readBackRes?.status ?? 'unknown'}` }
      }
      const readBack = await readBackRes.json().catch(() => null)
      if (!verifyStateContainsDump(readBack?.state, dump, { now: now() })) {
        return { ok: false, error: 'Host read-back could not confirm the import; keeping local data for retry' }
      }

      clearMigratedLegacyStorage(storage, dump, snapshot)
      return { ok: true, migrated: true, counts: data.counts }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  return { ok: false, error: 'No hostStore or fetch available for migration' }
}
