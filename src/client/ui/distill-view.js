/**
 * DistillView — the reviews Tab (「手账精炼」) state machine of the Desk.
 *
 * Design contract (2026-11-11 UX rework):
 * - One page header carries the title, a one-line scope subtitle and the
 *   phase's primary action at the top-right (start / back). The action is never
 *   duplicated at the bottom of a list.
 * - The config body is a card grid (`repeat(auto-fill, minmax(260px, 1fr))`)
 *   with hairline borders only: session title, the
 *   `N 条手账 · M 条日志` material readout, a right-aligned relative time and the
 *   archived badge. Selection keeps the shipped language: a
 *   `--pd-status-idle` left bar plus a `--pd-bg-panel` wash (the host accent
 *   token resolves to white in this build's dark theme, so it is banned for
 *   selection). Cards toggle on click and on the keyboard.
 * - Once 3~7 sessions are selected the page runs a debounced (400 ms) material
 *   pre-check against `GET api/punch-desk/distill-estimate`. A superseded
 *   request is aborted. A failed or empty pre-check only reports
 *   `distill.view.config.estimateFailed` and never blocks the start action:
 *   there is no fabricated three-line "cost card".
 * - Running is a semantic timeline (`run.progress.log`, newest first, the latest
 *   12 `HH:mm · stage · message` rows) with the thin bar, the stage name and the
 *   elapsed time kept. The newest row is highlighted (`logLatest`) and the
 *   caption says these rows are the stage's results (`timelineHint`); a log
 *   longer than the window offers `logMore` ({count}) / `logLess` to expand and
 *   collapse it. Cancelling is a two-step confirmation: the first click writes
 *   nothing, it only reveals `cancelConfirm` + `cancelYes` / `cancelNo`.
 * - A failed / cancelled / stale run keeps a `distill.view.running.retry`
 *   entry that re-posts the SAME batch (`run.sessions`) through
 *   `POST api/punch-desk/distill-run` — never an empty fresh config.
 * - History rows show a localized status badge, the session count, the relative
 *   time and an icon-only delete button guarded by a two-step confirmation
 *   (`history.deleteConfirm` + `deleteYes` / `deleteNo`, first click writes
 *   nothing) that posts `POST api/punch-desk/distill-delete {runId}`. Success
 *   removes the row locally and reports `history.deleted`; failure reports
 *   `history.deleteFailed` plus the `distill.view.error.code.*` label. An
 *   applied row keeps the `history.openResult` entry into the result page.
 * - The result page is PINNED: entering it (apply callback or history
 *   openResult) sets `pinnedRunId`, so the background `distill-run` poll can
 *   never navigate away from a record the user is reading. It shows the run
 *   title, `result.batchMeta`, `result.appliedAt`, `result.pinHint` and
 *   `result.back` (clear the pin → config). The body mounts the desk-injected
 *   confirmation page as the written-back ledger (`applied: run.applyResult ??
 *   applyPayload`, `onBack`), then `view.usage`, then `result.summaryHeading`
 *   with the session summaries (the existing `renderSummary` slot). A pinned run
 *   that disappears from the Host list returns to config with `result.notFound`.
 * - Candidate cards carry the "already distilled" marker derived from applied
 *   history runs: a `refinedBadge` ({count}) with `refinedBadgeTip`, plus the
 *   `refinedLast` ({time}) / `refinedFiles` ({files}) second row. Sessions stay
 *   selectable — the marker only says they already produced takeaways.
 * - The result page renders the `run.usage` block when present
 *   (`usage.title` / `calls` / `tokensIn` / `tokensOut` / `total`; a missing
 *   field omits its row).
 * - The pending phase keeps mounting the desk-injected confirmation page
 *   (`createDistillConfirm` in ./distill-confirm.js) with unchanged props
 *   { run, plan, workspaceId, onApplied }; this module never imports that file.
 *
 * Third UX round additions:
 * - Config is ONE grid with two PEER panels: the session builder on the left
 *   and the read-only 「精炼概览」 on the right
 *   (`minmax(0, 1fr) minmax(260px, 320px)`, 10px gap; single column under
 *   880px). Both use the same panel head (icon + title + count). The overview
 *   derives cumulative batches / files / changes and the three newest runs from
 *   `historyRuns` (`run.applyResult` first, legacy `plan.stats` fallback), with
 *   the empty state 「还没有精炼记录」.
 * - Running is two columns: stage / progress / cancel on the left
 *   (`minmax(220px, 300px)`) and the result timeline filling the right
 *   (`minmax(0, 1fr)`); under 760px it collapses to one column. The timeline is
 *   never capped to a narrow centered box and every row may wrap.
 * - Every explicit back path (result header, applied ledger `onBack`, pending
 *   confirmation `onBack`) lands on config and clears the pin / history
 *   transients. The landed run id is recorded in `suppressLandingRef`; while the
 *   poll still reports it, the view refreshes `historyRuns` / `activeRun` but
 *   never changes `phase` (a new start / summary view clears the record).
 *
 * The batch source must already be workspace-scoped by desk.js: this view
 * never filters by workspace itself and never sees another workspace's
 * sessions.
 *
 * State machine (five phases):
 *   config → running → pending → result, plus a side-viewable `history`
 *   - config:  batch configuration (multi-select 3~7 sessions, archived toggle,
 *              live selection summary, debounced material pre-check)
 *   - running: stage + semantic timeline + elapsed + two-step cancel; polls
 *              GET api/punch-desk/distill-run?workspaceId= for the non-terminal
 *              run. The same mount-time GET doubles as refresh recovery.
 *   - pending: awaiting confirmation (injected confirm page)
 *   - result:  result page shell + usage block; calls the `renderSummary` slot
 *   - history: past runs of this workspace (status / sessions / time / delete)
 *
 * Contract notes (mirrors the Host routes in index.js / distill-host.js):
 *   - GET api/punch-desk/distill-estimate?workspaceId=&sessions=a,b,c
 *   - POST api/punch-desk/distill-run body { workspaceId, sessions }
 *   - POST api/punch-desk/distill-cancel body { runId }
 *   - POST api/punch-desk/distill-delete body { runId }
 *   Host errors are read from either `{ code, error }` (numeric HTTP status) or
 *   `{ error: { code, message } }` (business error at HTTP 200).
 *
 * React is injected through the factory ({ h, React, services, t }); never
 * import react here. Visual language: Nord tokens (./nord.js) and Phosphor
 * vector icons (./icons.js via bits.js); no host DOM selectors.
 *
 * Locale keys this module references through the injected translate function
 * (zh/en pairs live in src/locale.js; the module never imports it):
 *   distill.view.title
 *   distill.view.subtitle
 *   distill.view.config.listTitle
 *   distill.view.config.showArchivedToggle          ({count} placeholder)
 *   distill.view.config.showArchivedHint
 *   distill.view.config.selectedCount               ({count} placeholder)
 *   distill.view.config.summaryFindings             ({count} placeholder)
 *   distill.view.config.summaryLogs                 ({count} placeholder)
 *   distill.view.config.start
 *   distill.view.config.startHint
 *   distill.view.config.untitled
 *   distill.view.config.archivedBadge
 *   distill.view.config.archivedBadgeTip
 *   distill.view.config.materialTip
 *   distill.view.config.findingsUnit
 *   distill.view.config.promptLogsUnit
 *   distill.view.config.noMaterial
 *   distill.view.config.startNoWorkspace
 *   distill.view.config.startNeedSessions
 *   distill.view.config.startTooMany
 *   distill.view.config.empty
 *   distill.view.config.emptyHint
 *   distill.view.config.estimateLoading
 *   distill.view.config.estimate                   ({materials} {tokens})
 *   distill.view.config.estimatePercent            ({percent} placeholder)
 *   distill.view.config.estimateTruncated          ({tokens} placeholder)
 *   distill.view.config.estimateModel              ({model} placeholder)
 *   distill.view.config.estimateFailed
 *   distill.view.config.estimateCalls              ({stage1} {stage2})
 *   distill.view.config.refinedBadge               ({count} placeholder)
 *   distill.view.config.refinedBadgeTip
 *   distill.view.config.refinedLast                ({time} placeholder)
 *   distill.view.config.refinedFiles               ({files} placeholder)
 *   distill.overview.title
 *   distill.overview.totals                        ({batches} {files} {changes})
 *   distill.overview.totalsEmpty
 *   distill.overview.recent
 *   distill.overview.empty
 *   distill.overview.applied                       ({files} placeholder)
 *   distill.overview.notApplied
 *   distill.overview.tokens                        ({tokens} placeholder)
 *   distill.overview.hint
 *   distill.view.running.heading
 *   distill.view.running.stage
 *   distill.view.running.elapsed                   ({duration} placeholder)
 *   distill.view.running.logTitle
 *   distill.view.running.logEmpty
 *   distill.view.running.logMore                   ({count} placeholder)
 *   distill.view.running.logLess
 *   distill.view.running.logLatest
 *   distill.view.running.timelineHint
 *   distill.view.running.cancel
 *   distill.view.running.cancelConfirm
 *   distill.view.running.cancelYes
 *   distill.view.running.cancelNo
 *   distill.view.running.retry
 *   distill.view.pending.heading
 *   distill.view.pending.placeholder
 *   distill.view.result.heading
 *   distill.view.result.placeholder
 *   distill.view.result.back
 *   distill.view.result.summaryHeading
 *   distill.view.result.pinHint
 *   distill.view.result.appliedAt                  ({time} placeholder)
 *   distill.view.result.batchMeta                  ({sessions} {files} {changes} placeholders)
 *   distill.view.result.notFound
 *   distill.confirm.applied.statsMissing (legacy applied run without stats)
 *   distill.view.usage.title
 *   distill.view.usage.calls                        ({count} placeholder)
 *   distill.view.usage.tokensIn                     ({tokens} placeholder)
 *   distill.view.usage.tokensOut                    ({tokens} placeholder)
 *   distill.view.usage.total                        ({tokens} placeholder)
 *   distill.view.history.heading
 *   distill.view.history.empty
 *   distill.view.history.back
 *   distill.view.history.runRow                    ({count} placeholder)
 *   distill.view.history.sessions                  ({count} placeholder)
 *   distill.view.history.delete
 *   distill.view.history.deleteConfirm
 *   distill.view.history.deleteYes
 *   distill.view.history.deleteNo
 *   distill.view.history.deleted
 *   distill.view.history.deleteFailed
 *   distill.view.history.openResult
 *   distill.view.run.status.queued
 *   distill.view.run.status.snapshotting
 *   distill.view.run.status.analyzing
 *   distill.view.run.status.validating
 *   distill.view.run.status.applying
 *   distill.view.run.status.ready
 *   distill.view.run.status.applied
 *   distill.view.run.status.failed
 *   distill.view.run.status.canceled
 *   distill.view.run.status.stale
 *   distill.view.run.status.superseded
 *   distill.view.time.justNow
 *   distill.view.time.minutesAgo
 *   distill.view.time.hoursAgo
 *   distill.view.time.daysAgo
 *   distill.view.error.startFailed
 *   distill.view.error.runFailed
 *   distill.view.error.runCanceled
 *   distill.view.error.runStale
 *   distill.view.error.runSuperseded
 *   distill.view.error.code.CONTEXT_WINDOW_UNAVAILABLE
 *   distill.view.error.code.RUN_ALREADY_ACTIVE
 *   distill.view.error.code.ANALYZER_UNAVAILABLE
 *   distill.view.error.code.ANALYZER_TIMEOUT
 *   distill.view.error.code.INVALID_BATCH
 *   distill.view.error.code.INVALID_REQUEST
 *   distill.view.error.code.INVALID_WORKSPACE_ID
 *   distill.view.error.code.WORKSPACE_UNAVAILABLE
 *   distill.view.error.code.RUN_NOT_READY
 *   distill.view.error.code.RUN_NOT_FOUND
 *   distill.view.error.code.REVIEW_NOT_ALLOWED
 *   distill.view.error.code.INVALID_SESSIONS
 *   distill.view.stage.snapshotting
 *   distill.view.stage.stage1
 *   distill.view.stage.stage2
 *   distill.view.stage.validating
 * Cancel feedback reuses the EXISTING keys: distill.lock.cancelRequested,
 * distill.lock.canceled, distill.lock.tooLate, distill.lock.cancelFailed.
 */

import {
  MAX_BATCH_SESSIONS,
  MIN_BATCH_SESSIONS,
  getActiveRun,
} from '../../domain/distill-run.js'
import { countText, createBits, formatLocalDateTime, formatLocalTime, suppressesRowToggle } from './bits.js'
import { NORD } from './nord.js'

/** Poll cadence of the running-state run list query (ms). */
export const DISTILL_VIEW_POLL_MS = 2500

/** Debounce applied to the material pre-check while the batch is being built. */
export const DISTILL_ESTIMATE_DEBOUNCE_MS = 400

/** Timeline rows rendered before the log must be expanded (newest first). */
export const DISTILL_TIMELINE_DEFAULT_ROWS = 12

/**
 * Backwards-compatible alias of the visible timeline window. Kept because the
 * first-round tests import it; the window is a default, not a hard cap — the
 * `logMore` / `logLess` toggle reveals the full `run.progress.log`.
 */
export const DISTILL_TIMELINE_MAX_ROWS = DISTILL_TIMELINE_DEFAULT_ROWS

/** Map of Host error codes to their locale keys (start / cancel / delete). */
const ERROR_CODE_KEYS = Object.freeze({
  CONTEXT_WINDOW_UNAVAILABLE: 'distill.view.error.code.CONTEXT_WINDOW_UNAVAILABLE',
  RUN_ALREADY_ACTIVE: 'distill.view.error.code.RUN_ALREADY_ACTIVE',
  ANALYZER_UNAVAILABLE: 'distill.view.error.code.ANALYZER_UNAVAILABLE',
  ANALYZER_TIMEOUT: 'distill.view.error.code.ANALYZER_TIMEOUT',
  INVALID_BATCH: 'distill.view.error.code.INVALID_BATCH',
  INVALID_REQUEST: 'distill.view.error.code.INVALID_REQUEST',
  INVALID_WORKSPACE_ID: 'distill.view.error.code.INVALID_WORKSPACE_ID',
  WORKSPACE_UNAVAILABLE: 'distill.view.error.code.WORKSPACE_UNAVAILABLE',
  RUN_NOT_READY: 'distill.view.error.code.RUN_NOT_READY',
  RUN_NOT_FOUND: 'distill.view.error.code.RUN_NOT_FOUND',
  REVIEW_NOT_ALLOWED: 'distill.view.error.code.REVIEW_NOT_ALLOWED',
  INVALID_SESSIONS: 'distill.view.error.code.INVALID_SESSIONS',
})

/** Labels for a run that landed in a terminal non-applied state. */
const RUN_FAILURE_KEYS = Object.freeze({
  failed: 'distill.view.error.runFailed',
  canceled: 'distill.view.error.runCanceled',
  stale: 'distill.view.error.runStale',
  superseded: 'distill.view.error.runSuperseded',
})

/**
 * Fallback label for an unmapped Host code. The old fallback was
 * RUN_ALREADY_ACTIVE, so an analyzer/wiring failure was reported as
 * "本工作区已有进行中的精炼任务" even when no run existed. Never do that again:
 * unknown codes surface the host message verbatim.
 */
const START_ERROR_FALLBACK = 'distill.view.error.startFailed'

/** Map of cancel outcomes to existing locale keys (already shipped). */
const CANCEL_NOTE_KEYS = Object.freeze({
  cancelRequested: 'distill.lock.cancelRequested',
  canceled: 'distill.lock.canceled',
  too_late: 'distill.lock.tooLate',
})

/** Human-readable labels for every distillation run status (history rows). */
const RUN_STATUS_KEYS = Object.freeze({
  queued: 'distill.view.run.status.queued',
  snapshotting: 'distill.view.run.status.snapshotting',
  analyzing: 'distill.view.run.status.analyzing',
  validating: 'distill.view.run.status.validating',
  applying: 'distill.view.run.status.applying',
  ready: 'distill.view.run.status.ready',
  applied: 'distill.view.run.status.applied',
  failed: 'distill.view.run.status.failed',
  canceled: 'distill.view.run.status.canceled',
  stale: 'distill.view.run.status.stale',
  superseded: 'distill.view.run.status.superseded',
})

/** Badge tone per run status: only applied reads as success. */
const RUN_STATUS_TONES = Object.freeze({
  applied: 'success',
  failed: 'danger',
  ready: 'info',
})

/** Stages that carry a locale label (running stage + timeline rows). */
const STAGE_KEYS = Object.freeze({
  snapshotting: 'distill.view.stage.snapshotting',
  stage1: 'distill.view.stage.stage1',
  stage2: 'distill.view.stage.stage2',
  validating: 'distill.view.stage.validating',
  applying: 'distill.view.stage.applying',
})

/** Only terminal runs may be deleted (mirrors the Host guard). */
const DELETABLE_RUN_STATUSES = new Set(['applied', 'failed', 'canceled', 'stale', 'superseded'])

/** Run statuses that offer the "start over" entry. */
const RETRYABLE_RUN_STATUSES = new Set(['failed', 'canceled', 'stale', 'superseded'])

const runStatusLabel = (status, translate) => {
  const key = RUN_STATUS_KEYS[status]
  return key ? translate(key) : String(status ?? '')
}

/** Seconds-vs-milliseconds tolerant epoch normalisation. */
function normalizeEpoch(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return NaN
  return n < 1e12 ? n * 1000 : n
}

/**
 * Localized "3 天前" style timestamp for candidate cards and history entries.
 * Falls back to the absolute date once the distance exceeds a month.
 *
 * @param {number|string} value epoch seconds or milliseconds
 * @param {(key: string) => string} translate
 * @param {number} [now] injectable clock for deterministic tests
 * @returns {string}
 */
export function formatRelativeTime(value, translate, now = Date.now()) {
  const ms = normalizeEpoch(value)
  if (!Number.isFinite(ms)) return ''
  const diff = Math.max(0, now - ms)
  if (diff < 60 * 1000) return translate('distill.view.time.justNow')
  const minutes = Math.floor(diff / (60 * 1000))
  if (minutes < 60) return countText(translate('distill.view.time.minutesAgo'), minutes)
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return countText(translate('distill.view.time.hoursAgo'), hours)
  const days = Math.floor(hours / 24)
  if (days < 30) return countText(translate('distill.view.time.daysAgo'), days)
  return formatLocalDateTime(ms).slice(0, 10)
}

/**
 * Locale-free elapsed duration. Minutes:seconds below one hour, then
 * hours:minutes:seconds. No unit words are emitted, so it needs no new key.
 *
 * @param {number} value elapsed milliseconds
 * @returns {string} '' when the value is not a finite non-negative number
 */
export function formatElapsedDuration(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return ''
  const totalSeconds = Math.floor(n / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
  return `${minutes}:${ss}`
}

/**
 * Fill a locale template with named placeholders (`{materials}`, `{tokens}`,
 * `{percent}`, `{model}`, `{stage1}`, `{stage2}`, `{duration}`). Unknown
 * placeholders are left untouched so a template/key mismatch stays visible.
 * @param {string} template
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function fillLocaleTemplate(template, vars = {}) {
  if (typeof template !== 'string') return ''
  return template.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : match
  ))
}

/**
 * Normalize `run.sessions` into plain session ids. The domain stores
 * `{ sessionId, title?, archived }`; older/hand-written variants may carry bare
 * id strings. Used by the "start over" action so it re-runs the SAME batch.
 * @param {object} run
 * @returns {string[]}
 */
export function normalizeRunSessionIds(run) {
  const list = Array.isArray(run?.sessions) ? run.sessions : []
  return list.map((entry) => {
    if (typeof entry === 'string') return entry
    if (entry && typeof entry === 'object' && typeof entry.sessionId === 'string') return entry.sessionId
    return ''
  }).filter(Boolean)
}

/**
 * Aggregate the "already distilled" marker of every session from applied
 * history runs.
 *
 * A session keeps its marker when it took part in at least one run with
 * `status === 'applied'`; it can still be selected again for a later batch.
 * `files` sums `run.applyResult.applied.length` across those runs (older runs
 * without the persisted apply record contribute 0, never a fabricated count).
 *
 * @param {Array<object>} [runs] run list as returned by GET distill-run
 * @returns {Map<string, {count: number, lastAt: number|null, files: number}>}
 */
export function deriveRefinedMarkers(runs) {
  const markers = new Map()
  const list = Array.isArray(runs) ? runs : []
  for (const run of list) {
    if (!run || typeof run !== 'object' || run.status !== 'applied') continue
    const sessionIds = new Set(normalizeRunSessionIds(run))
    if (sessionIds.size === 0) continue
    const at = normalizeEpoch(run.appliedAt ?? run.updatedAt ?? run.createdAt)
    const appliedList = Array.isArray(run.applyResult?.applied) ? run.applyResult.applied : []
    const files = appliedList.length
    for (const sessionId of sessionIds) {
      const previous = markers.get(sessionId)
      if (!previous) {
        markers.set(sessionId, {
          count: 1,
          lastAt: Number.isFinite(at) ? at : null,
          files,
        })
        continue
      }
      previous.count += 1
      previous.files += files
      if (Number.isFinite(at) && (previous.lastAt === null || at > previous.lastAt)) {
        previous.lastAt = at
      }
    }
  }
  return markers
}

/**
 * Aggregate the read-only "精炼概览" (distillation overview) of this workspace.
 *
 * - `batches` counts every run the Host kept for the workspace (including failed
 *   ones: the user asked how many batches ran, not how many succeeded);
 * - `files` / `changes` / `tokens` are cumulative facts of the applied runs only,
 *   preferring the persisted `run.applyResult` (actual write-back) and falling
 *   back to the deterministic plan stats for older records;
 * - `recent` holds at most the three newest runs, sorted by `appliedAt` →
 *   `updatedAt` → `createdAt`.
 *
 * The same data feeds the config page's peer overview panel; no extra Host route
 * is involved (the 2.5s `distill-run` poll already returns the full list).
 *
 * @param {Array<object>} [runs] run list as returned by GET distill-run
 * @returns {{batches: number, appliedCount: number, files: number, changes: number,
 *   tokens: number, recent: Array<object>}}
 */
export function deriveDistillOverview(runs) {
  const list = Array.isArray(runs)
    ? runs.filter((run) => run && typeof run === 'object')
    : []
  const applied = list.filter((run) => run.status === 'applied')
  let files = 0
  let changes = 0
  let tokens = 0
  for (const run of applied) {
    const result = run.applyResult && typeof run.applyResult === 'object' ? run.applyResult : null
    files += result && Array.isArray(result.applied)
      ? result.applied.length
      : (Number(run.plan?.stats?.targets) || 0)
    changes += result && Array.isArray(result.selectedChangeIds) && result.selectedChangeIds.length > 0
      ? result.selectedChangeIds.length
      : (Number(run.plan?.stats?.changes) || 0)
    tokens += Number(run.usage?.totalTokens) || 0
  }
  const stampOf = (run) => {
    const value = normalizeEpoch(run?.appliedAt ?? run?.updatedAt ?? run?.createdAt)
    return Number.isFinite(value) ? value : 0
  }
  const recent = list
    .filter((run) => run.id && stampOf(run) > 0)
    .slice()
    .sort((left, right) => stampOf(right) - stampOf(left))
    .slice(0, 3)
  return { batches: list.length, appliedCount: applied.length, files, changes, tokens, recent }
}

/**
 * Read a Host error payload in both shipped shapes:
 * `{ code, error: 'message' }` and `{ error: { code, message } }`.
 * @param {any} data parsed response body
 * @param {{ status?: number, ok?: boolean }} [res]
 * @returns {{ code: string, message: string }}
 */
function readErrorPayload(data, res) {
  const error = data && typeof data === 'object' ? data.error : null
  const nested = error && typeof error === 'object' ? error : null
  const code = typeof data?.code === 'string' && data.code
    ? data.code
    : (typeof nested?.code === 'string' && nested.code ? nested.code : `HTTP_${res?.status ?? 0}`)
  const message = typeof error === 'string'
    ? error
    : (typeof nested?.message === 'string' ? nested.message : '')
  return { code, message }
}

const TEXT_PRIMARY = `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`
const TEXT_SECONDARY = `var(--pd-text-secondary, var(--dsw-alias-label-secondary, ${NORD.nord4}))`
const TEXT_TERTIARY = `var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, ${NORD.nord3}))`
const BORDER_SUBTLE = `var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`
const ACCENT = `var(--pd-accent, var(--dsw-alias-button-primary-fill, ${NORD.nord8}))`
const DANGER = `var(--dsw-alias-state-error-primary, ${NORD.nord11})`
const WARN_TEXT = `var(--pd-status-warn-text, ${NORD.nord13})`
const SELECTED = `var(--pd-status-idle, ${NORD.nord10})`

const CONTAINER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  height: '100%',
  minHeight: 0,
  overflowY: 'auto',
  paddingRight: 4,
  boxSizing: 'border-box',
}

/* ---------------------------------------------------------------- header */

const HEADER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '2px 2px 10px',
  borderBottom: `1px solid ${BORDER_SUBTLE}`,
  // Sticky so the primary action and the batch readout never scroll away.
  position: 'sticky',
  top: 0,
  zIndex: 2,
  background: `var(--pd-bg-card, var(--dsw-alias-bg-layer-1, ${NORD.nord0}))`,
  flexShrink: 0,
}

const TITLE_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minWidth: 0,
}

const TITLE_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  fontSize: 15,
  fontWeight: 700,
  letterSpacing: '0.01em',
  color: TEXT_PRIMARY,
}

/** Header right edge: the phase's primary action lives here. */
const HEADER_ACTIONS_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexShrink: 0,
}

const SUBTITLE_STYLE = {
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_TERTIARY,
}

/* ------------------------------------------------------------------ body */

const BODY_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
  padding: '12px 2px 16px',
}

const SECTION_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

/** Quiet section caption row: label on the left, control on the right. */
const CAPTION_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  minHeight: 24,
}

const CAPTION_STYLE = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.04em',
  color: TEXT_TERTIARY,
}

/* ------------------------------------------------------ config card grid */

/**
 * Card grid: auto-fill lanes of at least 260px. Cards are hairline surfaces —
 * no thick frame, no box-shadow (Zero Visual Noise).
 */
const CARD_GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
  gap: 10,
  alignItems: 'stretch',
}

const PANEL_BG = `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord1}))`

/**
 * Candidate card. Rhythm: 10~12px padding, 7px inner gap, 10px grid gap.
 * Hover and selection only use the plugin panel wash; the left 2px idle bar
 * marks selection (the host accent token resolves to white in this build's
 * dark theme, so it is banned here).
 */
const CARD_STYLE = (selectedState, hoveredState = false) => ({
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  gap: 7,
  padding: '10px 12px',
  borderRadius: 8,
  border: `1px solid ${selectedState ? SELECTED : BORDER_SUBTLE}`,
  borderLeftWidth: 2,
  borderLeftColor: selectedState ? SELECTED : BORDER_SUBTLE,
  background: selectedState || hoveredState ? PANEL_BG : 'transparent',
  transition: 'background 120ms ease, border-color 120ms ease',
  cursor: 'pointer',
  boxSizing: 'border-box',
  minWidth: 0,
})

/** The native checkbox stays in the DOM for a11y/keyboard state; the card is
 *  the visible hit area, so the input itself is visually hidden. */
const HIDDEN_INPUT_STYLE = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  border: 0,
  opacity: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  pointerEvents: 'none',
}

const CARD_HEAD_STYLE = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: 8,
  minWidth: 0,
}

const CARD_TITLE_STYLE = {
  flex: 1,
  minWidth: 0,
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.4,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: TEXT_PRIMARY,
}

const CARD_FOOT_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  minWidth: 0,
}

const CARD_META_STYLE = {
  flex: 1,
  minWidth: 0,
  fontSize: 10.5,
  lineHeight: 1.45,
  color: TEXT_TERTIARY,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const CARD_TIME_STYLE = {
  flexShrink: 0,
  fontSize: 10.5,
  lineHeight: 1.4,
  color: TEXT_TERTIARY,
  whiteSpace: 'nowrap',
}

/** Third card row: the applied-history marker (badge + last time + files). */
const CARD_REFINED_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  flexWrap: 'wrap',
  paddingTop: 2,
  borderTop: `1px solid ${BORDER_SUBTLE}`,
}

const CARD_REFINED_TEXT_STYLE = {
  fontSize: 10.5,
  lineHeight: 1.45,
  color: TEXT_TERTIARY,
  whiteSpace: 'nowrap',
}

/* --------------------------------------- config peer panels (sessions + overview) */

/**
 * Wide-screen hierarchy: the session builder and the distillation overview are
 * two PEER panels of one grid — not a horizontal banner above the page.
 * The inline columns are the canonical wide layout; `DISTILL_RESPONSIVE_CSS`
 * collapses it to a single column under 880px.
 */
const CONFIG_GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(260px, 320px)',
  gap: 10,
  alignItems: 'start',
  minWidth: 0,
}

const CONFIG_GRID_CLASS = 'pd-distill-config-grid'

/**
 * Without candidates there is no 2-column hierarchy to express: both panels
 * stack, so the page never shows an empty grid lane next to the overview.
 */
const CONFIG_STACK_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minWidth: 0,
}

/** Shared panel shell: no heavy card frame, just a touch of inner rhythm. */
const PANEL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  minWidth: 0,
}

/**
 * Shared panel header: icon + title + count on one hairline row. Both config
 * panels use it verbatim so they read as the same hierarchy level.
 */
const PANEL_HEAD_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  minHeight: 26,
  padding: '2px 2px 6px',
  borderBottom: `1px solid ${BORDER_SUBTLE}`,
  minWidth: 0,
}

/** Foldable panel head (the whole row toggles the panel); shared by both peers. */
const PANEL_HEAD_FOLD_STYLE = { ...PANEL_HEAD_STYLE, cursor: 'pointer' }

const PANEL_TITLE_STYLE = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: TEXT_SECONDARY,
  whiteSpace: 'nowrap',
}

const PANEL_COUNT_STYLE = {
  fontSize: 10.5,
  lineHeight: 1.4,
  color: TEXT_TERTIARY,
  fontVariantNumeric: 'tabular-nums',
}

const PANEL_HEAD_EXTRA_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginLeft: 'auto',
  flexShrink: 0,
}

const PANEL_BODY_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
}

const OVERVIEW_TOTALS_STYLE = {
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_SECONDARY,
  overflowWrap: 'anywhere',
}

const OVERVIEW_SECTION_TITLE_STYLE = {
  fontSize: 10,
  lineHeight: 1.4,
  fontWeight: 600,
  letterSpacing: '0.03em',
  color: TEXT_TERTIARY,
}

const OVERVIEW_ROW_STYLE = (isLast) => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  padding: '4px 0',
  borderBottom: isLast ? 'none' : `1px solid ${BORDER_SUBTLE}`,
  minWidth: 0,
})

const OVERVIEW_ROW_TEXT_STYLE = {
  fontSize: 10.5,
  lineHeight: 1.45,
  color: TEXT_SECONDARY,
  overflowWrap: 'anywhere',
}

const OVERVIEW_ROW_TIME_STYLE = {
  marginLeft: 'auto',
  flexShrink: 0,
  fontSize: 10,
  lineHeight: 1.4,
  color: TEXT_TERTIARY,
  whiteSpace: 'nowrap',
}

const OVERVIEW_HINT_STYLE = {
  fontSize: 9.5,
  lineHeight: 1.5,
  color: TEXT_TERTIARY,
  overflowWrap: 'anywhere',
}

/* ------------------------------------------------------- config batch bar */

/**
 * Sticky command bar of the config phase: selection / material / pre-check on
 * the left, the primary start action at the right. It replaces the loose
 * summary line that used to sit under the grid.
 */
const BATCH_BAR_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  padding: '8px 10px',
  borderRadius: 8,
  border: `1px solid ${BORDER_SUBTLE}`,
  background: PANEL_BG,
}

const BATCH_BAR_MAIN_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  flex: 1,
  minWidth: 0,
}

const SUMMARY_STYLE = (valid) => ({
  fontSize: 11,
  lineHeight: 1.5,
  color: valid ? TEXT_SECONDARY : WARN_TEXT,
})

/* --------------------------------------------------------------- estimate */

const ESTIMATE_WRAP_STYLE = {
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'center',
  gap: '2px 12px',
  flexWrap: 'wrap',
  marginTop: 1,
}

const ESTIMATE_LINE_STYLE = (warn = false) => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  fontSize: 10.5,
  lineHeight: 1.5,
  color: warn ? WARN_TEXT : TEXT_TERTIARY,
})

/* ------------------------------------------------------------ error/empty */

const ERROR_BANNER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 6,
  padding: '8px 10px',
  borderRadius: 6,
  border: `1px solid ${DANGER}`,
  color: DANGER,
  fontSize: 12,
  fontWeight: 600,
}

const ERROR_BANNER_TEXT_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const EMPTY_WRAP_STYLE = {
  padding: '10px 0 4px',
}

const EMPTY_HINT_STYLE = {
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_TERTIARY,
}

/* --------------------------------------------------------------- running */

const RUNNING_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '18px 2px',
}

/**
 * Running page hierarchy: stage / progress / cancel on the left, the result
 * timeline filling the whole right column. Under 760px the grid collapses to a
 * single column (`DISTILL_RESPONSIVE_CSS`); the timeline itself is never capped
 * to a narrow, centered container.
 */
const RUNNING_GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'minmax(220px, 300px) minmax(0, 1fr)',
  gap: 16,
  alignItems: 'start',
  minWidth: 0,
  width: '100%',
}

const RUNNING_GRID_CLASS = 'pd-distill-running-grid'

const RUNNING_LEFT_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minWidth: 0,
}

const RUNNING_TIMELINE_PANEL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 0,
  width: '100%',
}

/**
 * Narrow screens collapse both two-column grids to a single column. Inline
 * styles cannot carry media queries, so the columns are declared inline (the
 * canonical wide layout) and this scoped rule with `!important` wins below the
 * breakpoints.
 */
const DISTILL_RESPONSIVE_CSS = `
@media (max-width: 880px) {
  .${CONFIG_GRID_CLASS} { grid-template-columns: minmax(0, 1fr) !important; }
}
@media (max-width: 760px) {
  .${RUNNING_GRID_CLASS} { grid-template-columns: minmax(0, 1fr) !important; }
}
`

const RUNNING_TITLE_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 13,
  fontWeight: 600,
  color: TEXT_PRIMARY,
}

const RUNNING_META_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_TERTIARY,
}

const PROGRESS_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
}

const PROGRESS_TRACK_STYLE = {
  position: 'relative',
  flex: 1,
  height: 4,
  borderRadius: 2,
  overflow: 'hidden',
  background: `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord2}))`,
}

const PROGRESS_FILL_STYLE = (ratio) => ({
  position: 'absolute',
  inset: 0,
  width: `${Math.max(0, Math.min(1, ratio)) * 100}%`,
  borderRadius: 2,
  background: ACCENT,
  transition: 'width 0.3s ease',
})

const PROGRESS_COUNT_STYLE = {
  flexShrink: 0,
  fontSize: 11,
  lineHeight: 1.4,
  color: TEXT_TERTIARY,
  fontVariantNumeric: 'tabular-nums',
}

const TIMELINE_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  width: '100%',
  minWidth: 0,
}

const TIMELINE_ROW_STYLE = (isLast, isLatest = false) => ({
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  padding: isLatest ? '6px 8px' : '5px 8px',
  borderRadius: isLatest ? 6 : 0,
  background: isLatest ? PANEL_BG : 'transparent',
  borderBottom: isLast ? 'none' : `1px solid ${BORDER_SUBTLE}`,
})

const TIMELINE_TIME_STYLE = {
  flexShrink: 0,
  width: 38,
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_TERTIARY,
  fontVariantNumeric: 'tabular-nums',
}

const TIMELINE_STAGE_STYLE = {
  flexShrink: 0,
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_SECONDARY,
}

const TIMELINE_MESSAGE_STYLE = (isLatest = false) => ({
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.5,
  fontWeight: isLatest ? 500 : 400,
  color: isLatest ? TEXT_PRIMARY : TEXT_SECONDARY,
  overflowWrap: 'anywhere',
})

const TIMELINE_LATEST_STYLE = {
  flexShrink: 0,
  fontSize: 10,
  lineHeight: 1.4,
  letterSpacing: '0.03em',
  color: TEXT_TERTIARY,
  whiteSpace: 'nowrap',
}

const LOG_TOGGLE_STYLE = {
  display: 'flex',
  alignItems: 'center',
  paddingTop: 4,
}

const CANCEL_CONFIRM_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 6,
  padding: '8px 0 0',
  maxWidth: 520,
}

const CANCEL_CONFIRM_TEXT_STYLE = {
  fontSize: 11,
  lineHeight: 1.5,
  color: WARN_TEXT,
}

/* --------------------------------------------------------------- history */

const HISTORY_ROW_STYLE = (isLast) => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 10,
  padding: '9px 8px',
  borderBottom: isLast ? 'none' : `1px solid ${BORDER_SUBTLE}`,
})

const HISTORY_MAIN_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  flex: 1,
  minWidth: 0,
}

const HISTORY_TITLE_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  flexWrap: 'wrap',
}

const HISTORY_META_STYLE = {
  fontSize: 11,
  lineHeight: 1.4,
  color: TEXT_TERTIARY,
}

const HISTORY_ACTIONS_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 0,
}

const CONFIRM_STRIP_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  flexWrap: 'wrap',
  padding: '2px 0 0',
}

const CONFIRM_TEXT_STYLE = {
  fontSize: 11,
  lineHeight: 1.5,
  color: WARN_TEXT,
  flex: 1,
  minWidth: 0,
}

const HISTORY_NOTE_STYLE = (kind) => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  lineHeight: 1.5,
  color: kind === 'deleted' ? TEXT_SECONDARY : DANGER,
})

/* ------------------------------------------------------------- pending */

/** Phase container: the confirmation page plus its secondary action row. */
const PENDING_PHASE_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
}

/** Secondary park/abandon row under the confirmation page. */
const PENDING_ACTIONS_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
  paddingTop: 8,
  borderTop: `1px solid ${BORDER_SUBTLE}`,
}

/** Two-step abandon strip: the confirmation text plus yes/no. */
const PENDING_CONFIRM_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 10px',
  border: `1px solid ${BORDER_SUBTLE}`,
  borderRadius: 6,
}

const PENDING_HINT_STYLE = {
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_TERTIARY,
  flex: 1,
  minWidth: 0,
}

const PENDING_ERROR_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
  lineHeight: 1.5,
  color: DANGER,
  flex: 1,
  minWidth: 0,
}

/* ----------------------------------------------------------------- usage */

const USAGE_WRAP_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
}

const USAGE_GRID_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
}

const USAGE_CELL_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 6px',
  borderRadius: 4,
  border: `1px solid ${BORDER_SUBTLE}`,
  fontSize: 11,
  lineHeight: '16px',
  color: TEXT_SECONDARY,
}

/* ---------------------------------------------------------------- result */

const RESULT_TOP_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  paddingBottom: 8,
  borderBottom: `1px solid ${BORDER_SUBTLE}`,
}

const RESULT_TITLE_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  minWidth: 0,
}

const RESULT_HEADING_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 600,
  color: TEXT_PRIMARY,
}

const RESULT_META_STYLE = {
  fontSize: 11,
  lineHeight: 1.5,
  color: TEXT_SECONDARY,
}

const RESULT_PIN_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 10.5,
  lineHeight: 1.5,
  color: TEXT_TERTIARY,
}

/** Config-page note after a pinned record vanished from the Host list. */
const RESULT_NOTE_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 10px',
  borderRadius: 6,
  border: `1px solid ${WARN_TEXT}`,
  fontSize: 11,
  lineHeight: 1.5,
  color: WARN_TEXT,
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)

const EMPTY_SOURCE = Object.freeze({ sessions: [], findings: [], promptLogs: [], archivedSessionIds: [] })

function normalizeSource(source) {
  if (!source || typeof source !== 'object') return EMPTY_SOURCE
  const archived = source.archivedSessionIds
  return {
    sessions: Array.isArray(source.sessions) ? source.sessions : [],
    findings: Array.isArray(source.findings) ? source.findings : [],
    promptLogs: Array.isArray(source.promptLogs) ? source.promptLogs : [],
    archivedSessionIds: archived instanceof Set ? archived : new Set(
      Array.isArray(archived) ? archived : [],
    ),
  }
}

/**
 * Derive the candidate sessions of a distillation batch.
 *
 * A session is a candidate when it is visible in `sessions` OR carries at
 * least one Finding OR has a PromptLog row. Entries are deduplicated by
 * sessionId (sessions first in their given order, then findings-only and
 * promptLogs-only sessions in first-seen order).
 *
 * @param {object} input
 * @param {Array<{sessionId?: string, title?: string, updatedAt?: number}>} [input.sessions]
 * @param {Array<{sessionId?: string, updatedAt?: number}>} [input.findings]
 * @param {Array<{sessionId?: string, updatedAt?: number}>} [input.promptLogs]
 * @param {Set<string>|Array<string>} [input.archivedSessionIds]
 * @returns {Array<{sessionId: string, title: string, archived: boolean, hasFindings: boolean,
 *   findingCount: number, hasPromptLog: boolean, promptLogCount: number, updatedAt: number|null}>}
 */
export function deriveDistillCandidates({ sessions, findings, promptLogs, archivedSessionIds } = {}) {
  const source = normalizeSource({ sessions, findings, promptLogs, archivedSessionIds })
  const byId = new Map()

  const ensure = (sessionId) => {
    const key = typeof sessionId === 'string' ? sessionId : (sessionId === null || sessionId === undefined ? '' : String(sessionId))
    if (!key) return null
    let row = byId.get(key)
    if (!row) {
      row = {
        sessionId: key,
        title: '',
        archived: source.archivedSessionIds.has(key),
        hasFindings: false,
        findingCount: 0,
        hasPromptLog: false,
        promptLogCount: 0,
        updatedAt: null,
      }
      byId.set(key, row)
    }
    return row
  }

  const mergeUpdatedAt = (row, value) => {
    if (isFiniteNumber(value) && (row.updatedAt === null || value > row.updatedAt)) {
      row.updatedAt = value
    }
  }

  for (const session of source.sessions) {
    if (!session || typeof session !== 'object') continue
    const row = ensure(session.sessionId ?? session.id)
    if (!row) continue
    if (typeof session.title === 'string' && session.title) row.title = session.title
    mergeUpdatedAt(row, session.updatedAt)
  }

  for (const finding of source.findings) {
    if (!finding || typeof finding !== 'object') continue
    const row = ensure(finding.sessionId)
    if (!row) continue
    row.hasFindings = true
    row.findingCount += 1
    mergeUpdatedAt(row, finding.updatedAt)
  }

  for (const log of source.promptLogs) {
    if (!log || typeof log !== 'object') continue
    const row = ensure(log.sessionId)
    if (!row) continue
    row.hasPromptLog = true
    row.promptLogCount += 1
    mergeUpdatedAt(row, log.updatedAt)
  }

  return Array.from(byId.values())
}

/** Map a run status onto the view phase. */
function phaseForRunStatus(status) {
  if (status === 'ready') return 'pending'
  if (status === 'applied') return 'result'
  return 'running'
}

/**
 * Merge a freshly polled copy of the pinned run into the locally held copy.
 *
 * The poll is a background refresh of a record the user is reading, so it must
 * never downgrade it: an applied result that the poll still reports as
 * ready/applying keeps the locally known applied status and its apply record.
 *
 * @param {object|null} current locally held run
 * @param {object} polled polled run (same id)
 * @returns {object}
 */
function mergePinnedRun(current, polled) {
  if (!current || current.id !== polled.id) return { ...polled }
  const status = polled.status === 'applied'
    ? 'applied'
    : (current.status === 'applied' ? 'applied' : polled.status)
  const summaries = Array.isArray(polled.summaries) && polled.summaries.length > 0
    ? polled.summaries
    : current.summaries
  return {
    ...current,
    ...polled,
    status,
    applyResult: polled.applyResult ?? current.applyResult,
    summaries,
    usage: polled.usage ?? current.usage,
  }
}

/**
 * Factory for the DistillView component.
 *
 * @param {object} deps
 * @param {Function} deps.h hyperscript (React.createElement)
 * @param {object} deps.React injected React hook namespace (never imported here)
 * @param {object} deps.services injected services; optional contract:
 *   services.loadDistillSource({ workspaceId }) →
 *     { sessions, findings, promptLogs, archivedSessionIds } (sync or async)
 * @param {Function} [deps.t] locale translate function; identity fallback
 * @param {Function} [deps.createConfirmComponent] zero-arg factory returning
 *   the confirmation page component (desk.js passes () => DistillConfirm).
 *   Called once at factory time; a missing or non-component result keeps the
 *   pending placeholder fallback. The component contract mirrors
 *   ./distill-confirm.js: props { run, plan, workspaceId, onApplied }.
 * @returns {Function} DistillView React component
 */
export function createDistillView({ h, React, services, t, createConfirmComponent } = {}) {
  const { Badge, Button, Empty, icons } = createBits(h)
  const translate = typeof t === 'function' ? t : (key) => key

  // Optional confirmation page (Task 3.2): resolve the factory once so the
  // desk-injected DistillConfirm instance is shared across renders. Never
  // imported here — the fallback keeps this module independently testable.
  const createdConfirm = typeof createConfirmComponent === 'function'
    ? createConfirmComponent()
    : null
  const ConfirmComponent = typeof createdConfirm === 'function' ? createdConfirm : null

  return function DistillView({ workspaceId, renderSummary } = {}) {
    const [phase, setPhase] = React.useState('config')
    const [source, setSource] = React.useState(EMPTY_SOURCE)
    const [selected, setSelected] = React.useState(() => new Set())
    const [showArchived, setShowArchived] = React.useState(false)
    const [activeRun, setActiveRun] = React.useState(null)
    const [historyRuns, setHistoryRuns] = React.useState([])
    const [startError, setStartError] = React.useState(null)
    const [starting, setStarting] = React.useState(false)
    const [cancelNote, setCancelNote] = React.useState(null)
    // Two-step cancel: the first click only reveals the confirmation.
    const [cancelConfirming, setCancelConfirming] = React.useState(false)
    // A run that was live in this view and then landed in a non-applied terminal
    // state. Dropping it silently sent the user back to config with no reason —
    // surface the persisted run.error and keep its batch for "start over".
    const [runFailure, setRunFailure] = React.useState(null)
    // Debounced material pre-check: { status: 'idle'|'loading'|'ok'|'failed', data }
    const [estimate, setEstimate] = React.useState({ status: 'idle', data: null })
    // Two-step delete: the run id awaiting confirmation (no write on first click).
    const [deleteTarget, setDeleteTarget] = React.useState(null)
    const [deleting, setDeleting] = React.useState(false)
    const [historyNote, setHistoryNote] = React.useState(null)
    // Park / abandon of the pending confirmation page.
    // `actionBusy` is 'park' | 'abandon' | null and disables every pending
    // action so a double click cannot post twice.
    const [actionBusy, setActionBusy] = React.useState(null)
    // Two-step abandon: the first click only reveals the inline confirmation.
    const [abandonConfirming, setAbandonConfirming] = React.useState(false)
    // Inline failure of a pending action (Host message + code, shown in place).
    const [pendingNote, setPendingNote] = React.useState(null)
    // Park succeeded: the config home page states where the plan went.
    const [parkedNotice, setParkedNotice] = React.useState(false)
    // History row that is re-locking its parked plan (unpark in flight).
    const [historyParkingId, setHistoryParkingId] = React.useState(null)
    // The 5s polling closure is created inside an effect; park/abandon need an
    // explicit refresh after mutating the Host, so expose it through a ref.
    const refreshRunsRef = React.useRef(null)
    // Pinned result record. While set, the background poll must never navigate
    // away: "查看摘要" used to be stolen back by the live run list after a few
    // seconds. Cleared only by the explicit back action.
    const [pinnedRunId, setPinnedRunId] = React.useState(null)
    // A pinned run that disappeared from the Host list is reported on config.
    const [resultNote, setResultNote] = React.useState(null)
    // Hovered candidate card: inline styles cannot express :hover, and the
    // hover wash must not be confused with the selection bar.
    const [hoveredSessionId, setHoveredSessionId] = React.useState(null)
    // Running timeline: past the 12-row window the log expands/collapses.
    const [logExpanded, setLogExpanded] = React.useState(false)
    // Collapsible sections of the distillation page (the config peer panels and
    // the history list). Mirrors the Desk dashboard / Session Pane: the whole
    // section head folds it, inner controls keep their own click.
    const [collapsedPanels, setCollapsedPanels] = React.useState({})
    const panelCollapsed = key => Boolean(collapsedPanels[key])
    const togglePanelSection = key => setCollapsedPanels(prev => ({ ...prev, [key]: !prev[key] }))

    const phaseRef = React.useRef('config')
    const activeRunRef = React.useRef(null)
    const pinnedRunRef = React.useRef(null)
    // A ready run the user backed out of from the confirmation page: the poll
    // must not bounce the phase straight back into pending.
    const detachedReadyRef = React.useRef(null)
    // A landed run the user explicitly backed out of from the result page:
    // `{ runId, at }`. While the poll still reports that run as an applied
    // landing (or as active), it may refresh `historyRuns` / `activeRun` but it
    // MUST NOT change `phase` — otherwise "返回精炼首页" was immediately stolen
    // back by the next poll. Cleared by the next explicit start / summary view.
    const suppressLandingRef = React.useRef(null)
    // The mount-time read doubles as refresh recovery: a reload onto a
    // failed/cancelled/stale batch must still offer the "start over" entry, so
    // the latest retryable terminal run is surfaced once.
    const recoveredRef = React.useRef(false)

    const candidates = React.useMemo(
      () => deriveDistillCandidates(source),
      [source],
    )
    // Applied-history markers ("already distilled"): per-session count, last
    // write-back time and files. Derived from the polled run list, so a fresh
    // apply shows up after the next poll without extra Host routes.
    const refinedMarkers = React.useMemo(
      () => deriveRefinedMarkers(historyRuns),
      [historyRuns],
    )
    // Cumulative read-only overview of this workspace's batches. Derived from
    // the same poll as the history list — no extra Host request.
    const overview = React.useMemo(
      () => deriveDistillOverview(historyRuns),
      [historyRuns],
    )
    // Human-readable evidence: the confirmation page resolves "会话标题 · 第 N 轮"
    // from this map, falling back to `run.summaries` and finally to the turn only.
    // Never let it fall back to raw session ids.
    const [appliedPayload, setAppliedPayload] = React.useState(null)
    const confirmSessionTitles = React.useMemo(() => {
      const map = {}
      for (const session of source.sessions) {
        const sessionId = session && typeof session.sessionId === 'string' ? session.sessionId : ''
        const title = session && typeof session.title === 'string' ? session.title.trim() : ''
        if (sessionId && title) map[sessionId] = title
      }
      return map
    }, [source])

    const gotoPhase = (next) => {
      phaseRef.current = next
      setPhase(next)
    }

    /** Pin a run on the result page; the background poll can no longer move it. */
    const pinRun = (runId) => {
      const id = typeof runId === 'string' && runId !== '' ? runId : null
      pinnedRunRef.current = id
      setPinnedRunId(id)
      setResultNote(null)
    }

    /** Drop every transient page state that must not survive a return home. */
    const clearTransientViewState = () => {
      setCancelConfirming(false)
      setCancelNote(null)
      setLogExpanded(false)
      setDeleteTarget(null)
      setHistoryNote(null)
      setResultNote(null)
      setAbandonConfirming(false)
      setPendingNote(null)
      setParkedNotice(false)
    }

    /**
     * Every explicit "返回" path (result header, applied ledger `onBack`,
     * pending confirmation `onBack`) lands on the config home page and clears
     * the pin / history transients. When a landed run was being shown, remember
     * it so the background poll can refresh its data without navigating back.
     */
    const backToConfig = () => {
      const landedId = activeRunRef.current?.id
      pinnedRunRef.current = null
      setPinnedRunId(null)
      setAppliedPayload(null)
      if (typeof landedId === 'string' && landedId !== '') {
        suppressLandingRef.current = { runId: landedId, at: Date.now() }
      }
      clearTransientViewState()
      gotoPhase('config')
    }

    /**
     * The confirmation page's back action. A ready run is still pending on the
     * Host, so the poll must not bounce straight back into the pending phase.
     */
    const backFromPending = () => {
      const runId = activeRunRef.current?.id
      detachedReadyRef.current = typeof runId === 'string' ? runId : null
      backToConfig()
    }

    /** Fold a polled run list into view state (mount recovery + polling). */
    const applyRuns = (runs) => {
      const list = Array.isArray(runs)
        ? runs.filter((run) => run && typeof run === 'object' && run.id)
        : []
      setHistoryRuns(list)
      // The run the user just backed out of. The poll may refresh its data, but
      // never navigate the phase: the user asked for the config home page.
      const suppressedId = suppressLandingRef.current?.runId ?? null

      // A pinned result record wins over the active-run projection. The user
      // explicitly opened this record ("查看摘要" / apply callback); a background
      // poll refreshing the list must never navigate the page away from it.
      if (pinnedRunRef.current) {
        const pinned = list.find((run) => run.id === pinnedRunRef.current)
        if (pinned) {
          const merged = mergePinnedRun(activeRunRef.current, pinned)
          activeRunRef.current = merged
          setActiveRun(merged)
          return
        }
        // The record is gone (deleted on the Host): say so and go back.
        pinnedRunRef.current = null
        setPinnedRunId(null)
        activeRunRef.current = null
        setActiveRun(null)
        setAppliedPayload(null)
        setResultNote('notFound')
        gotoPhase('config')
        return
      }

      const active = getActiveRun(list, workspaceId)
      if (active) {
        if (activeRunRef.current?.id !== active.id) {
          setStartError(null)
          setRunFailure(null)
          setCancelConfirming(false)
          setCancelNote(null)
          setLogExpanded(false)
        }
        activeRunRef.current = active
        setActiveRun(active)
        // A parked ready run is still the workspace's single non-terminal run,
        // but it deliberately released the submission lock: the background poll
        // must never bounce the user back into its confirmation page. Reopening
        // it is an explicit history action (park false → pending).
        if (active.parked === true && phaseRef.current !== 'pending') return
        // The suppressed run is only refreshed, never re-navigated to.
        if (suppressedId && active.id === suppressedId) return
        // The user backed out of this ready run's confirmation: stay on config
        // instead of bouncing back into pending on the next poll.
        if (detachedReadyRef.current === active.id && active.status === 'ready'
          && phaseRef.current === 'config') {
          return
        }
        detachedReadyRef.current = null
        gotoPhase(phaseForRunStatus(active.status))
        return
      }
      const previous = activeRunRef.current
      activeRunRef.current = null
      setActiveRun(null)
      if (!previous) {
        if (!recoveredRef.current) {
          recoveredRef.current = true
          // Refresh recovery: newest retryable terminal run of this workspace.
          const latest = list
            .filter((run) => RETRYABLE_RUN_STATUSES.has(run.status))
            .sort((a, b) => {
              const left = normalizeEpoch(a.updatedAt ?? a.createdAt)
              const right = normalizeEpoch(b.updatedAt ?? b.createdAt)
              return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0)
            })[0]
          if (latest) {
            setRunFailure({
              status: latest.status,
              code: typeof latest.error?.code === 'string' ? latest.error.code : '',
              message: typeof latest.error?.message === 'string' ? latest.error.message : '',
              sessions: normalizeRunSessionIds(latest),
            })
          }
        }
        return
      }
      const landed = list.find((run) => run.id === previous.id)
      if (landed && landed.status === 'applied') {
        // Explicitly backed out of this record: refresh the data only, stay on
        // the config home page. This is the "返回精炼首页 was bounced back to the
        // result page" fix.
        if (suppressedId && landed.id === suppressedId) {
          activeRunRef.current = landed
          setActiveRun(landed)
          return
        }
        // Landing on a finished run also pins the result: a later run in the
        // same workspace must not take the page away from the outcome.
        pinnedRunRef.current = landed.id
        setPinnedRunId(landed.id)
        setActiveRun(landed)
        gotoPhase('result')
      } else {
        if (landed) {
          setRunFailure({
            status: landed.status,
            code: typeof landed.error?.code === 'string' ? landed.error.code : '',
            message: typeof landed.error?.message === 'string' ? landed.error.message : '',
            sessions: normalizeRunSessionIds(landed),
          })
        }
        gotoPhase('config')
      }
    }

    // Load the batch source (sessions / findings / promptLogs / archived ids).
    React.useEffect(() => {
      if (typeof services?.loadDistillSource !== 'function') return
      let alive = true
      const load = async () => {
        try {
          const loaded = await services.loadDistillSource({ workspaceId })
          if (alive && loaded) setSource(normalizeSource(loaded))
        } catch {
          // Keep the last known source; the config list just stays shorter.
        }
      }
      void load()
      return () => { alive = false }
    }, [workspaceId])

    // Poll this workspace's runs. The mount-time GET doubles as refresh
    // recovery (a non-terminal run survives reloads). Fail-open: any
    // network/shape failure keeps the last known state. Cleanup aborts the
    // in-flight read and stops the timer; unref keeps test harnesses alive.
    React.useEffect(() => {
      if (!workspaceId || typeof fetch !== 'function') return
      let alive = true
      const controller = new AbortController()
      const refreshRuns = async () => {
        try {
          const res = await fetch(
            `api/punch-desk/distill-run?workspaceId=${encodeURIComponent(workspaceId)}`,
            { signal: controller.signal },
          )
          if (!res.ok) return
          const data = await res.json()
          if (!alive || !data || data.ok !== true || !Array.isArray(data.runs)) return
          applyRuns(data.runs)
        } catch {
          // Abort/network failure: keep the last known state (fail-open).
        }
      }
      const first = refreshRuns()
      refreshRunsRef.current = refreshRuns
      const timer = setInterval(refreshRuns, DISTILL_VIEW_POLL_MS)
      const unref = typeof timer.unref === 'function' ? () => timer.unref() : () => {}
      unref()
      return () => {
        alive = false
        if (refreshRunsRef.current === refreshRuns) refreshRunsRef.current = null
        clearInterval(timer)
        controller.abort()
        return first
      }
    }, [workspaceId])

    // Debounced material pre-check. Only a legal batch (3~7 sessions) is
    // estimated; a superseded request is aborted so a slow response can never
    // overwrite a newer one. Fail-open: a failed or empty pre-check only shows
    // `estimateFailed` and never blocks the start action.
    const selectedKey = Array.from(selected).sort().join(',')
    React.useEffect(() => {
      const count = selectedKey ? selectedKey.split(',').length : 0
      const legal = Boolean(workspaceId) && count >= MIN_BATCH_SESSIONS && count <= MAX_BATCH_SESSIONS
      if (!legal || typeof fetch !== 'function') {
        setEstimate((prev) => (prev.status === 'idle' ? prev : { status: 'idle', data: null }))
        return
      }
      let alive = true
      const controller = new AbortController()
      setEstimate({ status: 'loading', data: null })
      const timer = setTimeout(async () => {
        try {
          const sessions = selectedKey.split(',').map((id) => encodeURIComponent(id)).join(',')
          const res = await fetch(
            `api/punch-desk/distill-estimate?workspaceId=${encodeURIComponent(workspaceId)}&sessions=${sessions}`,
            { signal: controller.signal },
          )
          const data = await res.json().catch(() => null)
          if (!alive) return
          if (!res.ok || !data || data.ok !== true || !data.estimate) {
            setEstimate({ status: 'failed', data: null })
            return
          }
          setEstimate({ status: 'ok', data: data.estimate })
        } catch {
          if (alive) setEstimate({ status: 'failed', data: null })
        }
      }, DISTILL_ESTIMATE_DEBOUNCE_MS)
      return () => {
        alive = false
        clearTimeout(timer)
        controller.abort()
      }
    }, [workspaceId, selectedKey])

    const toggleSelect = (sessionId) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        return next
      })
    }

    const selectedList = candidates.filter((item) => selected.has(item.sessionId))
    const selectedFindings = selectedList.reduce((sum, item) => sum + item.findingCount, 0)
    const selectedPromptLogs = selectedList.filter((item) => item.hasPromptLog).length
    const startDisabled = !workspaceId
      || starting
      || selected.size < MIN_BATCH_SESSIONS
      || selected.size > MAX_BATCH_SESSIONS

    // Why the primary action is unavailable — the header button sits far from
    // the batch list, so a disabled button without a reason would be a dead end.
    const startTip = !workspaceId
      ? translate('distill.view.config.startNoWorkspace')
      : selected.size < MIN_BATCH_SESSIONS
        ? translate('distill.view.config.startNeedSessions')
        : selected.size > MAX_BATCH_SESSIONS
          ? translate('distill.view.config.startTooMany')
          : translate('distill.view.config.startHint')

    /**
     * Start a distillation batch. Shared by the config action and the
     * "start over" entry on a failed/cancelled/stale run: the retry always
     * re-posts the SAME batch, never an empty fresh config.
     * @param {string[]} sessions
     */
    const postRun = async (sessions) => {
      const batch = Array.isArray(sessions)
        ? sessions.filter((id) => typeof id === 'string' && id !== '')
        : []
      if (!workspaceId || batch.length < MIN_BATCH_SESSIONS || batch.length > MAX_BATCH_SESSIONS) return
      setStarting(true)
      setStartError(null)
      setCancelNote(null)
      setCancelConfirming(false)
      setRunFailure(null)
      setHistoryNote(null)
      setPendingNote(null)
      setParkedNotice(false)
      setAbandonConfirming(false)
      setSelected(new Set(batch))
      setResultNote(null)
      setLogExpanded(false)
      pinnedRunRef.current = null
      setPinnedRunId(null)
      setAppliedPayload(null)
      detachedReadyRef.current = null
      // A new explicit start is a fresh user intent: stop suppressing landings.
      suppressLandingRef.current = null
      try {
        const res = await fetch('api/punch-desk/distill-run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, sessions: batch }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok !== true || !data.run) {
          setStartError(readErrorPayload(data, res))
          return
        }
        activeRunRef.current = data.run
        setActiveRun(data.run)
        gotoPhase(phaseForRunStatus(data.run.status) || 'running')
      } catch (err) {
        setStartError({ code: 'NETWORK', message: err?.message || String(err) })
      } finally {
        setStarting(false)
      }
    }

    const handleStart = () => postRun(Array.from(selected))

    /** Re-post the persisted batch of a failed/cancelled/stale run. */
    const handleRetry = () => {
      const batch = Array.isArray(runFailure?.sessions) ? runFailure.sessions : []
      void postRun(batch)
    }

    const handleCancel = async () => {
      const runId = activeRunRef.current?.id
      if (!runId) return
      setCancelNote(null)
      try {
        const res = await fetch('api/punch-desk/distill-cancel', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok !== true) {
          setCancelNote('cancelFailed')
          return
        }
        setCancelNote(CANCEL_NOTE_KEYS[data.status] ? data.status : 'cancelFailed')
      } catch {
        setCancelNote('cancelFailed')
      } finally {
        setCancelConfirming(false)
      }
    }

    /**
     * One POST to a distill lifecycle route, normalizing both shipped error
     * shapes into `{ ok:false, code, message }`. Never throws for HTTP errors.
     */
    const postDistillAction = async (path, body) => {
      try {
        const res = await fetch(`api/punch-desk/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok !== true) {
          const failure = readErrorPayload(data, res)
          return { ok: false, code: failure.code, message: failure.message }
        }
        return { ok: true, data }
      } catch (err) {
        return { ok: false, code: 'NETWORK', message: err?.message || String(err) }
      }
    }

    /**
     * 暂存: keep this plan, release the workspace submission lock and return
     * home. The run stays non-terminal (`parked:true`), so history can reopen
     * the confirmation page later; nothing is written back.
     */
    const handlePark = async () => {
      const run = activeRunRef.current
      if (!run || !run.id || actionBusy) return
      setActionBusy('park')
      setPendingNote(null)
      const outcome = await postDistillAction('distill-park', { runId: run.id, parked: true })
      setActionBusy(null)
      if (!outcome.ok) {
        setPendingNote({ kind: 'failed', code: outcome.code, message: outcome.message })
        return
      }
      const parkedRun = outcome.data.run && typeof outcome.data.run === 'object'
        ? outcome.data.run
        : { ...run, parked: true }
      activeRunRef.current = parkedRun
      setActiveRun(parkedRun)
      setHistoryRuns((prev) => prev.map(
        (item) => (item.id === parkedRun.id ? { ...item, ...parkedRun } : item),
      ))
      // A parked run is still the workspace's non-terminal run: the poll must
      // not bounce straight back into the confirmation page.
      detachedReadyRef.current = parkedRun.id
      suppressLandingRef.current = null
      setAbandonConfirming(false)
      setParkedNotice(true)
      gotoPhase('config')
    }

    /**
     * 放弃本次精炼: delete this run + plan (nothing is written back) and go
     * home. The two-step confirmation is owned by the caller; the Host refuses
     * while `applying` and the error is shown in place.
     */
    const handleAbandon = async () => {
      const run = activeRunRef.current
      if (!run || !run.id || actionBusy) return
      setActionBusy('abandon')
      setPendingNote(null)
      const outcome = await postDistillAction('distill-abandon', { runId: run.id })
      setActionBusy(null)
      if (!outcome.ok) {
        setPendingNote({ kind: 'failed', code: outcome.code, message: outcome.message })
        return
      }
      setHistoryRuns((prev) => prev.filter((item) => item.id !== run.id))
      activeRunRef.current = null
      setActiveRun(null)
      detachedReadyRef.current = null
      suppressLandingRef.current = null
      pinnedRunRef.current = null
      setPinnedRunId(null)
      setAppliedPayload(null)
      setAbandonConfirming(false)
      setParkedNotice(false)
      setPendingNote(null)
      gotoPhase('config')
      // The row is gone on the Host; refresh the list instead of trusting the
      // local splice alone (another worker may have added rows meanwhile).
      void refreshRunsRef.current?.()
    }

    /**
     * History → 回到确认: un-park a parked ready run (Host re-locks it by
     * restarting the ready TTL), then pin it and open the confirmation page.
     */
    const handleOpenParkedConfirm = async (run) => {
      if (!run || !run.id || historyParkingId) return
      setHistoryParkingId(run.id)
      setHistoryNote(null)
      const outcome = await postDistillAction('distill-park', { runId: run.id, parked: false })
      setHistoryParkingId(null)
      if (!outcome.ok) {
        setHistoryNote({ kind: 'failed', code: outcome.code, message: outcome.message })
        return
      }
      const readyRun = outcome.data.run && typeof outcome.data.run === 'object'
        ? outcome.data.run
        : { ...run, parked: false }
      activeRunRef.current = readyRun
      setActiveRun(readyRun)
      setHistoryRuns((prev) => prev.map(
        (item) => (item.id === readyRun.id ? { ...item, ...readyRun } : item),
      ))
      setRunFailure(null)
      setPendingNote(null)
      setParkedNotice(false)
      setAbandonConfirming(false)
      detachedReadyRef.current = null
      suppressLandingRef.current = null
      // Pin before switching so an already in-flight poll cannot navigate away.
      pinRun(readyRun.id)
      gotoPhase('pending')
    }

    /** Delete a terminal history record after the inline two-step confirm. */
    const confirmDelete = async (runId) => {
      if (!runId || deleting) return
      setDeleting(true)
      setHistoryNote(null)
      // A parked ready run is not terminal, so the terminal-only distill-delete
      // route refuses it; the history trash then means "abandon this attempt".
      const target = historyRuns.find((run) => run.id === runId)
      const abandoning = Boolean(target && target.status === 'ready' && target.parked === true)
      const outcome = await postDistillAction(abandoning ? 'distill-abandon' : 'distill-delete', { runId })
      setDeleting(false)
      if (!outcome.ok) {
        setHistoryNote({ kind: 'failed', code: outcome.code, message: outcome.message })
        setDeleteTarget(null)
        return
      }
      setHistoryRuns((prev) => prev.filter((run) => run.id !== runId))
      setDeleteTarget(null)
      setHistoryNote({ kind: 'deleted' })
    }

    /** Open a past applied run on the result page (history row entry). */
    const openHistoryResult = (run) => {
      if (!run || typeof run !== 'object') return
      activeRunRef.current = run
      setActiveRun(run)
      setRunFailure(null)
      // Viewing a summary is an explicit action: it is never suppressed.
      suppressLandingRef.current = null
      // Pin before switching: the poll that is already in flight must not take
      // the page back.
      pinRun(run.id)
      gotoPhase('result')
    }

    // Task 3.2: DistillConfirm reports a successful apply. Fold the terminal
    // status into the local run copy so the result page renders immediately;
    // the still-running poll then refreshes the full applied run (summaries
    // included) and the history list through the same landing path.
    const handleConfirmApplied = (payload) => {
      // The user just completed the write-back: a fresh result is explicit.
      suppressLandingRef.current = null
      // Keep the 200 payload so the result phase can still show the written-back
      // ledger and post-apply stats (the confirmation page is unmounted here).
      if (payload && typeof payload === 'object') setAppliedPayload(payload)
      const status = (payload && typeof payload.runStatus === 'string' && payload.runStatus) || 'applied'
      const current = activeRunRef.current
      if (current && current.id) {
        const landed = { ...current, status }
        activeRunRef.current = landed
        setActiveRun(landed)
        // Fold the 200 payload into the local history copy too, so the config
        // page's "already distilled" files count is not stale until the poll.
        const applyRecord = payload && typeof payload === 'object'
          ? (payload.applied || payload.appliedAt || payload.ok === true ? payload : current.applyResult)
          : current.applyResult
        setHistoryRuns((prev) => prev.map(
          (run) => (run.id === landed.id
            ? { ...run, status, applyResult: applyRecord ?? run.applyResult }
            : run),
        ))
        // The applied page must stay put: pin the run so the next poll (which
        // may still report it ready/applying) refreshes the record in place.
        pinRun(landed.id)
      }
      gotoPhase('result')
    }

    /** One-line, human-readable description of a Host error, code-first. */
    const describeError = (code, message) => {
      const parts = []
      const key = code ? ERROR_CODE_KEYS[code] : ''
      if (key) parts.push(translate(key))
      else if (code) parts.push(code)
      if (message) parts.push(message)
      return parts.join(' · ')
    }

    /* -------------------------------------------------------- estimate UI */

    const renderEstimate = () => {
      const count = selectedKey ? selectedKey.split(',').length : 0
      if (!workspaceId || count < MIN_BATCH_SESSIONS || count > MAX_BATCH_SESSIONS) return null

      if (estimate.status === 'loading') {
        return h('div', { style: ESTIMATE_WRAP_STYLE },
          h('div', { style: ESTIMATE_LINE_STYLE() },
            h(icons.CircleNotch, { size: 12 }),
            h('span', {}, translate('distill.view.config.estimateLoading'))))
      }

      if (estimate.status !== 'ok' || !estimate.data) {
        const data = estimate.data
        // Failed pre-check: explicit, quiet and non-blocking. Never a
        // fabricated cost card.
        return h('div', { style: ESTIMATE_WRAP_STYLE },
          h('div', { style: ESTIMATE_LINE_STYLE(true) },
            h(icons.Prohibit, { size: 12 }),
            h('span', {}, translate('distill.view.config.estimateFailed'))),
          data && typeof data === 'object' ? renderEstimateLines(data) : null)
      }

      return h('div', { style: ESTIMATE_WRAP_STYLE }, renderEstimateLines(estimate.data))
    }

    /** Locale lines of a successful pre-check; missing fields are omitted. */
    const renderEstimateLines = (data) => {
      const lines = []
      const materials = isFiniteNumber(data.totalMaterials) ? data.totalMaterials : null
      const tokens = isFiniteNumber(data.totalTokens) ? data.totalTokens : null
      if (materials !== null && tokens !== null) {
        lines.push(h('div', { key: 'estimate', style: ESTIMATE_LINE_STYLE() },
          h('span', {}, fillLocaleTemplate(
            translate('distill.view.config.estimate'),
            { materials, tokens },
          ))))
      }
      const window = isFiniteNumber(data.contextWindow) ? data.contextWindow : null
      if (window && tokens !== null && window > 0) {
        const percent = Math.round((tokens / window) * 100)
        lines.push(h('div', { key: 'percent', style: ESTIMATE_LINE_STYLE() },
          h('span', {}, fillLocaleTemplate(
            translate('distill.view.config.estimatePercent'),
            { percent },
          ))))
      }
      const model = typeof data.model === 'string' && data.model ? data.model : ''
      if (model) {
        lines.push(h('div', { key: 'model', style: ESTIMATE_LINE_STYLE() },
          h('span', {}, fillLocaleTemplate(translate('distill.view.config.estimateModel'), { model }))))
      }
      const stage1 = isFiniteNumber(data.stage1Calls) ? data.stage1Calls : null
      const stage2 = isFiniteNumber(data.stage2Calls) ? data.stage2Calls : null
      if (stage1 !== null || stage2 !== null) {
        lines.push(h('div', { key: 'calls', style: ESTIMATE_LINE_STYLE() },
          h('span', {}, fillLocaleTemplate(
            translate('distill.view.config.estimateCalls'),
            { stage1: stage1 ?? 0, stage2: stage2 ?? 0 },
          ))))
      }
      const budget = data.budget && typeof data.budget === 'object' ? data.budget : null
      if (budget && budget.truncated === true) {
        const limit = isFiniteNumber(budget.maxTokens) ? budget.maxTokens : tokens
        lines.push(h('div', { key: 'truncated', style: ESTIMATE_LINE_STYLE(true) },
          h(icons.Prohibit, { size: 12 }),
          h('span', {}, fillLocaleTemplate(
            translate('distill.view.config.estimateTruncated'),
            { tokens: limit ?? 0 },
          ))))
      }
      return lines.length > 0 ? lines : null
    }

    /* ------------------------------------------------------------- config */

    /** Selection / material readout of the sticky batch bar. */
    const buildSelectionSummary = () => {
      const selectionValid = selected.size >= MIN_BATCH_SESSIONS && selected.size <= MAX_BATCH_SESSIONS
      const parts = [countText(translate('distill.view.config.selectedCount'), selected.size)]
      if (selectionValid) {
        if (selectedFindings > 0) {
          parts.push(countText(translate('distill.view.config.summaryFindings'), selectedFindings))
        }
        if (selectedPromptLogs > 0) {
          parts.push(countText(translate('distill.view.config.summaryLogs'), selectedPromptLogs))
        }
      } else {
        // The primary action is disabled; say why in place (sticky bar) instead
        // of relying on a hover-only tooltip.
        parts.push(startTip)
      }
      return { text: parts.join(' · '), valid: selectionValid }
    }

    /**
     * Sticky command bar: selection + material + pre-check on the left, the
     * single start action on the right. The action is never repeated in the
     * body, so a long card list cannot bury it.
     */
    const renderBatchBar = () => {
      const summary = buildSelectionSummary()
      return h('div', { style: BATCH_BAR_STYLE },
        h('div', { style: BATCH_BAR_MAIN_STYLE },
          h('div', { style: SUMMARY_STYLE(summary.valid) }, summary.text),
          renderEstimate()),
        h(Button, {
          icon: icons.Play,
          variant: 'primary',
          disabled: startDisabled,
          tip: startTip,
          onClick: handleStart,
        }, translate('distill.view.config.start')))
    }

    /* --------------------------------------- config peer panel chrome */

    /**
     * Shared panel head: icon + title + count, optional trailing control.
     *
     * With `sectionKey` the head becomes the section's whole-row fold control
     * (Session Pane pattern): the title, count and empty space all toggle the
     * panel, while the caret and any `extra` control keep their own click.
     */
    const renderPanelHeader = (icon, title, count, extra = null, sectionKey = null) => {
      const collapsed = sectionKey !== null && panelCollapsed(sectionKey)
      return h('div', {
        style: sectionKey === null ? PANEL_HEAD_STYLE : PANEL_HEAD_FOLD_STYLE,
        'data-pd-panel-head': 'true',
        ...(sectionKey !== null ? { 'data-distill-section': sectionKey } : {}),
        ...(sectionKey === null ? {} : {
          onClick: event => {
            if (suppressesRowToggle(event)) return
            togglePanelSection(sectionKey)
          },
        }),
      },
      h(icon, { size: 13, color: TEXT_TERTIARY }),
      h('span', { style: PANEL_TITLE_STYLE }, title),
      h('span', { style: PANEL_COUNT_STYLE }, String(count)),
      h('div', { style: PANEL_HEAD_EXTRA_STYLE },
        extra,
        sectionKey === null
          ? null
          : h(Button, {
            icon: collapsed ? icons.CaretRight : icons.CaretDown,
            iconOnly: true,
            variant: 'ghost',
            'aria-expanded': !collapsed,
            title: translate(collapsed ? 'finding.expand' : 'finding.collapse'),
            'aria-label': translate(collapsed ? 'finding.expand' : 'finding.collapse'),
            onClick: () => togglePanelSection(sectionKey),
            style: { padding: 3 },
          })))
    }

    /** One recent-batch row of the read-only overview panel. */
    const renderOverviewRow = (run, index) => {
      const sessions = Array.isArray(run.sessions) ? run.sessions.length : 0
      const result = run.applyResult && typeof run.applyResult === 'object' ? run.applyResult : null
      const filesApplied = result && Array.isArray(result.applied) ? result.applied.length : null
      const writeInfo = run.status === 'applied'
        ? fillLocaleTemplate(translate('distill.overview.applied'), {
          files: filesApplied ?? (Number(run.plan?.stats?.targets) || 0),
        })
        : translate('distill.overview.notApplied')
      const usageTokens = Number(run.usage?.totalTokens)
      const age = formatRelativeTime(run.appliedAt || run.updatedAt || run.createdAt, translate)
      return h('div', {
        key: `distill-overview-${run.id}`,
        'data-distill-overview-row': run.id,
        style: OVERVIEW_ROW_STYLE(index === overview.recent.length - 1),
      },
      h(Badge, { tone: RUN_STATUS_TONES[run.status] || 'neutral' },
        runStatusLabel(run.status, translate)),
      h('span', { style: OVERVIEW_ROW_TEXT_STYLE },
        countText(translate('distill.view.history.sessions'), sessions)),
      h('span', { style: OVERVIEW_ROW_TEXT_STYLE }, writeInfo),
      Number.isFinite(usageTokens) && usageTokens > 0
        ? h('span', { style: OVERVIEW_ROW_TEXT_STYLE },
          fillLocaleTemplate(translate('distill.overview.tokens'), { tokens: usageTokens }))
        : null,
      age ? h('span', { style: OVERVIEW_ROW_TIME_STYLE }, age) : null)
    }

    /**
     * "精炼概览" — the right peer panel of the config phase. Read-only: it says
     * how many batches ran, what they wrote back and which three are newest.
     */
    const renderOverviewPanel = () => h('section', {
      style: PANEL_STYLE,
      'data-distill-panel': 'overview',
      'data-distill-overview': 'true',
    },
    renderPanelHeader(icons.Clock, translate('distill.overview.title'), overview.batches, null, 'overview'),
    panelCollapsed('overview') ? null : h('div', { style: PANEL_BODY_STYLE },
      h('div', {
        style: OVERVIEW_TOTALS_STYLE,
        'data-distill-overview-totals': 'true',
      }, overview.batches > 0
        ? fillLocaleTemplate(translate('distill.overview.totals'), {
          batches: overview.batches,
          files: overview.files,
          changes: overview.changes,
        })
        : translate('distill.overview.totalsEmpty')),
      overview.recent.length === 0
        ? h('div', { style: EMPTY_HINT_STYLE, 'data-distill-overview-empty': 'true' },
          translate('distill.overview.empty'))
        : h('div', { style: PANEL_BODY_STYLE },
          h('div', { style: OVERVIEW_SECTION_TITLE_STYLE }, translate('distill.overview.recent')),
          overview.recent.map((run, index) => renderOverviewRow(run, index))),
      h('div', { style: OVERVIEW_HINT_STYLE }, translate('distill.overview.hint'))))

    const renderConfig = () => {
      const archivedCandidates = candidates.filter((item) => item.archived)
      const visible = showArchived ? candidates : candidates.filter((item) => !item.archived)

      return h('div', { style: BODY_STYLE },
        startError
          ? h('div', { role: 'alert', style: ERROR_BANNER_STYLE },
            h('div', { style: ERROR_BANNER_TEXT_STYLE },
              h(icons.Prohibit, { size: 14 }),
              h('span', {},
                translate(ERROR_CODE_KEYS[startError.code] || START_ERROR_FALLBACK),
                startError.code ? ` (${startError.code})` : '',
                startError.message ? ` — ${startError.message}` : '')))
          : null,

        runFailure
          ? h('div', { role: 'alert', style: ERROR_BANNER_STYLE },
            h('div', { style: ERROR_BANNER_TEXT_STYLE },
              h(icons.Prohibit, { size: 14 }),
              h('span', {},
                translate(RUN_FAILURE_KEYS[runFailure.status] || RUN_FAILURE_KEYS.failed),
                runFailure.code ? ` (${runFailure.code})` : '',
                runFailure.message ? ` — ${runFailure.message}` : '')),
            // "Start over" re-posts the SAME batch of the failed run. It stays
            // reachable exactly when the run landed failed / cancelled / stale.
            RETRYABLE_RUN_STATUSES.has(runFailure.status) && runFailure.sessions.length > 0
              ? h('div', { style: HEADER_ACTIONS_STYLE },
                h(Button, {
                  icon: icons.ArrowCounterClockwise,
                  variant: 'default',
                  disabled: starting,
                  onClick: handleRetry,
                }, translate('distill.view.running.retry')))
              : null)
          : null,

        // A pinned record that vanished from the Host list explains itself here
        // instead of silently returning to an unrelated config page.
        resultNote === 'notFound'
          ? h('div', { role: 'status', style: RESULT_NOTE_STYLE },
            h(icons.PushPinSimple, { size: 12 }),
            h('span', {}, translate('distill.view.result.notFound')))
          : null,

        // Parking succeeded: say where the plan went. It is deliberate that the
        // note lives on config — parking returns here instead of dropping the
        // user into an unexplained empty confirmation state.
        parkedNotice
          ? h('div', { role: 'status', style: HISTORY_NOTE_STYLE('deleted'), 'data-distill-parked-notice': 'true' },
            h(icons.PushPinSimple, { size: 12 }),
            h('span', {}, translate('distill.view.pending.parkedNote')))
          : null,

        h('div', {
          style: visible.length === 0 ? CONFIG_STACK_STYLE : CONFIG_GRID_STYLE,
          className: visible.length === 0 ? undefined : CONFIG_GRID_CLASS,
          'data-distill-config-grid': visible.length === 0 ? undefined : 'true',
          'data-distill-config-filter': showArchived ? 'archived' : 'active',
        },
        h('section', { style: PANEL_STYLE, 'data-distill-panel': 'sessions' },
          renderPanelHeader(
            icons.Kanban,
            translate('distill.view.config.listTitle'),
            visible.length,
            archivedCandidates.length > 0
              ? h(Button, {
                icon: icons.Folder,
                variant: showArchived ? 'primary' : 'ghost',
                'aria-pressed': showArchived,
                tip: translate('distill.view.config.showArchivedHint'),
                onClick: () => setShowArchived((prev) => !prev),
                style: { padding: '2px 8px', fontSize: 11 },
              }, countText(translate('distill.view.config.showArchivedToggle'), archivedCandidates.length))
              : null,
            'sessions'),
          panelCollapsed('sessions') ? null : visible.length === 0
            ? h('div', { style: EMPTY_WRAP_STYLE },
              h(Empty, { icon: icons.Kanban },
                h('span', {}, translate('distill.view.config.empty')),
                h('span', { style: EMPTY_HINT_STYLE }, translate('distill.view.config.emptyHint'))))
            : h('div', { style: CARD_GRID_STYLE },
              visible.map((item) => {
                const isSelected = selected.has(item.sessionId)
                const isHovered = hoveredSessionId === item.sessionId
                const title = item.title || translate('distill.view.config.untitled')
                const relative = formatRelativeTime(item.updatedAt, translate)
                const refined = refinedMarkers.get(item.sessionId)
                const refinedLastAt = refined ? formatRelativeTime(refined.lastAt, translate) : ''
                const material = []
                if (item.findingCount > 0) {
                  material.push(`${item.findingCount} ${translate('distill.view.config.findingsUnit')}`)
                }
                if (item.promptLogCount > 0) {
                  material.push(`${item.promptLogCount} ${translate('distill.view.config.promptLogsUnit')}`)
                }
                const materialText = material.length > 0
                  ? material.join(' · ')
                  : translate('distill.view.config.noMaterial')
                return h('label', {
                  key: item.sessionId,
                  style: CARD_STYLE(isSelected, isHovered),
                  tabIndex: 0,
                  onMouseEnter: () => setHoveredSessionId(item.sessionId),
                  onMouseLeave: () => setHoveredSessionId((prev) => (prev === item.sessionId ? null : prev)),
                  // Keyboard parity with the click target: Enter/Space toggles
                  // the card. Key events coming from the inner checkbox are
                  // handled natively, so they are ignored here.
                  onKeyDown: (event) => {
                    if (!event || (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar')) return
                    const target = event.target
                    const current = event.currentTarget
                    if (target && current && target !== current) return
                    if (typeof event.preventDefault === 'function') event.preventDefault()
                    toggleSelect(item.sessionId)
                  },
                },
                h('input', {
                  type: 'checkbox',
                  checked: isSelected,
                  tabIndex: -1,
                  'aria-label': title,
                  style: HIDDEN_INPUT_STYLE,
                  onChange: () => toggleSelect(item.sessionId),
                }),
                // Row 1: title (13.5px/600) + right-aligned relative time.
                h('div', { style: CARD_HEAD_STYLE },
                  // Truncated titles are a legitimate information tooltip: the
                  // ellipsis hides the full name otherwise.
                  h('span', { style: CARD_TITLE_STYLE, tip: title }, title),
                  relative ? h('span', { style: CARD_TIME_STYLE }, relative) : null),
                // Row 2: material readout + archived badge.
                h('div', { style: CARD_FOOT_STYLE },
                  h('span', { style: CARD_META_STYLE, tip: translate('distill.view.config.materialTip') },
                    materialText),
                  item.archived
                    ? h(Badge, {
                      tone: 'neutral',
                      icon: icons.Folder,
                      tip: translate('distill.view.config.archivedBadgeTip'),
                    }, translate('distill.view.config.archivedBadge'))
                    : null),
                // Row 3: the applied-history marker. Informational only — the
                // session can still join another batch.
                refined
                  ? h('div', { style: CARD_REFINED_ROW_STYLE },
                    h(Badge, {
                      tone: 'success',
                      icon: icons.CheckCircle,
                      tip: translate('distill.view.config.refinedBadgeTip'),
                    }, countText(translate('distill.view.config.refinedBadge'), refined.count)),
                    refinedLastAt
                      ? h('span', { style: CARD_REFINED_TEXT_STYLE },
                        fillLocaleTemplate(translate('distill.view.config.refinedLast'), { time: refinedLastAt }))
                      : null,
                    h('span', { style: CARD_REFINED_TEXT_STYLE },
                      fillLocaleTemplate(translate('distill.view.config.refinedFiles'), { files: refined.files })))
                  : null)
              }))),
          renderOverviewPanel())
      )
    }

    /* ------------------------------------------------------------ running */

    const renderRunning = () => {
      const progress = activeRun?.progress ?? {}
      const completed = Number(progress.completed) || 0
      const total = Number(progress.total) || 0
      const stageLabel = progress.stage && STAGE_KEYS[progress.stage]
        ? translate(STAGE_KEYS[progress.stage])
        : ''
      const startedAt = normalizeEpoch(activeRun?.createdAt ?? activeRun?.startedAt)
      const elapsed = Number.isFinite(startedAt) ? formatElapsedDuration(Date.now() - startedAt) : ''
      const rawLog = Array.isArray(progress.log) ? progress.log : []
      // Newest first. The default window is 12 result rows; the rest is revealed
      // by `logMore` so a long tail never pushes the cancel action off screen.
      const hasMore = rawLog.length > DISTILL_TIMELINE_DEFAULT_ROWS
      const visibleLog = logExpanded ? rawLog : rawLog.slice(-DISTILL_TIMELINE_DEFAULT_ROWS)
      const timeline = visibleLog.slice().reverse()

      return h('div', { style: BODY_STYLE },
        h('div', { style: RUNNING_STYLE },
          h('div', {
            style: RUNNING_GRID_STYLE,
            className: RUNNING_GRID_CLASS,
            'data-distill-running-grid': 'true',
          },
          // Left column: what stage we are in, the progress bar and the way out.
          h('div', { style: RUNNING_LEFT_STYLE, 'data-distill-running-left': 'true' },
            h('div', { style: RUNNING_TITLE_STYLE },
              h(icons.CircleNotch, { size: 16, color: ACCENT }),
              h('span', {}, translate('distill.view.running.heading'))),

            h('div', { style: RUNNING_META_ROW_STYLE },
              h('span', {}, stageLabel
                ? `${translate('distill.view.running.stage')} · ${stageLabel}`
                : translate('distill.view.running.stage')),
              elapsed
                ? h('span', {}, fillLocaleTemplate(
                  translate('distill.view.running.elapsed'),
                  { duration: elapsed },
                ))
                : null),

            h('div', { style: PROGRESS_ROW_STYLE },
              h('div', { style: PROGRESS_TRACK_STYLE },
                h('div', { style: PROGRESS_FILL_STYLE(total > 0 ? completed / total : 0) })),
              h('span', { style: PROGRESS_COUNT_STYLE }, `${completed}/${total}`)),

            cancelNote
              ? h('div', { style: EMPTY_HINT_STYLE },
                translate(cancelNote === 'cancelFailed'
                  ? 'distill.lock.cancelFailed'
                  : CANCEL_NOTE_KEYS[cancelNote] || 'distill.lock.cancelFailed'))
              : null,

            // Two-step cancel: the first click only reveals the confirmation and
            // writes nothing; only cancelYes posts distill-cancel.
            cancelConfirming
              ? h('div', { style: CANCEL_CONFIRM_STYLE },
                h('span', { style: CANCEL_CONFIRM_TEXT_STYLE },
                  translate('distill.view.running.cancelConfirm')),
                h('div', { style: HEADER_ACTIONS_STYLE },
                  h(Button, {
                    icon: icons.Prohibit,
                    variant: 'danger',
                    disabled: !activeRun,
                    onClick: handleCancel,
                  }, translate('distill.view.running.cancelYes')),
                  h(Button, {
                    icon: icons.X,
                    variant: 'ghost',
                    onClick: () => setCancelConfirming(false),
                  }, translate('distill.view.running.cancelNo'))))
              : h('div', { style: HEADER_ACTIONS_STYLE },
                h(Button, {
                  icon: icons.Prohibit,
                  variant: 'danger',
                  disabled: !activeRun,
                  title: translate('distill.view.running.cancel'),
                  onClick: () => setCancelConfirming(true),
                }, translate('distill.view.running.cancel')))),

          // Right column: the result timeline owns the full remaining width;
          // every row wraps instead of living in a narrow centered box.
          h('div', {
            style: RUNNING_TIMELINE_PANEL_STYLE,
            'data-distill-running-timeline': 'true',
          },
          h('div', { style: CAPTION_ROW_STYLE },
            h('span', { style: CAPTION_STYLE }, translate('distill.view.running.logTitle'))),
          // These rows are the stage's results, not tool names — say it so the
          // narration is read as an outcome timeline.
          h('div', { style: EMPTY_HINT_STYLE }, translate('distill.view.running.timelineHint')),
          timeline.length === 0
            ? h('div', { style: EMPTY_HINT_STYLE }, translate('distill.view.running.logEmpty'))
            : h('div', { style: TIMELINE_STYLE },
              timeline.map((entry, index) => {
                const at = formatLocalTime(entry?.at)
                const entryStage = entry && typeof entry.stage === 'string' && STAGE_KEYS[entry.stage]
                  ? translate(STAGE_KEYS[entry.stage])
                  : ''
                const message = entry && typeof entry.message === 'string' ? entry.message : ''
                const isLatest = index === 0
                return h('div', {
                  key: `${entry?.at ?? index}:${index}`,
                  style: TIMELINE_ROW_STYLE(index === timeline.length - 1, isLatest),
                },
                h('span', { style: TIMELINE_TIME_STYLE }, at),
                entryStage ? h('span', { style: TIMELINE_STAGE_STYLE }, entryStage) : null,
                h('span', { style: TIMELINE_MESSAGE_STYLE(isLatest) }, message),
                isLatest ? h('span', { style: TIMELINE_LATEST_STYLE }, translate('distill.view.running.logLatest')) : null)
              })),
          hasMore
            ? h('div', { style: LOG_TOGGLE_STYLE },
              h(Button, {
                icon: icons.CaretDown,
                variant: 'ghost',
                'aria-expanded': logExpanded,
                onClick: () => setLogExpanded((prev) => !prev),
                style: { padding: '2px 8px', fontSize: 11 },
              }, logExpanded
                ? translate('distill.view.running.logLess')
                : fillLocaleTemplate(translate('distill.view.running.logMore'), { count: rawLog.length })))
            : null))))
    }

    /* ------------------------------------------------------------- pending */

    // Pending = the confirmation page of the active (ready) run. With the
    // desk-injected confirm component the page owns its own heading, so the
    // view-level heading only renders in the placeholder fallback (the
    // DistillConfirm contract: plan prefers the polled run.plan; a missing
    // plan is handled by its internal fallback).
    //
    // Below the page sits the secondary row (暂存 / 放弃本次精炼): parking keeps
    // the plan and releases the lock, abandoning deletes the attempt. Neither
    // writes anything back. Both are guarded by `actionBusy` and failures are
    // reported in place with the Host code + message.
    const renderPendingActions = () => {
      const busy = actionBusy !== null
      const failure = pendingNote && pendingNote.kind === 'failed'
        ? h('div', { role: 'alert', style: PENDING_ERROR_STYLE, 'data-distill-pending-error': pendingNote.code || 'ERROR' },
          h(icons.Prohibit, { size: 12 }),
          h('span', {}, describeError(pendingNote.code, pendingNote.message)))
        : null
      if (abandonConfirming) {
        return h('div', {
          style: PENDING_PHASE_STYLE,
          'data-distill-pending-actions': 'true',
        },
        failure,
        h('div', { style: PENDING_CONFIRM_STYLE, 'data-distill-abandon-confirm': 'true' },
          h('span', { style: PENDING_HINT_STYLE }, translate('distill.view.pending.abandonConfirm')),
          h('div', { style: HEADER_ACTIONS_STYLE },
            h(Button, {
              icon: icons.Trash,
              variant: 'danger',
              disabled: busy,
              onClick: handleAbandon,
            }, translate('distill.view.pending.abandonYes')),
            h(Button, {
              icon: icons.X,
              variant: 'ghost',
              disabled: busy,
              onClick: () => setAbandonConfirming(false),
            }, translate('distill.view.pending.abandonNo')))))
      }
      return h('div', {
        style: PENDING_PHASE_STYLE,
        'data-distill-pending-actions': 'true',
      },
      failure,
      h('div', { style: PENDING_ACTIONS_STYLE },
        h('span', { style: PENDING_HINT_STYLE }, translate('distill.view.pending.parkHint')),
        h(Button, {
          icon: icons.PushPinSimple,
          variant: 'ghost',
          disabled: busy,
          tip: translate('distill.view.pending.parkHint'),
          onClick: handlePark,
        }, translate('distill.view.pending.park')),
        h(Button, {
          icon: icons.Trash,
          variant: 'danger',
          disabled: busy,
          onClick: () => {
            setPendingNote(null)
            setAbandonConfirming(true)
          },
        }, translate('distill.view.pending.abandon'))))
    }

    const renderPending = () => {
      const page = ConfirmComponent
        ? h(ConfirmComponent, {
          run: activeRun ?? undefined,
          plan: activeRun?.plan ?? undefined,
          workspaceId,
          sessionTitles: confirmSessionTitles,
          onApplied: handleConfirmApplied,
          onBack: backFromPending,
        })
        : h('div', { style: BODY_STYLE },
          h('div', { style: SECTION_STYLE },
            h('div', { style: CAPTION_ROW_STYLE },
              h('span', { style: CAPTION_STYLE }, translate('distill.view.pending.heading'))),
            h('div', { style: EMPTY_WRAP_STYLE },
              h(Empty, { icon: icons.Clock },
                h('span', {}, translate('distill.view.pending.placeholder'))))))
      return h('div', {
        style: PENDING_PHASE_STYLE,
        'data-distill-pending-phase': 'true',
      }, page, renderPendingActions())
    }

    /* -------------------------------------------------------------- result */

    /**
     * "N sessions · M files · K changes" of the result header. Every count is
     * read from persisted data; a missing count drops its segment instead of
     * printing an unresolved placeholder or a fabricated zero.
     */
    const buildResultMeta = (run, applied) => {
      const sessions = Array.isArray(run?.sessions) ? run.sessions.length : 0
      const plan = run?.plan
      const appliedFiles = Array.isArray(applied?.applied) ? applied.applied.length : null
      const planFiles = Array.isArray(plan?.targets) ? plan.targets.length : null
      const files = appliedFiles !== null ? appliedFiles : planFiles
      const selectedChanges = Array.isArray(applied?.selectedChangeIds) ? applied.selectedChangeIds.length : null
      const planChanges = isFiniteNumber(plan?.stats?.changes)
        ? plan.stats.changes
        : (plan && Array.isArray(plan.changes) ? plan.changes.length : null)
      const changes = selectedChanges !== null ? selectedChanges : planChanges
      const vars = {}
      if (sessions > 0) vars.sessions = sessions
      if (files !== null && files > 0) vars.files = files
      if (changes !== null && changes > 0) vars.changes = changes
      if (Object.keys(vars).length === 0) return ''
      return translate('distill.view.result.batchMeta')
        .replace(/\{(\w+)\}/g, (match, name) => (
          vars[name] !== undefined ? String(vars[name]) : match
        ))
        .split(/\s*·\s*/)
        .filter((part) => part !== '' && !/\{\w+\}/.test(part))
        .join(' · ')
    }

    /** `run.usage` block: a missing field omits its row (no fabricated zeros). */
    const renderUsage = () => {
      const usage = (activeRun && activeRun.usage)
        || (activeRun?.applyResult && activeRun.applyResult.usage)
        || (appliedPayload && appliedPayload.usage)
      if (!usage || typeof usage !== 'object') return null
      const rows = []
      if (isFiniteNumber(usage.calls)) {
        rows.push(h('span', { key: 'calls', style: USAGE_CELL_STYLE },
          fillLocaleTemplate(translate('distill.view.usage.calls'), { count: usage.calls })))
      }
      if (isFiniteNumber(usage.inputTokens)) {
        rows.push(h('span', { key: 'tokensIn', style: USAGE_CELL_STYLE },
          fillLocaleTemplate(translate('distill.view.usage.tokensIn'), { tokens: usage.inputTokens })))
      }
      if (isFiniteNumber(usage.outputTokens)) {
        rows.push(h('span', { key: 'tokensOut', style: USAGE_CELL_STYLE },
          fillLocaleTemplate(translate('distill.view.usage.tokensOut'), { tokens: usage.outputTokens })))
      }
      if (isFiniteNumber(usage.totalTokens)) {
        rows.push(h('span', { key: 'total', style: USAGE_CELL_STYLE },
          fillLocaleTemplate(translate('distill.view.usage.total'), { tokens: usage.totalTokens })))
      }
      if (rows.length === 0) return null
      return h('div', { style: USAGE_WRAP_STYLE },
        h('div', { style: CAPTION_ROW_STYLE },
          h('span', { style: CAPTION_STYLE }, translate('distill.view.usage.title'))),
        h('div', { style: USAGE_GRID_STYLE }, rows))
    }

    const renderResult = () => {
      const run = activeRun
      const applied = (run && typeof run.applyResult === 'object' && run.applyResult)
        || (appliedPayload && typeof appliedPayload === 'object' ? appliedPayload : null)
      const metaText = buildResultMeta(run, applied)
      const pinned = Boolean(pinnedRunId)
      const appliedAt = normalizeEpoch(applied?.appliedAt ?? run?.appliedAt ?? run?.updatedAt)
      const appliedAtText = Number.isFinite(appliedAt) ? formatLocalDateTime(appliedAt) : ''
      return h('div', { style: BODY_STYLE },
        // Result header: what this record is, when it was written back, and the
        // explicit way out. The pin note states that polling cannot move it.
        h('div', { style: RESULT_TOP_STYLE },
          h('div', { style: RESULT_TITLE_ROW_STYLE },
            h('div', { style: RESULT_HEADING_STYLE },
              h(icons.CheckCircle, { size: 16, color: `var(--dsw-alias-state-success-primary, ${NORD.nord14})` }),
              h('span', {}, translate('distill.view.result.heading'))),
            h(Button, {
              icon: icons.ArrowCounterClockwise,
              variant: 'ghost',
              title: translate('distill.view.result.back'),
              onClick: backToConfig,
            }, translate('distill.view.result.back'))),
          metaText ? h('div', { style: RESULT_META_STYLE }, metaText) : null,
          appliedAtText
            ? h('div', { style: RESULT_META_STYLE },
              fillLocaleTemplate(translate('distill.view.result.appliedAt'), { time: appliedAtText }))
            : null,
          pinned
            ? h('div', { style: RESULT_PIN_STYLE },
              h(icons.PushPinSimple, { size: 12 }),
              h('span', {}, translate('distill.view.result.pinHint')))
            : null),

        // Written-back ledger: the persisted apply record (or the live 200
        // payload). The confirmation page renders it in read-only applied mode,
        // and its `onBack` clears the pin. Legacy runs without a record explain
        // the missing stats instead of offering an interactive confirm page.
        ConfirmComponent && applied
          ? h(ConfirmComponent, {
            run,
            plan: run?.plan ?? undefined,
            workspaceId,
            sessionTitles: confirmSessionTitles,
            applied,
            onBack: backToConfig,
          })
          : null,
        !applied
          ? h('div', { style: EMPTY_HINT_STYLE }, translate('distill.confirm.applied.statsMissing'))
          : null,

        renderUsage(),
        h('div', { style: SECTION_STYLE },
          h('div', { style: CAPTION_ROW_STYLE },
            h('span', { style: CAPTION_STYLE }, translate('distill.view.result.summaryHeading'))),
          typeof renderSummary === 'function'
            ? renderSummary({ run: activeRun, runs: historyRuns })
            : h('div', { style: EMPTY_WRAP_STYLE },
              h(Empty, { icon: icons.CheckCircle },
                h('span', {}, translate('distill.view.result.placeholder'))))))
    }

    /* ------------------------------------------------------------- history */

    const renderHistory = () => {
      const runs = Array.isArray(historyRuns) ? historyRuns : []
      const noteText = historyNote?.kind === 'deleted'
        ? translate('distill.view.history.deleted')
        : historyNote?.kind === 'failed'
          ? [translate('distill.view.history.deleteFailed'),
            describeError(historyNote.code, historyNote.message)].filter(Boolean).join(' · ')
          : ''
      return h('div', { style: BODY_STYLE },
        noteText
          ? h('div', {
            role: historyNote.kind === 'failed' ? 'alert' : 'status',
            style: HISTORY_NOTE_STYLE(historyNote.kind),
          },
          h(historyNote.kind === 'deleted' ? icons.CheckCircle : icons.Prohibit, { size: 12 }),
          h('span', {}, noteText))
          : null,

        h('div', { style: SECTION_STYLE },
          h('div', {
            style: { ...CAPTION_ROW_STYLE, cursor: 'pointer' },
            'data-distill-section': 'history',
            onClick: event => {
              if (suppressesRowToggle(event)) return
              togglePanelSection('history')
            },
          },
            h('span', { style: CAPTION_STYLE },
              `${translate('distill.view.history.heading')} · ${runs.length}`),
            h(Button, {
              icon: panelCollapsed('history') ? icons.CaretRight : icons.CaretDown,
              iconOnly: true,
              variant: 'ghost',
              'aria-expanded': !panelCollapsed('history'),
              title: translate(panelCollapsed('history') ? 'finding.expand' : 'finding.collapse'),
              'aria-label': translate(panelCollapsed('history') ? 'finding.expand' : 'finding.collapse'),
              onClick: () => togglePanelSection('history'),
              style: { padding: 3 },
            })),
          panelCollapsed('history') ? null : runs.length === 0
            ? h('div', { style: EMPTY_WRAP_STYLE },
              h(Empty, { icon: icons.ArrowCounterClockwise },
                h('span', {}, translate('distill.view.history.empty'))))
            : h('div', { style: { display: 'flex', flexDirection: 'column', borderTop: `1px solid ${BORDER_SUBTLE}` } },
              runs.map((run, index) => {
                const sessionCount = Array.isArray(run.sessions) ? run.sessions.length : 0
                const meta = [
                  sessionCount > 0
                    ? countText(translate('distill.view.history.sessions'), sessionCount)
                    : '',
                  formatRelativeTime(run.appliedAt || run.updatedAt || run.createdAt, translate),
                ].filter(Boolean).join(' · ')
                const confirming = deleteTarget === run.id
                // A parked ready plan is still ready (可以写回) but released the
                // submission lock; the badge says 已暂存 without pretending the
                // plan became terminal or applied.
                const parked = run.status === 'ready' && run.parked === true
                const deletable = DELETABLE_RUN_STATUSES.has(run.status) || parked
                const rowBusy = deleting || historyParkingId === run.id
                return h('div', {
                  key: run.id,
                  style: HISTORY_ROW_STYLE(index === runs.length - 1),
                },
                h('div', { style: HISTORY_MAIN_STYLE },
                  h('div', { style: HISTORY_TITLE_ROW_STYLE },
                    h(Badge, { tone: RUN_STATUS_TONES[run.status] || 'neutral' },
                      parked
                        ? translate('distill.view.run.status.parked')
                        : runStatusLabel(run.status, translate)),
                    h('span', { style: HISTORY_META_STYLE }, meta)),
                  confirming
                    ? h('div', { style: CONFIRM_STRIP_STYLE },
                      h('span', { style: CONFIRM_TEXT_STYLE },
                        translate('distill.view.history.deleteConfirm')),
                      h('div', { style: HEADER_ACTIONS_STYLE },
                        h(Button, {
                          icon: icons.Trash,
                          variant: 'danger',
                          disabled: deleting,
                          onClick: () => confirmDelete(run.id),
                        }, translate('distill.view.history.deleteYes')),
                        h(Button, {
                          icon: icons.X,
                          variant: 'ghost',
                          disabled: deleting,
                          onClick: () => setDeleteTarget(null),
                        }, translate('distill.view.history.deleteNo'))))
                    : null),
                confirming
                  ? null
                  : h('div', { style: HISTORY_ACTIONS_STYLE },
                    run.status === 'applied'
                      ? h(Button, {
                        icon: icons.ArrowRight,
                        variant: 'ghost',
                        title: translate('distill.view.history.openResult'),
                        onClick: () => openHistoryResult(run),
                      }, translate('distill.view.history.openResult'))
                      : null,
                    parked
                      ? h(Button, {
                        icon: icons.ArrowCounterClockwise,
                        variant: 'ghost',
                        title: translate('distill.view.history.openConfirm'),
                        disabled: rowBusy,
                        onClick: () => { void handleOpenParkedConfirm(run) },
                      }, translate('distill.view.history.openConfirm'))
                      : null,
                    h(Button, {
                      icon: icons.Trash,
                      variant: 'icon',
                      iconOnly: true,
                      title: translate('distill.view.history.delete'),
                      disabled: !deletable || rowBusy,
                      tip: deletable
                        ? translate('distill.view.history.deleteConfirm')
                        : translate('distill.view.error.code.RUN_NOT_READY'),
                      onClick: () => {
                        setHistoryNote(null)
                        setDeleteTarget(run.id)
                      },
                    })))
              }))))
    }

    const phaseBody = {
      config: renderConfig,
      running: renderRunning,
      pending: renderPending,
      result: renderResult,
      history: renderHistory,
    }[phase] || renderConfig

    return h('div', { style: CONTAINER_STYLE },
      h('div', { style: HEADER_STYLE },
        h('div', { style: TITLE_ROW_STYLE },
          h('div', { style: TITLE_STYLE },
            h(icons.Brain, { size: 16, color: ACCENT }),
            h('span', {}, translate('distill.view.title'))),
          // Secondary navigation of the phase, top-right. The config phase's
          // primary start action lives in the sticky batch bar below, so it is
          // never repeated and never scrolls out of reach.
          h('div', { style: HEADER_ACTIONS_STYLE },
            phase === 'config'
              ? h(Button, {
                icon: icons.Clock,
                variant: 'ghost',
                title: translate('distill.view.history.heading'),
                onClick: () => {
                  // Stale confirm/feedback state never leaks into a new visit.
                  setDeleteTarget(null)
                  setHistoryNote(null)
                  setResultNote(null)
                  gotoPhase('history')
                },
              }, translate('distill.view.history.heading'))
              : phase === 'history'
                ? h(Button, {
                  icon: icons.X,
                  variant: 'ghost',
                  title: translate('distill.view.history.back'),
                  onClick: () => {
                    setDeleteTarget(null)
                    gotoPhase('config')
                  },
                }, translate('distill.view.history.back'))
                : null)),
        h('div', { style: SUBTITLE_STYLE }, translate('distill.view.subtitle')),
        phase === 'config' ? renderBatchBar() : null),
      phaseBody(),
      // Scoped responsive overrides (inline styles cannot carry media queries).
      h('style', { 'data-pd-distill-responsive': 'true' }, DISTILL_RESPONSIVE_CSS))
  }
}
