import nodeFs from 'node:fs'
import {
  withWorkspaceLock,
  detectGitBranch,
  detectGitCommit,
  readRefCommitFull,
  detectGitHeadFull,
  runGitCommitRange,
  prunePromptLogs,
  createHostDeskStore,
  sanitizePathSegment,
} from './src/store/host.js'
import { createDistillLifecycle, createDistillApply, distillErrorResult } from './src/store/distill-host.js'
import { createDistillAnalyzer } from './src/store/distill-analyzer.js'
import { deriveTurnDigests } from './src/domain/turn-actions.js'

export {
  withWorkspaceLock,
  detectGitBranch,
  detectGitCommit,
  readRefCommitFull,
  detectGitHeadFull,
  runGitCommitRange,
  prunePromptLogs,
  createHostDeskStore,
  sanitizePathSegment,
}
export { createDistillLifecycle, createDistillApply, createDistillAnalyzer }

/**
 * Safely resolve filesystem directory path from workspaceId.
 * @param {string} workspaceId
 * @param {object} [options]
 * @param {object} [options.hostStore]
 * @param {Array<object>} [options.workspaces]
 * @param {object} [deps]
 * @returns {Promise<string|null>|string|null}
 */
export async function resolveWorkspaceDir(workspaceId, { hostStore, workspaceRegistry, workspaces } = {}, deps = {}) {
  const fs = deps.fs || nodeFs

  // 1. Host `workspaceRegistry` is the authoritative WorkspaceId -> directory map.
  //    Optional access: a profile without the registry simply falls through.
  if (workspaceId && workspaceRegistry && typeof workspaceRegistry.get === 'function') {
    try {
      const workspace = workspaceRegistry.get(workspaceId)
      if (workspace?.path && fs.existsSync(workspace.path)) {
        const stat = fs.statSync(workspace.path)
        if (stat.isDirectory()) return workspace.path
      }
    } catch {}
  }

  // 2. If hostStore has its own workspaceRecords (v2 compatibility layer)
  if (workspaceId && hostStore && typeof hostStore.listWorkspaceRecords === 'function') {
    try {
      const records = await hostStore.listWorkspaceRecords()
      const match = records.find(r => r && (r.id === workspaceId || r.path === workspaceId))
      if (match?.path && fs.existsSync(match.path)) {
        return match.path
      }
    } catch {}
  }

  // 3. If a workspaces array was passed explicitly (tests / embedded callers)
  if (workspaceId && Array.isArray(workspaces)) {
    const match = workspaces.find(w => w && (w.id === workspaceId || w.path === workspaceId))
    if (match?.path && fs.existsSync(match.path)) {
      return match.path
    }
  }

  // 4. If workspaceId itself is an existing directory path on disk
  if (workspaceId && typeof workspaceId === 'string') {
    // Security check: reject null bytes or relative path traversal sequences
    if (workspaceId.includes('\0') || workspaceId.split(/[/\\]/).includes('..')) {
      return null
    }
    try {
      if (fs.existsSync(workspaceId)) {
        const stat = fs.statSync(workspaceId)
        if (stat.isDirectory()) return workspaceId
      }
    } catch {}
  }

  // 5. Fallback for undefined/empty/default workspaceId:
  //    Attempt to resolve the first workspace or process.cwd()
  if (!workspaceId || workspaceId === 'default') {
    if (workspaceRegistry && typeof workspaceRegistry.getWorkspaceList === 'function') {
      try {
        const list = workspaceRegistry.getWorkspaceList()
        if (list?.[0]?.path && fs.existsSync(list[0].path)) return list[0].path
      } catch {}
    }
    if (Array.isArray(workspaces) && workspaces[0]?.path && fs.existsSync(workspaces[0].path)) {
      return workspaces[0].path
    }
    try {
      if (typeof process !== 'undefined' && process.cwd) {
        const cwd = process.cwd()
        if (fs.existsSync(cwd)) return cwd
      }
    } catch {}
  }

  return null
}

/**
 * Handle GET /api/punch-desk/git-branch
 */
export async function handleGitBranch(input = {}, options = {}, deps = {}) {
  const workspaceId = input.workspaceId
  if (!workspaceId) {
    return { ok: false, status: 400, error: 'Missing required parameter: workspaceId' }
  }

  const workspaceDir = await resolveWorkspaceDir(workspaceId, options, deps)
  if (!workspaceDir) {
    return { ok: false, status: 400, error: `Unauthorized or unknown workspaceId: ${workspaceId}` }
  }

  const gitBranch = detectGitBranch(workspaceDir, deps)
  const gitCommit = detectGitCommit(workspaceDir, deps)
  return { ok: true, status: 200, gitBranch, ...(gitCommit ? { gitCommit } : {}) }
}

/**
 * Handle GET /api/punch-desk/git-head
 */
export async function handleGitHead(input = {}, options = {}, deps = {}) {
  const workspaceId = input.workspaceId
  if (!workspaceId) {
    return { ok: false, status: 400, error: 'Missing required parameter: workspaceId' }
  }

  const workspaceDir = await resolveWorkspaceDir(workspaceId, options, deps)
  if (!workspaceDir) {
    return { ok: false, status: 400, error: `Unauthorized or unknown workspaceId: ${workspaceId}` }
  }

  const headInfo = detectGitHeadFull(workspaceDir, deps)
  return { ok: true, status: 200, ...headInfo }
}

/**
 * Handle GET /api/punch-desk/git-commit-range
 */
export async function handleGitCommitRange(input = {}, options = {}, deps = {}) {
  const workspaceId = input.workspaceId
  if (!workspaceId) {
    return { ok: false, status: 400, error: 'Missing required parameter: workspaceId' }
  }

  const from = input.from
  const to = input.to
  if (!from || !to || !/^[0-9a-f]{40}$/i.test(from) || !/^[0-9a-f]{40}$/i.test(to)) {
    return { ok: false, status: 400, error: 'invalid-sha' }
  }

  const workspaceDir = await resolveWorkspaceDir(workspaceId, options, deps)
  if (!workspaceDir) {
    return { ok: false, status: 400, error: `Unauthorized or unknown workspaceId: ${workspaceId}` }
  }

  const execFile = deps.execFile || options.execFile
  return runGitCommitRange({ workspaceDir, from, to, execFile }, deps)
}

/**
 * Handle GET /api/punch-desk/commit-trace-lookup
 * Scans complete commit traces in the given workspace by commit hash prefix (7-40 hex chars).
 */
export async function handleCommitTraceLookup(input = {}, options = {}, deps = {}) {
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
  if (!workspaceId) {
    return { ok: false, status: 400, error: 'Missing required parameter: workspaceId' }
  }

  const hash = typeof input.hash === 'string' ? input.hash.trim() : ''
  if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) {
    return { ok: false, status: 400, error: 'Invalid hash: must be 7-40 hex characters' }
  }

  const limit = Number.isInteger(Number(input.limit)) && Number(input.limit) > 0 ? Number(input.limit) : 20
  const hostStore = options.hostStore || deps.hostStore
  if (!hostStore || typeof hostStore.lookupCommitTraces !== 'function') {
    return { ok: false, status: 500, error: 'Host storage unavailable' }
  }

  try {
    const result = await hostStore.lookupCommitTraces({ workspaceId, hash, limit })
    return { ok: true, status: 200, matches: Array.isArray(result?.matches) ? result.matches : [] }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || String(err) }
  }
}

/**
 * Handle GET /api/punch-desk/workspace-files
 * Recursively scans workspace files across all directory levels.
 */
export async function handleWorkspaceFiles(input = {}, options = {}, deps = {}) {
  const fs = deps.fs || nodeFs
  const workspaceId = input.workspaceId || 'default'
  const query = (input.query || '').trim().toLowerCase()

  const workspaceDir = await resolveWorkspaceDir(workspaceId, options, deps)
  if (!workspaceDir) {
    return { ok: false, status: 400, error: `Unauthorized or unknown workspaceId: ${workspaceId}` }
  }

  const IGNORED_NAMES = new Set([
    'node_modules',
    '.git',
    '.svn',
    '.hg',
    '.dsh',
    '.next',
    '.turbo',
    '.gemini',
    '.cache',
    'coverage',
    'dist',
    'build',
    'out',
    '.plugin-manager',
    '.dsh-market',
    '.DS_Store',
  ])

  try {
    const list = []
    const MAX_DEPTH = 10
    const MAX_FILES = 2500

    const walk = (dir, rel = '', depth = 0) => {
      if (list.length >= MAX_FILES || depth > MAX_DEPTH) return
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }

      // Sort entries: directories first, then alphabetical
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1
        if (!a.isDirectory() && b.isDirectory()) return 1
        return a.name.localeCompare(b.name)
      })

      for (const ent of entries) {
        if (list.length >= MAX_FILES) break
        const name = ent.name
        if (IGNORED_NAMES.has(name) || (name.startsWith('.') && name !== '.env.example' && name !== '.gitignore')) {
          continue
        }
        const relPath = rel ? `${rel}/${name}` : name
        const fullPath = `${dir}/${name}`

        if (ent.isDirectory()) {
          // If query is present, check if directory name or path matches
          const matchesQuery = !query || name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)
          if (matchesQuery) {
            list.push({ name, path: `${relPath}/`, kind: 'directory', description: '目录' })
          }
          walk(fullPath, relPath, depth + 1)
        } else if (ent.isFile()) {
          const matchesQuery = !query || name.toLowerCase().includes(query) || relPath.toLowerCase().includes(query)
          if (matchesQuery) {
            list.push({ name, path: relPath, kind: 'file', description: relPath })
          }
        }
      }
    }

    walk(workspaceDir)
    return { ok: true, status: 200, files: list }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || String(err) }
  }
}

/**
 * Handle POST /api/punch-desk/store-migrate
 * Migrates client-side dumped data into host storage and verifies consistency.
 */
export async function handleStoreMigrate(input = {}, options = {}) {
  const hostStore = options.hostStore
  if (!hostStore || typeof hostStore.importDump !== 'function') {
    return { ok: false, status: 500, error: 'Host storage unavailable' }
  }
  const dump = input.dump
  if (!dump || typeof dump !== 'object') {
    return { ok: false, status: 400, error: 'Missing or invalid dump object' }
  }
  return await hostStore.importDump(dump)
}

/**
 * Handle GET/POST /api/punch-desk/store
 * Dispatches RPC calls directly to Host store.
 */
export async function handleStoreRpc(input = {}, options = {}) {
  const hostStore = options.hostStore
  if (!hostStore) {
    return { ok: false, status: 500, error: 'Host storage unavailable' }
  }

  const action = input.action || 'dump'

  try {
    switch (action) {
      case 'dump': {
        const state = await hostStore.exportDump()
        return { ok: true, status: 200, state }
      }
      case 'import': {
        const dump = input.dump || input.payload
        if (!dump || typeof dump !== 'object') {
          return { ok: false, status: 400, error: 'Missing or invalid dump object' }
        }
        const mode = input.mode === 'replace' ? 'replace' : 'merge'
        return await hostStore.importDump(dump, { mode })
      }
      case 'getEntry': {
        const { workspaceKey, id } = input
        if (!workspaceKey || !id) {
          return { ok: false, status: 400, error: 'Missing workspaceKey or id' }
        }
        const entry = await hostStore.getEntry(workspaceKey, id)
        return { ok: true, status: 200, entry }
      }
      case 'listEntries': {
        const { workspaceKey } = input
        if (!workspaceKey) {
          return { ok: false, status: 400, error: 'Missing workspaceKey' }
        }
        const entries = await hostStore.listEntries(workspaceKey)
        return { ok: true, status: 200, entries }
      }
      case 'putEntry': {
        const entry = input.entry || input.payload
        if (!entry || !entry.id) {
          return { ok: false, status: 400, error: 'Missing entry' }
        }
        await hostStore.putEntry(entry)
        return { ok: true, status: 200 }
      }
      case 'putEntries': {
        const { workspaceKey, entries } = input
        if (typeof hostStore.putEntries === 'function') {
          await hostStore.putEntries(workspaceKey, entries)
        } else if (Array.isArray(entries)) {
          for (const ent of entries) await hostStore.putEntry({ ...ent, workspaceKey })
        }
        return { ok: true, status: 200 }
      }
      case 'deleteEntry': {
        const { workspaceKey, id } = input
        if (!workspaceKey || !id) {
          return { ok: false, status: 400, error: 'Missing workspaceKey or id' }
        }
        await hostStore.deleteEntry(workspaceKey, id)
        return { ok: true, status: 200 }
      }
      case 'listPromptLog': {
        const { workspaceKey, filter } = input
        const promptLogs = await hostStore.listPromptLog(workspaceKey, filter)
        return { ok: true, status: 200, promptLogs }
      }
      case 'upsertPromptLog': {
        const { workspaceKey, entries } = input
        if (!workspaceKey || !Array.isArray(entries)) {
          return { ok: false, status: 400, error: 'Missing workspaceKey or entries' }
        }
        await hostStore.upsertPromptLog(workspaceKey, entries)
        return { ok: true, status: 200 }
      }
      case 'deletePromptLog': {
        const { workspaceKey, messageId } = input
        if (!workspaceKey || !messageId) {
          return { ok: false, status: 400, error: 'Missing workspaceKey or messageId' }
        }
        await hostStore.deletePromptLog(workspaceKey, messageId)
        return { ok: true, status: 200 }
      }
      case 'getGroups': {
        const { sessionId } = input
        const groups = await hostStore.getGroups(sessionId)
        return { ok: true, status: 200, groups }
      }
      case 'putGroup': {
        const group = input.group || input.payload
        if (!group || !group.id || !group.sessionId) {
          return { ok: false, status: 400, error: 'Missing or invalid group' }
        }
        await hostStore.putGroup(group)
        return { ok: true, status: 200 }
      }
      case 'putGroups': {
        const { sessionId, groups } = input
        if (typeof hostStore.putGroups === 'function') {
          await hostStore.putGroups(sessionId, groups)
        } else if (Array.isArray(groups)) {
          for (const g of groups) await hostStore.putGroup(g)
        }
        return { ok: true, status: 200 }
      }
      case 'getHandoff': {
        const { sessionId } = input
        const handoff = await hostStore.getHandoff(sessionId)
        return { ok: true, status: 200, handoff }
      }
      case 'setHandoff': {
        const { sessionId, value } = input
        if (!sessionId) {
          return { ok: false, status: 400, error: 'Missing sessionId' }
        }
        await hostStore.setHandoff(sessionId, value)
        return { ok: true, status: 200 }
      }
      case 'deleteHandoff': {
        const { sessionId } = input
        if (!sessionId) {
          return { ok: false, status: 400, error: 'Missing sessionId' }
        }
        await hostStore.deleteHandoff(sessionId)
        return { ok: true, status: 200 }
      }
      case 'getPrefs': {
        const prefs = await hostStore.getPrefs()
        return { ok: true, status: 200, prefs }
      }
      case 'setPrefs': {
        const prefs = input.prefs || input.payload
        if (!prefs || typeof prefs !== 'object') {
          return { ok: false, status: 400, error: 'Missing prefs' }
        }
        await hostStore.setPrefs(prefs)
        return { ok: true, status: 200 }
      }
      case 'listWorkspaceRecords': {
        const records = await hostStore.listWorkspaceRecords()
        return { ok: true, status: 200, records }
      }
      case 'putWorkspaceRecord': {
        const record = input.record || input.payload
        if (!record || !record.id) {
          return { ok: false, status: 400, error: 'Missing record' }
        }
        await hostStore.putWorkspaceRecord(record)
        return { ok: true, status: 200 }
      }
      case 'clearWorkspaceData': {
        const { workspaceId, options: clearOpts } = input
        if (!workspaceId) {
          return { ok: false, status: 400, error: 'Missing workspaceId' }
        }
        await hostStore.clearWorkspaceData(workspaceId, clearOpts)
        return { ok: true, status: 200 }
      }
      case 'clearCache': {
        if (typeof hostStore.clearCache === 'function') {
          await hostStore.clearCache()
        }
        return { ok: true, status: 200 }
      }
      case 'listCommitTraces': {
        const sessionKey = input.sessionKey || input.payload?.sessionKey
        if (!sessionKey) {
          return { ok: false, status: 400, error: 'Missing sessionKey' }
        }
        const traces = (await hostStore.listCommitTraces?.(sessionKey)) || []
        return { ok: true, status: 200, traces }
      }
      case 'putCommitTraces': {
        const sessionKey = input.sessionKey || input.payload?.sessionKey
        const traces = input.traces || input.payload?.traces
        if (!sessionKey || !Array.isArray(traces)) {
          return { ok: false, status: 400, error: 'Missing sessionKey or traces' }
        }
        await hostStore.putCommitTraces?.(sessionKey, traces)
        return { ok: true, status: 200 }
      }
      case 'listTurnActions': {
        const sessionKey = input.sessionKey || input.payload?.sessionKey
        if (!sessionKey) {
          return { ok: false, status: 400, error: 'Missing sessionKey' }
        }
        const data = await hostStore.listTurnActions?.(sessionKey)
        return { ok: true, status: 200, value: data }
      }
      case 'putTurnActions': {
        const sessionKey = input.sessionKey || input.payload?.sessionKey
        const turnState = input.state || input.payload?.state
        if (!sessionKey || !turnState || typeof turnState !== 'object') {
          return { ok: false, status: 400, error: 'Missing sessionKey or state' }
        }
        await hostStore.putTurnActions?.(sessionKey, turnState)
        return { ok: true, status: 200 }
      }
      case 'deleteTurnActions': {
        const sessionKey = input.sessionKey || input.payload?.sessionKey
        if (!sessionKey) {
          return { ok: false, status: 400, error: 'Missing sessionKey' }
        }
        await hostStore.deleteTurnActions?.(sessionKey)
        return { ok: true, status: 200 }
      }
      case 'lookupCommitTraces': {
        const { workspaceId, hash, limit } = input
        return handleCommitTraceLookup({ workspaceId, hash, limit }, options)
      }
      default:
        return { ok: false, status: 400, error: `Unknown action: ${action}` }
    }
  } catch (err) {
    return { ok: false, status: 500, error: err.message || String(err) }
  }
}

/**
 * Handle GET /api/punch-desk/distill-docs
 * Navigation section of the target repo AGENTS.md §0 + allowed roots.
 */
export async function handleDistillDocs(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle) return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  try {
    return await lifecycle.readDocs(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle GET/POST /api/punch-desk/distill-run
 * POST starts a batch; GET ?id= polls one run; GET ?workspaceId= lists the
 * workspace runs (with plans) for refresh recovery / history (spec §13.2).
 */
export async function handleDistillRun(input = {}, options = {}, deps = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle) return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  try {
    if (deps.method === 'POST') return await lifecycle.startRun(input)
    return await lifecycle.getRun(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/distill-cancel
 * Cancel arbitration (spec §11.2.7). The response `status` field is the cancel
 * status string ('cancelRequested'|'canceled'|'too_late'), serialized as HTTP
 * 200 by jsonResponse's typeof guard; errors carry numeric HTTP statuses.
 */
export async function handleDistillCancel(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle) return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  try {
    return await lifecycle.cancelRun(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle GET /api/punch-desk/distill-baseline
 * Multi-file {content, baseHash} baseline (replaces the retired single-file baseline route).
 */
export async function handleDistillBaseline(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle) return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  try {
    return await lifecycle.readBaseline(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/distill-apply
 * Multi-file CAS transaction (spec §11): selection + dependency + §9 checks,
 * §8.4 synthesis, backups, crash-safe tx, fingerprints, cancel commit point.
 */
export async function handleDistillApply(input = {}, options = {}) {
  const distillApply = options.distillApply
  if (!distillApply) return { ok: false, status: 500, error: 'Distill apply unavailable' }
  try {
    return await distillApply.applyPlan(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle GET /api/punch-desk/distill-estimate
 * Read-only pre-flight for the batch config card grid: material counts, token
 * demand, budget and the planned model calls. Never writes, never locks.
 */
export async function handleDistillEstimate(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle || typeof lifecycle.estimate !== 'function') {
    return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  }
  try {
    return await lifecycle.estimate(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/distill-delete
 * Deletes a finished run + its plan row. Fingerprints are idempotency assets
 * and are deliberately kept.
 */
export async function handleDistillDelete(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle || typeof lifecycle.deleteRun !== 'function') {
    return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  }
  try {
    return await lifecycle.deleteRun(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/distill-park
 * Park (release the submission lock but keep the plan) or unpark (clear the
 * flag and restart the ready TTL, re-locking) a READY run. Business refusals
 * (PARK_NOT_ALLOWED) are HTTP 200 with the code in both error idioms.
 */
export async function handleDistillPark(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle || typeof lifecycle.parkRun !== 'function') {
    return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  }
  try {
    return await lifecycle.parkRun(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/distill-abandon
 * Delete this run + its plan without writing anything back. Allowed for
 * `ready|failed|canceled|stale|superseded|queued`; `applying|applied` answer
 * ABANDON_NOT_ALLOWED. Fingerprints are kept.
 */
export async function handleDistillAbandon(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle || typeof lifecycle.abandonRun !== 'function') {
    return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  }
  try {
    return await lifecycle.abandonRun(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/distill-review
 * Persists the human review marks (暂不采纳 / 已复核) of a ready plan and
 * verifies the write by re-reading the plan row.
 */
export async function handleDistillReview(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle || typeof lifecycle.reviewPlan !== 'function') {
    return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  }
  try {
    return await lifecycle.reviewPlan(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/distill-rebase
 * Deterministic baseline re-anchoring of one drifted file (no model call):
 * `apply:false` previews the disk state, `apply:true` aligns `fileBaseHash` and
 * marks already-present changes as skipped.
 */
export async function handleDistillRebase(input = {}, options = {}) {
  const lifecycle = options.distillLifecycle
  if (!lifecycle || typeof lifecycle.rebasePlan !== 'function') {
    return { ok: false, status: 500, error: 'Distill lifecycle unavailable' }
  }
  try {
    return await lifecycle.rebasePlan(input)
  } catch (err) {
    return distillErrorResult(err)
  }
}

/**
 * Handle POST /api/punch-desk/turn-actions-scan
 * Read-only scan of session turn events to derive TurnDigest action items.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {number} [input.maxTurns=20]
 * @param {boolean} [input.includeTextHeuristic=false]
 * @param {object} options
 * @param {object} [ctx] Cordis context
 * @returns {Promise<object>}
 */
export async function handleTurnActionsScan(input = {}, options = {}, ctx) {
  const sessionId = input.sessionId
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    return { ok: false, status: 400, error: 'INVALID_SESSION_ID' }
  }
  const cleanSessionId = sessionId.trim()

  let sq
  try {
    sq = ctx?.get?.('sessionQuery')
  } catch {
    sq = undefined
  }
  if (!sq || typeof sq.readSession !== 'function') {
    return { ok: false, status: 503, error: 'SESSION_QUERY_UNAVAILABLE' }
  }

  let snapshot
  try {
    snapshot = await sq.readSession(cleanSessionId)
  } catch (err) {
    if (err?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || err?.code === 'SESSION_NOT_FOUND' || err?.message?.includes('not found')) {
      return { ok: false, status: 404, error: 'SESSION_NOT_FOUND' }
    }
    return { ok: false, status: 500, error: 'SESSION_READ_FAILED' }
  }

  if (!snapshot) {
    return { ok: false, status: 404, error: 'SESSION_NOT_FOUND' }
  }

  if (
    typeof snapshot !== 'object'
    || !snapshot.session
    || typeof snapshot.session !== 'object'
    || snapshot.session.id !== cleanSessionId
    || !Array.isArray(snapshot.events)
  ) {
    return { ok: false, status: 500, error: 'SESSION_READ_FAILED' }
  }

  const events = snapshot.events
  const maxTurns = Number.isFinite(input.maxTurns) ? Math.max(1, input.maxTurns) : 20
  const includeTextHeuristic = Boolean(input.includeTextHeuristic)
  const workspaceKey = `session:${cleanSessionId}`

  // Read promptLogs and entries from hostStore to build promptLogTurns and findingsByRequest
  const hostStore = options.hostStore
  const promptLogTurns = new Map()
  const findingsByRequest = new Map()

  if (hostStore) {
    try {
      const logs = (await hostStore.listPromptLog?.(workspaceKey)) || []
      for (const log of logs) {
        if (typeof log.turn === 'number') {
          promptLogTurns.set(log.turn, log)
        }
      }
      const entries = (await hostStore.listEntries?.(workspaceKey)) || []
      for (const entry of entries) {
        const reqId = entry.requestId || entry.batchId
        if (reqId) {
          const list = findingsByRequest.get(reqId) || []
          list.push(entry)
          findingsByRequest.set(reqId, list)
        }
      }
    } catch {}
  }

  const turns = deriveTurnDigests(events, {
    sessionId: cleanSessionId,
    workspaceKey,
    maxTurns,
    includeTextHeuristic,
    promptLogTurns,
    findingsByRequest,
  })

  const scannedThroughSeq = events.length > 0 ? (events[events.length - 1]?.seq ?? 0) : 0
  const allTurnNumbers = new Set(events.filter(e => typeof e?.data?.turn === 'number').map(e => e.data.turn))
  const coverage = {
    totalTurns: allTurnNumbers.size,
    scannedTurns: turns.length,
    hasMore: allTurnNumbers.size > turns.length,
  }

  return {
    ok: true,
    status: 200,
    value: {
      sessionId: cleanSessionId,
      scannedThroughSeq,
      turns,
      coverage,
    },
  }
}

/**
 * Adapt handler to Koa/Express/pure route conventions.
 */
export function adaptRoute(handler, options = {}, deps = {}) {
  return async (reqOrCtx, maybeRes) => {
    const isKoa = reqOrCtx && typeof reqOrCtx.body === 'undefined' && reqOrCtx.request !== undefined
    const isExpress = maybeRes && typeof maybeRes.status === 'function' && typeof maybeRes.json === 'function'

    let input = {}
    if (reqOrCtx?.method === 'GET' || reqOrCtx?.request?.method === 'GET') {
      input = { ...(reqOrCtx.query || reqOrCtx.request?.query || {}) }
    } else {
      input = {
        ...(reqOrCtx.body || reqOrCtx.request?.body || reqOrCtx.query || reqOrCtx.request?.query || {}),
      }
    }

    const result = await handler(input, options, deps)
    const status = result.status || (result.ok ? 200 : 400)

    if (isExpress) {
      maybeRes.status(status).json(result)
    } else if (isKoa) {
      reqOrCtx.status = status
      reqOrCtx.body = result
    } else if (reqOrCtx && typeof reqOrCtx === 'object' && 'body' in reqOrCtx) {
      reqOrCtx.status = status
      reqOrCtx.body = result
    }
    return result
  }
}

export const name = 'dsh-punch-desk'

/**
 * Host routes live inside Connection's authentication fence: the browser page
 * reaches them same-origin with its own Connection credential, so the plugin
 * must never expose a raw unauthenticated HTTP router. `connection` is the only
 * host service this half needs; the workspace registry is resolved lazily
 * through optional access because not every profile mounts it.
 */
export const inject = ['connection']

const ROUTE_PREFIX = '/api/punch-desk'

/**
 * Serialize one handler result as an HTTP response. Handlers already return
 * `{ ok, status, ...payload }`; the HTTP status mirrors `status`.
 * @param {object} result
 * @returns {Response}
 */
function jsonResponse(result) {
  const status = typeof result?.status === 'number' ? result.status : (result?.ok ? 200 : 400)
  return Response.json(result ?? { ok: false, status }, {
    status,
    headers: { 'cache-control': 'no-store' },
  })
}

/**
 * Wrap one host handler as a `ConnectionFetchRoute.fetch` callback so an
 * unexpected throw still becomes a JSON 500 instead of a broken socket.
 * @param {() => Promise<object>} work
 * @returns {Promise<Response>}
 */
async function respondWith(work) {
  try {
    return jsonResponse(await work())
  } catch (error) {
    return jsonResponse({ ok: false, status: 500, error: error?.message ?? String(error) })
  }
}

/**
 * Resolve an externally supplied Host store without touching undeclared
 * services on the Cordis context.
 *
 * Reading `ctx.hostStore` directly throws `cannot get property "hostStore"
 * without inject` at activation time, because Cordis guards every service
 * property access with the plugin's `inject` list. That throw aborted `apply`,
 * left the Host entry in `fiberPhase: failed`, registered no `/api/punch-desk/*`
 * route, and made the Web client hydrate an empty store (data stayed intact on
 * disk but the desk and session pane both rendered empty). Optional services
 * must be read through `ctx.get`, which is the unguarded accessor.
 *
 * @param {object} ctx Cordis context
 * @returns {object|null} injected store when the profile supplies one
 */
function resolveInjectedHostStore(ctx) {
  if (!ctx || typeof ctx.get !== 'function') return null
  try {
    const injected = ctx.get('hostStore')
    return injected && typeof injected === 'object' ? injected : null
  } catch {
    return null
  }
}

/**
 * Cordis plugin host entry point.
 * @param {object} ctx Cordis context
 */
export function apply(ctx, pluginOptions = {}) {
  const hostStore = pluginOptions.hostStore
    || resolveInjectedHostStore(ctx)
    || createHostDeskStore(pluginOptions.storeOptions)

  const options = {
    hostStore,
    workspaces: pluginOptions.workspaces,
    // Resolve per request: the registry is optional and may mount after us.
    get workspaceRegistry() {
      try {
        return ctx.get('workspaceRegistry')
      } catch {
        return undefined
      }
    },
  }

  // Finding Distillation analyzer (Task 2.3) is wired here, not injected by the
  // profile: the Host entry owns the guarded-context bridge, so the analyzer can
  // lazily reach `llm` / `agentDefaultModel` (both may mount after this plugin)
  // through unguarded `ctx.get`. Without this wiring every start degraded to
  // ANALYZER_UNAVAILABLE ("distill analyzer is not wired into this Host entry"),
  // which the Desk surfaced as a start failure before any run existed.
  // An explicit pluginOptions.distillAnalyzer (tests / integrations) still wins.
  const resolveHostService = name => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const distillAnalyzer = pluginOptions.distillAnalyzer || createDistillAnalyzer({
    getService: resolveHostService,
    store: hostStore,
  })

  // Finding Distillation lifecycle (Task 2.4).
  const distillLifecycle = createDistillLifecycle({
    ctx,
    store: hostStore,
    analyzer: distillAnalyzer,
    workspaceRegistry: pluginOptions.distillWorkspaceRegistry,
    workspaces: pluginOptions.workspaces,
  })
  options.distillLifecycle = distillLifecycle

  // Finding Distillation apply transaction (Task 2.5). The recovery handler
  // is registered into the lifecycle's single apply-recovery slot; lazy
  // recovery of crashed `applying` runs routes through it (spec §11.2.6).
  const distillApply = createDistillApply({
    lifecycle: distillLifecycle,
    store: hostStore,
    ctx,
    workspaceRegistry: pluginOptions.distillWorkspaceRegistry,
    workspaces: pluginOptions.workspaces,
    backupsRoot: pluginOptions.distillBackupsRoot,
  })
  distillLifecycle.registerApplyRecovery(distillApply.recoverApplying)
  options.distillApply = distillApply

  const register = route => ctx.effect(
    () => ctx.connection.fetch.register(route),
    `punch-desk: ${route.path}`,
  )

  register({
    path: `${ROUTE_PREFIX}/git-branch`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      return handleGitBranch({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/git-head`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      return handleGitHead({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/git-commit-range`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      return handleGitCommitRange({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/commit-trace-lookup`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      return handleCommitTraceLookup({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
        hash: url.searchParams.get('hash') ?? undefined,
        limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/workspace-files`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      return handleWorkspaceFiles({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
        query: url.searchParams.get('query') ?? undefined,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/store-migrate`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleStoreMigrate(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/store`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      if (request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        const params = Object.fromEntries(url.searchParams.entries())
        return handleStoreRpc(params, options)
      }
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleStoreRpc(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-docs`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      return handleDistillDocs({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-run`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      if (request.method === 'GET') {
        const url = new URL(request.url, 'http://localhost')
        return handleDistillRun({
          id: url.searchParams.get('id') ?? undefined,
          workspaceId: url.searchParams.get('workspaceId') ?? undefined,
        }, options, { method: 'GET' })
      }
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillRun(input, options, { method: 'POST' })
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-cancel`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillCancel(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-baseline`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      const files = url.searchParams.getAll('files').flatMap(value => value.split(','))
      return handleDistillBaseline({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
        files,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-estimate`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => respondWith(() => {
      const url = new URL(request.url, 'http://localhost')
      const sessions = url.searchParams.getAll('sessions').flatMap(value => value.split(','))
      return handleDistillEstimate({
        workspaceId: url.searchParams.get('workspaceId') ?? undefined,
        sessions,
      }, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-delete`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillDelete(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-park`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillPark(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-abandon`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillAbandon(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-review`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillReview(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-rebase`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillRebase(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/distill-apply`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'Invalid JSON body' }
      }
      return handleDistillApply(input, options)
    }),
  })

  register({
    path: `${ROUTE_PREFIX}/turn-actions-scan`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respondWith(async () => {
      let input
      try {
        input = await request.json()
      } catch {
        return { ok: false, status: 400, error: 'INVALID_SESSION_ID' }
      }
      if (!input || typeof input !== 'object') {
        return { ok: false, status: 400, error: 'INVALID_SESSION_ID' }
      }
      return handleTurnActionsScan(input, options, ctx)
    }),
  })

  return { hostStore, distillLifecycle, distillApply }
}
