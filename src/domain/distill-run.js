/**
 * DistillationRun domain model: pure state machine, snapshot freeze, drift
 * annotation, maintenance lock window and TTL decisions. No I/O.
 *
 * Contract source: docs/superpowers/specs/2026-11-11-punch-desk-finding-distillation-design.md
 *   §4.2  run state machine / RunControl recovery semantics
 *   §5.1  DistillationRun data model (snapshot/model/budget may be absent at
 *         creation; must be complete before entering analyzing)
 *   §6.1  snapshot freeze happens in the snapshotting phase
 *   §10.4 maintenance window (D14/D20)
 *   §16.16 / §16.20 serialization, applying-never-stale-by-TTL, recovery guards
 *
 * Discipline:
 * - Pure functions only: no fs / child_process / network, no Date.now.
 *   Every clock read is injected as a required finite `now` (ms since epoch).
 * - Clone-on-write: helpers never mutate the input run.
 * - Host orchestration (Task 2.4/2.5) owns RunControl CAS, withWorkspaceLock
 *   atomicity and transaction recovery; this module only provides the pure
 *   decisions those writers must honor.
 */

/** Milliseconds a `ready` run keeps the submission lock (D20: 30 minutes). */
export const lockTtlMs = 30 * 60 * 1000
/** Milliseconds after which an abandoned non-terminal run becomes stale (§4.2: 2h). */
export const staleTtlMs = 2 * 60 * 60 * 1000
/** Milliseconds after which a `ready` plan is hinted as possibly expired (§4.2: 24h). */
export const planExpireMs = 24 * 60 * 60 * 1000

/** The three run timers under their spec names (§4.2), frozen for shared import. */
export const RUN_TIMINGS = Object.freeze({ lockTtlMs, staleTtlMs, planExpireMs })

/** Batch session bounds (D2: 3~7 sessions per run). */
export const MIN_BATCH_SESSIONS = 3
export const MAX_BATCH_SESSIONS = 7

/** All run statuses (§5.1). */
export const RUN_STATUSES = Object.freeze([
  'queued', 'snapshotting', 'analyzing', 'validating', 'ready',
  'applying', 'applied', 'failed', 'canceled', 'stale', 'superseded',
])

/** Terminal statuses: irreversible and always unlocked (§4.2 / D20). */
export const TERMINAL_RUN_STATUSES = Object.freeze([
  'applied', 'failed', 'canceled', 'stale', 'superseded',
])

/**
 * Legal transition table (§4.2). Notes:
 * - `stale` is reachable only via TTL recovery on queued/snapshotting/
 *   analyzing/validating/ready; `applying` must first recover its transaction
 *   intent and can never be TTL-staled directly (§16.16).
 * - `superseded` is the rerun replacement of an old `ready` run (§12.5).
 * - `canceled` from `applying` is legal only after transaction recovery;
 *   use resolveCancelByStatus() to decide the path (Host executes).
 * - Terminal statuses have no outgoing edges (irreversible guard).
 */
export const RUN_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['snapshotting', 'failed', 'canceled', 'stale']),
  snapshotting: Object.freeze(['analyzing', 'failed', 'canceled', 'stale']),
  analyzing: Object.freeze(['validating', 'failed', 'canceled', 'stale']),
  validating: Object.freeze(['ready', 'failed', 'canceled', 'stale']),
  ready: Object.freeze(['applying', 'superseded', 'failed', 'canceled', 'stale']),
  applying: Object.freeze(['applied', 'failed', 'canceled']),
  applied: Object.freeze([]),
  failed: Object.freeze([]),
  canceled: Object.freeze([]),
  stale: Object.freeze([]),
  superseded: Object.freeze([]),
})

/** Progress stages carried by run.progress (§5.1). */
export const PROGRESS_STAGES = Object.freeze(['snapshotting', 'stage1', 'stage2', 'validating'])

/** Evidence grades counted by snapshot.byGrade (§6.2; dismissed = negative context only). */
export const EVIDENCE_GRADES = Object.freeze(['resolved', 'commit', 'submitted', 'dismissed'])

/** Patch keys a caller may never override through transitionRun. */
const FORBIDDEN_PATCH_KEYS = Object.freeze(['status', 'id', 'workspaceId', 'createdAt', 'updatedAt', 'lockWindow'])

/**
 * @typedef {object} RunSnapshot
 * @property {number} takenAt Freeze time (ms since epoch)
 * @property {number} materialCount Number of frozen result-pair materials
 * @property {{ resolved: number, commit: number, submitted: number, dismissed: number }} byGrade
 *   Material counts per evidence grade; `dismissed` is negative context only
 * @property {Record<string, string>} contentHashes `${sessionId}:${messageId}` → sha256
 */

/**
 * @typedef {object} DistillRun
 * @property {string} id
 * @property {string} workspaceId Required; never empty or 'default'
 * @property {string} status One of RUN_STATUSES
 * @property {number} createdAt
 * @property {number} updatedAt Last status/progress write (TTL reference clock)
 * @property {boolean} [parked] Ready-only: true means the plan was parked and
 *   released the submission lock (still non-terminal, still apply/cancel/delete)
 * @property {Array<{ sessionId: string, title?: string, archived: boolean }>} sessions 3~7
 * @property {{ sinceTs?: number }} scope
 * @property {RunSnapshot} [snapshot] Absent until frozen in snapshotting (§5.1)
 * @property {{ stage: string, completed: number, total: number }} progress
 * @property {{ provider: string, model: string, reasoningEffort?: string }} [model]
 * @property {{ maxTokens: number, usedTokens?: number, truncated: boolean }} [budget]
 * @property {{ at: number, changed: string[] }} [driftDetected] Annotation only; never a terminal cause
 * @property {{ startedAt: number, endedAt?: number, expiresAt: number }} [lockWindow]
 *   Bookkeeping maintained by transitionRun; for `ready`, expiresAt is the
 *   lockTtlMs unlock deadline. See deriveLockWindow for the derivation rules.
 */

/**
 * @typedef {object} LockWindowDerivation
 * @property {boolean} locked Whether this workspace's plugin submission entries are paused
 * @property {string} reason Stable token: 'terminal' | 'pre-analysis' | 'analyzing' |
 *   'validating' | 'applying' | 'ready' | 'ready-ttl-expired' | 'parked'
 * @property {number|null} expiresAt Ready unlock deadline (ms); null for other states
 */

/**
 * @typedef {object} StaleEvaluation
 * @property {'none'|'stale'|'recover-tx'} action Host instruction for lazy recovery
 * @property {string} reason Stable explanation token
 */

/**
 * @typedef {object} CancelResolution
 * @property {'cancel'|'recover-first'|'idempotent'|'too-late'} outcome
 * @property {string} runStatus Persisted status the decision was based on
 * @property {string} [nextStatus] 'canceled' when outcome is 'cancel'
 */

function fail(code, message) {
  const err = new Error(message)
  err.code = code
  throw err
}

function requireNow(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    fail('INVALID_NOW', 'now must be injected as a finite number (ms since epoch)')
  }
  return now
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * True when the status is one of the five irreversible terminal statuses.
 * Unknown statuses are treated as non-terminal (conservative for the
 * single-batch guard: an unrecognized run still occupies the slot).
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.includes(status)
}

/**
 * Pure transition-table lookup. Self-transitions and unknown statuses are illegal.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransitionRun(from, to) {
  const allowed = RUN_TRANSITIONS[from]
  return Array.isArray(allowed) && allowed.includes(to)
}

/**
 * Factory for a queued DistillationRun (§5.1). snapshot/model/budget are
 * intentionally absent: they must not be fabricated before collection.
 * The single-batch invariant is checked separately via canCreateDistillRun
 * inside the Host workspace lock.
 * @param {object} input
 * @param {string} input.id Caller-generated run id (domain never fabricates ids)
 * @param {string} input.workspaceId Required; empty/'default' rejected (§14.1)
 * @param {Array<{ sessionId: string, title?: string, archived?: boolean }>} input.sessions 3~7 unique sessions (D2)
 * @param {{ sinceTs?: number }} [input.scope]
 * @param {number} input.now Injected creation time (ms)
 * @returns {DistillRun}
 */
export function createDistillRun({ id, workspaceId, sessions, scope, now } = {}) {
  requireNow(now)
  if (!isNonEmptyString(id)) fail('INVALID_RUN', 'id is required')
  if (!isNonEmptyString(workspaceId) || workspaceId.trim() === 'default') {
    fail('INVALID_WORKSPACE', 'workspaceId is required and must not be "default"')
  }
  if (!Array.isArray(sessions) || sessions.length < MIN_BATCH_SESSIONS || sessions.length > MAX_BATCH_SESSIONS) {
    fail('INVALID_BATCH', `sessions must contain ${MIN_BATCH_SESSIONS}~${MAX_BATCH_SESSIONS} entries`)
  }
  const seen = new Set()
  const normalized = sessions.map((s, idx) => {
    if (!isPlainObject(s) || !isNonEmptyString(s.sessionId)) {
      fail('INVALID_BATCH', `sessions[${idx}].sessionId is required`)
    }
    const sessionId = s.sessionId.trim()
    if (seen.has(sessionId)) fail('INVALID_BATCH', `duplicate sessionId: ${sessionId}`)
    seen.add(sessionId)
    if (s.archived !== undefined && typeof s.archived !== 'boolean') {
      fail('INVALID_BATCH', `sessions[${idx}].archived must be a boolean`)
    }
    if (s.title !== undefined && typeof s.title !== 'string') {
      fail('INVALID_BATCH', `sessions[${idx}].title must be a string`)
    }
    const item = { sessionId, archived: s.archived === true }
    if (s.title !== undefined) item.title = s.title
    return item
  })
  let normalizedScope = {}
  if (scope !== undefined) {
    if (!isPlainObject(scope)) fail('INVALID_RUN', 'scope must be an object')
    if (scope.sinceTs !== undefined) {
      if (typeof scope.sinceTs !== 'number' || !Number.isFinite(scope.sinceTs)) {
        fail('INVALID_RUN', 'scope.sinceTs must be a finite number')
      }
      normalizedScope = { sinceTs: scope.sinceTs }
    }
  }
  return {
    id,
    workspaceId: workspaceId.trim(),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    sessions: normalized,
    scope: normalizedScope,
    progress: { stage: 'snapshotting', completed: 0, total: normalized.length },
  }
}

/**
 * Find the single non-terminal run of a workspace, or null.
 * Pure decision only: the atomic check-and-create must happen inside the
 * Host withWorkspaceLock (§4.2).
 * @param {DistillRun[]} runs
 * @param {string} workspaceId
 * @returns {DistillRun|null}
 */
export function getActiveRun(runs, workspaceId) {
  if (!Array.isArray(runs) || !isNonEmptyString(workspaceId)) return null
  return runs.find(r => isPlainObject(r) && r.workspaceId === workspaceId && !isTerminalRunStatus(r.status)) ?? null
}

/**
 * True when no non-terminal run occupies this workspace (single-batch rule).
 * @param {DistillRun[]} runs
 * @param {string} workspaceId
 * @returns {boolean}
 */
export function canCreateDistillRun(runs, workspaceId) {
  return getActiveRun(runs, workspaceId) === null
}

function collectSnapshotErrors(snapshot) {
  const errors = []
  if (!isPlainObject(snapshot)) return ['snapshot must be an object']
  if (typeof snapshot.takenAt !== 'number' || !Number.isFinite(snapshot.takenAt)) {
    errors.push('snapshot.takenAt must be a finite number')
  }
  if (!Number.isInteger(snapshot.materialCount) || snapshot.materialCount < 0) {
    errors.push('snapshot.materialCount must be a non-negative integer')
  }
  if (!isPlainObject(snapshot.byGrade)) {
    errors.push('snapshot.byGrade must be an object')
  } else {
    for (const grade of EVIDENCE_GRADES) {
      const value = snapshot.byGrade[grade]
      if (!Number.isInteger(value) || value < 0) {
        errors.push(`snapshot.byGrade.${grade} must be a non-negative integer (dismissed included)`)
      }
    }
  }
  if (!isPlainObject(snapshot.contentHashes)) {
    errors.push('snapshot.contentHashes must be an object')
  } else {
    for (const [key, value] of Object.entries(snapshot.contentHashes)) {
      if (!isNonEmptyString(key) || !isNonEmptyString(value)) {
        errors.push('snapshot.contentHashes must map non-empty keys to non-empty hash strings')
        break
      }
    }
  }
  return errors
}

/**
 * Non-throwing snapshot completeness check (used by the analyzing guard).
 * @param {RunSnapshot} snapshot
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateSnapshot(snapshot) {
  const errors = collectSnapshotErrors(snapshot)
  return { ok: errors.length === 0, errors }
}

/**
 * Freeze a snapshot collected during the snapshotting phase (§6.1).
 * Validates and returns a normalized clone; throws on incomplete input.
 * `byGrade` must carry all four grades including `dismissed` (negative
 * context count, never a writable-rule candidate).
 * @param {RunSnapshot} input
 * @returns {RunSnapshot}
 */
export function freezeSnapshot(input) {
  const errors = collectSnapshotErrors(input)
  if (errors.length > 0) fail('SNAPSHOT_INVALID', errors.join('; '))
  return {
    takenAt: input.takenAt,
    materialCount: input.materialCount,
    byGrade: {
      resolved: input.byGrade.resolved,
      commit: input.byGrade.commit,
      submitted: input.byGrade.submitted,
      dismissed: input.byGrade.dismissed,
    },
    contentHashes: { ...input.contentHashes },
  }
}

/**
 * Attach a frozen snapshot to a run. Only legal while status is
 * 'snapshotting' (freeze timing, §6.1); re-freezing during snapshotting is
 * allowed (re-collection). Bumps updatedAt; status stays snapshotting.
 * @param {DistillRun} run
 * @param {RunSnapshot} snapshot
 * @param {number} now Injected time (ms)
 * @returns {DistillRun}
 */
export function attachSnapshot(run, snapshot, now) {
  requireNow(now)
  if (!isPlainObject(run)) fail('INVALID_RUN', 'run must be an object')
  if (run.status !== 'snapshotting') {
    fail('SNAPSHOT_PHASE', `snapshot can only be frozen during snapshotting (current: ${run.status})`)
  }
  return { ...run, snapshot: freezeSnapshot(snapshot), updatedAt: now }
}

/**
 * Completeness guard for entering analyzing (§5.1): a complete snapshot,
 * a model selection and a budget must all be present.
 * @param {DistillRun} run
 * @returns {{ ok: boolean, missing: string[] }} missing ⊆ ['snapshot','model','budget']
 */
export function checkAnalyzingReadiness(run) {
  const missing = []
  if (!isPlainObject(run) || !validateSnapshot(run.snapshot).ok) missing.push('snapshot')
  const model = run?.model
  if (!isPlainObject(model) || !isNonEmptyString(model.provider) || !isNonEmptyString(model.model)) {
    missing.push('model')
  }
  const budget = run?.budget
  if (!isPlainObject(budget)
    || typeof budget.maxTokens !== 'number' || !Number.isFinite(budget.maxTokens) || budget.maxTokens <= 0
    || typeof budget.truncated !== 'boolean'
    || (budget.usedTokens !== undefined && (typeof budget.usedTokens !== 'number' || !Number.isFinite(budget.usedTokens) || budget.usedTokens < 0))) {
    missing.push('budget')
  }
  return { ok: missing.length === 0, missing }
}

function nextLockWindow(run, next, now) {
  const prev = isPlainObject(run.lockWindow) ? run.lockWindow : null
  const startedAt = prev && Number.isFinite(prev.startedAt) ? prev.startedAt : now
  if (isTerminalRunStatus(next)) {
    return { startedAt, endedAt: now, expiresAt: prev && Number.isFinite(prev.expiresAt) ? prev.expiresAt : now }
  }
  if (next === 'analyzing') {
    // Window opens (§10.4). expiresAt is provisional here: it only acts as an
    // unlock deadline while status is 'ready' and is recomputed on ready entry.
    return { startedAt: now, expiresAt: now + lockTtlMs }
  }
  if (next === 'ready') {
    // Ready keeps the lock for lockTtlMs, then auto-unlocks while staying ready.
    return { startedAt, expiresAt: now + lockTtlMs }
  }
  if (next === 'applying') {
    // Re-lock on apply (D20). applying never TTL-unlocks: deriveLockWindow
    // keeps it locked regardless of expiresAt.
    return { startedAt, expiresAt: now + lockTtlMs }
  }
  if (next === 'validating') {
    return prev ? { ...prev } : { startedAt: now, expiresAt: now + lockTtlMs }
  }
  // snapshotting: the maintenance window has not opened yet.
  return null
}

/**
 * Apply a legal status transition (clone-on-write). Guards:
 * - transition table + terminal irreversibility (§4.2);
 * - entering analyzing requires complete snapshot/model/budget (§5.1),
 *   evaluated after `patch` is merged;
 * - lockWindow bookkeeping: opens at analyzing, ready TTL deadline at ready,
 *   re-lock at applying, endedAt at any terminal.
 * Host writers must call this inside withWorkspaceLock after re-reading the
 * persisted run; the domain cannot enforce atomicity itself.
 * @param {DistillRun} run
 * @param {string} next Target status
 * @param {object} [opts]
 * @param {number} opts.now Required injected time (ms)
 * @param {Partial<DistillRun>} [opts.patch] Extra fields (progress/model/budget/planId/error/tx/...)
 * @returns {DistillRun}
 */
export function transitionRun(run, next, { now, patch } = {}) {
  requireNow(now)
  if (!isPlainObject(run)) fail('INVALID_RUN', 'run must be an object')
  const from = run.status
  if (!RUN_STATUSES.includes(from)) fail('UNKNOWN_STATUS', `unknown run status: ${from}`)
  if (!canTransitionRun(from, next)) {
    if (isTerminalRunStatus(from)) {
      fail('TERMINAL_IRREVERSIBLE', `run ${run.id ?? '?'} is terminal (${from}); cannot transition to ${next}`)
    }
    fail('ILLEGAL_TRANSITION', `illegal run transition: ${from} -> ${next}`)
  }
  if (patch !== undefined && !isPlainObject(patch)) fail('INVALID_PATCH', 'patch must be an object')
  for (const key of FORBIDDEN_PATCH_KEYS) {
    if (patch && key in patch) fail('PATCH_FORBIDDEN', `patch must not override ${key}`)
  }
  const candidate = { ...run, ...(patch ?? {}) }
  if (next === 'analyzing') {
    const readiness = checkAnalyzingReadiness(candidate)
    if (!readiness.ok) {
      fail('ANALYZING_PREREQUISITES_MISSING', `run cannot enter analyzing; missing: ${readiness.missing.join(', ')}`)
    }
  }
  const result = { ...candidate, status: next, updatedAt: now }
  const lockWindow = nextLockWindow(run, next, now)
  if (lockWindow) result.lockWindow = lockWindow
  else delete result.lockWindow
  return result
}

/**
 * Zeroed token ledger for `run.usage` (§1.5 of the UX Host contract). Always
 * present on the wire so the 结果页/历史 can render counters without null
 * guards; every field is a plain non-negative integer.
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number,
 *   cacheReadTokens: number, cacheWriteTokens: number, calls: number }}
 */
export function emptyRunUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
  }
}

/** Token fields accumulated from one model call's usage echo. */
const RUN_USAGE_FIELDS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
])

/**
 * Merge one model call's usage into a run ledger (mutating accumulator).
 * Missing/non-numeric fields add 0 and never throw: providers legitimately
 * omit cache counters, and a failed call may echo nothing at all. When the
 * provider omits `totalTokens`, the input+output sum is used.
 * @param {{ [key: string]: number }} target ledger created by emptyRunUsage
 * @param {object|null|undefined} usage analyzer- or provider-shaped usage
 * @returns {{ [key: string]: number }} the same target
 */
export function accumulateRunUsage(target, usage) {
  if (!isPlainObject(target) || !isPlainObject(usage)) return target
  for (const field of RUN_USAGE_FIELDS) {
    if (Number.isFinite(usage[field]) && usage[field] > 0) target[field] += usage[field]
  }
  if (!Number.isFinite(usage.totalTokens)) {
    const input = Number.isFinite(usage.inputTokens) ? usage.inputTokens : 0
    const output = Number.isFinite(usage.outputTokens) ? usage.outputTokens : 0
    target.totalTokens += input + output
  }
  if (Number.isFinite(usage.calls) && usage.calls > 0) target.calls += usage.calls
  return target
}

/** Max narration lines kept on run.progress.log (oldest dropped). */
export const PROGRESS_LOG_LIMIT = 30

/**
 * Append one human-readable narration line to a progress object (clone-on-
 * write, bounded by PROGRESS_LOG_LIMIT). Used by transitions that replace the
 * whole progress object (phase switches) so the timeline survives them.
 * @param {{ stage?: string, log?: object[] }|null|undefined} progress
 * @param {string} stage progress stage the line belongs to
 * @param {string} message short human-readable narration
 * @param {number} now injected time (ms)
 * @returns {{ stage?: string, log: Array<{ at: number, stage: string, message: string }> }}
 */
export function appendProgressLog(progress, stage, message, now) {
  requireNow(now)
  const previous = isPlainObject(progress) && Array.isArray(progress.log) ? progress.log : []
  const text = typeof message === 'string' ? message.trim().slice(0, 200) : ''
  if (!text) return { ...(isPlainObject(progress) ? progress : {}), log: previous }
  return {
    ...(isPlainObject(progress) ? progress : {}),
    log: [...previous, { at: now, stage, message: text }].slice(-PROGRESS_LOG_LIMIT),
  }
}

/**
 * Update executor progress (clone-on-write). Only snapshotting/analyzing/
 * validating carry progress; the stage must match the status
 * (snapshotting↔'snapshotting', analyzing↔'stage1'|'stage2', validating↔'validating').
 * An optional `note` appends one human-readable line to `progress.log`
 * (bounded by PROGRESS_LOG_LIMIT); a plain update keeps the previous log.
 * @param {DistillRun} run
 * @param {{ stage: string, completed: number, total: number, note?: string }} progress
 * @param {number} now Injected time (ms)
 * @returns {DistillRun}
 */
export function updateRunProgress(run, progress, now) {
  requireNow(now)
  if (!isPlainObject(run)) fail('INVALID_RUN', 'run must be an object')
  const allowedStages = { snapshotting: ['snapshotting'], analyzing: ['stage1', 'stage2'], validating: ['validating'] }[run.status]
  if (!allowedStages) fail('PROGRESS_PHASE', `status ${run.status} does not carry progress`)
  if (!isPlainObject(progress) || !PROGRESS_STAGES.includes(progress.stage)) {
    fail('PROGRESS_INVALID', 'progress.stage is invalid')
  }
  if (!allowedStages.includes(progress.stage)) {
    fail('PROGRESS_INVALID', `progress.stage ${progress.stage} does not match status ${run.status}`)
  }
  if (!Number.isInteger(progress.completed) || progress.completed < 0
    || !Number.isInteger(progress.total) || progress.total < 0
    || progress.completed > progress.total) {
    fail('PROGRESS_INVALID', 'progress.completed/total must be non-negative integers with completed <= total')
  }
  const nextProgress = { stage: progress.stage, completed: progress.completed, total: progress.total }
  // Optional human-readable narration (running-phase timeline). Plain progress
  // updates keep the previous log so the UI never loses its history.
  const note = typeof progress.note === 'string' ? progress.note.trim().slice(0, 200) : ''
  if (note) {
    const previous = Array.isArray(run.progress?.log) ? run.progress.log : []
    nextProgress.log = [...previous, { at: now, stage: progress.stage, message: note }].slice(-PROGRESS_LOG_LIMIT)
  } else if (Array.isArray(run.progress?.log) && run.progress.log.length > 0) {
    nextProgress.log = run.progress.log
  }
  return { ...run, progress: nextProgress, updatedAt: now }
}

/**
 * Compare the frozen snapshot against current session-side content hashes.
 * A material is drifted when its hash changed or it disappeared; newly added
 * session messages are not part of the frozen material and are ignored.
 * Returns null when nothing drifted, otherwise `{ at, changed }` with sorted
 * `${sessionId}:${messageId}` keys. Pure comparison: never produces a status.
 * @param {DistillRun} run Run carrying a frozen snapshot
 * @param {Record<string, string>} currentHashes Session-side hashes now
 * @param {number} now Injected time (ms)
 * @returns {{ at: number, changed: string[] }|null}
 */
export function detectMaterialDrift(run, currentHashes, now) {
  requireNow(now)
  const frozen = run?.snapshot?.contentHashes
  if (!isPlainObject(frozen)) fail('NO_SNAPSHOT', 'run has no frozen snapshot to compare')
  if (!isPlainObject(currentHashes)) fail('INVALID_HASHES', 'currentHashes must be an object')
  const changed = Object.keys(frozen)
    .filter(key => currentHashes[key] !== frozen[key])
    .sort()
  return changed.length > 0 ? { at: now, changed } : null
}

/**
 * Annotate a run with drift detection (§6.1). Annotation only:
 * - status is never changed (drift never causes the `stale` terminal);
 * - updatedAt and lockWindow are untouched, so TTL clocks are not reset;
 * - when nothing drifted, the same run reference is returned (no write).
 * @param {DistillRun} run
 * @param {Record<string, string>} currentHashes Session-side hashes now
 * @param {number} now Injected time (ms)
 * @returns {DistillRun}
 */
export function markDriftDetected(run, currentHashes, now) {
  const drift = detectMaterialDrift(run, currentHashes, now)
  if (!drift) return run
  return { ...run, driftDetected: drift }
}

/**
 * Derive the maintenance lock window for a workspace (§10.4 / D20):
 * - analyzing (incl. validating) / applying → locked, no TTL unlock;
 * - ready → locked until lockTtlMs elapses, then auto-unlocked while the run
 *   stays ready (apply re-locks later). Deadline: run.lockWindow.expiresAt
 *   when present (maintained by transitionRun), else updatedAt + lockTtlMs;
 *   a parked ready run (`run.parked === true`) is always unlocked — the plan
 *   stays revisitable but must not pause the workspace's submissions;
 * - queued/snapshotting → not yet open;
 * - all terminal statuses → unlocked.
 * Pure derivation: never mutates the run and never changes its status.
 * @param {DistillRun} run
 * @param {number} now Injected time (ms)
 * @returns {LockWindowDerivation}
 */
export function deriveLockWindow(run, now) {
  requireNow(now)
  if (!isPlainObject(run)) fail('INVALID_RUN', 'run must be an object')
  const status = run.status
  if (isTerminalRunStatus(status)) return { locked: false, reason: 'terminal', expiresAt: null }
  if (status === 'queued' || status === 'snapshotting') {
    return { locked: false, reason: 'pre-analysis', expiresAt: null }
  }
  if (status === 'analyzing' || status === 'validating' || status === 'applying') {
    return { locked: true, reason: status, expiresAt: null }
  }
  if (status === 'ready') {
    // Parked is a ready plan that yielded the submission lock: it is still
    // non-terminal (apply / cancel / delete stay legal) but never locks.
    if (run.parked === true) return { locked: false, reason: 'parked', expiresAt: null }
    const persisted = run.lockWindow?.expiresAt
    let expiresAt
    if (typeof persisted === 'number' && Number.isFinite(persisted)) {
      expiresAt = persisted
    } else {
      if (typeof run.updatedAt !== 'number' || !Number.isFinite(run.updatedAt)) {
        fail('INVALID_RUN', 'ready run needs lockWindow.expiresAt or a finite updatedAt')
      }
      expiresAt = run.updatedAt + lockTtlMs
    }
    const locked = now < expiresAt
    return { locked, reason: locked ? 'ready' : 'ready-ttl-expired', expiresAt }
  }
  fail('UNKNOWN_STATUS', `unknown run status: ${status}`)
}

/**
 * Lazy-recovery TTL decision (§4.2 / §16.16). Host executes the action:
 * - 'stale': transition the run to stale (legal only for queued/snapshotting/
 *   analyzing/validating/ready past staleTtlMs, measured from updatedAt);
 * - 'recover-tx': status is applying — it must NEVER be TTL-staled directly;
 *   reconcile tx.currentFile, roll back tx.done in reverse, then failed
 *   (or canceled when a cancel triggered the recovery);
 * - 'none': terminal or still within TTL.
 * Runs holding an active RunControl are skipped by the Host before calling.
 * @param {DistillRun} run
 * @param {number} now Injected time (ms)
 * @returns {StaleEvaluation}
 */
export function evaluateStaleRun(run, now) {
  requireNow(now)
  if (!isPlainObject(run)) fail('INVALID_RUN', 'run must be an object')
  if (isTerminalRunStatus(run.status)) return { action: 'none', reason: 'terminal' }
  if (run.status === 'applying') {
    return { action: 'recover-tx', reason: 'applying-requires-transaction-recovery' }
  }
  if (!RUN_STATUSES.includes(run.status)) fail('UNKNOWN_STATUS', `unknown run status: ${run.status}`)
  if (typeof run.updatedAt !== 'number' || !Number.isFinite(run.updatedAt)) {
    fail('INVALID_RUN', 'run.updatedAt must be a finite number')
  }
  if (now - run.updatedAt > staleTtlMs) return { action: 'stale', reason: 'stale-ttl' }
  return { action: 'none', reason: 'within-ttl' }
}

/**
 * Soft hint: a ready plan older than planExpireMs may be expired and can be
 * rerun (§4.2). Never a terminal cause; the run stays ready. Measured from
 * updatedAt (the ready-entry write); markDriftDetected deliberately does not
 * bump updatedAt, so drift annotation does not shift this clock.
 * @param {DistillRun} run
 * @param {number} now Injected time (ms)
 * @returns {boolean}
 */
export function isPlanExpired(run, now) {
  requireNow(now)
  return isPlainObject(run) && run.status === 'ready'
    && typeof run.updatedAt === 'number' && Number.isFinite(run.updatedAt)
    && now - run.updatedAt > planExpireMs
}

/**
 * Persisted-state cancel arbitration (§4.2 / §13.2), for runs without an
 * active RunControl (the Host handles active controls via in-memory CAS):
 * - canceled → idempotent success;
 * - applied/failed/stale/superseded → too-late (terminal, nothing to cancel);
 * - applying → recover-first: Host reconciles the transaction intent, then
 *   writes canceled (clean rollback) or failed (with reason);
 * - queued/snapshotting/analyzing/validating/ready → direct cancel.
 * @param {DistillRun} run
 * @returns {CancelResolution}
 */
export function resolveCancelByStatus(run) {
  const status = run?.status
  if (!RUN_STATUSES.includes(status)) fail('UNKNOWN_STATUS', `unknown run status: ${status}`)
  if (status === 'canceled') return { outcome: 'idempotent', runStatus: status }
  if (isTerminalRunStatus(status)) return { outcome: 'too-late', runStatus: status }
  if (status === 'applying') return { outcome: 'recover-first', runStatus: status }
  return { outcome: 'cancel', nextStatus: 'canceled', runStatus: status }
}

/**
 * Mark an old ready run as superseded by a rerun (§12.5 / D13).
 * Only ready runs can be superseded; the human's selections on the old plan
 * are preserved because the rerun creates a fresh run instead of overwriting.
 * @param {DistillRun} run
 * @param {string} supersededBy Id of the new run
 * @param {number} now Injected time (ms)
 * @returns {DistillRun}
 */
export function markRunSuperseded(run, supersededBy, now) {
  requireNow(now)
  if (!isNonEmptyString(supersededBy)) fail('INVALID_SUPERSEDE', 'supersededBy (new run id) is required')
  if (isPlainObject(run) && supersededBy === run.id) fail('INVALID_SUPERSEDE', 'a run cannot supersede itself')
  return transitionRun(run, 'superseded', { now, patch: { supersededBy } })
}
