import {
  ARCHIVED_HISTORY_HEIGHTS,
  COMPOSER_ROWS_OPTIONS,
  DEFAULT_PREFS,
  DRAFT_DEFAULT_VISIBILITIES,
  INHERIT_SCOPES,
  PREFIX,
  SEQUENTIAL_COST_HINTS,
  START_SESSION_BEHAVIORS,
  workspaceKeyPart,
} from './contract.js'
import { validateWorkspaceRecord } from '../domain/workspace.js'
import { validateGroupRecord } from '../domain/active-group.js'
import { pruneTurnActionItems } from '../domain/turn-actions.js'

function readJson(storage, key, fallback) {
  if (!storage || typeof storage.getItem !== 'function') return fallback
  try {
    const raw = storage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

function writeJson(storage, key, value) {
  if (!storage || typeof storage.setItem !== 'function') return false
  try {
    storage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

function mergeById(current, incoming) {
  const map = new Map(current.map(item => [item.id, item]))
  for (const item of incoming) {
    const existing = map.get(item.id)
    if (!existing || (item.updatedAt ?? 0) >= (existing.updatedAt ?? 0)) map.set(item.id, item)
  }
  return [...map.values()]
}

function mergeLog(current, incoming) {
  const map = new Map(current.map(item => [item.messageId, item]))
  for (const item of incoming) map.set(item.messageId, { ...map.get(item.messageId), ...item })
  return [...map.values()]
}

function mergeTraces(current = [], incoming = []) {
  const map = new Map(current.filter(item => item && item.id).map(item => [item.id, item]))
  for (const item of incoming) {
    if (!item || !item.id) continue
    const prev = map.get(item.id)
    const itemTime = item.updatedAt ?? item.capturedAt ?? 0
    const prevTime = prev ? (prev.updatedAt ?? prev.capturedAt ?? 0) : -1
    if (!prev || itemTime >= prevTime) {
      map.set(item.id, item)
    }
  }
  return [...map.values()]
}

/**
 * Session id named by a `session:<id>` workspace key, or null when the key
 * names something else (`draft:global`, a directory path, ...).
 * @param {string} workspaceKey
 * @returns {string|null}
 */
function sessionIdOfWorkspaceKey(workspaceKey) {
  if (typeof workspaceKey !== 'string' || !workspaceKey.startsWith('session:')) return null
  const id = workspaceKey.slice('session:'.length)
  return id === '' ? null : id
}

/**
 * Create a DeskStore backed by pure in-memory cache and asynchronous Host disk persistence.
 * Completely eliminates dependency on browser localStorage for runtime persistence.
 *
 * @param {object} [deps]
 * @param {{ getItem?: Function, setItem?: Function, removeItem?: Function, key?: Function, length?: number }|null} [deps.storage] Optional Web Storage backend (used for backward compatibility / tests)
 * @param {object|null} [deps.hostStore] Optional direct in-process Host store instance (for Node / integration tests)
 * @param {Function|null} [deps.fetch] Optional fetch function for remote Host RPC calls
 * @param {string} [deps.endpoint] Endpoint path for host store RPC (defaults to 'api/punch-desk/store')
 * @param {boolean} [deps.autoHydrate] Whether to automatically hydrate from host on creation (defaults to true)
 * @param {() => number} [deps.now] Clock for stored timestamps
 * @param {() => string} [deps.uuid] ID generator
 * @param {EventTarget} [deps.eventTarget] Source of cross-tab `storage` events (when storage is supplied)
 * @returns {import('./contract.js').DeskStore & {
 *   listWorkspaces: () => Promise<string[]>,
 *   revision: (workspaceKey: string) => number,
 *   quotaWarning: () => boolean,
 *   hydrate: () => Promise<boolean>,
 *   exportDump: () => Promise<object>,
 *   dispose: () => void,
 * }} desktop store
 */
export function createDeskStore({
  storage = null,
  hostStore = null,
  fetch: customFetch = null,
  endpoint = 'api/punch-desk/store',
  autoHydrate = true,
  now = Date.now,
  uuid = () => globalThis.crypto.randomUUID(),
  eventTarget = globalThis,
} = {}) {
  const listeners = new Set()
  const revisions = new Map()
  const memoryEntries = new Map()
  const memoryLog = new Map()
  // Session-scoped drafts handed to a composer; newest write per session.
  const memoryHandoff = new Map()
  const memoryTraces = new Map()
  const memoryTurnActions = new Map()
  // Finding-Distillation buckets mirror the Host Store layout:
  //   distillRuns / distillFingerprints: `ws:<workspaceId>` → array
  //   distillPlans: `run:<runId>` → ChangePlan object
  const memoryDistillRuns = new Map()
  const memoryDistillPlans = new Map()
  const memoryDistillFingerprints = new Map()
  // Ids whose delete could not be persisted; hidden from reads until a write succeeds.
  const tombstones = new Map()
  const promptTombstones = new Map()
  const traceTombstones = new Map()
  const handoffTombstones = new Set()
  const memoryWorkspaceRecords = new Map()
  const memoryGroups = new Map()
  const knownWorkspaces = new Set()
  let memoryPrefs = null
  let quotaExceeded = false

  // Determine fetch implementation (avoid invalid URL errors in Node when no custom fetch is passed)
  const fetchFn = customFetch || (
    typeof window !== 'undefined' && typeof window.fetch === 'function'
      ? window.fetch.bind(window)
      : null
  )

  function notify() {
    for (const listener of listeners) {
      try { listener() } catch { /* subscriber failure must not break the store */ }
    }
  }

  function bump(workspaceKey) {
    if (!workspaceKey) return 0
    const next = (revisions.get(workspaceKey) ?? 0) + 1
    revisions.set(workspaceKey, next)
    return next
  }

  // Cross-tab storage synchronization if a Web Storage backend is explicitly attached
  const stopStorage = (storage && typeof eventTarget?.addEventListener === 'function')
    ? (() => {
        const onStorage = event => {
          if (!event || typeof event.key !== 'string' || !event.key.startsWith(PREFIX)) return
          const suffix = event.key.slice(PREFIX.length)
          const separator = suffix.indexOf('.')
          const kind = separator === -1 ? suffix : suffix.slice(0, separator)
          if (separator !== -1 && (kind === 'entries' || kind === 'promptlog')) {
            try {
              bump(decodeURIComponent(suffix.slice(separator + 1)))
            } catch {
              // A malformed key cannot name a workspace; still notify subscribers.
            }
          }
          notify()
        }
        eventTarget.addEventListener('storage', onStorage)
        return () => {
          if (typeof eventTarget.removeEventListener === 'function') {
            eventTarget.removeEventListener('storage', onStorage)
          }
        }
      })()
    : () => {}

  /**
   * Whether one workspace key still owns durable plugin data in this store.
   *
   * Empty buckets are residue from deleting the last row: the Host prunes them
   * on disk, but a hydrated snapshot (or a legacy Web Storage index) may still
   * carry one, and listing it would resurrect a deleted session as a phantom
   * Desk card. The empty check keeps `draft:global` and workspace paths intact
   * because those keys are not sessions.
   * @param {string} workspaceKey
   * @returns {boolean}
   */
  function workspaceKeyHasData(workspaceKey) {
    const entries = memoryEntries.get(workspaceKey)
    if (Array.isArray(entries) && entries.length > 0) return true
    const logs = memoryLog.get(workspaceKey)
    if (Array.isArray(logs) && logs.length > 0) return true
    const traces = memoryTraces.get(workspaceKey)
    if (Array.isArray(traces) && traces.length > 0) return true
    const turnActions = memoryTurnActions.get(workspaceKey)
    if (turnActions && Array.isArray(turnActions.items) && turnActions.items.length > 0) return true
    return false
  }

  function workspaceIndex() {
    if (storage) {
      // Heal any entries saved to undefined/null workspaceKey
      for (const badKey of ['undefined', 'null']) {
        try {
          const rawBad = readJson(storage, `${PREFIX}entries.${badKey}`, null)
          if (rawBad && Array.isArray(rawBad.entries)) {
            for (const item of rawBad.entries) {
              if (item.sessionId) {
                const targetKey = `session:${item.sessionId}`
                const cur = readJson(storage, `${PREFIX}entries.${targetKey.replace(/:/g, '.')}`, { entries: [] })
                writeJson(storage, `${PREFIX}entries.${targetKey.replace(/:/g, '.')}`, {
                  version: 1, rev: 1, updatedAt: now(),
                  entries: mergeById(cur.entries || [], [{ ...item, workspaceKey: targetKey, workspaceId: targetKey }]),
                })
              }
            }
            try { storage.removeItem(`${PREFIX}entries.${badKey}`) } catch {}
          }
        } catch {}
      }
      const index = readJson(storage, `${PREFIX}workspaces`, { keys: [] })
      if (Array.isArray(index.keys)) {
        for (const k of index.keys) knownWorkspaces.add(k)
      }
    }
    for (const [k, items] of memoryEntries) {
      if (Array.isArray(items) && items.length > 0) knownWorkspaces.add(k)
    }
    for (const [k, items] of memoryLog) {
      if (Array.isArray(items) && items.length > 0) knownWorkspaces.add(k)
    }
    for (const [k, items] of memoryTraces) {
      if (Array.isArray(items) && items.length > 0) knownWorkspaces.add(k)
    }
    for (const k of memoryWorkspaceRecords.keys()) knownWorkspaces.add(k)
    // `knownWorkspaces` also accumulates raw keys from hydration and the legacy
    // index; drop session keys that no longer have any row so a deleted session
    // cannot survive as an empty "untitled" Desk card.
    return [...knownWorkspaces].filter(key => sessionIdOfWorkspaceKey(key) === null || workspaceKeyHasData(key))
  }

  function ensureWorkspace(workspaceKey) {
    if (!workspaceKey) return
    knownWorkspaces.add(workspaceKey)
    if (storage) {
      const keys = workspaceIndex()
      if (!keys.includes(workspaceKey)) {
        if (!writeJson(storage, `${PREFIX}workspaces`, { keys: [...keys, workspaceKey] })) {
          quotaExceeded = true
        }
      }
    }
  }

  function entriesKey(workspaceKey) {
    return `${PREFIX}entries.${workspaceKeyPart(workspaceKey)}`
  }

  function promptLogKey(workspaceKey) {
    return `${PREFIX}promptlog.${workspaceKeyPart(workspaceKey)}`
  }

  function groupsKey(sessionIdOrWsKey) {
    return `${PREFIX}groups.${workspaceKeyPart(sessionIdOrWsKey)}`
  }

  function handoffKey(sessionId) {
    return `${PREFIX}handoff.${workspaceKeyPart(sessionId)}`
  }

  function canonicalCommitTraceSessionKey(sessionKey) {
    if (typeof sessionKey !== 'string') return ''
    const trimmed = sessionKey.trim()
    if (!trimmed) return ''
    return trimmed.startsWith('session:') ? trimmed : `session:${trimmed}`
  }

  function commitTracesKey(sessionKey) {
    const canonical = canonicalCommitTraceSessionKey(sessionKey)
    return `${PREFIX}committraces.${workspaceKeyPart(canonical)}`
  }

  function canonicalTurnActionsSessionKey(sessionKey) {
    if (typeof sessionKey !== 'string') return ''
    const trimmed = sessionKey.trim()
    if (!trimmed) return ''
    return trimmed.startsWith('session:') ? trimmed : `session:${trimmed}`
  }

  function turnActionsKey(sessionKey) {
    const canonical = canonicalTurnActionsSessionKey(sessionKey)
    return `${PREFIX}turnactions.${workspaceKeyPart(canonical)}`
  }

  function tombstoneSet(workspaceKey) {
    let ids = tombstones.get(workspaceKey)
    if (!ids) {
      ids = new Set()
      tombstones.set(workspaceKey, ids)
    }
    return ids
  }

  function promptTombstoneSet(workspaceKey) {
    let ids = promptTombstones.get(workspaceKey)
    if (!ids) {
      ids = new Set()
      promptTombstones.set(workspaceKey, ids)
    }
    return ids
  }

  function resolveSessionId(key) {
    if (!key || typeof key !== 'string') return ''
    return key.startsWith('session:') ? key.slice('session:'.length) : key
  }

  /**
   * Asynchronously synchronize mutation to Host storage file.
   * Completely non-blocking: memory state updates immediately, and host persists in background.
   */
  function syncToHost(action, payload) {
    if (hostStore) {
      try {
        switch (action) {
          case 'putEntry': return hostStore.putEntry?.(payload.entry)
          case 'putEntries': return hostStore.putEntries?.(payload.workspaceKey, payload.entries)
          case 'deleteEntry': return hostStore.deleteEntry?.(payload.workspaceKey, payload.id)
          case 'upsertPromptLog': return hostStore.upsertPromptLog?.(payload.workspaceKey, payload.entries)
          case 'deletePromptLog': return hostStore.deletePromptLog?.(payload.workspaceKey, payload.messageId)
          case 'putGroup': return hostStore.putGroup?.(payload.group)
          case 'putGroups': return hostStore.putGroups?.(payload.sessionId, payload.groups)
          case 'setHandoff': return hostStore.setHandoff?.(payload.sessionId, payload.value)
          case 'deleteHandoff': return hostStore.deleteHandoff?.(payload.sessionId)
          case 'setPrefs': return hostStore.setPrefs?.(payload.prefs)
          case 'putWorkspaceRecord': return hostStore.putWorkspaceRecord?.(payload.record)
          case 'putCommitTraces': return hostStore.putCommitTraces?.(payload.sessionKey, payload.traces)
          case 'putTurnActions': return hostStore.putTurnActions?.(payload.sessionKey, payload.state)
          case 'deleteTurnActions': return hostStore.deleteTurnActions?.(payload.sessionKey)
          case 'clearWorkspaceData': return hostStore.clearWorkspaceData?.(payload.workspaceId, payload.options)
          case 'clearCache': return hostStore.clearCache?.()
          default: return Promise.resolve()
        }
      } catch {
        return Promise.resolve()
      }
    }

    if (typeof fetchFn === 'function') {
      return fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...payload }),
      }).catch(() => {
        // Network or host unavailability does not throw
      })
    }

    return Promise.resolve()
  }

  /**
   * Load full serialized state from host into local in-memory cache.
   */
  function loadState(state) {
    if (!state || typeof state !== 'object') return

    if (state.entries && typeof state.entries === 'object') {
      for (const [wsKey, items] of Object.entries(state.entries)) {
        if (Array.isArray(items)) {
          const cur = memoryEntries.get(wsKey) ?? []
          memoryEntries.set(wsKey, mergeById(cur, items))
          knownWorkspaces.add(wsKey)
          bump(wsKey)
        }
      }
    }

    if (state.promptLogs && typeof state.promptLogs === 'object') {
      for (const [wsKey, items] of Object.entries(state.promptLogs)) {
        if (Array.isArray(items)) {
          const cur = memoryLog.get(wsKey) ?? []
          memoryLog.set(wsKey, mergeLog(cur, items))
          knownWorkspaces.add(wsKey)
          bump(wsKey)
        }
      }
    }

    if (state.groups && typeof state.groups === 'object') {
      for (const [sId, groupList] of Object.entries(state.groups)) {
        if (Array.isArray(groupList)) {
          const cleanId = resolveSessionId(sId)
          let mem = memoryGroups.get(cleanId)
          if (!mem) {
            mem = new Map()
            memoryGroups.set(cleanId, mem)
            memoryGroups.set(sId, mem)
            memoryGroups.set('session:' + cleanId, mem)
          }
          for (const g of groupList) {
            if (g && g.id) mem.set(g.id, g)
          }
          bump(`session:${cleanId}`)
        }
      }
    }

    if (Array.isArray(state.workspaceRecords)) {
      for (const rec of state.workspaceRecords) {
        if (rec && rec.id) {
          memoryWorkspaceRecords.set(rec.id, rec)
          knownWorkspaces.add(rec.id)
        }
      }
    }

    if (state.handoffs && typeof state.handoffs === 'object') {
      for (const [sId, val] of Object.entries(state.handoffs)) {
        memoryHandoff.set(sId, val)
      }
    }

    if (state.prefs && typeof state.prefs === 'object') {
      memoryPrefs = { ...(memoryPrefs ?? DEFAULT_PREFS), ...state.prefs }
    }

    if (Array.isArray(state.workspaces)) {
      for (const ws of state.workspaces) {
        knownWorkspaces.add(ws)
      }
    }

    if (state.commitTraces && typeof state.commitTraces === 'object') {
      for (const [sessionKey, items] of Object.entries(state.commitTraces)) {
        if (Array.isArray(items)) {
          const canonical = canonicalCommitTraceSessionKey(sessionKey)
          if (canonical) {
            const cur = memoryTraces.get(canonical) ?? []
            memoryTraces.set(canonical, mergeTraces(cur, items))
            bump(canonical)
          }
        }
      }
    }

    if (state.turnActions && typeof state.turnActions === 'object') {
      for (const [sessionKey, sessionState] of Object.entries(state.turnActions)) {
        if (!sessionState || typeof sessionState !== 'object') continue
        const canonical = canonicalTurnActionsSessionKey(sessionKey)
        if (canonical) {
          memoryTurnActions.set(canonical, sessionState)
          bump(canonical)
        }
      }
    }

    if (state.distillRuns && typeof state.distillRuns === 'object') {
      for (const [bucketKey, items] of Object.entries(state.distillRuns)) {
        if (!Array.isArray(items)) continue
        const cur = memoryDistillRuns.get(bucketKey) ?? []
        memoryDistillRuns.set(bucketKey, mergeById(cur, items))
        bump(bucketKey)
      }
    }

    if (state.distillPlans && typeof state.distillPlans === 'object') {
      for (const [planKey, plan] of Object.entries(state.distillPlans)) {
        if (!plan || typeof plan !== 'object') continue
        memoryDistillPlans.set(planKey, { ...plan })
        bump(planKey)
      }
    }

    if (state.distillFingerprints && typeof state.distillFingerprints === 'object') {
      for (const [bucketKey, items] of Object.entries(state.distillFingerprints)) {
        if (!Array.isArray(items)) continue
        const cur = memoryDistillFingerprints.get(bucketKey) ?? []
        memoryDistillFingerprints.set(bucketKey, mergeById(cur, items))
        bump(bucketKey)
      }
    }
  }

  /**
   * Hydrate in-memory store from Host storage.
   * Returns a promise resolving to true on successful hydration.
   */
  let hydrationPromise = null
  function hydrate() {
    if (hostStore && typeof hostStore.exportDump === 'function') {
      hydrationPromise = hostStore.exportDump().then(state => {
        if (state) {
          loadState(state)
          notify()
        }
        return true
      }).catch(() => false)
      return hydrationPromise
    }

    if (typeof fetchFn === 'function') {
      // POST without query params avoids Connection router query matching nuances
      hydrationPromise = fetchFn(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'dump' }),
      }).then(async res => {
        if (!res.ok) {
          // Fall back to GET if POST was rejected
          const url = endpoint.includes('?') ? `${endpoint}&action=dump` : `${endpoint}?action=dump`
          const getRes = await fetchFn(url, {
            method: 'GET',
            headers: { 'cache-control': 'no-store' },
          }).catch(() => null)
          if (!getRes?.ok) return false
          const data = await getRes.json().catch(() => null)
          if (data?.ok && data?.state) {
            loadState(data.state)
            notify()
            return true
          }
          return false
        }
        const data = await res.json()
        if (data?.ok && data?.state) {
          loadState(data.state)
          notify()
          return true
        }
        return false
      }).catch(() => false)
      return hydrationPromise
    }

    return Promise.resolve(false)
  }

  const initialHydration = autoHydrate ? hydrate().catch(() => false) : Promise.resolve(false)

  /**
   * Read directly from a legacy Web Storage backend while the Host migration is
   * still pending. This keeps previously-local data visible (and durable) when
   * the Host half is unavailable, instead of rendering an empty desk and then
   * discarding the only copy. Reads and writes are mirrored, so a later
   * successful migration still captures everything.
   * @param {object} legacyStorage
   * @returns {boolean} whether the fallback was attached
   */
  function attachLegacyStorage(legacyStorage) {
    if (!legacyStorage || typeof legacyStorage.getItem !== 'function') return false
    storage = legacyStorage
    notify()
    return true
  }

  /**
   * Stop reading from the legacy fallback once migration is verified.
   * @returns {boolean} whether a fallback was attached
   */
  function detachLegacyStorage() {
    if (storage == null) return false
    storage = null
    notify()
    return true
  }

  async function listEntries(workspaceKey) {
    const data = storage ? readJson(storage, entriesKey(workspaceKey), { entries: [] }) : { entries: [] }
    const stored = Array.isArray(data.entries) ? data.entries : []
    const merged = mergeById(stored, memoryEntries.get(workspaceKey) ?? [])
    const hidden = tombstones.get(workspaceKey)
    const result = hidden ? merged.filter(item => !hidden.has(item.id)) : merged
    const sanitize = (list) => list.map(item => {
      if (item && item.kind === 'finding' && item.status === 'archived') {
        return { ...item, status: 'resolved', reviewStatus: 'resolved' }
      }
      return item
    })

    if (result.length > 0) return sanitize(result)

    // Fallback: If not found under workspaceKey, scan legacy session keys
    if (typeof workspaceKey === 'string' && !workspaceKey.startsWith('session:') && !workspaceKey.startsWith('draft:')) {
      if (storage) {
        const sessionLegacyData = readJson(storage, entriesKey(`session:${workspaceKey}`), null)
        if (sessionLegacyData && Array.isArray(sessionLegacyData.entries) && sessionLegacyData.entries.length > 0) {
          return sessionLegacyData.entries
        }
      } else {
        const sessionMem = memoryEntries.get(`session:${workspaceKey}`)
        if (sessionMem && sessionMem.length > 0) return sanitize(sessionMem)
      }
      const legacyKeys = workspaceIndex().filter(k => typeof k === 'string' && k.startsWith('session:'))
      const matching = []
      for (const legKey of legacyKeys) {
        const legEntries = storage
          ? (readJson(storage, entriesKey(legKey), null)?.entries || [])
          : (memoryEntries.get(legKey) || [])
        for (const entry of legEntries) {
          if (entry.workspaceId === workspaceKey || entry.workspaceKey === workspaceKey) {
            matching.push(entry)
          }
        }
      }
      if (matching.length > 0) {
        return sanitize(mergeById([], matching))
      }
    }
    return sanitize(result)
  }

  async function putEntry(entry) {
    if (!entry || !entry.id) return
    const wsKey = entry.workspaceKey || (entry.sessionId ? `session:${entry.sessionId}` : 'draft:global')
    const normalized = { ...entry, workspaceKey: wsKey }
    ensureWorkspace(wsKey)
    const current = await listEntries(wsKey)
    const next = mergeById(current, [normalized])
    memoryEntries.set(wsKey, next)

    if (storage) {
      const ok = writeJson(storage, entriesKey(wsKey), {
        version: 1, rev: bump(wsKey), updatedAt: now(), entries: next,
      })
      if (!ok) {
        quotaExceeded = true
      } else {
        tombstones.delete(wsKey)
      }
    } else {
      bump(wsKey)
    }

    notify()
    await syncToHost('putEntry', { entry: normalized })
  }

  async function putEntries(workspaceKey, entries) {
    ensureWorkspace(workspaceKey)
    const safeEntries = Array.isArray(entries) ? entries : []
    memoryEntries.set(workspaceKey, safeEntries)

    if (storage) {
      const ok = writeJson(storage, entriesKey(workspaceKey), {
        version: 1, rev: bump(workspaceKey), updatedAt: now(), entries: safeEntries,
      })
      if (!ok) {
        quotaExceeded = true
      }
      tombstones.delete(workspaceKey)
    } else {
      bump(workspaceKey)
    }

    notify()
    await syncToHost('putEntries', { workspaceKey, entries: safeEntries })
  }

  async function deleteEntry(workspaceKey, id) {
    // Defensive swap: if arguments were reversed (e.g. deleteEntry(id, workspaceKey))
    if (typeof id === 'string' && (id.startsWith('session:') || id === 'draft:global') && !workspaceKey.startsWith('session:') && workspaceKey !== 'draft:global') {
      const temp = workspaceKey
      workspaceKey = id
      id = temp
    }
    const current = await listEntries(workspaceKey)
    const next = current.filter(item => item.id !== id)
    memoryEntries.set(workspaceKey, next)

    if (storage) {
      const ok = writeJson(storage, entriesKey(workspaceKey), {
        version: 1, rev: bump(workspaceKey), updatedAt: now(), entries: next,
      })
      if (!ok) {
        quotaExceeded = true
        tombstoneSet(workspaceKey).add(id)
        return
      }
      tombstones.delete(workspaceKey)
    } else {
      bump(workspaceKey)
    }

    notify()
    await syncToHost('deleteEntry', { workspaceKey, id })
  }

  async function listPromptLog(workspaceKey, filter) {
    const data = storage ? readJson(storage, promptLogKey(workspaceKey), { entries: [] }) : { entries: [] }
    const stored = Array.isArray(data.entries) ? data.entries : []
    const merged = mergeLog(stored, memoryLog.get(workspaceKey) ?? [])
    const hidden = promptTombstones.get(workspaceKey)
    const list = hidden ? merged.filter(item => !hidden.has(item.messageId)) : merged
    if (!filter || typeof filter !== 'object') return list
    return list.filter(item => {
      for (const [key, val] of Object.entries(filter)) {
        if (item[key] !== val) return false
      }
      return true
    })
  }

  async function upsertPromptLog(workspaceKey, entries) {
    ensureWorkspace(workspaceKey)
    const current = await listPromptLog(workspaceKey)
    const next = mergeLog(current, entries)
    memoryLog.set(workspaceKey, next)

    if (storage) {
      const ok = writeJson(storage, promptLogKey(workspaceKey), {
        version: 1, rev: bump(workspaceKey), updatedAt: now(), entries: next,
      })
      if (!ok) {
        quotaExceeded = true
      } else {
        promptTombstones.delete(workspaceKey)
      }
    } else {
      bump(workspaceKey)
    }

    notify()
    await syncToHost('upsertPromptLog', { workspaceKey, entries })
  }

  async function deletePromptLog(workspaceKey, messageId) {
    const current = await listPromptLog(workspaceKey)
    const next = current.filter(item => item.messageId !== messageId)
    if (next.length === current.length) return
    memoryLog.set(workspaceKey, next)

    if (storage) {
      const ok = writeJson(storage, promptLogKey(workspaceKey), {
        version: 1, rev: bump(workspaceKey), updatedAt: now(), entries: next,
      })
      if (!ok) {
        quotaExceeded = true
        promptTombstoneSet(workspaceKey).add(messageId)
      } else {
        promptTombstones.delete(workspaceKey)
      }
    } else {
      bump(workspaceKey)
    }

    notify()
    await syncToHost('deletePromptLog', { workspaceKey, messageId })
  }

  async function setHandoff(sessionId, value) {
    memoryHandoff.set(sessionId, value)
    handoffTombstones.delete(sessionId)

    if (storage) {
      if (writeJson(storage, handoffKey(sessionId), value)) {
        handoffTombstones.delete(sessionId)
      } else {
        quotaExceeded = true
      }
    }

    notify()
    await syncToHost('setHandoff', { sessionId, value })
  }

  async function getHandoff(sessionId) {
    if (handoffTombstones.has(sessionId)) return null
    if (memoryHandoff.has(sessionId)) return memoryHandoff.get(sessionId)
    if (storage) {
      return readJson(storage, handoffKey(sessionId), null)
    }
    return null
  }

  async function deleteHandoff(sessionId) {
    memoryHandoff.delete(sessionId)
    if (storage) {
      try {
        if (typeof storage.removeItem === 'function') {
          storage.removeItem(handoffKey(sessionId))
        } else {
          storage.setItem(handoffKey(sessionId), 'null')
        }
        handoffTombstones.delete(sessionId)
      } catch {
        quotaExceeded = true
        handoffTombstones.add(sessionId)
      }
    }
    notify()
    await syncToHost('deleteHandoff', { sessionId })
  }

  async function listWorkspaceRecords() {
    const data = storage ? readJson(storage, `${PREFIX}workspace_records`, { records: [] }) : { records: [] }
    const stored = Array.isArray(data.records) ? data.records : []
    const map = new Map(stored.map(r => [r.id, r]))
    for (const [id, r] of memoryWorkspaceRecords.entries()) {
      map.set(id, r)
    }
    const knownKeys = workspaceIndex()
    for (const key of knownKeys) {
      if (key && !key.startsWith('draft:') && !key.startsWith('session:') && !map.has(key)) {
        map.set(key, {
          id: key,
          name: key,
          path: key,
          gitBranch: '',
          status: 'active',
          specSyncStatus: 'synced',
          createdAt: 0,
          updatedAt: 0,
        })
      }
    }
    return [...map.values()]
  }

  async function putWorkspaceRecord(record) {
    const check = validateWorkspaceRecord(record)
    if (!check.ok) throw new Error(check.errors.join('; '))
    ensureWorkspace(record.id)
    memoryWorkspaceRecords.set(record.id, record)

    if (storage) {
      const current = await listWorkspaceRecords()
      const map = new Map(current.map(r => [r.id, r]))
      map.set(record.id, record)
      const records = [...map.values()]
      const ok = writeJson(storage, `${PREFIX}workspace_records`, {
        version: 1, updatedAt: now(), records,
      })
      if (!ok) {
        quotaExceeded = true
      }
    }

    notify()
    await syncToHost('putWorkspaceRecord', { record })
  }

  async function getGroups(sessionIdOrWsKey) {
    const raw = sessionIdOrWsKey || ''
    const cleanId = resolveSessionId(raw)
    if (!cleanId) return []

    let stored = []
    if (storage) {
      let data = readJson(storage, `${PREFIX}groups.${workspaceKeyPart(cleanId)}`, null)
      if (!data || !Array.isArray(data.groups) || data.groups.length === 0) {
        const fallback = readJson(storage, `${PREFIX}groups.${workspaceKeyPart(raw)}`, null)
        if (fallback && Array.isArray(fallback.groups) && fallback.groups.length > 0) {
          data = fallback
        }
      }
      stored = Array.isArray(data?.groups) ? data.groups : []
    }
    const map = new Map(stored.map(g => [g.id, g]))

    const mem1 = memoryGroups.get(cleanId)
    if (mem1) for (const [id, g] of mem1.entries()) map.set(id, g)
    const mem2 = memoryGroups.get(raw)
    if (mem2 && mem2 !== mem1) for (const [id, g] of mem2.entries()) map.set(id, g)

    return [...map.values()].sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0))
  }

  /**
   * Findings index for one session, assembled at group-write time so
   * `validateGroupRecord` can enforce invariant I2 (plan Phase 4 / B6): every
   * group item must resolve to a persisted finding of the same session.
   * Read paths (`getGroups`) stay index-free so legacy groups remain readable.
   *
   * @param {string} sessionId
   * @returns {Promise<Map<string, object>>}
   */
  async function findingsIndexForSession(sessionId) {
    const index = new Map()
    const cleanId = resolveSessionId(sessionId)
    if (!cleanId) return index
    const list = await listEntries(`session:${cleanId}`)
    for (const item of list) {
      if (item && typeof item.id === 'string' && item.id !== '') index.set(item.id, item)
    }
    return index
  }

  async function putGroup(group) {
    const findingsById = await findingsIndexForSession(group?.sessionId)
    const check = validateGroupRecord(group, findingsById)
    if (!check.ok) throw new Error(check.errors.join('; '))
    const cleanId = resolveSessionId(group.sessionId)

    let mem = memoryGroups.get(cleanId)
    if (!mem) {
      mem = new Map()
      memoryGroups.set(cleanId, mem)
      memoryGroups.set(group.sessionId, mem)
      memoryGroups.set('session:' + cleanId, mem)
    }
    mem.set(group.id, group)

    if (storage) {
      const current = await getGroups(cleanId)
      const map = new Map(current.map(g => [g.id, g]))
      map.set(group.id, group)
      const groups = [...map.values()].sort((a, b) => (a.groupNumber ?? 0) - (b.groupNumber ?? 0))

      const keyClean = `${PREFIX}groups.${workspaceKeyPart(cleanId)}`
      const keyRaw = `${PREFIX}groups.${workspaceKeyPart(group.sessionId)}`
      const keySession = `${PREFIX}groups.${workspaceKeyPart('session:' + cleanId)}`

      writeJson(storage, keyClean, { version: 1, updatedAt: now(), groups })
      writeJson(storage, keyRaw, { version: 1, updatedAt: now(), groups })
      writeJson(storage, keySession, { version: 1, updatedAt: now(), groups })
    }

    notify()
    await syncToHost('putGroup', { group })
  }

  async function putGroups(sessionIdOrWsKey, groups) {
    const raw = sessionIdOrWsKey || ''
    const cleanId = resolveSessionId(raw)
    if (!cleanId) return
    const safeGroups = Array.isArray(groups) ? groups : []

    if (safeGroups.length === 0) {
      memoryGroups.delete(cleanId)
      memoryGroups.delete(raw)
      memoryGroups.delete('session:' + cleanId)
      if (storage) {
        const keyClean = `${PREFIX}groups.${workspaceKeyPart(cleanId)}`
        const keyRaw = `${PREFIX}groups.${workspaceKeyPart(raw)}`
        const keySession = `${PREFIX}groups.${workspaceKeyPart('session:' + cleanId)}`
        try {
          storage?.removeItem?.(keyClean)
          storage?.removeItem?.(keyRaw)
          storage?.removeItem?.(keySession)
        } catch {}
      }
    } else {
      memoryGroups.set(cleanId, new Map(safeGroups.map(g => [g.id, g])))
      memoryGroups.set(raw, new Map(safeGroups.map(g => [g.id, g])))
      memoryGroups.set('session:' + cleanId, new Map(safeGroups.map(g => [g.id, g])))
      if (storage) {
        const keyClean = `${PREFIX}groups.${workspaceKeyPart(cleanId)}`
        const keyRaw = `${PREFIX}groups.${workspaceKeyPart(raw)}`
        const keySession = `${PREFIX}groups.${workspaceKeyPart('session:' + cleanId)}`
        const data = { version: 1, updatedAt: now(), groups: safeGroups }
        writeJson(storage, keyClean, data)
        writeJson(storage, keyRaw, data)
        writeJson(storage, keySession, data)
      }
    }

    bump(`session:${cleanId}`)
    notify()
    await syncToHost('putGroups', { sessionId: cleanId, groups: safeGroups })
  }

  async function listCommitTraces(sessionKey) {
    const canonical = canonicalCommitTraceSessionKey(sessionKey)
    if (!canonical) return []
    const data = storage ? readJson(storage, commitTracesKey(canonical), { entries: [] }) : { entries: [] }
    const stored = Array.isArray(data.entries) ? data.entries : []
    const merged = mergeTraces(stored, memoryTraces.get(canonical) ?? [])
    const hidden = traceTombstones.get(canonical)
    const list = hidden ? merged.filter(item => !hidden.has(item.id)) : merged
    return list
  }

  async function putCommitTraces(sessionKey, traces) {
    const canonical = canonicalCommitTraceSessionKey(sessionKey)
    if (!canonical || !Array.isArray(traces) || traces.length === 0) return
    const current = await listCommitTraces(canonical)
    const next = mergeTraces(current, traces)
    memoryTraces.set(canonical, next)

    if (storage) {
      const ok = writeJson(storage, commitTracesKey(canonical), {
        version: 1, rev: bump(canonical), updatedAt: now(), entries: next,
      })
      if (!ok) {
        quotaExceeded = true
      } else {
        quotaExceeded = false
      }
    }
    bump(canonical)
    notify()
    await syncToHost('putCommitTraces', { sessionKey: canonical, traces })
  }

  async function lookupCommitTraces(query = {}) {
    if (hostStore && typeof hostStore.lookupCommitTraces === 'function') {
      return await hostStore.lookupCommitTraces(query)
    }
    if (typeof fetchFn === 'function') {
      const qs = new URLSearchParams()
      if (query.workspaceId) qs.set('workspaceId', query.workspaceId)
      if (query.hash) qs.set('hash', query.hash)
      if (query.limit) qs.set('limit', String(query.limit))
      const base = endpoint.replace(/\/store\b.*$/, '')
      const url = `${base}/commit-trace-lookup?${qs.toString()}`
      try {
        const res = await fetchFn(url, { method: 'GET', headers: { 'cache-control': 'no-store' } })
        if (res && typeof res.json === 'function') {
          const data = await res.json()
          if (data && data.ok) return { matches: data.matches || [] }
        }
      } catch {}
    }
    // In-memory fallback
    const targetWs = query.workspaceId
    const normalizedHash = (query.hash || '').toLowerCase()
    const maxLimit = Math.min(20, Math.max(1, Number(query.limit) || 20))
    const matches = []
    for (const traces of memoryTraces.values()) {
      if (!Array.isArray(traces)) continue
      for (const trace of traces) {
        if (!trace || trace.workspaceId !== targetWs || trace.status !== 'complete') continue
        if (!Array.isArray(trace.commits)) continue
        for (const commit of trace.commits) {
          if (!commit || typeof commit.hash !== 'string') continue
          if (commit.hash.toLowerCase().startsWith(normalizedHash)) {
            matches.push({
              traceId: trace.id,
              sessionId: trace.sessionId,
              turn: trace.turn,
              groupIds: Array.isArray(trace.groupIds) ? [...trace.groupIds] : [],
              findingIds: Array.isArray(trace.findingIds) ? [...trace.findingIds] : [],
              commit: {
                hash: commit.hash,
                shortHash: commit.shortHash || commit.hash.slice(0, 7),
                subject: commit.subject || '',
                time: commit.time ?? 0,
              },
              capturedAt: trace.capturedAt ?? 0,
            })
          }
        }
      }
    }
    matches.sort((a, b) => (b.capturedAt ?? 0) - (a.capturedAt ?? 0))
    return { matches: matches.slice(0, maxLimit) }
  }

  async function listTurnActions(sessionKey) {
    const canonical = canonicalTurnActionsSessionKey(sessionKey)
    if (!canonical) return null
    if (memoryTurnActions.has(canonical)) {
      return memoryTurnActions.get(canonical)
    }
    if (storage) {
      const data = readJson(storage, turnActionsKey(canonical), null)
      if (data && typeof data === 'object') {
        memoryTurnActions.set(canonical, data)
        return data
      }
    }
    return null
  }

  async function putTurnActions(sessionKey, turnState) {
    const canonical = canonicalTurnActionsSessionKey(sessionKey)
    if (!canonical || !turnState || typeof turnState !== 'object') return
    const prev = await listTurnActions(canonical)
    const sessionId = turnState.sessionId || prev?.sessionId || canonical.slice('session:'.length)
    const rawItems = Array.isArray(turnState.items) ? turnState.items : (Array.isArray(prev?.items) ? prev.items : [])
    const items = pruneTurnActionItems(rawItems, 500)
    const next = {
      version: typeof turnState.version === 'number' ? turnState.version : 1,
      sessionId,
      scannedThroughSeq: Number.isFinite(turnState.scannedThroughSeq) ? turnState.scannedThroughSeq : (prev?.scannedThroughSeq ?? 0),
      scannedAt: typeof turnState.scannedAt === 'number' ? turnState.scannedAt : now(),
      items,
    }
    memoryTurnActions.set(canonical, next)
    if (storage) {
      const ok = writeJson(storage, turnActionsKey(canonical), next)
      if (!ok) quotaExceeded = true
      else quotaExceeded = false
    }
    bump(canonical)
    notify()
    await syncToHost('putTurnActions', { sessionKey: canonical, state: next })
  }

  async function deleteTurnActions(sessionKey) {
    const canonical = canonicalTurnActionsSessionKey(sessionKey)
    if (!canonical) return
    memoryTurnActions.delete(canonical)
    if (storage) {
      try { storage?.removeItem?.(turnActionsKey(canonical)) } catch {}
    }
    bump(canonical)
    notify()
    await syncToHost('deleteTurnActions', { sessionKey: canonical })
  }

  async function clearWorkspaceData(workspaceId, {
    preservePinned = true,
    sessionIds = [],
    sessionId,
    clearFindings = true,
    clearGroups = true,
    clearPromptLogs = true,
    clearDrafts = false,
    clearCommitTraces = true,
    clearDistillRuns = true,
    clearDistillFingerprints = true,
  } = {}) {
    if (!workspaceId) return
    const cleanWs = resolveSessionId(workspaceId)
    const targetSessionIds = new Set()

    if (sessionId) targetSessionIds.add(resolveSessionId(sessionId))
    if (Array.isArray(sessionIds)) {
      for (const id of sessionIds) {
        if (id) targetSessionIds.add(resolveSessionId(id))
      }
    }
    if (workspaceId.startsWith('session:')) {
      targetSessionIds.add(cleanWs)
    }

    const allWs = await listWorkspaceRecords()
    const thisRecord = allWs.find(w => w.id === workspaceId || w.id === cleanWs)
    if (thisRecord && Array.isArray(thisRecord.sessionIds)) {
      for (const id of thisRecord.sessionIds) {
        if (id) targetSessionIds.add(resolveSessionId(id))
      }
    }

    // Storage legacy cleanup
    try {
      if (typeof storage?.length === 'number') {
        const groupsKeysToRemove = []
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i)
          if (!key) continue
          if (key.startsWith(`${PREFIX}entries.`)) {
            const entries = readJson(storage, key, [])
            if (Array.isArray(entries)) {
              for (const e of entries) {
                if (e.workspaceId === workspaceId || e.workspaceId === cleanWs || e.workspaceKey === workspaceId || e.workspaceKey === cleanWs) {
                  if (e.sessionId) targetSessionIds.add(resolveSessionId(e.sessionId))
                }
              }
            }
          } else if (key.startsWith(`${PREFIX}groups.`)) {
            const data = readJson(storage, key, null)
            const grps = Array.isArray(data?.groups) ? data.groups : []
            for (const g of grps) {
              if (g.workspaceId === workspaceId || g.workspaceId === cleanWs) {
                if (g.sessionId) targetSessionIds.add(resolveSessionId(g.sessionId))
              }
            }
            if (clearGroups) {
              const unpinnedBelonging = grps.filter(g => (g.workspaceId === workspaceId || g.workspaceId === cleanWs) && (!preservePinned || !g.pinned))
              if (unpinnedBelonging.length > 0) {
                const remainingGrps = preservePinned ? grps.filter(g => (g.workspaceId !== workspaceId && g.workspaceId !== cleanWs) || g.pinned) : []
                if (remainingGrps.length === 0) {
                  groupsKeysToRemove.push(key)
                } else {
                  writeJson(storage, key, { version: 1, updatedAt: now(), groups: remainingGrps })
                }
              }
            }
          }
        }
        for (const k of groupsKeysToRemove) storage.removeItem(k)
      }
    } catch {}

    // Find sessions in memory
    for (const [sId, groupMap] of memoryGroups.entries()) {
      for (const g of groupMap.values()) {
        if (g.workspaceId === workspaceId || g.workspaceId === cleanWs) {
          targetSessionIds.add(resolveSessionId(sId))
        }
      }
    }
    for (const [wsKey, items] of memoryEntries.entries()) {
      for (const it of items) {
        if (it.workspaceId === workspaceId || it.workspaceId === cleanWs || it.workspaceKey === workspaceId || it.workspaceKey === cleanWs) {
          if (it.sessionId) targetSessionIds.add(resolveSessionId(it.sessionId))
        }
      }
    }

    const allPreservedFindingIds = new Set()
    const cleanedSessionKeys = new Set()

    for (const sId of targetSessionIds) {
      if (!sId || (sId === cleanWs && !workspaceId.startsWith('session:'))) continue
      const sKey = `session:${sId}`
      const cleanSId = resolveSessionId(sId)
      const groups = await getGroups(sId)
      const pinnedGroups = groups.filter(g => Boolean(g.pinned))
      const pinnedFindingIds = new Set()
      for (const pg of pinnedGroups) {
        for (const it of pg.items || []) {
          if (it.findingId) {
            pinnedFindingIds.add(it.findingId)
            allPreservedFindingIds.add(it.findingId)
          }
        }
      }

      // Group handling
      if (clearGroups) {
        const remainingGroups = preservePinned ? pinnedGroups : []
        if (remainingGroups.length === 0) {
          try {
            storage?.removeItem?.(groupsKey(sId))
            storage?.removeItem?.(groupsKey(sKey))
            storage?.removeItem?.(groupsKey(cleanSId))
            storage?.removeItem?.(groupsKey('session:' + cleanSId))
          } catch {}
          memoryGroups.delete(sId)
          memoryGroups.delete(sKey)
          memoryGroups.delete(cleanSId)
          memoryGroups.delete('session:' + cleanSId)
        } else {
          await putGroups(sId, remainingGroups)
          memoryGroups.set(sId, new Map(remainingGroups.map(g => [g.id, g])))
          memoryGroups.set(sKey, new Map(remainingGroups.map(g => [g.id, g])))
        }
      }

      // Entries handling
      if (clearFindings) {
        const entries = await listEntries(sKey)
        const preservedEntries = []
        for (const e of entries) {
          const isPinned = preservePinned && (
            pinnedFindingIds.has(e.id) ||
            (e.assignedGroupId && pinnedGroups.some(g => g.id === e.assignedGroupId))
          )
          if (isPinned) {
            preservedEntries.push(e)
            allPreservedFindingIds.add(e.id)
          }
        }

        if (preservedEntries.length === 0) {
          try {
            storage?.removeItem?.(entriesKey(sKey))
            storage?.removeItem?.(entriesKey(sId))
          } catch {}
          memoryEntries.delete(sKey)
          memoryEntries.delete(sId)
          tombstones.delete(sKey)
          tombstones.delete(sId)
        } else {
          await putEntries(sKey, preservedEntries)
          memoryEntries.set(sKey, preservedEntries)
          memoryEntries.set(sId, preservedEntries)
          tombstones.delete(sKey)
          tombstones.delete(sId)
        }
      }

      // Reconcile group/finding cross-references after category switches:
      // a surviving group must not keep items for deleted findings, and a
      // surviving finding must not keep a deleted group id.
      {
        const groupsNow = await getGroups(sId)
        const entriesNow = await listEntries(sKey)
        const remainingGroupIds = new Set(groupsNow.map(g => g.id))
        const remainingEntryIds = new Set(entriesNow.map(e => e.id))

        let groupsChanged = false
        const nextGroups = groupsNow.map(g => {
          const items = Array.isArray(g.items) ? g.items : []
          const kept = items.filter(item => item?.findingId && remainingEntryIds.has(item.findingId))
          if (kept.length === items.length) return g
          groupsChanged = true
          return { ...g, items: kept }
        })
        if (groupsChanged) {
          await putGroups(sId, nextGroups)
          memoryGroups.set(sId, new Map(nextGroups.map(g => [g.id, g])))
          memoryGroups.set(sKey, new Map(nextGroups.map(g => [g.id, g])))
        }

        let entriesChanged = false
        const nextEntries = entriesNow.map(entry => {
          if (!entry?.assignedGroupId || remainingGroupIds.has(entry.assignedGroupId)) return entry
          entriesChanged = true
          const { assignedGroupId, ...rest } = entry
          return rest
        })
        if (entriesChanged) {
          await putEntries(sKey, nextEntries)
          memoryEntries.set(sKey, nextEntries)
          memoryEntries.set(sId, nextEntries)
        }
      }

      // PromptLogs handling
      if (clearPromptLogs) {
        try {
          storage?.removeItem?.(`${PREFIX}promptlog.${workspaceKeyPart(sId)}`)
          storage?.removeItem?.(`${PREFIX}promptlog.${workspaceKeyPart(sKey)}`)
        } catch {}
        memoryLog.delete(sId)
        memoryLog.delete(sKey)
      }

      const turnActionKey = `session:${sId}`
      memoryTurnActions.delete(turnActionKey)
      memoryTurnActions.delete(sId)
      if (storage) {
        try {
          storage.removeItem(turnActionsKey(turnActionKey))
          storage.removeItem(turnActionsKey(sId))
        } catch {}
      }
      bump(turnActionKey)

      const remainingGroupsNow = await getGroups(sId)
      const remainingEntriesNow = await listEntries(sKey)
      if (remainingGroupsNow.length === 0 && remainingEntriesNow.length === 0) {
        cleanedSessionKeys.add(sKey)
        cleanedSessionKeys.add(sId)
      }
    }

    // Clean up empty session keys & any errant workspaceId keys from the workspaces index
    try {
      const currentKeys = workspaceIndex()
      const sanitizedKeys = currentKeys.filter(k => {
        if (cleanedSessionKeys.has(k)) return false
        if (!workspaceId.startsWith('session:') && (k === `session:${cleanWs}` || k === cleanWs)) return false
        return true
      })
      if (sanitizedKeys.length !== currentKeys.length) {
        if (storage) writeJson(storage, `${PREFIX}workspaces`, { keys: sanitizedKeys })
        knownWorkspaces.clear()
        for (const k of sanitizedKeys) knownWorkspaces.add(k)
      }
    } catch {}

    // Clean errant session:workspaceId or raw workspaceId entry storage if exists
    if (!workspaceId.startsWith('session:')) {
      try {
        if (clearFindings) {
          storage?.removeItem?.(entriesKey(`session:${cleanWs}`))
          storage?.removeItem?.(entriesKey(cleanWs))
          memoryEntries.delete(`session:${cleanWs}`)
          memoryEntries.delete(cleanWs)
        }
        if (clearGroups) {
          storage?.removeItem?.(groupsKey(cleanWs))
          storage?.removeItem?.(groupsKey(`session:${cleanWs}`))
          memoryGroups.delete(cleanWs)
          memoryGroups.delete(`session:${cleanWs}`)
        }
        if (clearPromptLogs) {
          storage?.removeItem?.(`${PREFIX}promptlog.${workspaceKeyPart(cleanWs)}`)
          storage?.removeItem?.(`${PREFIX}promptlog.${workspaceKeyPart(`session:${cleanWs}`)}`)
          memoryLog.delete(cleanWs)
          memoryLog.delete(`session:${cleanWs}`)
        }
        knownWorkspaces.delete(cleanWs)
        knownWorkspaces.delete(`session:${cleanWs}`)
      } catch {}
    }

    // Drafts are one logical pool with a per-draft visibility scope: clearing a
    // workspace only drops that workspace's `workspace` drafts; the shared
    // global pool and other workspaces' drafts stay intact.
    if (clearDrafts) {
      try {
        const draftKey = 'draft:global'
        const current = await listEntries(draftKey)
        const owners = new Set([String(workspaceId), String(cleanWs)])
        const remaining = current.filter(item => !(item?.kind === 'draft'
          && item.visibility === 'workspace'
          && owners.has(String(item.workspaceId))))
        memoryEntries.set(draftKey, remaining)
        if (storage) {
          if (remaining.length === 0) {
            storage.removeItem?.(entriesKey(draftKey))
          } else {
            writeJson(storage, entriesKey(draftKey), {
              version: 1, rev: bump(draftKey), updatedAt: now(), entries: remaining,
            })
          }
        } else {
          bump(draftKey)
        }
        tombstones.delete(draftKey)
      } catch {}
    }

    if (clearCommitTraces) {
      const isSessionTarget = workspaceId.startsWith('session:')
      const targetCleanSession = isSessionTarget ? workspaceId.slice('session:'.length) : null

      for (const [sKey, traceList] of memoryTraces.entries()) {
        const cleanSId = sKey.startsWith('session:') ? sKey.slice('session:'.length) : sKey
        const matchesSession = isSessionTarget
          ? cleanSId === targetCleanSession
          : targetSessionIds.has(cleanSId)

        const remaining = traceList.filter(t => {
          if (!t) return false
          if (matchesSession) return false
          if (!isSessionTarget && t.workspaceId === workspaceId) return false
          return true
        })

        if (remaining.length !== traceList.length) {
          if (remaining.length > 0) {
            memoryTraces.set(sKey, remaining)
          } else {
            memoryTraces.delete(sKey)
          }
          if (storage) {
            if (remaining.length > 0) {
              writeJson(storage, commitTracesKey(sKey), { version: 1, rev: bump(sKey), updatedAt: now(), entries: remaining })
            } else {
              try { storage?.removeItem?.(commitTracesKey(sKey)) } catch {}
            }
          }
          bump(sKey)
        }
      }
    }

    // Distillation buckets are workspace-scoped; plans follow their run.
    if (clearDistillRuns || clearDistillFingerprints) {
      const owners = new Set([String(workspaceId), String(cleanWs)])
      const bucketOwners = new Set([`ws:${workspaceId}`, `ws:${cleanWs}`])
      const removedRunIds = new Set()

      if (clearDistillRuns) {
        for (const [bucketKey, list] of [...memoryDistillRuns.entries()]) {
          if (!Array.isArray(list)) continue
          const bucketWs = bucketKey.startsWith('ws:') ? bucketKey.slice('ws:'.length) : bucketKey
          const keyMatch = bucketOwners.has(bucketKey) || owners.has(bucketWs)
          const remaining = list.filter(run => {
            if (!run || typeof run !== 'object') return false
            const match = keyMatch || (typeof run.workspaceId === 'string' && owners.has(run.workspaceId))
            if (match && run.id) removedRunIds.add(run.id)
            return !match
          })
          if (remaining.length !== list.length) {
            if (remaining.length > 0) memoryDistillRuns.set(bucketKey, remaining)
            else memoryDistillRuns.delete(bucketKey)
            bump(bucketKey)
          }
        }
        for (const [planKey, plan] of [...memoryDistillPlans.entries()]) {
          const runId = planKey.startsWith('run:') ? planKey.slice('run:'.length) : planKey
          const planWorkspace = plan && typeof plan.workspaceId === 'string' ? plan.workspaceId : ''
          if (removedRunIds.has(runId) || (planWorkspace && owners.has(planWorkspace))) {
            memoryDistillPlans.delete(planKey)
            bump(planKey)
          }
        }
      }

      if (clearDistillFingerprints) {
        for (const [bucketKey, list] of [...memoryDistillFingerprints.entries()]) {
          if (!Array.isArray(list)) continue
          const bucketWs = bucketKey.startsWith('ws:') ? bucketKey.slice('ws:'.length) : bucketKey
          const keyMatch = bucketOwners.has(bucketKey) || owners.has(bucketWs)
          const remaining = list.filter(fingerprint => {
            if (!fingerprint || typeof fingerprint !== 'object') return false
            if (keyMatch) return false
            return !(typeof fingerprint.workspaceId === 'string' && owners.has(fingerprint.workspaceId))
          })
          if (remaining.length !== list.length) {
            if (remaining.length > 0) memoryDistillFingerprints.set(bucketKey, remaining)
            else memoryDistillFingerprints.delete(bucketKey)
            bump(bucketKey)
          }
        }
      }
    }

    bump(cleanWs)
    bump(workspaceId)
    notify()

    syncToHost('clearWorkspaceData', {
      workspaceId,
      options: {
        preservePinned,
        sessionIds,
        sessionId,
        clearFindings,
        clearGroups,
        clearPromptLogs,
        clearDrafts,
        clearCommitTraces,
        clearDistillRuns,
        clearDistillFingerprints,
      },
    })
  }

  /**
   * Hydrated distillation runs for one workspace, newest first.
   * @param {string} workspaceId
   * @param {{ statuses?: string[] }} [options]
   * @returns {Promise<object[]>}
   */
  async function listDistillRuns(workspaceId, { statuses = null } = {}) {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) return []
    const bucketKey = `ws:${workspaceId.trim()}`
    const list = memoryDistillRuns.get(bucketKey) ?? []
    const allowed = Array.isArray(statuses) && statuses.length > 0 ? new Set(statuses) : null
    const distillTime = item => (typeof item?.updatedAt === 'number'
      ? item.updatedAt
      : (typeof item?.createdAt === 'number' ? item.createdAt : 0))
    return list
      .filter(run => run && (!allowed || allowed.has(run.status)))
      .map(run => ({ ...run }))
      .sort((a, b) => distillTime(b) - distillTime(a))
  }

  /**
   * @param {string} runId
   * @returns {Promise<object|null>}
   */
  async function getDistillRun(runId) {
    if (typeof runId !== 'string' || !runId.trim()) return null
    for (const list of memoryDistillRuns.values()) {
      const found = list.find(run => run && run.id === runId)
      if (found) return { ...found }
    }
    return null
  }

  /**
   * @param {string} runId
   * @returns {Promise<object|null>}
   */
  async function getDistillPlan(runId) {
    if (typeof runId !== 'string' || !runId.trim()) return null
    const plan = memoryDistillPlans.get(`run:${runId.trim()}`)
    return plan ? { ...plan } : null
  }

  /**
   * @param {string} workspaceId
   * @returns {Promise<object[]>}
   */
  async function listDistillFingerprints(workspaceId) {
    if (typeof workspaceId !== 'string' || !workspaceId.trim()) return []
    const bucketKey = `ws:${workspaceId.trim()}`
    const list = memoryDistillFingerprints.get(bucketKey) ?? []
    return list
      .filter(fingerprint => fingerprint && fingerprint.id)
      .map(fingerprint => ({ ...fingerprint }))
      .sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
  }

  return {
    listEntries,
    getEntry: async (workspaceKey, id) => (await listEntries(workspaceKey)).find(item => item.id === id),
    putEntry,
    putEntries,
    deleteEntry,
    listPromptLog,
    upsertPromptLog,
    deletePromptLog,
    setHandoff,
    getHandoff,
    deleteHandoff,
    listWorkspaceRecords,
    putWorkspaceRecord,
    getGroups,
    putGroup,
    putGroups,
    listCommitTraces,
    putCommitTraces,
    lookupCommitTraces,
    listDistillRuns,
    getDistillRun,
    getDistillPlan,
    listDistillFingerprints,
    listTurnActions,
    putTurnActions,
    deleteTurnActions,
    clearWorkspaceData,
    clearCache: async () => {
      try {
        if (typeof storage?.length === 'number') {
          const keysToRemove = []
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i)
            if (key && (key.startsWith(PREFIX) || key.startsWith('dsh-punch-desk.'))) keysToRemove.push(key)
          }
          for (const key of keysToRemove) storage.removeItem(key)
        }
      } catch {}
      memoryEntries.clear()
      memoryLog.clear()
      memoryTraces.clear()
      memoryTurnActions.clear()
      traceTombstones.clear()
      memoryHandoff.clear()
      memoryWorkspaceRecords.clear()
      memoryGroups.clear()
      knownWorkspaces.clear()
      revisions.clear()
      notify()
      await syncToHost('clearCache', {})
    },
    getPrefs: async () => {
      const stored = storage ? readJson(storage, `${PREFIX}prefs`, {}) : {}
      const merged = {
        ...DEFAULT_PREFS,
        ...stored,
        ...(memoryPrefs ?? {}),
      }
      if (!START_SESSION_BEHAVIORS.includes(merged.startSessionBehavior)) {
        merged.startSessionBehavior = DEFAULT_PREFS.startSessionBehavior
      }
      if (!INHERIT_SCOPES.includes(merged.inheritScope)) {
        merged.inheritScope = DEFAULT_PREFS.inheritScope
      }
      if (!DRAFT_DEFAULT_VISIBILITIES.includes(merged.draftDefaultVisibility)) {
        merged.draftDefaultVisibility = DEFAULT_PREFS.draftDefaultVisibility
      }
      if (!SEQUENTIAL_COST_HINTS.includes(merged.sequentialCostHint)) {
        merged.sequentialCostHint = DEFAULT_PREFS.sequentialCostHint
      }
      const parsedRows = Number(merged.composerRows)
      if (!COMPOSER_ROWS_OPTIONS.includes(parsedRows)) {
        merged.composerRows = DEFAULT_PREFS.composerRows
      } else {
        merged.composerRows = parsedRows
      }
      if (!ARCHIVED_HISTORY_HEIGHTS.includes(merged.archivedHistoryHeight)) {
        merged.archivedHistoryHeight = DEFAULT_PREFS.archivedHistoryHeight
      }
      return merged
    },
    setPrefs: async prefs => {
      if (storage) {
        if (writeJson(storage, `${PREFIX}prefs`, prefs)) {
          memoryPrefs = null
        } else {
          quotaExceeded = true
          memoryPrefs = { ...(memoryPrefs ?? DEFAULT_PREFS), ...prefs }
        }
      } else {
        memoryPrefs = { ...(memoryPrefs ?? DEFAULT_PREFS), ...prefs }
      }
      notify()
      await syncToHost('setPrefs', { prefs })
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listWorkspaces: async () => workspaceIndex(),
    revision: workspaceKey => revisions.get(workspaceKey) ?? 0,
    quotaWarning: () => quotaExceeded,
    hydrate,
    whenHydrated: () => initialHydration,
    attachLegacyStorage,
    detachLegacyStorage,
    /**
     * Import a previously exported dump.
     * 'merge' upserts by id (newest updatedAt wins); 'replace' backs up the
     * current file first, then rebuilds storage from the dump.
     * @param {object} dump
     * @param {'merge'|'replace'} [mode]
     */
    importDump: async (dump, mode = 'merge') => {
      const effectiveMode = mode === 'replace' ? 'replace' : 'merge'
      if (hostStore && typeof hostStore.importDump === 'function') {
        try {
          return await hostStore.importDump(dump, { mode: effectiveMode })
        } catch (err) {
          return { ok: false, error: err?.message || 'Import failed' }
        }
      }
      if (typeof fetchFn === 'function') {
        try {
          const res = await fetchFn(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'import', dump, mode: effectiveMode }),
          })
          const data = res && typeof res.json === 'function' ? await res.json() : null
          if (data && typeof data === 'object') return data
        } catch (err) {
          return { ok: false, error: err?.message || 'Import failed' }
        }
      }
      return { ok: false, error: 'Host import unavailable' }
    },
    exportDump: async () => {
      const entries = {}
      for (const [k, v] of memoryEntries.entries()) entries[k] = v
      const promptLogs = {}
      for (const [k, v] of memoryLog.entries()) promptLogs[k] = v
      const commitTraces = {}
      for (const [k, v] of memoryTraces.entries()) commitTraces[k] = v
      const turnActions = {}
      for (const [k, v] of memoryTurnActions.entries()) turnActions[k] = v
      const distillRuns = {}
      for (const [k, v] of memoryDistillRuns.entries()) distillRuns[k] = v
      const distillPlans = {}
      for (const [k, v] of memoryDistillPlans.entries()) distillPlans[k] = { ...v }
      const distillFingerprints = {}
      for (const [k, v] of memoryDistillFingerprints.entries()) distillFingerprints[k] = v
      const groups = {}
      for (const [k, v] of memoryGroups.entries()) {
        if (!k.startsWith('session:')) groups[k] = [...v.values()]
      }
      const workspaceRecords = [...memoryWorkspaceRecords.values()]
      const handoffs = {}
      for (const [k, v] of memoryHandoff.entries()) handoffs[k] = v
      const prefs = memoryPrefs ? { ...memoryPrefs } : { ...DEFAULT_PREFS }
      const workspaces = [...knownWorkspaces]
      return {
        entries,
        promptLogs,
        commitTraces,
        turnActions,
        distillRuns,
        distillPlans,
        distillFingerprints,
        groups,
        workspaceRecords,
        handoffs,
        prefs,
        workspaces,
      }
    },
    dispose: () => stopStorage(),
  }
}

export { createDeskStore as createLocalDeskStore }
