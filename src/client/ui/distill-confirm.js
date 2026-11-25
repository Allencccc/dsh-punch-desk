/**
 * DistillConfirm — the confirmation page + applied page + result-page content
 * of the Desk distillation flow (spec §10 / plan Task 3.2 / UX rework).
 *
 * Two exported surfaces, both built by one factory so React, hyperscript,
 * services and the translate function stay injected (never imported):
 *
 *   const DistillConfirm = createDistillConfirm({ h, React, services, t })
 *   - DistillConfirm({ run, plan, workspaceId, checks?, sessionTitles?, onApplied?, applied?, onBack?, onViewResult? })
 *       the confirmation page, laid out as a three-bucket ledger:
 *         · applied  (only after a 200 apply: what now lives in the docs,
 *                     original text + rationale kept read-only for audit)
 *         · review   (changes that still need a per-item human decision)
 *         · conflict (baseline drift on disk + evidence conflicts that code
 *                     and session adjudication could not settle)
 *       Conflicts already adjudicated by code/session are shown as a read-only
 *       note above the ledger (context, not to-do). Proposals the deterministic
 *       shaping dropped (`plan.dropped`) stay visible so the plan never looks
 *       silently shortened. "not adopted" is a light marker on a review item,
 *       not a fourth bucket; "blocked by static validation" is a badge, not a
 *       bucket. A single "only pending" filter hides already-accepted /
 *       already-written rows.
 *
 *       UX round 2 (user feedback, in this file):
 *         · the whole action bar is sticky at the top (`position: sticky`):
 *           back-to-index, pending filter, select-qualified, selected count and
 *           the primary apply button are always in the same place; the disabled
 *           reason is printed in the bar instead of at the page tail;
 *         · the two-step confirmation opens directly under that bar (inside the
 *           sticky block) and reports `applying` in place — no scroll jump;
 *         · every review card shows a read-only before/after comparison
 *           (`change.beforeText` vs `change.proposedText`) with `kind` + section
 *           anchor; create-file and older batches degrade to explicit copy;
 *         · the applied page order is: conclusion badge → plan summary →
 *           written-back detail → write-back stats → persistence hint, with a
 *           sticky bar carrying back-to-index and (optionally) view-result, and
 *           an honest `statsMissing` line for records without stats data.
 *   - DistillConfirm.ResultContent({ run, onRenew?, sessionTitles? })
 *       the result-page content consumed through the distill-view
 *       renderSummary slot.
 *
 * Contract notes (mirrors Host routes in index.js / distill-host.js):
 *   - POST api/punch-desk/distill-apply
 *     body { runId, selectedChangeIds, baseHashes, rationaleEdits }
 *     200 → { ok, applied[], skipped[], readBackOk, fingerprints[], runStatus }
 *     409 → { ok: false, code, ...code-specific fields }
 *   - POST api/punch-desk/distill-review
 *     body { runId, ignoredChangeIds, reviewedChangeIds } → { ok, review }
 *     Optimistic: the marker flips immediately, a failed write rolls the
 *     marker (and the touched selection) back and surfaces the error.
 *   - POST api/punch-desk/distill-rebase
 *     body { runId, filePath, apply:false } → { ok, rebase: { previews[] } }
 *     body { runId, filePath, apply:true }  → { ok, plan }
 *     Two steps: the first click fetches the disk-vs-plan preview, the second
 *     click re-anchors the file's baseline and swaps in the returned plan.
 *     Nothing is ever written to the docs by a rebase.
 *   - `baseHashes` is assembled from plan.targets[].fileBaseHash for the files
 *     that carry at least one effective selected change; the authoritative
 *     value stays the server-side persisted plan (spec §11.1).
 *   - Static validation checks: the Host persists `checks[]` on the plan. The
 *     component prefers an explicit `checks` prop, then plan.checks. Error
 *     checks make a change "blocked": unchecked by default, not selectable,
 *     never sent to the apply; the real reason rides on the badge tooltip.
 *   - Selection semantics reuse the domain pure functions defaultSelection /
 *     validateDependencySelection / changeGrade from src/domain/distill-plan.js
 *     — no duplicate rules here.
 *   - Evidence is always human readable (session title · turn). Session ids are
 *     read from `props.sessionTitles` (object or array), then run.summaries[].title;
 *     a session id / hash / raw JSON is never printed.
 *
 * Visual language: Nord tokens (./nord.js), Phosphor vector icons through
 * bits.js, no host DOM access, no emoji, no box-shadow, no Tailwind.
 */

import {
  changeGrade,
  defaultSelection,
  validateDependencySelection,
} from '../../domain/distill-plan.js'
import { createBits } from './bits.js'
import { NORD } from './nord.js'

/** Backup directory shown in the two-step confirmation (data, not chrome). */
const BACKUP_DIR_DISPLAY = '~/.dsh/storages/punch_desk/backups/'

/** Change kind → locale key (§8.4 four deterministic kinds). */
const KIND_KEYS = Object.freeze({
  'append-section': 'distill.confirm.kind.append-section',
  'insert-into-section': 'distill.confirm.kind.insert-into-section',
  'replace-block': 'distill.confirm.kind.replace-block',
  'create-file': 'distill.confirm.kind.create-file',
})

/** Evidence grade → locale key (§6.2). */
const GRADE_KEYS = Object.freeze({
  resolved: 'distill.confirm.grade.resolved',
  commit: 'distill.confirm.grade.commit',
  submitted: 'distill.confirm.grade.submitted',
})

/** Grade badge tone mapping. */
const GRADE_TONES = Object.freeze({
  resolved: 'success',
  commit: 'info',
  submitted: 'warn',
})

/** Conflict resolution tri-state → locale key (spec §5.2 conflicts). */
const RESOLVED_BY_KEYS = Object.freeze({
  code: 'distill.confirm.conflict.code',
  session: 'distill.confirm.conflict.session',
  unresolved: 'distill.confirm.conflict.unresolved',
})

/** §13.3 error codes → locale key. */
const ERROR_CODE_KEYS = Object.freeze({
  CAS_CONFLICT: 'distill.confirm.error.code.CAS_CONFLICT',
  RECOVERY_CONFLICT: 'distill.confirm.error.code.RECOVERY_CONFLICT',
  BACKUP_CORRUPT: 'distill.confirm.error.code.BACKUP_CORRUPT',
  BACKUP_MISSING: 'distill.confirm.error.code.BACKUP_MISSING',
  VALIDATION_FAILED: 'distill.confirm.error.code.VALIDATION_FAILED',
  RUN_NOT_READY: 'distill.confirm.error.code.RUN_NOT_READY',
  CANCELED: 'distill.confirm.error.code.CANCELED',
})

/** Summary source → locale key (run.summaries[].source). */
const SOURCE_KEYS = Object.freeze({
  digest: 'distill.confirm.result.source.digest',
  llm: 'distill.confirm.result.source.llm',
})

/** Plan-level dropped-proposal reason → locale key (deterministic shaping). */
const DROPPED_REASON_KEYS = Object.freeze({
  'root-file': 'distill.confirm.dropped.reason.root-file',
  'no-changelog': 'distill.confirm.dropped.reason.no-changelog',
  default: 'distill.confirm.dropped.reason.default',
})

const CONTAINER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

const SECTION_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const SECTION_HEADING_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: `var(--pd-accent, var(--dsw-alias-button-primary-fill, ${NORD.nord8}))`,
}

const SUMMARY_TEXT_STYLE = {
  fontSize: 13,
  lineHeight: 1.6,
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
}

const STATS_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

const STAT_STYLE = {
  fontSize: 12,
  color: `var(--pd-text-secondary, var(--dsw-alias-label-secondary, ${NORD.nord4}))`,
}

/** One ledger bucket: heading + one-line hint + a hairline separator. */
const BUCKET_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  paddingTop: 10,
  borderTop: `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`,
}

const BUCKET_HEAD_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
}

const BUCKET_TITLE_STYLE = {
  fontSize: 13,
  fontWeight: 700,
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
}

const BUCKET_HINT_STYLE = {
  fontSize: 12,
  lineHeight: 1.5,
  color: `var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, ${NORD.nord3}))`,
}

const FILE_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 10px',
  background: `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord1}))`,
  borderRadius: '6px 6px 0 0',
}

const CHANGE_ROW_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 10px 8px 26px',
  borderBottom: `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`,
}

const CHANGE_HEAD_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

/** Right-aligned marker cluster of a review row (ignored / blocked). */
const MARKER_GROUP_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  marginLeft: 'auto',
  flexWrap: 'wrap',
}

const CHANGE_ID_STYLE = {
  fontSize: 12,
  fontWeight: 700,
  fontFamily: 'ui-monospace, monospace',
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
}

const FILE_PATH_STYLE = {
  fontSize: 12,
  fontFamily: 'ui-monospace, monospace',
  flex: 1,
  minWidth: 160,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
}

const BODY_TEXT_STYLE = {
  fontSize: 12,
  lineHeight: 1.5,
  color: `var(--pd-text-secondary, var(--dsw-alias-label-secondary, ${NORD.nord4}))`,
}

const EVIDENCE_TEXT_STYLE = {
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  color: `var(--pd-text-secondary, var(--dsw-alias-label-secondary, ${NORD.nord4}))`,
}

const META_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flexWrap: 'wrap',
}

const CHECKBOX_STYLE = {
  flexShrink: 0,
  margin: 0,
}

const TEXTAREA_STYLE = {
  width: '100%',
  boxSizing: 'border-box',
  fontSize: 12,
  lineHeight: 1.5,
  padding: '6px 8px',
  borderRadius: 6,
  border: `1px solid var(--pd-border-default, var(--dsw-alias-border-l1, ${NORD.nord2}))`,
  background: `var(--pd-bg-card, var(--dsw-alias-bg-layer-1, ${NORD.nord0}))`,
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
}

const ERROR_BANNER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 12px',
  borderRadius: 6,
  border: `1px solid var(--dsw-alias-state-error-primary, ${NORD.nord11})`,
  color: `var(--dsw-alias-state-error-primary, ${NORD.nord11})`,
  fontSize: 12,
  fontWeight: 600,
}

const WARN_TEXT_STYLE = {
  fontSize: 12,
  lineHeight: 1.5,
  color: `var(--dsw-alias-state-warn-primary, ${NORD.nord12})`,
}

const CONFIRM_PANEL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '10px 12px',
  borderRadius: 6,
  border: `1px solid var(--dsw-alias-state-warn-primary, ${NORD.nord12})`,
  background: `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord1}))`,
}

const EMPTY_HINT_STYLE = {
  padding: '14px 2px',
  fontSize: 12,
  lineHeight: 1.5,
  color: `var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, ${NORD.nord3}))`,
}

const APPLIED_ROW_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 10px',
  borderBottom: `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`,
}

/**
 * Maximum visible height of a long code body.
 *
 * The body is always rendered in full and simply scrolls past this height:
 * there is no fold, no toggle and no data cut. One scroll window is the
 * simplest shape that keeps every line reachable ("long content scrollable,
 * data never truncated") without asking the user for an interaction.
 */
const CODE_BLOCK_MAX_HEIGHT = 260

/** Shared look of every code body: monospace, panel background, wrapped, scrollable. */
const CODE_BLOCK_STYLE = {
  margin: 0,
  padding: '8px 10px',
  borderRadius: 6,
  fontSize: 11.5,
  lineHeight: 1.55,
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  border: `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`,
  background: `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord1}))`,
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
  maxHeight: CODE_BLOCK_MAX_HEIGHT,
  overflowY: 'auto',
}

/** Optional label stacked above one code body (before / after / written-back). */
const CODE_PANEL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

/**
 * Sticky top action bar shared by the confirmation page and the applied page.
 *
 * The user reported having to hunt for the primary action across the whole
 * page; the bar therefore pins itself to the top of the scroll container
 * (`position: sticky; top: 0`) with the page/card background and a bottom
 * hairline so content scrolling underneath never bleeds through. Nothing here
 * navigates or scrolls on click, so focus and scroll position survive.
 */
const STICKY_BAR_STYLE = {
  position: 'sticky',
  top: 0,
  zIndex: 6,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: '8px 0 10px',
  background: `var(--pd-bg-card, var(--dsw-alias-bg-layer-1, ${NORD.nord0}))`,
  borderBottom: `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`,
}

const ACTION_BAR_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  flexWrap: 'wrap',
}

/** Left cluster of the bar: label + one-line caption (no extra chrome). */
const ACTION_BAR_LEFT_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

/** Right cluster of the bar: every action the user needs, one row. */
const ACTION_BAR_RIGHT_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  marginLeft: 'auto',
  flexWrap: 'wrap',
}

const ACTION_BAR_LABEL_STYLE = {
  fontSize: 13,
  fontWeight: 700,
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
}

const ACTION_BAR_CAPTION_STYLE = {
  fontSize: 11,
  lineHeight: 1.4,
  color: `var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, ${NORD.nord3}))`,
}

/** In-place disabled / progress reason directly under the bar's controls. */
const ACTION_BAR_REASON_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11.5,
  lineHeight: 1.5,
  color: `var(--pd-text-secondary, var(--dsw-alias-label-secondary, ${NORD.nord4}))`,
}

/** Before/after comparison of one change (structural, not a line diff). */
const DIFF_GROUP_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  paddingTop: 2,
}

const DIFF_GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
  gap: 8,
  alignItems: 'start',
}

const DIFF_COL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  minWidth: 0,
}

const DIFF_LABEL_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: '0.02em',
  color: `var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, ${NORD.nord3}))`,
}

/** Drift conflict card (baseline changed on disk): warn rail, panel surface. */
const DRIFT_CARD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: '10px 12px',
  borderLeft: `2px solid var(--dsw-alias-state-warn-primary, ${NORD.nord12})`,
  background: `var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, ${NORD.nord1}))`,
}

const PREVIEW_ROW_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '8px 10px',
  borderBottom: `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, ${NORD.nord3}))`,
}

const MD_HEADING_STYLE = {
  fontSize: 12,
  fontWeight: 700,
  color: `var(--pd-text-primary, var(--dsw-alias-label-primary, ${NORD.nord6}))`,
}

/** Fill a {count}/{ids}/{status}/{file} locale template with plain data. */
function fill(template, vars) {
  let out = String(template ?? '')
  for (const [name, value] of Object.entries(vars || {})) {
    out = out.split(`{${name}}`).join(String(value))
  }
  return out
}

/** Short hash display (7 chars); used only for the audit copy of a new file hash. */
function shortHash(hash) {
  const text = typeof hash === 'string' ? hash : ''
  return text.length > 7 ? `${text.slice(0, 7)}…` : text
}

/** Split preview markdown into blank-line-separated blocks. */
function markdownBlocks(markdown) {
  const blocks = []
  let current = []
  for (const line of String(markdown ?? '').split('\n')) {
    if (line.trim() === '') {
      if (current.length > 0) { blocks.push(current); current = [] }
      continue
    }
    current.push(line)
  }
  if (current.length > 0) blocks.push(current)
  return blocks
}

/** Compact elapsed duration (`m:ss`), digits only so no chrome copy leaks in. */
function formatDurationMs(ms) {
  const total = Number(ms)
  if (!Number.isFinite(total) || total < 0) return '0:00'
  const seconds = Math.floor(total / 1000)
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** Persisted plan.review → ignored change ids. */
function ignoredFromPlan(plan) {
  const review = plan && typeof plan.review === 'object' ? plan.review : null
  return Array.isArray(review?.ignoredChangeIds) ? review.ignoredChangeIds : []
}

/** Persisted plan.review → reviewed change ids. */
function reviewedFromPlan(plan) {
  const review = plan && typeof plan.review === 'object' ? plan.review : null
  return Array.isArray(review?.reviewedChangeIds) ? review.reviewedChangeIds : []
}

/** Normalise a `{ id: value }` record into `Map<sessionId, title>`. */
function pushSessionTitle(map, sessionId, value) {
  if (typeof sessionId !== 'string' || sessionId === '') return
  const title = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' && typeof value.title === 'string' ? value.title : '')
  const text = title.trim()
  if (text === '') return
  if (!map.has(sessionId)) map.set(sessionId, text)
}

/**
 * Session titles for human-readable evidence. Sources, in order of trust:
 * the `sessionTitles` / `titles` / `sessions` props (object or array) and
 * run.summaries[].title (always present, derived from the analysed sessions).
 * @returns {Map<string, string>}
 */
function collectSessionTitles(props, run) {
  const map = new Map()
  const sources = [props?.sessionTitles, props?.sessionTitleMap, props?.titles, props?.sessions]
  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const item of source) {
        if (!item || typeof item !== 'object') continue
        pushSessionTitle(map, item.sessionId ?? item.id, item.title ?? item.name)
      }
    } else if (source && typeof source === 'object') {
      for (const [sessionId, value] of Object.entries(source)) pushSessionTitle(map, sessionId, value)
    }
  }
  for (const summary of Array.isArray(run?.summaries) ? run.summaries : []) {
    if (!summary || typeof summary !== 'object') continue
    pushSessionTitle(map, summary.sessionId, summary.title)
  }
  return map
}

/**
 * Human-readable evidence label (never a bare session id / hash / JSON):
 * "title · turn N", "turn N" or the session-level fallback.
 */
function evidenceLabel(evidence, titles, translate) {
  const sessionId = typeof evidence?.sessionId === 'string' ? evidence.sessionId : ''
  const title = sessionId ? (titles.get(sessionId) || '') : ''
  const turn = Number.isInteger(evidence?.turn) && evidence.turn >= 0 ? evidence.turn : null
  if (title !== '' && turn !== null) {
    return fill(translate('distill.confirm.evidence.session'), { title, turn })
  }
  if (title !== '') return title
  if (turn !== null) return fill(translate('distill.confirm.evidence.turn'), { turn })
  return translate('distill.confirm.evidence.noTurn')
}

/** All evidence labels of a change, in plan order. */
function changeEvidenceLabels(change, titles, translate) {
  const items = Array.isArray(change?.evidence) ? change.evidence : []
  return items.filter((item) => item && typeof item === 'object')
    .map((item) => evidenceLabel(item, titles, translate))
}

/** Normalise `{ ok:false, error }` (new routes) and `{ ok:false, code, error }`. */
function errorPayload(data, status) {
  const raw = data?.error
  const code = (typeof data?.code === 'string' && data.code !== '')
    ? data.code
    : (raw && typeof raw === 'object' && typeof raw.code === 'string' ? raw.code : '')
  const fromObject = raw && typeof raw === 'object' && typeof raw.message === 'string' ? raw.message : ''
  const fromString = typeof raw === 'string' ? raw : ''
  return { code, message: fromObject || fromString || `HTTP ${status}` }
}

/**
 * Map a dropped-proposal reason (code or Host prose) to its locale key:
 * deterministic shaping uses stable codes, older persisted runs carry prose.
 */
function droppedReasonKey(reason) {
  if (typeof reason !== 'string') return DROPPED_REASON_KEYS.default
  if (DROPPED_REASON_KEYS[reason]) return DROPPED_REASON_KEYS[reason]
  if (/root|tree|navigation/i.test(reason)) return DROPPED_REASON_KEYS['root-file']
  if (/changelog/i.test(reason)) return DROPPED_REASON_KEYS['no-changelog']
  return DROPPED_REASON_KEYS.default
}

/**
 * Factory for the DistillConfirm component tree.
 *
 * @param {object} deps
 * @param {Function} deps.h hyperscript (React.createElement)
 * @param {object} deps.React injected React hook namespace (never imported here)
 * @param {object} [deps.services] reserved injected services (unused today)
 * @param {Function} [deps.t] locale translate function; identity fallback
 * @returns {Function} DistillConfirm component; the result-page content is
 *   attached as DistillConfirm.ResultContent for the renderSummary slot.
 */
export function createDistillConfirm({ h, React, services, t } = {}) {
  const { Badge, Button, icons } = createBits(h)
  const translate = typeof t === 'function' ? t : (key) => key

  /**
   * One read-only code block, always rendered in full.
   *
   * Deliberately no expand/collapse affordance: a long body scrolls inside the
   * capped window, so no line is truncated and no click is needed to read the
   * diff. `blockId` and `side` remain stable test hooks.
   *
   * @param {object} params
   * @param {string} params.text body, rendered verbatim (never truncated)
   * @param {string} params.blockId stable key of this block
   * @param {string} [params.side] 'before' | 'after' (diff grid test hook)
   * @param {string} [params.label] optional label rendered above the body
   * @returns {object} React element
   */
  function renderCodeBlock({ text, blockId, side, label }) {
    return h('div', {
      style: CODE_PANEL_STYLE,
      'data-code-panel': blockId,
    },
    label === undefined || label === null
      ? null
      : h('div', { style: DIFF_LABEL_STYLE }, label),
    h('pre', {
      style: CODE_BLOCK_STYLE,
      'data-diff-text': side,
      'data-code-text': blockId,
    }, String(text ?? '')))
  }

  /**
   * Result-page content for the distill-view renderSummary slot.
   *
   * @param {object} [props]
   * @param {object} [props.run] applied DistillationRun carrying summaries[]
   * @param {Function} [props.onRenew] renew callback, invoked with the summary
   */
  function DistillResultContent({ run, onRenew, sessionTitles } = {}) {
    const summaries = Array.isArray(run?.summaries)
      ? run.summaries.filter((item) => item && typeof item === 'object')
      : []
    const titles = collectSessionTitles({ sessionTitles }, run)

    const body = summaries.length === 0
      ? [h('div', { style: EMPTY_HINT_STYLE }, translate('distill.confirm.result.empty'))]
      : summaries.map((summary, index) => {
        const blocks = markdownBlocks(summary.markdown).map((lines, blockIndex) => {
          const isHeading = /^#{1,6}\s+/.test((lines[0] || '').trim())
          return h('div', {
            key: `block-${blockIndex}`,
            style: isHeading ? MD_HEADING_STYLE : BODY_TEXT_STYLE,
          }, lines.join('\n'))
        })
        const isLast = index === summaries.length - 1
        const title = typeof summary.title === 'string' && summary.title.trim() !== ''
          ? summary.title
          : (titles.get(summary.sessionId) || translate('distill.confirm.result.untitled'))
        return h('div', {
          key: `summary-${index}`,
          style: isLast
            ? { ...CHANGE_ROW_STYLE, borderBottom: 'none' }
            : CHANGE_ROW_STYLE,
        },
        h('div', { style: CHANGE_HEAD_STYLE },
          h('span', { style: FILE_PATH_STYLE }, title),
          h('span', { style: META_STYLE },
            h(Badge, {
              tone: 'neutral',
              icon: icons.ChatTeardropText,
            }, translate(SOURCE_KEYS[summary.source] || 'distill.confirm.result.source.llm')))),
        ...blocks,
        h('div', { style: META_STYLE },
          h(Button, {
            icon: icons.ArrowCounterClockwise,
            title: translate('distill.confirm.result.renewHint'),
            onClick: () => {
              if (typeof onRenew === 'function') onRenew({ summary })
            },
          }, translate('distill.confirm.result.renew'))))
      })

    return h('div', { style: SECTION_STYLE },
      h('div', { style: SECTION_HEADING_STYLE },
        h(icons.ChatTeardropText, { size: 14 }),
        h('span', {}, translate('distill.confirm.result.heading'))),
      ...body)
  }

  /**
   * Confirmation / applied page component.
   *
   * @param {object} [props]
   * @param {object} [props.run] DistillationRun (ready; re-renders on change)
   * @param {object} [props.plan] ChangePlan (§5.2), may carry persisted checks[]
   * @param {string} [props.workspaceId] informational scope id (apply is run-scoped)
   * @param {Array} [props.checks] pre-computed validation checks (override plan.checks)
   * @param {object|Array} [props.sessionTitles] sessionId → title map (or records)
   * @param {Function} [props.onApplied] invoked with the 200 apply response payload
   * @param {object} [props.applied] captured apply payload passed back down
   *   (the applied page also reads `run.applyResult` when the parent has none)
   * @param {Function} [props.onBack] back-to-index callback (sticky bar)
   * @param {Function} [props.onViewResult] optional "view this result" callback
   *   used by the applied page when the host view exposes a result phase
   */
  function DistillConfirm(props = {}) {
    const { run, onApplied } = props

    // A rebase returns the refreshed plan; it wins over the prop copy while the
    // same run is on screen (a brand-new run never inherits a stale override).
    const runKey = (run && typeof run.id === 'string' && run.id !== '')
      ? run.id
      : (props.plan && typeof props.plan.runId === 'string' ? props.plan.runId : '')
    const [rebaseOverride, setRebaseOverride] = React.useState(null)
    const activePlan = (rebaseOverride && rebaseOverride.runKey === runKey)
      ? rebaseOverride.plan
      : props.plan
    const checksSource = Array.isArray(props.checks)
      ? props.checks
      : (Array.isArray(activePlan?.checks) ? activePlan.checks : [])

    const [selected, setSelected] = React.useState(() => new Set(defaultSelection(activePlan, checksSource)))
    const [ignoredIds, setIgnoredIds] = React.useState(() => new Set(ignoredFromPlan(activePlan)))
    const [reviewedIds, setReviewedIds] = React.useState(() => new Set(reviewedFromPlan(activePlan)))
    const [reviewBusyId, setReviewBusyId] = React.useState(null)
    const [reviewError, setReviewError] = React.useState(null)
    const [onlyPending, setOnlyPending] = React.useState(false)
    const [driftFiles, setDriftFiles] = React.useState(() => new Set())
    const [rebaseState, setRebaseState] = React.useState({})
    // File name of the most recent successful re-anchor, shown as a status line so
    // the drift card vanishing does not read as "nothing happened".
    const [rebaseNotice, setRebaseNotice] = React.useState(null)
    const [rationaleEdits, setRationaleEdits] = React.useState({})
    const [editingChangeId, setEditingChangeId] = React.useState(null)
    const [rationaleDraft, setRationaleDraft] = React.useState('')
    const [confirming, setConfirming] = React.useState(false)
    const [applying, setApplying] = React.useState(false)
    const [localApplied, setLocalApplied] = React.useState(null)
    const [applyError, setApplyError] = React.useState(null)
    // Remembers whether an ignored change was selected before the marker landed,
    // so undoIgnore restores the exact pre-ignore selection.
    const ignoreMemory = React.useRef(new Map())
    // Snapshot of the apply request, used by the applied page (counts/duration).
    const applySnapshot = React.useRef(null)

    // The immediate 200 payload wins; a parent may also hand a captured payload
    // back down (`props.applied`), and a reloaded/replayed applied run carries
    // the persisted `run.applyResult`. All three feed the same applied page so a
    // refresh or a history re-open keeps the full audit trail.
    const appliedResult = localApplied
      ?? (props.applied && typeof props.applied === 'object' ? props.applied : null)
      ?? (run?.applyResult && typeof run.applyResult === 'object' ? run.applyResult : null)

    const titles = collectSessionTitles(props, run)
    const targets = Array.isArray(activePlan?.targets) ? activePlan.targets : []
    const conflicts = Array.isArray(activePlan?.conflicts) ? activePlan.conflicts : []
    const checks = Array.isArray(checksSource) ? checksSource : []
    const errorChecks = checks.filter((item) => item?.level === 'error')
    const warnChecks = checks.filter((item) => item?.level === 'warn')
    const hasErrors = errorChecks.length > 0
    const runReady = !run || run.status === 'ready'
    const runId = typeof activePlan?.runId === 'string' ? activePlan.runId : (run?.id || '')

    const changeById = new Map()
    for (const target of targets) {
      for (const change of Array.isArray(target.changes) ? target.changes : []) {
        changeById.set(change.id, { change, target })
      }
    }

    // ------------------------------------------------- static validation blocks
    const planWideBlocked = errorChecks.find((item) => item && !item.file && !item.changeId)
    const blockedByChangeId = new Map()
    const blockedByFile = new Map()
    for (const item of errorChecks) {
      if (!item) continue
      const reason = (typeof item.message === 'string' && item.message !== '')
        ? item.message
        : String(item.code || '')
      if (typeof item.changeId === 'string') blockedByChangeId.set(item.changeId, reason)
      else if (typeof item.file === 'string' && !blockedByFile.has(item.file)) blockedByFile.set(item.file, reason)
    }
    const blockedReasonOf = (changeId) => {
      const entry = changeById.get(changeId)
      if (!entry) return null
      if (blockedByChangeId.has(changeId)) return blockedByChangeId.get(changeId)
      if (blockedByFile.has(entry.target.file)) return blockedByFile.get(entry.target.file)
      if (planWideBlocked) {
        return (typeof planWideBlocked.message === 'string' && planWideBlocked.message !== '')
          ? planWideBlocked.message
          : String(planWideBlocked.code || '')
      }
      return null
    }
    const isBlocked = (changeId) => blockedReasonOf(changeId) !== null
    const isIgnored = (changeId) => ignoredIds.has(changeId)
    // A re-anchored plan marks equivalent content that already sits on disk as
    // `skipReason: 'already-present'`: it is effectively written back, so it is
    // never selected again (the Host skips it anyway).
    const isAlreadyPresent = (changeId) => changeById.get(changeId)?.change?.skipReason === 'already-present'
    const isSelectable = (changeId) => changeById.has(changeId)
      && !isBlocked(changeId) && !isIgnored(changeId) && !isAlreadyPresent(changeId)

    // Selection that actually reaches the apply: blocked / ignored / drifted /
    // already-present changes never do (the Host re-checks all three, this is
    // the UI contract).
    const effectiveSelectedIds = Array.from(selected).filter((changeId) => {
      const entry = changeById.get(changeId)
      if (!entry) return false
      if (isBlocked(changeId) || isIgnored(changeId) || isAlreadyPresent(changeId)) return false
      if (driftFiles.has(entry.target.file)) return false
      return true
    })
    const effectiveSelectedFiles = new Set(
      effectiveSelectedIds.map((changeId) => changeById.get(changeId)?.target?.file).filter(Boolean),
    )
    const selectedTargets = targets.filter((target) => effectiveSelectedFiles.has(target.file))
    const baseHashes = {}
    for (const target of selectedTargets) {
      baseHashes[target.file] = typeof target.fileBaseHash === 'string' ? target.fileBaseHash : null
    }

    const dependency = validateDependencySelection(activePlan, effectiveSelectedIds)
    const depMissingByChangeId = new Map(
      (dependency.missing || []).map((item) => [item.changeId, item.dependsOn]),
    )

    const unresolvedConflicts = conflicts.filter((conflict) => conflict?.resolvedBy === 'unresolved')
    const adjudicatedConflicts = conflicts.filter((conflict) => conflict?.resolvedBy !== 'unresolved')
    const ignoredCount = Array.from(ignoredIds).filter((changeId) => changeById.has(changeId)).length
    const conflictCount = driftFiles.size + unresolvedConflicts.length

    const applyBlockedReason = !runReady
      ? 'runStatus'
      : (driftFiles.size > 0
        ? 'drift'
        : ((hasErrors || !dependency.ok)
          ? 'blocked'
          : (effectiveSelectedIds.length === 0 ? 'empty' : null)))
    const applyDisabled = applyBlockedReason !== null || applying || Boolean(appliedResult)

    // ---------------------------------------------------------- selection moves
    const toggleChange = (changeId) => {
      if (!isSelectable(changeId)) return
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(changeId)) next.delete(changeId)
        else next.add(changeId)
        return next
      })
    }

    const selectableIdsOf = (target) => (Array.isArray(target.changes) ? target.changes : [])
      .map((change) => change.id)
      .filter((changeId) => isSelectable(changeId))

    const fileFullySelected = (target) => {
      const ids = selectableIdsOf(target)
      return ids.length > 0 && ids.every((changeId) => selected.has(changeId))
    }

    const toggleFile = (target) => {
      const ids = selectableIdsOf(target)
      if (ids.length === 0) return
      setSelected((prev) => {
        const next = new Set(prev)
        const allSelected = ids.every((changeId) => next.has(changeId))
        if (allSelected) {
          for (const changeId of ids) next.delete(changeId)
        } else {
          for (const changeId of ids) next.add(changeId)
        }
        return next
      })
    }

    const selectQualified = () => {
      const qualified = defaultSelection(activePlan, checks)
        .filter((changeId) => !isIgnored(changeId) && !isBlocked(changeId) && !isAlreadyPresent(changeId))
      setSelected(new Set(qualified))
    }

    // ------------------------------------------------------- ignore / adoption
    const persistReview = async (nextIgnored, nextReviewed, rollback) => {
      if (!runId) {
        rollback()
        setReviewError({ code: 'REVIEW_NOT_ALLOWED' })
        return
      }
      try {
        const res = await fetch('api/punch-desk/distill-review', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId,
            ignoredChangeIds: Array.from(nextIgnored).sort(),
            reviewedChangeIds: Array.from(nextReviewed).sort(),
          }),
        })
        const data = await res.json().catch(() => null)
        if (res.ok && data && data.ok === true) return
        rollback()
        setReviewError(errorPayload(data, res.status))
      } catch (err) {
        rollback()
        setReviewError({ code: 'NETWORK', message: err?.message || String(err) })
      }
    }

    /**
     * Flip the light "not adopted" marker. Optimistic, rolls the marker and the
     * touched selection back when the write fails.
     */
    const toggleIgnored = (change) => {
      if (!runReady || !change || reviewBusyId !== null) return
      const changeId = change.id
      const prevIgnored = new Set(ignoredIds)
      const prevReviewed = new Set(reviewedIds)
      const prevSelected = new Set(selected)
      const nextIgnored = new Set(ignoredIds)
      const nextReviewed = new Set(reviewedIds)
      const nextSelected = new Set(selected)

      if (nextIgnored.has(changeId)) {
        nextIgnored.delete(changeId)
        nextReviewed.add(changeId)
        if (ignoreMemory.current.get(changeId) === true) nextSelected.add(changeId)
      } else {
        ignoreMemory.current.set(changeId, nextSelected.has(changeId))
        nextIgnored.add(changeId)
        nextReviewed.add(changeId)
        nextSelected.delete(changeId)
      }

      setIgnoredIds(nextIgnored)
      setReviewedIds(nextReviewed)
      setSelected(nextSelected)
      setReviewError(null)
      setReviewBusyId(changeId)
      persistReview(nextIgnored, nextReviewed, () => {
        setIgnoredIds(prevIgnored)
        setReviewedIds(prevReviewed)
        setSelected(prevSelected)
      }).finally(() => {
        setReviewBusyId((current) => (current === changeId ? null : current))
      })
    }

    // ------------------------------------------------------------- rationale
    const startEditRationale = (change) => {
      setEditingChangeId(change.id)
      setRationaleDraft(
        typeof rationaleEdits[change.id] === 'string'
          ? rationaleEdits[change.id]
          : (change.rationale || ''),
      )
    }

    const saveRationale = () => {
      if (editingChangeId === null) return
      const value = String(rationaleDraft ?? '').trim()
      if (value !== '') {
        setRationaleEdits((prev) => ({ ...prev, [editingChangeId]: value }))
      }
      setEditingChangeId(null)
      setRationaleDraft('')
    }

    const cancelRationaleEdit = () => {
      setEditingChangeId(null)
      setRationaleDraft('')
    }

    // ---------------------------------------------------------- apply / rebase
    const handleApplyFirstStep = () => {
      if (applyDisabled) return
      setConfirming(true)
    }

    const handleApplyConfirm = async () => {
      if (applyDisabled || !runId) return
      const selectedIds = effectiveSelectedIds.slice()
      const ignoredCountAtApply = ignoredCount
      const conflictCountAtApply = conflictCount
      const startedAt = Date.now()
      setApplying(true)
      setApplyError(null)
      try {
        const res = await fetch('api/punch-desk/distill-apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            runId,
            selectedChangeIds: selectedIds,
            baseHashes,
            rationaleEdits,
          }),
        })
        const data = await res.json().catch(() => null)
        if (res.ok && data && data.ok === true) {
          applySnapshot.current = {
            selectedIds,
            ignoredCount: ignoredCountAtApply,
            conflicts: conflictCountAtApply,
            startedAt,
            completedAt: Date.now(),
          }
          setLocalApplied(data)
          if (typeof onApplied === 'function') onApplied(data)
          return
        }
        const payload = errorPayload(data, res.status)
        setApplyError({
          ...payload,
          file: data?.file,
          targets: Array.isArray(data?.targets) ? data.targets : [],
          backupPath: data?.backupPath,
        })
        // Baseline drift detected by the CAS guard becomes a conflict-bucket
        // entry: the user re-anchors that file instead of reading hashes.
        const drifted = []
        if (payload.code === 'CAS_CONFLICT' && typeof data?.file === 'string') drifted.push(data.file)
        if (payload.code === 'RECOVERY_CONFLICT') {
          for (const file of Array.isArray(data?.targets) ? data.targets : []) {
            if (typeof file === 'string') drifted.push(file)
          }
        }
        if (drifted.length > 0) {
          setDriftFiles((prev) => {
            const next = new Set(prev)
            for (const file of drifted) next.add(file)
            return next
          })
        }
      } catch (err) {
        setApplyError({ code: 'NETWORK', message: err?.message || String(err) })
      } finally {
        setApplying(false)
        setConfirming(false)
      }
    }

    const setRebaseEntry = (file, patch) => {
      setRebaseState((prev) => ({ ...prev, [file]: { ...(prev[file] || {}), ...patch } }))
    }

    const clearRebaseEntry = (file) => {
      setRebaseState((prev) => {
        if (!(file in prev)) return prev
        const next = { ...prev }
        delete next[file]
        return next
      })
    }

    /** Step 1: pure preview of "plan content vs current disk content". */
    const previewRebase = async (file) => {
      if (!runId || !runReady) return
      setRebaseEntry(file, { busy: true, error: null, preview: null, confirming: false })
      try {
        const res = await fetch('api/punch-desk/distill-rebase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId, filePath: file, apply: false }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok !== true || !data.rebase) {
          const payload = errorPayload(data, res.status)
          setRebaseEntry(file, { busy: false, preview: null, confirming: false, error: payload.message })
          return
        }
        setRebaseEntry(file, { busy: false, preview: data.rebase, confirming: true, error: null })
      } catch (err) {
        setRebaseEntry(file, { busy: false, preview: null, confirming: false, error: err?.message || String(err) })
      }
    }

    /** Step 2: re-anchor the file baseline, swap in the refreshed plan. */
    const applyRebase = async (file) => {
      if (!runId || !runReady) return
      setRebaseEntry(file, { busy: true, error: null })
      setRebaseNotice(null)
      try {
        const res = await fetch('api/punch-desk/distill-rebase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ runId, filePath: file, apply: true }),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok || !data || data.ok !== true || !data.plan || typeof data.plan !== 'object') {
          const payload = errorPayload(data, res.status)
          setRebaseEntry(file, { busy: false, error: payload.message })
          return
        }
        const nextPlan = data.plan
        const nextIds = new Set()
        for (const target of Array.isArray(nextPlan.targets) ? nextPlan.targets : []) {
          for (const change of Array.isArray(target.changes) ? target.changes : []) nextIds.add(change.id)
        }
        setRebaseOverride({ runKey, plan: nextPlan })
        setDriftFiles((prev) => {
          const next = new Set(prev)
          next.delete(file)
          return next
        })
        clearRebaseEntry(file)
        setRebaseNotice(file)
        setSelected((prev) => {
          const next = new Set(Array.from(prev).filter((changeId) => nextIds.has(changeId)))
          for (const changeId of defaultSelection(
            nextPlan,
            Array.isArray(nextPlan.checks) ? nextPlan.checks : [],
          )) {
            next.add(changeId)
          }
          for (const changeId of next) {
            if (!nextIds.has(changeId)) next.delete(changeId)
          }
          return next
        })
        setIgnoredIds((prev) => new Set(Array.from(prev).filter((changeId) => nextIds.has(changeId))))
        setReviewedIds((prev) => new Set(Array.from(prev).filter((changeId) => nextIds.has(changeId))))
        setApplyError(null)
      } catch (err) {
        setRebaseEntry(file, { busy: false, error: err?.message || String(err) })
      }
    }

    // --------------------------------------------------------------- applied page
    if (appliedResult) {
      const applied = Array.isArray(appliedResult.applied) ? appliedResult.applied : []
      const skipped = Array.isArray(appliedResult.skipped) ? appliedResult.skipped : []
      const fingerprints = Array.isArray(appliedResult.fingerprints) ? appliedResult.fingerprints : []
      // A persisted failure (`run.applyResult = { ok:false, code, ... }`) also
      // lands here: the conclusion badge must say the apply failed instead of
      // showing a green read-back badge over an empty ledger.
      const applyFailed = appliedResult.ok === false
      const failureCode = applyFailed && typeof appliedResult.code === 'string' ? appliedResult.code : ''
      const failureMessage = applyFailed
        ? (typeof appliedResult.message === 'string' && appliedResult.message !== ''
          ? appliedResult.message
          : (typeof appliedResult.error === 'string' ? appliedResult.error : ''))
        : ''
      // Stats need at least one of the two write-back lists; a minimal persisted
      // record (only `ok` + `appliedAt`) shows the honest "no stats" copy instead
      // of fabricated zeroes.
      const hasStats = !applyFailed
        && (Array.isArray(appliedResult.applied) || Array.isArray(appliedResult.skipped))
      // The apply response reports which selected ids were left out and why, so
      // the count on screen matches the plan the user reviewed (no silent gaps).
      const ignoredSkipped = Array.isArray(appliedResult.ignoredSkipped) ? appliedResult.ignoredSkipped : []
      const alreadyPresentSkipped = Array.isArray(appliedResult.alreadyPresentSkipped)
        ? appliedResult.alreadyPresentSkipped
        : []
      const appliedFileSet = new Set(applied.map((item) => item?.file).filter(Boolean))
      const writtenFileSet = new Set([
        ...applied.map((item) => item?.file),
        ...skipped.map((item) => item?.file),
      ].filter(Boolean))
      // Reloaded/replayed applied runs do not carry the original selection;
      // rebuild it from the written files so the stats stay honest.
      const derivedSelectedIds = []
      for (const target of targets) {
        if (!writtenFileSet.has(target.file)) continue
        for (const change of Array.isArray(target.changes) ? target.changes : []) {
          if (!ignoredIds.has(change.id)) derivedSelectedIds.push(change.id)
        }
      }
      const snapshot = applySnapshot.current || {
        selectedIds: Array.isArray(appliedResult.selectedChangeIds)
          ? appliedResult.selectedChangeIds
          : derivedSelectedIds,
        ignoredCount,
        conflicts: conflictCount,
        startedAt: Number.isFinite(run?.createdAt) ? run.createdAt : null,
        completedAt: Number.isFinite(run?.appliedAt) ? run.appliedAt : null,
      }
      const writtenChangeIds = snapshot.selectedIds
        .filter((changeId) => changeById.has(changeId) && writtenFileSet.has(changeById.get(changeId).target.file))
      const appliedChangeIds = new Set(snapshot.selectedIds
        .filter((changeId) => changeById.has(changeId) && appliedFileSet.has(changeById.get(changeId).target.file)))
      const rows = [...applied, ...skipped.map((item) => ({ ...item, skipped: true }))]
      const duration = snapshot.startedAt && snapshot.completedAt
        ? formatDurationMs(snapshot.completedAt - snapshot.startedAt)
        : formatDurationMs(0)

      /** Read-only entries of one written file: original text + rationale. */
      const renderWrittenChanges = (file, lastRow) => {
        const target = targets.find((item) => item.file === file)
        if (!target) return null
        const changes = (Array.isArray(target.changes) ? target.changes : [])
          .filter((change) => writtenChangeIds.includes(change.id))
        if (changes.length === 0) return null
        return h('div', { key: `written-${file}`, style: SECTION_STYLE },
          changes.map((change, index) => {
            const isLast = index === changes.length - 1
            // The audit copy of the written body uses the same shape as the
            // review card: shown in full, scrolling inside the capped window.
            const panelId = `applied:${runId}:${file}:${change.id}`
            return h('div', {
              key: `written-${change.id}`,
              style: isLast
                ? { ...CHANGE_ROW_STYLE, borderBottom: lastRow ? 'none' : CHANGE_ROW_STYLE.borderBottom }
                : CHANGE_ROW_STYLE,
            },
            h('div', { style: META_STYLE },
              h(Badge, {
                tone: 'neutral',
                icon: icons.GitDiff,
              }, translate(KIND_KEYS[change.kind] || 'distill.confirm.kind.append-section')),
              h('span', { style: BODY_TEXT_STYLE },
                `${translate('distill.confirm.rationaleLabel')}: ${change.rationale || ''}`)),
            renderCodeBlock({
              text: change.proposedText || '',
              blockId: panelId,
              label: translate('distill.confirm.diff.after'),
            }))
          }))
      }

      const renderAppliedFile = (item, index) => h('div', {
        key: item.file || `applied-${index}`,
        style: index === rows.length - 1
          ? { ...APPLIED_ROW_STYLE, borderBottom: 'none' }
          : APPLIED_ROW_STYLE,
      },
      h('div', { style: CHANGE_HEAD_STYLE },
        h('span', { style: FILE_PATH_STYLE }, item.file || ''),
        item.skipped
          ? h(Badge, { tone: 'neutral', icon: icons.ArrowCounterClockwise },
            translate('distill.confirm.applied.skipped'))
          : h(Badge, {
            tone: 'info',
            icon: item.action === 'create' ? icons.FolderPlus : icons.PencilSimple,
          }, translate(item.action === 'create'
            ? 'distill.confirm.action.create'
            : 'distill.confirm.action.update'))),
      item.skipped
        ? null
        : h('div', { style: BODY_TEXT_STYLE },
          `${translate('distill.confirm.applied.newHash')}: `,
          h('span', {
            title: typeof item.newHash === 'string' ? item.newHash : undefined,
            style: { fontFamily: 'ui-monospace, monospace' },
          }, shortHash(item.newHash))),
      item.skipped || typeof item.backupPath !== 'string'
        ? null
        : h('div', { style: BODY_TEXT_STYLE },
          `${translate('distill.confirm.applied.backupPath')}: `,
          h('span', {
            title: item.backupPath,
            style: { fontFamily: 'ui-monospace, monospace' },
          }, item.backupPath)),
      renderWrittenChanges(item.file, index === rows.length - 1))

      // Write-back stats: files/changes/duration + what was left out (spec §10.4).
      const statsBlock = h('div', { style: SECTION_STYLE, 'data-stats': 'applied' },
        h('div', { style: SECTION_HEADING_STYLE },
          h(icons.ChartBar, { size: 14 }),
          h('span', {}, translate('distill.confirm.stats.heading'))),
        h('div', { style: STATS_ROW_STYLE },
          h('span', { style: STAT_STYLE }, fill(
            translate('distill.confirm.stats.files'), { count: applied.length })),
          h('span', { style: STAT_STYLE }, fill(
            translate('distill.confirm.stats.changes'), { count: appliedChangeIds.size })),
          h('span', { style: STAT_STYLE }, fill(
            translate('distill.confirm.stats.duration'), { duration })),
          h('span', { style: STAT_STYLE }, fill(
            translate('distill.confirm.stats.buckets'), {
              ignored: snapshot.ignoredCount,
              conflicts: snapshot.conflicts,
            })),
          ignoredSkipped.length === 0
            ? null
            : h('span', { style: STAT_STYLE },
              `${translate('distill.confirm.marker.ignored')}: ${ignoredSkipped.length}`),
          alreadyPresentSkipped.length === 0
            ? null
            : h('span', { style: STAT_STYLE },
              `${translate('distill.confirm.applied.skipped')}: ${alreadyPresentSkipped.length}`)))

      // ---------------------------------------------------- conclusion + summary
      const conclusionBadges = h('div', {
        style: META_STYLE,
        'data-applied-conclusion': applyFailed ? 'failed' : 'ok',
      },
      applyFailed
        ? h(Badge, { tone: 'warn', icon: icons.Prohibit },
          translate(ERROR_CODE_KEYS[failureCode] || 'distill.confirm.error.code.default'))
        : h(Badge, {
          tone: appliedResult.readBackOk === false ? 'warn' : 'success',
          icon: appliedResult.readBackOk === false ? icons.Prohibit : icons.CheckCircle,
        }, translate(appliedResult.readBackOk === false
          ? 'distill.confirm.applied.readBackFailed'
          : 'distill.confirm.applied.readBackOk')),
      h(Badge, { tone: 'neutral', icon: icons.GitDiff }, fill(
        translate('distill.confirm.applied.fingerprints'), { count: fingerprints.length })),
      failureMessage === ''
        ? null
        : h('span', { style: WARN_TEXT_STYLE }, failureMessage),
      applyFailed && appliedResult.rolledBack === false
        ? h('span', { style: WARN_TEXT_STYLE }, translate('distill.confirm.error.manualHint'))
        : null)

      // Why these changes were made, before the file-by-file audit detail.
      const planSummary = typeof activePlan?.summary === 'string' ? activePlan.summary.trim() : ''
      const summarySection = planSummary === ''
        ? null
        : h('div', { style: SECTION_STYLE, 'data-applied-summary': 'plan' },
          h('div', { style: SECTION_HEADING_STYLE },
            h(icons.Brain, { size: 14 }),
            h('span', {}, translate('distill.confirm.applied.summaryHeading'))),
          h('div', { style: SUMMARY_TEXT_STYLE }, activePlan.summary))

      // A failed apply wrote nothing, so there is no written-back detail to show
      // (and the empty-state copy would read as "skipped equivalence", which is
      // wrong). Failures keep conclusion + summary + stats-missing + hint.
      const showAppliedBucket = !applyFailed || rows.length > 0
      const appliedBucket = h('div', { style: BUCKET_STYLE, 'data-bucket': 'applied' },
        h('div', { style: BUCKET_HEAD_STYLE },
          h(icons.CheckCircle, { size: 14 }),
          h('span', { style: BUCKET_TITLE_STYLE }, translate('distill.confirm.bucket.applied'))),
        h('div', { style: BUCKET_HINT_STYLE }, translate('distill.confirm.bucket.appliedHint')),
        rows.length === 0
          ? h('div', { style: EMPTY_HINT_STYLE }, translate('distill.confirm.applied.skipped'))
          : h('div', { style: SECTION_STYLE }, rows.map(renderAppliedFile)))

      // Where the result lives so a refresh does not lose the audit trail.
      const persistedHint = h('div', {
        style: ACTION_BAR_REASON_STYLE,
        'data-applied-hint': 'persisted',
      },
      h(icons.Folder, { size: 12 }),
      h('span', {}, translate('distill.confirm.applied.persistedHint')))

      // Top bar of the applied page: the way out is always one click away, and
      // it stays visible while the ledger scrolls.
      const appliedSticky = h('div', { style: STICKY_BAR_STYLE, 'data-sticky-bar': 'applied' },
        h('div', { style: ACTION_BAR_ROW_STYLE },
          h('div', { style: ACTION_BAR_LEFT_STYLE },
            h('div', { style: META_STYLE },
              h(icons.CheckCircle, { size: 14 }),
              h('span', { style: ACTION_BAR_LABEL_STYLE }, translate('distill.confirm.applied.heading'))),
            h('span', { style: ACTION_BAR_CAPTION_STYLE }, translate('distill.confirm.actionBarHint'))),
          h('div', { style: ACTION_BAR_RIGHT_STYLE },
            typeof props.onViewResult === 'function'
              ? h(Button, {
                icon: icons.ArrowRight,
                variant: 'ghost',
                title: translate('distill.confirm.gotoResult'),
                onClick: () => props.onViewResult(appliedResult),
              }, translate('distill.confirm.gotoResult'))
              : null,
            h(Button, {
              icon: icons.Kanban,
              variant: 'ghost',
              disabled: typeof props.onBack !== 'function',
              title: translate('distill.confirm.applied.backToIndex'),
              onClick: () => {
                if (typeof props.onBack === 'function') props.onBack()
              },
            }, translate('distill.confirm.applied.backToIndex')))))

      return h('div', { style: CONTAINER_STYLE },
        appliedSticky,
        conclusionBadges,
        summarySection,
        showAppliedBucket ? appliedBucket : null,
        hasStats ? statsBlock : h('div', {
          style: EMPTY_HINT_STYLE,
          role: 'status',
          'data-stats': 'missing',
        }, translate('distill.confirm.applied.statsMissing')),
        persistedHint)
    }

    // -------------------------------------------------------- confirmation page
    if (!activePlan || typeof activePlan !== 'object') {
      return h('div', { style: CONTAINER_STYLE },
        h('div', { style: SECTION_HEADING_STYLE },
          h(icons.Brain, { size: 14 }),
          h('span', {}, translate('distill.confirm.heading'))),
        h('div', { style: EMPTY_HINT_STYLE }, translate('distill.confirm.planMissing')))
    }

    // ------------------------------------------------------------- bucket parts
    const bucketHeader = (icon, titleKey, hintKey) => h('div', { style: SECTION_STYLE },
      h('div', { style: BUCKET_HEAD_STYLE },
        h(icon, { size: 14 }),
        h('span', { style: BUCKET_TITLE_STYLE }, translate(titleKey))),
      h('div', { style: BUCKET_HINT_STYLE }, translate(hintKey)))

    const renderConflictBadge = (resolvedBy) => h(Badge, {
      tone: resolvedBy === 'unresolved' ? 'warn' : 'neutral',
      icon: resolvedBy === 'code' ? icons.GitBranch : icons.Prohibit,
    }, translate(RESOLVED_BY_KEYS[resolvedBy] || RESOLVED_BY_KEYS.unresolved))

    const renderConflictItem = (conflict, index, list) => {
      const claims = Array.isArray(conflict?.claims) ? conflict.claims : []
      return h('div', {
        key: `conflict-${index}`,
        style: index === list.length - 1
          ? { ...APPLIED_ROW_STYLE, borderBottom: 'none' }
          : APPLIED_ROW_STYLE,
      },
      h('div', { style: CHANGE_HEAD_STYLE },
        h('span', { style: SUMMARY_TEXT_STYLE }, conflict?.topic || ''),
        renderConflictBadge(conflict?.resolvedBy)),
      claims.length === 0
        ? null
        : h('div', { style: SECTION_STYLE },
          claims.map((claim, claimIndex) => h('div', {
            key: `claim-${index}-${claimIndex}`,
            style: EVIDENCE_TEXT_STYLE,
          }, `${evidenceLabel(claim, titles, translate)} · ${claim?.claim || ''}`))),
      typeof conflict?.note === 'string' && conflict.note !== ''
        ? h('div', { style: BODY_TEXT_STYLE }, conflict.note)
        : null)
    }

    /** Read-only comparison block of one re-anchor preview (no diff library). */
    const renderRebasePreview = (file, preview, state) => {
      const previews = Array.isArray(preview?.previews) ? preview.previews : []
      const alreadyApplied = Array.isArray(preview?.alreadyApplied) ? preview.alreadyApplied : []
      return h('div', { style: SECTION_STYLE, 'data-rebase-preview': file },
        previews.length === 0
          ? null
          : h('div', { style: SECTION_STYLE },
            previews.map((item, index) => {
              const anchor = typeof item?.anchor === 'string' && item.anchor !== ''
                ? item.anchor
                : (typeof item?.changeId === 'string' ? item.changeId : '')
              return h('div', {
                key: `rebase-${file}-${index}`,
                style: index === previews.length - 1
                  ? { ...PREVIEW_ROW_STYLE, borderBottom: 'none' }
                  : PREVIEW_ROW_STYLE,
              },
              h('div', { style: META_STYLE },
                h(Badge, { tone: 'neutral', icon: icons.GitDiff }, anchor)),
              h('div', { style: STAT_STYLE }, translate('distill.confirm.error.expected')),
              h('pre', { style: CODE_BLOCK_STYLE }, item?.proposedText || ''),
              h('div', { style: STAT_STYLE }, translate('distill.confirm.error.actual')),
              h('pre', { style: CODE_BLOCK_STYLE }, item?.currentText || ''))
            })),
        alreadyApplied.length === 0
          ? null
          : h('div', { style: META_STYLE },
            h(Badge, { tone: 'neutral', icon: icons.ArrowCounterClockwise },
              translate('distill.confirm.applied.skipped'))),
        h('div', { style: META_STYLE },
          h(Button, {
            icon: icons.ArrowCounterClockwise,
            variant: 'primary',
            disabled: Boolean(state?.busy) || !runReady,
            title: translate('distill.confirm.drift.rebaseHint'),
            onClick: () => applyRebase(file),
          }, translate('distill.confirm.drift.rebaseAction')),
          h(Button, {
            icon: icons.X,
            disabled: Boolean(state?.busy) || !runReady,
            onClick: () => clearRebaseEntry(file),
          }, translate('distill.confirm.confirmNo'))),
        h('div', { style: STAT_STYLE }, translate('distill.confirm.drift.rebaseHint')))
    }

    const renderDriftCard = (file) => {
      const state = rebaseState[file] || {}
      const hasPreview = Boolean(state.preview)
      return h('div', {
        key: `drift-${file}`,
        'data-drift-file': file,
        style: DRIFT_CARD_STYLE,
      },
      h('div', { style: CHANGE_HEAD_STYLE },
        h(icons.GitBranch, { size: 14 }),
        h('span', { style: BUCKET_TITLE_STYLE }, translate('distill.confirm.drift.heading')),
        h(Badge, { tone: 'warn', icon: icons.PencilSimple }, file)),
      h('div', { style: WARN_TEXT_STYLE }, fill(translate('distill.confirm.drift.body'), { file })),
      state.busy
        ? h('div', { style: BODY_TEXT_STYLE }, translate('distill.confirm.drift.rebaseBusy'))
        : null,
      typeof state.error === 'string' && state.error !== ''
        ? h('div', { style: WARN_TEXT_STYLE },
          fill(translate('distill.confirm.drift.rebaseFailed'), { message: state.error }))
        : null,
      hasPreview
        ? renderRebasePreview(file, state.preview, state)
        : (state.busy
          ? null
          : h('div', { style: SECTION_STYLE },
            h('div', { style: META_STYLE },
              h(Button, {
                icon: icons.ArrowCounterClockwise,
                disabled: !runReady,
                title: translate('distill.confirm.drift.rebaseHint'),
                onClick: () => previewRebase(file),
              }, translate('distill.confirm.drift.rebaseAction'))),
            h('div', { style: STAT_STYLE }, translate('distill.confirm.drift.rebaseHint')))))
    }

    // ----------------------------------------------------- static validation copy
    const checksSection = checks.length === 0
      ? h('div', { style: EMPTY_HINT_STYLE }, translate('distill.confirm.checks.empty'))
      : h('div', { style: SECTION_STYLE },
        errorChecks.length === 0 ? null : h('div', { style: SECTION_STYLE },
          h('div', { style: ERROR_BANNER_STYLE },
            h('span', {},
              `${translate('distill.confirm.checks.errorLabel')}: ${errorChecks.length}`)),
          errorChecks.map((item, index) => h('div', {
            key: `check-err-${index}`,
            style: { ...BODY_TEXT_STYLE, fontWeight: 600, color: `var(--dsw-alias-state-error-primary, ${NORD.nord11})` },
          }, item.message || String(item.code || '')))),
        warnChecks.length === 0 ? null : h('div', { style: SECTION_STYLE },
          h('div', { style: WARN_TEXT_STYLE },
            `${translate('distill.confirm.checks.warnLabel')}: ${warnChecks.length}`),
          warnChecks.map((item, index) => h('div', {
            key: `check-warn-${index}`,
            style: WARN_TEXT_STYLE,
          }, item.message || String(item.code || '')))))

    // --------------------------------------------------------- review change card
    const renderChangeCard = (change, target) => {
      const grade = changeGrade(change)
      const changeId = change.id
      const blockedReason = blockedReasonOf(changeId)
      const ignored = isIgnored(changeId)
      const isSelected = selected.has(changeId)
      const missingDeps = depMissingByChangeId.get(changeId)
      const isEditing = editingChangeId === changeId
      const editedRationale = typeof rationaleEdits[changeId] === 'string'
        ? rationaleEdits[changeId]
        : null
      const labels = changeEvidenceLabels(change, titles, translate)
      const rationaleEditingBlock = isEditing
        ? h('div', { style: SECTION_STYLE },
          h('textarea', {
            value: rationaleDraft,
            style: TEXTAREA_STYLE,
            rows: 2,
            onChange: (event) => setRationaleDraft(event?.target?.value ?? ''),
          }),
          h('div', { style: META_STYLE },
            h(Button, {
              icon: icons.CheckCircle,
              onClick: saveRationale,
            }, translate('distill.confirm.rationaleSave')),
            h(Button, {
              icon: icons.X,
              onClick: cancelRationaleEdit,
            }, translate('distill.confirm.rationaleCancel'))))
        : h('div', { style: META_STYLE },
          h(Button, {
            icon: icons.PencilSimple,
            onClick: () => startEditRationale(change),
            title: translate('distill.confirm.rationaleEdit'),
          }, translate('distill.confirm.rationaleEdit')))

      const alreadyPresent = isAlreadyPresent(changeId)
      const markerGroup = h('div', { style: MARKER_GROUP_STYLE },        alreadyPresent
          ? h('span', { 'data-marker': 'written', style: { display: 'inline-flex' } },
            h(Badge, { tone: 'neutral', icon: icons.ArrowCounterClockwise },
              translate('distill.confirm.applied.skipped')))
          : null,
        blockedReason !== null
          ? h('span', { 'data-marker': 'blocked', style: { display: 'inline-flex' } },
            h(Badge, {
              tone: 'warn',
              icon: icons.Prohibit,
              tip: fill(translate('distill.confirm.marker.blockedTip'), { reason: blockedReason }),
            }, translate('distill.confirm.marker.blocked')))
          : null,
        ignored
          ? h('span', { 'data-marker': 'ignored', style: { display: 'inline-flex' } },
            h(Badge, {
              tone: 'neutral',
              icon: icons.Circle,
              tip: translate('distill.confirm.marker.ignoredTip'),
            }, translate('distill.confirm.marker.ignored')))
          : null,
        ignored
          ? h(Button, {
            icon: icons.ArrowCounterClockwise,
            disabled: !runReady || reviewBusyId !== null,
            title: translate('distill.confirm.undoIgnore'),
            onClick: () => toggleIgnored(change),
          }, translate('distill.confirm.undoIgnore'))
          : ((blockedReason === null && !alreadyPresent)
            ? h(Button, {
              icon: icons.Prohibit,
              disabled: !runReady || reviewBusyId !== null,
              title: translate('distill.confirm.ignoreAction'),
              onClick: () => toggleIgnored(change),
            }, translate('distill.confirm.ignoreAction'))
            : null))

      // ------------------------------------------------ before/after comparison
      // Users could not tell what a structural change actually does, so every
      // review card carries a read-only "before / after" pair. `beforeText` is
      // the original snapshot captured at plan time (Host ≥ this round); older
      // batches and brand-new files degrade to an explicit note instead of
      // pretending the plan body is the disk state.
      //
      // Both sides are rendered in full with no expand/collapse affordance: a
      // long body simply scrolls inside the capped window, so the comparison is
      // readable without any interaction and still shows every line.
      const isCreateChange = target?.action === 'create' || change.kind === 'create-file'
      const diffAnchor = typeof change.sectionAnchor === 'string' ? change.sectionAnchor.trim() : ''
      const beforeText = typeof change.beforeText === 'string' ? change.beforeText : ''
      const afterText = typeof change.proposedText === 'string' ? change.proposedText : ''
      const beforePanelId = `${runId}:${changeId}:before`
      const afterPanelId = `${runId}:${changeId}:after`
      const diffSection = h('div', { style: DIFF_GROUP_STYLE, 'data-diff': changeId },
        h('div', { style: META_STYLE },
          isCreateChange
            ? h(Badge, { tone: 'info', icon: icons.FolderPlus },
              translate('distill.confirm.diff.newFile'))
            : (diffAnchor === ''
              ? null
              : h(Badge, { tone: 'neutral', icon: icons.GitDiff },
                fill(translate('distill.confirm.diff.anchor'), { anchor: diffAnchor }))),
          h('span', { style: BUCKET_HINT_STYLE }, translate('distill.confirm.diff.unchangedHint'))),
        h('div', { style: DIFF_GRID_STYLE },
          h('div', { style: DIFF_COL_STYLE, 'data-diff-side': 'before' },
            isCreateChange
              ? h('div', { style: EVIDENCE_TEXT_STYLE, 'data-diff-empty': 'new-file' },
                translate('distill.confirm.diff.newFile'))
              : (beforeText === ''
                ? h('div', { style: EVIDENCE_TEXT_STYLE, 'data-diff-empty': 'no-before' },
                  translate('distill.confirm.diff.noBefore'))
                : renderCodeBlock({
                  text: beforeText,
                  blockId: beforePanelId,
                  side: 'before',
                  label: translate('distill.confirm.diff.before'),
                }))),
          h('div', { style: DIFF_COL_STYLE, 'data-diff-side': 'after' },
            renderCodeBlock({
              text: afterText,
              blockId: afterPanelId,
              side: 'after',
              label: translate('distill.confirm.diff.after'),
            }))))

      const rationaleText = editedRationale ?? (change.rationale || '')

      return h('div', {
        key: `change-${changeId}`,
        'data-change-id': changeId,
        style: CHANGE_ROW_STYLE,
      },
      h('div', { style: CHANGE_HEAD_STYLE },
        h('input', {
          type: 'checkbox',
          checked: isSelected && !ignored && !alreadyPresent && blockedReason === null,
          disabled: ignored || alreadyPresent || blockedReason !== null,
          style: CHECKBOX_STYLE,
          onChange: () => toggleChange(changeId),
        }),
        h('span', { style: CHANGE_ID_STYLE }, changeId),
        h(Badge, {
          tone: 'info',
          icon: icons.GitDiff,
        }, translate(KIND_KEYS[change.kind] || 'distill.confirm.kind.append-section')),
        grade
          ? h(Badge, {
            tone: GRADE_TONES[grade] || 'neutral',
            icon: grade === 'resolved' ? icons.CheckCircle : (grade === 'commit' ? icons.GitBranch : icons.Clock),
          }, translate(GRADE_KEYS[grade] || 'distill.confirm.grade.submitted'))
          : null,
        h('span', { style: STAT_STYLE }, translate('distill.confirm.structuredNote')),
        missingDeps
          ? h(Badge, {
            tone: 'warn',
            icon: icons.Prohibit,
          }, fill(translate('distill.confirm.dependencyMissing'), { ids: missingDeps.join(', ') }))
          : null,
        markerGroup),

      diffSection,

      labels.length > 0
        ? h('div', { style: SECTION_STYLE },
          h('span', { style: STAT_STYLE }, translate('distill.confirm.evidenceLabel')),
          labels.map((label, index) => h('div', {
            key: `ev-${index}`,
            style: EVIDENCE_TEXT_STYLE,
          }, label)))
        : null,

      typeof change.evidenceSnippet === 'string' && change.evidenceSnippet !== ''
        ? h('div', { style: EVIDENCE_TEXT_STYLE }, change.evidenceSnippet)
        : null,

      // Rationale: label + the one-line hint that explains what the text is for
      // (a write-back record, never re-submitted to the model) + the editor.
      h('div', { style: SECTION_STYLE, 'data-rationale': changeId },
        h('div', { style: META_STYLE },
          h('span', { style: STAT_STYLE }, translate('distill.confirm.rationaleLabel')),
          editedRationale !== null
            ? h(Badge, { tone: 'info', icon: icons.PencilSimple },
              translate('distill.confirm.rationaleEdited'))
            : null,
          Array.isArray(change.dependsOn) && change.dependsOn.length > 0
            ? h('span', { style: STAT_STYLE },
              ` · ${translate('distill.confirm.dependencyLabel')}: ${change.dependsOn.join(', ')}`)
            : null),
        h('div', { style: BODY_TEXT_STYLE }, rationaleText),
        h('div', { style: BUCKET_HINT_STYLE, 'data-rationale-hint': 'true' },
          translate('distill.confirm.rationaleHint')),
        rationaleEditingBlock))
    }

    // --------------------------------------------------------------- review bucket
    const reviewTargets = targets.filter((target) => !driftFiles.has(target.file))
    const visibleChangesOf = (target) => (Array.isArray(target.changes) ? target.changes : [])
      .filter((change) => !onlyPending || (!selected.has(change.id) && !isAlreadyPresent(change.id)))
    const visibleReviewTargets = reviewTargets
      .map((target) => ({ target, changes: visibleChangesOf(target) }))
      .filter((entry) => entry.changes.length > 0)

    const reviewErrorText = reviewError
      ? (reviewError.code === 'REVIEW_NOT_ALLOWED'
        ? translate('distill.view.error.code.REVIEW_NOT_ALLOWED')
        : (reviewError.message || translate('distill.view.error.code.REVIEW_NOT_ALLOWED')))
      : ''

    // Proposals the deterministic shaping dropped before they reached the plan.
    // They are not a bucket (nothing will be written); they stay visible so the
    // user knows why the plan is smaller than the model draft.
    const droppedItems = (Array.isArray(activePlan.dropped) ? activePlan.dropped : [])
      .filter((item) => item && typeof item === 'object')
    const droppedSection = droppedItems.length === 0
      ? null
      : h('div', { style: SECTION_STYLE, 'data-dropped': 'plan' },
        h('div', { style: SECTION_HEADING_STYLE },
          h(icons.Prohibit, { size: 14 }),
          h('span', {}, translate('distill.confirm.dropped.heading'))),
        h('div', { style: BUCKET_HINT_STYLE }, translate('distill.confirm.dropped.hint')),
        droppedItems.map((item, index) => h('div', {
          key: `dropped-${index}`,
          style: META_STYLE,
        },
        h('span', { style: BODY_TEXT_STYLE }, typeof item.file === 'string' ? item.file : ''),
        Number.isFinite(item.count)
          ? h(Badge, { tone: 'neutral', icon: icons.GitDiff }, String(item.count))
          : null,
        h(Badge, { tone: 'neutral', icon: icons.Prohibit },
          translate(droppedReasonKey(item.reason))))))

    const reviewBucket = h('div', { style: BUCKET_STYLE, 'data-bucket': 'review' },
      bucketHeader(icons.PencilSimple, 'distill.confirm.bucket.review', 'distill.confirm.bucket.reviewHint'),
      h('div', { style: SECTION_STYLE },
        h('div', { style: SECTION_HEADING_STYLE },
          h(icons.Gauge, { size: 14 }),
          h('span', {}, translate('distill.confirm.checks.heading'))),
        checksSection),
      reviewError
        ? h('div', { role: 'alert', style: ERROR_BANNER_STYLE },
          h('div', { style: META_STYLE },
            h(icons.Prohibit, { size: 14 }),
            h('span', {}, reviewErrorText)))
        : null,
      visibleReviewTargets.length === 0
        ? null
        : h('div', { style: SECTION_STYLE },
          visibleReviewTargets.map(({ target, changes }) => h('div', {
            key: `file-${target.file}`,
            'data-target-file': target.file,
            style: SECTION_STYLE,
          },
          h('div', { style: FILE_ROW_STYLE },
            h('input', {
              type: 'checkbox',
              checked: fileFullySelected(target),
              disabled: selectableIdsOf(target).length === 0,
              style: CHECKBOX_STYLE,
              title: translate('distill.confirm.selectFileAll'),
              onChange: () => toggleFile(target),
            }),
            h('span', { style: FILE_PATH_STYLE, title: target.file }, target.file),
            h(Badge, {
              tone: 'neutral',
              icon: target.action === 'create' ? icons.FolderPlus : icons.PencilSimple,
            }, translate(target.action === 'create'
              ? 'distill.confirm.action.create'
              : 'distill.confirm.action.update')),
            h('span', { style: STAT_STYLE }, `${(target.changes || []).length}`)),
          changes.map((change) => renderChangeCard(change, target))))),
      droppedSection)

    // ------------------------------------------------------------- conflict bucket
    const driftEntries = Array.from(driftFiles).sort()
    const hasConflictBucket = driftEntries.length > 0 || unresolvedConflicts.length > 0
    const conflictBucket = hasConflictBucket
      ? h('div', { style: BUCKET_STYLE, 'data-bucket': 'conflict' },
        bucketHeader(icons.GitBranch, 'distill.confirm.bucket.conflict', 'distill.confirm.bucket.conflictHint'),
        driftEntries.length === 0
          ? null
          : h('div', { style: SECTION_STYLE }, driftEntries.map(renderDriftCard)),
        unresolvedConflicts.length === 0
          ? null
          : h('div', { style: SECTION_STYLE },
            h('div', { style: SECTION_HEADING_STYLE },
              h(icons.GitBranch, { size: 14 }),
              h('span', {}, translate('distill.confirm.conflicts.heading'))),
            unresolvedConflicts.map((conflict, index) => renderConflictItem(conflict, index, unresolvedConflicts))))
      : null

    // Conflicts already settled by code/session adjudication are context, not
    // pending work: they stay visible (audit) but never look like a to-do.
    const adjudicatedSection = adjudicatedConflicts.length === 0
      ? null
      : h('div', { style: SECTION_STYLE, 'data-conflicts': 'adjudicated' },
        h('div', { style: SECTION_HEADING_STYLE },
          h(icons.GitBranch, { size: 14 }),
          h('span', {}, translate('distill.confirm.conflicts.heading'))),
        adjudicatedConflicts.map((conflict, index) => renderConflictItem(
          conflict, index, adjudicatedConflicts)))

    const stats = activePlan.stats && typeof activePlan.stats === 'object' ? activePlan.stats : {}

    // ------------------------------------------------------ apply bar / two steps
    const confirmPanel = h('div', {
      style: CONFIRM_PANEL_STYLE,
      'data-confirm-panel': 'apply',
    },
    h('div', { style: SECTION_HEADING_STYLE },
      h(icons.Prohibit, { size: 14 }),
      h('span', {}, translate('distill.confirm.confirmTitle'))),
    h('div', { style: BODY_TEXT_STYLE }, fill(
      translate('distill.confirm.confirmFiles'), { count: selectedTargets.length })),
    h('div', { style: BODY_TEXT_STYLE }, fill(
      translate('distill.confirm.confirmConflicts'), { count: conflictCount })),
    h('div', { style: BODY_TEXT_STYLE },
      `${translate('distill.confirm.confirmBackup')}: ${BACKUP_DIR_DISPLAY}`),
    applying
      ? h('div', { style: ACTION_BAR_REASON_STYLE, role: 'status', 'data-confirm-busy': 'applying' },
        h(icons.CircleNotch, { size: 12 }),
        h('span', {}, translate('distill.confirm.applying')))
      : null,
    h('div', { style: META_STYLE },
      h(Button, {
        icon: icons.CheckCircle,
        variant: 'primary',
        disabled: applying,
        onClick: handleApplyConfirm,
      }, translate(applying ? 'distill.confirm.applying' : 'distill.confirm.confirmYes')),
      h(Button, {
        icon: icons.X,
        disabled: applying,
        onClick: () => setConfirming(false),
      }, translate('distill.confirm.confirmNo'))))

    // ------------------------------------------------------- sticky action bar
    // Everything the user needs while reviewing sits in one pinned bar: the way
    // back, the pending filter, "select qualified", the selection count and the
    // primary apply action. The disabled reason is printed right here instead of
    // living at the end of the page (user: "buttons/hints all over the page").
    const backToIndex = h(Button, {
      icon: icons.Kanban,
      variant: 'ghost',
      disabled: typeof props.onBack !== 'function' || applying,
      title: translate('distill.confirm.backToIndex'),
      onClick: () => {
        if (typeof props.onBack === 'function') props.onBack()
      },
    }, translate('distill.confirm.backToIndex'))

    const onlyPendingButton = h(Button, {
      icon: icons.Faders,
      variant: onlyPending ? 'primary' : 'ghost',
      'aria-pressed': onlyPending,
      disabled: applying,
      onClick: () => setOnlyPending((prev) => !prev),
      title: translate('distill.confirm.filter.onlyPending'),
    }, translate('distill.confirm.filter.onlyPending'))

    const selectQualifiedButton = h(Button, {
      icon: icons.CheckCircle,
      variant: 'ghost',
      disabled: applying,
      onClick: selectQualified,
      title: translate('distill.confirm.selectQualifiedHint'),
    }, translate('distill.confirm.selectQualified'))

    const applyButton = h(Button, {
      icon: icons.Play,
      variant: 'primary',
      disabled: applyDisabled,
      title: translate('distill.confirm.applyHint'),
      onClick: handleApplyFirstStep,
    }, translate('distill.confirm.applyButton'))

    // In-place reason: progress while applying, the moment's blocker when the
    // apply is disabled, and the two-step hint when the button is live.
    let applyReasonKind = 'hint'
    let applyReasonNodes = []
    if (applying) {
      applyReasonKind = 'applying'
      applyReasonNodes = [
        h(icons.CircleNotch, { key: 'reason-icon', size: 12 }),
        h('span', { key: 'reason-text' }, translate('distill.confirm.applying')),
      ]
    } else if (applyError) {
      applyReasonKind = 'error'
      applyReasonNodes = [
        h(icons.Prohibit, { key: 'reason-icon', size: 12 }),
        h('span', { key: 'reason-text' },
          translate(ERROR_CODE_KEYS[applyError.code] || 'distill.confirm.error.code.default')),
      ]
    } else if (applyBlockedReason === 'empty') {
      applyReasonKind = 'empty'
      applyReasonNodes = [h('span', { key: 'reason-text' }, translate('distill.confirm.applyEmpty'))]
    } else if (applyBlockedReason === 'blocked') {
      applyReasonKind = 'blocked'
      applyReasonNodes = [h('span', { key: 'reason-text' }, translate('distill.confirm.applyBlocked'))]
    } else if (applyBlockedReason === 'runStatus') {
      applyReasonKind = 'runStatus'
      applyReasonNodes = [h('span', { key: 'reason-text' }, fill(
        translate('distill.confirm.runStatusNote'), { status: run?.status || '' }))]
    } else if (applyBlockedReason === 'drift') {
      applyReasonKind = 'drift'
      applyReasonNodes = [h('span', { key: 'reason-text' },
        translate('distill.confirm.bucket.conflictHint'))]
    } else {
      applyReasonNodes = [h('span', { key: 'reason-text' }, translate('distill.confirm.applyHint'))]
    }
    const warnReason = applyReasonKind === 'error'
      || applyReasonKind === 'blocked'
      || applyReasonKind === 'empty'
      || applyReasonKind === 'drift'
      || applyReasonKind === 'runStatus'

    const actionBar = h('div', {
      style: STICKY_BAR_STYLE,
      'data-action-bar': 'confirm',
    },
    h('div', { style: ACTION_BAR_ROW_STYLE, 'data-action-bar-row': 'main' },
      h('div', { style: ACTION_BAR_LEFT_STYLE },
        h('div', { style: META_STYLE },
          h(icons.Faders, { size: 14 }),
          h('span', { style: ACTION_BAR_LABEL_STYLE }, translate('distill.confirm.actionBar'))),
        h('span', { style: ACTION_BAR_CAPTION_STYLE }, translate('distill.confirm.actionBarHint'))),
      h('div', { style: ACTION_BAR_RIGHT_STYLE },
        backToIndex,
        onlyPendingButton,
        selectQualifiedButton,
        h('span', { style: STAT_STYLE }, fill(
          translate('distill.confirm.selectedCount'), { count: effectiveSelectedIds.length })),
        applyButton)),
    h('div', {
      style: warnReason
        ? { ...ACTION_BAR_REASON_STYLE, color: `var(--dsw-alias-state-warn-primary, ${NORD.nord12})` }
        : ACTION_BAR_REASON_STYLE,
      role: 'status',
      'data-apply-reason': applyReasonKind,
    }, ...applyReasonNodes),
    // The two-step confirmation opens directly under the bar (still inside the
    // sticky block), never at the page tail — no scroll jump, no hunting.
    confirming ? confirmPanel : null)

    return h('div', { style: CONTAINER_STYLE },
      // Page title first (it scrolls away); the action bar directly underneath
      // pins to the top from the first scroll onward.
      h('div', { style: SECTION_HEADING_STYLE },
        h(icons.Brain, { size: 14 }),
        h('span', {}, translate('distill.confirm.heading'))),

      actionBar,

      // Summary + plan-level counters (§10.1) stay above the ledger.
      h('div', { style: SECTION_STYLE },
        h('div', { style: SECTION_HEADING_STYLE },
          h(icons.ChartBar, { size: 14 }),
          h('span', {}, translate('distill.confirm.summaryLabel'))),
        h('div', { style: SUMMARY_TEXT_STYLE }, activePlan.summary || ''),
        h('div', { style: STATS_ROW_STYLE },
          h('span', { style: STAT_STYLE }, `${translate('distill.confirm.statFiles')}: ${stats.targets ?? targets.length}`),
          h('span', { style: STAT_STYLE }, `${translate('distill.confirm.statChanges')}: ${stats.changes ?? 0}`),
          h('span', { style: STAT_STYLE }, `${translate('distill.confirm.statConflicts')}: ${unresolvedConflicts.length}`),
          activePlan.truncated === true
            ? h(Badge, { tone: 'warn', icon: icons.Prohibit }, translate('distill.confirm.truncatedBadge'))
            : null)),

      adjudicatedSection,
      rebaseNotice
        ? h('div', {
            role: 'status',
            style: {
              ...META_STYLE,
              color: `var(--dsw-alias-state-success-primary, ${NORD.nord14})`,
            },
          },
            h(icons.CheckCircle, { size: 14 }),
            h('span', {}, fill(translate('distill.confirm.drift.rebaseDone'), { file: rebaseNotice })))
        : null,

      reviewBucket,
      conflictBucket,

      // Apply error banner (§10.5 / §13.3): readable copy, no raw hashes.
      applyError
        ? h('div', { role: 'alert', style: ERROR_BANNER_STYLE },
          h('div', { style: META_STYLE },
            h(icons.Prohibit, { size: 14 }),
            h('span', {},
              translate(ERROR_CODE_KEYS[applyError.code] || 'distill.confirm.error.code.default'),
              applyError.message ? ` — ${applyError.message}` : '')),
          applyError.code === 'CAS_CONFLICT' && applyError.file
            ? h('div', { style: { ...BODY_TEXT_STYLE, color: `var(--dsw-alias-state-error-primary, ${NORD.nord11})` } },
              `${translate('distill.confirm.error.file')}: ${applyError.file}`)
            : null,
          (applyError.targets && applyError.targets.length > 0) || applyError.backupPath
            ? h('div', { style: { ...BODY_TEXT_STYLE, color: `var(--dsw-alias-state-error-primary, ${NORD.nord11})` } },
              applyError.targets && applyError.targets.length > 0
                ? `${translate('distill.confirm.error.targets')}: ${applyError.targets.join(', ')}`
                : '',
              applyError.backupPath
                ? ` · ${translate('distill.confirm.error.backupPath')}: ${applyError.backupPath}`
                : '',
              h('div', { style: BODY_TEXT_STYLE }, translate('distill.confirm.error.manualHint')))
            : null)
        : null)
  }

  DistillConfirm.ResultContent = DistillResultContent
  return DistillConfirm
}
