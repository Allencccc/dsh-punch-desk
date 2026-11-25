/**
 * Host-side adapter layer for Finding Distillation (手账精炼).
 *
 * Spec: docs/superpowers/specs/2026-11-11-punch-desk-finding-distillation-design.md
 * Plan: Task 2.1 (read-only session history adapter). Tasks 2.4 (run lifecycle)
 * and 2.5 (multi-file CAS apply) extend this module below the session section;
 * keep the partitions explicit and do not mix pure domain rules into this file
 * (those live in src/domain/distill*.js, decision D19).
 *
 * Interface (lead adjudication 2026-11-11, supersedes the plan's flat-row
 * wording): `readSessionHistory` passes the RAW event stream through. Turn
 * derivation and the messageId→turn reverse index belong to the material
 * domain (Task 1.1, spec §6.3); this adapter never flattens events and never
 * drops `turn/end`. Task 1.1 `selectMaterials` consumes
 * `[{ sessionId, archived, events }]` — exactly this module's output shape.
 *
 * Platform contracts verified against the running Host build (2026-11-11):
 * - `ctx.get('sessionQuery').readSession(sessionId)` resolves to a
 *   `SessionLogSnapshot`: `{ session: SessionHeader, inheritedEventCount,
 *   events: SessionEvent[] }`. The header carries `cwd` (there is no
 *   workspaceId field), so workspace attribution is a canonical-cwd match
 *   against the workspace directory (spec §14.2).
 * - Raw events are `{ type, seq, time, data }` with `turn/start`, `turn/end`,
 *   `user/message` (data IS the UserMessage, no wrapper — AGENTS §5),
 *   `assistant/message` (`data.interrupted?: true`), `tool/call`,
 *   `tool/result`, etc. They are returned untouched.
 * - `ctx.get('workspaceRegistry').archivedSessionIds` is the registry-global
 *   archive set (getter). Archiving only gates `agent/pre-step`;
 *   `readSession` reads archived history without restriction (spec §0.1 /
 *   §7.3, AGENTS §5). This adapter never blocks a read because a session is
 *   archived; a missing registry/field degrades to "not archived".
 *
 * Cordis discipline (AGENTS §4): every optional service is reached through
 * `ctx.get('<name>')` inside try/catch. Never `ctx?.<service>`, never
 * `ctx.<service> || fallback`, never `ctx.remote` (the Host half has no
 * remote service).
 */

import nodeFs from 'node:fs'
import nodePath from 'node:path'
import nodeOs from 'node:os'
import nodeCrypto from 'node:crypto'
import { withWorkspaceLock, sha256Hex } from './host.js'
import {
  createDistillRun,
  transitionRun,
  attachSnapshot,
  freezeSnapshot,
  updateRunProgress,
  getActiveRun,
  isTerminalRunStatus,
  deriveLockWindow,
  evaluateStaleRun,
  resolveCancelByStatus,
  markRunSuperseded,
  isPlanExpired,
  emptyRunUsage,
  accumulateRunUsage,
  appendProgressLog,
  PROGRESS_LOG_LIMIT,
  MIN_BATCH_SESSIONS,
  MAX_BATCH_SESSIONS,
  lockTtlMs,
} from '../domain/distill-run.js'
import { selectMaterials, computeBudget, truncateMaterials } from '../domain/distill.js'
import {
  validatePlan,
  collectAtxAnchors,
  isAllowedDocPath,
  synthesizeFileContent,
  validateDependencySelection,
  isEquivalentContent,
  computeFingerprint,
  changeGrade,
  normalizeNewlines,
  normalizeForFingerprint,
  parseAtxHeading,
} from '../domain/distill-plan.js'

/* ------------------------------------------------------------------ *
 * Section 1 — shared error taxonomy (used by all distill-host sections)
 * ------------------------------------------------------------------ */

/**
 * Error codes surfaced by the distill Host adapter. Route layers (Task 2.4)
 * map these onto the spec §13.3 error table; `WORKSPACE_UNAVAILABLE` is the
 * spec-defined code, the session-read codes are introduced by Task 2.1.
 */
export const DISTILL_ERROR_CODES = Object.freeze({
  /** workspaceId missing, empty, non-string or the forbidden `default`. */
  INVALID_WORKSPACE_ID: 'INVALID_WORKSPACE_ID',
  /** workspaceId is valid but no workspace directory can be resolved. */
  WORKSPACE_UNAVAILABLE: 'WORKSPACE_UNAVAILABLE',
  /** sessionId missing or not a non-empty string. */
  INVALID_SESSION_ID: 'INVALID_SESSION_ID',
  /** Host `sessionQuery` service is missing or has no readSession. */
  SESSION_QUERY_UNAVAILABLE: 'SESSION_QUERY_UNAVAILABLE',
  /** The requested session does not exist (live or persisted). */
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  /** The session header cwd does not belong to the requested workspace. */
  SESSION_WORKSPACE_MISMATCH: 'SESSION_WORKSPACE_MISMATCH',
  /** readSession failed for any other reason (corrupt log, I/O, ...). */
  SESSION_READ_FAILED: 'SESSION_READ_FAILED',
})

/**
 * Coded error thrown by every distill-host adapter function. Callers catch
 * and inspect `.code`; `.cause` preserves the original platform failure and
 * `.details` carries machine-readable context for route responses.
 */
export class DistillHostError extends Error {
  /**
   * @param {string} code one of DISTILL_ERROR_CODES
   * @param {string} message human-readable diagnosis (never user-facing copy)
   * @param {object} [options]
   * @param {unknown} [options.cause] original platform error, when any
   * @param {Record<string, unknown>} [options.details] extra context (ids, paths)
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'DistillHostError'
    this.code = code
    if (options.cause !== undefined) this.cause = options.cause
    this.details = options.details && typeof options.details === 'object' ? options.details : {}
  }
}

/* ------------------------------------------------------------------ *
 * Section 2 — strict workspace resolution (no process.cwd() fallback)
 * ------------------------------------------------------------------ */

/**
 * Validate the mandatory workspaceId (spec §14.1). Empty values and the
 * implicit `default` workspace are rejected; there is deliberately no
 * fallback to `process.cwd()` or to the first registered workspace.
 *
 * @param {unknown} workspaceId
 * @returns {string} the trimmed workspaceId
 * @throws {DistillHostError} INVALID_WORKSPACE_ID
 */
export function assertDistillWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
    throw new DistillHostError(
      DISTILL_ERROR_CODES.INVALID_WORKSPACE_ID,
      'distillation requires a non-empty workspaceId',
    )
  }
  const trimmed = workspaceId.trim()
  if (trimmed.toLowerCase() === 'default') {
    throw new DistillHostError(
      DISTILL_ERROR_CODES.INVALID_WORKSPACE_ID,
      'distillation rejects the implicit "default" workspaceId',
    )
  }
  return trimmed
}

/**
 * Canonicalize a directory for attribution comparison: absolute, no trailing
 * separator, symlinks resolved best-effort (the Host registry canonicalizes
 * workspace paths through fs.realpath, and session cwd may use another
 * spelling of the same directory, e.g. /tmp vs /private/tmp).
 *
 * @param {unknown} dir
 * @param {object} fs
 * @param {object} path
 * @returns {string|null} null when the value cannot be a directory path
 */
function canonicalDir(dir, fs, path) {
  if (typeof dir !== 'string' || dir.trim() === '') return null
  let resolved
  try {
    resolved = path.resolve(dir)
  } catch {
    return null
  }
  try {
    resolved = fs.realpathSync(resolved)
  } catch {
    // Keep the resolved spelling when realpath is unavailable (missing dir).
  }
  return resolved
}

/**
 * Resolve a workspaceId to its directory using only explicit, attributable
 * sources — in priority order:
 *   1. Host `workspaceRegistry.get(id).path` (authoritative registry);
 *   2. the plugin Host store `workspaceRecords` (v2 compatibility layer);
 *   3. an explicit `workspaces` array (tests / embedded callers).
 *
 * Unlike index.js `resolveWorkspaceDir`, this NEVER falls back to
 * `process.cwd()`, never treats the workspaceId itself as a path, and never
 * picks the first workspace (spec §14.1). A candidate path must exist and be
 * a directory.
 *
 * @param {string} workspaceId already validated via assertDistillWorkspaceId
 * @param {object} [sources]
 * @param {object|null} [sources.workspaceRegistry]
 * @param {object|null} [sources.hostStore]
 * @param {Array<object>} [sources.workspaces]
 * @param {object} [deps]
 * @param {object} [deps.fs]
 * @param {object} [deps.path]
 * @returns {Promise<string>} existing workspace directory
 * @throws {DistillHostError} WORKSPACE_UNAVAILABLE when nothing resolves
 */
export async function resolveDistillWorkspaceDir(workspaceId, sources = {}, deps = {}) {
  const id = assertDistillWorkspaceId(workspaceId)
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath
  const candidates = []

  const registry = sources.workspaceRegistry
  if (registry && typeof registry.get === 'function') {
    try {
      const workspace = registry.get(id)
      if (workspace && typeof workspace.path === 'string') candidates.push(workspace.path)
    } catch {
      // Optional service failure: fall through to the next explicit source.
    }
  }

  const hostStore = sources.hostStore
  if (hostStore && typeof hostStore.listWorkspaceRecords === 'function') {
    try {
      const records = await hostStore.listWorkspaceRecords()
      if (Array.isArray(records)) {
        const match = records.find(record => record && record.id === id)
        if (match && typeof match.path === 'string') candidates.push(match.path)
      }
    } catch {
      // Store unavailable: fall through to the next explicit source.
    }
  }

  if (Array.isArray(sources.workspaces)) {
    const match = sources.workspaces.find(workspace => workspace && workspace.id === id)
    if (match && typeof match.path === 'string') candidates.push(match.path)
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // Unreadable candidate: try the next source.
    }
  }

  throw new DistillHostError(
    DISTILL_ERROR_CODES.WORKSPACE_UNAVAILABLE,
    `workspace directory for "${id}" cannot be resolved`,
    { details: { workspaceId: id } },
  )
}

/* ------------------------------------------------------------------ *
 * Section 3 — read-only session history adapter (Task 2.1)
 * ------------------------------------------------------------------ */

/**
 * Raw session history handed to the material domain (Task 1.1). `events` is
 * the untouched `sessionQuery.readSession` event stream (AGENTS §5 shapes,
 * `turn/end` included); the domain derives turns, result pairs and the
 * messageId→turn reverse index from it (spec §6.3).
 *
 * @typedef {object} DistillSessionHistory
 * @property {string} sessionId
 * @property {boolean} archived registry-global archive projection; false when
 *   the registry or its archive set is unavailable (never blocks the read)
 * @property {object[]} events raw SessionEvent[] in log order
 */

/**
 * Read a service through the only Cordis-safe accessor. Returns undefined
 * when the context is missing, `ctx.get` throws (strict service Proxy), or
 * the service is not mounted. Never reads service properties directly.
 *
 * @param {object|null|undefined} ctx
 * @param {string} name
 * @returns {unknown}
 */
function getService(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return undefined
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/**
 * Read one complete session snapshot through `sessionQuery.readSession`.
 * Archived sessions are readable: the Host archive gate only blocks
 * `agent/pre-step`, never history reads (spec §7.3). Failures are mapped to
 * explicit codes — an unavailable service or missing session never produces
 * fabricated empty material.
 *
 * @param {object} ctx Host Cordis context (service access via ctx.get only)
 * @param {string} sessionId
 * @returns {Promise<{session: object, inheritedEventCount?: number, events: object[]}>}
 * @throws {DistillHostError} INVALID_SESSION_ID | SESSION_QUERY_UNAVAILABLE |
 *   SESSION_NOT_FOUND | SESSION_READ_FAILED
 */
async function readSessionSnapshot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new DistillHostError(
      DISTILL_ERROR_CODES.INVALID_SESSION_ID,
      'sessionId must be a non-empty string',
    )
  }

  const sessionQuery = getService(ctx, 'sessionQuery')
  if (!sessionQuery || typeof sessionQuery.readSession !== 'function') {
    throw new DistillHostError(
      DISTILL_ERROR_CODES.SESSION_QUERY_UNAVAILABLE,
      'Host sessionQuery service is unavailable; session history cannot be read',
    )
  }

  let snapshot
  try {
    snapshot = await sessionQuery.readSession(sessionId)
  } catch (error) {
    if (error && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
      throw new DistillHostError(
        DISTILL_ERROR_CODES.SESSION_NOT_FOUND,
        `session "${sessionId}" was not found`,
        { cause: error, details: { sessionId } },
      )
    }
    throw new DistillHostError(
      DISTILL_ERROR_CODES.SESSION_READ_FAILED,
      `failed to read session "${sessionId}"`,
      { cause: error, details: { sessionId } },
    )
  }

  if (
    !snapshot || typeof snapshot !== 'object'
    || !snapshot.session || typeof snapshot.session !== 'object'
    || !Array.isArray(snapshot.events)
    || snapshot.session.id !== sessionId
  ) {
    throw new DistillHostError(
      DISTILL_ERROR_CODES.SESSION_READ_FAILED,
      `sessionQuery.readSession returned an invalid snapshot for "${sessionId}"`,
      { details: { sessionId } },
    )
  }

  return snapshot
}

/**
 * Project the registry-global archive set defensively (AGENTS §5): a missing
 * registry, missing field, non-array value or throwing getter all mean
 * "no archive information" → false. Archive state is a read-only projection;
 * it never gates history reads and is never written by this plugin.
 *
 * @param {unknown} workspaceRegistry
 * @param {string} sessionId
 * @returns {boolean}
 */
function isSessionArchived(workspaceRegistry, sessionId) {
  try {
    if (!workspaceRegistry || typeof workspaceRegistry !== 'object') return false
    const ids = workspaceRegistry.archivedSessionIds
    return Array.isArray(ids) && ids.includes(sessionId)
  } catch {
    return false
  }
}

/**
 * Read the raw history of one session for distillation, with mandatory
 * workspace attribution (spec §14):
 *
 * 1. validate workspaceId (reject empty / `default`, no cwd fallback);
 * 2. resolve the workspace directory from explicit sources only;
 * 3. read the complete session snapshot via `sessionQuery.readSession`
 *    (archived sessions included — read-only history is never gated);
 * 4. verify the session header `cwd` canonically matches the workspace
 *    directory; a session without cwd cannot be attributed and is rejected;
 * 5. return `{ sessionId, archived, events }` with the raw event stream
 *    untouched (no flattening, `turn/end` preserved) plus the archive
 *    projection for the domain's downgrade rules (spec §6.2).
 *
 * Every failure throws a coded DistillHostError; an empty `events` array is
 * returned only for a session that genuinely has no events.
 *
 * @param {object} ctx Host Cordis context (service access via ctx.get only)
 * @param {object} input
 * @param {string} input.workspaceId mandatory, non-empty, not `default`
 * @param {string} input.sessionId candidate session to read
 * @param {object} [deps]
 * @param {object} [deps.fs]
 * @param {object} [deps.path]
 * @param {object|null} [deps.workspaceRegistry] override for the registry service
 * @param {object|null} [deps.hostStore] override for the plugin Host store
 * @param {Array<object>} [deps.workspaces] explicit workspace list (tests)
 * @returns {Promise<DistillSessionHistory>}
 * @throws {DistillHostError} INVALID_WORKSPACE_ID | WORKSPACE_UNAVAILABLE |
 *   INVALID_SESSION_ID | SESSION_QUERY_UNAVAILABLE | SESSION_NOT_FOUND |
 *   SESSION_WORKSPACE_MISMATCH | SESSION_READ_FAILED
 */
/**
 * Read one session's raw snapshot with its workspace attribution verified.
 * Shared by `readSessionHistory` (which narrows the result to the documented
 * `{sessionId, archived, events}` shape) and by the read-only estimate route,
 * which additionally needs the session title from the raw event stream.
 *
 * @param {object} ctx Host Cordis context (service access via ctx.get only)
 * @param {{ workspaceId: string, sessionId: string }} input
 * @param {object} [deps]
 * @returns {Promise<{ snapshot: object, workspaceRegistry: object|undefined|any }>}
 * @throws {DistillHostError}
 */
async function readWorkspaceSession(ctx, { workspaceId, sessionId } = {}, deps = {}) {
  const id = assertDistillWorkspaceId(workspaceId)
  const fs = deps.fs || nodeFs
  const path = deps.path || nodePath

  const workspaceRegistry = deps.workspaceRegistry !== undefined
    ? deps.workspaceRegistry
    : getService(ctx, 'workspaceRegistry')
  const hostStore = deps.hostStore !== undefined
    ? deps.hostStore
    : getService(ctx, 'hostStore')

  const workspaceDir = await resolveDistillWorkspaceDir(
    id,
    { workspaceRegistry, hostStore, workspaces: deps.workspaces },
    { fs, path },
  )

  const snapshot = await readSessionSnapshot(ctx, sessionId)

  const sessionCwd = canonicalDir(snapshot.session.cwd, fs, path)
  const workspaceCanonical = canonicalDir(workspaceDir, fs, path)
  if (!sessionCwd || !workspaceCanonical || sessionCwd !== workspaceCanonical) {
    throw new DistillHostError(
      DISTILL_ERROR_CODES.SESSION_WORKSPACE_MISMATCH,
      `session "${sessionId}" does not belong to workspace "${id}"`,
      { details: { sessionId, workspaceId: id } },
    )
  }

  return { snapshot, workspaceRegistry }
}

export async function readSessionHistory(ctx, { workspaceId, sessionId } = {}, deps = {}) {
  const { snapshot, workspaceRegistry } = await readWorkspaceSession(ctx, { workspaceId, sessionId }, deps)
  return {
    sessionId,
    archived: isSessionArchived(workspaceRegistry, sessionId),
    events: snapshot.events,
  }
}

/**
 * Human-readable session title derived from the raw log: the latest
 * `session/title` event wins (`SessionTitleEventData` in the Host contract).
 * The session header carries no title, so the log is the only truthful
 * Host-side source; a session without a title event returns null and the
 * client falls back to its own session list.
 * @param {object[]|undefined} events raw SessionEvent[]
 * @returns {string|null}
 */
function sessionTitleFromEvents(events) {
  let title = null
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'session/title') continue
    const text = event.data?.title
    if (typeof text === 'string' && text.trim() !== '') title = text.trim()
  }
  return title
}

/* ------------------------------------------------------------------ *
 * Section 4 — Task 2.4: run lifecycle orchestration, RunControl,
 * lazy recovery, target-surface collection, non-apply route support
 * ------------------------------------------------------------------ */

/**
 * Lifecycle/route error codes introduced by Task 2.4 (the session-read codes
 * live in DISTILL_ERROR_CODES above; analyzer codes are passed through).
 */
export const DISTILL_LIFECYCLE_CODES = Object.freeze({
  /** Single-batch invariant: a non-terminal run already occupies the workspace. */
  RUN_ALREADY_ACTIVE: 'RUN_ALREADY_ACTIVE',
  /** GET/cancel referenced an unknown run id. */
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  /** Request shape invalid (missing params, bad sessions, too many files). */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** Baseline/surface path violates the §8.3 hard boundary. */
  PATH_REJECTED: 'PATH_REJECTED',
  /** Lazy recovery found no registered apply-recovery handler (Task 2.5). */
  RECOVERY_PENDING: 'RECOVERY_PENDING',
  /** Run exceeded staleTtlMs without activity (informational run.error). */
  STALE_TTL: 'STALE_TTL',
})

/** Finished RunControls linger this long to answer late cancels with too_late. */
export const RUN_CONTROL_FINISHED_TTL_MS = 60 * 1000
/** Per-workspace cap for the in-process RunControl map (finished evicted first). */
export const RUN_CONTROL_MAX_PER_WORKSPACE = 32
/** Consecutive WORKSPACE_UNAVAILABLE recovery attempts before a run is failed. */
export const RECOVERY_WORKSPACE_MAX_RETRIES = 5

const TMP_SCAN_MAX_DEPTH = 8
const TMP_SCAN_MAX_ENTRIES = 5000
const SNIPPET_MAX_FILES = 10
const SNIPPET_MAX_CHARS = 20000
const BASELINE_MAX_FILES = 20
const IGNORED_SCAN_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.dsh', 'dist', 'build', 'coverage'])

/**
 * Map a distill error code onto the spec §13.3 HTTP table (plus the Task 2.3
 * analyzer codes: timeout → 504, invalid input → 400, aborted → 409, other
 * analyzer internals → 500). Unknown codes are 500.
 * @param {string} code
 * @returns {number}
 */
export function distillErrorStatus(code) {
  switch (code) {
    case 'ANALYZER_UNAVAILABLE':
    case 'SESSION_QUERY_UNAVAILABLE':
      return 503
    case 'ANALYZER_TIMEOUT':
      return 504
    case 'CONTEXT_WINDOW_UNAVAILABLE':
    case 'WORKSPACE_UNAVAILABLE':
    case 'CAS_CONFLICT':
    case 'RECOVERY_CONFLICT':
    case 'BACKUP_CORRUPT':
    case 'BACKUP_MISSING':
    case 'RUN_ALREADY_ACTIVE':
    case 'ABORTED':
      return 409
    case 'SESSION_NOT_FOUND':
    case 'RUN_NOT_FOUND':
      return 404
    case 'SESSION_WORKSPACE_MISMATCH':
    case 'PATH_REJECTED':
      return 403
    case 'INVALID_WORKSPACE_ID':
    case 'INVALID_SESSION_ID':
    case 'INVALID_REQUEST':
    case 'INVALID_INPUT':
    case 'INVALID_BATCH':
    case 'INVALID_RUN':
    case 'INVALID_WORKSPACE':
    case 'INVALID_SUPERSEDE':
      return 400
    default:
      return 500
  }
}

/**
 * Serialize a thrown adapter/lifecycle error as a route result.
 * @param {unknown} err
 * @returns {{ ok: false, status: number, code: string, error: string }}
 */
export function distillErrorResult(err) {
  const code = err && typeof err.code === 'string' && err.code ? err.code : 'INTERNAL_ERROR'
  const result = {
    ok: false,
    status: distillErrorStatus(code),
    code,
    error: err?.message || String(err),
  }
  if (err && typeof err.details === 'object' && err.details !== null) {
    Object.assign(result, err.details)
  }
  return result
}

/**
 * Business error for the four UX Host routes (contract §1): the body is always
 * serialized with HTTP 200 and carries the code in BOTH idioms — `code` +
 * `message` (the established distill-* handler style) and
 * `error: { code, message }` (the shape the UX contract documents) — so the
 * client half can read either without a compatibility branch.
 * @param {string} code stable error code
 * @param {string} message human-readable diagnosis
 * @param {Record<string, unknown>} [details] extra machine-readable context
 * @returns {{ ok: false, status: 200, code: string, message: string, error: { code: string, message: string } }}
 */
export function distillRouteError(code, message, details = {}) {
  return {
    ok: false,
    status: 200,
    code,
    message,
    error: { code, message },
    ...(details && typeof details === 'object' ? details : {}),
  }
}

/** Max characters of the current disk section echoed by a rebase preview (§1.4). */
const REBASE_PREVIEW_MAX_CHARS = 2000

/**
 * Progress object for a phase-switch transition. `transitionRun` replaces
 * `progress` wholesale, so the narration log is carried forward explicitly and
 * one new human-readable line is appended (bounded by PROGRESS_LOG_LIMIT).
 * @param {object|null|undefined} previous previous run.progress
 * @param {string} stage progress stage the line belongs to
 * @param {number} completed
 * @param {number} total
 * @param {string} message short human-readable narration
 * @param {number} at injected time (ms)
 * @returns {{ stage: string, completed: number, total: number, log?: object[] }}
 */
function carryProgressLog(previous, stage, completed, total, message, at) {
  const previousLog = previous && Array.isArray(previous.log) ? previous.log : []
  const appended = appendProgressLog({ log: previousLog }, stage, message, at)
  const log = Array.isArray(appended.log) ? appended.log : []
  return { stage, completed, total, ...(log.length > 0 ? { log } : {}) }
}

/**
 * Run shape handed to the client (GET distill-run): `usage` is always present
 * and `progress.log` is always an array, so the 运行/历史 views can render the
 * ledger and the timeline for runs persisted before the UX contract.
 * @param {object|null} run
 * @returns {object|null}
 */
function withRunDefaults(run) {
  if (!run || typeof run !== 'object') return run
  const out = { ...run }
  // `parked` is a ready-only flag; every wire run carries the boolean so the
  // history view never has to distinguish "absent" from "false".
  if (out.parked !== true) out.parked = false
  if (!out.usage || typeof out.usage !== 'object' || Array.isArray(out.usage)) out.usage = emptyRunUsage()
  if (out.progress && typeof out.progress === 'object' && !Array.isArray(out.progress.log)) {
    out.progress = { ...out.progress, log: [] }
  }
  return out
}

/**
 * Current disk text of one change's target section, truncated to 2000 chars
 * (§1.4 rebase preview). An anchor that no longer exists returns '' so the
 * preview honestly shows "this section is gone"; an append-section change (no
 * anchor) echoes the file tail.
 * @param {string} content current disk content
 * @param {string|null} anchor ATX heading text of the change, if any
 * @returns {string}
 */
function sectionTextOf(content, anchor) {
  const normalized = normalizeNewlines(typeof content === 'string' ? content : '')
  if (!anchor) return normalized.slice(-REBASE_PREVIEW_MAX_CHARS)
  const parsed = parseAtxHeading(anchor)
  if (!parsed) return ''
  const match = collectAtxAnchors(normalized)
    .find(entry => entry.level === parsed.level && entry.text === parsed.text)
  if (!match) return ''
  return normalized.split('\n').slice(match.startLine, match.endLine).join('\n').slice(0, REBASE_PREVIEW_MAX_CHARS)
}

/**
 * Read the target repo's AGENTS.md §0 navigation section (spec §8.1/§8.2).
 * No tree parser: the section text is handed to the model as the document
 * map; the plugin only decides tree vs fallback. Missing AGENTS.md, missing
 * §0 or a section without any document reference degrades to fallback.
 * @param {string} workspaceDir
 * @param {object} [deps]
 * @param {object} [deps.fs]
 * @param {object} [deps.path]
 * @returns {{ content: string, mode: 'tree'|'fallback' }}
 */
export function readNavigation(workspaceDir, { fs = nodeFs, path = nodePath } = {}) {
  const fallback = { content: '', mode: 'fallback' }
  try {
    const agentsPath = path.join(workspaceDir, 'AGENTS.md')
    if (!fs.existsSync(agentsPath)) return fallback
    const lines = fs.readFileSync(agentsPath, 'utf8').split('\n')
    const start = lines.findIndex(line => /^##\s+0[.．、]?\s*工程文档体系与导航/.test(line))
    if (start < 0) return fallback
    let end = lines.length
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) { end = i; break }
    }
    const section = lines.slice(start, end).join('\n').trim()
    if (!section) return fallback
    const hasTree = /\.md\b/.test(section) || /[├└│]/.test(section)
    return hasTree ? { content: section, mode: 'tree' } : fallback
  } catch {
    return fallback
  }
}

/**
 * §8.3 symlink guard: lstat every segment of a relative doc path under the
 * workspace root; any symlink rejects the path.
 * @param {string} workspaceDir
 * @param {string} file
 * @param {object} deps
 * @returns {boolean}
 */
function hasSymlinkSegment(workspaceDir, file, { fs = nodeFs, path = nodePath } = {}) {
  const segments = file.split('/')
  let current = workspaceDir
  for (const segment of segments) {
    current = path.join(current, segment)
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Deterministic navigation membership without a tree parser (D10 hard
 * boundary): either the full relative path appears as a path token, or the
 * file's basename appears AND every ancestor directory is listed as a
 * `name/` token (hierarchical trees spell `docs/` and `guide.md` on separate
 * lines). Token boundaries prevent `guide.md` matching `guide.md.bak`.
 * @param {string} navContent
 * @param {string} file
 * @returns {boolean}
 */
function isNavRegistered(navContent, file) {
  const boundary = '(?![\\w./-])'
  if (new RegExp(escapeRegExp(file) + boundary).test(navContent)) return true
  const segments = file.split('/')
  const base = segments[segments.length - 1]
  if (!new RegExp(escapeRegExp(base) + boundary).test(navContent)) return false
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!navContent.includes(`${segments[i]}/`)) return false
  }
  return true
}

/**
 * Collect the §9 TargetSurfaceSnapshot for a plan (Host side of D19: read
 * disk / hash / anchors here, pure validation stays in distill-plan.js).
 * Anchors reuse collectAtxAnchors so collection and §8.4 synthesis agree.
 * Update targets carry content (required); create targets are expressed via
 * plannedFiles. Rejected paths are surfaced honestly, never silently skipped.
 * @param {string} workspaceDir
 * @param {object} plan ChangePlan
 * @param {{ content: string, mode: 'tree'|'fallback' }} navigation
 * @param {object} [deps]
 * @returns {{ navigation: object, targets: object[], plannedFiles: string[] }}
 */
export function collectTargetSurface(workspaceDir, plan, navigation, { fs = nodeFs, path = nodePath } = {}) {
  const mode = navigation?.mode === 'tree' ? 'tree' : 'fallback'
  const navContent = typeof navigation?.content === 'string' ? navigation.content : ''
  const targets = []
  const plannedFiles = []
  for (const target of Array.isArray(plan?.targets) ? plan.targets : []) {
    const file = target?.file
    if (typeof file !== 'string' || !isAllowedDocPath(file)) {
      targets.push({ file, exists: false, fileBaseHash: null, anchors: [], navRegistered: false, pathRejected: true })
      continue
    }
    if (hasSymlinkSegment(workspaceDir, file, { fs, path })) {
      targets.push({ file, exists: false, fileBaseHash: null, anchors: [], navRegistered: false, symlinkRejected: true })
      continue
    }
    let exists = false
    let content = null
    let fileBaseHash = null
    let anchors = []
    try {
      const full = path.join(workspaceDir, file)
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        exists = true
        content = fs.readFileSync(full, 'utf8')
        fileBaseHash = sha256Hex(content, nodeCrypto)
        anchors = collectAtxAnchors(content)
      }
    } catch {
      exists = false
      content = null
      fileBaseHash = null
      anchors = []
    }
    const navRegistered = mode === 'tree' && isNavRegistered(navContent, file)
    const entry = { file, exists, fileBaseHash, anchors, navRegistered }
    if (content !== null) entry.content = content
    targets.push(entry)
    if (target.action === 'create' && !exists) plannedFiles.push(file)
  }
  return { navigation: { content: navContent, mode }, targets, plannedFiles }
}

/**
 * Relevant target-document snippets for stage 2 (spec §6.4): existing files
 * suggested by stage 1 candidates, capped in count and size. Read-only.
 * @param {string} workspaceDir
 * @param {Array<{ sessionId: string, candidates: object[] }>} stage1Results
 * @param {object} [deps]
 * @returns {Array<{ file: string, content: string }>}
 */
function collectTargetSnippets(workspaceDir, stage1Results, { fs = nodeFs, path = nodePath } = {}) {
  const suggested = new Set()
  for (const result of Array.isArray(stage1Results) ? stage1Results : []) {
    for (const candidate of Array.isArray(result?.candidates) ? result.candidates : []) {
      for (const file of Array.isArray(candidate?.suggestedTargets) ? candidate.suggestedTargets : []) {
        if (typeof file === 'string' && isAllowedDocPath(file)) suggested.add(file)
      }
    }
  }
  const snippets = []
  for (const file of suggested) {
    if (snippets.length >= SNIPPET_MAX_FILES) break
    try {
      if (hasSymlinkSegment(workspaceDir, file, { fs, path })) continue
      const full = path.join(workspaceDir, file)
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue
      const content = fs.readFileSync(full, 'utf8')
      snippets.push({ file, content: content.slice(0, SNIPPET_MAX_CHARS) })
    } catch {
      // Unreadable suggestion: skip, never fabricate content.
    }
  }
  return snippets
}

/**
 * Remove residual `.tmp-*` files left by a crashed apply (spec §4.2/§11.2.6).
 * Convention for Task 2.5: temporary writes must use a `.tmp-` basename prefix
 * so recovery can find them. Bounded walk; never follows directory symlinks.
 * @param {string} workspaceDir
 * @param {object} [deps]
 * @returns {number} removed count
 */
function cleanResidualTmpFiles(workspaceDir, { fs = nodeFs, path = nodePath } = {}) {
  let removed = 0
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > TMP_SCAN_MAX_DEPTH || visited >= TMP_SCAN_MAX_ENTRIES) return
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      visited += 1
      if (visited >= TMP_SCAN_MAX_ENTRIES) return
      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRS.has(entry.name)) walk(path.join(dir, entry.name), depth + 1)
      } else if (entry.isFile() && entry.name.startsWith('.tmp-')) {
        try {
          fs.unlinkSync(path.join(dir, entry.name))
          removed += 1
        } catch {
          // Leave undeletable residue; never throw from recovery cleanup.
        }
      }
    }
  }
  walk(workspaceDir, 0)
  return removed
}

/**
 * Graceful stand-in until the lead wires the real analyzer (Task 2.3):
 * every probe fails with ANALYZER_UNAVAILABLE, no run is ever created.
 * @returns {{ probeContextWindow: Function, runStage1: Function, runStage2: Function }}
 */
function unavailableAnalyzer() {
  const failure = async () => ({
    ok: false,
    error: { code: 'ANALYZER_UNAVAILABLE', message: 'distill analyzer is not wired into this Host entry' },
  })
  return { probeContextWindow: failure, runStage1: failure, runStage2: failure }
}

/**
 * @typedef {object} ApplyRecoveryResult
 * @property {'failed'|'canceled'} runStatus Final status the hook persisted
 * @property {{ code: string, message: string }} [error] Failure reason when failed
 * @property {boolean} rolledBack Whether the transaction was fully rolled back
 *   (false for RECOVERY_CONFLICT / BACKUP_CORRUPT / BACKUP_MISSING scenes)
 * @property {string[]} [targets] Affected files (conflict scenes)
 * @property {string} [backupPath] Preserved backup location (conflict scenes)
 */

/**
 * Create the per-process distillation lifecycle (one instance per Host
 * apply()). Owns the in-process RunControl map, the background executor,
 * lazy recovery and the apply-recovery hook registry. All run writes go
 * through withWorkspaceLock(realpath(workspaceDir)) with re-read + terminal
 * guards; the cancel path for active controls never takes that lock.
 *
 * @param {object} options
 * @param {object} options.ctx Host Cordis context (services via ctx.get only)
 * @param {object} options.store Host DeskStore (distill buckets, Task 2.2)
 * @param {object} [options.analyzer] DI: { probeContextWindow, runStage1, runStage2 }
 *   (Task 2.3 createDistillAnalyzer output; tests mock it)
 * @param {() => number} [options.now] Injected clock (Host layer; tests fix it)
 * @param {() => string} [options.uuid] Run id factory
 * @param {object} [options.fs]
 * @param {object} [options.path]
 * @param {object} [options.workspaceRegistry] Override (tests); default ctx.get
 * @param {Array<object>} [options.workspaces] Explicit workspace list (tests)
 */
export function createDistillLifecycle({
  ctx = null,
  store,
  analyzer = null,
  now = Date.now,
  uuid = () => nodeCrypto.randomUUID(),
  fs = nodeFs,
  path = nodePath,
  workspaceRegistry,
  workspaces,
} = {}) {
  if (!store || typeof store !== 'object') throw new Error('createDistillLifecycle requires a host store')
  const analyzerApi = analyzer && typeof analyzer.probeContextWindow === 'function' ? analyzer : unavailableAnalyzer()

  const getService = (name) => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  const registry = () => (workspaceRegistry !== undefined ? workspaceRegistry : getService('workspaceRegistry'))
  const sessionDeps = () => {
    const deps = { fs, path, hostStore: store }
    if (workspaceRegistry !== undefined) deps.workspaceRegistry = workspaceRegistry
    if (workspaces !== undefined) deps.workspaces = workspaces
    return deps
  }

  /** runId → RunControl (process memory; never persisted, spec §11.2.7). */
  const controls = new Map()
  /** runId → executor promise (inspection/await hook for tests). */
  const executors = new Map()
  /** runId → consecutive WORKSPACE_UNAVAILABLE recovery failures. */
  const workspaceFailures = new Map()
  /** Registered by Task 2.5; called OUTSIDE the workspace lock. */
  let applyRecoveryHandler = null

  function purgeControls() {
    const t = now()
    for (const [id, control] of controls) {
      if (control.state === 'finished' && t - control.finishedAt > RUN_CONTROL_FINISHED_TTL_MS) {
        controls.delete(id)
      }
    }
    const byWorkspace = new Map()
    for (const control of controls.values()) {
      const list = byWorkspace.get(control.workspaceId) || []
      list.push(control)
      byWorkspace.set(control.workspaceId, list)
    }
    for (const list of byWorkspace.values()) {
      if (list.length <= RUN_CONTROL_MAX_PER_WORKSPACE) continue
      const finished = list.filter(c => c.state === 'finished').sort((a, b) => a.finishedAt - b.finishedAt)
      let excess = list.length - RUN_CONTROL_MAX_PER_WORKSPACE
      for (const control of finished) {
        if (excess <= 0) break
        controls.delete(control.runId)
        excess -= 1
      }
    }
  }

  function registerControl(runId, workspaceId) {
    purgeControls()
    const control = {
      runId,
      workspaceId,
      state: 'active',
      abort: new AbortController(),
      createdAt: now(),
      finishedAt: null,
    }
    controls.set(runId, control)
    return control
  }

  /**
   * Synchronous compare-and-set on a RunControl (no await between read and
   * write). This is the cancel/commit linearization point (spec §11.2.7).
   * @param {object} control
   * @param {string} from
   * @param {string} to
   * @returns {boolean}
   */
  function casControl(control, from, to) {
    if (!control || control.state !== from) return false
    control.state = to
    if (to === 'finished') control.finishedAt = now()
    return true
  }

  function finishControl(control) {
    if (!control || control.state === 'finished') return
    control.state = 'finished'
    control.finishedAt = now()
    purgeControls()
  }

  async function lockKeyFor(workspaceId) {
    const dir = await resolveDistillWorkspaceDir(
      workspaceId,
      { workspaceRegistry: registry(), hostStore: store, workspaces },
      { fs, path },
    )
    let key = dir
    try {
      key = fs.realpathSync(dir)
    } catch {
      // Keep the resolved spelling when realpath is unavailable.
    }
    return { dir, key }
  }

  /**
   * The single run-write funnel: workspace lock → re-read → terminal guard →
   * mutate (domain transition/progress) → persist. Late writes against a
   * terminal run are skipped, never applied (spec §4.2 / §16.16).
   * @param {string} key realpath lock key
   * @param {string} runId
   * @param {(run: object) => object|null} mutate
   * @returns {Promise<{ skipped: boolean, reason?: string, run?: object, error?: Error }>}
   */
  async function writeRunLocked(key, runId, mutate) {
    return withWorkspaceLock(key, async () => {
      const current = await store.getDistillRun(runId)
      if (!current) return { skipped: true, reason: 'missing' }
      if (isTerminalRunStatus(current.status)) return { skipped: true, reason: 'terminal', run: current }
      let next
      try {
        next = mutate(current)
      } catch (error) {
        return { skipped: true, reason: 'rejected', run: current, error }
      }
      if (!next) return { skipped: true, reason: 'noop', run: current }
      const persisted = await store.putDistillRun(next)
      return { skipped: false, run: persisted }
    })
  }

  const transitionLocked = (key, runId, next, patch) =>
    writeRunLocked(key, runId, run => transitionRun(run, next, { now: now(), patch }))

  const progressLocked = (key, runId, progress) =>
    writeRunLocked(key, runId, run => updateRunProgress(run, progress, now()))

  /**
   * Apply-recovery hook registry (Task 2.5 consumes). The handler is invoked
   * OUTSIDE the workspace lock and owns its own locking, re-read, tx
   * reconciliation (currentFile first, done reverse), fingerprint deletion
   * and final run persistence. Exactly one handler; last registration wins.
   * @param {(input: { run: object, workspaceDir: string, store: object, now: number }) => Promise<ApplyRecoveryResult>} handler
   * @returns {() => void} unregister
   */
  function registerApplyRecovery(handler) {
    if (typeof handler !== 'function') throw new Error('registerApplyRecovery requires a function')
    applyRecoveryHandler = handler
    return () => {
      if (applyRecoveryHandler === handler) applyRecoveryHandler = null
    }
  }

  async function recoverApplyingRun(run) {
    if (!applyRecoveryHandler) return { recovered: false, reason: DISTILL_LIFECYCLE_CODES.RECOVERY_PENDING }
    let dir
    try {
      ({ dir } = await lockKeyFor(run.workspaceId))
    } catch {
      return { recovered: false, reason: 'WORKSPACE_UNAVAILABLE' }
    }
    try {
      const result = await applyRecoveryHandler({ run, workspaceDir: dir, store, now: now() })
      return { recovered: true, result }
    } catch (error) {
      return { recovered: false, reason: 'handler-error', error: { code: error?.code || 'INTERNAL_ERROR', message: error?.message || String(error) } }
    }
  }

  /**
   * Lazy non-apply recovery (spec §4.2 / §16.20), triggered by distill-*
   * requests. Best-effort: never throws into the request path.
   * - skips runs holding a live RunControl (no lock taken for the skip);
   * - applying → apply-recovery hook (never TTL-staled directly);
   * - queued/snapshotting/analyzing/validating/ready past staleTtlMs → stale;
   * - workspaceDir unresolvable → keep non-terminal + record
   *     WORKSPACE_UNAVAILABLE, retry on later requests; only after
   *     RECOVERY_WORKSPACE_MAX_RETRIES consecutive failures fail the run
   *     (tx/backups preserved, no rollback claimed);
   * - cleans residual .tmp-* when something was recovered; prunes retention.
   * @param {string} workspaceId
   * @returns {Promise<{ recovered: number }>}
   */
  async function recoverWorkspace(workspaceId) {
    try {
      const runs = await store.listDistillRuns(workspaceId)
      const nonTerminal = runs.filter(run => run && !isTerminalRunStatus(run.status))
      if (nonTerminal.length === 0) {
        if (typeof store.pruneDistillData === 'function') await store.pruneDistillData({ workspaceId })
        return { recovered: 0 }
      }
      purgeControls()
      let dir = null
      let key = null
      try {
        ({ dir, key } = await lockKeyFor(workspaceId))
      } catch {
        dir = null
      }
      let recovered = 0
      for (const run of nonTerminal) {
        try {
          const control = controls.get(run.id)
          if (control && control.state !== 'finished') continue
          if (!dir) {
            const failures = (workspaceFailures.get(run.id) || 0) + 1
            workspaceFailures.set(run.id, failures)
            const latest = await store.getDistillRun(run.id)
            if (!latest || isTerminalRunStatus(latest.status)) {
              workspaceFailures.delete(run.id)
              continue
            }
            const error = { code: 'WORKSPACE_UNAVAILABLE', message: 'workspace directory temporarily unavailable; recovery will retry' }
            if (failures >= RECOVERY_WORKSPACE_MAX_RETRIES) {
              // Confirmed unavailable: fail without claiming rollback; tx stays.
              const failed = transitionRun(latest, 'failed', { now: now(), patch: { error } })
              await store.putDistillRun(failed)
              workspaceFailures.delete(run.id)
              recovered += 1
            } else {
              // Annotation only: keep status and updatedAt (TTL clock intact).
              await store.putDistillRun({ ...latest, error })
            }
            continue
          }
          workspaceFailures.delete(run.id)
          if (run.status === 'applying') {
            const outcome = await recoverApplyingRun(run)
            if (outcome.recovered) recovered += 1
            continue
          }
          const evaluation = evaluateStaleRun(run, now())
          if (evaluation.action === 'stale') {
            const result = await transitionLocked(key, run.id, 'stale', {
              error: { code: DISTILL_LIFECYCLE_CODES.STALE_TTL, message: 'run exceeded staleTtlMs without activity' },
            })
            if (!result.skipped) recovered += 1
          }
        } catch {
          // Per-run isolation: one bad row never blocks the rest.
        }
      }
      if (recovered > 0 && dir) cleanResidualTmpFiles(dir, { fs, path })
      if (typeof store.pruneDistillData === 'function') await store.pruneDistillData({ workspaceId })
      return { recovered }
    } catch {
      return { recovered: 0 }
    }
  }

  /**
   * Background executor: queued → snapshotting → analyzing(stage1|stage2) →
   * validating → ready. Cancel checkpoints at every phase boundary; analyzing
   * aborts through the RunControl AbortController. The executor is the sole
   * writer of its run's progress and writes the canceled terminal after a
   * requested cancel (spec §4.2).
   * @param {object} initialRun persisted queued run
   * @param {{ dir: string, key: string, probe: object }} ctx0
   */
  async function executeRun(initialRun, { dir, key, probe }) {
    const runId = initialRun.id
    const workspaceId = initialRun.workspaceId
    const control = registerControl(runId, workspaceId)
    const signal = control.abort.signal
    const isCancelled = () => control.state === 'cancelRequested' || signal.aborted
    // Monotonic guard: fire-and-forget onProgress writes never regress.
    const progressHighWater = new Map()
    const onProgress = stage => (payload) => {
      if (!payload || typeof payload !== 'object') return
      const completed = payload.completed
      const total = payload.total
      if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 0 || completed > total) return
      const high = progressHighWater.get(stage) || 0
      if (completed < high) return
      progressHighWater.set(stage, completed)
      progressLocked(key, runId, { stage, completed, total }).catch(() => {})
    }
    /**
     * Phase-switch transition (contract §1.5: every phase switch is narrated).
     * `transitionRun` replaces `progress` wholesale, so the narration log is
     * carried forward explicitly and one human-readable line is appended.
     */
    const transitionWithProgress = (next, stage, completed, total, message, patch) => {
      progressHighWater.set(stage, Math.max(progressHighWater.get(stage) || 0, completed))
      return writeRunLocked(key, runId, run => transitionRun(run, next, {
        now: now(),
        patch: {
          ...(patch ?? {}),
          progress: carryProgressLog(run.progress, stage, completed, total, message, now()),
        },
      }))
    }
    /**
     * Narration-only line: appends to `run.progress.log` without touching
     * completed/total, so it never fights the analyzer's own progress writes
     * (contract §1.5: each session completion and each model call is narrated).
     */
    const noteOnly = message => writeRunLocked(key, runId, run => {
      const progress = run.progress && typeof run.progress === 'object' ? run.progress : {}
      const stage = typeof progress.stage === 'string' && progress.stage ? progress.stage : 'snapshotting'
      const completed = Number.isInteger(progress.completed) ? progress.completed : 0
      const total = Number.isInteger(progress.total) ? progress.total : 0
      return {
        ...run,
        progress: carryProgressLog(progress, stage, completed, total, message, now()),
        updatedAt: now(),
      }
    })
    /**
     * Progress + token ledger in ONE persistence (§1.5): the model-call usage is
     * accumulated into `run.usage` alongside the narration line. Missing
     * provider counters add 0 and never fail the run.
     */
    const progressWithUsage = (stage, completed, total, note, usage) => writeRunLocked(key, runId, run => {
      const next = updateRunProgress(run, { stage, completed, total, note }, now())
      if (!usage || typeof usage !== 'object') return next
      const ledger = emptyRunUsage()
      accumulateRunUsage(ledger, run.usage && typeof run.usage === 'object' ? run.usage : {})
      accumulateRunUsage(ledger, usage)
      return { ...next, usage: ledger }
    })
    /**
     * Human-readable session label for the narration log (the client's title
     * when the batch carried one, else a stable ordinal). Never a bare
     * sessionId: the timeline is read by people. Titles are capped so the
     * 「仍缺 X 个会话，正在取：Y」tail survives the 200-char log-line bound.
     * @param {object[]} list run sessions
     * @param {number} index
     * @returns {string}
     */
    const sessionTitleOf = (list, index) => {
      const title = list?.[index]?.title
      const text = typeof title === 'string' && title.trim() !== ''
        ? title.trim()
        : `第 ${index + 1} 个会话`
      return text.length > 24 ? `${text.slice(0, 23)}…` : text
    }
    /**
     * Stage-1 candidates carrying code-commit evidence: a candidate whose
     * evidenceRefs resolve to a frozen material graded `commit` (spec §6.2).
     * Counts candidates, not refs, so the narration answers "how many rules
     * from this session have code behind them".
     * @param {object[]} candidates stage-1 candidates
     * @param {object[]} materials the session materials actually analysed
     * @returns {number}
     */
    const commitEvidenceCount = (candidates, materials) => {
      const grades = new Map()
      for (const material of Array.isArray(materials) ? materials : []) {
        if (!material || typeof material !== 'object') continue
        const grade = typeof material.grade === 'string' ? material.grade : ''
        if (!grade) continue
        for (const ref of [material.findingId, material.messageId]) {
          if (typeof ref === 'string' && ref !== '') grades.set(ref, grade)
        }
      }
      let count = 0
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const refs = Array.isArray(candidate?.evidenceRefs) ? candidate.evidenceRefs : []
        if (refs.some(ref => grades.get(ref) === 'commit')) count += 1
      }
      return count
    }
    const finishCanceled = async () => {
      await noteOnly('已取消：已停止模型调用，本次未写入任何文件').catch(() => {})
      return transitionLocked(key, runId, 'canceled')
    }
    try {
      let result = await transitionWithProgress(
        'snapshotting', 'snapshotting', 0, initialRun.sessions.length, '开始收集素材',
      )
      if (result.skipped) return
      if (isCancelled()) { await finishCanceled(); return }

      // snapshotting: read raw histories, select materials, freeze snapshot.
      // Local copies so a title derived from the `session/title` event can feed
      // the narration even when the batch payload carried bare session ids.
      const sessions = initialRun.sessions.map(session => ({ ...session }))
      const histories = []
      for (let i = 0; i < sessions.length; i += 1) {
        if (isCancelled()) { await finishCanceled(); return }
        const history = await readSessionHistory(ctx, { workspaceId, sessionId: sessions[i].sessionId }, sessionDeps())
        histories.push(history)
        if (typeof sessions[i].title !== 'string' || sessions[i].title.trim() === '') {
          const derivedTitle = sessionTitleFromEvents(history.events)
          if (derivedTitle) sessions[i].title = derivedTitle
        }
        await progressLocked(key, runId, {
          stage: 'snapshotting',
          completed: i + 1,
          total: sessions.length,
          note: `已读取会话 ${i + 1}/${sessions.length}「${sessionTitleOf(sessions, i)}」`
            + `：${Array.isArray(history?.events) ? history.events.length : 0} 条事件`,
        })
      }
      if (isCancelled()) { await finishCanceled(); return }
      const findings = []
      const commitTraces = []
      for (const session of sessions) {
        findings.push(...await store.listEntries(`session:${session.sessionId}`))
        commitTraces.push(...await store.listCommitTraces(`session:${session.sessionId}`))
      }
      const selected = selectMaterials({ findings, commitTraces, sessionTurns: histories, now: now() })
      const contentHashes = {}
      for (const material of selected.materials) {
        if (material && typeof material.messageId === 'string' && material.messageId !== '') {
          contentHashes[`${material.sessionId}:${material.messageId}`] =
            sha256Hex(typeof material.text === 'string' ? material.text : '', nodeCrypto)
        }
      }
      const snapshot = freezeSnapshot({
        takenAt: now(),
        materialCount: selected.materialCount,
        byGrade: selected.byGrade,
        contentHashes,
      })
      result = await writeRunLocked(key, runId, run => attachSnapshot(run, snapshot, now()))
      if (result.skipped) return
      await noteOnly(
        `素材已冻结：${selected.materialCount} 条（resolved ${selected.byGrade.resolved}`
        + ` / commit ${selected.byGrade.commit} / submitted ${selected.byGrade.submitted}）`,
      )
      if (isCancelled()) { await finishCanceled(); return }

      // Budget gate: failure fails the run WITHOUT any model call (§16.17).
      const materialTokens = selected.materials.reduce(
        (sum, material) => sum + (Number.isFinite(material?.tokens) ? material.tokens : 0), 0,
      )
      const budgetResult = computeBudget({ contextWindow: probe.contextWindow, materialTokens })
      if (!budgetResult.ok) {
        await noteOnly('预算不足，分析未开始（未发生任何模型调用）')
        await transitionLocked(key, runId, 'failed', { error: budgetResult.error })
        return
      }
      const truncated = truncateMaterials(selected.materials, budgetResult.maxTokens)
      const budget = { maxTokens: budgetResult.maxTokens, usedTokens: truncated.usedTokens, truncated: truncated.truncated }
      const keptMaterials = truncated.materials

      result = await transitionWithProgress(
        'analyzing',
        'stage1',
        0,
        sessions.length,
        `开始分析 ${sessions.length} 个会话的素材（模型 ${probe.model?.provider || '?'} / ${probe.model?.model || '?'}`
        + ` · 预算 ${budget.maxTokens} tokens${budget.truncated ? ' · 素材已截断' : ''}）`,
        { model: probe.model, budget },
      )
      if (result.skipped) return
      if (isCancelled()) { await finishCanceled(); return }

      // stage 1: per-session calls; materials pass through to stage 2 so the
      // analyzer can build per-session summaries (lead integration rule 1).
      const stage1Results = []
      for (let i = 0; i < sessions.length; i += 1) {
        if (isCancelled()) { await finishCanceled(); return }
        const sessionId = sessions[i].sessionId
        const sessionMaterials = keptMaterials.filter(material => material.sessionId === sessionId)
        const stage1 = await analyzerApi.runStage1({ sessionId, materials: sessionMaterials, budget, signal, onProgress: onProgress('stage1') })
        if (isCancelled()) { await finishCanceled(); return }
        if (!stage1 || stage1.ok !== true) {
          await noteOnly(
            `会话「${sessionTitleOf(sessions, i)}」分析失败：`
            + `${stage1?.error?.code || 'ANALYZER_INTERNAL'}，本次精炼已停止`,
          )
          await transitionLocked(key, runId, 'failed', {
            error: stage1?.error || { code: 'ANALYZER_INTERNAL', message: 'stage1 returned no result' },
          })
          return
        }
        const candidates = Array.isArray(stage1.candidates) ? stage1.candidates : []
        stage1Results.push({ sessionId, candidates, materials: sessionMaterials })
        // Result-type narration: what this session produced, how much of it has
        // code behind it, and what is still missing (contract §2.3). The last
        // session closes the loop with the batch total.
        const remaining = sessions.length - (i + 1)
        const totalCandidates = stage1Results.reduce((sum, entry) => sum + entry.candidates.length, 0)
        const message = remaining > 0
          ? `会话「${sessionTitleOf(sessions, i)}」：${candidates.length} 条候选，其中 `
            + `${commitEvidenceCount(candidates, sessionMaterials)} 条有代码提交证据；`
            + `仍缺 ${remaining} 个会话，正在取：${sessionTitleOf(sessions, i + 1)}`
          : `收齐 ${sessions.length} 个会话共 ${totalCandidates} 条候选，进入合并去重与冲突裁决`
        await progressWithUsage('stage1', i + 1, sessions.length, message, stage1.usage)
      }

      // stage 2: merge + conflicts + summaries; analyzer persists the plan
      // (including rawResponseRef) at the end of runStage2.
      if (isCancelled()) { await finishCanceled(); return }
      const candidateTotal = stage1Results.reduce((sum, entry) => sum + entry.candidates.length, 0)
      await progressLocked(key, runId, {
        stage: 'stage2',
        completed: 0,
        total: 1,
        note: `正在合并 ${candidateTotal} 条候选，去重并裁决冲突…`,
      })
      const navigation = readNavigation(dir, { fs, path })
      const fingerprints = await store.listDistillFingerprints(workspaceId)
      const targetSnippets = collectTargetSnippets(dir, stage1Results, { fs, path })
      const latestRun = await store.getDistillRun(runId)
      // Host-owned plan facts: the model drafts semantics, this callback hands
      // the analyzer the real disk state (existence + sha256) so `fileBaseHash`
      // is never model-invented. Path safety mirrors the write boundary.
      const resolveFileFacts = (file) => {
        if (!isAllowedDocPath(file)) return null
        try {
          if (hasSymlinkSegment(dir, file, { fs, path })) return { exists: false, fileBaseHash: null }
          const full = path.join(dir, file)
          if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
            return { exists: false, fileBaseHash: null }
          }
          const content = fs.readFileSync(full, 'utf8')
          return { exists: true, fileBaseHash: sha256Hex(content, nodeCrypto) }
        } catch {
          return null
        }
      }
      const stage2 = await analyzerApi.runStage2({
        run: latestRun || initialRun,
        stage1Results,
        navigation,
        fingerprints,
        targetSnippets,
        budget,
        signal,
        onProgress: onProgress('stage2'),
        resolveFileFacts,
      })
      if (isCancelled()) { await finishCanceled(); return }
      if (!stage2 || stage2.ok !== true) {
        await noteOnly(
          `变更计划生成失败：${stage2?.error?.code || 'ANALYZER_INTERNAL'}，本次精炼已停止`,
        )
        await transitionLocked(key, runId, 'failed', {
          error: stage2?.error || { code: 'ANALYZER_INTERNAL', message: 'stage2 returned no result' },
        })
        return
      }
      // Accept {plan, summaries} wrapper or a bare ChangePlan payload.
      const plan = stage2.plan && typeof stage2.plan === 'object'
        ? stage2.plan
        : (Array.isArray(stage2.targets) ? stage2 : null)
      const summaries = Array.isArray(stage2.summaries) ? stage2.summaries : []
      if (!plan) {
        await noteOnly('变更计划生成失败：模型没有返回可写回的变更')
        await transitionLocked(key, runId, 'failed', { error: { code: 'PLAN_INVALID', message: 'stage2 produced no ChangePlan' } })
        return
      }
      let persistedPlan = await store.getDistillPlan(runId)
      if (!persistedPlan) {
        persistedPlan = await store.putDistillPlan({ ...plan, runId })
      }
      const planTargets = Array.isArray(plan.targets) ? plan.targets : []
      const plannedChanges = planTargets
        .reduce((sum, target) => sum + (Array.isArray(target?.changes) ? target.changes.length : 0), 0)
      const unresolvedConflicts = (Array.isArray(plan.conflicts) ? plan.conflicts : [])
        .filter(conflict => conflict?.resolvedBy === 'unresolved').length
      await progressWithUsage(
        'stage2',
        1,
        1,
        `已合并为 ${planTargets.length} 个文件、${plannedChanges} 条变更（${unresolvedConflicts} 项未决冲突）`,
        stage2.usage,
      )

      result = await transitionWithProgress(
        'validating', 'validating', 0, 1, '开始静态校验', { summaries },
      )
      if (result.skipped) return
      if (isCancelled()) { await finishCanceled(); return }

      // validating: §9 surface collection + pure validation. Error checks
      // block apply later; they do not prevent readiness (spec §9/§10.2).
      let checks = []
      try {
        const surface = collectTargetSurface(dir, persistedPlan, navigation, { fs, path })
        checks = validatePlan(persistedPlan, surface).checks
      } catch (error) {
        await noteOnly(`静态校验失败：${error?.code || 'PLAN_INVALID'}，本次精炼已停止`)
        await transitionLocked(key, runId, 'failed', {
          error: { code: 'PLAN_INVALID', message: error?.message || String(error) },
        })
        return
      }
      // Read-modify-write: preserve rawResponseRef and every analyzer field.
      const currentPlan = await store.getDistillPlan(runId) || persistedPlan
      await store.putDistillPlan({ ...currentPlan, checks })
      // `checks[].level` (not `severity`) is the §9 contract; errors block apply
      // later but never prevent readiness, so both counts are narrated honestly.
      const errorCount = checks.filter(check => check && check.level === 'error').length
      const warnCount = checks.filter(check => check && check.level === 'warn').length
      await progressLocked(key, runId, {
        stage: 'validating',
        completed: 1,
        total: 1,
        note: `静态校验：${errorCount} 错误 / ${warnCount} 警告`,
      })
      // Final validating checkpoint: a cancel that arrived during surface
      // collection / validation must stop the run before ready (§4.2).
      if (isCancelled()) { await finishCanceled(); return }
      await writeRunLocked(key, runId, run => transitionRun(run, 'ready', {
        now: now(),
        patch: {
          planId: runId,
          progress: carryProgressLog(run.progress, 'validating', 1, 1, '计划已就绪，等待你确认', now()),
        },
      }))
    } catch (error) {
      // Cancel wins over any analyzer failure (lead integration rule 3).
      if (isCancelled()) {
        await finishCanceled().catch(() => {})
      } else {
        const code = error?.code || 'INTERNAL_ERROR'
        await noteOnly(`分析中断：${code}，本次精炼已停止`).catch(() => {})
        await transitionLocked(key, runId, 'failed', {
          error: { code, message: error?.message || String(error) },
        }).catch(() => {})
      }
    } finally {
      finishControl(control)
    }
  }

  function normalizeSessions(input) {
    if (!Array.isArray(input)) return null
    return input.map(item => (typeof item === 'string' ? { sessionId: item } : item))
  }

  /**
   * POST distill-run: probe → atomic single-batch create → background
   * executor. Probe failure returns before any run is persisted (§16.17).
   * @param {object} input { workspaceId, sessions, scope? }
   * @returns {Promise<object>} route result
   */
  async function startRun(input = {}) {
    let workspaceId
    try {
      workspaceId = assertDistillWorkspaceId(input.workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    const sessions = normalizeSessions(input.sessions)
    if (!sessions) {
      return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: 'sessions must be an array of 3~7 session ids' }
    }
    // Cheap input validation before any probe/recovery work; the authoritative
    // shape/uniqueness check still runs in createDistillRun inside the lock.
    if (sessions.length < MIN_BATCH_SESSIONS || sessions.length > MAX_BATCH_SESSIONS) {
      return { ok: false, status: 400, code: 'INVALID_BATCH', error: `sessions must contain ${MIN_BATCH_SESSIONS}~${MAX_BATCH_SESSIONS} entries` }
    }
    await recoverWorkspace(workspaceId)
    const probe = await analyzerApi.probeContextWindow()
    if (!probe || probe.ok !== true) {
      const error = probe?.error || { code: 'ANALYZER_UNAVAILABLE', message: 'analyzer probe failed' }
      return { ok: false, status: distillErrorStatus(error.code), code: error.code, error: error.message }
    }
    let locked
    try {
      locked = await lockKeyFor(workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    const created = await withWorkspaceLock(locked.key, async () => {
      const runs = await store.listDistillRuns(workspaceId)
      const active = getActiveRun(runs, workspaceId)
      // §12.5 rerun: an old READY plan is replaced (superseded), never
      // overwritten — the human's selections on it stay untouched but it can no
      // longer be applied. Any other non-terminal state still blocks creation.
      if (active && active.status !== 'ready') return { conflict: active }
      const runId = uuid()
      let run
      try {
        run = createDistillRun({ id: runId, workspaceId, sessions, scope: input.scope, now: now() })
      } catch (error) {
        return { invalid: error }
      }
      // Seed the wire-visible ledgers now (contract §1.5): the running view and
      // history read `progress.log` and `usage` from the first poll onward, even
      // before any model call happened.
      run = {
        ...run,
        usage: emptyRunUsage(),
        progress: carryProgressLog(
          run.progress,
          'snapshotting',
          0,
          run.sessions.length,
          `已创建精炼批次：${run.sessions.length} 个会话`,
          now(),
        ),
      }
      const supersededRunIds = []
      if (active && active.status === 'ready') {
        for (const candidate of runs.filter(item => item && item.status === 'ready')) {
          try {
            await store.putDistillRun(markRunSuperseded(candidate, runId, now()))
            supersededRunIds.push(candidate.id)
          } catch (error) {
            // A concurrent transition (or an old data shape) must surface as a
            // conflict instead of silently creating a second live plan.
            return { conflict: candidate, supersedeError: error }
          }
        }
      }
      return { run: await store.putDistillRun(run), supersededRunIds }
    })
    if (created.conflict) {
      return {
        ok: false,
        status: 409,
        code: DISTILL_LIFECYCLE_CODES.RUN_ALREADY_ACTIVE,
        error: 'workspace already has a non-terminal distillation run',
        activeRunId: created.conflict.id,
        runStatus: created.conflict.status,
        ...(created.supersedeError ? { supersedeError: created.supersedeError.message } : {}),
      }
    }
    if (created.invalid) return distillErrorResult(created.invalid)
    const promise = executeRun(created.run, { dir: locked.dir, key: locked.key, probe })
    executors.set(created.run.id, promise)
    promise.catch(() => {}).finally(() => executors.delete(created.run.id))
    return {
      ok: true,
      status: 200,
      run: created.run,
      ...(created.supersededRunIds?.length ? { supersededRunIds: created.supersededRunIds } : {}),
    }
  }

  /**
   * GET distill-run: ?id= polling (run + plan + lock derivation) or
   * ?workspaceId= list mode (runs newest first, each with plan, for refresh
   * recovery / history / window restore, spec §13.2).
   * @param {object} input { id?, workspaceId? }
   * @returns {Promise<object>}
   */
  async function getRun(input = {}) {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : ''
    if (id) {
      const found = await store.getDistillRun(id)
      if (!found) {
        return { ok: false, status: 404, code: DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, error: `run not found: ${id}` }
      }
      // Soft expiry hint is computed from the pre-recovery snapshot: the run
      // itself may be TTL-staled first, but the plan's 24h hint must survive.
      const planExpired = isPlanExpired(found, now())
      await recoverWorkspace(found.workspaceId)
      const run = withRunDefaults(await store.getDistillRun(id))
      const plan = await store.getDistillPlan(id)
      return { ok: true, status: 200, run, plan, planExpired, lock: deriveLockWindow(run, now()) }
    }
    if (workspaceId) {
      try {
        assertDistillWorkspaceId(workspaceId)
      } catch (error) {
        return distillErrorResult(error)
      }
      // Snapshot the expiry hint before recovery can TTL-stale an aged plan.
      const before = await store.listDistillRuns(workspaceId)
      const expiredById = new Map(before.map(run => [run.id, isPlanExpired(run, now())]))
      await recoverWorkspace(workspaceId)
      const runs = await store.listDistillRuns(workspaceId)
      const items = []
      for (const run of runs) {
        const plan = await store.getDistillPlan(run.id)
        items.push({
          ...withRunDefaults(run),
          plan,
          planExpired: expiredById.get(run.id) ?? isPlanExpired(run, now()),
          lock: deriveLockWindow(run, now()),
        })
      }
      return { ok: true, status: 200, runs: items }
    }
    return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: 'id or workspaceId is required' }
  }

  /**
   * POST distill-cancel (spec §4.2 / §11.2.7 / §13.2). Active controls are
   * arbitrated by synchronous memory CAS without the workspace lock; runs
   * without a live control are re-read under the lock (applying recovers
   * first). Response `status` is the spec's cancel status string; the HTTP
   * layer serializes 200 for ok results (jsonResponse typeof guard).
   * @param {object} input { runId }
   * @returns {Promise<object>}
   */
  async function cancelRun(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) {
      return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: 'runId is required' }
    }
    purgeControls()
    const control = controls.get(runId)
    if (control && control.state !== 'finished') {
      // Synchronous arbitration: no await between state read and CAS.
      if (control.state === 'committing') {
        const persisted = await store.getDistillRun(runId)
        return { ok: true, status: 'too_late', tooLate: true, runStatus: persisted?.status ?? 'applying' }
      }
      if (control.state === 'active') {
        casControl(control, 'active', 'cancelRequested')
        control.abort.abort()
      }
      const persisted = await store.getDistillRun(runId)
      return { ok: true, status: 'cancelRequested', runStatus: persisted?.status ?? 'analyzing' }
    }
    const run = await store.getDistillRun(runId)
    if (!run) {
      return { ok: false, status: 404, code: DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, error: `run not found: ${runId}` }
    }
    const decision = resolveCancelByStatus(run)
    if (decision.outcome === 'idempotent') {
      return { ok: true, status: 'canceled', runStatus: 'canceled' }
    }
    if (decision.outcome === 'too-late') {
      return { ok: true, status: 'too_late', tooLate: true, runStatus: run.status }
    }
    if (decision.outcome === 'recover-first') {
      const outcome = await recoverApplyingRun(run)
      const after = await store.getDistillRun(runId)
      if (after?.status === 'canceled') return { ok: true, status: 'canceled', runStatus: 'canceled' }
      if (after?.status === 'failed') {
        return { ok: true, status: 'too_late', tooLate: true, runStatus: 'failed', error: after.error ?? undefined }
      }
      return {
        ok: true,
        status: 'too_late',
        tooLate: true,
        runStatus: after?.status ?? 'applying',
        recoveryPending: true,
        recoveryReason: outcome.reason,
      }
    }
    // Direct cancel of a non-active non-terminal run: lock + re-read + guard.
    let locked
    try {
      locked = await lockKeyFor(run.workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    const result = await transitionLocked(locked.key, runId, 'canceled')
    if (result.skipped) {
      const after = await store.getDistillRun(runId)
      if (after?.status === 'canceled') return { ok: true, status: 'canceled', runStatus: 'canceled' }
      return { ok: true, status: 'too_late', tooLate: true, runStatus: after?.status ?? run.status }
    }
    return { ok: true, status: 'canceled', runStatus: 'canceled' }
  }

  /**
   * GET distill-docs: navigation section + allowed roots (spec §8/§13.2).
   * @param {object} input { workspaceId }
   * @returns {Promise<object>}
   */
  async function readDocs(input = {}) {
    let workspaceId
    try {
      workspaceId = assertDistillWorkspaceId(input.workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    await recoverWorkspace(workspaceId)
    let locked
    try {
      locked = await lockKeyFor(workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    const navigation = readNavigation(locked.dir, { fs, path })
    return {
      ok: true,
      status: 200,
      navigation,
      allowedRoots: navigation.mode === 'tree' ? ['AGENTS.md', 'README.md', 'docs/'] : ['AGENTS.md', 'README.md'],
    }
  }

  /**
   * GET distill-baseline: multi-file {content, baseHash} (replaces the old
   * single-file spec-baseline, spec §13.2). Missing files report exists:false
   * with null hash (create targets); boundary violations reject the request.
   * @param {object} input { workspaceId, files: string[]|string }
   * @returns {Promise<object>}
   */
  async function readBaseline(input = {}) {
    let workspaceId
    try {
      workspaceId = assertDistillWorkspaceId(input.workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    const rawFiles = Array.isArray(input.files) ? input.files : (typeof input.files === 'string' ? input.files.split(',') : [])
    const files = rawFiles.map(file => (typeof file === 'string' ? file.trim() : '')).filter(Boolean)
    if (files.length === 0) {
      return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: 'files is required (comma-separated or array)' }
    }
    if (files.length > BASELINE_MAX_FILES) {
      return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: `too many files (max ${BASELINE_MAX_FILES})` }
    }
    await recoverWorkspace(workspaceId)
    let locked
    try {
      locked = await lockKeyFor(workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    const out = []
    for (const file of files) {
      if (!isAllowedDocPath(file) || hasSymlinkSegment(locked.dir, file, { fs, path })) {
        return { ok: false, status: 403, code: DISTILL_LIFECYCLE_CODES.PATH_REJECTED, error: `path rejected: ${file}`, file }
      }
      const full = path.join(locked.dir, file)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          const content = fs.readFileSync(full, 'utf8')
          out.push({ file, exists: true, content, baseHash: sha256Hex(content, nodeCrypto) })
        } else {
          out.push({ file, exists: false, content: null, baseHash: null })
        }
      } catch (error) {
        return { ok: false, status: 500, code: 'READ_FAILED', error: error?.message || String(error), file }
      }
    }
    return { ok: true, status: 200, files: out }
  }

  /**
   * GET distill-estimate: read-only pre-flight for the batch card grid
   * (contract §1.1). NEVER writes, NEVER takes the workspace lock. Material
   * selection, token demand and the budget all reuse the pure domain helpers
   * (`selectMaterials` / `computeBudget` / `truncateMaterials`) so the estimate
   * cannot drift from what the run will actually do.
   *
   * Degradations are explicit instead of fatal: a session whose history cannot
   * be read keeps its store-side counts with `readable: false`, and a model
   * whose context window cannot be probed yields `model: null`,
   * `contextWindow: null` with the token totals still reported.
   *
   * @param {object} input { workspaceId, sessions: string[]|string }
   * @returns {Promise<object>} route result `{ ok, estimate }`
   */
  async function estimate(input = {}) {
    let workspaceId
    try {
      workspaceId = assertDistillWorkspaceId(input.workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    const rawSessions = Array.isArray(input.sessions)
      ? input.sessions
      : (typeof input.sessions === 'string' ? input.sessions.split(',') : [])
    const sessionIds = [...new Set(
      rawSessions.map(item => (typeof item === 'string' ? item.trim() : '')).filter(Boolean),
    )]
    if (sessionIds.length === 0) {
      return {
        ok: false,
        status: 400,
        code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST,
        error: 'sessions is required (comma-separated or array)',
      }
    }
    if (sessionIds.length > MAX_BATCH_SESSIONS) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_BATCH',
        error: `too many sessions (max ${MAX_BATCH_SESSIONS})`,
      }
    }

    // Model probe is optional: a missing model must not fail the estimate.
    const probe = await analyzerApi.probeContextWindow()
    const probed = probe && probe.ok === true ? probe : null
    const contextWindow = probed && Number.isFinite(probed.contextWindow) ? probed.contextWindow : null
    const model = probed && typeof probed.model?.model === 'string' ? probed.model.model : null
    const provider = probed && typeof probed.model?.provider === 'string' ? probed.model.provider : null

    const sessions = []
    const histories = []
    const findings = []
    const commitTraces = []
    for (const sessionId of sessionIds) {
      const entries = await store.listEntries(`session:${sessionId}`)
      const promptLogs = await store.listPromptLog(`session:${sessionId}`)
      const row = {
        sessionId,
        title: null,
        findings: (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry.id === 'string').length,
        promptLogs: Array.isArray(promptLogs) ? promptLogs.length : 0,
        readable: true,
      }
      try {
        const { snapshot } = await readWorkspaceSession(ctx, { workspaceId, sessionId }, sessionDeps())
        row.title = sessionTitleFromEvents(snapshot.events)
        histories.push({
          sessionId,
          archived: isSessionArchived(registry(), sessionId),
          events: snapshot.events,
        })
        findings.push(...(Array.isArray(entries) ? entries : []))
        commitTraces.push(...await store.listCommitTraces(`session:${sessionId}`))
      } catch {
        // Honest degradation: the row keeps what the store knows, the timeline
        // pages can still render the selection. The run itself will refuse this
        // session, so the estimate never pretends it is analysable.
        row.readable = false
      }
      sessions.push(row)
    }

    const selected = selectMaterials({ findings, commitTraces, sessionTurns: histories, now: now() })
    const totalMaterials = selected.materialCount
    const totalTokens = selected.materials.reduce(
      (sum, material) => sum + (Number.isFinite(material?.tokens) ? material.tokens : 0), 0,
    )
    let budget
    if (contextWindow !== null) {
      const computed = computeBudget({ contextWindow, materialTokens: totalTokens })
      if (computed.ok) {
        const truncated = truncateMaterials(selected.materials, computed.maxTokens)
        budget = { maxTokens: computed.maxTokens, usedTokens: truncated.usedTokens, truncated: truncated.truncated }
      }
    }
    if (!budget) {
      // No trustworthy window: report the demand, never invent a maxTokens.
      budget = { maxTokens: null, usedTokens: totalTokens, truncated: false }
    }

    return {
      ok: true,
      status: 200,
      estimate: {
        sessions,
        totalMaterials,
        totalTokens,
        contextWindow,
        model,
        provider,
        budget,
        // One stage-1 call per readable session, one stage-2 call per batch.
        stage1Calls: histories.length,
        stage2Calls: histories.length > 0 && totalMaterials > 0 ? 1 : 0,
      },
    }
  }

  /**
   * POST distill-delete: remove a FINISHED run and its plan row (contract §1.2).
   * Terminal statuses only (`applied|failed|canceled|stale|superseded`);
   * `distillFingerprints` are long-lived idempotency assets and are deliberately
   * kept, so the same conclusion cannot be proposed twice later.
   * @param {object} input { runId }
   * @returns {Promise<object>}
   */
  async function deleteRun(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, 'runId is required')
    }
    const run = await store.getDistillRun(runId)
    if (!run) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
    }
    if (!isTerminalRunStatus(run.status)) {
      return distillRouteError('RUN_NOT_READY', `run is not finished yet (${run.status})`, {
        runId,
        runStatus: run.status,
      })
    }
    if (typeof store.deleteDistillRun !== 'function') {
      return distillRouteError('DELETE_FAILED', 'host store cannot delete distill runs')
    }
    const removedRun = await store.deleteDistillRun(runId)
    if (!removedRun) {
      return distillRouteError('DELETE_FAILED', `run ${runId} was not deleted`)
    }
    const removedPlan = typeof store.deleteDistillPlan === 'function'
      ? await store.deleteDistillPlan(runId)
      : false
    return {
      ok: true,
      status: 200,
      runId,
      runStatus: run.status,
      deletedPlan: removedPlan === true,
      fingerprintsKept: true,
    }
  }

  /**
   * POST distill-park (park / unpark a READY plan, UX contract §1.6).
   *
   * - `parked:true` records `run.parked = true` and bumps `updatedAt`; the plan
   *   row is kept and `deriveLockWindow` immediately reports the workspace as
   *   unlocked (`reason:'parked'`).
   * - `parked:false` clears the flag and resets the ready TTL
   *   (`lockWindow.expiresAt = now + lockTtlMs`), so re-entering the
   *   confirmation page re-locks the workspace like a fresh ready run.
   *
   * Only `ready` may be (un)parked; every other status answers
   * `PARK_NOT_ALLOWED` (HTTP 200, business error). The write goes through the
   * workspace lock with a re-read guard and is verified by reading the row back
   * from the store (which itself verifies the disk write).
   *
   * @param {object} input { runId, parked?: boolean } — `parked:false` unparks,
   *   everything else parks.
   * @returns {Promise<object>}
   */
  async function parkRun(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, 'runId is required')
    }
    const parked = input.parked !== false
    const run = await store.getDistillRun(runId)
    if (!run) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
    }
    if (run.status !== 'ready') {
      return distillRouteError('PARK_NOT_ALLOWED', `run is not ready (${run.status})`, {
        runId,
        runStatus: run.status,
      })
    }
    let locked
    try {
      locked = await lockKeyFor(run.workspaceId)
    } catch (error) {
      return distillRouteError(error?.code || 'WORKSPACE_UNAVAILABLE', error?.message || String(error), { runId })
    }
    try {
      return await withWorkspaceLock(locked.key, async () => {
        const current = await store.getDistillRun(runId)
        if (!current) {
          return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
        }
        if (current.status !== 'ready') {
          return distillRouteError('PARK_NOT_ALLOWED', `run is not ready (${current.status})`, {
            runId,
            runStatus: current.status,
          })
        }
        const at = now()
        const startedAt = Number.isFinite(current.lockWindow?.startedAt)
          ? current.lockWindow.startedAt
          : at
        const next = parked
          ? { ...current, parked: true, updatedAt: at }
          : {
            ...current,
            parked: false,
            updatedAt: at,
            // Re-lock: the ready TTL restarts from this explicit revisit.
            lockWindow: { startedAt, expiresAt: at + lockTtlMs },
          }
        await store.putDistillRun(next)
        const readBack = await store.getDistillRun(runId)
        const expiresOk = parked || readBack?.lockWindow?.expiresAt === at + lockTtlMs
        if (!readBack || readBack.status !== 'ready'
          || (readBack.parked === true) !== parked
          || readBack.updatedAt !== at
          || !expiresOk) {
          return distillRouteError('PARK_WRITE_FAILED', 'park state was not persisted', { runId })
        }
        const lock = deriveLockWindow(readBack, at)
        return {
          ok: true,
          status: 200,
          parked,
          // `locked` rides on the run as well so the client can render the
          // maintenance-window state without recomputing the derivation.
          run: { ...withRunDefaults(readBack), locked: lock.locked },
          lock,
        }
      })
    } catch (error) {
      return distillErrorResult(error)
    }
  }

  /** Run statuses that may be abandoned (write-back never started). */
  const ABANDONABLE_RUN_STATUSES = new Set(['ready', 'failed', 'canceled', 'stale', 'superseded', 'queued'])

  /**
   * POST distill-abandon (UX contract §1.7): delete this distillation attempt
   * (run row + `distillPlans['run:<id>']`) without writing anything back.
   *
   * Allowed: `ready|failed|canceled|stale|superseded|queued`. `applying` and
   * `applied` are rejected with `ABANDON_NOT_ALLOWED` (HTTP 200 business
   * error): an in-flight write-back owns the transaction and must finish or
   * fail through apply recovery, never disappear. Idempotency fingerprints are
   * long-lived audit assets and are deliberately kept, like distill-delete.
   *
   * @param {object} input { runId }
   * @returns {Promise<object>}
   */
  async function abandonRun(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, 'runId is required')
    }
    const run = await store.getDistillRun(runId)
    if (!run) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
    }
    if (!ABANDONABLE_RUN_STATUSES.has(run.status)) {
      return distillRouteError('ABANDON_NOT_ALLOWED', `run cannot be abandoned (${run.status})`, {
        runId,
        runStatus: run.status,
      })
    }
    if (typeof store.deleteDistillRun !== 'function') {
      return distillRouteError('DELETE_FAILED', 'host store cannot delete distill runs')
    }
    let locked
    try {
      locked = await lockKeyFor(run.workspaceId)
    } catch (error) {
      return distillRouteError(error?.code || 'WORKSPACE_UNAVAILABLE', error?.message || String(error), { runId })
    }
    try {
      return await withWorkspaceLock(locked.key, async () => {
        // Re-read under the lock: the run may have entered `applying` since the
        // guard above, and deleting a live transaction is never allowed.
        const current = await store.getDistillRun(runId)
        if (!current) {
          return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
        }
        if (!ABANDONABLE_RUN_STATUSES.has(current.status)) {
          return distillRouteError('ABANDON_NOT_ALLOWED', `run cannot be abandoned (${current.status})`, {
            runId,
            runStatus: current.status,
          })
        }
        const removed = await store.deleteDistillRun(runId)
        if (!removed) {
          return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
        }
        const removedPlan = typeof store.deleteDistillPlan === 'function'
          ? await store.deleteDistillPlan(runId)
          : false
        // Removing the non-terminal run row frees this workspace's maintenance
        // window; the response states it explicitly.
        return {
          ok: true,
          status: 200,
          deleted: true,
          runId,
          runStatus: current.status,
          deletedPlan: removedPlan === true,
          fingerprintsKept: true,
          lock: { locked: false, reason: 'abandoned', expiresAt: null },
        }
      })
    } catch (error) {
      return distillErrorResult(error)
    }
  }

  /**
   * POST distill-review: persist the human review marks of a READY plan
   * (contract §1.3). `ignored` = 暂不采纳 (kept in the plan, excluded from
   * apply); `reviewed` = 人工复核过的条目. Unknown change ids are filtered out
   * instead of failing the request. The write goes through the workspace lock
   * and is verified by re-reading the plan row.
   * @param {object} input { runId, ignoredChangeIds, reviewedChangeIds }
   * @returns {Promise<object>}
   */
  async function reviewPlan(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, 'runId is required')
    }
    const run = await store.getDistillRun(runId)
    if (!run) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
    }
    if (run.status !== 'ready') {
      return distillRouteError('REVIEW_NOT_ALLOWED', `run is not ready (${run.status})`, {
        runId,
        runStatus: run.status,
      })
    }
    let locked
    try {
      locked = await lockKeyFor(run.workspaceId)
    } catch (error) {
      return distillRouteError(error?.code || 'WORKSPACE_UNAVAILABLE', error?.message || String(error), { runId })
    }
    try {
      return await withWorkspaceLock(locked.key, async () => {
        const plan = await store.getDistillPlan(runId)
        if (!plan) {
          return distillRouteError(DISTILL_APPLY_CODES.PLAN_MISSING, `no persisted plan for run ${runId}`, { runId })
        }
        const knownIds = new Set()
        for (const target of Array.isArray(plan.targets) ? plan.targets : []) {
          for (const change of Array.isArray(target?.changes) ? target.changes : []) {
            if (change && typeof change.id === 'string' && change.id !== '') knownIds.add(change.id)
          }
        }
        const pick = value => [...new Set(
          (Array.isArray(value) ? value : [])
            .filter(id => typeof id === 'string' && knownIds.has(id)),
        )]
        const review = {
          ignoredChangeIds: pick(input.ignoredChangeIds),
          reviewedChangeIds: pick(input.reviewedChangeIds),
          at: now(),
        }
        await store.putDistillPlan({ ...plan, review })
        const readBack = await store.getDistillPlan(runId)
        if (!readBack || !readBack.review || readBack.review.at !== review.at) {
          return distillRouteError('REVIEW_WRITE_FAILED', 'plan review was not persisted', { runId })
        }
        return { ok: true, status: 200, review: readBack.review }
      })
    } catch (error) {
      return distillErrorResult(error)
    }
  }

  /**
   * POST distill-rebase: deterministic re-anchoring of one drifted file
   * (contract §1.4). **No model call.** `apply:false` previews the disk state
   * (current hash + per-change section text + already-present detection);
   * `apply:true` writes the current hash into `target.fileBaseHash` and marks
   * already-present changes `skipReason:'already-present'` so a later
   * distill-apply excludes them while keeping the human's selection untouched.
   * The run stays `ready`; the write path stays CAS + backup + read-back.
   * @param {object} input { runId, filePath, apply }
   * @returns {Promise<object>}
   */
  async function rebasePlan(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, 'runId is required')
    }
    const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : ''
    if (!filePath) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, 'filePath is required')
    }
    const run = await store.getDistillRun(runId)
    if (!run) {
      return distillRouteError(DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, `run not found: ${runId}`, { runId })
    }
    if (run.status !== 'ready') {
      return distillRouteError(DISTILL_APPLY_CODES.RUN_NOT_READY, `run is not ready (${run.status})`, {
        runId,
        runStatus: run.status,
      })
    }
    let locked
    try {
      locked = await lockKeyFor(run.workspaceId)
    } catch (error) {
      return distillRouteError(error?.code || 'WORKSPACE_UNAVAILABLE', error?.message || String(error), { runId })
    }
    // Preview reads under the lock too: the hashes it reports must be the ones
    // an immediately following apply would see (contract §1.4 determinism).
    try {
      return await withWorkspaceLock(locked.key, async () => {
        const plan = await store.getDistillPlan(runId)
        if (!plan) {
          return distillRouteError(DISTILL_APPLY_CODES.PLAN_MISSING, `no persisted plan for run ${runId}`, { runId })
        }
        const targets = (Array.isArray(plan.targets) ? plan.targets : []).filter(target => target && typeof target === 'object')
        const target = targets.find(item => item.file === filePath)
        if (!target) {
          return distillRouteError(
            DISTILL_LIFECYCLE_CODES.INVALID_REQUEST,
            `file is not part of this plan: ${filePath}`,
            { runId, filePath },
          )
        }
        if (!isAllowedDocPath(filePath) || hasSymlinkSegment(locked.dir, filePath, { fs, path })) {
          return distillRouteError(DISTILL_LIFECYCLE_CODES.PATH_REJECTED, `path rejected: ${filePath}`, { runId, filePath })
        }
        const disk = readDiskFile(path.join(locked.dir, filePath), fs)
        const planHash = typeof target.fileBaseHash === 'string' ? target.fileBaseHash : null
        if (!disk.exists) {
          return distillRouteError(
            'REBASE_TARGET_MISSING',
            `target file no longer exists: ${filePath}`,
            { runId, filePath, planHash, currentHash: disk.hash },
          )
        }
        const currentHash = disk.hash
        const currentNormalized = normalizeForFingerprint(disk.content)
        const isPresent = (change) => {
          const text = normalizeForFingerprint(
            typeof change?.proposedText === 'string' ? change.proposedText : '',
          ).trim()
          return text !== '' && currentNormalized.includes(text)
        }
        const changes = (Array.isArray(target.changes) ? target.changes : [])
          .filter(change => change && typeof change.id === 'string')
        const alreadyApplied = []
        const previews = []
        for (const change of changes) {
          const present = isPresent(change)
          if (present) alreadyApplied.push({ changeId: change.id, reason: 'already-present' })
          const anchor = typeof change.sectionAnchor === 'string' && change.sectionAnchor !== ''
            ? change.sectionAnchor
            : null
          const currentText = sectionTextOf(disk.content, anchor)
          previews.push({
            changeId: change.id,
            anchor,
            proposedText: typeof change.proposedText === 'string' ? change.proposedText : '',
            currentText,
            anchorFound: anchor ? currentText !== '' : true,
            alreadyPresent: present,
          })
        }
        // A create target whose file now exists can only be re-anchored when the
        // human's content is already on disk; otherwise the baseline cannot be
        // updated without silently overwriting someone else's file.
        let canReanchor = true
        let reason = null
        if (target.action === 'create') {
          if (alreadyApplied.length === changes.length) {
            canReanchor = true
            reason = 'create-target-exists-already-present'
          } else {
            canReanchor = false
            reason = 'create-target-exists'
          }
        } else if (target.action !== 'update') {
          canReanchor = false
          reason = 'unsupported-action'
        } else if (planHash === currentHash) {
          reason = 'already-aligned'
        } else {
          reason = 'baseline-drift'
        }
        const rebase = {
          filePath,
          planHash,
          currentHash,
          canReanchor,
          reason,
          alreadyApplied,
          previews,
        }
        if (input.apply !== true) {
          return { ok: true, status: 200, rebase }
        }
        if (!canReanchor) {
          return distillRouteError(
            'REBASE_NOT_POSSIBLE',
            `target cannot be re-anchored (${reason})`,
            { runId, filePath, rebase },
          )
        }
        // apply:true — deterministic plan edit only. Nothing on disk is written.
        const appliedIds = new Set(alreadyApplied.map(item => item.changeId))
        const nextTargets = targets.map((item) => {
          if (item.file !== filePath) return item
          const nextChanges = (Array.isArray(item.changes) ? item.changes : []).map((change) => {
            const next = { ...change }
            if (appliedIds.has(change.id)) next.skipReason = 'already-present'
            else if (next.skipReason === 'already-present') delete next.skipReason
            return next
          })
          return {
            ...item,
            action: item.action === 'create' ? 'update' : item.action,
            fileBaseHash: currentHash,
            changes: nextChanges,
          }
        })
        await store.putDistillPlan({ ...plan, targets: nextTargets })
        const readBack = await store.getDistillPlan(runId)
        const readBackTarget = (Array.isArray(readBack?.targets) ? readBack.targets : [])
          .find(item => item && item.file === filePath)
        const readBackOk = Boolean(readBackTarget)
          && readBackTarget.fileBaseHash === currentHash
          && (Array.isArray(readBackTarget.changes) ? readBackTarget.changes : [])
            .filter(change => appliedIds.has(change.id))
            .every(change => change.skipReason === 'already-present')
        if (!readBackOk) {
          return distillRouteError('REBASE_WRITE_FAILED', 'plan baseline was not persisted', { runId, filePath })
        }
        return { ok: true, status: 200, plan: readBack, rebase }
      })
    } catch (error) {
      return distillErrorResult(error)
    }
  }

  return {
    startRun,
    getRun,
    cancelRun,
    readDocs,
    readBaseline,
    estimate,
    deleteRun,
    parkRun,
    abandonRun,
    reviewPlan,
    rebasePlan,
    recoverWorkspace,
    registerApplyRecovery,
    /** Inspection for Task 2.5 (committing CAS) and tests. */
    getRunControl: (runId) => controls.get(runId) ?? null,
    /** Synchronous CAS helper for the apply commit point (Task 2.5). */
    casRunControl: (runId, from, to) => casControl(controls.get(runId), from, to),
    /**
     * Task 2.5: (re-)register an active RunControl for the apply phase. The
     * analysis executor's control is already `finished` by the time a ready
     * run is applied; cancel arbitration and the committing CAS need a live
     * `active` control in the SAME map cancelRun reads.
     */
    registerRunControl: (runId, workspaceId) => registerControl(runId, workspaceId),
    /** Task 2.5: mark the apply RunControl finished (late cancels → too_late). */
    finishRunControl: (runId) => finishControl(controls.get(runId)),
    /** Await the background executor of a run (tests; resolves when absent). */
    awaitRun: (runId) => executors.get(runId) ?? Promise.resolve(),
  }
}

/* ------------------------------------------------------------------ *
 * Section 5 — Task 2.5: multi-file CAS apply transaction (spec §11)
 *
 * One withWorkspaceLock(realpath) acquisition covers the whole transaction:
 * single-batch check → rationaleEdits pre-write → §9 re-validation → §8.4
 * synthesis → run→applying + full tx → per-file currentFile-first writes →
 * read-back → committing CAS → fingerprint IDs-then-rows → applied.
 * Failure rolls back currentFile-first + done-reverse with double-hash
 * idempotence; conflict scenes (RECOVERY_CONFLICT / BACKUP_CORRUPT /
 * BACKUP_MISSING) preserve tx + backups and never claim rollback.
 * The lazy-recovery handler is registered by the wiring layer through
 * lifecycle.registerApplyRecovery(apply.recoverApplying) and is invoked
 * OUTSIDE the workspace lock (it takes its own lock + re-read + guard).
 * ------------------------------------------------------------------ */

/** Error codes introduced by the apply transaction (spec §13.3). */
export const DISTILL_APPLY_CODES = Object.freeze({
  CAS_CONFLICT: 'CAS_CONFLICT',
  RECOVERY_CONFLICT: 'RECOVERY_CONFLICT',
  BACKUP_CORRUPT: 'BACKUP_CORRUPT',
  BACKUP_MISSING: 'BACKUP_MISSING',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  RUN_NOT_READY: 'RUN_NOT_READY',
  PLAN_MISSING: 'PLAN_MISSING',
  APPLY_INTERRUPTED: 'APPLY_INTERRUPTED',
  CANCELED: 'CANCELED',
  READ_BACK_FAILED: 'READ_BACK_FAILED',
})

const APPLY_MAX_BACKUP_SUFFIX = 1000

/** Internal signal: cancel observed at a file boundary (spec §11.2.7). */
class ApplyCanceledError extends Error {
  constructor() {
    super('apply canceled at file boundary')
    this.name = 'ApplyCanceledError'
  }
}

function defaultBackupsRoot(path) {
  return path.join(nodeOs.homedir(), '.dsh', 'storages', 'punch_desk', 'backups')
}

/**
 * §8.3.7 backup directory: backups/<encoded-basename>-<workspaceId short hash>/.
 * The workspace hash keeps same-named workspaces from overwriting each other.
 */
function backupDirFor(backupsRoot, workspaceDir, workspaceId, path) {
  const base = encodeURIComponent(path.basename(workspaceDir))
  const short = sha256Hex(workspaceId, nodeCrypto).slice(0, 8)
  return path.join(backupsRoot, `${base}-${short}`)
}

/**
 * Read a disk file with its SHA-256. Missing/non-file → exists:false; real
 * read errors propagate (never silently treated as "missing" for CAS).
 */
function readDiskFile(full, fs) {
  if (!fs.existsSync(full)) return { exists: false, content: null, hash: null }
  if (!fs.statSync(full).isFile()) return { exists: false, content: null, hash: null }
  const content = fs.readFileSync(full, 'utf8')
  return { exists: true, content, hash: sha256Hex(content, nodeCrypto) }
}

/**
 * Atomic replacement: write a `.tmp-` sibling then rename over the target.
 * The `.tmp-` basename prefix is the recovery scan convention (Task 2.4).
 */
function atomicWriteFile(full, content, { fs, path, uuid }) {
  const tmp = path.join(path.dirname(full), `.tmp-${uuid()}`)
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.renameSync(tmp, full)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* residue is swept by recovery */ }
    throw error
  }
}

/**
 * Atomic no-clobber create (§11.2): temp file + hard link into place. The
 * link fails EEXIST when the target appeared after analysis — never overwrite.
 */
function createFileNoClobber(full, content, { fs, path, uuid }) {
  const tmp = path.join(path.dirname(full), `.tmp-${uuid()}`)
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    fs.linkSync(tmp, full)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* residue is swept by recovery */ }
    if (error && error.code === 'EEXIST') {
      throw new DistillHostError(DISTILL_APPLY_CODES.CAS_CONFLICT, `create target already exists: ${full}`, {
        details: { file: full },
      })
    }
    throw error
  }
  try { fs.unlinkSync(tmp) } catch { /* residue is swept by recovery */ }
}

/** §8.3.7 unique reversible backup name: <ts>-<encodeURIComponent(relPath)>. */
function uniqueBackupPath(dir, ts, file, fs, path) {
  const base = `${ts}-${encodeURIComponent(file)}`
  let candidate = path.join(dir, base)
  let suffix = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${suffix}`)
    suffix += 1
    if (suffix > APPLY_MAX_BACKUP_SUFFIX) {
      throw new DistillHostError(DISTILL_APPLY_CODES.BACKUP_CORRUPT, 'backup name space exhausted')
    }
  }
  return candidate
}

/**
 * Double-hash idempotent rollback (§11.2.5/6): currentFile first, then done
 * in reverse. update: target==baseHash → already restored; backup must hash
 * to baseHash; target==newHash → restore from backup; anything else is an
 * external change (RECOVERY_CONFLICT). Missing backup + target==newHash →
 * BACKUP_MISSING (never delete the target). create: unlink only when the
 * target hashes to newHash; missing → already restored; else conflict.
 * @returns {{ rolledBack: boolean, conflict?: { code: string, message: string, targets: string[], backupPath?: string } }}
 */
function rollbackTxFiles(tx, workspaceDir, { fs, path, uuid }) {
  const items = []
  if (tx.currentFile) items.push(tx.currentFile)
  const done = Array.isArray(tx.done) ? tx.done : []
  for (let i = done.length - 1; i >= 0; i -= 1) items.push(done[i])
  const conflict = (code, message, item, backupPath) => ({
    rolledBack: false,
    conflict: { code, message, targets: [item.file], ...(backupPath ? { backupPath } : {}) },
  })
  for (const item of items) {
    const full = path.join(workspaceDir, item.file)
    const target = readDiskFile(full, fs)
    if (item.action === 'create') {
      if (!target.exists) continue
      if (target.hash === item.newHash) { fs.unlinkSync(full); continue }
      return conflict(DISTILL_APPLY_CODES.RECOVERY_CONFLICT, `create target changed externally: ${item.file}`, item)
    }
    if (target.exists && target.hash === item.baseHash) continue
    const backup = item.backupPath ? readDiskFile(item.backupPath, fs) : { exists: false }
    if (!backup.exists) {
      if (target.exists && target.hash === item.newHash) {
        return conflict(DISTILL_APPLY_CODES.BACKUP_MISSING, `backup missing while target holds new content: ${item.file}`, item, item.backupPath)
      }
      return conflict(DISTILL_APPLY_CODES.RECOVERY_CONFLICT, `update target changed externally and no backup: ${item.file}`, item, item.backupPath)
    }
    if (backup.hash !== item.baseHash) {
      return conflict(DISTILL_APPLY_CODES.BACKUP_CORRUPT, `backup hash does not match baseHash: ${item.file}`, item, item.backupPath)
    }
    if (!target.exists) {
      return conflict(DISTILL_APPLY_CODES.RECOVERY_CONFLICT, `update target disappeared: ${item.file}`, item, item.backupPath)
    }
    if (target.hash !== item.newHash) {
      return conflict(DISTILL_APPLY_CODES.RECOVERY_CONFLICT, `update target changed externally: ${item.file}`, item, item.backupPath)
    }
    atomicWriteFile(full, backup.content, { fs, path, uuid })
  }
  return { rolledBack: true }
}

/**
 * Create the apply transaction engine (Task 2.5). Consumes the Task 2.4
 * lifecycle for RunControl arbitration and recovery-hook registration; all
 * file content synthesis/validation stays in the pure domain (D19).
 *
 * @param {object} options
 * @param {object} options.lifecycle createDistillLifecycle output
 * @param {object} options.store Host DeskStore (distill buckets)
 * @param {object} [options.ctx] Host Cordis context (optional services via ctx.get)
 * @param {object} [options.workspaceRegistry] Override (tests)
 * @param {Array<object>} [options.workspaces] Explicit workspace list (tests)
 * @param {() => number} [options.now]
 * @param {() => string} [options.uuid]
 * @param {object} [options.fs]
 * @param {object} [options.path]
 * @param {string} [options.backupsRoot] Override backup root (tests)
 * @returns {{ applyPlan: (input: object) => Promise<object>, recoverApplying: (input: object) => Promise<ApplyRecoveryResult> }}
 */
export function createDistillApply({
  lifecycle,
  store,
  ctx = null,
  workspaceRegistry,
  workspaces,
  now = Date.now,
  uuid = () => nodeCrypto.randomUUID(),
  fs = nodeFs,
  path = nodePath,
  backupsRoot,
} = {}) {
  if (!lifecycle || typeof lifecycle.registerApplyRecovery !== 'function') {
    throw new Error('createDistillApply requires a distill lifecycle')
  }
  if (!store || typeof store !== 'object') throw new Error('createDistillApply requires a host store')
  const backupsBase = typeof backupsRoot === 'string' && backupsRoot !== '' ? backupsRoot : defaultBackupsRoot(path)

  const getService = (name) => {
    try {
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    } catch {
      return undefined
    }
  }
  const registry = () => (workspaceRegistry !== undefined ? workspaceRegistry : getService('workspaceRegistry'))

  async function resolveDir(workspaceId) {
    const dir = await resolveDistillWorkspaceDir(
      workspaceId,
      { workspaceRegistry: registry(), hostStore: store, workspaces },
      { fs, path },
    )
    let key = dir
    try { key = fs.realpathSync(dir) } catch { /* keep resolved spelling */ }
    return { dir, key }
  }

  const persistTx = (run, tx, patch) => store.putDistillRun({
    ...run,
    tx,
    ...(patch && typeof patch === 'object' ? patch : {}),
    updatedAt: now(),
  })

  /**
   * Token ledger snapshot persisted as `applyResult.usage` (contract §2.2).
   * Apply performs no model call, so this mirrors the analysis ledger.
   * @param {object|null} run
   * @returns {object} emptyRunUsage shape
   */
  function usageSnapshot(run) {
    const ledger = emptyRunUsage()
    accumulateRunUsage(ledger, run && typeof run.usage === 'object' ? run.usage : {})
    return ledger
  }

  /**
   * Success record persisted on the run (contract §2.2). Shaped exactly like
   * the apply payload so the result page can render either source; `applied`
   * keeps only the file/newHash/backupPath triple the write-back ledger shows.
   */
  function buildApplySuccess({
    applied, skipped, fingerprints, selectedChangeIds,
    ignoredSkipped, alreadyPresentSkipped, usage, at,
  }) {
    return {
      ok: true,
      appliedAt: at,
      applied: applied.map(item => ({
        file: item.file,
        newHash: item.newHash,
        ...(item.backupPath ? { backupPath: item.backupPath } : {}),
      })),
      skipped,
      fingerprints,
      readBackOk: true,
      selectedChangeIds,
      ignoredSkipped,
      alreadyPresentSkipped,
      usage,
    }
  }

  /**
   * Failure record persisted on the run (contract §2.2).
   * @param {{ code: string, message: string, file?: string, targets?: string[], rolledBack: boolean, at: number }} fields
   * @returns {object}
   */
  function buildApplyFailure({ code, message, file, targets, rolledBack, at }) {
    return {
      ok: false,
      code,
      message,
      ...(typeof file === 'string' && file !== '' ? { file } : {}),
      ...(Array.isArray(targets) && targets.length > 0 ? { targets } : {}),
      rolledBack: rolledBack === true,
      at,
    }
  }

  /**
   * Attach a failure record to a run that stays `ready` after a refused apply
   * (CAS drift / static validation / path rejection). The human can fix the
   * cause and retry, so the status is untouched and `updatedAt` is preserved:
   * a refused attempt must not reset the ready TTL/expiry clocks. Persistence
   * errors never mask the apply outcome the route already computed.
   * @param {object} run the run as read inside the workspace lock
   * @param {{ code: string, message: string, file?: string, targets?: string[] }} failure
   */
  async function recordApplyFailure(run, failure) {
    if (!run || typeof run.id !== 'string') return
    const at = now()
    const applyResult = buildApplyFailure({ ...failure, rolledBack: false, at })
    const progress = run.progress && typeof run.progress === 'object'
      ? appendProgressLog(run.progress, 'validating', `写回未开始：${failure.code}`, at)
      : run.progress
    try {
      await store.putDistillRun({ ...run, ...(progress ? { progress } : {}), applyResult, updatedAt: run.updatedAt })
    } catch {
      // The route response stays authoritative; never turn a CAS error into a 500.
    }
  }

  /**
   * Roll back + clean a transaction inside the caller's lock. On conflict the
   * scene (tx/backups/fingerprints) is preserved untouched; on success the
   * tx fingerprint IDs are deleted idempotently and `.tmp-` residue is swept
   * (workspace tree + this workspace's backup directory).
   */
  async function finalizeRollback(run, workspaceDir, theStore = store) {
    const tx = run.tx && typeof run.tx === 'object' ? run.tx : { files: [], done: [], fingerprintIds: [] }
    const outcome = rollbackTxFiles(tx, workspaceDir, { fs, path, uuid })
    if (!outcome.rolledBack) return outcome
    const ids = Array.isArray(tx.fingerprintIds) ? tx.fingerprintIds.filter(id => typeof id === 'string' && id !== '') : []
    if (ids.length > 0 && typeof theStore.deleteDistillFingerprints === 'function') {
      await theStore.deleteDistillFingerprints(run.workspaceId, ids)
    }
    cleanResidualTmpFiles(workspaceDir, { fs, path })
    const backupDir = backupDirFor(backupsBase, workspaceDir, run.workspaceId, path)
    try {
      for (const entry of fs.readdirSync(backupDir)) {
        if (entry.startsWith('.tmp-')) {
          try { fs.unlinkSync(path.join(backupDir, entry)) } catch { /* keep undeletable residue */ }
        }
      }
    } catch { /* backup dir may not exist yet */ }
    return { rolledBack: true }
  }

  /** One fingerprint per applied (or equivalent-skipped) change (§5.1/§12). */
  function buildFingerprints(plan, applied, skipped, run, clock) {
    const fileMeta = new Map()
    for (const item of applied) fileMeta.set(item.file, { hash: item.newHash, backupPath: item.backupPath })
    for (const item of skipped) fileMeta.set(item.file, { hash: item.hash, backupPath: undefined })
    const out = []
    for (const target of plan.targets) {
      const meta = fileMeta.get(target.file)
      if (!meta) continue
      for (const change of target.changes) {
        out.push({
          workspaceId: run.workspaceId,
          targetFile: target.file,
          ...(typeof change.sectionAnchor === 'string' && change.sectionAnchor !== '' ? { sectionAnchor: change.sectionAnchor } : {}),
          changeKind: change.kind,
          normalizedHash: computeFingerprint({ targetFile: target.file, sectionAnchor: change.sectionAnchor, proposedText: change.proposedText }),
          sourceRefs: (Array.isArray(change.evidence) ? change.evidence : []).map(ev => ({
            sessionId: ev.sessionId,
            messageId: ev.messageId,
            ...(ev.turn !== undefined ? { turn: ev.turn } : {}),
          })),
          runId: run.id,
          appliedAt: clock,
          appliedFileHash: meta.hash,
          ...(meta.backupPath ? { backupPath: meta.backupPath } : {}),
        })
      }
    }
    return out
  }

  const casConflictResult = (file, expected, actual) => ({
    ok: false,
    status: 409,
    code: DISTILL_APPLY_CODES.CAS_CONFLICT,
    error: `baseline hash mismatch: ${file}`,
    file,
    expected,
    actual,
    rolledBack: false,
  })

  /**
   * CAS refusal + persisted failure record (contract §2.2). The run stays
   * `ready` and nothing on disk changed; the human can rebase the baseline and
   * retry, and the result page still sees the last refusal.
   * @param {object} run run as read inside the lock
   * @param {string} file target file whose baseline drifted
   * @param {string|null} expected persisted baseline hash
   * @param {string|null} actual observed hash
   */
  async function casFailure(run, file, expected, actual) {
    const conflict = casConflictResult(file, expected, actual)
    await recordApplyFailure(run, { code: conflict.code, message: conflict.error, file: conflict.file })
    return conflict
  }

  /**
   * POST distill-apply (spec §11.1/§11.2). The authoritative baseline is the
   * persisted plan's fileBaseHash; request baseHashes are secondary
   * confirmation only. Never reuses the retired executeSpecWriteback.
   * Two review-side marks narrow the write-back set without touching the
   * human's recorded selection (contract §1.3/§1.4): `plan.review.ignoredChangeIds`
   * (暂不采纳) and `change.skipReason === 'already-present'` (rebase). Both are
   * reported back as `ignoredSkipped` / `alreadyPresentSkipped`.
   * @param {object} input { runId, selectedChangeIds, baseHashes?, rationaleEdits? }
   * @returns {Promise<object>} route result
   */
  async function applyPlan(input = {}) {
    const runId = typeof input.runId === 'string' ? input.runId.trim() : ''
    if (!runId) return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: 'runId is required' }
    const selectedIds = Array.isArray(input.selectedChangeIds)
      ? [...new Set(input.selectedChangeIds.filter(id => typeof id === 'string' && id !== ''))]
      : null
    if (!selectedIds || selectedIds.length === 0) {
      return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: 'selectedChangeIds must be a non-empty array of change ids' }
    }
    const initialRun = await store.getDistillRun(runId)
    if (!initialRun) return { ok: false, status: 404, code: DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, error: `run not found: ${runId}` }
    // Lazy recovery first (spec §4.2): a crashed applying run is reconciled
    // before this request decides anything.
    await lifecycle.recoverWorkspace(initialRun.workspaceId)
    let locked
    try {
      locked = await resolveDir(initialRun.workspaceId)
    } catch (error) {
      return distillErrorResult(error)
    }
    // Live control BEFORE the lock so cancel can arbitrate while we wait.
    const control = lifecycle.registerRunControl(runId, initialRun.workspaceId)
    const isCancelled = () => control.state === 'cancelRequested' || control.abort.signal.aborted
    try {
      return await withWorkspaceLock(locked.key, async () => {
        const run = await store.getDistillRun(runId)
        if (!run) return { ok: false, status: 404, code: DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, error: `run not found: ${runId}` }
        if (run.status !== 'ready') {
          return { ok: false, status: 409, code: DISTILL_APPLY_CODES.RUN_NOT_READY, error: `run is not ready (${run.status})`, runStatus: run.status }
        }
        const runs = await store.listDistillRuns(run.workspaceId)
        const active = getActiveRun(runs, run.workspaceId)
        if (active && active.id !== runId) {
          return { ok: false, status: 409, code: DISTILL_LIFECYCLE_CODES.RUN_ALREADY_ACTIVE, error: 'workspace already has a non-terminal distillation run', activeRunId: active.id }
        }
        let plan = await store.getDistillPlan(runId)
        if (!plan) return { ok: false, status: 409, code: DISTILL_APPLY_CODES.PLAN_MISSING, error: `no persisted plan for run ${runId}` }

        // Selection legality + dependency closure (no auto-adding, §10.3).
        const knownIds = new Set()
        for (const target of Array.isArray(plan.targets) ? plan.targets : []) {
          for (const change of Array.isArray(target.changes) ? target.changes : []) knownIds.add(change.id)
        }
        const unknown = selectedIds.filter(id => !knownIds.has(id))
        if (unknown.length > 0) {
          return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: `unknown change ids: ${unknown.join(', ')}` }
        }
        // Review marks (contract §1.3):「暂不采纳」changes stay in the plan but
        // never reach the write-back set, even when the client still submits
        // them (the human's non-adoption is authoritative).
        const ignoredIds = new Set(
          (Array.isArray(plan.review?.ignoredChangeIds) ? plan.review.ignoredChangeIds : [])
            .filter(id => typeof id === 'string' && id !== ''),
        )
        // Rebase marks (contract §1.4): changes whose content is already on disk
        // are skipped instead of being written twice, while the human's
        // selection stays recorded on the plan.
        const alreadyPresentIds = new Set()
        for (const target of Array.isArray(plan.targets) ? plan.targets : []) {
          for (const change of Array.isArray(target?.changes) ? target.changes : []) {
            if (change && change.skipReason === 'already-present' && typeof change.id === 'string') {
              alreadyPresentIds.add(change.id)
            }
          }
        }
        const ignoredSkipped = selectedIds.filter(id => ignoredIds.has(id))
        const alreadyPresentSkipped = selectedIds.filter(id => alreadyPresentIds.has(id))
        const effectiveIds = selectedIds.filter(id => !ignoredIds.has(id) && !alreadyPresentIds.has(id))
        if (effectiveIds.length === 0) {
          return {
            ok: false,
            status: 400,
            code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST,
            error: 'every selected change is either not adopted or already present on disk',
            ignoredSkipped,
            alreadyPresentSkipped,
          }
        }
        const dependencyCheck = validateDependencySelection(plan, effectiveIds)
        if (!dependencyCheck.ok) {
          return { ok: false, status: 400, code: DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, error: dependencyCheck.errors.join('; '), missing: dependencyCheck.missing }
        }

        // rationaleEdits pre-write (§11.2.8): inside the lock, after checks,
        // read-modify-write preserving rawResponseRef; survives file rollback.
        if (input.rationaleEdits && typeof input.rationaleEdits === 'object' && !Array.isArray(input.rationaleEdits)) {
          const currentPlan = await store.getDistillPlan(runId) || plan
          let edited = false
          const nextTargets = (Array.isArray(currentPlan.targets) ? currentPlan.targets : []).map(target => ({
            ...target,
            changes: (Array.isArray(target.changes) ? target.changes : []).map((change) => {
              const edit = input.rationaleEdits[change.id]
              if (typeof edit === 'string' && edit !== '') { edited = true; return { ...change, rationale: edit } }
              return change
            }),
          }))
          if (edited) {
            await store.putDistillPlan({ ...currentPlan, targets: nextTargets })
            plan = await store.getDistillPlan(runId)
          }
        }

        // Filter to the selection; recompute stats so §9 schema stays honest.
        const selected = new Set(effectiveIds)
        const filteredTargets = plan.targets
          .map(target => ({ ...target, changes: target.changes.filter(change => selected.has(change.id)) }))
          .filter(target => target.changes.length > 0)
        const byGrade = { resolved: 0, commit: 0, submitted: 0 }
        let changeCount = 0
        for (const target of filteredTargets) {
          for (const change of target.changes) {
            changeCount += 1
            const grade = changeGrade(change)
            if (grade && grade in byGrade) byGrade[grade] += 1
          }
        }
        const filteredPlan = { ...plan, targets: filteredTargets, stats: { targets: filteredTargets.length, changes: changeCount, byGrade } }

        // baseHashes: secondary confirmation against the authoritative plan.
        if (input.baseHashes && typeof input.baseHashes === 'object' && !Array.isArray(input.baseHashes)) {
          for (const target of filteredPlan.targets) {
            const claimed = input.baseHashes[target.file]
            if (typeof claimed === 'string' && claimed !== target.fileBaseHash) {
              return casFailure(run, target.file, target.fileBaseHash, claimed)
            }
          }
        }

        // Fresh surface + §9 pure validation (errors forbid application).
        const navigation = readNavigation(locked.dir, { fs, path })
        const surface = collectTargetSurface(locked.dir, filteredPlan, navigation, { fs, path })
        // Baseline drift surfaces as the spec §11.1 CAS_CONFLICT shape, not a
        // generic validation error (path/symlink rejections stay validation).
        for (const target of filteredPlan.targets) {
          const st = surface.targets.find(entry => entry.file === target.file)
          if (!st || st.pathRejected || st.symlinkRejected) continue
          if (target.action === 'update') {
            if (!st.exists || st.fileBaseHash !== target.fileBaseHash) {
              return casFailure(run, target.file, target.fileBaseHash, st.fileBaseHash)
            }
          } else if (st.exists) {
            return casFailure(run, target.file, null, st.fileBaseHash)
          }
        }
        const validation = validatePlan(filteredPlan, surface)
        if (!validation.ok) {
          const message = 'plan failed static validation'
          await recordApplyFailure(run, { code: DISTILL_APPLY_CODES.VALIDATION_FAILED, message })
          return { ok: false, status: 409, code: DISTILL_APPLY_CODES.VALIDATION_FAILED, error: message, checks: validation.checks }
        }
        if (isCancelled()) {
          const at = now()
          const applyResult = buildApplyFailure({
            code: DISTILL_APPLY_CODES.CANCELED,
            message: 'apply canceled before any file was written',
            rolledBack: true,
            at,
          })
          await store.putDistillRun(transitionRun(run, 'canceled', {
            now: at,
            patch: {
              applyResult,
              progress: appendProgressLog(run.progress, 'validating', '写回已取消：本次未写入任何文件', at),
            },
          }))
          return { ok: false, status: 409, code: DISTILL_APPLY_CODES.CANCELED, runStatus: 'canceled', rolledBack: true }
        }

        // §8.4 synthesis for every file — still no filesystem side effects.
        const txFiles = []
        const skipped = []
        const contentByFile = new Map()
        for (const target of filteredPlan.targets) {
          if (!isAllowedDocPath(target.file) || hasSymlinkSegment(locked.dir, target.file, { fs, path })) {
            const message = `path rejected: ${target.file}`
            await recordApplyFailure(run, { code: DISTILL_LIFECYCLE_CODES.PATH_REJECTED, message, file: target.file })
            return { ok: false, status: 403, code: DISTILL_LIFECYCLE_CODES.PATH_REJECTED, error: message, file: target.file }
          }
          const full = path.join(locked.dir, target.file)
          if (target.action === 'create') {
            const parent = path.dirname(full)
            if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
              const message = `create directory does not exist: ${target.file}`
              await recordApplyFailure(run, { code: DISTILL_LIFECYCLE_CODES.PATH_REJECTED, message, file: target.file })
              return { ok: false, status: 403, code: DISTILL_LIFECYCLE_CODES.PATH_REJECTED, error: message, file: target.file }
            }
            if (fs.existsSync(full)) {
              const existing = readDiskFile(full, fs)
              return casFailure(run, target.file, null, existing.hash)
            }
            const synth = synthesizeFileContent({ action: 'create', changes: target.changes })
            if (!synth.ok) {
              await recordApplyFailure(run, {
                code: DISTILL_APPLY_CODES.VALIDATION_FAILED,
                message: synth.errors.map(e => e.message).join('; '),
                file: target.file,
              })
              return { ok: false, status: 409, code: DISTILL_APPLY_CODES.VALIDATION_FAILED, error: synth.errors.map(e => e.message).join('; '), file: target.file, errors: synth.errors }
            }
            txFiles.push({ file: target.file, action: 'create', baseHash: null, newHash: sha256Hex(synth.content, nodeCrypto) })
            contentByFile.set(target.file, synth.content)
          } else {
            const disk = readDiskFile(full, fs)
            if (!disk.exists || disk.hash !== target.fileBaseHash) {
              return casFailure(run, target.file, target.fileBaseHash, disk.hash)
            }
            const synth = synthesizeFileContent({ action: 'update', content: disk.content, anchors: collectAtxAnchors(disk.content), changes: target.changes })
            if (!synth.ok) {
              await recordApplyFailure(run, {
                code: DISTILL_APPLY_CODES.VALIDATION_FAILED,
                message: synth.errors.map(e => e.message).join('; '),
                file: target.file,
              })
              return { ok: false, status: 409, code: DISTILL_APPLY_CODES.VALIDATION_FAILED, error: synth.errors.map(e => e.message).join('; '), file: target.file, errors: synth.errors }
            }
            // §12.4 equivalence on FINAL content: already present → skip.
            if (isEquivalentContent(synth.content, disk.content)) {
              skipped.push({ file: target.file, reason: 'equivalent', hash: disk.hash })
              continue
            }
            txFiles.push({ file: target.file, action: 'update', baseHash: target.fileBaseHash, newHash: sha256Hex(synth.content, nodeCrypto) })
            contentByFile.set(target.file, synth.content)
          }
        }

        // Atomic occupation: run→applying + complete tx in one persistence.
        // The narration switch rides along in the same write (§2.3), so the
        // timeline shows the write-back phase without an extra persistence.
        let current
        const occupationAt = now()
        try {
          current = await store.putDistillRun(transitionRun(run, 'applying', {
            now: occupationAt,
            patch: {
              tx: { startedAt: occupationAt, files: txFiles, done: [], fingerprintIds: [] },
              progress: appendProgressLog(
                run.progress,
                'applying',
                `开始写回 ${txFiles.length} 个文件（${changeCount} 条变更）`,
                occupationAt,
              ),
            },
          }))
        } catch (error) {
          return { ok: false, status: 409, code: DISTILL_APPLY_CODES.RUN_NOT_READY, error: error?.message || String(error) }
        }

        const backupDir = backupDirFor(backupsBase, locked.dir, run.workspaceId, path)
        const applied = []
        try {
          const fileTotal = Array.isArray(current.tx.files) ? current.tx.files.length : 0
          for (const [index, item] of current.tx.files.entries()) {
            if (isCancelled()) throw new ApplyCanceledError()
            // currentFile BEFORE any filesystem side effect (§11.2.3). The
            // narration names the file and its position (contract §2.3).
            const writeAt = now()
            current = await persistTx(current, { ...current.tx, currentFile: { ...item } }, {
              progress: appendProgressLog(
                current.progress,
                'applying',
                `正在写回 ${item.file}（${index + 1}/${fileTotal}）`,
                writeAt,
              ),
            })
            const full = path.join(locked.dir, item.file)
            const content = contentByFile.get(item.file)
            let backupPath
            if (item.action === 'update') {
              fs.mkdirSync(backupDir, { recursive: true })
              const original = readDiskFile(full, fs)
              if (!original.exists || original.hash !== item.baseHash) {
                throw new DistillHostError(DISTILL_APPLY_CODES.CAS_CONFLICT, `baseline hash mismatch: ${item.file}`, {
                  details: { file: item.file, expected: item.baseHash, actual: original.hash },
                })
              }
              const tmpBackup = path.join(backupDir, `.tmp-${uuid()}`)
              fs.writeFileSync(tmpBackup, original.content, 'utf8')
              const verified = readDiskFile(tmpBackup, fs)
              if (!verified.exists || verified.hash !== item.baseHash) {
                throw new DistillHostError(DISTILL_APPLY_CODES.BACKUP_CORRUPT, `backup verification failed: ${item.file}`, {
                  details: { file: item.file, backupPath: tmpBackup },
                })
              }
              backupPath = uniqueBackupPath(backupDir, now(), item.file, fs, path)
              fs.renameSync(tmpBackup, backupPath)
              // Record backupPath before touching the target (crash window).
              current = await persistTx(current, { ...current.tx, currentFile: { ...item, backupPath } })
              // CAS re-check immediately before replacement (§11.2).
              const recheck = readDiskFile(full, fs)
              if (!recheck.exists || recheck.hash !== item.baseHash) {
                throw new DistillHostError(DISTILL_APPLY_CODES.CAS_CONFLICT, `baseline hash mismatch: ${item.file}`, {
                  details: { file: item.file, expected: item.baseHash, actual: recheck.hash },
                })
              }
              atomicWriteFile(full, content, { fs, path, uuid })
            } else {
              createFileNoClobber(full, content, { fs, path, uuid })
            }
            const after = readDiskFile(full, fs)
            if (!after.exists || after.hash !== item.newHash) {
              throw new DistillHostError(DISTILL_APPLY_CODES.READ_BACK_FAILED, `read-back verification failed: ${item.file}`, {
                details: { file: item.file },
              })
            }
            const doneItem = { ...item, ...(backupPath ? { backupPath } : {}) }
            current = await persistTx(current, { ...current.tx, done: [...current.tx.done, doneItem], currentFile: undefined })
            applied.push({ file: item.file, action: item.action, newHash: item.newHash, ...(backupPath ? { backupPath } : {}) })
          }

          // Commit point (§11.2.7): synchronous CAS active→committing. After
          // this, cancel returns too_late; before it, cancel rolls back.
          if (isCancelled()) throw new ApplyCanceledError()
          if (!lifecycle.casRunControl(runId, 'active', 'committing')) throw new ApplyCanceledError()

          // Fingerprints: allocate ALL ids, persist the list, then write rows
          // idempotently (§11.2.4) so recovery can delete the full set.
          const clock = now()
          const fingerprints = buildFingerprints(filteredPlan, applied, skipped, run, clock)
          const fingerprintIds = fingerprints.map(() => uuid())
          current = await persistTx(current, { ...current.tx, fingerprintIds })
          for (let i = 0; i < fingerprints.length; i += 1) {
            await store.putDistillFingerprints(run.workspaceId, [{ ...fingerprints[i], id: fingerprintIds[i] }])
          }

          // applied persistence; failure rolls back per transaction rules and
          // does not accept late cancels (control stays committing). The
          // outcome is persisted on the run in the SAME write (contract §2.2),
          // so GET distill-run has it without a second read-back.
          const doneNote = applied.length > 0
            ? `已写回 ${applied.length} 个文件并完成回读校验`
              + `${skipped.length > 0 ? `，${skipped.length} 个文件内容已一致跳过` : ''}`
            : `没有文件需要写入：${skipped.length} 个文件内容已一致`
          const applyResult = buildApplySuccess({
            applied,
            skipped,
            fingerprints: fingerprintIds,
            selectedChangeIds: effectiveIds,
            ignoredSkipped,
            alreadyPresentSkipped,
            usage: usageSnapshot(current),
            at: clock,
          })
          try {
            const appliedRun = transitionRun(current, 'applied', {
              now: clock,
              patch: {
                appliedAt: clock,
                tx: undefined,
                applyResult,
                progress: appendProgressLog(current.progress, 'applying', doneNote, clock),
              },
            })
            await store.putDistillRun(appliedRun)
          } catch (error) {
            const outcome = await finalizeRollback(current, locked.dir)
            const code = outcome.rolledBack ? (error?.code || 'INTERNAL_ERROR') : outcome.conflict.code
            const message = outcome.rolledBack ? (error?.message || String(error)) : outcome.conflict.message
            const at = now()
            const failed = transitionRun(current, 'failed', {
              now: at,
              patch: {
                error: { code, message },
                ...(outcome.rolledBack ? { tx: undefined } : {}),
                applyResult: buildApplyFailure({
                  code,
                  message,
                  ...(outcome.rolledBack ? {} : { targets: outcome.conflict.targets }),
                  rolledBack: outcome.rolledBack,
                  at,
                }),
                progress: appendProgressLog(
                  current.progress,
                  'applying',
                  outcome.rolledBack
                    ? `写回失败：${code}，已回滚全部写入`
                    : `写回失败：${code}，回滚未完成，需人工处理`,
                  at,
                ),
              },
            })
            await store.putDistillRun(failed)
            return {
              ok: false, status: distillErrorStatus(code), code, error: message,
              rolledBack: outcome.rolledBack, runStatus: 'failed',
              ...(outcome.rolledBack ? {} : { targets: outcome.conflict.targets, backupPath: outcome.conflict.backupPath }),
            }
          }
          return {
            ok: true,
            status: 200,
            applied,
            skipped,
            ignoredSkipped,
            alreadyPresentSkipped,
            readBackOk: true,
            fingerprints: fingerprintIds,
            runStatus: 'applied',
          }
        } catch (error) {
          const canceled = error instanceof ApplyCanceledError || isCancelled()
          const outcome = await finalizeRollback(current, locked.dir)
          if (!outcome.rolledBack) {
            const at = now()
            const failed = transitionRun(current, 'failed', {
              now: at,
              patch: {
                error: { code: outcome.conflict.code, message: outcome.conflict.message },
                applyResult: buildApplyFailure({
                  code: outcome.conflict.code,
                  message: outcome.conflict.message,
                  targets: outcome.conflict.targets,
                  rolledBack: false,
                  at,
                }),
                progress: appendProgressLog(
                  current.progress,
                  'applying',
                  `写回失败：${outcome.conflict.code}，回滚未完成，需人工处理`,
                  at,
                ),
              },
            })
            await store.putDistillRun(failed)
            return {
              ok: false, status: 409, code: outcome.conflict.code, error: outcome.conflict.message,
              rolledBack: false, runStatus: 'failed', targets: outcome.conflict.targets,
              ...(outcome.conflict.backupPath ? { backupPath: outcome.conflict.backupPath } : {}),
            }
          }
          if (canceled) {
            const at = now()
            await store.putDistillRun(transitionRun(current, 'canceled', {
              now: at,
              patch: {
                tx: undefined,
                applyResult: buildApplyFailure({
                  code: DISTILL_APPLY_CODES.CANCELED,
                  message: 'apply canceled; transaction rolled back',
                  rolledBack: true,
                  at,
                }),
                progress: appendProgressLog(current.progress, 'applying', '写回已取消：已回滚本次写入，文件保持原样', at),
              },
            }))
            return { ok: false, status: 409, code: DISTILL_APPLY_CODES.CANCELED, runStatus: 'canceled', rolledBack: true }
          }
          const code = error?.code || 'INTERNAL_ERROR'
          const message = error?.message || String(error)
          const at = now()
          await store.putDistillRun(transitionRun(current, 'failed', {
            now: at,
            patch: {
              error: { code, message },
              tx: undefined,
              applyResult: buildApplyFailure({
                code,
                message,
                ...(error?.details?.file ? { file: error.details.file } : {}),
                ...(Array.isArray(error?.details?.targets) ? { targets: error.details.targets } : {}),
                rolledBack: true,
                at,
              }),
              progress: appendProgressLog(current.progress, 'applying', `写回失败：${code}，已回滚全部写入`, at),
            },
          }))
          return {
            ok: false, status: distillErrorStatus(code), code, error: message,
            rolledBack: true, runStatus: 'failed', ...(error?.details || {}),
          }
        }
      })
    } catch (error) {
      return distillErrorResult(error)
    } finally {
      lifecycle.finishRunControl(runId)
    }
  }

  /**
   * Apply lazy-recovery handler (registered via lifecycle.registerApplyRecovery).
   * Invoked OUTSIDE the workspace lock: takes its own lock, re-reads the run,
   * guards terminal states, reconciles currentFile first + done reverse,
   * deletes tx fingerprints, sweeps `.tmp-` residue and persists the terminal.
   * Conflict scenes keep tx/backups and report rolledBack:false honestly.
   * @param {{ run: object, workspaceDir: string, store?: object, now?: number }} input
   * @returns {Promise<ApplyRecoveryResult>}
   */
  async function recoverApplying({ run, workspaceDir, store: hookStore, now: hookNow } = {}) {
    const theStore = hookStore || store
    const clock = typeof hookNow === 'number' ? hookNow : now()
    if (!run || typeof run.id !== 'string') {
      throw new DistillHostError(DISTILL_LIFECYCLE_CODES.INVALID_REQUEST, 'apply recovery requires a run')
    }
    let key
    try {
      key = fs.realpathSync(workspaceDir)
    } catch (error) {
      // Transient: lifecycle keeps the run non-terminal and retries later.
      throw new DistillHostError(DISTILL_ERROR_CODES.WORKSPACE_UNAVAILABLE, `workspace directory unavailable: ${workspaceDir}`, { cause: error })
    }
    return withWorkspaceLock(key, async () => {
      const current = await theStore.getDistillRun(run.id)
      if (!current) {
        return { runStatus: 'failed', rolledBack: true, error: { code: DISTILL_LIFECYCLE_CODES.RUN_NOT_FOUND, message: `run disappeared: ${run.id}` } }
      }
      if (isTerminalRunStatus(current.status)) {
        return { runStatus: current.status === 'canceled' ? 'canceled' : 'failed', rolledBack: true }
      }
      if (current.status !== 'applying') {
        // Defensive no-op: the lifecycle only routes applying runs here.
        return { runStatus: 'failed', rolledBack: true }
      }
      const outcome = await finalizeRollback(current, workspaceDir, theStore)
      if (!outcome.rolledBack) {
        const error = { code: outcome.conflict.code, message: outcome.conflict.message }
        await theStore.putDistillRun(transitionRun(current, 'failed', {
          now: clock,
          patch: {
            error,
            applyResult: buildApplyFailure({
              code: error.code,
              message: error.message,
              targets: outcome.conflict.targets,
              rolledBack: false,
              at: clock,
            }),
            progress: appendProgressLog(
              current.progress,
              'applying',
              `写回失败：${error.code}，回滚未完成，需人工处理`,
              clock,
            ),
          },
        }))
        return {
          runStatus: 'failed', error, rolledBack: false, targets: outcome.conflict.targets,
          ...(outcome.conflict.backupPath ? { backupPath: outcome.conflict.backupPath } : {}),
        }
      }
      const error = { code: DISTILL_APPLY_CODES.APPLY_INTERRUPTED, message: 'applying run recovered after interruption; transaction rolled back' }
      await theStore.putDistillRun(transitionRun(current, 'failed', {
        now: clock,
        patch: {
          error,
          tx: undefined,
          applyResult: buildApplyFailure({
            code: error.code,
            message: error.message,
            rolledBack: true,
            at: clock,
          }),
          progress: appendProgressLog(current.progress, 'applying', `写回中断：${error.code}，已回滚全部写入`, clock),
        },
      }))
      return { runStatus: 'failed', error, rolledBack: true }
    })
  }

  return { applyPlan, recoverApplying }
}
