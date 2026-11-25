import { DEFAULT_TAIL_TEXTS } from '../domain/prompt.js'
import { DEFAULT_TAGS } from '../domain/tags.js'

/**
 * @typedef {object} DeskStore
 * @property {(workspaceKey: string) => Promise<object[]>} listEntries
 * @property {(workspaceKey: string, id: string) => Promise<object|undefined>} getEntry
 * @property {(entry: object) => Promise<void>} putEntry
 * @property {(workspaceKey: string, id: string) => Promise<void>} deleteEntry
 * @property {(workspaceKey: string, filter?: object) => Promise<object[]>} listPromptLog
 * @property {(workspaceKey: string, entries: object[]) => Promise<void>} upsertPromptLog
 * @property {(workspaceKey: string, messageId: string) => Promise<void>} deletePromptLog
 * @property {(sessionId: string, value: object) => Promise<void>} setHandoff
 * @property {(sessionId: string) => Promise<object|null>} getHandoff
 * @property {(sessionId: string) => Promise<void>} deleteHandoff
 * @property {() => Promise<object>} getPrefs
 * @property {(prefs: object) => Promise<void>} setPrefs
 * @property {() => Promise<string[]>} [listWorkspaces] workspace keys currently indexed
 * @property {() => Promise<import('../domain/workspace.js').WorkspaceRecord[]>} [listWorkspaceRecords]
 * @property {(record: import('../domain/workspace.js').WorkspaceRecord) => Promise<void>} [putWorkspaceRecord]
 * @property {(sessionId: string) => Promise<import('../domain/active-group.js').GroupRecord[]>} [getGroups]
 * @property {(group: import('../domain/active-group.js').GroupRecord) => Promise<void>} [putGroup]
 * @property {(workspaceKey: string) => number} [revision] monotonic read counter for cache invalidation
 * @property {(sessionKey: string) => Promise<object[]>} [listCommitTraces]
 * @property {(sessionKey: string, traces: object[]) => Promise<void>} [putCommitTraces]
 * @property {(query: { workspaceId: string, hash: string, limit?: number }) => Promise<{ matches: object[] }>} [lookupCommitTraces]
 * @property {(run: object) => Promise<object>} [putDistillRun] upsert a DistillationRun into `distillRuns['ws:<workspaceId>']`
 * @property {(runId: string) => Promise<object|null>} [getDistillRun] find a run by id across workspace buckets
 * @property {(workspaceId: string, options?: { statuses?: string[] }) => Promise<object[]>} [listDistillRuns] runs for one workspace, newest first
 * @property {(plan: object) => Promise<object>} [putDistillPlan] persist a DistillPlan/ChangePlan under `distillPlans['run:<runId>']`
 * @property {(runId: string) => Promise<object|null>} [getDistillPlan]
 * @property {(runId: string) => Promise<void>} [deleteDistillPlan]
 * @property {(workspaceId: string, fingerprints: object[]) => Promise<object[]>} [putDistillFingerprints] upsert + prune fingerprints for one workspace
 * @property {(workspaceId: string) => Promise<object[]>} [listDistillFingerprints]
 * @property {(workspaceId: string, ids: string[]) => Promise<number>} [deleteDistillFingerprints] rollback/cleanup helper
 * @property {(options?: { workspaceId?: string }) => Promise<{ runs: number, plans: number, fingerprints: number }>} [pruneDistillData] retention enforcement for lazy recovery
 * @property {(sessionKey: string) => Promise<TurnActionSessionState|null>} [listTurnActions]
 * @property {(sessionKey: string, state: TurnActionSessionState) => Promise<void>} [putTurnActions]
 * @property {(sessionKey: string) => Promise<void>} [deleteTurnActions]
 * @property {() => { version: number, readOnly: boolean }} [getStateVersionInfo] stored schema version / read-only guard
 * @property {(workspaceId: string, options?: { preservePinned?: boolean, sessionIds?: string[], sessionId?: string, clearFindings?: boolean, clearGroups?: boolean, clearPromptLogs?: boolean, clearDrafts?: boolean, clearCommitTraces?: boolean, clearDistillRuns?: boolean, clearDistillFingerprints?: boolean }) => Promise<void>} [clearWorkspaceData]
 * @property {(listener: () => void) => () => void} subscribe
 * @property {() => boolean} [quotaWarning]
 * @property {() => void} [dispose] releases cross-tab listeners
 */

export const PREFIX = 'dsh-punch-desk.v1.'

/**
 * How a draft becomes a session's first prompt: `prefill` writes the draft
 * into the composer and waits for the user; `auto` sends it immediately.
 * @typedef {'prefill'|'auto'} StartSessionBehavior
 */

/** @type {ReadonlyArray<StartSessionBehavior>} */
export const START_SESSION_BEHAVIORS = ['prefill', 'auto']

/**
 * How far the asset-inheritance candidate list reaches: `workspace` keeps the
 * candidates inside the current workspace (safe default); `all` additionally
 * offers sessions from every workspace, where inheritance is copy-only.
 * @typedef {'workspace'|'all'} InheritScope
 */

/** @type {ReadonlyArray<InheritScope>} */
export const INHERIT_SCOPES = ['workspace', 'all']

/** @typedef {'workspace'|'global'} DraftDefaultVisibility */
export const DRAFT_DEFAULT_VISIBILITIES = ['workspace', 'global']

/** @typedef {'threshold'|'always'|'off'} SequentialCostHint */
export const SEQUENTIAL_COST_HINTS = ['threshold', 'always', 'off']

/** @typedef {3|4|5} ComposerRowsOption */
export const COMPOSER_ROWS_OPTIONS = [3, 4, 5]

/** @typedef {'compact'|'tall'|'half'} ArchivedHistoryHeight */
export const ARCHIVED_HISTORY_HEIGHTS = ['compact', 'tall', 'half']

/**
 * Coverage of the reply-contract tail appended to every submitted prompt.
 * The wording of each section is user-editable (`promptTailTextA/B/C`).
 * - `minimal`: A only (numbered three-state replies).
 * - `standard`: A + B (adds one result line per tool batch).
 * - `strict`: A + B + C (adds the four-part wrap-up).
 * @typedef {'minimal'|'standard'|'strict'} PromptTail
 */

/** @type {ReadonlyArray<PromptTail>} */
export const PROMPT_TAILS = ['minimal', 'standard', 'strict']

/**
 * Submission size limits are user-configurable because "one atomic finding" is
 * a product judgement, not a platform constraint: a code snippet can be far
 * larger than 2 KB, while a 100 KB queued prompt costs real tokens. Defaults
 * follow the capture hard cap so a saved finding is always submittable.
 */
export const PROMPT_ENTRY_BYTES_DEFAULT = 8192
export const PROMPT_ENTRY_BYTES_RANGE = { min: 1024, max: 65536 }
export const PROMPT_TOTAL_BYTES_DEFAULT = 65536
export const PROMPT_TOTAL_BYTES_RANGE = { min: 4096, max: 262144 }
/** Reserved headroom so one entry + header + reply tail can never exceed the total limit. */
export const PROMPT_TAIL_RESERVE_BYTES = 2048
/** Advisory only: beyond this the dock asks the user to split the batch (no hard block). */
export const PROMPT_SOFT_WARN_BYTES = 128 * 1024

/**
 * PromptLog / CommitTrace retention window (age AND count; whichever hits first).
 * These are caps, not targets. Users may lower them in Settings; raising the
 * caps needs a storage-layering design for the single-JSON Host store, so the
 * ranges below are the hard ceiling for now.
 */
export const PROMPT_RETENTION_DEFAULT_DAYS = 30
export const PROMPT_RETENTION_DAYS_RANGE = { min: 7, max: 30 }
export const PROMPT_RETENTION_DEFAULT_ROWS = 1000
export const PROMPT_RETENTION_ROWS_RANGE = { min: 200, max: 1000 }

// Section texts and the length bound live in the domain composer; the store
// re-exports them so the prefs layer keeps one source of truth.
export { DEFAULT_TAIL_TEXTS, TAIL_TEXT_MAX } from '../domain/prompt.js'

/**
 * @typedef {object} TurnActionSessionState
 * @property {number} [version]
 * @property {string} sessionId
 * @property {number} scannedThroughSeq
 * @property {number} scannedAt
 * @property {Array<object>} items
 */

export const TURN_ACTIONS_MAX_ITEMS_PER_SESSION = 500

export const DEFAULT_PREFS = {
  lastWorkspace: null,
  /** @type {boolean} */
  includeTextHeuristic: false,
  /** @type {StartSessionBehavior} */
  startSessionBehavior: 'prefill',
  /** @type {InheritScope} */
  inheritScope: 'workspace',
  /** @type {DraftDefaultVisibility} */
  draftDefaultVisibility: 'workspace',
  /** @type {SequentialCostHint} */
  sequentialCostHint: 'threshold',
  /** @type {ComposerRowsOption} */
  composerRows: 4,
  /** @type {ArchivedHistoryHeight} */
  archivedHistoryHeight: 'half',
  /** @type {PromptTail} */
  promptTail: 'standard',
  /**
   * Editable reply-contract sections (A/B/C). Defaults mirror
   * `DEFAULT_TAIL_TEXTS` in `src/domain/prompt.js`; empty = omit the section.
   */
  promptTailTextA: DEFAULT_TAIL_TEXTS.a,
  promptTailTextB: DEFAULT_TAIL_TEXTS.b,
  promptTailTextC: DEFAULT_TAIL_TEXTS.c,
  /** Max UTF-8 bytes of one finding body when submitting (default 8 KB). */
  promptMaxEntryBytes: PROMPT_ENTRY_BYTES_DEFAULT,
  /** Max UTF-8 bytes of one composed prompt (combined message / one sequential item). */
  promptMaxBytes: PROMPT_TOTAL_BYTES_DEFAULT,
  /** PromptLog / CommitTrace retention: age in days and max rows (both caps). */
  promptLogRetentionDays: PROMPT_RETENTION_DEFAULT_DAYS,
  promptLogRetentionRows: PROMPT_RETENTION_DEFAULT_ROWS,
  /**
   * Finding tag catalog (4 presets + up to 6 custom). Each tag carries the
   * editable guidance that `buildTagFramework` injects into the prompt.
   * Stored in prefs because labels are user content, not locale strings.
   */
  findingTags: DEFAULT_TAGS,
}

/**
 * Clamp the retention window from prefs. The client prune path and the Host
 * prune path both call this so memory and disk agree on the same window.
 * @param {object|null|undefined} prefs
 * @returns {{days:number, rows:number, maxAgeMs:number, maxCount:number}}
 */
export function retentionWindowFromPrefs(prefs) {
  const src = prefs && typeof prefs === 'object' ? prefs : {}
  const clamp = (value, fallback, range) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(range.max, Math.max(range.min, Math.round(n)))
  }
  const days = clamp(src.promptLogRetentionDays, PROMPT_RETENTION_DEFAULT_DAYS, PROMPT_RETENTION_DAYS_RANGE)
  const rows = clamp(src.promptLogRetentionRows, PROMPT_RETENTION_DEFAULT_ROWS, PROMPT_RETENTION_ROWS_RANGE)
  return { days, rows, maxAgeMs: days * 24 * 3600 * 1000, maxCount: rows }
}

/**
 * @param {string} workspaceKey absolute workspace path
 * @returns {string} storage-key-safe segment
 */
export function workspaceKeyPart(workspaceKey) {
  return encodeURIComponent(workspaceKey)
}

/**
 * Host store schema version. Bumped whenever a new top-level bucket is added
 * so older builds cannot silently drop it (`distillRuns`/`distillPlans`/
 * `distillFingerprints` require v3; `turnActions` requires v4). A file written
 * by a newer build is treated as read-only instead of being rewritten with
 * unknown buckets lost.
 * @type {4}
 */
export const HOST_STATE_VERSION = 4

/**
 * Retention windows for the Finding-Distillation buckets (spec §13.1).
 * `distillPlans` follows its run, so it has no independent retention.
 */
export const DISTILL_RETENTION = Object.freeze({
  runs: Object.freeze({ maxAgeMs: 90 * 24 * 3600 * 1000, maxCount: 100 }),
  fingerprints: Object.freeze({ maxAgeMs: 365 * 24 * 3600 * 1000, maxCount: 5000 }),
})

/** Bucket names that every dump/import/clear/verify path must carry. */
export const DISTILL_BUCKETS = Object.freeze(['distillRuns', 'distillPlans', 'distillFingerprints'])
