import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'
import nodeCrypto from 'node:crypto'
import nodeChildProcess from 'node:child_process'
import { DEFAULT_PREFS, DISTILL_RETENTION, HOST_STATE_VERSION, retentionWindowFromPrefs } from './contract.js'
import { verifyStateContainsDump } from './migrate.js'
import { createWorkspaceRecord, validateWorkspaceRecord } from '../domain/workspace.js'
import { createGroupRecord, validateGroupRecord } from '../domain/active-group.js'
import { pruneTurnActionItems } from '../domain/turn-actions.js'

/**
 * Mutex lock map to serialize writeback requests per workspace.
 */
const workspaceLocks = new Map()

/**
 * Async mutex per workspace directory to serialize concurrent writeback requests.
 * @param {string} workspaceKey
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withWorkspaceLock(workspaceKey, fn) {
  const prevLock = workspaceLocks.get(workspaceKey) || Promise.resolve()
  let release
  const newLock = new Promise(resolve => { release = resolve })
  workspaceLocks.set(workspaceKey, prevLock.then(() => newLock))
  await prevLock
  try {
    return await fn()
  } finally {
    release()
    if (workspaceLocks.get(workspaceKey) === newLock) {
      workspaceLocks.delete(workspaceKey)
    }
  }
}

/**
 * Compute SHA-256 hash in hex format.
 * @param {string} content
 * @param {object} [crypto]
 * @returns {string}
 */
export function sha256Hex(content, crypto = nodeCrypto) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Safely sanitize a path segment to prevent directory traversal or control characters.
 * @param {string} segment
 * @returns {string}
 */
export function sanitizePathSegment(segment) {
  if (!segment || typeof segment !== 'string') return 'workspace'
  const cleaned = segment.replace(/[\0\r\n/\\]/g, '_').trim()
  if (cleaned === '.' || cleaned === '..' || cleaned === '') return 'workspace'
  return encodeURIComponent(cleaned)
}

/**
 * Storage prefix used by workspace-scoped session keys (`session:<id>`).
 */
const SESSION_STORAGE_PREFIX = 'session:'

/**
 * Normalize any session identifier (`<id>` or `session:<id>`) to the one and
 * only `state.groups` key group data may be written to.
 *
 * Historical builds wrote every group array under three aliases at once
 * (`<id>`, `session:<id>` and the caller's raw spelling), which doubled the
 * on-disk payload and left no single source of truth. Reads still tolerate the
 * aliases, but writes go through this canonical key only.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function groupsKeyFor(sessionId) {
  if (typeof sessionId !== 'string') return ''
  const trimmed = sessionId.trim()
  if (!trimmed) return ''
  return trimmed.startsWith(SESSION_STORAGE_PREFIX)
    ? trimmed.slice(SESSION_STORAGE_PREFIX.length).trim()
    : trimmed
}

/**
 * Normalise a session key for commitTraces to canonical 'session:<sessionId>'.
 * @param {string} sessionKey
 * @returns {string}
 */
export function commitTracesKeyFor(sessionKey) {
  if (typeof sessionKey !== 'string') return ''
  const trimmed = sessionKey.trim()
  if (!trimmed) return ''
  return trimmed.startsWith(SESSION_STORAGE_PREFIX)
    ? trimmed
    : `${SESSION_STORAGE_PREFIX}${trimmed}`
}

/**
 * Normalise a session key for turnActions to canonical 'session:<sessionId>'.
 * @param {string} sessionKey
 * @returns {string}
 */
export function turnActionsKeyFor(sessionKey) {
  if (typeof sessionKey !== 'string') return ''
  const trimmed = sessionKey.trim()
  if (!trimmed) return ''
  return trimmed.startsWith(SESSION_STORAGE_PREFIX)
    ? trimmed
    : `${SESSION_STORAGE_PREFIX}${trimmed}`
}

/**
 * Session id named by a store workspace key (`session:<id>`), or null when the
 * key names something else (`draft:global`, a directory path, a WorkspaceRecord
 * id, ...).
 * @param {string} workspaceKey
 * @returns {string|null}
 */
function sessionIdOfWorkspaceKey(workspaceKey) {
  if (typeof workspaceKey !== 'string' || !workspaceKey.startsWith(SESSION_STORAGE_PREFIX)) return null
  const id = workspaceKey.slice(SESSION_STORAGE_PREFIX.length).trim()
  return id === '' ? null : id
}

/**
 * Whether one state bucket holds at least one record for `key`.
 * @param {Record<string, unknown>|undefined} bucket
 * @param {string} key
 * @returns {boolean}
 */
function hasNonEmptyArray(bucket, key) {
  if (!bucket || typeof bucket !== 'object') return false
  const list = bucket[key]
  return Array.isArray(list) && list.length > 0
}

/**
 * Build the findings index for one session from the persisted entry buckets.
 *
 * `validateGroupRecord` can only enforce invariant I2 (every group item
 * resolves to an existing finding of the same session) when it receives this
 * index, so the store assembles it at write time. Read paths (`getGroups`,
 * import, migration) never call it: legacy rows stay readable, only new writes
 * are strict.
 *
 * Both the canonical `session:<id>` bucket and the historical raw `<id>` spelling
 * are indexed so an old file is not re-interpreted as orphaned just because it
 * predates the single-key layout.
 *
 * @param {object} state host store state
 * @param {string} sessionId
 * @returns {Map<string, object>}
 */
export function findingsIndexForSession(state, sessionId) {
  const index = new Map()
  const sessionKey = groupsKeyFor(sessionId)
  if (!sessionKey) return index
  const buckets = state && state.entries && typeof state.entries === 'object' ? state.entries : {}
  for (const [key, list] of Object.entries(buckets)) {
    if (!Array.isArray(list) || list.length === 0) continue
    const namedSession = sessionIdOfWorkspaceKey(key)
    const bucketSession = namedSession !== null ? namedSession : key.trim()
    if (bucketSession !== sessionKey) continue
    for (const item of list) {
      if (item && typeof item.id === 'string' && item.id !== '') index.set(item.id, item)
    }
  }
  return index
}

/**
 * Whether one session still owns any durable plugin data.
 *
 * A `session:<id>` workspace key is bookkeeping, not an entity: an empty bucket
 * is the residue of deleting the last finding / prompt-log / git trace, never a
 * session that should surface in the Desk session list. The Desk lists the
 * plugin store's workspace index (it cannot read the Harness session tree's
 * `blank` filter), so every residual key must be able to prove it still has
 * data before it is advertised.
 * @param {object} state host store state
 * @param {string} workspaceKey
 * @returns {boolean}
 */
function hasSessionData(state, workspaceKey) {
  if (hasNonEmptyArray(state.entries, workspaceKey)) return true
  if (hasNonEmptyArray(state.promptLogs, workspaceKey)) return true
  const traceKeys = new Set([workspaceKey])
  const canonicalTraces = commitTracesKeyFor(workspaceKey)
  if (canonicalTraces !== '') traceKeys.add(canonicalTraces)
  const sessionId = sessionIdOfWorkspaceKey(workspaceKey)
  if (sessionId !== null) {
    traceKeys.add(sessionId)
    traceKeys.add(commitTracesKeyFor(sessionId))
    if (hasNonEmptyArray(state.groups, groupsKeyFor(sessionId))) return true
  }
  for (const key of traceKeys) {
    if (hasNonEmptyArray(state.commitTraces, key)) return true
  }
  const turnActionKey = turnActionsKeyFor(workspaceKey)
  if (state.turnActions && state.turnActions[turnActionKey]?.items?.length > 0) return true
  return false
}

/**
 * Drop empty session buckets and their stale `state.workspaces` slots.
 *
 * Deletes used to leave `entries["session:<id>"] = []` (and the matching
 * `state.workspaces` entry) behind, so a completely deleted session kept
 * showing up in the Desk as an untitled "0 findings / 0 turns" card. The
 * Harness hides blank sessions in its own tree; the plugin store has to do the
 * equivalent pruning itself. Non-session keys (`draft:global`, directory paths)
 * are never touched.
 * @param {object} state
 * @returns {boolean} whether the state changed
 */
function pruneEmptySessionBuckets(state) {
  let changed = false
  for (const bucket of [state.entries, state.promptLogs, state.commitTraces]) {
    if (!bucket || typeof bucket !== 'object') continue
    for (const key of Object.keys(bucket)) {
      if (sessionIdOfWorkspaceKey(key) === null) continue
      const list = bucket[key]
      if (Array.isArray(list) && list.length === 0) {
        delete bucket[key]
        changed = true
      }
    }
  }
  if (Array.isArray(state.workspaces)) {
    const kept = state.workspaces.filter(key => sessionIdOfWorkspaceKey(key) === null || hasSessionData(state, key))
    if (kept.length !== state.workspaces.length) {
      state.workspaces = kept
      changed = true
    }
  }
  return changed
}

/**
 * Canonical Host Store bucket key for the workspace-scoped distillation runs.
 * @param {string} workspaceId
 * @returns {string} `ws:<workspaceId>`
 */
export function distillRunBucketKey(workspaceId) {
  if (typeof workspaceId !== 'string') return ''
  const trimmed = workspaceId.trim()
  return trimmed ? `ws:${trimmed}` : ''
}

/**
 * Canonical Host Store bucket key for a persisted DistillPlan.
 * @param {string} runId
 * @returns {string} `run:<runId>`
 */
export function distillPlanKeyFor(runId) {
  if (typeof runId !== 'string') return ''
  const trimmed = runId.trim()
  return trimmed ? `run:${trimmed}` : ''
}

/**
 * Every key a historical build could have used for the same session.
 * @param {string} sessionId
 * @returns {string[]}
 */
function groupsAliasKeys(sessionId) {
  const canonical = groupsKeyFor(sessionId)
  const keys = []
  if (canonical) keys.push(canonical)
  if (typeof sessionId === 'string' && sessionId.trim()) keys.push(sessionId.trim())
  if (canonical) keys.push(`${SESSION_STORAGE_PREFIX}${canonical}`)
  return [...new Set(keys)]
}

/**
 * Read the `updatedAt` timestamp used to arbitrate conflicting group copies.
 * @param {object} group
 * @returns {number}
 */
function groupUpdatedAt(group) {
  return typeof group?.updatedAt === 'number' && Number.isFinite(group.updatedAt)
    ? group.updatedAt
    : -Infinity
}

/**
 * Merge two copies of the same group: fields are unioned, conflicting values
 * come from the copy with the larger `updatedAt`.
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
function mergeGroupRecord(a, b) {
  if (!a) return b ? { ...b } : b
  if (!b) return { ...a }
  const aTime = groupUpdatedAt(a)
  const bTime = groupUpdatedAt(b)
  const winner = bTime > aTime ? b : a
  const loser = winner === b ? a : b
  const merged = { ...winner }
  for (const [key, value] of Object.entries(loser)) {
    if (merged[key] === undefined) merged[key] = value
  }
  if (Number.isFinite(aTime) || Number.isFinite(bTime)) {
    merged.updatedAt = Math.max(
      Number.isFinite(aTime) ? aTime : 0,
      Number.isFinite(bTime) ? bTime : 0,
    )
  }
  return merged
}

/**
 * Merge several historical group arrays into one list deduped by group.id.
 * @param {any[]} lists
 * @returns {any[]}
 */
function mergeGroupLists(lists) {
  const merged = []
  const indexById = new Map()
  for (const list of lists) {
    if (!Array.isArray(list)) continue
    for (const group of list) {
      if (!group || typeof group !== 'object' || group.id === undefined || group.id === null) {
        merged.push(group)
        continue
      }
      if (!indexById.has(group.id)) {
        indexById.set(group.id, merged.length)
        merged.push({ ...group })
      } else {
        const index = indexById.get(group.id)
        merged[index] = mergeGroupRecord(merged[index], group)
      }
    }
  }
  return merged
}

/**
 * Read group data for a session, tolerating any legacy key alias and deduping
 * multiple copies by group.id. Pure read: never mutates `state`.
 * @param {{ groups?: Record<string, any[]> }} state
 * @param {string} sessionId
 * @returns {any[]}
 */
function readGroupsCompat(state, sessionId) {
  const lists = []
  const groups = state && typeof state.groups === 'object' && state.groups ? state.groups : {}
  for (const key of groupsAliasKeys(sessionId)) {
    if (Array.isArray(groups[key])) lists.push(groups[key])
  }
  return mergeGroupLists(lists)
}

/**
 * Build the canonical single-key group map from whatever aliases exist on disk.
 * @param {Record<string, any[]>} groups
 * @returns {{ needed: boolean, groups: Record<string, any[]>, expectedGroupCount: number, keys: string[] }}
 */
function planGroupsMigration(groups) {
  const source = groups && typeof groups === 'object' ? groups : {}
  const buckets = new Map()
  let needed = false

  for (const [rawKey, list] of Object.entries(source)) {
    const canonical = groupsKeyFor(rawKey)
    const key = canonical || rawKey
    if (canonical !== rawKey) needed = true
    if (!Array.isArray(list)) {
      needed = true
      continue
    }
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(list)
  }

  const normalized = {}
  let expectedGroupCount = 0
  for (const [key, lists] of buckets) {
    if (lists.length > 1) needed = true
    const merged = mergeGroupLists(lists)
    if (merged.length !== lists.reduce((total, list) => total + list.length, 0)) needed = true
    normalized[key] = merged
    expectedGroupCount += merged.length
  }

  return {
    needed,
    groups: normalized,
    expectedGroupCount,
    keys: Object.keys(normalized),
  }
}

/**
 * Resolve the working `.git` directory (including the worktree `.git` file and
 * `commondir` indirection) without executing shell commands.
 * @param {string} workspaceDir
 * @param {object} [deps]
 * @returns {{ gitDir: string, commonDir: string }|null}
 */
function resolveGitLocations(workspaceDir, deps = {}) {
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath

  if (!workspaceDir || typeof workspaceDir !== 'string') return null
  try {
    const gitPath = path.join(workspaceDir, '.git')
    if (!fs.existsSync(gitPath)) return null

    let gitDir = gitPath
    if (fs.statSync(gitPath).isFile()) {
      const content = fs.readFileSync(gitPath, 'utf8')
      const match = content.match(/^gitdir:\s*(.+)$/m)
      if (!match) return null
      const gitdir = match[1].trim()
      gitDir = path.isAbsolute(gitdir) ? gitdir : path.resolve(workspaceDir, gitdir)
    }
    if (!fs.existsSync(gitDir)) return null

    // Linked worktrees keep shared refs in the common dir.
    let commonDir = gitDir
    const commonFile = path.join(gitDir, 'commondir')
    if (fs.existsSync(commonFile)) {
      const relative = fs.readFileSync(commonFile, 'utf8').trim()
      if (relative !== '') commonDir = path.resolve(gitDir, relative)
    }
    return { gitDir, commonDir }
  } catch {
    return null
  }
}

/**
 * Read the full 40-char commit SHA a ref points at, from loose refs first and
 * packed-refs second. Returns an empty string when the ref cannot be resolved.
 * @param {string} ref
 * @param {{ gitDir: string, commonDir: string }} locations
 * @param {object} [deps]
 * @returns {string} 40-hex commit SHA, or empty string.
 */
export function readRefCommitFull(ref, locations, deps = {}) {
  if (!locations) return ''
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath
  const dirs = [locations.commonDir, locations.gitDir]
  for (const dir of dirs) {
    if (!dir) continue
    const refPath = path.join(dir, ref)
    if (!fs.existsSync(refPath)) continue
    const content = fs.readFileSync(refPath, 'utf8').trim()
    if (/^[0-9a-f]{40}$/i.test(content)) return content
  }
  for (const dir of dirs) {
    if (!dir) continue
    const packedPath = path.join(dir, 'packed-refs')
    if (!fs.existsSync(packedPath)) continue
    const lines = fs.readFileSync(packedPath, 'utf8').split(/\r?\n/)
    for (const line of lines) {
      const value = line.trim()
      if (value === '' || value.startsWith('#') || value.startsWith('^')) continue
      const [hash, name] = value.split(/\s+/)
      if (name === ref && /^[0-9a-f]{40}$/i.test(hash)) return hash
    }
  }
  return ''
}

/**
 * Read the short commit hash a ref points at, from loose refs first and
 * packed-refs second. Returns an empty string when the ref cannot be resolved.
 * @param {string} ref
 * @param {{ gitDir: string, commonDir: string }} locations
 * @param {object} [deps]
 */
function readRefCommit(ref, locations, deps = {}) {
  const full = readRefCommitFull(ref, locations, deps)
  return full ? full.slice(0, 7) : ''
}

/**
 * Safely detect the current git branch without executing shell commands.
 * Handles both standard repositories and git worktrees with `.git` files.
 * @param {string} workspaceDir
 * @param {object} [deps]
 * @returns {string} Branch name, detached short commit hash, or empty string.
 */
export function detectGitBranch(workspaceDir, deps = {}) {
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath
  const locations = resolveGitLocations(workspaceDir, deps)
  if (!locations) return ''

  try {
    const headPath = path.join(locations.gitDir, 'HEAD')
    if (!fs.existsSync(headPath)) return ''
    const headContent = fs.readFileSync(headPath, 'utf8').trim()
    if (headContent.startsWith('ref: refs/heads/')) {
      return headContent.slice('ref: refs/heads/'.length).trim()
    }
    if (headContent.startsWith('ref: ')) {
      return headContent.slice('ref: '.length).trim()
    }
    // Detached HEAD commit hash
    if (/^[0-9a-f]{40}$/i.test(headContent)) return headContent.slice(0, 7)
    return headContent
  } catch {
    return ''
  }
}

/**
 * Resolve the current HEAD commit hash without executing shell commands.
 * @param {string} workspaceDir
 * @param {object} [deps]
 * @returns {string} short 7-char commit hash, or empty string when unavailable.
 */
export function detectGitCommit(workspaceDir, deps = {}) {
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath
  const locations = resolveGitLocations(workspaceDir, deps)
  if (!locations) return ''

  try {
    const headPath = path.join(locations.gitDir, 'HEAD')
    if (!fs.existsSync(headPath)) return ''
    const headContent = fs.readFileSync(headPath, 'utf8').trim()
    if (/^[0-9a-f]{40}$/i.test(headContent)) return headContent.slice(0, 7)
    if (!headContent.startsWith('ref: ')) return ''
    const ref = headContent.slice('ref: '.length).trim()
    return readRefCommit(ref, locations, deps)
  } catch {
    return ''
  }
}

/**
 * Resolve full 40-character HEAD commit SHA and branch metadata without executing shell commands.
 * Handles both standard repositories and git worktrees with `.git` files.
 * @param {string} workspaceDir
 * @param {object} [deps]
 * @returns {{ isRepo: boolean, gitBranch?: string, gitHead?: string }}
 */
export function detectGitHeadFull(workspaceDir, deps = {}) {
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath
  const locations = resolveGitLocations(workspaceDir, deps)
  if (!locations) return { isRepo: false }

  try {
    const headPath = path.join(locations.gitDir, 'HEAD')
    if (!fs.existsSync(headPath)) return { isRepo: false }
    const headContent = fs.readFileSync(headPath, 'utf8').trim()

    // Detached HEAD commit hash
    if (/^[0-9a-f]{40}$/i.test(headContent)) {
      return { isRepo: true, gitBranch: '', gitHead: headContent }
    }

    if (headContent.startsWith('ref: ')) {
      const ref = headContent.slice('ref: '.length).trim()
      let gitBranch = ref
      if (ref.startsWith('refs/heads/')) {
        gitBranch = ref.slice('refs/heads/'.length).trim()
      }
      const gitHead = readRefCommitFull(ref, locations, deps)
      return {
        isRepo: true,
        gitBranch,
        ...(gitHead ? { gitHead } : {}),
      }
    }

    return { isRepo: true }
  } catch {
    return { isRepo: false }
  }
}

const GIT_ENV_VARS_TO_CLEAR = Object.freeze([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CEILING_DIRECTORIES',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_REPLACE_REF_BASE',
])

/**
 * Execute read-only git rev-list in the specified workspace with strict security guardrails.
 * @param {object} options
 * @param {string} options.workspaceDir
 * @param {string} options.from - 40-char commit SHA
 * @param {string} options.to - 40-char commit SHA
 * @param {Function} [options.execFile] - Custom execFile function for dependency injection
 * @param {object} [deps]
 * @param {Function} [deps.execFile]
 * @returns {Promise<{ ok: boolean, status: number, from?: string, to?: string, truncated?: boolean, commits?: Array<object>, error?: string, detail?: string }>}
 */
export async function runGitCommitRange(options = {}, deps = {}) {
  const { workspaceDir, from, to } = options
  const execFileFn = options.execFile || deps.execFile || nodeChildProcess.execFile

  if (!from || !to || !/^[0-9a-f]{40}$/i.test(from) || !/^[0-9a-f]{40}$/i.test(to)) {
    return { ok: false, status: 400, error: 'invalid-sha' }
  }

  if (from.toLowerCase() === to.toLowerCase()) {
    return { ok: true, status: 200, from, to, truncated: false, commits: [] }
  }

  const env = { ...process.env }
  // Deleting is important: empty GIT_DIR makes real git reject every repo
  // (`fatal: not a git repository: ''`), it does not mean "unset".
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key]
  }
  for (const key of GIT_ENV_VARS_TO_CLEAR) delete env[key]
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_NO_LAZY_FETCH = '1'
  env.LC_ALL = 'C'
  env.GIT_OPTIONAL_LOCKS = '0'

  const cmd = 'git'
  const args = [
    '--no-optional-locks',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    'rev-list',
    '--reverse',
    '--max-count=101',
    '--no-commit-header',
    '--format=%H%x09%ct%x09%s',
    `${from}..${to}`,
  ]

  const opts = {
    cwd: workspaceDir,
    timeout: 8000,
    maxBuffer: 1024 * 1024,
    env,
  }

  return new Promise(resolve => {
    try {
      execFileFn(cmd, args, opts, (err, stdout) => {
        if (err) {
          resolve({
            ok: false,
            status: 500,
            error: 'range-failed',
            detail: err.message || String(err),
          })
          return
        }

        const lines = (stdout || '').split('\n').filter(Boolean)
        const parsedCommits = []

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
          const firstTab = line.indexOf('\t')
          const secondTab = firstTab !== -1 ? line.indexOf('\t', firstTab + 1) : -1
          if (firstTab === -1 || secondTab === -1) continue

          const hash = line.slice(0, firstTab)
          const shortHash = hash.slice(0, 7)
          const time = Number.parseInt(line.slice(firstTab + 1, secondTab), 10) || 0
          const subject = line.slice(secondTab + 1).slice(0, 200)

          parsedCommits.push({ hash, shortHash, subject, time })
        }

        const truncated = parsedCommits.length >= 101
        const commits = truncated ? parsedCommits.slice(-100) : parsedCommits

        resolve({
          ok: true,
          status: 200,
          from,
          to,
          truncated,
          commits,
        })
      })
    } catch (err) {
      resolve({
        ok: false,
        status: 500,
        error: 'range-failed',
        detail: err.message || String(err),
      })
    }
  })
}

/**
 * Rolling prune for prompt logs:
 * Max 1000 records AND max 30 days retention.
 * Whichever limit hits first triggers deletion of older records and removes their index.
 * @param {Array<object>} logs
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxCount] Defaults to 1000
 * @param {number} [options.maxAgeMs] Defaults to 30 days
 * @returns {Array<object>} Pruned logs array
 */
export function prunePromptLogs(logs, {
  now = Date.now(),
  maxCount = 1000,
  maxAgeMs = 30 * 24 * 3600 * 1000,
} = {}) {
  if (!Array.isArray(logs)) return []
  const cutoff = now - maxAgeMs

  // 1. Time-based retention pruning (drop items older than 30 days)
  const nonExpired = logs.filter(entry => {
    if (!entry) return false
    const timestamp = typeof entry.time === 'number'
      ? entry.time
      : (typeof entry.createdAt === 'number' ? entry.createdAt : 0)
    return timestamp >= cutoff
  })

  // 2. Count-based pruning (keep at most 1000 newest items)
  if (nonExpired.length <= maxCount) {
    return nonExpired
  }

  // Sort descending by timestamp to take the top maxCount
  const sorted = [...nonExpired].sort((a, b) => {
    const timeB = b.time ?? b.createdAt ?? 0
    const timeA = a.time ?? a.createdAt ?? 0
    return timeB - timeA
  })
  const kept = sorted.slice(0, maxCount)
  // Restore chronological order
  return kept.reverse()
}

/**
 * Prune commit trace records on a rolling window by max retention time and max record count.
 * @param {Array<object>} traces Array of CommitTrace objects
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxCount] Defaults to 1000
 * @param {number} [options.maxAgeMs] Defaults to 30 days
 * @returns {Array<object>} Pruned traces array in chronological order
 */
export function pruneCommitTraces(traces, {
  now = Date.now(),
  maxCount = 1000,
  maxAgeMs = 30 * 24 * 3600 * 1000,
} = {}) {
  if (!Array.isArray(traces)) return []
  const cutoff = now - maxAgeMs

  // 1. Time-based retention pruning (drop items older than 30 days)
  const nonExpired = traces.filter(entry => {
    if (!entry) return false
    const timestamp = typeof entry.capturedAt === 'number'
      ? entry.capturedAt
      : (typeof entry.updatedAt === 'number'
        ? entry.updatedAt
        : (typeof entry.time === 'number' ? entry.time : 0))
    // Legacy/imported traces may have no timestamp; verification keeps them,
    // so pruning must keep them too (otherwise migration never verifies).
    return timestamp === 0 || timestamp >= cutoff
  })

  // 2. Count-based pruning (keep at most 1000 newest items)
  if (nonExpired.length <= maxCount) {
    return nonExpired
  }

  // Sort descending by timestamp to take the top maxCount
  const sorted = [...nonExpired].sort((a, b) => {
    const timeB = b.capturedAt ?? b.updatedAt ?? b.time ?? 0
    const timeA = a.capturedAt ?? a.updatedAt ?? a.time ?? 0
    return timeB - timeA
  })
  const kept = sorted.slice(0, maxCount)
  // Restore chronological order
  return kept.reverse()
}

/**
 * Timestamp used to arbitrate/prune distillation runs and fingerprints.
 * @param {object} item
 * @returns {number}
 */
function distillItemTime(item) {
  if (!item || typeof item !== 'object') return 0
  if (typeof item.updatedAt === 'number') return item.updatedAt
  if (typeof item.createdAt === 'number') return item.createdAt
  if (typeof item.appliedAt === 'number') return item.appliedAt
  return 0
}

/**
 * Prune DistillationRun records on a rolling window (spec §13.1: 90 days / 100).
 * Untimestamped legacy rows are kept so import verification cannot deadlock.
 * @param {Array<object>} runs
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxCount] Defaults to 100
 * @param {number} [options.maxAgeMs] Defaults to 90 days
 * @returns {Array<object>} pruned runs in chronological order
 */
export function pruneDistillRuns(runs, {
  now = Date.now(),
  maxCount = DISTILL_RETENTION.runs.maxCount,
  maxAgeMs = DISTILL_RETENTION.runs.maxAgeMs,
} = {}) {
  if (!Array.isArray(runs)) return []
  const cutoff = now - maxAgeMs
  const nonExpired = runs.filter(entry => {
    if (!entry) return false
    const time = distillItemTime(entry)
    return time === 0 || time >= cutoff
  })
  if (nonExpired.length <= maxCount) return nonExpired
  const sorted = [...nonExpired].sort((a, b) => distillItemTime(b) - distillItemTime(a))
  return sorted.slice(0, maxCount).reverse()
}

/**
 * Prune DistillFingerprint records on a rolling window (spec §13.1: 365 days / 5000).
 * @param {Array<object>} fingerprints
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {number} [options.maxCount] Defaults to 5000
 * @param {number} [options.maxAgeMs] Defaults to 365 days
 * @returns {Array<object>} pruned fingerprints in chronological order
 */
export function pruneDistillFingerprints(fingerprints, {
  now = Date.now(),
  maxCount = DISTILL_RETENTION.fingerprints.maxCount,
  maxAgeMs = DISTILL_RETENTION.fingerprints.maxAgeMs,
} = {}) {
  if (!Array.isArray(fingerprints)) return []
  const cutoff = now - maxAgeMs
  const nonExpired = fingerprints.filter(entry => {
    if (!entry) return false
    const time = distillItemTime(entry)
    return time === 0 || time >= cutoff
  })
  if (nonExpired.length <= maxCount) return nonExpired
  const sorted = [...nonExpired].sort((a, b) => distillItemTime(b) - distillItemTime(a))
  return sorted.slice(0, maxCount).reverse()
}

/**
 * Drop distillPlans whose run is no longer present in `distillRuns`.
 * Plans "follow their run" per spec §13.1.
 * @param {object} state
 * @returns {number} number of removed plans
 */
function pruneOrphanDistillPlans(state) {
  if (!state || typeof state !== 'object') return 0
  if (!state.distillPlans || typeof state.distillPlans !== 'object') return 0
  const runIds = new Set()
  if (state.distillRuns && typeof state.distillRuns === 'object') {
    for (const list of Object.values(state.distillRuns)) {
      if (!Array.isArray(list)) continue
      for (const run of list) {
        if (run && typeof run.id === 'string') runIds.add(run.id)
      }
    }
  }
  let removed = 0
  for (const key of Object.keys(state.distillPlans)) {
    const runId = key.startsWith('run:') ? key.slice('run:'.length) : key
    if (!runIds.has(runId)) {
      delete state.distillPlans[key]
      removed += 1
    }
  }
  return removed
}

/**
 * Create a default empty state for Host store.
 */
function defaultState() {
  return {
    version: HOST_STATE_VERSION,
    workspaceRecords: [],
    workspaces: [],
    groups: {},
    entries: {},
    promptLogs: {},
    commitTraces: {},
    distillRuns: {},
    distillPlans: {},
    distillFingerprints: {},
    turnActions: {},
    handoffs: {},
    prefs: { ...DEFAULT_PREFS },
  }
}

/**
 * Create Host-side storage domain implementation supporting `~/.dsh/storages/punch_desk.json`.
 * @param {object} [options]
 * @param {string} [options.storageRoot]
 * @param {string} [options.storageFilePath]
 * @param {object} [options.fs]
 * @param {object} [options.path]
 * @param {object} [options.os]
 * @param {object} [options.crypto]
 * @param {() => number} [options.now]
 * @param {() => string} [options.uuid]
 * @returns {import('./contract.js').DeskStore & {
 *   filePath: string,
 *   cleanExpiredPromptLogs: (options?: object) => Promise<{ prunedCount: number, remainingCount: number }>,
 *   listWorkspaces: () => Promise<string[]>,
 *   listWorkspaceRecords: () => Promise<import('../domain/workspace.js').WorkspaceRecord[]>,
 *   putWorkspaceRecord: (record: import('../domain/workspace.js').WorkspaceRecord) => Promise<void>,
 *   getGroups: (sessionId: string) => Promise<import('../domain/active-group.js').GroupRecord[]>,
 *   putGroup: (group: import('../domain/active-group.js').GroupRecord) => Promise<void>,
 *   getGroupsMigrationStatus: () => { status: 'pending'|'skipped'|'migrated'|'failed', [key: string]: any },
 *   revision: (workspaceKey: string) => number,
 *   dispose: () => void,
 * }}
 */
export function createHostDeskStore({
  storageRoot,
  storageFilePath,
  fs = nodeFs,
  path = nodePath,
  os = nodeOs,
  crypto = nodeCrypto,
  now = Date.now,
  uuid = () => crypto.randomUUID(),
} = {}) {
  const isTest = typeof process !== 'undefined' && (
    process.env.NODE_ENV === 'test' ||
    (Array.isArray(process.execArgv) && process.execArgv.includes('--test'))
  )
  const root = storageRoot || process.env.DSH_STORAGE_ROOT || (
    isTest ? path.join(os.tmpdir(), `dsh-punch-desk-test-${process.pid}`) : path.join(os.homedir(), '.dsh', 'storages')
  )
  const filePath = storageFilePath || path.join(root, 'punch_desk.json')

  const listeners = new Set()
  const revisions = new Map()
  // Set when the on-disk file was written by a newer schema version. Writes are
  // refused (read-only) rather than rewriting unknown buckets away.
  let storageReadOnly = false

  function bump(workspaceKey) {
    revisions.set(workspaceKey, (revisions.get(workspaceKey) ?? 0) + 1)
  }

  function notify() {
    for (const listener of listeners) {
      try { listener() } catch {}
    }
  }

  function parseState() {
    try {
      if (!fs.existsSync(filePath)) {
        return defaultState()
      }
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const rawVersion = Number.isFinite(parsed.version) ? parsed.version : 2
      storageReadOnly = rawVersion > HOST_STATE_VERSION
      return {
        version: storageReadOnly ? rawVersion : HOST_STATE_VERSION,
        workspaceRecords: Array.isArray(parsed.workspaceRecords) ? parsed.workspaceRecords : [],
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
        entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
        promptLogs: parsed.promptLogs && typeof parsed.promptLogs === 'object' ? parsed.promptLogs : {},
        commitTraces: parsed.commitTraces && typeof parsed.commitTraces === 'object' ? parsed.commitTraces : {},
        distillRuns: parsed.distillRuns && typeof parsed.distillRuns === 'object' ? parsed.distillRuns : {},
        distillPlans: parsed.distillPlans && typeof parsed.distillPlans === 'object' ? parsed.distillPlans : {},
        distillFingerprints: parsed.distillFingerprints && typeof parsed.distillFingerprints === 'object' ? parsed.distillFingerprints : {},
        turnActions: parsed.turnActions && typeof parsed.turnActions === 'object' ? parsed.turnActions : {},
        handoffs: parsed.handoffs && typeof parsed.handoffs === 'object' ? parsed.handoffs : {},
        prefs: parsed.prefs && typeof parsed.prefs === 'object' ? { ...DEFAULT_PREFS, ...parsed.prefs } : { ...DEFAULT_PREFS },
      }
    } catch (err) {
      if (fs.existsSync(filePath)) {
        try {
          const corruptBackup = `${filePath}.corrupt.${Date.now()}`
          fs.copyFileSync(filePath, corruptBackup)
          console.warn(`[punch-desk] Corrupted storage file at ${filePath}. Created emergency backup at ${corruptBackup}. Falling back to default state safely.`)
        } catch {}
      }
      storageReadOnly = false
      return defaultState()
    }
  }

  /**
   * One-time legacy alias migration state. `failed` is deliberately sticky for
   * the lifetime of this store instance so a verification failure retries on
   * the next startup instead of hammering the disk on every read.
   */
  let groupsMigration = { status: 'pending' }

  /**
   * Create a non-overwriting backup of the storage file.
   * @returns {string|null} backup path, or null when the backup could not be created
   */
  function createGroupsBackup() {
    const base = `${filePath}.bak-${now()}`
    let candidate = base
    let suffix = 1
    while (fs.existsSync(candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
      if (suffix > 1000) return null
    }
    try {
      fs.copyFileSync(filePath, candidate)
      return candidate
    } catch {
      return null
    }
  }

  /**
   * Re-read the file from disk and verify the migrated shape:
   * one canonical key per session and the same deduped group total.
   * @param {Record<string, any[]>} expectedGroups
   * @returns {{ ok: boolean, reason?: string, keys?: number, actualGroups?: number }}
   */
  /**
   * Non-overwriting backup of the whole storage file. Used before a destructive
   * replace-import so a wrong file can always be rolled back offline.
   * @returns {string|null}
   */
  function createStorageBackup() {
    if (!fs.existsSync(filePath)) return null
    const base = `${filePath}.bak-${now()}`
    let candidate = base
    let suffix = 1
    while (fs.existsSync(candidate)) {
      candidate = `${base}-${suffix}`
      suffix += 1
      if (suffix > 1000) return null
    }
    try {
      fs.copyFileSync(filePath, candidate)
      return candidate
    } catch {
      return null
    }
  }

  function verifyGroupsMigration(expectedGroups) {
    const expectedKeys = Object.keys(expectedGroups)
    let expectedCount = 0
    for (const key of expectedKeys) expectedCount += expectedGroups[key].length

    const disk = parseState()
    const groups = disk.groups && typeof disk.groups === 'object' ? disk.groups : {}
    const keys = Object.keys(groups)

    let actualCount = 0
    for (const key of keys) {
      if (groupsKeyFor(key) !== key) {
        return { ok: false, reason: 'non-canonical-key', actualGroups: actualCount }
      }
      if (!Array.isArray(groups[key])) {
        return { ok: false, reason: 'non-array-group-key', actualGroups: actualCount }
      }
      actualCount += groups[key].length
    }

    // Canonical keys are unique object keys, so "exactly one group key per
    // session" reduces to "no alias key survived and every expected key exists".
    if (keys.length !== expectedKeys.length) {
      return { ok: false, reason: 'session-key-count-mismatch', keys: keys.length, actualGroups: actualCount }
    }
    for (const key of expectedKeys) {
      if (!Array.isArray(groups[key])) {
        return { ok: false, reason: 'missing-session-key', keys: keys.length, actualGroups: actualCount }
      }
    }

    if (actualCount !== expectedCount) {
      return { ok: false, reason: 'group-count-mismatch', keys: keys.length, actualGroups: actualCount }
    }

    for (const key of expectedKeys) {
      const expectedList = expectedGroups[key]
      const actualList = groups[key]
      if (actualList.length !== expectedList.length) {
        return { ok: false, reason: 'group-count-mismatch', keys: keys.length, actualGroups: actualCount }
      }
      const expectedIds = expectedList
        .map(group => group?.id)
        .filter(id => id !== undefined && id !== null)
      const actualIds = actualList
        .map(group => group?.id)
        .filter(id => id !== undefined && id !== null)
      if (expectedIds.length !== actualIds.length) {
        return { ok: false, reason: 'group-id-count-mismatch', keys: keys.length, actualGroups: actualCount }
      }
      const actualSet = new Set(actualIds)
      for (const id of expectedIds) {
        if (!actualSet.has(id)) {
          return { ok: false, reason: 'group-id-missing', keys: keys.length, actualGroups: actualCount }
        }
      }
    }

    return { ok: true, keys: keys.length, actualGroups: actualCount }
  }

  /**
   * Collapse legacy multi-key group data into the single canonical key and
   * persist it exactly once. The old file is backed up first, the write is
   * atomic (temp + rename) and the result is verified by reading the file back.
   * On any failure the original data is restored and the migration is left
   * pending for the next startup.
   * @param {object} state
   * @returns {object}
   */
  function migrateGroupsIfNeeded(state) {
    // A newer-schema file is read-only; do not attempt legacy writes on it.
    if (storageReadOnly) return state
    const plan = planGroupsMigration(state.groups)
    if (!plan.needed) {
      if (groupsMigration.status === 'pending') {
        groupsMigration = { status: 'skipped', keys: plan.keys.length }
      }
      return state
    }
    if (groupsMigration.status === 'failed') return state

    const backupPath = createGroupsBackup()
    if (!backupPath) {
      groupsMigration = {
        status: 'failed',
        reason: 'backup-failed',
        expectedGroups: plan.expectedGroupCount,
      }
      return state
    }

    const candidate = { ...state, groups: plan.groups }
    if (!writeState(candidate)) {
      groupsMigration = {
        status: 'failed',
        reason: 'write-failed',
        backupPath,
        expectedGroups: plan.expectedGroupCount,
      }
      return state
    }

    const verification = verifyGroupsMigration(plan.groups)
    if (!verification.ok) {
      let restored = false
      try {
        fs.copyFileSync(backupPath, filePath)
        restored = true
      } catch {}
      if (!restored) {
        try { restored = writeState(state) } catch {}
      }
      groupsMigration = {
        status: 'failed',
        reason: verification.reason || 'verification-failed',
        backupPath,
        restored,
        expectedGroups: plan.expectedGroupCount,
        actualGroups: verification.actualGroups,
      }
      return state
    }

    groupsMigration = {
      status: 'migrated',
      backupPath,
      keys: verification.keys,
      groups: verification.actualGroups,
    }
    return candidate
  }

  /**
   * One-shot self-healing of empty session buckets written by an older build.
   * The prune runs on the first read of each store instance and rewrites the
   * file only when it actually removed residue, so an upgraded profile stops
   * advertising deleted sessions without a manual data edit.
   */
  let residuePruned = false
  function pruneStoredResidueOnce(state) {
    if (residuePruned || storageReadOnly) return state
    residuePruned = true
    if (pruneEmptySessionBuckets(state)) writeState(state)
    return state
  }

  function readState() {
    return pruneStoredResidueOnce(migrateGroupsIfNeeded(parseState()))
  }

  function writeState(state) {
    // Never downgrade or partially rewrite a file created by a newer build.
    if (storageReadOnly) return false
    if (state && Number(state.version) > HOST_STATE_VERSION) {
      storageReadOnly = true
      return false
    }
    try {
      const dir = path.dirname(filePath)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      const tmpPath = path.join(
        dir,
        `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
      )
      fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), 'utf8')
      fs.renameSync(tmpPath, filePath)
      return true
    } catch {
      return false
    }
  }

  return {
    filePath,

    /**
     * Introspection helper for the one-time groups alias migration. Not part of
     * the DeskStore contract: it exists so hosts/tests can observe whether the
     * legacy multi-key layout has been collapsed, skipped or left pending.
     * @returns {{ status: 'pending'|'skipped'|'migrated'|'failed', [key: string]: any }}
     */
    getGroupsMigrationStatus() {
      return { ...groupsMigration }
    },

    /**
     * Schema version of the on-disk file plus the write guard flag. A file from
     * a newer build is surfaced as `readOnly: true` and all writes are refused.
     * @returns {{ version: number, readOnly: boolean }}
     */
    getStateVersionInfo() {
      const state = parseState()
      return { version: state.version, readOnly: storageReadOnly }
    },

    async listEntries(workspaceKey) {
      const state = readState()
      const list = state.entries[workspaceKey]
      return Array.isArray(list) ? [...list] : []
    },

    async getEntry(workspaceKey, id) {
      const state = readState()
      const list = state.entries[workspaceKey] || []
      return list.find(item => item.id === id)
    },

    async putEntry(entry) {
      if (!entry || typeof entry !== 'object' || !entry.id) return
      const workspaceKey = entry.workspaceKey || (entry.sessionId ? `session:${entry.sessionId}` : 'draft:global')
      const state = readState()
      const list = state.entries[workspaceKey] || []
      const index = list.findIndex(item => item.id === entry.id)
      const nextList = [...list]
      if (index >= 0) {
        nextList[index] = { ...nextList[index], ...entry, updatedAt: now() }
      } else {
        nextList.push({ ...entry, createdAt: entry.createdAt ?? now(), updatedAt: now() })
      }
      state.entries[workspaceKey] = nextList

      // Ensure workspace is recorded
      if (!state.workspaces.includes(workspaceKey)) {
        state.workspaces.push(workspaceKey)
      }

      writeState(state)
      bump(workspaceKey)
      notify()
    },

    async putEntries(workspaceKey, entries) {
      if (!workspaceKey || !Array.isArray(entries)) return
      const state = readState()
      if (entries.length === 0) {
        // Replacing with zero rows means the session has no findings left.
        // Keeping the empty bucket would advertise a phantom session forever.
        const hadEntries = Object.hasOwn(state.entries, workspaceKey)
        if (hadEntries) delete state.entries[workspaceKey]
        if (pruneEmptySessionBuckets(state) || hadEntries) {
          writeState(state)
          bump(workspaceKey)
          notify()
        }
        return
      }
      state.entries[workspaceKey] = [...entries]
      if (!state.workspaces.includes(workspaceKey)) {
        state.workspaces.push(workspaceKey)
      }
      writeState(state)
      bump(workspaceKey)
      notify()
    },

    async deleteEntry(workspaceKey, id) {
      const state = readState()
      const list = state.entries[workspaceKey] || []
      const next = list.filter(item => item.id !== id)
      if (next.length === 0) delete state.entries[workspaceKey]
      else state.entries[workspaceKey] = next
      pruneEmptySessionBuckets(state)
      writeState(state)
      bump(workspaceKey)
      notify()
    },

    async listPromptLog(workspaceKey, filter) {
      const state = readState()
      const list = state.promptLogs[workspaceKey] || []
      if (!filter || typeof filter !== 'object') {
        return [...list]
      }
      return list.filter(item => {
        for (const [key, val] of Object.entries(filter)) {
          if (item[key] !== val) return false
        }
        return true
      })
    },

    async upsertPromptLog(workspaceKey, entries) {
      if (!Array.isArray(entries) || entries.length === 0) return
      const state = readState()
      const existing = state.promptLogs[workspaceKey] || []
      const map = new Map(existing.map(item => [item.messageId || item.id, item]))

      for (const entry of entries) {
        const key = entry.messageId || entry.id
        if (!key) continue
        map.set(key, { ...map.get(key), ...entry })
      }

      const merged = [...map.values()]
      // Rolling prune to the user-configured window (age AND count)
      const retention = retentionWindowFromPrefs(state.prefs)
      const pruned = prunePromptLogs(merged, { now: now(), maxCount: retention.maxCount, maxAgeMs: retention.maxAgeMs })

      state.promptLogs[workspaceKey] = pruned
      if (!state.workspaces.includes(workspaceKey)) {
        state.workspaces.push(workspaceKey)
      }

      writeState(state)
      bump(workspaceKey)
      notify()
    },

    async deletePromptLog(workspaceKey, messageId) {
      const state = readState()
      const list = state.promptLogs[workspaceKey] || []
      const next = list.filter(item => item.messageId !== messageId && item.id !== messageId)
      if (next.length === 0) delete state.promptLogs[workspaceKey]
      else state.promptLogs[workspaceKey] = next
      pruneEmptySessionBuckets(state)
      writeState(state)
      bump(workspaceKey)
      notify()
    },

    async listCommitTraces(sessionKey) {
      const key = commitTracesKeyFor(sessionKey) || sessionKey
      const state = readState()
      const cleanKey = typeof key === 'string' && key.startsWith('session:') ? key.slice('session:'.length) : key
      const list = state.commitTraces[key] || state.commitTraces[cleanKey] || []
      if (!Array.isArray(list)) return []
      return [...list].sort((a, b) => {
        const ta = Number.isFinite(a?.turn) ? a.turn : Number.MAX_SAFE_INTEGER
        const tb = Number.isFinite(b?.turn) ? b.turn : Number.MAX_SAFE_INTEGER
        return ta - tb
      })
    },

    async listTurnActions(sessionKey) {
      const key = turnActionsKeyFor(sessionKey)
      if (!key) return null
      const state = readState()
      const raw = state.turnActions?.[key]
      if (!raw || typeof raw !== 'object') return null
      return JSON.parse(JSON.stringify(raw))
    },

    async putTurnActions(sessionKey, turnState) {
      const key = turnActionsKeyFor(sessionKey)
      if (!key || !turnState || typeof turnState !== 'object') return
      const state = readState()
      const prev = state.turnActions?.[key]
      const sessionId = turnState.sessionId || prev?.sessionId || key.slice('session:'.length)
      const rawItems = Array.isArray(turnState.items) ? turnState.items : (Array.isArray(prev?.items) ? prev.items : [])
      const prunedItems = pruneTurnActionItems(rawItems, 500)
      if (!state.turnActions || typeof state.turnActions !== 'object') {
        state.turnActions = {}
      }
      state.turnActions[key] = {
        version: typeof turnState.version === 'number' ? turnState.version : (prev?.version ?? 1),
        sessionId,
        scannedThroughSeq: Number.isFinite(turnState.scannedThroughSeq) ? turnState.scannedThroughSeq : (prev?.scannedThroughSeq ?? 0),
        scannedAt: typeof turnState.scannedAt === 'number' ? turnState.scannedAt : now(),
        items: prunedItems,
      }
      writeState(state)
      bump(key)
      notify()
    },

    async deleteTurnActions(sessionKey) {
      const key = turnActionsKeyFor(sessionKey)
      if (!key) return
      const state = readState()
      if (state.turnActions && key in state.turnActions) {
        delete state.turnActions[key]
        writeState(state)
        bump(key)
        notify()
      }
    },

    async putCommitTraces(sessionKey, traces) {
      if (!Array.isArray(traces) || traces.length === 0) return
      const key = commitTracesKeyFor(sessionKey) || sessionKey
      const state = readState()
      const existing = state.commitTraces[key] || []
      const map = new Map(existing.map(item => [item.id, item]))

      for (const trace of traces) {
        if (!trace || !trace.id) continue
        const prev = map.get(trace.id)
        const effectiveUpdatedAt = typeof trace.updatedAt === 'number'
          ? trace.updatedAt
          : (typeof trace.capturedAt === 'number' ? trace.capturedAt : now())
        map.set(trace.id, {
          ...prev,
          ...trace,
          updatedAt: effectiveUpdatedAt,
        })
      }

      const merged = [...map.values()]
      const retention = retentionWindowFromPrefs(state.prefs)
      const pruned = pruneCommitTraces(merged, { now: now(), maxCount: retention.maxCount, maxAgeMs: retention.maxAgeMs })

      state.commitTraces[key] = pruned
      writeState(state)
      bump(key)
      notify()
    },

    async lookupCommitTraces({ workspaceId, hash, limit = 20 } = {}) {
      if (!workspaceId || typeof workspaceId !== 'string' || !workspaceId.trim()) {
        throw new Error('Missing or invalid workspaceId')
      }
      if (!hash || typeof hash !== 'string' || !/^[0-9a-f]{7,40}$/i.test(hash.trim())) {
        throw new Error('Invalid hash: must be 7-40 hex characters')
      }

      const targetWs = workspaceId.trim()
      const normalizedHash = hash.trim().toLowerCase()
      const maxLimit = Math.min(20, Math.max(1, Number(limit) || 20))
      const state = readState()

      const matches = []
      const buckets = state.commitTraces && typeof state.commitTraces === 'object'
        ? Object.values(state.commitTraces)
        : []

      for (const bucket of buckets) {
        if (!Array.isArray(bucket)) continue
        for (const trace of bucket) {
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
    },

    /**
     * Upsert a DistillationRun into `distillRuns['ws:<workspaceId>']`, enforce
     * the 90-day/100-run retention and drop orphan plans. The write is verified
     * by re-reading the file from disk (spec §13.1 "写后重读磁盘断言").
     * @param {object} run
     * @returns {Promise<object>} persisted run
     */
    async putDistillRun(run) {
      if (!run || typeof run !== 'object' || !run.id) {
        throw new Error('putDistillRun requires run.id')
      }
      const workspaceId = typeof run.workspaceId === 'string' ? run.workspaceId.trim() : ''
      if (!workspaceId) throw new Error('putDistillRun requires run.workspaceId')
      const key = distillRunBucketKey(workspaceId)
      const state = readState()
      if (!state.distillRuns[key]) state.distillRuns[key] = []
      const list = Array.isArray(state.distillRuns[key]) ? [...state.distillRuns[key]] : []
      const index = list.findIndex(item => item && item.id === run.id)
      const next = {
        ...(index >= 0 ? list[index] : {}),
        ...run,
        updatedAt: typeof run.updatedAt === 'number' ? run.updatedAt : now(),
      }
      if (index >= 0) list[index] = next
      else list.push(next)
      const retainedRuns = pruneDistillRuns(list, { now: now() })
      state.distillRuns[key] = retainedRuns
      pruneOrphanDistillPlans(state)
      if (!writeState(state)) {
        throw new Error(`Distill run ${run.id} was not persisted (storage read-only or write failed)`)
      }
      bump(key)
      notify()
      const disk = parseState()
      const diskList = Array.isArray(disk.distillRuns[key]) ? disk.distillRuns[key] : []
      const persisted = diskList.some(item => item && item.id === run.id)
      // A run may legitimately be pruned on write (old row or count overflow);
      // only a row that should have been retained proves a whitelist/osync bug.
      const shouldPersist = retainedRuns.some(item => item && item.id === run.id)
      if (shouldPersist && !persisted) {
        throw new Error(`Distill run ${run.id} read-back verification failed`)
      }
      return { ...next }
    },

    /**
     * Find a run by id across all workspace buckets (run ids are UUIDs).
     * @param {string} runId
     * @returns {Promise<object|null>}
     */
    async getDistillRun(runId) {
      if (typeof runId !== 'string' || !runId.trim()) return null
      const state = readState()
      for (const list of Object.values(state.distillRuns)) {
        if (!Array.isArray(list)) continue
        const found = list.find(item => item && item.id === runId)
        if (found) return { ...found }
      }
      return null
    },

    /**
     * List runs for one workspace, newest first.
     * @param {string} workspaceId
     * @param {{ statuses?: string[] }} [options]
     * @returns {Promise<object[]>}
     */
    async listDistillRuns(workspaceId, { statuses = null } = {}) {
      const key = distillRunBucketKey(workspaceId)
      if (!key) return []
      const state = readState()
      const list = Array.isArray(state.distillRuns[key]) ? state.distillRuns[key] : []
      const allowed = Array.isArray(statuses) && statuses.length > 0 ? new Set(statuses) : null
      return list
        .filter(run => run && (!allowed || allowed.has(run.status)))
        .map(run => ({ ...run }))
        .sort((a, b) => distillItemTime(b) - distillItemTime(a))
    },

    /**
     * Persist a DistillPlan/ChangePlan under `distillPlans['run:<runId>']`.
     * @param {object} plan
     * @returns {Promise<object>}
     */
    async putDistillPlan(plan) {
      if (!plan || typeof plan !== 'object' || !plan.runId) {
        throw new Error('putDistillPlan requires plan.runId')
      }
      const key = distillPlanKeyFor(plan.runId)
      const state = readState()
      state.distillPlans[key] = { ...plan }
      if (!writeState(state)) {
        throw new Error(`Distill plan for ${plan.runId} was not persisted (storage read-only or write failed)`)
      }
      bump(key)
      notify()
      const disk = parseState()
      if (!disk.distillPlans[key]) throw new Error(`Distill plan for ${plan.runId} read-back verification failed`)
      return { ...plan }
    },

    /**
     * Remove one DistillRun row from its `ws:<workspaceId>` bucket.
     * Terminal-run deletion only (the caller enforces readiness); the plan row is
     * deleted separately, fingerprints are audit history and are kept.
     * @param {string} runId
     * @returns {Promise<boolean>} whether a row was removed
     */
    async deleteDistillRun(runId) {
      if (typeof runId !== 'string' || runId === '') return false
      const state = readState()
      for (const bucket of Object.values(state.distillRuns || {})) {
        if (!Array.isArray(bucket)) continue
        const index = bucket.findIndex(run => run && run.id === runId)
        if (index >= 0) {
          bucket.splice(index, 1)
          if (!writeState(state)) throw new Error(`Distill run ${runId} was not deleted (storage read-only or write failed)`)
          bump(`distill:${runId}`)
          notify()
          return true
        }
      }
      return false
    },

    /**
     * @param {string} runId
     * @returns {Promise<object|null>}
     */
    async getDistillPlan(runId) {
      const key = distillPlanKeyFor(runId)
      if (!key) return null
      const state = readState()
      return state.distillPlans[key] ? { ...state.distillPlans[key] } : null
    },

    /**
     * @param {string} runId
     * @returns {Promise<boolean>} whether a plan row was removed
     */
    async deleteDistillPlan(runId) {
      const key = distillPlanKeyFor(runId)
      if (!key) return false
      const state = readState()
      if (!state.distillPlans[key]) return false
      delete state.distillPlans[key]
      writeState(state)
      bump(key)
      notify()
      return true
    },

    /**
     * Upsert fingerprints for one workspace and enforce 365-day/5000-item retention.
     * @param {string} workspaceId
     * @param {object[]} fingerprints
     * @returns {Promise<object[]>} retained fingerprints
     */
    async putDistillFingerprints(workspaceId, fingerprints) {
      const key = distillRunBucketKey(workspaceId)
      if (!key) throw new Error('putDistillFingerprints requires workspaceId')
      if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
        const current = readState()
        const list = Array.isArray(current.distillFingerprints[key]) ? current.distillFingerprints[key] : []
        return list.map(item => ({ ...item }))
      }
      const state = readState()
      const existing = Array.isArray(state.distillFingerprints[key]) ? state.distillFingerprints[key] : []
      const map = new Map(existing.filter(item => item && item.id).map(item => [item.id, item]))
      for (const fingerprint of fingerprints) {
        if (!fingerprint || !fingerprint.id) continue
        map.set(fingerprint.id, { ...map.get(fingerprint.id), ...fingerprint })
      }
      const pruned = pruneDistillFingerprints([...map.values()], { now: now() })
      state.distillFingerprints[key] = pruned
      if (!writeState(state)) {
        throw new Error('Distill fingerprints were not persisted (storage read-only or write failed)')
      }
      bump(key)
      notify()
      const disk = parseState()
      const diskIds = new Set((Array.isArray(disk.distillFingerprints[key]) ? disk.distillFingerprints[key] : []).map(item => item?.id))
      const retainedIds = new Set(pruned.map(item => item?.id))
      for (const fingerprint of fingerprints) {
        if (!fingerprint || !fingerprint.id) continue
        // Rows pruned by retention cannot be read back; that is expected.
        if (!retainedIds.has(fingerprint.id)) continue
        if (!diskIds.has(fingerprint.id)) {
          throw new Error(`Distill fingerprint ${fingerprint.id} read-back verification failed`)
        }
      }
      return pruned.map(item => ({ ...item }))
    },

    /**
     * @param {string} workspaceId
     * @returns {Promise<object[]>}
     */
    async listDistillFingerprints(workspaceId) {
      const key = distillRunBucketKey(workspaceId)
      if (!key) return []
      const state = readState()
      const list = Array.isArray(state.distillFingerprints[key]) ? state.distillFingerprints[key] : []
      return list
        .filter(item => item && item.id)
        .map(item => ({ ...item }))
        .sort((a, b) => distillItemTime(b) - distillItemTime(a))
    },

    /**
     * Remove fingerprints by id (used when a transaction rolls back so the same
     * conclusion can be proposed again).
     * @param {string} workspaceId
     * @param {string[]} ids
     * @returns {Promise<number>} removed count
     */
    async deleteDistillFingerprints(workspaceId, ids) {
      const key = distillRunBucketKey(workspaceId)
      if (!key || !Array.isArray(ids) || ids.length === 0) return 0
      const removeIds = new Set(ids.filter(id => typeof id === 'string' && id))
      if (removeIds.size === 0) return 0
      const state = readState()
      const list = Array.isArray(state.distillFingerprints[key]) ? state.distillFingerprints[key] : []
      const remaining = list.filter(item => !item || !removeIds.has(item.id))
      const removed = list.length - remaining.length
      if (removed === 0) return 0
      state.distillFingerprints[key] = remaining
      writeState(state)
      bump(key)
      notify()
      return removed
    },

    /**
     * Retention execution point for lazy recovery (spec §13.1 point 8). Prunes
     * runs/fingerprints (optionally scoped to a workspace) and drops orphan plans.
     * @param {{ workspaceId?: string }} [options]
     * @returns {Promise<{ runs: number, plans: number, fingerprints: number }>}
     */
    async pruneDistillData({ workspaceId = null } = {}) {
      const state = readState()
      const scopedKey = workspaceId ? distillRunBucketKey(workspaceId) : ''
      let runsRemoved = 0
      let fingerprintsRemoved = 0
      for (const key of Object.keys(state.distillRuns)) {
        if (scopedKey && key !== scopedKey) continue
        const list = Array.isArray(state.distillRuns[key]) ? state.distillRuns[key] : []
        const pruned = pruneDistillRuns(list, { now: now() })
        runsRemoved += list.length - pruned.length
        state.distillRuns[key] = pruned
        if (pruned.length === 0) delete state.distillRuns[key]
      }
      for (const key of Object.keys(state.distillFingerprints)) {
        if (scopedKey && key !== scopedKey) continue
        const list = Array.isArray(state.distillFingerprints[key]) ? state.distillFingerprints[key] : []
        const pruned = pruneDistillFingerprints(list, { now: now() })
        fingerprintsRemoved += list.length - pruned.length
        state.distillFingerprints[key] = pruned
        if (pruned.length === 0) delete state.distillFingerprints[key]
      }
      const plansRemoved = pruneOrphanDistillPlans(state)
      if (runsRemoved + fingerprintsRemoved + plansRemoved > 0) {
        writeState(state)
        notify()
      }
      return { runs: runsRemoved, plans: plansRemoved, fingerprints: fingerprintsRemoved }
    },

    async setHandoff(sessionId, value) {
      const state = readState()
      state.handoffs[sessionId] = value
      writeState(state)
    },

    async getHandoff(sessionId) {
      const state = readState()
      return state.handoffs[sessionId] ?? null
    },

    async deleteHandoff(sessionId) {
      const state = readState()
      delete state.handoffs[sessionId]
      writeState(state)
    },

    async getPrefs() {
      const state = readState()
      return { ...DEFAULT_PREFS, ...state.prefs }
    },

    async setPrefs(prefs) {
      const state = readState()
      state.prefs = { ...state.prefs, ...prefs }
      writeState(state)
      notify()
    },

    async listWorkspaces() {
      const state = readState()
      const set = new Set()
      // Sessions are derived from their data buckets below. Replaying the raw
      // `workspaces` slots would resurrect a deleted session whose empty bucket
      // was the only trace left (the phantom "untitled" session bug).
      for (const key of state.workspaces) {
        if (sessionIdOfWorkspaceKey(key) !== null) continue
        set.add(key)
      }
      for (const bucket of [state.entries, state.promptLogs, state.commitTraces]) {
        if (!bucket || typeof bucket !== 'object') continue
        for (const key of Object.keys(bucket)) {
          if (hasNonEmptyArray(bucket, key)) set.add(key)
        }
      }
      if (state.groups && typeof state.groups === 'object') {
        for (const [sessionId, list] of Object.entries(state.groups)) {
          if (!Array.isArray(list) || list.length === 0) continue
          const key = commitTracesKeyFor(sessionId)
          if (key !== '') set.add(key)
        }
      }
      for (const rec of state.workspaceRecords) {
        if (rec?.id) set.add(rec.id)
      }
      return [...set]
    },

    async listWorkspaceRecords() {
      const state = readState()
      return [...state.workspaceRecords]
    },

    async putWorkspaceRecord(record) {
      const validation = validateWorkspaceRecord(record)
      if (!validation.ok) {
        throw new Error(`Invalid WorkspaceRecord: ${validation.errors.join(', ')}`)
      }
      const state = readState()
      const list = state.workspaceRecords
      const idx = list.findIndex(r => r.id === record.id)
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...record, updatedAt: now() }
      } else {
        list.push({ ...record, createdAt: record.createdAt ?? now(), updatedAt: now() })
      }
      if (record.path && !state.workspaces.includes(record.path)) {
        state.workspaces.push(record.path)
      }
      writeState(state)
      notify()
    },

    async getGroups(sessionId) {
      const state = readState()
      // Read-only compatibility: merge every legacy alias and dedupe by id.
      return readGroupsCompat(state, sessionId)
    },

    async putGroup(group) {
      const state = readState()
      // Strict write-time relationship check (plan Phase 4 / B6): every item
      // must resolve to a persisted finding of the same session. Read paths
      // stay index-free so legacy rows remain readable.
      const findingsById = findingsIndexForSession(state, group?.sessionId)
      const validation = validateGroupRecord(group, findingsById)
      if (!validation.ok) {
        throw new Error(`Invalid GroupRecord: ${validation.errors.join(', ')}`)
      }
      const key = groupsKeyFor(group.sessionId) || group.sessionId.trim()
      const list = readGroupsCompat(state, group.sessionId)
      const idx = list.findIndex(g => g.id === group.id)
      if (idx >= 0) {
        list[idx] = { ...list[idx], ...group }
      } else {
        list.push({ ...group })
      }
      // Writes go to the canonical key only. Any leftover alias is dropped from
      // the in-memory state before the single atomic write.
      for (const alias of groupsAliasKeys(group.sessionId)) {
        if (alias !== key) delete state.groups[alias]
      }
      state.groups[key] = list
      writeState(state)
      bump(`session:${key}`)
      notify()
    },

    async putGroups(sessionIdOrWsKey, groups) {
      const key = groupsKeyFor(sessionIdOrWsKey) || (typeof sessionIdOrWsKey === 'string' ? sessionIdOrWsKey.trim() : '')
      if (!key) return
      const safeGroups = Array.isArray(groups) ? groups : []
      const state = readState()
      for (const alias of groupsAliasKeys(sessionIdOrWsKey)) {
        if (alias !== key) delete state.groups[alias]
      }
      if (safeGroups.length === 0) {
        delete state.groups[key]
      } else {
        state.groups[key] = safeGroups
      }
      writeState(state)
      bump(`session:${key}`)
      notify()
    },

    revision(workspaceKey) {
      return revisions.get(workspaceKey) ?? 0
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    async cleanExpiredPromptLogs({ now: customNow = now(), maxCount, maxAgeMs } = {}) {
      const state = readState()
      const retention = retentionWindowFromPrefs(state.prefs)
      const limitCount = Number.isFinite(maxCount) ? maxCount : retention.maxCount
      const limitAge = Number.isFinite(maxAgeMs) ? maxAgeMs : retention.maxAgeMs
      let prunedCount = 0
      let remainingCount = 0

      for (const [workspaceKey, list] of Object.entries(state.promptLogs)) {
        const initialLen = list.length
        const pruned = prunePromptLogs(list, { now: customNow, maxCount: limitCount, maxAgeMs: limitAge })
        prunedCount += (initialLen - pruned.length)
        remainingCount += pruned.length
        if (pruned.length === 0) delete state.promptLogs[workspaceKey]
        else state.promptLogs[workspaceKey] = pruned
      }

      if (pruneEmptySessionBuckets(state) || prunedCount > 0) {
        writeState(state)
        notify()
      }
      return { prunedCount, remainingCount }
    },

    async exportDump() {
      const state = readState()
      return {
        entries: state.entries,
        promptLogs: state.promptLogs,
        commitTraces: state.commitTraces,
        turnActions: state.turnActions,
        distillRuns: state.distillRuns,
        distillPlans: state.distillPlans,
        distillFingerprints: state.distillFingerprints,
        groups: state.groups,
        workspaceRecords: state.workspaceRecords,
        handoffs: state.handoffs,
        prefs: state.prefs,
        workspaces: state.workspaces,
      }
    },

    async importDump(dump, options = {}) {
      if (!dump || typeof dump !== 'object') {
        return { ok: false, status: 400, error: 'Invalid dump payload' }
      }
      const mode = options.mode === 'replace' ? 'replace' : 'merge'
      let backupPath = null
      if (mode === 'replace') {
        // Replace wipes every local row: take a non-overwriting backup first so a
        // wrong file can always be rolled back offline.
        backupPath = createStorageBackup()
        if (!backupPath) {
          return { ok: false, status: 500, error: 'Backup failed; import aborted', mode }
        }
      }
      const state = mode === 'replace' ? defaultState() : readState()
      const counts = {
        entries: 0,
        promptLogs: 0,
        commitTraces: 0,
        turnActions: 0,
        distillRuns: 0,
        distillPlans: 0,
        distillFingerprints: 0,
        groups: 0,
        workspaceRecords: 0,
        handoffs: 0,
      }

      if (dump.entries && typeof dump.entries === 'object') {
        for (const [wsKey, items] of Object.entries(dump.entries)) {
          if (!Array.isArray(items)) continue
          const existing = state.entries[wsKey] || []
          const map = new Map(existing.map(it => [it.id, it]))
          for (const item of items) {
            if (!item || !item.id) continue
            const prev = map.get(item.id)
            if (!prev || (item.updatedAt ?? 0) >= (prev.updatedAt ?? 0)) {
              map.set(item.id, item)
              counts.entries++
            }
          }
          state.entries[wsKey] = [...map.values()]
          if (!state.workspaces.includes(wsKey)) state.workspaces.push(wsKey)
          bump(wsKey)
        }
      }

      if (dump.promptLogs && typeof dump.promptLogs === 'object') {
        for (const [wsKey, items] of Object.entries(dump.promptLogs)) {
          if (!Array.isArray(items)) continue
          const existing = state.promptLogs[wsKey] || []
          const map = new Map(existing.map(it => [it.messageId || it.id, it]))
          for (const item of items) {
            const key = item.messageId || item.id
            if (!key) continue
            map.set(key, { ...map.get(key), ...item })
            counts.promptLogs++
          }
          const merged = [...map.values()]
          const retention = retentionWindowFromPrefs(state.prefs)
          state.promptLogs[wsKey] = prunePromptLogs(merged, { now: now(), maxCount: retention.maxCount, maxAgeMs: retention.maxAgeMs })
          if (!state.workspaces.includes(wsKey)) state.workspaces.push(wsKey)
          bump(wsKey)
        }
      }

      if (dump.commitTraces && typeof dump.commitTraces === 'object') {
        for (const [sessionKey, items] of Object.entries(dump.commitTraces)) {
          if (!Array.isArray(items)) continue
          const key = commitTracesKeyFor(sessionKey) || sessionKey
          const existing = state.commitTraces[key] || []
          const map = new Map(existing.map(it => [it.id, it]))
          for (const item of items) {
            if (!item || !item.id) continue
            const prev = map.get(item.id)
            const itemTime = item.updatedAt ?? item.capturedAt ?? 0
            const prevTime = prev ? (prev.updatedAt ?? prev.capturedAt ?? 0) : -1
            if (!prev || itemTime >= prevTime) {
              map.set(item.id, item)
              counts.commitTraces++
            }
          }
          const merged = [...map.values()]
          const retention = retentionWindowFromPrefs(state.prefs)
          state.commitTraces[key] = pruneCommitTraces(merged, { now: now(), maxCount: retention.maxCount, maxAgeMs: retention.maxAgeMs })
          bump(key)
        }
      }

      // Enforce 1000 items / 30 days retention across all commitTraces buckets after import
      {
        const retention = retentionWindowFromPrefs(state.prefs)
        for (const [sessionKey, list] of Object.entries(state.commitTraces)) {
          if (Array.isArray(list)) {
            state.commitTraces[sessionKey] = pruneCommitTraces(list, { now: now(), maxCount: retention.maxCount, maxAgeMs: retention.maxAgeMs })
          }
        }
      }

      if (dump.turnActions && typeof dump.turnActions === 'object') {
        if (!state.turnActions || typeof state.turnActions !== 'object') {
          state.turnActions = {}
        }
        for (const [sessionKey, sessionState] of Object.entries(dump.turnActions)) {
          if (!sessionState || typeof sessionState !== 'object') continue
          const key = turnActionsKeyFor(sessionKey) || sessionKey
          const prev = state.turnActions[key]
          const existingItems = Array.isArray(prev?.items) ? prev.items : []
          const incomingItems = Array.isArray(sessionState.items) ? sessionState.items : []
          const map = new Map(existingItems.filter(it => it && it.id).map(it => [it.id, it]))
          for (const item of incomingItems) {
            if (!item || !item.id) continue
            const existing = map.get(item.id)
            const itemTime = item.decidedAt ?? item.createdAt ?? 0
            const existingTime = existing ? (existing.decidedAt ?? existing.createdAt ?? 0) : -1
            if (!existing || itemTime >= existingTime) {
              map.set(item.id, item)
              counts.turnActions++
            }
          }
          const mergedItems = pruneTurnActionItems([...map.values()], 500)
          const scannedThroughSeq = Math.max(
            Number(prev?.scannedThroughSeq) || 0,
            Number(sessionState.scannedThroughSeq) || 0,
          )
          const scannedAt = Math.max(
            Number(prev?.scannedAt) || 0,
            Number(sessionState.scannedAt) || 0,
          )
          const sessionId = sessionState.sessionId || prev?.sessionId || (key.startsWith('session:') ? key.slice('session:'.length) : key)
          state.turnActions[key] = {
            version: 1,
            sessionId,
            scannedThroughSeq,
            scannedAt,
            items: mergedItems,
          }
          bump(key)
        }
      }

      if (dump.distillRuns && typeof dump.distillRuns === 'object') {
        for (const [bucketKey, items] of Object.entries(dump.distillRuns)) {
          if (!Array.isArray(items)) continue
          const workspaceId = bucketKey.startsWith('ws:') ? bucketKey.slice('ws:'.length) : bucketKey
          const key = distillRunBucketKey(workspaceId)
          if (!key) continue
          const existing = Array.isArray(state.distillRuns[key]) ? state.distillRuns[key] : []
          const map = new Map(existing.filter(it => it && it.id).map(it => [it.id, it]))
          for (const item of items) {
            if (!item || !item.id) continue
            const prev = map.get(item.id)
            const itemTime = distillItemTime(item)
            const prevTime = prev ? distillItemTime(prev) : -1
            if (!prev || itemTime >= prevTime) {
              map.set(item.id, item)
              counts.distillRuns++
            }
          }
          state.distillRuns[key] = pruneDistillRuns([...map.values()], { now: now() })
          bump(key)
        }
      }

      if (dump.distillPlans && typeof dump.distillPlans === 'object') {
        for (const [rawKey, plan] of Object.entries(dump.distillPlans)) {
          if (!plan || typeof plan !== 'object') continue
          const runId = typeof plan.runId === 'string' && plan.runId
            ? plan.runId
            : (rawKey.startsWith('run:') ? rawKey.slice('run:'.length) : rawKey)
          const key = distillPlanKeyFor(runId)
          if (!key) continue
          state.distillPlans[key] = { ...state.distillPlans[key], ...plan, runId }
          counts.distillPlans++
          bump(key)
        }
      }

      if (dump.distillFingerprints && typeof dump.distillFingerprints === 'object') {
        for (const [bucketKey, items] of Object.entries(dump.distillFingerprints)) {
          if (!Array.isArray(items)) continue
          const workspaceId = bucketKey.startsWith('ws:') ? bucketKey.slice('ws:'.length) : bucketKey
          const key = distillRunBucketKey(workspaceId)
          if (!key) continue
          const existing = Array.isArray(state.distillFingerprints[key]) ? state.distillFingerprints[key] : []
          const map = new Map(existing.filter(it => it && it.id).map(it => [it.id, it]))
          for (const item of items) {
            if (!item || !item.id) continue
            map.set(item.id, { ...map.get(item.id), ...item })
            counts.distillFingerprints++
          }
          state.distillFingerprints[key] = pruneDistillFingerprints([...map.values()], { now: now() })
          bump(key)
        }
      }

      // Retention is re-applied across every bucket after the merge/replace pass.
      for (const [key, list] of Object.entries(state.distillRuns)) {
        if (Array.isArray(list)) state.distillRuns[key] = pruneDistillRuns(list, { now: now() })
      }
      for (const [key, list] of Object.entries(state.distillFingerprints)) {
        if (Array.isArray(list)) state.distillFingerprints[key] = pruneDistillFingerprints(list, { now: now() })
      }
      pruneOrphanDistillPlans(state)

      if (dump.groups && typeof dump.groups === 'object') {
        for (const [sessionId, groupList] of Object.entries(dump.groups)) {
          if (!Array.isArray(groupList)) continue
          const key = groupsKeyFor(sessionId) || sessionId
          if (!key) continue
          // Merge against every legacy alias, then persist only the canonical
          // key so an import can never re-introduce the triple-write layout.
          const existing = readGroupsCompat(state, key)
          const map = new Map(existing.map(g => [g.id, g]))
          for (const g of groupList) {
            if (!g || !g.id) continue
            // Legacy group rows may predate required schema fields (startTurn,
            // createdAt, ...). Normalize before validating, otherwise a single
            // old row makes read-back verification fail and blocks migration
            // forever while the fallback keeps re-reading localStorage.
            let record = null
            try {
              record = createGroupRecord({
                ...g,
                sessionId: typeof g.sessionId === 'string' && g.sessionId.trim() ? g.sessionId : sessionId,
              }, { now })
            } catch {
              const validation = validateGroupRecord(g)
              if (!validation.ok) continue
              record = g
            }
            map.set(record.id, record)
            counts.groups++
          }
          for (const alias of groupsAliasKeys(key)) {
            if (alias !== key) delete state.groups[alias]
          }
          state.groups[key] = [...map.values()]
        }
      }

      if (Array.isArray(dump.workspaceRecords)) {
        const existing = state.workspaceRecords || []
        const map = new Map(existing.map(r => [r.id, r]))
        for (const rec of dump.workspaceRecords) {
          if (!rec || !rec.id) continue
          // Legacy records may predate schema v2 fields. Normalize instead of
          // dropping them: a migration must not silently lose the workspace
          // record just because it only had { id, name, path }.
          let record = null
          const existingRecord = map.get(rec.id)
          try {
            record = createWorkspaceRecord({
              ...rec,
              createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : existingRecord?.createdAt,
              updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : existingRecord?.updatedAt,
            }, { now })
          } catch {
            const validation = validateWorkspaceRecord(rec)
            if (!validation.ok) continue
            record = rec
          }
          map.set(record.id, record)
          counts.workspaceRecords++
          if (record.path && !state.workspaces.includes(record.path)) state.workspaces.push(record.path)
        }
        state.workspaceRecords = [...map.values()]
      }

      if (dump.handoffs && typeof dump.handoffs === 'object') {
        for (const [sessionId, val] of Object.entries(dump.handoffs)) {
          state.handoffs[sessionId] = val
          counts.handoffs++
        }
      }

      if (dump.prefs && typeof dump.prefs === 'object') {
        state.prefs = { ...state.prefs, ...dump.prefs }
      }

      if (Array.isArray(dump.workspaces)) {
        for (const workspaceKey of dump.workspaces) {
          if (typeof workspaceKey === 'string' && workspaceKey && !state.workspaces.includes(workspaceKey)) {
            state.workspaces.push(workspaceKey)
          }
        }
      }

      // A dump exported by an older build may contain empty session buckets;
      // do not import that residue as a phantom Desk session.
      pruneEmptySessionBuckets(state)
      writeState(state)
      notify()

      // Verification is a real read-back from disk: the caller is about to
      // delete the only other copy of this data, so an OK response alone is not
      // proof that every row physically survived the atomic write.
      let verifyState = null
      try {
        verifyState = readState()
      } catch {
        verifyState = null
      }
      const verified = verifyStateContainsDump(verifyState, dump, { now: now() })

      // An unverified import must never look like success to any caller: the
      // client uses this result to decide whether deleting its legacy copy is
      // even allowed.
      return {
        ok: verified,
        status: verified ? 200 : 500,
        verified,
        mode,
        counts,
        ...(backupPath ? { backupPath } : {}),
        ...(verified ? {} : { error: 'Import could not be verified on disk' }),
      }
    },

    async clearWorkspaceData(workspaceId, {
      preservePinned = true,
      sessionIds = [],
      sessionId = null,
      clearFindings = true,
      clearGroups = true,
      clearPromptLogs = true,
      clearDrafts = false,
      clearCommitTraces = true,
      clearDistillRuns = true,
      clearDistillFingerprints = true,
    } = {}) {
      if (!workspaceId) return
      const state = readState()

      const targetSessionIds = new Set(sessionIds.map(s => String(s)))
      if (sessionId) targetSessionIds.add(String(sessionId))
      if (workspaceId.startsWith('session:')) {
        targetSessionIds.add(workspaceId.slice('session:'.length))
      }

      for (const rec of state.workspaceRecords) {
        if ((rec.id === workspaceId || rec.path === workspaceId) && Array.isArray(rec.sessionIds)) {
          for (const sId of rec.sessionIds) targetSessionIds.add(String(sId))
        }
      }

      // Check all groups to find sessions belonging to workspaceId
      for (const [sId, grpList] of Object.entries(state.groups)) {
        if (Array.isArray(grpList) && grpList.some(g => g.workspaceId === workspaceId)) {
          targetSessionIds.add(sId)
        }
      }

      // Check entries to find sessions belonging to workspaceId
      for (const [key, items] of Object.entries(state.entries)) {
        if (Array.isArray(items)) {
          for (const it of items) {
            if (it.workspaceId === workspaceId || it.workspaceKey === workspaceId) {
              if (it.sessionId) targetSessionIds.add(String(it.sessionId))
            }
          }
        }
      }

      // Track pinned finding IDs and pinned group IDs
      const pinnedFindingIds = new Set()
      const pinnedGroupIds = new Set()

      for (const sId of targetSessionIds) {
        const grps = readGroupsCompat(state, sId)
        const pinned = grps.filter(g => Boolean(g.pinned))
        for (const pg of pinned) {
          pinnedGroupIds.add(pg.id)
          for (const it of pg.items || []) {
            if (it.findingId) pinnedFindingIds.add(it.findingId)
          }
        }
      }

      // 1. Process groups (if clearGroups enabled). All group writes stay on
      // the canonical single key; legacy aliases are removed in the same pass.
      if (clearGroups) {
        for (const sId of targetSessionIds) {
          const key = groupsKeyFor(sId) || String(sId)
          const grps = readGroupsCompat(state, sId)
          const remaining = preservePinned ? grps.filter(g => Boolean(g.pinned)) : []
          for (const alias of groupsAliasKeys(sId)) {
            if (alias !== key) delete state.groups[alias]
          }
          if (remaining.length > 0) {
            state.groups[key] = remaining
          } else {
            delete state.groups[key]
          }
        }
      }

      // 2. Process entries (if clearFindings enabled)
      if (clearFindings) {
        for (const sId of targetSessionIds) {
          const sKey = `session:${sId}`
          const entries = state.entries[sKey] || []
          const preserved = entries.filter(e => {
            return preservePinned && (
              pinnedFindingIds.has(e.id) ||
              (e.assignedGroupId && pinnedGroupIds.has(e.assignedGroupId))
            )
          })
          if (preserved.length > 0) {
            state.entries[sKey] = preserved
          } else {
            delete state.entries[sKey]
            state.workspaces = state.workspaces.filter(w => w !== sKey)
          }
          bump(sKey)
        }

        // Direct workspaceKey entries
        if (state.entries[workspaceId]) {
          const entries = state.entries[workspaceId]
          const preserved = entries.filter(e => {
            return preservePinned && (
              pinnedFindingIds.has(e.id) ||
              (e.assignedGroupId && pinnedGroupIds.has(e.assignedGroupId))
            )
          })
          if (preserved.length > 0) {
            state.entries[workspaceId] = preserved
          } else {
            delete state.entries[workspaceId]
            state.workspaces = state.workspaces.filter(w => w !== workspaceId)
          }
          bump(workspaceId)
        }
      }

      // 2.1 Reconcile group/finding cross-references after category switches.
      // `clearFindings` and `clearGroups` are independent, so either side can
      // survive while the other is removed. Never leave a surviving group with
      // items pointing at deleted findings, or a surviving finding assigned to
      // a deleted group.
      {
        const entryBuckets = new Set()
        for (const sId of targetSessionIds) entryBuckets.add(`session:${sId}`)
        if (state.entries[workspaceId]) entryBuckets.add(workspaceId)

        const allowedFindingIds = new Set()
        for (const bucket of Object.keys(state.entries)) {
          for (const entry of Array.isArray(state.entries[bucket]) ? state.entries[bucket] : []) {
            if (entry?.id) allowedFindingIds.add(entry.id)
          }
        }

        const remainingGroupIds = new Set()
        for (const list of Object.values(state.groups)) {
          for (const group of Array.isArray(list) ? list : []) {
            if (group?.id) remainingGroupIds.add(group.id)
          }
        }

        for (const sId of targetSessionIds) {
          const key = groupsKeyFor(sId) || String(sId)
          const groups = readGroupsCompat(state, sId)
          let changed = false
          const nextGroups = groups.map(group => {
            const items = Array.isArray(group.items) ? group.items : []
            const kept = items.filter(item => item?.findingId && allowedFindingIds.has(item.findingId))
            if (kept.length === items.length) return group
            changed = true
            return { ...group, items: kept }
          })
          if (changed) {
            state.groups[key] = nextGroups
            bump(key)
          }
        }

        for (const bucket of entryBuckets) {
          const rows = Array.isArray(state.entries[bucket]) ? state.entries[bucket] : []
          let changed = false
          const nextRows = rows.map(entry => {
            if (!entry?.assignedGroupId || remainingGroupIds.has(entry.assignedGroupId)) return entry
            changed = true
            const { assignedGroupId, ...rest } = entry
            return rest
          })
          if (changed) {
            state.entries[bucket] = nextRows
            bump(bucket)
          }
        }
      }

      // 3. Process promptLogs (if clearPromptLogs enabled)
      if (clearPromptLogs) {
        for (const sId of targetSessionIds) {
          const sKey = `session:${sId}`
          delete state.promptLogs[sKey]
          bump(sKey)
        }
        delete state.promptLogs[workspaceId]
        bump(workspaceId)
      }

      // 4. Process drafts (if clearDrafts enabled). Drafts share one storage
      // namespace with a per-draft visibility scope, so only workspace-scoped
      // drafts owned by this workspace are removed; global drafts and other
      // workspaces' drafts survive.
      if (clearDrafts) {
        const draftKey = 'draft:global'
        const drafts = Array.isArray(state.entries[draftKey]) ? state.entries[draftKey] : []
        const owners = new Set([String(workspaceId)])
        if (String(workspaceId).startsWith('session:')) {
          owners.add(String(workspaceId).slice('session:'.length))
        }
        const remaining = drafts.filter(draft => !(draft && draft.kind === 'draft'
          && draft.visibility === 'workspace'
          && owners.has(String(draft.workspaceId))))
        if (remaining.length === 0) delete state.entries[draftKey]
        else state.entries[draftKey] = remaining
        bump(draftKey)
      }

      // 5. Clear handoffs for targeted sessions
      for (const sId of targetSessionIds) {
        delete state.handoffs[sId]
      }

      // Clear turnActions for targeted sessions
      if (state.turnActions && typeof state.turnActions === 'object') {
        for (const sId of targetSessionIds) {
          const sKey = `session:${sId}`
          delete state.turnActions[sKey]
          delete state.turnActions[sId]
          bump(sKey)
        }
        if (workspaceId.startsWith('session:')) {
          delete state.turnActions[workspaceId]
          delete state.turnActions[workspaceId.slice('session:'.length)]
          bump(workspaceId)
        }
      }

      // 6. Process commitTraces (if clearCommitTraces enabled)
      if (clearCommitTraces && state.commitTraces && typeof state.commitTraces === 'object') {
        const isSessionTarget = workspaceId.startsWith('session:')
        const targetCleanSession = isSessionTarget ? workspaceId.slice('session:'.length) : null

        for (const [sessionKey, traceList] of Object.entries(state.commitTraces)) {
          if (!Array.isArray(traceList)) continue
          const cleanSessionId = sessionKey.startsWith('session:')
            ? sessionKey.slice('session:'.length)
            : sessionKey

          const remaining = traceList.filter(t => {
            if (!t) return false
            if (t.workspaceId === workspaceId) return false
            if (isSessionTarget && (cleanSessionId === targetCleanSession || targetSessionIds.has(cleanSessionId))) {
              return false
            }
            if (!t.workspaceId) {
              const sid = t.sessionId ? String(t.sessionId) : cleanSessionId
              if (targetSessionIds.has(sid)) return false
            }
            return true
          })

          if (remaining.length !== traceList.length) {
            if (remaining.length > 0) {
              state.commitTraces[sessionKey] = remaining
            } else {
              delete state.commitTraces[sessionKey]
            }
            bump(sessionKey)
          }
        }
      }

      // 7. Process distillation buckets (workspace-scoped; plans follow runs)
      if (clearDistillRuns || clearDistillFingerprints) {
        const cleanWorkspaceId = workspaceId.startsWith('session:')
          ? workspaceId.slice('session:'.length)
          : workspaceId
        const workspaceCandidates = new Set([workspaceId, cleanWorkspaceId])
        const bucketCandidates = new Set([`ws:${workspaceId}`, `ws:${cleanWorkspaceId}`])
        const removedRunIds = new Set()

        if (clearDistillRuns && state.distillRuns && typeof state.distillRuns === 'object') {
          for (const [bucketKey, list] of Object.entries(state.distillRuns)) {
            if (!Array.isArray(list)) continue
            const bucketWorkspace = bucketKey.startsWith('ws:') ? bucketKey.slice('ws:'.length) : bucketKey
            const keyMatch = bucketCandidates.has(bucketKey) || workspaceCandidates.has(bucketWorkspace)
            const remaining = list.filter(run => {
              if (!run || typeof run !== 'object') return false
              const match = keyMatch || (typeof run.workspaceId === 'string' && workspaceCandidates.has(run.workspaceId))
              if (match && run.id) removedRunIds.add(run.id)
              return !match
            })
            if (remaining.length !== list.length) {
              if (remaining.length > 0) state.distillRuns[bucketKey] = remaining
              else delete state.distillRuns[bucketKey]
              bump(bucketKey)
            }
          }
        }

        if (clearDistillRuns && state.distillPlans && typeof state.distillPlans === 'object') {
          for (const [planKey, plan] of Object.entries(state.distillPlans)) {
            const runId = planKey.startsWith('run:') ? planKey.slice('run:'.length) : planKey
            const planWorkspace = plan && typeof plan.workspaceId === 'string' ? plan.workspaceId : ''
            if (removedRunIds.has(runId) || (planWorkspace && workspaceCandidates.has(planWorkspace))) {
              delete state.distillPlans[planKey]
              bump(planKey)
            }
          }
        }

        if (clearDistillFingerprints && state.distillFingerprints && typeof state.distillFingerprints === 'object') {
          for (const [bucketKey, list] of Object.entries(state.distillFingerprints)) {
            if (!Array.isArray(list)) continue
            const bucketWorkspace = bucketKey.startsWith('ws:') ? bucketKey.slice('ws:'.length) : bucketKey
            const keyMatch = bucketCandidates.has(bucketKey) || workspaceCandidates.has(bucketWorkspace)
            const remaining = list.filter(fingerprint => {
              if (!fingerprint || typeof fingerprint !== 'object') return false
              if (keyMatch) return false
              return !(typeof fingerprint.workspaceId === 'string' && workspaceCandidates.has(fingerprint.workspaceId))
            })
            if (remaining.length !== list.length) {
              if (remaining.length > 0) state.distillFingerprints[bucketKey] = remaining
              else delete state.distillFingerprints[bucketKey]
              bump(bucketKey)
            }
          }
        }
      }

      writeState(state)
      notify()
    },

    async clearCache() {
      const state = defaultState()
      writeState(state)
      revisions.clear()
      notify()
    },

    dispose() {
      listeners.clear()
    },
  }
}
