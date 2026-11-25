/**
 * Session right-side pane (v2.0):
 * Faithful realization of docs/mockup/punch_desk_mockup.html layout & interactions.
 *
 * 1. Drawer Header: Brand icon, title, v2.0 pill, quick status counter ({activeCount}/{totalOpenCount}).
 * 2. Master Input Composer: Roomy monospace textarea, in-edit alert ribbon, toggleable tag pills (#优化/#卡点/#重构/#上下文), Save to pool button.
 * 3. Thought Pool Controls Toolbar: Select all checkbox, summary count, Expand/Collapse all toggle, Merge selected button.
 * 4. Cards Stream:
 *    - Active Groups Stream: Group header with status pulse, turns badge, title, count, item rows with execution indicators, queued edit/retract, drop-target.
 *    - Thoughts Draft Pool: Draggable cards with grip handle, checkbox, #No, tag pill, collapsed preview / full text, expand chevron, edit, delete.
 * 5. Bottom Staging & Submission Dock:
 *    - Target group selector (+G1, +G2, ... + 新建组 with 3-group limit).
 *    - Tweak prompt popover ("微调指令") with resizable height, copy button, and submit.
 *    - Combined Submit (1 Turn) and Sequential Queue buttons.
 */

import { SEVERITIES, reconcileFindingStatuses, filterInheritableFindings, inheritFindings, forkFinding, nextThoughtNo, isIgnoredFinding } from '../../domain/entries.js'
import { DEFAULT_PREFS, prefsOf } from '../prefs.js'
import { persistInheritScope } from '../inherit-scope.js'
import { LIMITS, composeCombinedPrompt, composeSequentialPrompt, estimatePromptBudget, validateBatch } from '../../domain/prompt.js'
import {
  MAX_EXECUTING_GROUPS,
  deriveGroupExecutionStatus,
  nextGroupNumber,
  createGroupRecord,
  addItemToGroup,
  removeItemFromGroup,
  planGroupWrapUp,
  countExecutingGroups,
  canCreateGroup,
} from '../../domain/active-group.js'
import { deriveLockWindow, getActiveRun } from '../../domain/distill-run.js'
import { deriveGroupTurnStats, freezeGroupTurnStats } from '../../domain/group-turns.js'
import {
  countText,
  createBits,
  formatLocalDateTime,
  formatLocalTime,
  subscribePendingCommitFocus,
  suppressesRowToggle,
  takePendingCommitFocus,
} from './bits.js'
import { COMMAND_CATALOG, SKILL_CATALOG, toTriggerItems } from '../catalog.js'
import { createClearDataModal } from './clear-data-modal.js'
import { hasNeonMark, neonSignal, NEON_CLASS } from './easter-egg.js'
import { NORD, SEMANTIC_TOKENS, getTagColor, getSeverityColor, getTagStyle, formatTagText, formatTagLabel, injectPunchDeskStyles, getSequenceTint, nordTint } from './nord.js'
import { DEFAULT_TAGS } from '../../domain/tags.js'
import { createSubmittedList } from './submitted-list.js'
import { createActionCardList } from './action-card-list.js'
import {
  findFindingByOriginKey,
  itemOriginKey,
  convertTurnActionToFinding,
  inheritTurnActions,
} from '../../domain/turn-actions.js'

/** Fallback catalog when prefs have not hydrated yet (normalizePrefs always yields presets). */

/** Distillation maintenance-window poll interval (spec §10.4: 1~2s). */
const DISTILL_LOCK_POLL_MS = 1500

/**
 * Derive the pane's distillation maintenance-window state from the workspace
 * run list (spec §10.4 / D20). Pure and fail-open: only the workspace's own
 * non-terminal run is considered, and a malformed run (deriveLockWindow
 * throws) never fabricates a lock. The returned `run` drives the window bar;
 * `locked` pauses the plugin submission entries only — never capture, edit,
 * draft deletion, inheritance, retrySubmit or editQueued, and never the
 * host's main input box (honest boundary).
 *
 * @param {object[]} runs workspace runs from GET distill-run?workspaceId=
 * @param {string} workspaceId real workspace id (never a `session:<id>` key)
 * @param {number} now injected clock (ms)
 * @returns {{ locked: boolean, reason: string|null, expiresAt: number|null, run: object|null }}
 */
export function deriveDistillLockState(runs, workspaceId, now) {
  const unlocked = { locked: false, reason: null, expiresAt: null, run: null }
  const run = getActiveRun(runs, workspaceId)
  if (!run) return unlocked
  try {
    const lock = deriveLockWindow(run, now)
    return { locked: lock.locked, reason: lock.reason, expiresAt: lock.expiresAt, run }
  } catch {
    // Malformed run: fail-open, no bar and no lock.
    return unlocked
  }
}

/** Foreground for solid danger fills (host inverted label, Snow Storm fallback). */
const ON_DANGER_FILL = 'var(--dsw-alias-label-primary-inverted, #eceff4)'

/** Full-screen modal scrim derived from Polar Night instead of pure black. */
const MODAL_SCRIM = nordTint(NORD.nord0, 0.55)

/**
 * Canonicalize an entry list by id. React state can race a store notification
 * that lands between an optimistic insert and its echo (e.g. forking a finding
 * while the subscription refreshes the pool), which would otherwise render two
 * cards with the same key: one persisted and deletable, one local ghost.
 * Keeping the last copy lets a newer version win; the array stays deduped.
 * @param {object[]} list
 * @returns {object[]}
 */
export function dedupeEntriesById(list) {
  if (!Array.isArray(list)) return []
  const map = new Map()
  for (const entry of list) {
    if (entry && typeof entry.id === 'string' && entry.id !== '') map.set(entry.id, entry)
  }
  return [...map.values()]
}

/**
 * Insert or replace one entry without ever duplicating its id.
 * @param {object[]} list current entries
 * @param {object} entry entry to merge in
 * @returns {object[]}
 */
export function upsertEntryState(list, entry) {
  if (!entry || typeof entry.id !== 'string' || entry.id === '') return Array.isArray(list) ? list : []
  const current = Array.isArray(list) ? list : []
  const index = current.findIndex(item => item && item.id === entry.id)
  if (index < 0) return [entry, ...current]
  const next = [...current]
  next[index] = entry
  return next
}

/**
 * Resolve catalog descriptions from locale keys. Built-in catalogs only carry a
 * descKey; host-provided catalogs keep their plain-text description untouched.
 * @param {object[]} items catalog entries
 * @param {(key: string) => string} [t] locale resolver
 * @returns {object[]}
 */
function resolveCatalog(items, t) {
  if (!Array.isArray(items)) return []
  return items.map(item => {
    if (!item || typeof item.descKey !== 'string') return item
    const text = typeof t === 'function' ? t(item.descKey) : ''
    return { ...item, description: typeof text === 'string' && text !== item.descKey ? text : '' }
  })
}

/** Default slash commands — derived from the shared catalog (P1-8). */
const DEFAULT_SLASH_COMMANDS = toTriggerItems(COMMAND_CATALOG)

/** Default skills catalog for / and $ triggers — derived from the shared catalog. */
const DEFAULT_SKILLS = toTriggerItems(SKILL_CATALOG)

/** Default workspace files for @ context mentions. */
const DEFAULT_WORKSPACE_FILES = [
  { name: 'AGENTS.md', path: 'AGENTS.md', descKey: 'mention.file.agents', kind: 'file', insert: '@AGENTS.md ' },
  { name: 'README.md', path: 'README.md', descKey: 'mention.file.readme', kind: 'file', insert: '@README.md ' },
  { name: 'package.json', path: 'package.json', descKey: 'mention.file.packageJson', kind: 'file', insert: '@package.json ' },
  { name: 'src/', path: 'src/', descKey: 'mention.file.src', kind: 'directory', insert: '@src/ ' },
]

// ============================================================================
// STYLES (strictly mapped to --dsw-alias-* tokens and Nord palette)
// ============================================================================

const PANE_CONTAINER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  background: 'var(--pd-bg-surface, var(--dsw-alias-bg-base, #ffffff))',
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  position: 'relative',
  minWidth: 320,
  overflowX: 'auto',
  overflowY: 'hidden',
  boxSizing: 'border-box',
}

const DRAWER_HEADER_STYLE = {
  padding: '10px 14px',
  borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  flexShrink: 0,
}

const COMPOSER_BOX_STYLE = {
  position: 'relative',
  padding: 12,
  borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  flexShrink: 0,
}

const EDIT_RIBBON_STYLE = {
  padding: '5px 10px',
  borderRadius: 6,
  background: nordTint(NORD.nord12, 0.15),
  border: `1px solid ${nordTint(NORD.nord12, 0.35)}`,
  color: NORD.nord12,
  fontSize: 11,
  fontFamily: 'monospace',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const COMPOSER_TEXTAREA_STYLE = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 8,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  outline: 'none',
  resize: 'vertical',
  minHeight: 68,
}

const TOOLBAR_STYLE = {
  padding: '6px 12px',
  borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  fontSize: 11,
  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
  flexShrink: 0,
}

function getCardTagStyle(tag, customIndex = -1, explicitColor = '') {
  const s = getTagStyle(tag, customIndex, explicitColor)
  return {
    padding: '2px 8px',
    borderRadius: 6,
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: 600,
    lineHeight: '14px',
    display: 'inline-flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    color: s.color,
    background: s.background,
    border: `1px solid ${s.borderColor}`,
    flexShrink: 0,
  }
}

function getTagPillStyle(tag, isSelected, customIndex = -1, explicitColor = '') {
  const activeStyle = getCardTagStyle(tag, customIndex, explicitColor)
  return {
    padding: '3px 10px',
    borderRadius: 6,
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: isSelected ? 700 : 500,
    cursor: 'pointer',
    color: isSelected ? activeStyle.color : 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
    background: isSelected ? activeStyle.background : 'transparent',
    border: isSelected ? activeStyle.border : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
    boxShadow: isSelected ? `0 0 8px ${activeStyle.background}` : 'none',
    transition: 'all 0.15s ease',
    display: 'inline-flex',
    alignItems: 'center',
  }
}

const STREAM_CONTAINER_STYLE = {
  flex: 1,
  minHeight: 0,
  overflowY: 'auto',
  padding: '8px 10px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

// Submitted prompt-log section: a borderless audit footer under the pool.
// It uses only semantic tokens so light/dark mode both resolve to a neutral
// hairline + secondary text (no sequence tint).
const SUBMITTED_SECTION_STYLE = (open) => ({
  marginTop: open ? 8 : 'auto',
  flexShrink: 0,
  borderTop: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.28)))',
})
const SUBMITTED_HEADER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 6,
  padding: '6px 2px',
  margin: 0,
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #4c566a))',
}
const SUBMITTED_COUNT_STYLE = {
  fontSize: 10,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontVariantNumeric: 'tabular-nums',
  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
}

const GROUP_CARD_STYLE = (groupNumber = 1, dragOver = false) => {
  const tint = getSequenceTint(Math.max(0, (Number(groupNumber) || 1) - 1))
  const isOdd = (Number(groupNumber) || 1) % 2 === 1
  return {
    borderRadius: 10,
    border: `1px solid ${dragOver ? `var(--pd-accent, var(--dsw-alias-button-primary-fill, ${NORD.nord8}))` : 'var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))'}`,
    // Left colour strip: solid accent on odd groups, soft border tone on even
    // groups, so adjacent groups stay distinguishable even when the five tint
    // tones wrap around to the same hue (group 6 reuses group 1's tint).
    borderLeft: `3px solid ${isOdd ? tint.accent : tint.border}`,
    background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    transition: 'border-color 0.15s ease',
  }
}

const GROUP_HEADER_STYLE = (groupNumber = 1) => {
  const tint = getSequenceTint(Math.max(0, (Number(groupNumber) || 1) - 1))
  return {
    padding: '8px 10px',
    // Neutral panel surface in both themes: the translucent sequence tint read as
    // muddy over dark layer-1 and dirty grey over light layer-1. The left strip and
    // the header dot keep the per-group identity instead.
    background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
    borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    fontSize: 11,
    fontFamily: 'monospace',
    color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  }
}

const DRAFT_CARD_STYLE = (isEditing = false, isSelected = false, last = false) => ({
  borderBottom: last ? 'none' : '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
  background: isEditing
    ? nordTint(NORD.nord12, 0.12)
    : isSelected
      ? nordTint(NORD.nord8, 0.10)
      : 'transparent',
  padding: '8px 10px',
  fontSize: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  position: 'relative',
  transition: 'background 0.15s ease',
})

const DOCK_STYLE = {
  padding: '10px 12px',
  borderTop: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  flexShrink: 0,
  position: 'relative',
}

const TWEAK_POPOVER_STYLE = (maximized = false) => ({
  position: 'absolute',
  bottom: '100%',
  left: 8,
  right: 8,
  marginBottom: 8,
  borderRadius: 12,
  background: 'var(--pd-bg-floating, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  boxShadow: `0 12px 30px ${nordTint(NORD.nord0, 0.25)}`,
  zIndex: 40,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  maxHeight: maximized ? 560 : 360,
  transition: 'max-height 0.2s ease',
})

const ROW_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '6px 8px',
  borderBottom: `1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))`,
  position: 'relative',
}

const ROW_TITLE_STYLE = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  lineHeight: 1.4,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  overflowWrap: 'anywhere',
}

// The right-side meta cluster (status / anchor badge / row actions) must be
// allowed to shrink and wrap; otherwise a long quote anchor (up to 40 chars +
// turn/message) overflows the row and collapses the title, especially while the
// finding is executing and the status badge is also present.
const FINDING_META_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  flexShrink: 1,
  minWidth: 0,
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
}
const ANCHOR_BADGE_STYLE = {
  minWidth: 0,
  maxWidth: 120,
  overflow: 'hidden',
}
const ANCHOR_LABEL_STYLE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const EXPANDED_CONTENT_STYLE = {
  fontSize: 12,
  lineHeight: 1.5,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  overflowWrap: 'anywhere',
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 10px',
  borderRadius: 6,
  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
  marginTop: 4,
}

const WARNING_STYLE = {
  padding: '8px 10px',
  borderRadius: 6,
  background: nordTint(NORD.nord12, 0.15),
  border: `1px solid ${NORD.nord12}`,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const WARNING_TEXT_STYLE = {
  fontSize: 12,
  lineHeight: 1.4,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}

const ANCHOR_HINT_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 11,
}

const BUTTON_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
}

/**
 * Human-readable anchor hint. Quote anchors surface the captured excerpt so the
 * card/composer never hides what was actually quoted.
 * @param {object|null} anchor
 * @param {(key: string) => string} [t]
 * @returns {string}
 */
function anchorText(anchor, t) {
  if (!anchor || typeof anchor !== 'object') return ''
  const translate = key => {
    const text = typeof t === 'function' ? t(key) : ''
    return typeof text === 'string' && text !== key ? text : ''
  }
  const fill = (template, name, value) => template.replace(`{${name}}`, String(value))
  const kind = anchor.type || anchor.kind
  const turnText = anchor.turn
    ? fill(translate('anchor.turn'), 'turn', anchor.turn)
    : ''
  const messageText = anchor.messageId
    ? fill(translate('anchor.message'), 'id', String(anchor.messageId).slice(0, 8))
    : translate('anchor.selection')
  if (kind === 'message') {
    return [turnText, messageText].filter(Boolean).join(' · ')
  }
  if (kind === 'quote') {
    const quote = typeof anchor.text === 'string' ? anchor.text.trim() : ''
    const excerpt = quote === ''
      ? ''
      : fill(translate('anchor.quoteExcerpt'), 'text', quote.length > 40 ? `${quote.slice(0, 40)}…` : quote)
    const suffix = [turnText, messageText].filter(Boolean).join(' · ')
    return [
      translate('anchor.quote'),
      excerpt,
      suffix === '' ? '' : `(${suffix})`,
    ].filter(Boolean).join(' ')
  }
  return ''
}

function failureText(result, error) {
  if (result?.error?.message) return result.error.message
  if (Array.isArray(result?.errors) && result.errors.length > 0) return result.errors.join('；')
  if (error?.message) return error.message
  return 'Operation failed'
}

const COMMIT_TRACE_ERROR_KEYS = {
  'no-pre-head': 'commitTrace.error.noPreHead',
  'no-post-head': 'commitTrace.error.noPostHead',
  'not-a-repo': 'commitTrace.error.notARepo',
  'range-failed': 'commitTrace.error.rangeFailed',
  'workspace-unresolved': 'commitTrace.error.workspaceUnresolved',
  'invalid-sha': 'commitTrace.error.badRange',
}

function formatCommitTraceError(errorCode, t) {
  const key = COMMIT_TRACE_ERROR_KEYS[errorCode]
  if (key && typeof t === 'function') return t(key)
  return typeof errorCode === 'string' && errorCode ? errorCode : (typeof t === 'function' ? t('commitTrace.error.rangeFailed') : 'range-failed')
}

function canRetryCommitTrace(trace) {
  if (!trace || trace.status !== 'failed') return false
  if (!trace.preHead || !trace.postHead) return false
  if (trace.error === 'not-a-repo' || trace.error === 'workspace-unresolved') return false
  return true
}

function collectUniqueCommits(traces) {
  const map = new Map()
  for (const tr of traces || []) {
    if (!tr || !Array.isArray(tr.commits)) continue
    for (const c of tr.commits) {
      if (c && typeof c.hash === 'string' && c.hash && !map.has(c.hash)) {
        map.set(c.hash, c)
      }
    }
  }
  return [...map.values()]
}

function formatCommitTime(epochSec) {
  return formatLocalTime(epochSec)
}

export function captureAnchor(capture) {
  if (!capture || typeof capture !== 'object') return null
  if (capture.kind === 'message' && typeof capture.messageId === 'string' && capture.messageId !== '') {
    return { type: 'message', messageId: capture.messageId }
  }
  if (capture.kind === 'turn' && typeof capture.turn === 'number') {
    return { type: 'turn', turn: capture.turn, ...(typeof capture.seq === 'number' ? { seq: capture.seq } : {}) }
  }
  return null
}

/**
 * Derive the readonly Harness execution projection for a finding.
 *
 * The projection is evidence-based; a persisted `status` is only ever the *last
 * known* value, never proof of a newer Harness state.
 *
 * BUG-2026-11-13-01 (2026-11-12 22:44 submission 23/25): once the queue item was
 * consumed, the row kept reading 已排队 because `finding.status === 'queued'`
 * was echoed back whenever no `completed` PromptLog row matched. The live queue
 * is authoritative when it was actually read (`liveQueue` is an array):
 * - item present          -> `running` (item.status === 'running') or `queued`;
 * - item absent from a read queue -> the prompt left the queue; report `running`
 *   when the PromptLog proves a turn started, otherwise `unknown`. Never `queued`;
 * - queue unknown (`null`/missing, i.e. the state read failed or the service is
 *   absent) proves nothing, so the persisted last-known value stays.
 *
 * Terminal PromptLog rows (`completed`/`executed`/`resolved`) and a resolved
 * review are execution evidence; `sent`/`running` rows prove a turn started but
 * not that it finished. Nothing here fabricates execution.
 *
 * @param {object} finding
 * @param {Array} log PromptLog rows of this session (current retained window)
 * @param {Array|null} liveQueue live Harness queue items, or a non-array when
 *   the queue could not be read
 * @returns {'queued' | 'running' | 'executed' | 'settled' | 'unknown'}
 */
export function deriveHarnessProjection(finding, log = [], liveQueue = []) {
  if (!finding) return 'unknown'
  if (finding.submissionStatus === 'unsubmitted' || finding.status === 'open') return 'unknown'
  if (finding.reviewStatus === 'resolved') return 'executed'
  // Dismissed is a review settlement, not Harness execution evidence.
  if (isIgnoredFinding(finding)) return 'settled'

  const requestId = typeof finding.requestId === 'string' && finding.requestId !== ''
    ? finding.requestId
    : undefined
  // `null` / a non-array means the queue was not read: it cannot prove absence.
  const queueRead = Array.isArray(liveQueue)
  const queuedItem = (requestId && queueRead)
    ? liveQueue.find(item => item.rpcId === requestId || item.id === requestId)
    : null

  // A delivered log row is stronger evidence than a queue snapshot. The pane
  // only polls the queue while a finding is still `queued`; once delivery flips
  // it to `sent` the polling stops, so the last snapshot can keep listing the
  // item after the turn finished (or while it runs). Trusting the snapshot first
  // left correctly completed jobs stuck on 「已排队」 and blocked wrap-up
  // (queuedIds) until a manual refresh. Order: log evidence, then the queue.
  if (requestId && Array.isArray(log)) {
    const matchingLog = log.find(item => item.requestId === requestId || item.messageId === requestId)
    if (matchingLog) {
      if (matchingLog.status === 'completed' || matchingLog.status === 'executed' || matchingLog.status === 'resolved') {
        return 'executed'
      }
      // A `queue:<requestId>` placeholder is a tracking row, not turn evidence;
      // only a delivered row (`sent`) proves the turn started.
      if (matchingLog.status === 'sent' || matchingLog.status === 'running') {
        return 'running'
      }
    }
  }

  if (queuedItem) {
    if (queuedItem.status === 'running') return 'running'
    return 'queued'
  }

  // AGENTS §7: a legacy M1b 'sent' row is a submission fact, NOT execution
  // evidence. Only 'completed'/'executed' may claim execution without a log row;
  // everything else stays 'unknown' instead of silently assuming completion.
  if (finding.status === 'completed' || finding.status === 'executed') return 'executed'

  // A persisted 'queued' is the last known state. If the queue was read and the
  // item is gone, the prompt was consumed: keep it out of `queued` (it would
  // block wrap-up forever) but do not claim execution either.
  if (finding.status === 'queued') return queueRead && requestId ? 'unknown' : 'queued'
  return 'unknown'
}

/**
 * Locale-backed label model for the group header turn attribution
 * (`本组 N 轮 · 触发 K · 直输归属 A`).
 *
 * `groupTurns = charged + attributed` is the main number. `elapsed` is session
 * context and only ever appears in the tooltip. Archived groups read the
 * write-once window snapshot; an archived group whose snapshot is missing
 * falls back to the live derivation and is labelled 未冻结 instead of
 * pretending the numbers froze.
 *
 * @param {{ groupTurns?: number, charged?: number, attributed?: number, elapsed?: number, source?: string, frozen?: boolean, coverage?: { inferred?: number, unknown?: number, unattributed?: number } }|null|undefined} stats
 * @param {(key: string) => string} t
 * @returns {{
 *   turns: string, triggered: string, attributed: string,
 *   turnsTip: string, triggeredTip: string, attributedTip: string,
 *   archived: boolean, frozen: boolean,
 * }}
 */
export function describeGroupTurns(stats, t) {
  const safe = stats && typeof stats === 'object' ? stats : {}
  const turns = Number.isFinite(safe.groupTurns) ? safe.groupTurns : 0
  const charged = Number.isFinite(safe.charged) ? safe.charged : 0
  const attributed = Number.isFinite(safe.attributed) ? safe.attributed : 0
  const elapsed = Number.isFinite(safe.elapsed) ? safe.elapsed : 0
  const archived = safe.source === 'archived' || safe.source === 'live-unfrozen'
  const frozen = archived && safe.frozen !== false

  const fill = (template, vars) => String(template).replace(/\{(\w+)\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ))

  const main = archived
    ? fill(t('group.archivedAtBadge'), { turns })
    : fill(t('group.groupTurnsBadge'), { turns })
  const turnsText = archived && !frozen ? `${main} · ${t('group.unfrozenBadge')}` : main
  const elapsedLine = fill(t('group.elapsedTip'), { turns: elapsed })
  const archiveLine = archived
    ? t(frozen ? 'group.archivedFrozenTip' : 'group.unfrozenTip')
    : ''
  const turnsTip = [t('group.turnsTip'), elapsedLine, archiveLine]
    .filter(part => typeof part === 'string' && part !== '')
    .join('\n')

  return {
    turns: turnsText,
    triggered: fill(t('group.triggeredBadge'), { count: charged }),
    attributed: fill(t('group.attributedBadge'), { count: attributed }),
    turnsTip,
    triggeredTip: t('group.triggeredTip'),
    attributedTip: t('group.attributedTip'),
    archived,
    frozen,
  }
}

/**
 * Factory creating the SessionPane React component.
 * @param {{ h: Function, React: object, services: object }} deps
 * @returns {Function} SessionPane component
 */
/**
 * Header summary: findings that still need a human action.
 *
 * A batch that has finished executing is NOT finished: it still needs the
 * explicit wrap-up click, so its findings stay in the count as "待结项"
 * instead of vanishing from the badge (reported: 1 active group with 9
 * completed rows read 0/0). Archived groups are history and stay out of the
 * counter entirely.
 *
 * @param {{entries: Array<object>, groups: Array<object>, poolCount?: number, findingsMap: Map<string, object>, harnessProjectionsMap: any}} input
 * @returns {{active:number,total:number,awaitingWrapUp:number,awaitingGroups:number,needsWrapUp:boolean,color:string,textColor:string,executing:number,queued:number,executingGroups:number,breathing:boolean,statusCounts:{submitted:number,awaitingReview:number,completed:number}}}
 */
export function summarizeOpenWork({ entries, groups, poolCount = 0, findingsMap, harnessProjectionsMap }) {
  const projectOf = (findingId, finding) => {
    if (!harnessProjectionsMap) return 'unknown'
    if (harnessProjectionsMap instanceof Map) return harnessProjectionsMap.get(findingId) ?? 'unknown'
    if (typeof harnessProjectionsMap === 'function') {
      try { return harnessProjectionsMap(findingId, finding) ?? 'unknown' } catch { return 'unknown' }
    }
    if (typeof harnessProjectionsMap === 'object') return harnessProjectionsMap[findingId] ?? 'unknown'
    return 'unknown'
  }
  const activeGroups = (groups || []).filter(group => group.status !== 'archived')
  let awaitingWrapUp = 0
  let awaitingGroups = 0
  let active = 0
  let hasCompletedGroup = false
  let executing = 0
  let queued = 0
  let executingGroups = 0
  const statusCounts = { submitted: 0, awaitingReview: 0, completed: 0 }
  for (const group of activeGroups) {
    const items = entries.filter(entry => entry.assignedGroupId === group.id && !isIgnoredFinding(entry))
    // Stable across execution phases: an item in a not-yet-wrapped group keeps
    // counting until the group is wrapped up. Counting only unresolved rows made
    // the header jump from 3/3 (running) to 14/14 (executed) on the same batch.
    active += items.length
    for (const item of items) {
      const projection = projectOf(item.id, item)
      if (projection === 'running') executing += 1
      else if (projection === 'queued') queued += 1
      if (item.reviewStatus === 'resolved') statusCounts.completed += 1
      else if (projection === 'executed') statusCounts.awaitingReview += 1
      else statusCounts.submitted += 1
    }
    const status = deriveGroupExecutionStatus(group, findingsMap, harnessProjectionsMap)
    if (status === 'completed') {
      awaitingWrapUp += items.length
      awaitingGroups += 1
      hasCompletedGroup = true
    } else if (status === 'executing') executingGroups += 1
  }
  const total = active + poolCount
  // A batch whose rows are all dismissed has no actionable row but still needs the
  // explicit wrap-up click, so it must keep warning instead of reading 0/0 silently.
  const needsWrapUp = awaitingWrapUp > 0 || hasCompletedGroup
  const breathing = executing > 0
  // Priority: running > pending wrap-up > empty > idle. A completed batch whose
  // rows are all dismissed has total 0 but still needs the wrap-up click.
  const color = breathing
    ? 'var(--pd-status-running, #0e9f4f)'
    : (needsWrapUp
        ? 'var(--pd-status-warn, #ebcb8b)'
        : (!total
            ? 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))'
            : 'var(--pd-status-idle, #5e81ac)'))
  // High-saturation green is for the dot; 9-11px text needs a readable shade.
  const textColor = breathing
    ? 'var(--pd-status-running-text, #0a6b36)'
    : (needsWrapUp
        ? 'var(--pd-status-warn-text, #7a5a00)'
        : (!total
            ? 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))'
            : 'var(--pd-status-idle, #5e81ac)'))
  return { active, total, awaitingWrapUp, awaitingGroups, needsWrapUp, color, textColor, executing, queued, executingGroups, breathing, statusCounts }
}

/**
 * Group badge state. A settled batch distinguishes "all rows completed" from
 * "some/all rows dismissed": 忽略 is a review outcome, never 已完成.
 * @returns {{executionStatus:string,kind:'inProgress'|'completed'|'partialIgnored'|'allIgnored',dismissed:number,total:number}}
 */
export function deriveGroupBadgeState(group, findingsMap, harnessProjectionsMap) {
  const executionStatus = deriveGroupExecutionStatus(group, findingsMap, harnessProjectionsMap)
  const items = Array.isArray(group?.items) ? group.items : []
  const pick = id => {
    if (findingsMap instanceof Map) return findingsMap.get(id)
    if (Array.isArray(findingsMap)) return findingsMap.find(finding => finding && finding.id === id)
    return findingsMap?.[id]
  }
  const findings = []
  const seen = new Set()
  for (const item of items) {
    const finding = pick(item.findingId)
    if (finding && !seen.has(finding.id)) { findings.push(finding); seen.add(finding.id) }
  }
  // Historical rows may be linked only through assignedGroupId; the row list uses
  // that union, so the badge must use it too.
  const allFindings = findingsMap instanceof Map
    ? [...findingsMap.values()]
    : (Array.isArray(findingsMap) ? findingsMap : [])
  for (const finding of allFindings) {
    if (finding && finding.assignedGroupId === group?.id && !seen.has(finding.id)) {
      findings.push(finding); seen.add(finding.id)
    }
  }
  const isDismissed = isIgnoredFinding
  const dismissed = findings.filter(isDismissed).length
  if (executionStatus !== 'completed') return { executionStatus, kind: 'inProgress', dismissed, total: findings.length }
  const kind = dismissed === 0 ? 'completed' : (dismissed >= findings.length ? 'allIgnored' : 'partialIgnored')
  return { executionStatus, kind, dismissed, total: findings.length }
}

/**
 * Per-group finding-state counts used by the header count Badge.
 * - completed: reviewStatus resolved (真完成)
 * - awaitingWrapUp: executed but not reviewed (待结项)
 * - submitted: queued/running/unknown (已提交未执行完)
 * - ignored: dismissed
 * @param {object[]} findings
 * @param {(finding: object) => string} projectOf
 * @returns {{completed:number,awaitingWrapUp:number,submitted:number,ignored:number,total:number}}
 */
export function summarizeGroupStatusCounts(findings, projectOf = () => 'unknown') {
  const counts = { completed: 0, awaitingWrapUp: 0, submitted: 0, ignored: 0, total: 0 }
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!finding) continue
    counts.total += 1
    if (isIgnoredFinding(finding)) { counts.ignored += 1; continue }
    if (finding.reviewStatus === 'resolved') { counts.completed += 1; continue }
    if (projectOf(finding) === 'executed') counts.awaitingWrapUp += 1
    else counts.submitted += 1
  }
  return counts
}

export function formatGroupCountBadge(counts) {
  const awaiting = Number.isFinite(counts?.awaitingWrapUp) ? counts.awaitingWrapUp : 0
  const total = Number.isFinite(counts?.total) ? counts.total : 0
  return `${awaiting}/${total}`
}

export function createSessionPane({ h, React, services }) {
  const {
    Button,
    Badge,
    Card,
    Empty,
    Folder,
    ChatTeardropText,
    BookBookmark,
    Kanban,
    GitDiff,
    Brain,
    Plus,
    Trash,
    PencilSimple,
    Play,
    CheckCircle,
    CircleNotch,
    Circle,
    Clock,
    ArrowRight,
    ArrowCounterClockwise,
    CaretDown,
    CaretRight,
    ArrowsDownUp,
    Prohibit,
    DotsThree,
    X,
    BookmarkSimple,
    DotsSixVertical,
    PaperPlaneRight,
    Sliders,
    ArrowsOut,
    List,
    PushPin,
    PushPinSimple,
    Copy,
    GitCommit,
    PunchDeskLogoColor,
    PunchDeskLogoMono,
  } = createBits(h)

  const SubmittedList = createSubmittedList({ h, t: services.t, React })
  const ActionCardList = createActionCardList({ h, t: services.t, React })

  return function SessionPane(props) {
    const { sessionId } = props
    const t = services.t
    const [entries, setEntries] = React.useState([])
    const [groups, setGroups] = React.useState([])
    const [log, setLog] = React.useState([])
    // `null` until the live queue was actually read. BUG-2026-11-13-01: an empty
    // array must not mean "queue known empty" before the first read, or a stale
    // persisted `queued` row would be reported as consumed/unknown on mount.
    const [liveQueue, setLiveQueue] = React.useState(null)
    // Session archive state belongs to the Harness workspace registry; the pane
    // only projects it. Archived sessions keep their data readable but cannot
    // consume prompts (the host's archived-session gate rejects every step).
    const [sessionArchived, setSessionArchived] = React.useState(false)
    // Distillation maintenance window (spec §10.4): a read-only projection of
    // this workspace's active distill run. Only plugin submission entries are
    // paused while locked; the host input box is never claimed to be blocked.
    const [distillLock, setDistillLock] = React.useState({ locked: false, reason: null, expiresAt: null, run: null })
    const [distillCancelBusy, setDistillCancelBusy] = React.useState(false)
    const [text, setText] = React.useState('')
    // Composer glow: armed only by a *successful save* of a body that carries the
    // marker (not by typing), then it fades on its own. Purely visual.
    const [neonArmed, setNeonArmed] = React.useState(false)
    const maybeArmNeon = saved => {
      if (hasNeonMark(saved)) neonSignal.arm()
    }
    React.useEffect(() => {
      let timer = null
      const unsubscribe = neonSignal.subscribe(armed => {
        setNeonArmed(armed)
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        if (!armed) return
        timer = setTimeout(() => {
          setNeonArmed(false)
          neonSignal.clear()
        }, neonSignal.remaining() + 30)
      })
      return () => {
        unsubscribe()
        if (timer) clearTimeout(timer)
      }
    }, [])
    const [selectedTag, setSelectedTag] = React.useState('optimize')
    const [selected, setSelected] = React.useState(() => new Set())
    const [expandedSet, setExpandedSet] = React.useState(() => new Set())
    const [expandedTurnGroupIds, setExpandedTurnGroupIds] = React.useState(() => new Set())
    const [expandedGroupCountIds, setExpandedGroupCountIds] = React.useState(() => new Set())
    // The submitted prompt-log section starts expanded but can be folded.
    const [submittedLogOpen, setSubmittedLogOpen] = React.useState(true)
    const [turnActionsState, setTurnActionsState] = React.useState(null)
    const [isRescanningActions, setIsRescanningActions] = React.useState(false)
    const [activeBottomTab, setActiveBottomTab] = React.useState('actions')
    const [bottomSectionOpen, setBottomSectionOpen] = React.useState(true)
    const [highlightedActionId, setHighlightedActionId] = React.useState(null)
    const [highlightedFindingId, setHighlightedFindingId] = React.useState(null)
    const [inheritModalTab, setInheritModalTab] = React.useState('findings')
    const [archivedActionsData, setArchivedActionsData] = React.useState([])
    const [importSourceActionSessionId, setImportSourceActionSessionId] = React.useState(null)
    const [importSelectedActionIds, setImportSelectedActionIds] = React.useState(() => new Set())
    const [isAllExpanded, setIsAllExpanded] = React.useState(true)
    const [editingFindingId, setEditingFindingId] = React.useState(null)
    const [editingText, setEditingText] = React.useState('')
    const [captureError, setCaptureError] = React.useState('')
    const [busy, setBusy] = React.useState(false)
    const [quotaWarning, setQuotaWarning] = React.useState(false)
    const [notice, setNotice] = React.useState(null)
    const [anchors, setAnchors] = React.useState([])
    const [dragOverGroupId, setDragOverGroupId] = React.useState(null)
    const [selectedTargetGroupId, setSelectedTargetGroupId] = React.useState(null)
    const [pendingAppend, setPendingAppend] = React.useState(null)
    const [capPopoverOpen, setCapPopoverOpen] = React.useState(false)
    const [capWrapConfirmId, setCapWrapConfirmId] = React.useState(null)
    // Hover card for the git footprint badge. Native `title` proved unreliable in
    // the host webview (delayed or silently swallowed), so the badge owns its tooltip.
    const [showTweakPopover, setShowTweakPopover] = React.useState(false)
    const [isMaximizedPopover, setIsMaximizedPopover] = React.useState(false)
    const [tweakPromptText, setTweakPromptText] = React.useState('')
    const [draggedFindingId, setDraggedFindingId] = React.useState(null)
    const [dragOverFindingId, setDragOverFindingId] = React.useState(null)
    const [showArchivedSection, setShowArchivedSection] = React.useState(true)
    const [archivedSortDesc, setArchivedSortDesc] = React.useState(true)
    const [liveTurn, setLiveTurn] = React.useState(0)
    const [popover, setPopover] = React.useState(null)
    const [commandsList, setCommandsList] = React.useState([])
    const [skillsList, setSkillsList] = React.useState([])
    const [referencesCache, setReferencesCache] = React.useState({ files: [], sessions: [] })
    const [isImportModalOpen, setIsImportModalOpen] = React.useState(false)
    const [isClearModalOpen, setIsClearModalOpen] = React.useState(false)
    const [clearOptions, setClearOptions] = React.useState({
      clearFindings: true,
      clearGroups: true,
      clearPromptLogs: true,
      clearDrafts: false,
      preservePinned: true,
    })
    const [clearing, setClearing] = React.useState(false)
    const [clearNotice, setClearNotice] = React.useState(null)
    const [otherSessionsData, setOtherSessionsData] = React.useState([])
    const [wrapUpConfirmId, setWrapUpConfirmId] = React.useState(null)
    // Deleting a draft finding is irreversible (no undo): mirror the wrap-up
    // two-step confirmation so a mis-click cannot destroy a finding.
    const [deleteConfirmId, setDeleteConfirmId] = React.useState(null)
    const [importSourceSessionId, setImportSourceSessionId] = React.useState(null)
    const [importSelectedIds, setImportSelectedIds] = React.useState(() => new Set())
    const [importNotice, setImportNotice] = React.useState(null)
    const [importing, setImporting] = React.useState(false)
    const [panePrefs, setPanePrefs] = React.useState(DEFAULT_PREFS)
    const [inheritScope, setInheritScope] = React.useState('workspace')
    // Tag catalog lives in prefs (labels are user content, never translated).
    // Custom tags borrow a shared palette by their catalog index.
    const tagCatalog = Array.isArray(panePrefs.findingTags) && panePrefs.findingTags.length > 0
      ? panePrefs.findingTags
      : DEFAULT_TAGS
    const tagCustomIndex = key => tagCatalog.filter(tag => tag.preset !== true).findIndex(tag => tag.key === key)
    const tagLabelOf = key => {
      const def = tagCatalog.find(tag => tag.key === key)
      return def ? formatTagLabel(def.label) : formatTagText(key, t)
    }
    const tagExplicitColor = key => {
      const def = tagCatalog.find(tag => tag.key === key)
      return def && !def.preset && typeof def.color === 'string' ? def.color : ''
    }
    const tagStyleOf = key => getCardTagStyle(key, tagCustomIndex(key), tagExplicitColor(key))
    const tagColorOf = key => getTagColor(key, tagCustomIndex(key), tagExplicitColor(key))
    // One source for every submit path (dock, drag-to-group, retry): the reply
    // tail, byte budget and tag framework must match between precheck and send.
    const promptOptionsFor = () => ({
      promptTail: panePrefs.promptTail,
      texts: {
        a: panePrefs.promptTailTextA,
        b: panePrefs.promptTailTextB,
        c: panePrefs.promptTailTextC,
      },
      maxEntries: LIMITS.maxEntries,
      maxEntryBytes: panePrefs.promptMaxEntryBytes,
      maxBytes: panePrefs.promptMaxBytes,
      tags: tagCatalog,
    })
    const [commitTraces, setCommitTraces] = React.useState([])
    const [gitExpandedMap, setGitExpandedMap] = React.useState(() => new Map())
    const [highlightedCommitFocus, setHighlightedCommitFocus] = React.useState(null)
    const paneRef = React.useRef(null)

    const toggleGitExpand = (key, currentlyExpanded) => {
      setGitExpandedMap(prev => {
        const next = new Map(prev)
        next.set(key, !currentlyExpanded)
        return next
      })
    }

    const toggleGroupStatusCounts = (groupId, event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      setExpandedGroupCountIds(prev => {
        const next = new Set(prev)
        if (next.has(groupId)) next.delete(groupId)
        else next.add(groupId)
        return next
      })
    }

    const toggleTurnMetrics = (groupId, event) => {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
      setExpandedTurnGroupIds(prev => {
        const next = new Set(prev)
        if (next.has(groupId)) next.delete(groupId)
        else next.add(groupId)
        return next
      })
    }

    React.useEffect(() => {
      let active = true
      if (typeof services.listCommands === 'function') {
        services.listCommands(sessionId).then(cmds => {
          if (active && Array.isArray(cmds)) setCommandsList(cmds)
        }).catch(() => {})
      }
      if (typeof services.listSkills === 'function') {
        services.listSkills(sessionId).then(sks => {
          if (active && Array.isArray(sks)) setSkillsList(sks)
        }).catch(() => {})
      }
      if (typeof services.listFilesAndSessions === 'function') {
        services.listFilesAndSessions(sessionId, '').then(refs => {
          if (active && refs) setReferencesCache(refs)
        }).catch(() => {})
      }
      return () => { active = false }
    }, [sessionId, services])

    React.useEffect(() => {
      if (!sessionId || !services.remote?.session?.observeEvent) return
      const ac = new AbortController()
      ;(async () => {
        try {
          for await (const frame of services.remote.session.observeEvent({ address: { kind: 'session', sessionId } }, ac.signal)) {
            const event = frame?.event
            if (!event) continue
            const tNum = event.data?.turn ?? event.turn
            if (Number.isFinite(tNum)) {
              // Only advance the live session turn. Group badges derive their
              // elapsed turns from currentTurn - startTurn, so persisting a
              // separate per-group counter here made them freeze at stale
              // values (e.g. G2 stayed at 1 while the session reached turn 30).
              setLiveTurn(prev => (tNum > prev ? tNum : prev))
            }
          }
        } catch {}
      })()
      return () => ac.abort()
    }, [sessionId, services.remote])

    // Target selection contract (active-group.md §提交目标与容量交互):
    // submission is irreversible, so an implicit default must never decide the
    // destination when more than one active group exists. Only the unambiguous
    // single-group case auto-selects; otherwise the user picks explicitly.
    React.useEffect(() => {
      const active = groups.filter(g => g.status !== 'archived')
      if (selectedTargetGroupId === 'new') return
      if (active.length === 0) {
        if (selectedTargetGroupId !== null) setSelectedTargetGroupId(null)
        return
      }
      if (selectedTargetGroupId && active.some(g => g.id === selectedTargetGroupId)) return
      setSelectedTargetGroupId(active.length === 1 ? active[0].id : null)
    }, [groups, selectedTargetGroupId])

    const workspaceKey = `session:${sessionId}`
    const currentWorkspaceId = props.workspaceId
      || props.workspace?.id
      || (typeof services.resolveWorkspaceId === 'function' ? services.resolveWorkspaceId(sessionId) : undefined)
      || workspaceKey
    // Distill routes require a real workspaceId: the `session:<id>` storage-key
    // fallback is NOT a valid distill workspaceId (the route rejects it), so it
    // is deliberately excluded here. Without a real id the window stays open.
    const distillWorkspaceId = (() => {
      const candidates = [
        props.workspaceId,
        props.workspace?.id,
        typeof services.resolveWorkspaceId === 'function' ? services.resolveWorkspaceId(sessionId) : null,
      ]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim() !== ''
          && candidate !== workspaceKey && !candidate.startsWith('session:')) {
          return candidate
        }
      }
      return null
    })()
    const mounted = React.useRef(false)
    const logGeneration = React.useRef(0)
    const captureSession = React.useRef(null)
    const textareaRef = React.useRef(null)

    const maxLogTurn = log.length > 0
      ? Math.max(...log.map(l => (typeof l.turn === 'number' ? l.turn : (typeof l.turnIndex === 'number' ? l.turnIndex : 0))), 0)
      : 0
    const indexTurn = typeof services.index?.getTurn === 'function' ? (services.index.getTurn(sessionId) ?? 0) : 0
    const currentTurn = props.currentTurn ?? props.turn ?? Math.max(liveTurn, maxLogTurn, indexTurn)

    const findingsMap = React.useMemo(() => {
      const map = new Map()
      for (const e of entries) {
        if (e && e.id) map.set(e.id, e)
      }
      return map
    }, [entries])

    const harnessProjectionsMap = React.useCallback((id, finding) => {
      const f = finding || findingsMap.get(id)
      return deriveHarnessProjection(f, log, liveQueue)
    }, [findingsMap, log, liveQueue])

    /**
     * Group turn attribution (plan 2026-11-12 Phase 2): `groupTurns = charged +
     * attributed` per group, derived from accepted submission evidence plus the
     * session's current retained PromptLog/Trace window. Archived groups read
     * their write-once window snapshot instead (see domain/group-turns.js).
     *
     * Pure read model: it never writes, never schedules, and never stands in for
     * the Harness queue. One derivation per group per render, shared by the
     * active stream and the archived history.
     */
    const groupTurnStatsById = React.useMemo(() => {
      const map = new Map()
      const input = {
        groups,
        findings: entries,
        promptLogs: log,
        traces: commitTraces,
        currentTurn,
      }
      for (const group of groups) {
        if (!group || typeof group !== 'object' || typeof group.id !== 'string') continue
        map.set(group.id, deriveGroupTurnStats(group, input))
      }
      return map
    }, [groups, entries, log, commitTraces, currentTurn])

    // Load findings and groups from store
    const load = React.useCallback(async () => {
      if (!sessionId) return
      try {
        const [listedEntries, listedGroups, listedTurnActions] = await Promise.all([
          services.store.listEntries(workspaceKey),
          services.store.getGroups ? services.store.getGroups(sessionId) : Promise.resolve([]),
          services.store.listTurnActions ? services.store.listTurnActions(sessionId) : Promise.resolve(null),
        ])
        if (!mounted.current) return

        const loadedEntries = listedEntries || []
        const rawEntries = dedupeEntriesById(loadedEntries)
        // Determine existing thought numbers and fill any missing ones deterministically
        let maxNo = 0
        for (const e of rawEntries) {
          if (typeof e.thoughtNo === 'number' && e.thoughtNo > maxNo) {
            maxNo = e.thoughtNo
          }
        }

        // A duplicated dispatch in the store (or a stale optimistic echo) must
        // never survive into the rendered pool; persist the repaired list too.
        let needsSave = rawEntries.length !== loadedEntries.length
        const sanitizedEntries = rawEntries.map(e => {
          if (typeof e.thoughtNo === 'number' && e.thoughtNo > 0) {
            return e
          }
          maxNo += 1
          needsSave = true
          return { ...e, thoughtNo: maxNo }
        })

        setEntries(sanitizedEntries)
        setGroups(listedGroups || [])
        setTurnActionsState(listedTurnActions || null)

        if (needsSave) {
          if (services.store?.putEntries) {
            services.store.putEntries(workspaceKey, sanitizedEntries).catch(() => {})
          } else if (services.store?.putEntry) {
            Promise.all(sanitizedEntries.map(e => services.store.putEntry(e))).catch(() => {})
          }
        }
      } catch {
        // degrade safely
      }
    }, [sessionId, workspaceKey])

    // Track the Harness archive set. The service is optional (older compositions
    // may not expose it), so a missing subscription simply leaves the session
    // unarchived; a host that provides it keeps the pane reactive.
    React.useEffect(() => {
      let alive = true
      const read = () => {
        if (!alive) return
        try {
          const ids = services.getArchivedSessionIds?.()
          setSessionArchived(Array.isArray(ids) && ids.includes(sessionId))
        } catch {
          setSessionArchived(false)
        }
      }
      read()
      let unsubscribe
      try {
        unsubscribe = services.subscribeWorkspaceSnapshot?.(read)
      } catch {
        unsubscribe = undefined
      }
      return () => {
        alive = false
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    }, [sessionId, services])

    // Refresh live Harness queue
    const refreshQueue = React.useCallback(async () => {
      if (!sessionId || !services.submit?.queryQueue) return
      try {
        const queueRes = await services.submit.queryQueue(sessionId)
        if (mounted.current && queueRes?.ok && Array.isArray(queueRes.value)) {
          setLiveQueue(queueRes.value)
          const queueRpcIds = new Set(queueRes.value.map(item => item.rpcId || item.id))
          setEntries(prev => {
            let changed = false
            const next = prev.map(e => {
              if (e.status === 'queued' && e.requestId && !queueRpcIds.has(e.requestId)) {
                changed = true
                const updated = { ...e, status: 'sent', submissionStatus: 'submitted', updatedAt: Date.now() }
                if (services.store?.putEntry) services.store.putEntry(updated).catch(() => {})
                return updated
              }
              return e
            })
            return changed ? next : prev
          })
        }
      } catch {
        // ignore
      }
    }, [sessionId])

    // Load open/unsubmitted findings from other sessions for asset inheritance & triage
    const loadOtherSessions = React.useCallback(async () => {
      try {
        if (!services.store?.listWorkspaces) return
        const wsKeys = await services.store.listWorkspaces()
        // Archived sessions stay in the candidate list on purpose: archiving
        // freezes and hides a Session, but its unsubmitted findings are the
        // only asset still worth rescuing before the session is abandoned.
        const otherSessionKeys = wsKeys.filter(k => k && k.startsWith('session:') && k !== `session:${sessionId}`)
        // The sidebar tab only receives sessionId, so props.useSessions is absent in
        // production. Fall back to the host session registry exposed by factory.
        let titleMap = props.useSessions?.byId
        if (!titleMap || typeof titleMap !== 'object') {
          try {
            titleMap = typeof services.getSessionTitles === 'function' ? services.getSessionTitles() : {}
          } catch {
            titleMap = {}
          }
        }
        // Same reason: workspaceId must be resolved through the plugin services,
        // otherwise inheritance filtering silently degrades to cross-workspace.
        const targetWsId = props.workspaceId
          || props.workspace?.id
          || (typeof services.resolveWorkspaceId === 'function' ? services.resolveWorkspaceId(sessionId) : undefined)
          || (typeof services.getActiveWorkspaceId === 'function' ? services.getActiveWorkspaceId() : undefined)
        const result = []
        for (const key of otherSessionKeys) {
          const sId = key.replace('session:', '')
          const rawEntries = await services.store.listEntries(key)
          const inheritable = filterInheritableFindings(rawEntries, targetWsId, { scope: inheritScope })
          if (inheritable.length > 0) {
            const titleRecord = titleMap?.[sId]
            const title = (typeof titleRecord === 'string' ? titleRecord : titleRecord?.title)
              || t('session.fallbackTitle').replace('{id}', sId.slice(0, 8))
            const sourceWsId = inheritable[0]?.workspaceId || inheritable[0]?.workspaceKey || null
            result.push({
              sessionId: sId,
              workspaceKey: key,
              workspaceId: sourceWsId,
              // Cross-workspace sources are copy-only: moving would delete the
              // finding from a project the user is not looking at.
              crossWorkspace: Boolean(targetWsId && sourceWsId && sourceWsId !== targetWsId),
              title,
              findings: inheritable,
            })
          }
        }
        // Same-workspace sources stay first so the default path is unchanged.
        result.sort((a, b) => Number(a.crossWorkspace) - Number(b.crossWorkspace))
        if (mounted.current) {
          setOtherSessionsData(result)
          if (result.length > 0) {
            setImportSourceSessionId(prev => (prev && result.some(s => s.sessionId === prev)) ? prev : result[0].sessionId)
            const targetSource = (result.find(s => s.sessionId === importSourceSessionId) || result[0])
            setImportSelectedIds(new Set(targetSource.findings.map(f => f.id)))
          } else {
            setImportSourceSessionId(null)
            setImportSelectedIds(new Set())
          }
        }
      } catch {}
    }, [sessionId, props.useSessions, importSourceSessionId, inheritScope])

    // Load open turnAction items from archived sessions for asset inheritance & triage
    const loadArchivedActions = React.useCallback(async () => {
      try {
        if (!services.store?.listWorkspaces) return
        const wsKeys = await services.store.listWorkspaces()
        const otherSessionKeys = wsKeys.filter(k => k && k.startsWith('session:') && k !== `session:${sessionId}`)
        let titleMap = props.useSessions?.byId
        if (!titleMap || typeof titleMap !== 'object') {
          try {
            titleMap = typeof services.getSessionTitles === 'function' ? services.getSessionTitles() : {}
          } catch {
            titleMap = {}
          }
        }
        const targetWsId = props.workspaceId
          || props.workspace?.id
          || (typeof services.resolveWorkspaceId === 'function' ? services.resolveWorkspaceId(sessionId) : undefined)
          || (typeof services.getActiveWorkspaceId === 'function' ? services.getActiveWorkspaceId() : undefined)

        let archivedIds = []
        try {
          if (typeof services.getArchivedSessionIds === 'function') {
            archivedIds = await services.getArchivedSessionIds()
          } else if (Array.isArray(props.archivedSessionIds)) {
            archivedIds = props.archivedSessionIds
          }
        } catch {
          archivedIds = []
        }

        const candidateSessionIds = archivedIds && archivedIds.length > 0
          ? archivedIds.filter(id => id !== sessionId)
          : otherSessionKeys.map(k => k.replace('session:', ''))

        const result = []
        for (const sId of candidateSessionIds) {
          const key = `session:${sId}`
          let turnState = null
          if (typeof services.store?.listTurnActions === 'function') {
            turnState = await services.store.listTurnActions(sId).catch(() => null)
          }
          if (!turnState || !Array.isArray(turnState.items)) continue
          const openItems = turnState.items.filter(item => item && item.status === 'open')
          if (openItems.length === 0) continue

          const rawEntries = await services.store.listEntries(key).catch(() => [])
          const resolvedWsId = typeof services.resolveWorkspaceId === 'function'
            ? services.resolveWorkspaceId(sId)
            : null
          const sourceWsId = resolvedWsId || rawEntries?.[0]?.workspaceId || rawEntries?.[0]?.workspaceKey || null
          const isCrossWorkspace = Boolean(targetWsId && sourceWsId && sourceWsId !== targetWsId)

          if (inheritScope === 'workspace' && targetWsId && sourceWsId && sourceWsId !== targetWsId) {
            continue
          }

          const titleRecord = titleMap?.[sId]
          const title = (typeof titleRecord === 'string' ? titleRecord : titleRecord?.title)
            || t('session.fallbackTitle').replace('{id}', sId.slice(0, 8))

          result.push({
            sessionId: sId,
            workspaceKey: key,
            workspaceId: sourceWsId,
            crossWorkspace: isCrossWorkspace,
            title,
            items: openItems,
          })
        }

        result.sort((a, b) => Number(a.crossWorkspace) - Number(b.crossWorkspace))
        if (mounted.current) {
          setArchivedActionsData(result)
          if (result.length > 0) {
            setImportSourceActionSessionId(prev => (prev && result.some(s => s.sessionId === prev)) ? prev : result[0].sessionId)
            const targetSource = (result.find(s => s.sessionId === importSourceActionSessionId) || result[0])
            setImportSelectedActionIds(new Set(targetSource.items.map(it => it.id || itemOriginKey(it))))
          } else {
            setImportSourceActionSessionId(null)
            setImportSelectedActionIds(new Set())
          }
        }
      } catch {}
    }, [sessionId, props.useSessions, importSourceActionSessionId, inheritScope, props.workspaceId])

    const handleExecuteInherit = async (mode) => {
      if (importing) return
      if (sessionArchived) {
        setImportNotice({ text: t('session.archivedLocked'), error: true })
        return
      }
      const sourceSession = otherSessionsData.find(s => s.sessionId === importSourceSessionId)
      if (!sourceSession) return
      const selectedFindings = sourceSession.findings.filter(f => importSelectedIds.has(f.id))
      if (selectedFindings.length === 0) return
      // Cross-workspace assets are copy-only: a Move would delete the finding
      // from a project the user is not looking at.
      const effectiveMode = sourceSession.crossWorkspace ? 'copy' : mode

      setImporting(true)
      try {
        const { upsertTarget, deleteSource } = inheritFindings({
          findings: selectedFindings,
          targetSessionId: sessionId,
          mode: effectiveMode,
          source: { sessionId: sourceSession.sessionId, workspaceId: sourceSession.workspaceId ?? null },
          existingThoughtNos: entries.map(entry => entry.thoughtNo),
          uuidGenerator: services.uuid,
        })

        // 1. Delete moved findings from source session
        if (deleteSource.length > 0) {
          const sourceWsKey = sourceSession.workspaceKey || `session:${sourceSession.sessionId}`
          for (const item of deleteSource) {
            await services.store.deleteEntry(sourceWsKey, item.id)
          }
        }

        // 2. Put findings into target session
        for (const item of upsertTarget) {
          await services.store.putEntry(item)
        }

        // 3. Show notice, reload, and close
        const noticeText = (effectiveMode === 'copy' ? t('pool.importSuccessCopy') : t('pool.importSuccessMove'))
          .replace('{count}', String(upsertTarget.length))
        setImportNotice({ text: noticeText, error: false })
        await load()
        await loadOtherSessions()
        setTimeout(() => {
          if (mounted.current) {
            setIsImportModalOpen(false)
            setImportNotice(null)
          }
        }, 700)
      } catch (err) {
        if (mounted.current) {
          setImportNotice({ text: err.message || 'Inherit failed', error: true })
        }
      } finally {
        if (mounted.current) {
          setImporting(false)
        }
      }
    }

    const handleInheritActionsConfirm = async () => {
      const currentActionSource = archivedActionsData.find(s => s.sessionId === importSourceActionSessionId) || archivedActionsData[0]
      if (!currentActionSource) return
      const selectedItems = (currentActionSource.items || []).filter(it => importSelectedActionIds.has(it.id || itemOriginKey(it)))
      if (selectedItems.length === 0) return

      const effectiveMode = currentActionSource.crossWorkspace ? 'copy' : (inheritScope === 'workspace' ? 'move' : 'copy')
      setImporting(true)
      try {
        // A linked action may point at a Finding that lives in the archived
        // source session, not in the active session's entries. Load that bucket
        // so the conversion can Fork instead of silently degrading to createEntry.
        const sourceKey = currentActionSource.workspaceKey || `session:${currentActionSource.sessionId}`
        const sourceEntries = typeof services.store?.listEntries === 'function'
          ? await services.store.listEntries(sourceKey).catch(() => [])
          : []
        const parentFindingsMap = new Map([
          ...(Array.isArray(sourceEntries) ? sourceEntries : []).map(e => [e.id, e]),
          ...entries.map(e => [e.id, e]),
        ])
        const { createdFindings, convertedSourceItems } = inheritTurnActions({
          items: selectedItems,
          targetSessionId: sessionId,
          targetWorkspaceKey: workspaceKey,
          targetWorkspaceId: currentWorkspaceId,
          targetSessionTitle: props.sessionTitle || '',
          mode: effectiveMode,
          existingEntries: entries,
          parentFindingsMap,
          idGenerator: services.uuid,
        })

        for (const item of createdFindings) {
          if (services.store?.putEntry) {
            await services.store.putEntry(withForkRoundNote(item))
          }
        }

        if (effectiveMode === 'move' && convertedSourceItems.length > 0) {
          let sourceTurnState = null
          if (services.store?.listTurnActions) {
            sourceTurnState = await services.store.listTurnActions(currentActionSource.sessionId).catch(() => null)
          }
          if (sourceTurnState && Array.isArray(sourceTurnState.items)) {
            const convertedMap = new Map(convertedSourceItems.map(it => [it.id || itemOriginKey(it), it]))
            const nextSourceItems = sourceTurnState.items.map(it => {
              const k = it.id || itemOriginKey(it)
              return convertedMap.has(k) ? convertedMap.get(k) : it
            })
            if (services.store?.putTurnActions) {
              await services.store.putTurnActions(currentActionSource.sessionId, {
                ...sourceTurnState,
                items: nextSourceItems,
              })
            }
          }
        }

        const noticeText = effectiveMode === 'copy'
          ? t('turnActions.inheritSuccessCopy').replace('{count}', String(createdFindings.length))
          : t('turnActions.inheritSuccessMove').replace('{count}', String(createdFindings.length))
        setImportNotice({ text: noticeText, error: false })
        await load()
        await loadArchivedActions()
        setTimeout(() => {
          if (mounted.current) {
            setIsImportModalOpen(false)
            setImportNotice(null)
          }
        }, 700)
      } catch (err) {
        if (mounted.current) {
          setImportNotice({ text: err.message || 'Inherit failed', error: true })
        }
      } finally {
        if (mounted.current) {
          setImporting(false)
        }
      }
    }

    const loadCommitTraces = React.useCallback(async () => {
      if (!sessionId || typeof services.store?.listCommitTraces !== 'function') return
      try {
        const res = services.store.listCommitTraces(workspaceKey)
        if (res && typeof res.then === 'function') {
          const list = await res
          if (mounted.current) setCommitTraces(Array.isArray(list) ? [...list] : [])
        } else if (mounted.current) {
          setCommitTraces(Array.isArray(res) ? [...res] : [])
        }
      } catch {
        // degrade safely
      }
    }, [sessionId, workspaceKey])

    const handleRetryCommitTrace = async (traceId) => {
      if (!traceId || !services.commitTraces?.retryTrace) return
      try {
        const res = await services.commitTraces.retryTrace({ sessionId, traceId })
        await loadCommitTraces()
        if (res?.ok) {
          say(t('finding.commitTrace.retryDone'))
        }
      } catch (err) {
        say(failureText(undefined, err), true)
      }
    }

    React.useEffect(() => {
      mounted.current = true
      load()
      loadCommitTraces()
      refreshQueue()
      loadOtherSessions()
      loadArchivedActions()
      if (typeof services.store?.getPrefs === 'function') {
        services.store.getPrefs()
          .then(raw => {
            if (mounted.current) {
              const p = prefsOf(raw)
              setPanePrefs(p)
              setInheritScope(p.inheritScope)
            }
          })
          .catch(() => {})
      }

      const unsubscribe = typeof services.store.subscribe === 'function'
        ? services.store.subscribe(() => {
            // Host hydration lands after the first render; refresh persisted
            // preferences here so they reflect changes immediately.
            if (typeof services.store?.getPrefs === 'function') {
              services.store.getPrefs()
                .then(raw => {
                  if (mounted.current) {
                    const p = prefsOf(raw)
                    setPanePrefs(p)
                    setInheritScope(p.inheritScope)
                  }
                })
                .catch(() => {})
            }
            load()
            loadCommitTraces()
            loadOtherSessions()
            loadArchivedActions()
          })
        : () => {}

      return () => {
        mounted.current = false
        unsubscribe()
      }
    }, [load, loadCommitTraces, refreshQueue, loadOtherSessions, loadArchivedActions])

    // Draft Deletion Reversion: if a converted item's finding was deleted, revert item to 'open'
    React.useEffect(() => {
      if (!turnActionsState?.items?.length) return
      const findingIds = new Set(entries.map(e => e.id))
      const originKeys = new Set(entries.map(e => e.originKey).filter(Boolean))
      let changed = false
      const updatedItems = turnActionsState.items.map(item => {
        const linkedFindingExists = item.findingId
          ? findingIds.has(item.findingId)
          : (item.originKey ? originKeys.has(item.originKey) : false)
        if (item.status === 'converted' && !linkedFindingExists) {
          changed = true
          return { ...item, status: 'open', findingId: undefined, decidedAt: undefined }
        }
        return item
      })
      if (changed) {
        const nextState = { ...turnActionsState, items: updatedItems }
        setTurnActionsState(nextState)
        if (services.store?.putTurnActions) {
          services.store.putTurnActions(sessionId, nextState).catch(() => {})
        }
      }
    }, [entries, turnActionsState, sessionId])

    // Reconcile finding statuses on log/queue changes
    React.useEffect(() => {
      if (!entries.length || !log.length) return
      const reconciled = reconcileFindingStatuses(entries, log)
      if (reconciled && reconciled.length > 0) {
        const recMap = new Map(reconciled.map(r => [r.id, r]))
        setEntries(prev => prev.map(e => recMap.get(e.id) || e))
        for (const item of reconciled) {
          services.store.putEntry(item).catch(() => {})
        }
      }
    }, [entries, log])

    // Sync prompt log index
    React.useEffect(() => {
      if (!sessionId || !services.index) return
      let active = true
      const gen = ++logGeneration.current

      const refresh = async () => {
        try {
          const recent = await services.index.listRecent({ workspaceKey, sessionId, limit: 100 })
          if (active && gen === logGeneration.current) {
            setLog(recent || [])
          }
        } catch {
          // ignore
        }
      }

      refresh()
      services.index.start?.({ sessionId, workspaceKey, onLog: refresh })

      return () => {
        active = false
        services.index.stop?.(sessionId)
      }
    }, [sessionId, workspaceKey])

    // Periodically refresh queue while queued items exist to track completion
    React.useEffect(() => {
      const hasQueued = entries.some(e => e.status === 'queued')
      if (!hasQueued) return
      const timer = setInterval(() => {
        refreshQueue()
      }, 2500)
      // A queued row can outlive the mount for a long time; do not let the poll
      // alone keep a headless runtime (tests, SSR smoke) alive. No-op in browsers.
      if (typeof timer?.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, [entries, refreshQueue])

    // Distillation maintenance window (spec §10.4): poll this workspace's runs
    // and derive the lock locally so the ready TTL unlocks on time. The first
    // fetch doubles as refresh recovery (a non-terminal run survives reloads).
    // Fail-open: any network/shape failure keeps the last known state and never
    // fabricates a lock. Cleanup aborts the in-flight read and stops the timer.
    React.useEffect(() => {
      if (!distillWorkspaceId || typeof fetch !== 'function') return
      let active = true
      const controller = new AbortController()
      const refreshDistillLock = async () => {
        try {
          const res = await fetch(`api/punch-desk/distill-run?workspaceId=${encodeURIComponent(distillWorkspaceId)}`, { signal: controller.signal })
          if (!res.ok) return
          const data = await res.json()
          if (!active || !data || data.ok !== true || !Array.isArray(data.runs)) return
          setDistillLock(deriveDistillLockState(data.runs, distillWorkspaceId, Date.now()))
        } catch {
          // Abort/network failure: keep the last known state (fail-open).
        }
      }
      const first = refreshDistillLock()
      const timer = setInterval(refreshDistillLock, DISTILL_LOCK_POLL_MS)
      // Test harnesses without real timers never unmount; a pending first fetch
      // would otherwise keep the event loop alive. unref is a no-op in browsers.
      const unref = typeof timer.unref === 'function' ? () => timer.unref() : () => {}
      unref()
      return () => {
        active = false
        clearInterval(timer)
        controller.abort()
        return first
      }
    }, [distillWorkspaceId])

    // Track capture payload if active (including text quotes and assistant message anchors)
    React.useEffect(() => {
      if (sessionId !== captureSession.current) {
        captureSession.current = sessionId
        setAnchors([])
      }

      const handlePending = (targetSid) => {
        if (!targetSid || targetSid !== sessionId) return
        if (typeof services.takePendingCapture === 'function') {
          const cap = services.takePendingCapture(sessionId)
          if (!cap) return
          if (cap.kind === 'quote' && cap.text) {
            const rawQuote = String(cap.text).trim()
            const quoteBlock = rawQuote.split('\n').map(l => `> ${l}`).join('\n')
            setText(prev => (prev ? `${prev.trim()}\n\n${quoteBlock}\n\n` : `${quoteBlock}\n\n`))
            setAnchors([{
              type: 'quote',
              turn: cap.turn ?? currentTurn,
              messageId: cap.messageId,
              text: rawQuote.length > 80 ? `${rawQuote.slice(0, 80)}...` : rawQuote,
            }])
            setTimeout(() => {
              if (textareaRef.current) {
                textareaRef.current.focus()
                const len = textareaRef.current.value.length
                textareaRef.current.setSelectionRange(len, len)
              }
            }, 60)
          } else if (cap.anchor) {
            setAnchors([cap.anchor])
          } else if (cap.kind === 'message' && cap.messageId) {
            setAnchors([{
              type: 'message',
              messageId: cap.messageId,
              turn: cap.turn ?? currentTurn,
            }])
          }
        }
      }

      handlePending(sessionId)
      if (typeof services.subscribePendingCapture === 'function') {
        return services.subscribePendingCapture(handlePending)
      }
    }, [sessionId, currentTurn])

    // Consume pending commit-attribution focus from Desk Git Lookup so the
    // matched finding, its parent group (including archived groups), and its
    // commit trace block automatically expand and scroll into view.
    React.useEffect(() => {
      const consumeFocus = (targetSid) => {
        if (!targetSid || targetSid !== sessionId) return
        const takeFn = typeof services.takePendingCommitFocus === 'function'
          ? services.takePendingCommitFocus
          : takePendingCommitFocus
        const payload = takeFn(sessionId)
        if (!payload) return
        setHighlightedCommitFocus(payload)
      }
      consumeFocus(sessionId)
      const subFn = typeof services.subscribePendingCommitFocus === 'function'
        ? services.subscribePendingCommitFocus
        : subscribePendingCommitFocus
      return subFn(consumeFocus)
    }, [sessionId, services])

    React.useEffect(() => {
      if (!highlightedCommitFocus) return
      const targetFindingIds = Array.isArray(highlightedCommitFocus.findingIds)
        ? highlightedCommitFocus.findingIds.filter(Boolean)
        : []
      if (targetFindingIds.length === 0 && entries.length === 0) return

      setShowArchivedSection(true)
      setExpandedSet(prev => {
        const next = new Set(prev)
        for (const fid of targetFindingIds) {
          next.add(fid)
          const f = entries.find(e => e.id === fid)
          if (f?.assignedGroupId) {
            next.add(`group-${f.assignedGroupId}`)
            next.add(`archived-${f.assignedGroupId}`)
          }
        }
        for (const grp of groups) {
          const itemIds = Array.isArray(grp?.items) ? grp.items.map(it => it.findingId) : []
          if (targetFindingIds.some(fid => itemIds.includes(fid))) {
            next.add(`group-${grp.id}`)
            next.add(`archived-${grp.id}`)
          }
        }
        return next
      })
      setGitExpandedMap(prev => {
        const next = new Map(prev)
        for (const fid of targetFindingIds) {
          next.set(fid, true)
          const f = entries.find(e => e.id === fid)
          if (f?.assignedGroupId) {
            next.set(`group-git-${f.assignedGroupId}`, true)
          }
        }
        return next
      })

      if (typeof document !== 'undefined' && targetFindingIds.length > 0) {
        const firstId = targetFindingIds[0]
        setTimeout(() => {
          try {
            const root = paneRef.current
            if (!root || typeof root.querySelectorAll !== 'function') return
            const targetHash = highlightedCommitFocus.commitHash || ''
            const commitRows = Array.from(root.querySelectorAll('[data-commit-hash]'))
              .filter(node => node?.dataset?.commitHash === targetHash)
            const matchingFindingIds = new Set(targetFindingIds)
            const commitRow = commitRows.find(node =>
              matchingFindingIds.has(node?.closest?.('[data-finding-id]')?.dataset?.findingId)
            ) || commitRows[0]
            const el = commitRow || Array.from(root.querySelectorAll('[data-finding-id]'))
              .find(node => node?.dataset?.findingId === firstId)
            el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
          } catch {}
        }, 60)
      }
    }, [highlightedCommitFocus, entries, groups, commitTraces])

    const say = (msg, error = false, tip = undefined) => {
      setNotice({ text: msg, error, ...(tip ? { tip } : {}) })
      setTimeout(() => setNotice(null), 3500)
    }

    /**
     * Fold the acceptance evidence returned by the submit service into the pane's
     * entry state (B9 / T-GTA-24).
     *
     * The factory already persisted `acceptedAt` + `submissionSeq`; mirroring them
     * into state keeps a later whole-entry write (status reconciliation, queue
     * repair, review) from dropping the pair on the floor. A pending evidence
     * write is deliberately skipped: latest moves only after it is durable.
     *
     * @param {{ acceptedAt?: number, submissionSeq?: number, evidencePending?: true, requests?: object[] }} result
     * @param {object[]} [batch]
     */
    const applyAcceptedEvidence = (result, batch) => {
      if (!result || result.evidencePending === true) return
      const stamps = new Map()
      if (result.acceptedAt !== undefined && result.submissionSeq !== undefined) {
        for (const entry of Array.isArray(batch) ? batch : []) {
          if (entry && typeof entry.id === 'string') {
            stamps.set(entry.id, { acceptedAt: result.acceptedAt, submissionSeq: result.submissionSeq })
          }
        }
      }
      for (const request of Array.isArray(result.requests) ? result.requests : []) {
        if (!request || typeof request.entryId !== 'string') continue
        if (request.acceptedAt === undefined || request.submissionSeq === undefined) continue
        stamps.set(request.entryId, { acceptedAt: request.acceptedAt, submissionSeq: request.submissionSeq })
      }
      if (stamps.size === 0) return
      setEntries(prev => prev.map(entry => (
        stamps.has(entry.id) ? { ...entry, ...stamps.get(entry.id) } : entry
      )))
    }

    /**
     * Handle `evidencePending` on an otherwise accepted submission
     * (Group Turn Attribution T-GTA-26 / B9).
     *
     * The prompt already left the client, so this is NOT a send failure: the
     * finding keeps `submissionStatus:'submitted'` and its original
     * `requestId`, no `retryPending` is written, and `prompt()` is never called
     * again. Only the acceptance-evidence write is retried (same requestId and
     * reserved sequence); the PromptLog fallback covers a reload in between.
     */
    const settleEvidencePending = async () => {
      // Information-only notice: the prompt is accepted and never resent, so this
      // must never look like a submit failure.
      say(t('group.evidencePending'), false, t('group.evidencePendingTip'))
      if (typeof services.retrySubmissionEvidence !== 'function') return
      try {
        await services.retrySubmissionEvidence(sessionId)
        await load()
        say(t('group.evidenceRecovered'))
      } catch {
        // Still pending (store unavailable): keep the pending notice. This is not
        // a send failure, so it must never be rendered as an error.
        say(t('group.evidencePending'), false, t('group.evidencePendingTip'))
      }
    }

    // Explicit cancel exit of the maintenance window bar (spec §10.4/§10.5).
    // The Host arbitrates (active RunControl CAS or persisted-state cancel);
    // the pane only projects the answer. The next poll refreshes the window.
    const handleCancelDistill = async () => {
      const run = distillLock.run
      if (!run || distillCancelBusy || typeof fetch !== 'function') return
      setDistillCancelBusy(true)
      try {
        const res = await fetch('api/punch-desk/distill-cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: run.id }),
        })
        const data = res.ok ? await res.json() : null
        if (data && data.ok === true) {
          if (data.status === 'canceled') say(t('distill.lock.canceled'))
          else if (data.status === 'too_late') say(t('distill.lock.tooLate'), true)
          else say(t('distill.lock.cancelRequested'))
        } else {
          say(t('distill.lock.cancelFailed'), true)
        }
      } catch {
        say(t('distill.lock.cancelFailed'), true)
      } finally {
        setDistillCancelBusy(false)
      }
    }

    const toggle = id => {
      setSelected(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const toggleExpand = id => {
      // Group headers (`group-*` / `archived-*`) are force-expanded while the
      // global expand-all toggle is on (`|| isAllExpanded`). Clicking one of them
      // must collapse only that group, so materialise the implicit state into an
      // explicit set first: every group stays expanded except the clicked one.
      const groupScoped = typeof id === 'string' && (id.startsWith('group-') || id.startsWith('archived-'))
      if (isAllExpanded && groupScoped) {
        const materialized = new Set(expandedSet)
        groups.forEach(group => {
          materialized.add(`group-${group.id}`)
          materialized.add(`archived-${group.id}`)
        })
        materialized.delete(id)
        setIsAllExpanded(false)
        setExpandedSet(materialized)
        return
      }
      setExpandedSet(prev => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    }

    const toggleAllExpand = () => {
      const nextExpanded = !isAllExpanded
      setIsAllExpanded(nextExpanded)
      if (nextExpanded) {
        const all = new Set(entries.map(e => e.id))
        groups.forEach(group => {
          all.add(`group-${group.id}`)
          all.add(`archived-${group.id}`)
        })
        setExpandedSet(all)
      } else {
        setExpandedSet(new Set())
      }
    }

    const track = async ({ requestId, batchId }) => {
      if (!services.index?.track) return
      try {
        await services.index.track({ sessionId, workspaceKey, requestId, batchId })
      } catch {
        // tracking is best-effort
      }
    }

    // ----------------------------------------------------
    // Actions: Capture / Add Finding
    // ----------------------------------------------------
    const capture = async (newText, newTag) => {
      const trimmed = (newText || '').trim()
      if (!trimmed) {
        setCaptureError(t('capture.error'))
        return
      }

      const nextNo = nextThoughtNo(entries)

      const finding = services.createFinding({
        sessionId,
        thoughtNo: nextNo,
        workspaceKey,
        workspaceId: currentWorkspaceId,
        text: trimmed,
        // Tag is the single classification field; `severity` stays legacy-only.
        tag: newTag || selectedTag || 'optimize',
        anchors: anchors.length > 0 ? anchors : undefined,
        submissionStatus: 'unsubmitted',
        status: 'open',
      })
      finding.thoughtNo = nextNo

      try {
        await services.store.putEntry(finding)
        maybeArmNeon(trimmed)
        setText('')
        setAnchors([])
        setCaptureError('')
        setEditingFindingId(null)
        setEntries(prev => upsertEntryState(prev, finding))
        await load()
        if (textareaRef.current) textareaRef.current.focus()
      } catch {
        setCaptureError(t('store.error'))
      }
    }

    const handleSaveComposer = async () => {
      const trimmed = text.trim()
      if (!trimmed) return

      if (editingFindingId) {
        const existing = findingsMap.get(editingFindingId)
        if (existing) {
          const updated = {
            ...existing,
            text: trimmed,
            body: trimmed,
            title: trimmed.split('\n')[0].slice(0, 80),
            tag: selectedTag || existing.tag || 'optimize',
            updatedAt: Date.now(),
          }
          await services.store.putEntry(updated)
          maybeArmNeon(trimmed)
          setEntries(prev => prev.map(e => e.id === existing.id ? updated : e))
          say(t('desk.draft.saved'))
        }
        setEditingFindingId(null)
        setText('')
        return
      }

      await capture(trimmed, selectedTag)
    }

    const cancelEditingCard = () => {
      setEditingFindingId(null)
      setText('')
      setPopover(null)
    }

    // ----------------------------------------------------
    // Autocomplete Popover Engine for /, @ and $ in Composer
    // ----------------------------------------------------
    const checkPopover = React.useCallback(async (val, cursor) => {
      if (typeof cursor !== 'number' || cursor < 0) {
        setPopover(null)
        return
      }
      const before = val.slice(0, cursor)

      // Find trigger symbols preceding cursor
      const lastAt = before.lastIndexOf('@')
      const lastSlash = before.lastIndexOf('/')
      const lastDollar = before.lastIndexOf('$')

      // Identify the closest valid trigger before cursor
      let activeTrigger = null
      let triggerIndex = -1

      const candidates = [
        { type: '@', idx: lastAt },
        { type: '/', idx: lastSlash },
        { type: '$', idx: lastDollar },
      ].filter(c => c.idx !== -1).sort((a, b) => b.idx - a.idx)

      for (const cand of candidates) {
        const charBefore = cand.idx > 0 ? before[cand.idx - 1] : '\n'
        const isLeading = charBefore === ' ' || charBefore === '\n' || charBefore === '\t' || charBefore === '(' || charBefore === '['
        const textAfter = before.slice(cand.idx + 1)
        if (isLeading && !/\s/.test(textAfter)) {
          activeTrigger = cand.type
          triggerIndex = cand.idx
          break
        }
      }

      if (!activeTrigger || triggerIndex === -1) {
        setPopover(null)
        return
      }

      const query = before.slice(triggerIndex + 1).toLowerCase()

      // 1. Check slash command & skill trigger (/)
      if (activeTrigger === '/') {
        const cmdPool = commandsList.length > 0 ? commandsList : resolveCatalog(DEFAULT_SLASH_COMMANDS, t)
        const skillPool = skillsList.length > 0 ? skillsList : resolveCatalog(DEFAULT_SKILLS, t)

        const matchedCommands = cmdPool.filter(cmd => {
          const name = (cmd.name || '').toLowerCase()
          const label = (cmd.label || '').toLowerCase()
          const desc = (cmd.description || cmd.desc || '').toLowerCase()
          return !query || name.includes(query) || label.includes(query) || desc.includes(query)
        }).map(cmd => ({
          key: `cmd-${cmd.name}`,
          group: 'commands',
          name: cmd.name,
          label: cmd.label || `/${cmd.name}`,
          desc: cmd.description || cmd.desc || '',
          insert: cmd.insert || `/${cmd.name} `,
        }))

        const matchedSkills = skillPool.filter(skill => {
          const name = (skill.name || '').toLowerCase()
          const label = (skill.label || '').toLowerCase()
          const desc = (skill.description || skill.desc || '').toLowerCase()
          return !query || name.includes(query) || label.includes(query) || desc.includes(query)
        }).map(skill => ({
          key: `skill-${skill.name}`,
          group: 'skills',
          name: skill.name,
          label: skill.label || `/${skill.name}`,
          desc: skill.description || skill.desc || '',
          insert: skill.insert || `/${skill.name} `,
        }))

        const allMatched = [...matchedCommands, ...matchedSkills]
        if (allMatched.length > 0) {
          setPopover({
            type: '/',
            start: triggerIndex,
            end: cursor,
            items: allMatched,
            activeIndex: 0,
          })
          return
        }
      }

      // 2. Check direct dollar skill trigger ($)
      if (activeTrigger === '$') {
        const skillPool = skillsList.length > 0 ? skillsList : resolveCatalog(DEFAULT_SKILLS, t)
        const matchedSkills = skillPool.filter(skill => {
          const name = (skill.name || '').toLowerCase()
          const label = (skill.label || '').toLowerCase()
          const desc = (skill.description || skill.desc || '').toLowerCase()
          return !query || name.includes(query) || label.includes(query) || desc.includes(query)
        }).map(skill => ({
          key: `skill-${skill.name}`,
          group: 'skills',
          name: skill.name,
          label: `/${skill.name}`,
          desc: skill.description || skill.desc || '',
          insert: `/${skill.name} `,
        }))

        if (matchedSkills.length > 0) {
          setPopover({
            type: '$',
            start: triggerIndex,
            end: cursor,
            items: matchedSkills,
            activeIndex: 0,
          })
          return
        }
      }

      // 3. Check @ context mention trigger (@)
      if (activeTrigger === '@') {
        let files = (referencesCache.files && referencesCache.files.length > 0)
          ? referencesCache.files
          : resolveCatalog(DEFAULT_WORKSPACE_FILES, t)
        let sessions = referencesCache.sessions || []

        if (typeof services.listFilesAndSessions === 'function' && query) {
          try {
            const dyn = await services.listFilesAndSessions(sessionId, query)
            if (dyn?.files?.length > 0) files = dyn.files
            if (dyn?.sessions?.length > 0) sessions = dyn.sessions
          } catch {}
        }

        const matchedFiles = files.filter(f => {
          const name = (f.name || '').toLowerCase()
          const path = (f.path || '').toLowerCase()
          const desc = (f.description || '').toLowerCase()
          return !query || name.includes(query) || path.includes(query) || desc.includes(query)
        }).slice(0, 80).map(f => {
          const displayPath = f.path || f.name || ''
          return {
            key: `file-${displayPath}`,
            group: 'files',
            name: f.name || displayPath,
            label: `@${displayPath}`,
            desc: f.kind === 'directory'
              ? t('mention.kindDirectory')
              : (displayPath.includes('/') ? displayPath : (f.description || t('mention.kindFile'))),
            insert: f.insert || `@${displayPath} `,
            kind: f.kind || 'file',
          }
        })

        const matchedSessions = sessions.filter(s => {
          const title = (s.title || s.name || '').toLowerCase()
          const sid = (s.id || s.sessionId || '').toLowerCase()
          return !query || title.includes(query) || sid.includes(query)
        }).map(s => {
          const sid = s.id || s.sessionId || ''
          const name = s.title || s.name
            || (sid ? t('session.fallbackTitle').replace('{id}', sid.slice(0, 8)) : t('session.fallbackName'))
          const shortId = sid ? sid.slice(0, 6) : ''
          return {
            key: `session-${sid || Math.random()}`,
            group: 'sessions',
            name,
            label: `@[${name}]`,
            desc: s.description || (shortId ? t('mention.sessionHint').replace('{id}', shortId) : t('session.fallbackName')),
            insert: `@[${name}] `,
          }
        })

        const allMatched = [...matchedFiles, ...matchedSessions]
        if (allMatched.length > 0) {
          setPopover({
            type: '@',
            start: triggerIndex,
            end: cursor,
            items: allMatched,
            activeIndex: 0,
          })
          return
        }
      }

      setPopover(null)
    }, [commandsList, skillsList, referencesCache, sessionId, services])

    const applyPopoverItem = React.useCallback((item) => {
      if (!popover) return
      const before = text.slice(0, popover.start)
      const after = text.slice(popover.end)
      const replacement = item.insert || `${item.label} `

      const nextText = before + replacement + after
      setText(nextText)
      setPopover(null)

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.focus()
          const newCursor = before.length + replacement.length
          textareaRef.current.setSelectionRange(newCursor, newCursor)
        }
      }, 30)
    }, [popover, text])

    const handleTextareaKeyDown = (e) => {
      if (!popover || !popover.items || popover.items.length === 0) return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setPopover(prev => (prev ? {
          ...prev,
          activeIndex: (prev.activeIndex + 1) % prev.items.length,
        } : null))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setPopover(prev => (prev ? {
          ...prev,
          activeIndex: (prev.activeIndex - 1 + prev.items.length) % prev.items.length,
        } : null))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const selectedItem = popover.items[popover.activeIndex]
        if (selectedItem) {
          applyPopoverItem(selectedItem)
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setPopover(null)
      }
    }

    const renderPopover = () => {
      if (!popover || !popover.items || popover.items.length === 0) return null
      const isSlash = popover.type === '/' || popover.type === '$'
      const title = isSlash ? t('popover.slashTitle') : t('popover.mentionTitle')

      return h('div', {
        id: 'composerAutocompletePopover',
        style: {
          position: 'absolute',
          top: 'calc(100% + 4px)',
          bottom: 'auto',
          left: 12,
          right: 12,
          zIndex: 1000,
          background: 'var(--pd-bg-floating, var(--dsw-alias-bg-floating, #ffffff))',
          border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l2, #d8dee9))',
          borderRadius: 8,
          boxShadow: 'var(--dsw-elevation-panel, 0 12px 32px rgba(0,0,0,0.25))',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          animation: 'fadeIn 0.15s ease',
        },
      },
        // Header
        h('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '6px 10px',
            background: 'var(--pd-bg-panel, var(--dsw-alias-fill-l1, #e5e9f0))',
            borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0,0,0,0.06)))',
            fontSize: 10,
            color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
          },
        },
          h('span', { style: { fontWeight: 600, color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' } }, title),
          h('span', { style: { fontSize: 9, opacity: 0.7 } }, t('popover.hint'))),

        // List
        h('div', {
          style: {
            maxHeight: 240,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            padding: '4px',
            gap: 2,
          },
        },
          (() => {
            let lastGroup = null
            const elements = []
            popover.items.forEach((item, idx) => {
              if (item.group && item.group !== lastGroup) {
                lastGroup = item.group
                const groupTitle = item.group === 'commands'
                  ? t('popover.commandsGroup')
                  : (item.group === 'skills'
                      ? t('popover.skillsGroup')
                      : (item.group === 'files'
                          ? t('popover.filesGroup')
                          : t('popover.sessionsGroup')))
                elements.push(
                  h('div', {
                    key: `grp-hdr-${item.group}`,
                    style: {
                      padding: '6px 8px 2px 8px',
                      fontSize: 10,
                      fontWeight: 600,
                      color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                      letterSpacing: '0.5px',
                    },
                  }, groupTitle)
                )
              }

              const isSelected = idx === popover.activeIndex
              const itemIcon = item.group === 'commands'
                ? h(Play, { size: 12, color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' })
                : (item.group === 'skills'
                    ? h(Brain, { size: 12, color: 'var(--dsw-alias-state-business-primary, #b48ead)' })
                    : (item.group === 'files'
                        ? h(Folder, { size: 12, color: 'var(--dsw-alias-state-business-primary, #81a1c1)' })
                        : h(ChatTeardropText, { size: 12, color: 'var(--dsw-alias-state-success-primary, #a3be8c)' })))

              elements.push(
                h('div', {
                  key: item.key,
                  onMouseEnter: () => setPopover(prev => (prev ? { ...prev, activeIndex: idx } : null)),
                  onClick: () => applyPopoverItem(item),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '6px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: isSelected ? 'var(--pd-popover-item-hover, var(--dsw-alias-bg-layer-2, #d8dee9))' : 'transparent',
                    borderLeft: `3px solid ${isSelected ? 'var(--pd-popover-item-active-fg, var(--dsw-alias-button-primary-fill, #5e81ac))' : 'transparent'}`,
                    transition: 'background 0.1s ease',
                  },
                },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, overflow: 'hidden' } },
                    itemIcon,
                    h('span', {
                      style: {
                        fontWeight: 600,
                        fontSize: 11,
                        fontFamily: 'monospace',
                        color: isSelected ? 'var(--pd-popover-item-active-fg, var(--dsw-alias-button-primary-fill, #5e81ac))' : 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                        whiteSpace: 'nowrap',
                      },
                    }, item.label),
                    h('span', {
                      style: {
                        fontSize: 10,
                        color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                        opacity: 0.85,
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                        overflow: 'hidden',
                      },
                    }, item.desc)
                  ),
                  isSelected ? h('span', {
                    style: {
                      fontSize: 9,
                      padding: '1px 4px',
                      borderRadius: 4,
                      background: 'var(--pd-bg-panel, var(--dsw-alias-fill-l3, #d8dee9))',
                      color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                      fontFamily: 'monospace',
                      flexShrink: 0,
                    },
                  }, '↵') : null
                )
              )
            })
            return elements
          })()
        )
      )
    }

    const loadIntoComposer = (finding) => {
      setEditingFindingId(finding.id)
      setText(finding.text || finding.body || '')
      setSelectedTag(finding.tag || finding.severity || 'optimize')
      if (textareaRef.current) {
        textareaRef.current.focus()
      }
    }

    const deleteFinding = async (findingId) => {
      const entry = findingsMap.get(findingId)
      const wsKey = entry?.workspaceKey || workspaceKey
      if (services.store?.deleteEntry) {
        await services.store.deleteEntry(wsKey, findingId)
      } else {
        if (entry) {
          await services.store.putEntry({ ...entry, status: 'dismissed', reviewStatus: 'dismissed', updatedAt: Date.now() })
        }
      }
      setEntries(prev => prev.filter(e => e.id !== findingId))
      setSelected(prev => {
        const next = new Set(prev)
        next.delete(findingId)
        return next
      })
      if (editingFindingId === findingId) {
        setEditingFindingId(null)
        setText('')
      }
      await load()
    }

    // ----------------------------------------------------
    // Actions: Active Groups
    // ----------------------------------------------------
    const activeGroups = groups.filter(g => g.status !== 'archived')
    const canCreate = activeGroups.length < 3 && canCreateGroup(groups, findingsMap, harnessProjectionsMap)

    const handleCreateGroup = () => {
      if (!canCreate || busy) {
        if (activeGroups.length >= 3) {
          say(t('group.maxReached'), true)
        }
        return
      }
      setSelectedTargetGroupId('new')
    }

    const handleTogglePinGroup = async (groupId) => {
      const group = groups.find(g => g.id === groupId)
      if (!group) return
      const updated = { ...group, pinned: !group.pinned }
      // The store rejects a group whose items no longer resolve to findings of
      // this session (B6 / Phase 4): keep the toggle honest instead of showing
      // a state that never landed.
      try {
        if (services.store?.putGroup) await services.store.putGroup(updated)
      } catch {
        say(t('store.error'), true)
        return
      }
      setGroups(prev => prev.map(g => (g.id === groupId ? updated : g)))
    }

    const handleOpenClearModal = () => {
      setClearNotice(null)
      setIsClearModalOpen(true)
    }

    const handleExecuteClear = async () => {
      const { clearFindings, clearGroups, clearPromptLogs, clearDrafts, preservePinned } = clearOptions
      if (!clearFindings && !clearGroups && !clearPromptLogs && !clearDrafts) {
        setClearNotice({ error: true, text: t('clear.noneSelected') })
        return
      }

      setClearing(true)
      setClearNotice(null)

      try {
        if (services.store?.clearWorkspaceData) {
          await services.store.clearWorkspaceData(currentWorkspaceId, {
            preservePinned,
            sessionId,
            sessionIds: [sessionId],
            clearFindings,
            clearGroups,
            clearPromptLogs,
            clearDrafts,
          })
        } else if (services.store?.clearCache) {
          await services.store.clearCache()
        }

        if (clearFindings) {
          setSelected(new Set())
          setEditingFindingId(null)
          setText('')
          setEntries(prev => prev.filter(e => {
            const g = groups.find(grp => grp.id === e.assignedGroupId)
            return preservePinned && Boolean(g?.pinned)
          }))
        }
        if (clearGroups) {
          setGroups(prev => preservePinned ? prev.filter(g => Boolean(g.pinned)) : [])
        }

        await load()
        setIsClearModalOpen(false)
        say(t('clear.success'))
      } catch (err) {
        setClearNotice({ error: true, text: err?.message || t('clear.failed') })
      } finally {
        setClearing(false)
      }
    }

    // Shared clear-data dialog (P1-8 dedupe): one renderer for Desk + Session Pane.
    const clearModal = createClearDataModal({ h, t, Button, Trash, X })

    const handleDropFindingToGroup = async (findingId, groupId) => {
      // Drag-to-group is a submission (零阻力拖拽即提交): the distillation
      // maintenance window pauses it exactly like the dock buttons.
      if (distillLock.locked) {
        say(t('distill.lock.submitPausedTip'), true)
        return
      }
      const finding = findingsMap.get(findingId)
      const group = groups.find(g => g.id === groupId)
      if (!finding || !group) return

      const updatedGroup = addItemToGroup(group, findingId)

      const assigned = {
        ...finding,
        assignedGroupId: groupId,
        submissionStatus: 'submitted',
        status: 'queued',
        requestId: services.uuid(),
        batchId: groupId,
        submittedAt: finding.submittedAt || Date.now(),
        updatedAt: Date.now(),
      }

      // B6 / plan Phase 4: the group may only name findings that are already
      // persisted in this session, so the assignment lands first and the group
      // upsert follows. A rejected group write rolls the finding back to its
      // pre-drag shape instead of leaving an orphan assignment behind.
      try {
        await services.store.putEntry(assigned)
        if (services.store?.putGroup) await services.store.putGroup(updatedGroup)
      } catch {
        try {
          await services.store.putEntry(finding)
        } catch {}
        say(t('store.error'), true)
        return
      }
      setGroups(prev => prev.map(g => g.id === groupId ? updatedGroup : g))
      setSelectedTargetGroupId(groupId)

      // A submission failure is an infrastructure error (DSH unreachable), not a
      // reason to roll the submission fact back: keep the finding in the group
      // as queued and surface the error so the user can retry with the same
      // requestId.
      const annotateFailure = async (payload) => {
        await services.store.putEntry({
          ...assigned,
          lastSubmitError: payload?.error?.message ?? payload?.message ?? 'submit-failed',
          retryPending: true,
          reconciliationPending: false,
          updatedAt: Date.now(),
        })
      }

      try {
        const res = await services.submit.submitCombined(sessionId, [assigned], assigned.requestId, undefined, promptOptionsFor())
        if (res?.ok) {
          await track({ requestId: assigned.requestId, batchId: groupId })
          // Keep the persisted acceptedAt/submissionSeq in pane state so a later
          // whole-entry write cannot drop the attribution evidence.
          applyAcceptedEvidence(res, [assigned])
          // Accepted but the evidence write failed: keep the submission fact, do
          // not mark it failed and never resend the prompt.
          if (res.evidencePending) await settleEvidencePending()
        } else {
          await annotateFailure(res)
          say(failureText(res), true)
        }
      } catch (err) {
        await annotateFailure({ error: err })
        say(failureText(undefined, err), true)
      }
    }

    // ----------------------------------------------------
    // Actions: In-place edit of a still-queued prompt (no retraction: the queue
    // belongs to the Harness and submissions are never withdrawn)
    // ----------------------------------------------------
    const handleSaveEditQueued = async (finding, newPromptText) => {
      const trimmed = (newPromptText || '').trim()
      if (!trimmed || busy || !finding.requestId) return
      setBusy(true)
      try {
        const res = await (services.submit.editQueued
          ? services.submit.editQueued(sessionId, finding.requestId, trimmed)
          : { ok: false, reason: 'unsupported' })

        if (res?.ok) {
          if (res.method === 'edit') {
            const updated = {
              ...finding,
              text: trimmed,
              body: trimmed,
              title: trimmed.split('\n')[0].slice(0, 80),
              updatedAt: Date.now(),
            }
            await services.store.putEntry(updated)
          }
          setEditingFindingId(null)
          setEditingText('')
          await refreshQueue()
        } else {
          say(t('finding.cannotEditRunning'), true)
          setEditingFindingId(null)
        }
      } catch {
        say(t('finding.cannotEditRunning'), true)
        setEditingFindingId(null)
      } finally {
        setBusy(false)
      }
    }

    const handleArchiveGroup = async (groupId) => {
      const grp = groups.find(g => g.id === groupId)
      if (!grp) return

      // Wrap-up is the human confirmation that ends the batch. It only settles
      // static rows: queued/running rows must finish first (same rule as the row
      // level resolve/dismiss), and unsettled submissions block it.
      const groupItemIds = new Set((grp.items || []).map(item => item.findingId))
      const groupFindings = entries.filter(e => e.assignedGroupId === groupId || groupItemIds.has(e.id))
      const findingsMap = new Map(groupFindings.map(f => [f.id, f]))
      const wrapGroup = {
        ...grp,
        items: groupFindings.map((f, index) => ({ findingId: f.id, order: index + 1 })),
      }
      const plan = planGroupWrapUp(
        wrapGroup,
        findingsMap,
        (findingId, finding) => deriveHarnessProjection(finding ?? findingsMap.get(findingId), log, liveQueue),
      )

      if (plan.queuedIds.length > 0) {
        say(countText(t('group.wrapUpBlockedQueued'), plan.queuedIds.length), true)
        return
      }
      if (plan.runningIds.length > 0) {
        say(countText(t('group.wrapUpBlockedRunning'), plan.runningIds.length), true)
        return
      }
      if (plan.unsettledIds.length > 0) {
        say(countText(t('group.wrapUpBlockedUnsettled'), plan.unsettledIds.length), true)
        return
      }

      const now = Date.now()
      const settled = plan.settleIds
        .map(id => findingsMap.get(id))
        .filter(f => f && !isIgnoredFinding(f) && f.reviewStatus !== 'resolved')
        .map(f => ({
          ...f,
          submissionStatus: 'submitted',
          reviewStatus: 'resolved',
          status: 'resolved',
          resolvedAt: now,
          updatedAt: now,
          completedVia: 'group-wrap-up',
        }))
      if (settled.length > 0) {
        // putEntries replaces the whole workspace list, so persist item by item.
        if (services.store?.putEntry) {
          for (const finding of settled) await services.store.putEntry(finding)
        }
        setEntries(prev => {
          const byId = new Map(settled.map(item => [item.id, item]))
          return prev.map(item => byId.get(item.id) || item)
        })
      }

      // B2 / plan §6: freeze the *window snapshot* in the SAME putGroup upsert
      // that writes status:'archived'. A second write could interleave with a
      // later render and leave the group archived without its frozen numbers.
      const archivedTurn = currentTurn
      const groupStats = deriveGroupTurnStats(grp, {
        groups,
        findings: entries,
        promptLogs: log,
        traces: commitTraces,
        currentTurn,
      })
      const frozenGroup = freezeGroupTurnStats(grp, groupStats, archivedTurn)
      const updated = {
        ...(frozenGroup ?? grp),
        status: 'archived',
        archivedAt: now,
      }
      // The store re-validates every item against the session's findings index
      // (B6 / Phase 4) and refuses a group that names a deleted finding. Fail
      // loudly instead of pretending the batch was closed.
      try {
        if (services.store?.putGroup) await services.store.putGroup(updated)
      } catch {
        say(t('store.error'), true)
        return
      }
      setGroups(prev => prev.map(g => g.id === groupId ? updated : g))
      say(settled.length > 0
        ? t('group.wrapUpDone').replace('{number}', String(grp.groupNumber))
        : t('group.wrapUpDoneIgnored').replace('{number}', String(grp.groupNumber)))
    }

    const handleCompleteFinding = async (finding) => {
      let gitFootprint = finding.gitFootprint
      if (!gitFootprint && typeof fetch === 'function') {
        try {
          // `currentSession` was never declared here, so this line threw a
          // ReferenceError that the empty catch below swallowed: gitFootprint was
          // silently never written. Resolve the workspace through real sources.
          const wsId = finding.workspaceId
            || (typeof services.resolveWorkspaceId === 'function' ? services.resolveWorkspaceId(sessionId) : '')
            || (typeof services.getActiveWorkspaceId === 'function' ? services.getActiveWorkspaceId() : '')
          if (wsId) {
            const res = await fetch(`api/punch-desk/git-branch?workspaceId=${encodeURIComponent(wsId)}`)
            if (res.ok) {
              const data = await res.json()
              if (data?.gitBranch || data?.gitCommit) {
                gitFootprint = {
                  branch: data.gitBranch || '',
                  ...(typeof data.gitCommit === 'string' && data.gitCommit !== '' ? { commit: data.gitCommit } : {}),
                  recordedAt: Date.now(),
                }
              }
            }
          }
        } catch {}
      }

      const updated = {
        ...finding,
        status: 'completed',
        submissionStatus: 'submitted',
        reviewStatus: 'resolved',
        submittedAt: finding.submittedAt || finding.createdAt || Date.now(),
        resolvedAt: Date.now(),
        updatedAt: Date.now(),
        ...(gitFootprint ? { gitFootprint } : {}),
      }
      if (services.store?.putEntry) await services.store.putEntry(updated)
      setEntries(prev => prev.map(e => e.id === finding.id ? updated : e))
    }

    const handleForkFinding = async (finding) => {
      const parentRound = Number.isFinite(finding.reviewRound) ? finding.reviewRound : 1
      const round = parentRound + 1
      const forked = services?.submit?.fork ? services.submit.fork(finding) : forkFinding(finding)
      const note = t('entry.forkRoundNote').replace('{round}', String(round))
      const inheritedText = typeof forked.text === 'string' ? forked.text : ''
      const parentNote = typeof finding.roundNote === 'string' ? finding.roundNote : ''
      const stripped = parentNote && inheritedText.startsWith(parentNote)
        ? inheritedText.slice(parentNote.length).replace(/^\n+/, '')
        : inheritedText
      const text = note + '\n' + stripped
      const renumbered = {
        ...forked,
        text,
        body: text,
        reviewRound: round,
        roundNote: note,
        thoughtNo: nextThoughtNo(entries),
      }
      await services.store.putEntry(renumbered)
      setEntries(prev => upsertEntryState(prev, renumbered))
    }

    const handleRetryFinding = async (finding) => {
      if (busy) return
      setBusy(true)
      say(t('submit.running'))
      try {
        const findingToRetry = {
          ...finding,
          submissionStatus: 'submitted',
          status: 'submitted',
          retryPending: false,
          lastSubmitError: undefined,
          updatedAt: Date.now(),
        }
        await services.store.putEntry(findingToRetry)

        const result = await services.submit.submitSequential(sessionId, [findingToRetry], promptOptionsFor())
        if (!result?.ok) {
          if (typeof services.submit.reconcileSubmission === 'function') {
            const rec = await services.submit.reconcileSubmission(sessionId, findingToRetry, result?.error)
            await services.store.putEntry({ ...findingToRetry, ...rec, updatedAt: Date.now() })
          } else {
            await services.store.putEntry({
              ...findingToRetry,
              retryPending: true,
              reconciliationPending: false,
              lastSubmitError: result?.error?.message ?? 'submit-failed',
              updatedAt: Date.now(),
            })
          }
          say(failureText(result), true)
        } else {
          await track({ requestId: findingToRetry.requestId, batchId: findingToRetry.batchId ?? 'retry' })
          applyAcceptedEvidence(result, [findingToRetry])
          if (result.evidencePending) await settleEvidencePending()
          else setNotice(null)
        }
      } catch (err) {
        say(failureText(undefined, err), true)
      } finally {
        setBusy(false)
      }
    }

    // ----------------------------------------------------
    // Turn Action Inbox Handlers (Confirm, Dismiss, Undo, Question, Context)
    // ----------------------------------------------------
    // Turn Action Fork follows the same round-note contract as the normal
    // finding Fork: the derived draft carries "第 N 轮" and a matching prefix.
    const withForkRoundNote = (finding) => {
      if (!finding || !finding.sourceFindingId || !finding.reviewRound) return finding
      const note = t('entry.forkRoundNote').replace('{round}', String(finding.reviewRound))
      if (finding.roundNote === note) return finding
      const base = finding.text ?? finding.body ?? ''
      return { ...finding, roundNote: note, text: `${note}\n${base}`, body: `${note}\n${base}` }
    }

    const handleConfirmAction = async (item) => {
      if (!item) return
      const originKey = item.originKey || itemOriginKey(item)
      const existingFinding = findFindingByOriginKey(entries, originKey)
      if (existingFinding) {
        say(t('turnActions.toastAlreadyExists'))
        setHighlightedFindingId(existingFinding.id)
        setTimeout(() => {
          if (typeof document !== 'undefined') {
            const el = document.getElementById(`finding-${existingFinding.id}`)
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          }
        }, 50)
        return
      }

      let parentFinding = null
      if (item.relatedFindingId) {
        parentFinding = entries.find(e => e.id === item.relatedFindingId) || null
        if (!parentFinding && typeof services.store?.listEntries === 'function') {
          const all = await services.store.listEntries(workspaceKey).catch(() => [])
          parentFinding = (Array.isArray(all) ? all : []).find(e => e.id === item.relatedFindingId) || null
        }
      }

      const thoughtNo = nextThoughtNo(entries)
      const newFinding = withForkRoundNote(convertTurnActionToFinding({
        item,
        parentFinding,
        targetSessionId: sessionId,
        targetWorkspaceKey: workspaceKey,
        targetWorkspaceId: currentWorkspaceId,
        targetSessionTitle: props.sessionTitle || '',
        thoughtNo,
        idGenerator: services.uuid,
      }))

      if (services.store?.putEntry) {
        await services.store.putEntry(newFinding)
      }

      setEntries(prev => upsertEntryState(prev, newFinding))

      // Mark item as converted in turnActions
      const rawItems = Array.isArray(turnActionsState?.items) ? turnActionsState.items : []
      const updatedItems = rawItems.map(it => {
        const itKey = it.id || itemOriginKey(it)
        if (itKey === (item.id || originKey)) {
          return {
            ...it,
            status: 'converted',
            findingId: newFinding.id,
            decidedAt: Date.now(),
          }
        }
        return it
      })

      const nextTurnState = {
        ...(turnActionsState || {}),
        version: 1,
        sessionId,
        items: updatedItems,
      }
      setTurnActionsState(nextTurnState)
      if (services.store?.putTurnActions) {
        await services.store.putTurnActions(sessionId, nextTurnState)
      }

      say(t('turnActions.toastConverted'))
      setHighlightedFindingId(newFinding.id)
      setTimeout(() => {
        if (typeof document !== 'undefined') {
          const el = document.getElementById(`finding-${newFinding.id}`)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
        }
      }, 50)
    }

    const handleDismissAction = async (item) => {
      if (!item) return
      const originKey = item.originKey || itemOriginKey(item)
      const rawItems = Array.isArray(turnActionsState?.items) ? turnActionsState.items : []
      const updatedItems = rawItems.map(it => {
        const itKey = it.id || itemOriginKey(it)
        if (itKey === (item.id || originKey)) {
          return {
            ...it,
            status: 'dismissed',
            decidedAt: Date.now(),
          }
        }
        return it
      })
      const nextTurnState = {
        ...(turnActionsState || {}),
        version: 1,
        sessionId,
        items: updatedItems,
      }
      setTurnActionsState(nextTurnState)
      if (services.store?.putTurnActions) {
        await services.store.putTurnActions(sessionId, nextTurnState)
      }
      say(t('turnActions.toastDismissed'))
    }

    const handleUndoAction = async (item) => {
      if (!item) return
      const originKey = item.originKey || itemOriginKey(item)
      const rawItems = Array.isArray(turnActionsState?.items) ? turnActionsState.items : []
      const updatedItems = rawItems.map(it => {
        const itKey = it.id || itemOriginKey(it)
        if (itKey === (item.id || originKey)) {
          return {
            ...it,
            status: 'open',
            decidedAt: undefined,
          }
        }
        return it
      })
      const nextTurnState = {
        ...(turnActionsState || {}),
        version: 1,
        sessionId,
        items: updatedItems,
      }
      setTurnActionsState(nextTurnState)
      if (services.store?.putTurnActions) {
        await services.store.putTurnActions(sessionId, nextTurnState)
      }
      say(t('turnActions.toastUndone'))
    }

    const handleRevealQuestion = (item) => {
      if (item?.callId && typeof services.userQuestionPanels?.reveal === 'function') {
        services.userQuestionPanels.reveal(sessionId, item.callId)
      }
    }

    const handleViewContext = (item) => {
      if (!item) return
      setHighlightedActionId(item.id || itemOriginKey(item))
      if (typeof services.toast?.info === 'function') {
        services.toast.info(`Turn ${item.turn}: ${item.title}`)
      }
    }

    const handleViewFinding = (findingId) => {
      if (!findingId) return
      setHighlightedFindingId(findingId)
      if (typeof document !== 'undefined') {
        const el = document.getElementById(`finding-${findingId}`)
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }
    }

    const handleRescanActions = async (e) => {
      if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
      if (isRescanningActions || !sessionId) return
      setIsRescanningActions(true)
      try {
        if (services.turnActionsTracker && typeof services.turnActionsTracker.resync === 'function') {
          await services.turnActionsTracker.resync(sessionId)
        }
        await load()
        const latestState = services.store?.listTurnActions
          ? await services.store.listTurnActions(sessionId).catch(() => null)
          : null
        const openItems = (latestState?.items || []).filter(it => it.status === 'open')
        if (openItems.length > 0) {
          say(t('turnActions.toastRescanned').replace('{n}', String(openItems.length)))
          setActiveBottomTab('actions')
          setBottomSectionOpen(true)
          setSubmittedLogOpen(true)
        } else {
          say(t('turnActions.toastNoActions'))
        }
      } catch {
        // degrade safely
      } finally {
        if (mounted.current) {
          setIsRescanningActions(false)
        }
      }
    }

    // ----------------------------------------------------
    // Thoughts Pool Submit Selected (Combined & Sequential)
    // ----------------------------------------------------
    const submitSelected = async (mode, { confirmed = false, customPrompt = null } = {}) => {
      if (busy) return
      // The host's archived-session gate rejects every model step; submitting
      // would only park a queue item that can never run.
      if (sessionArchived) {
        say(t('session.archivedLocked'), true)
        return
      }
      // Distillation maintenance window (spec §10.4): plugin submissions are
      // paused while this workspace's run holds the lock. This covers the
      // dock buttons, drag-to-submit and submit-after-inherit alike (they all
      // funnel here). Honest boundary: the host's main input box is NOT locked.
      if (distillLock.locked) {
        say(t('distill.lock.submitPausedTip'), true)
        return
      }
      if (!sessionId) {
        say(t('submit.failed'), true)
        return
      }
      const chosen = entries.filter(entry => selected.has(entry.id) && (entry.submissionStatus === 'unsubmitted' || entry.status === 'open'))
      if (chosen.length === 0) {
        say(t('submit.none'), true)
        return
      }

      // Resolve target group: either existing group or auto-created new group
      let targetGroup = null
      let targetGroupId = selectedTargetGroupId

      if (targetGroupId && targetGroupId !== 'new') {
        targetGroup = groups.find(g => g.id === targetGroupId)
        // A wrap-up archives the group; if the dock still points at it, silently
        // appending items would make the submitted findings vanish (archived
        // groups are not rendered in the active stream and cannot be结项 twice).
        if (targetGroup && targetGroup.status === 'archived') {
          say(t('group.targetArchived'), true)
          return
        }
      }

      if (!targetGroup) {
        if (activeGroups.length >= 3) {
          say(t('group.maxReached'), true)
          return
        }
        const grpNum = nextGroupNumber(groups)
        targetGroup = createGroupRecord({
          id: typeof services.uuid === 'function' ? services.uuid() : `group-${Date.now()}`,
          groupNumber: grpNum,
          sessionId,
          workspaceId: currentWorkspaceId,
          startTurn: currentTurn,
          items: [],
        })
        targetGroupId = targetGroup.id
      }

      const batchId = targetGroupId

      const carried = chosen.map(entry => entry.requestId)
      const sharedRequestId = carried.length > 0
        && carried.every(requestId => typeof requestId === 'string' && requestId !== '')
        && new Set(carried).size === 1
        ? carried[0]
        : undefined
      const combinedRequestId = mode === 'combined'
        ? sharedRequestId ?? services.uuid()
        : undefined

      const queued = mode === 'combined'
        ? chosen.map(entry => ({
            ...entry,
            submissionStatus: 'submitted',
            status: 'queued',
            batchId,
            assignedGroupId: targetGroupId,
            requestId: combinedRequestId,
            submittedAt: entry.submittedAt || Date.now(),
            updatedAt: Date.now(),
          }))
        : chosen.map(entry => ({
            ...entry,
            submissionStatus: 'submitted',
            status: 'queued',
            batchId,
            assignedGroupId: targetGroupId,
            requestId: entry.requestId ?? services.uuid(),
            submittedAt: entry.submittedAt || Date.now(),
            updatedAt: Date.now(),
          }))

      // Build the same prompt options the submit service will use, so the
      // pre-send guard and the actual send share one budget.
      const promptOptions = promptOptionsFor()
      const precheck = validateBatch(queued, { ...promptOptions, mode })
      if (!precheck.ok) {
        say(precheck.errors[0] ?? t('submit.invalid'), true)
        return
      }

      setBusy(true)
      say(t('submit.running'))

      try {
        let nextGrp = targetGroup
        for (const entry of queued) {
          nextGrp = addItemToGroup(nextGrp, entry.id)
        }
        // B6 / plan Phase 4: referenced findings must be persisted BEFORE the
        // group that names them, otherwise `putGroup`'s strict relationship
        // check would see a legitimately new item as an orphan. The reverse
        // order is not enough: a rejected group write then has to roll the
        // queued rows back so no finding keeps an assignedGroupId pointing at
        // a group that does not list it. Nothing has been sent to Harness yet
        // at this point, so the rollback is safe.
        try {
          for (const entry of queued) await services.store.putEntry(entry)
          if (services.store?.putGroup) await services.store.putGroup(nextGrp)
        } catch {
          for (const entry of chosen) {
            try {
              await services.store.putEntry(entry)
            } catch {}
          }
          say(t('store.error'), true)
          return
        }
        setGroups(prev => {
          const exists = prev.some(g => g.id === nextGrp.id)
          if (exists) return prev.map(g => g.id === nextGrp.id ? nextGrp : g)
          return [...prev, nextGrp]
        })
        setSelectedTargetGroupId(nextGrp.id)

        setEntries(prev => {
          const queuedMap = new Map(queued.map(q => [q.id, q]))
          return prev.map(e => queuedMap.get(e.id) || e)
        })

        const result = mode === 'combined'
          ? await services.submit.submitCombined(sessionId, queued, combinedRequestId, customPrompt, promptOptions)
          : await services.submit.submitSequential(sessionId, queued, promptOptions)

        if (!result?.ok) {
          if (mode === 'sequential') {
            for (const request of result?.requests ?? []) {
              await track({ requestId: request.requestId, batchId })
            }
            const failedEntry = queued.find(e => e.id === result.failedEntryId)
            if (failedEntry && typeof services.submit.reconcileSubmission === 'function') {
              const rec = await services.submit.reconcileSubmission(sessionId, failedEntry, result.error)
              await services.store.putEntry({ ...failedEntry, ...rec, updatedAt: Date.now() })
            }
          }
          const accepted = new Set((result?.requests ?? []).map(request => request.entryId))
          for (const entry of queued) {
            if (accepted.has(entry.id) || entry.id === result?.failedEntryId) continue
            await services.store.putEntry({
              ...entry,
              retryPending: true,
              reconciliationPending: false,
              lastSubmitError: result?.error?.message ?? 'submit-failed',
              updatedAt: Date.now(),
            })
          }
          say(failureText(result), true)
          return
        }

        if (mode === 'combined') {
          await track({ requestId: combinedRequestId, batchId })
        } else {
          for (const request of result.requests ?? []) {
            await track({ requestId: request.requestId, batchId })
          }
        }
        // Mirror the persisted acceptance evidence into pane state (B9) before any
        // other write can replace these entries from a stale copy.
        applyAcceptedEvidence(result, queued)
        setSelected(new Set())
        setShowTweakPopover(false)
        setPendingAppend(null)
        setNotice(null)
        // Immediate receipt: an irreversible append must be visible where it landed.
        const landedLabel = nextGrp && nextGrp.groupNumber ? `G${nextGrp.groupNumber}` : t('dock.targetNew')
        say(t('dock.submittedTo')
          .replace('{count}', String(queued.length))
          .replace('{target}', landedLabel)
          .replace('{after}', String((nextGrp?.items || []).length)))
        if (!result.evidencePending) return
        // Accepted prompts whose acceptance evidence could not be persisted
        // (T-GTA-26): keep them submitted, never resend, only retry the evidence.
        // Rows the sequential batch refused to send were never accepted, so a
        // retry flag there is honest (nothing was queued for them).
        const unsent = new Set(Array.isArray(result.unsentEntryIds) ? result.unsentEntryIds : [])
        for (const entry of queued) {
          if (!unsent.has(entry.id)) continue
          await services.store.putEntry({
            ...entry,
            retryPending: true,
            reconciliationPending: false,
            lastSubmitError: result.evidenceError?.message ?? 'submit/evidence-pending',
            updatedAt: Date.now(),
          })
        }
        await load()
        await settleEvidencePending()
      } catch (error) {
        for (const entry of queued) {
          await services.store.putEntry({
            ...entry,
            retryPending: true,
            reconciliationPending: false,
            lastSubmitError: error?.message ?? 'submit-failed',
            updatedAt: Date.now(),
          })
        }
        say(failureText(undefined, error), true)
      } finally {
        setBusy(false)
      }
    }

    // Merge selected cards into 1 card in thoughts pool
    const handleMergeSelected = async () => {
      const chosen = entries.filter(e => selected.has(e.id) && (e.submissionStatus === 'unsubmitted' || e.status === 'open'))
      if (chosen.length < 2) return

      const nextNo = nextThoughtNo(entries)
      const mergedText = chosen.map((c, i) => `${c.text || c.body || ''}`).join('\n---\n')
      const first = chosen[0]
      const mergedFinding = services.createFinding({
        sessionId,
        thoughtNo: nextNo,
        workspaceKey,
        workspaceId: currentWorkspaceId,
        text: `${t('pool.mergedTitle').replace('{number}', String(nextNo)).replace('{count}', String(chosen.length))}\n${mergedText}`,
        tag: first.tag || first.severity || 'optimize',
        submissionStatus: 'unsubmitted',
        status: 'open',
      })

      mergedFinding.thoughtNo = nextNo
      await services.store.putEntry(mergedFinding)
      for (const c of chosen) {
        const cWsKey = c.workspaceKey || workspaceKey
        if (services.store?.deleteEntry) {
          await services.store.deleteEntry(cWsKey, c.id)
        }
      }
      const chosenIds = new Set(chosen.map(c => c.id))
      setEntries(prev => upsertEntryState(prev.filter(e => !chosenIds.has(e.id)), mergedFinding))
      setSelected(new Set([mergedFinding.id]))
      say(t('desk.draft.saved'))
      await load()
    }

    const handleReorderFindings = async (sourceId, targetId) => {
      const sourceIdx = entries.findIndex(e => e.id === sourceId)
      const targetIdx = entries.findIndex(e => e.id === targetId)
      if (sourceIdx < 0 || targetIdx < 0 || sourceIdx === targetIdx) return

      const updated = [...entries]
      const [moved] = updated.splice(sourceIdx, 1)
      updated.splice(targetIdx, 0, moved)

      // Stable thought identities: do NOT overwrite thoughtNo on drag!
      setEntries(updated)
      if (services.store?.putEntries) {
        await services.store.putEntries(workspaceKey, updated)
      } else if (services.store?.putEntry) {
        await Promise.all(updated.map(e => services.store.putEntry(e)))
      }
    }

    // ----------------------------------------------------
    // Thoughts Pool & Group Filtering
    // ----------------------------------------------------
    const poolEntries = entries.filter(entry => {
      if (entry.assignedGroupId) {
        const grp = groups.find(g => g.id === entry.assignedGroupId)
        if (grp) return false
      }
      return !entry.batchId || entry.submissionStatus === 'unsubmitted' || entry.status === 'open'
    })

    const openPoolEntries = poolEntries.filter(e => e.submissionStatus === 'unsubmitted' || e.status === 'open')
    const allPoolSelected = openPoolEntries.length > 0 && openPoolEntries.every(e => selected.has(e.id))
    const selectedPoolCount = openPoolEntries.filter(e => selected.has(e.id)).length

    // Dock target contract: label + post-append preview are shown BEFORE submit.
    const targetGroupRecord = selectedTargetGroupId && selectedTargetGroupId !== 'new'
      ? groups.find(g => g.id === selectedTargetGroupId) || null
      : null
    const targetLabel = targetGroupRecord
      ? `G${targetGroupRecord.groupNumber}`
      : (selectedTargetGroupId === 'new' || (activeGroups.length === 0 && !selectedTargetGroupId) ? t('dock.targetNew') : null)
    const needTarget = !targetLabel && selectedPoolCount > 0
    const targetCaption = selectedPoolCount === 0
      ? null
      : (needTarget
          ? t('dock.needTarget').replace('{groups}', activeGroups.map(g => `+G${g.groupNumber}`).join(' / '))
          : (targetGroupRecord
              ? t('dock.appendPreview')
                  .replace('{count}', String(selectedPoolCount))
                  .replace('{target}', `G${targetGroupRecord.groupNumber}`)
                  .replace('{before}', String((targetGroupRecord.items || []).length))
                  .replace('{after}', String((targetGroupRecord.items || []).length + selectedPoolCount))
              : t('dock.newGroupPreview')
                  .replace('{count}', String(selectedPoolCount))
                  .replace('{number}', String(nextGroupNumber(groups)))))

    // Appending to an existing non-empty group needs an explicit second step.
    const requestSubmit = (mode, options = {}) => {
      if (busy) return
      setCapPopoverOpen(false)
      if (targetGroupRecord) {
        const chosenCount = entries.filter(entry => selected.has(entry.id)
          && (entry.submissionStatus === 'unsubmitted' || entry.status === 'open')).length
        if ((targetGroupRecord.items || []).length > 0 && chosenCount > 0) {
          setPendingAppend({
            mode,
            targetId: targetGroupRecord.id,
            before: (targetGroupRecord.items || []).length,
            count: chosenCount,
            after: (targetGroupRecord.items || []).length + chosenCount,
            customPrompt: options.customPrompt ?? null,
          })
          return
        }
      }
      submitSelected(mode, options)
    }

    const toggleSelectAllPool = () => {
      if (allPoolSelected) setSelected(new Set())
      else setSelected(new Set(openPoolEntries.map(e => e.id)))
    }

    // Archived groups: groups that were explicitly archived by clicking 结项.
    // Default is newest-first (descending group number); the header button toggles it.
    const archivedGroups = groups
      .filter(g => g.status === 'archived')
      .map((group, index) => ({ group, index }))
      .sort((a, b) => {
        const aNum = Number.isFinite(a.group.groupNumber) ? a.group.groupNumber : a.index
        const bNum = Number.isFinite(b.group.groupNumber) ? b.group.groupNumber : b.index
        const diff = aNum - bNum || (Number(a.group.archivedAt) || 0) - (Number(b.group.archivedAt) || 0)
        return archivedSortDesc ? -diff : diff
      })
      .map(item => item.group)

    const headerWork = summarizeOpenWork({
      entries,
      groups,
      poolCount: openPoolEntries.length,
      findingsMap,
      harnessProjectionsMap,
    })
    const activeGroupItemsCount = headerWork.active
    const totalOpenCount = headerWork.total
    const awaitingWrapUpCount = headerWork.awaitingWrapUp
    const awaitingGroupsCount = headerWork.awaitingGroups || 0
    const needsWrapUp = headerWork.needsWrapUp
    const statusColor = headerWork.color
    const statusTextColor = headerWork.textColor
    const executingItemsCount = headerWork.executing
    const breathing = headerWork.breathing

    // Update tweak prompt preview when selection or tweak opened
    React.useEffect(() => {
      const chosen = entries.filter(e => selected.has(e.id) && (e.submissionStatus === 'unsubmitted' || e.status === 'open'))
      if (chosen.length > 0) {
        const promptLines = chosen.map((item, idx) => `[${item.tag || item.severity || 'optimize'}] #${idx + 1} ${item.text || item.body || ''}`).join('\n\n')
        setTweakPromptText(promptLines)
      } else {
        setTweakPromptText('')
      }
    }, [selected, entries])

    // ----------------------------------------------------
    // Render Functions
    // ----------------------------------------------------

    /** Render turn-grouped commit trace details + optional secondary completion footprint */
    const renderTraceDetailsBlock = (traces, { secondaryFootprint = null, headerTitle = null } = {}) => {
      const sortedTraces = [...(Array.isArray(traces) ? traces : [])].sort((a, b) =>
        (Number(a?.turn) || 0) - (Number(b?.turn) || 0) || (Number(a?.capturedAt) || 0) - (Number(b?.capturedAt) || 0)
      )
      const hasSecondary = Boolean(secondaryFootprint?.commit || secondaryFootprint?.branch)
      if (sortedTraces.length === 0 && !hasSecondary) return null

      return h('div', {
        style: {
          marginTop: 4,
          padding: '6px 8px',
          borderRadius: 6,
          background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
          border: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          fontSize: 11,
        },
        onClick: (e) => {
          if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
        },
      },
        headerTitle
          ? h('div', {
              style: {
                fontSize: 10,
                fontWeight: 600,
                color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              },
            },
              h(GitCommit, { size: 12 }),
              h('span', null, headerTitle))
          : null,
        ...sortedTraces.map(tr => {
          const isFailed = tr.status === 'failed'
          const commits = Array.isArray(tr.commits) ? tr.commits : []
          const retryAllowed = canRetryCommitTrace(tr)

          return h('div', {
            key: tr.id || `${tr.requestId}-${tr.turn}`,
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            },
          },
            h('div', {
              style: {
                fontSize: 10,
                fontFamily: 'monospace',
                fontWeight: 600,
                color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
              },
            }, t('finding.commitTrace.turnHeader').replace('{turn}', String(tr.turn ?? '—'))),
            isFailed
              ? h('div', {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    gap: 6,
                  },
                },
                  h(Badge, { tone: 'warn', icon: Prohibit }, t('finding.commitTrace.failedBadge')),
                  h('span', {
                    style: {
                      fontSize: 11,
                      color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                    },
                  }, t('finding.commitTrace.failedReason').replace('{reason}', formatCommitTraceError(tr.error, t))),
                  retryAllowed
                    ? h(Button, {
                        key: `retry-${tr.id}`,
                        icon: ArrowCounterClockwise,
                        title: t('finding.commitTrace.retry'),
                        'aria-label': t('finding.commitTrace.retry'),
                        'data-action': 'retry-commit-trace',
                        onClick: (e) => {
                          if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                          return handleRetryCommitTrace(tr.id)
                        },
                        style: { padding: '2px 8px', fontSize: 10 },
                      }, t('finding.commitTrace.retry'))
                    : null)
              : (commits.length === 0
                  ? h('div', {
                      style: {
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                      },
                    }, t('finding.commitTrace.badgeZero'))
                  : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                      ...commits.map((c, cIdx) => {
                        const shortHash = c.shortHash || (typeof c.hash === 'string' ? c.hash.slice(0, 7) : '')
                        const timeStr = formatCommitTime(c.time)
                        const fullTimeStr = formatLocalDateTime(c.time)
                        const isFocusedCommit = Boolean(
                          highlightedCommitFocus
                          && (
                            (highlightedCommitFocus.commitHash && c.hash === highlightedCommitFocus.commitHash)
                            || (highlightedCommitFocus.shortHash && shortHash === highlightedCommitFocus.shortHash)
                          )
                        )
                        return h('div', {
                          key: c.hash || `${tr.id}-${cIdx}`,
                          'data-commit-hash': c.hash || shortHash,
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 11,
                            ...(isFocusedCommit
                              ? {
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  background: nordTint(NORD.nord8, 0.22),
                                  borderLeft: `2.5px solid ${NORD.nord8}`,
                                }
                              : {}),
                          },
                        },
                          h('code', {
                            style: {
                              fontFamily: 'monospace',
                              fontWeight: 700,
                              color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))',
                              flexShrink: 0,
                            },
                          }, shortHash),
                          h('span', {
                            style: {
                              flex: 1,
                              minWidth: 0,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              fontWeight: isFocusedCommit ? 600 : 400,
                              color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                            },
                          }, c.subject || ''),
                          timeStr
                            ? h('span', {
                                tip: fullTimeStr || timeStr,
                                style: {
                                  fontSize: 10,
                                  fontFamily: 'monospace',
                                  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                                  flexShrink: 0,
                                },
                              }, timeStr)
                            : null)
                      }))),
            tr.truncated
              ? h('div', {
                  style: {
                    fontSize: 10,
                    color: 'var(--dsw-alias-state-warn-primary, #ebcb8b)',
                  },
                }, t('finding.commitTrace.truncatedHint'))
              : null)
        }),
        hasSecondary
          ? h('div', {
              style: {
                fontSize: 10,
                fontFamily: 'monospace',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                borderTop: sortedTraces.length > 0 ? '1px dashed var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))' : 'none',
                paddingTop: sortedTraces.length > 0 ? 4 : 0,
              },
              tip: t('finding.gitFootprint.title')
                .replace('{branch}', secondaryFootprint.branch || '—')
                .replace('{commit}', String(secondaryFootprint.commit || '')),
            }, t('finding.gitFootprint.secondary')
              .replace('{branch}', secondaryFootprint.branch || '—')
              .replace('{commit}', String(secondaryFootprint.commit || '').slice(0, 7)))
          : null)
    }

    /** Render a single finding row inside pool or group */
    const renderFindingItem = (finding, options = {}) => {
      const { inGroup = false, last = false } = options
      const isExpanded = expandedSet.has(finding.id)
      const isEditing = editingFindingId === finding.id
      const isUnsubmitted = finding.submissionStatus === 'unsubmitted' || finding.status === 'open'
      const projection = deriveHarnessProjection(finding, log, liveQueue)
      const firstAnchor = Array.isArray(finding.anchors) ? finding.anchors[0] : null
      const label = anchorText(firstAnchor, t)
      const isQuoteAnchor = Boolean(firstAnchor
        && (firstAnchor.type === 'quote' || firstAnchor.kind === 'quote'))
      const anchorTitle = isQuoteAnchor
        && typeof firstAnchor.text === 'string'
        && firstAnchor.text.trim() !== ''
        ? firstAnchor.text.trim()
        : undefined

      // In-place edit view (for queued tasks or in-place edit test)
      if (isEditing && !isUnsubmitted) {
        return h(Card, { key: finding.id, variant: 'fluid', last, style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          h('textarea', {
            value: editingText,
            onChange: e => setEditingText(e.target.value),
            rows: 3,
            style: COMPOSER_TEXTAREA_STYLE,
          }),
          h('div', { style: BUTTON_ROW_STYLE },
            h(Button, {
              variant: 'primary',
              icon: CheckCircle,
              disabled: busy || !editingText.trim(),
              onClick: () => handleSaveEditQueued(finding, editingText),
            }, t('finding.save')),
            h(Button, {
              variant: 'ghost',
              icon: Prohibit,
              disabled: busy,
              onClick: () => { setEditingFindingId(null); setEditingText('') },
            }, t('finding.cancel'))))
      }

      const findingTraces = commitTraces.filter(tr => Array.isArray(tr?.findingIds) && tr.findingIds.includes(finding.id))
      const findingUniqueCommits = collectUniqueCommits(findingTraces)
      const findingCommitCount = findingUniqueCommits.length
      const hasFailedFindingTrace = findingTraces.some(tr => tr.status === 'failed')
      const hasFindingGitArea = findingTraces.length > 0 || Boolean(finding.gitFootprint?.commit)
      const isFindingGitExpanded = gitExpandedMap.has(finding.id)
        ? gitExpandedMap.get(finding.id)
        : hasFailedFindingTrace

      let gitBadgeNode = null
      if (findingTraces.length > 0) {
        const commitBadgeText = findingCommitCount === 0
          ? t('finding.commitTrace.badgeZero')
          : t('finding.commitTrace.badge').replace('{count}', String(findingCommitCount))
        gitBadgeNode = h('button', {
          type: 'button',
          title: commitBadgeText,
          'aria-label': commitBadgeText,
          'data-action': 'finding-commit-trace',
          onClick: (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
            toggleGitExpand(finding.id, isFindingGitExpanded)
          },
          style: {
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          },
        }, h(Badge, {
          tone: hasFailedFindingTrace ? 'warn' : 'neutral',
          icon: GitCommit,
          style: { cursor: 'pointer' },
        }, findingCommitCount > 0 ? String(findingCommitCount) : null))
      } else if (finding.gitFootprint?.commit) {
        const fpTitle = t('finding.gitFootprint.title')
          .replace('{branch}', finding.gitFootprint.branch || '—')
          .replace('{commit}', String(finding.gitFootprint.commit))
        gitBadgeNode = h('button', {
          type: 'button',
          tabIndex: 0,
          tip: fpTitle,
          'aria-label': fpTitle,
          'data-action': 'finding-git-footprint',
          onClick: (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
            toggleGitExpand(finding.id, isFindingGitExpanded)
          },
          style: {
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          },
        }, h(Badge, { tone: 'neutral', icon: GitCommit }, String(finding.gitFootprint.commit).slice(0, 7)))
      }

      // Status Indicator
      let statusIndicator = null
      if (finding.reconciliationPending) {
        statusIndicator = h(Badge, { tone: 'warn', icon: Clock }, t('finding.reconciling'))
      } else if (finding.retryPending) {
        statusIndicator = h('span', { style: { display: 'inline-flex', gap: 4, alignItems: 'center' } },
          h(Badge, { tone: 'danger', icon: Prohibit }, t('finding.reconciledFailed')),
          h(Button, {
            icon: Play,
            disabled: busy,
            title: t('finding.retry'),
            onClick: () => handleRetryFinding(finding),
          }, t('finding.retry')))
      } else if (!isUnsubmitted) {
        // 2026-11-11 fix: dismissed ≠ completed. "忽略" means "no follow-up" and
        // must keep its own audit label; both review states used to fall into one
        // branch and a dismissed row rendered 已完成 (reported).
        if (isIgnoredFinding(finding)) {
          statusIndicator = h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
            h(Badge, { tone: 'neutral', icon: Prohibit }, t('list.dismissed')),
          )
        } else if (finding.status === 'completed' || finding.reviewStatus === 'resolved') {
          statusIndicator = h('span', { style: { display: 'inline-flex', gap: 6, alignItems: 'center' } },
            h(Badge, { tone: 'success', icon: (p) => CheckCircle({ ...p, filled: true, color: NORD.nord14 }) }, t('status.completed')),
          )
        } else {
          // The row badge MUST use the same Harness projection as the group badge
          // (active-group.md §5): a group can only read "completed" when every row
          // reads "executed", never "executing".
          const badgeSpec = projection === 'queued'
            ? { tone: 'info', icon: Clock, label: t('status.queued') }
            : projection === 'running'
              ? { tone: 'neutral', icon: CircleNotch, label: t('group.status.executing'), style: { color: 'var(--pd-status-running-text, #0a6b36)' } }
              : projection === 'executed'
                ? { tone: 'success', icon: Circle, label: t('finding.badge.executed'), tip: t('finding.badge.executedTip') }
                : { tone: 'neutral', icon: Circle, label: t('finding.badge.submitted') }
          const canComplete = projection === 'executed' || projection === 'unknown'
          statusIndicator = canComplete
            ? h('button', {
                type: 'button',
                onClick: () => handleCompleteFinding(finding),
                title: t('finding.action.complete'),
                style: {
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                },
              }, h(Badge, { tone: badgeSpec.tone, icon: badgeSpec.icon, tip: badgeSpec.tip, style: { cursor: 'pointer', ...(badgeSpec.style || {}) } }, badgeSpec.label))
            : h(Badge, { tone: badgeSpec.tone, icon: badgeSpec.icon, tip: badgeSpec.tip, style: badgeSpec.style }, badgeSpec.label)
        }
      }

      // Action Buttons
      const actions = []

      // Expand / Collapse button
      actions.push(h(Button, {
        key: 'expand',
        variant: 'icon',
        icon: isExpanded ? CaretDown : CaretRight,
        title: isExpanded ? t('finding.collapse') : t('finding.expand'),
        onClick: () => toggleExpand(finding.id),
      }))

      // Actions when queued
      if (!isUnsubmitted && projection === 'queued' && finding.requestId) {
        actions.push(h(Button, {
          key: 'edit',
          variant: 'icon',
          icon: PencilSimple,
          title: t('finding.edit'),
          style: { color: NORD.nord13 },
          disabled: busy,
          onClick: () => {
            setEditingFindingId(finding.id)
            setEditingText(finding.text || finding.body || '')
          },
        }))
      }

      // Actions when unsubmitted in pool: edit & delete
      if (isUnsubmitted && !inGroup) {
        actions.push(h(Button, {
          key: 'edit-pool',
          variant: 'icon',
          icon: PencilSimple,
          title: t('finding.edit'),
          style: { color: NORD.nord13 },
          disabled: busy,
          onClick: () => loadIntoComposer(finding),
        }))
        if (deleteConfirmId === finding.id) {
          actions.push(h('div', {
            key: 'delete-confirm',
            style: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
          },
            h('span', { style: { fontSize: 10, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' } },
              t('finding.deleteConfirmShort')),
            h('button', {
              key: 'delete-confirm-yes',
              type: 'button',
              disabled: busy,
              title: t('finding.deleteConfirmYes'),
              'aria-label': t('finding.deleteConfirmYes'),
              onClick: () => { setDeleteConfirmId(null); deleteFinding(finding.id) },
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                padding: '2px 8px',
                borderRadius: 6,
                fontSize: 10,
                fontWeight: 600,
                cursor: busy ? 'not-allowed' : 'pointer',
                background: nordTint(NORD.nord11, 0.14),
                border: `1px solid ${nordTint(NORD.nord11, 0.45)}`,
                color: 'var(--dsw-alias-state-danger-primary, #bf616a)',
              },
            }, h(CheckCircle, { size: 12 }), t('finding.deleteConfirmYes')),
            h('button', {
              key: 'delete-confirm-cancel',
              type: 'button',
              disabled: busy,
              title: t('finding.cancel'),
              'aria-label': t('finding.cancel'),
              onClick: () => setDeleteConfirmId(null),
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 3,
                padding: '2px 8px',
                borderRadius: 6,
                fontSize: 10,
                cursor: busy ? 'not-allowed' : 'pointer',
                background: 'transparent',
                border: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(76, 86, 106, 0.25)))',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
              },
            }, h(X, { size: 12 }), t('finding.cancel'))))
        } else {
          actions.push(h(Button, {
            key: 'delete-pool',
            variant: 'icon',
            icon: Trash,
            title: t('desk.draft.delete'),
            style: { color: NORD.nord11 },
            disabled: busy,
            onClick: () => setDeleteConfirmId(finding.id),
          }))
        }
      }

      // Fork to draft pool: allowed for reviewed rows and for executed-but-
      // unreviewed rows, so a repeat review round does not require accepting
      // (completing) the previous one first. The derived entry keeps lineage and
      // carries a round note into its prompt text.
      const isReviewed = finding.reviewStatus === 'resolved' || isIgnoredFinding(finding)
      const canFork = isReviewed || (!isUnsubmitted && projection === 'executed')
      if (canFork) {
        const nextRound = (Number.isFinite(finding.reviewRound) ? finding.reviewRound : 1) + 1
        const forkLabel = t('entry.forkRound').replace('{round}', String(nextRound))
        actions.push(h(Button, {
          key: 'fork',
          variant: 'icon',
          icon: Copy,
          title: forkLabel,
          'aria-label': forkLabel,
          style: { color: NORD.nord8 },
          onClick: async () => handleForkFinding(finding),
        }))
      }

      const reviewStatic = projection === 'executed' || projection === 'unknown'
      if (!isReviewed && !isUnsubmitted && reviewStatic) {
        actions.push(h(Button, {
          key: 'resolve',
          variant: 'icon',
          icon: CheckCircle,
          title: t('finding.action.resolve'),
          'aria-label': t('finding.action.resolve'),
          style: { color: NORD.nord14 },
          onClick: async () => {
            const now = Date.now()
            const updated = {
              ...finding,
              status: 'resolved',
              reviewStatus: 'resolved',
              submittedAt: finding.submittedAt || finding.createdAt || now,
              resolvedAt: now,
              updatedAt: now,
            }
            await services.store.putEntry(updated)
            setEntries(prev => prev.map(e => e.id === finding.id ? updated : e))
          },
        }))
        actions.push(h(Button, {
          key: 'dismiss',
          variant: 'icon',
          icon: Prohibit,
          title: t('finding.action.dismiss'),
          'aria-label': t('finding.action.dismiss'),
          style: { color: NORD.nord11 },
          onClick: async () => {
            const now = Date.now()
            const updated = {
              ...finding,
              status: 'dismissed',
              reviewStatus: 'dismissed',
              resolvedAt: now,
              updatedAt: now,
            }
            await services.store.putEntry(updated)
            setEntries(prev => prev.map(e => e.id === finding.id ? updated : e))
          },
        }))
      }

      const isHighlightedByCommit = Boolean(
        highlightedCommitFocus
        && Array.isArray(highlightedCommitFocus.findingIds)
        && highlightedCommitFocus.findingIds.includes(finding.id)
      )
      const isHighlightedByAction = highlightedFindingId === finding.id
      const isCardHighlighted = isHighlightedByCommit || isHighlightedByAction
      const locatedCommitShort = isHighlightedByCommit
        ? (highlightedCommitFocus.shortHash || String(highlightedCommitFocus.commitHash || '').slice(0, 7))
        : ''

      const cardStyle = inGroup
        ? {
            ...ROW_STYLE,
            borderBottom: last ? 'none' : '1px solid var(--dsw-alias-border-l2, #3b4252)',
            ...(isCardHighlighted
              ? {
                  background: nordTint(NORD.nord8, 0.14),
                  borderLeft: `3px solid ${NORD.nord8}`,
                  borderRadius: 6,
                }
              : {}),
          }
        : {
            ...DRAFT_CARD_STYLE(isEditing, selected.has(finding.id), last),
            // Pool cards carry a tag-coloured strip: groups use their sequence
            // tint, loose findings use their tag colour, so the two families of
            // strips stay semantically distinct.
            borderLeft: `3px solid ${isCardHighlighted ? NORD.nord8 : tagColorOf(finding.tag || finding.severity || 'optimize')}`,
            ...(isCardHighlighted ? { background: nordTint(NORD.nord8, 0.14) } : {}),
            ...(dragOverFindingId === finding.id ? { borderTop: '2px solid var(--dsw-alias-button-primary-fill, #88c0d0)' } : {}),
          }

      return h('div', {
        key: finding.id,
        id: `finding-${finding.id}`,
        'data-finding-id': finding.id,
        draggable: isUnsubmitted && !inGroup && !distillLock.locked,
        // The whole card (header + body) toggles the expanded state, so the hit
        // area stays equally wide in both states instead of shrinking to the
        // caret icon once expanded. Inner controls and text selections are
        // filtered out by suppressesRowToggle.
        onClick: (event) => {
          if (suppressesRowToggle(event)) return
          toggleExpand(finding.id)
        },
        onDragStart: (e) => {
          if (isUnsubmitted && !inGroup && !distillLock.locked) {
            setDraggedFindingId(finding.id)
            e.dataTransfer.setData('text/plain', finding.id)
            e.dataTransfer.effectAllowed = 'move'
          }
        },
        onDragEnd: () => {
          setDraggedFindingId(null)
          setDragOverFindingId(null)
        },
        onDragOver: (e) => {
          if (isUnsubmitted && !inGroup && draggedFindingId && draggedFindingId !== finding.id) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            if (dragOverFindingId !== finding.id) setDragOverFindingId(finding.id)
          }
        },
        onDragLeave: () => {
          if (dragOverFindingId === finding.id) setDragOverFindingId(null)
        },
        onDrop: async (e) => {
          const sourceId = (e.dataTransfer && typeof e.dataTransfer.getData === 'function' ? e.dataTransfer.getData('text/plain') : null) || draggedFindingId
          if (isUnsubmitted && !inGroup && sourceId && sourceId !== finding.id) {
            if (typeof e.preventDefault === 'function') e.preventDefault()
            setDragOverFindingId(null)
            await handleReorderFindings(sourceId, finding.id)
          }
        },
        style: {
          ...cardStyle,
          cursor: isUnsubmitted && !inGroup && !distillLock.locked ? 'grab' : 'pointer',
        },
      },
      // Top row: grip / checkbox / #No / Tag / preview / status / actions
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 } },
          isUnsubmitted && !inGroup
            ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary, #4c566a)', cursor: 'grab', display: 'flex' } },
                h(DotsSixVertical, { size: 14 }))
            : null,
          isUnsubmitted && !inGroup
            ? h('input', {
                type: 'checkbox',
                checked: selected.has(finding.id),
                onChange: () => toggle(finding.id),
                style: { cursor: 'pointer', margin: 0 },
              })
            : null,
          h('span', { style: { fontSize: 11, fontWeight: 'bold', fontFamily: 'monospace', color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' } },
            `#${finding.thoughtNo || 1}`),
          h('span', {
            style: tagStyleOf(finding.tag || finding.severity || 'optimize'),
          }, tagLabelOf(finding.tag || finding.severity || 'optimize')),
          Number.isFinite(finding.reviewRound) && finding.reviewRound >= 2
            ? h(Badge, {
                tone: 'info',
                tip: t('entry.reviewRoundTip'),
                style: { fontSize: 9, padding: '1px 6px', whiteSpace: 'nowrap' },
              }, t('entry.reviewRoundBadge').replace('{round}', String(finding.reviewRound)))
            : null,
          !isExpanded
            ? h('span', {
                style: {
                  ...ROW_TITLE_STYLE,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
                title: t('finding.expand'),
              }, finding.title || finding.text || finding.body || '')
            : null),
        h('div', { style: FINDING_META_STYLE },
          isHighlightedByCommit && locatedCommitShort
            ? h(Badge, {
                tone: 'info',
                icon: GitCommit,
                style: { fontSize: 9, padding: '1px 6px', fontWeight: 700 },
              }, t('desk.gitLookup.locatedBadge').replace('{commit}', locatedCommitShort))
            : null,
          statusIndicator,
          gitBadgeNode,
          label
            ? h(Badge, {
                tone: 'info',
                icon: isQuoteAnchor ? BookBookmark : undefined,
                style: ANCHOR_BADGE_STYLE,
                tip: anchorTitle,
                'aria-label': anchorTitle || label,
              }, isQuoteAnchor ? null : h('span', { style: ANCHOR_LABEL_STYLE }, label))
            : null,
          ...actions)),
      hasFindingGitArea && (isFindingGitExpanded || isHighlightedByCommit)
        ? renderTraceDetailsBlock(findingTraces, { secondaryFootprint: finding.gitFootprint })
        : null,
      // Expanded content: full pre-wrap without truncation
      isExpanded
        ? h('div', { style: EXPANDED_CONTENT_STYLE }, finding.text || finding.body || '')
        : null)
    }

    /** Render an Active Group card */
    const renderActiveGroup = (group, index = 0) => {
      const groupItemIds = new Set((group.items || []).map(it => it.findingId))
      const groupFindings = entries.filter(e => e.assignedGroupId === group.id || groupItemIds.has(e.id))
      const groupFindingIdSet = new Set(groupFindings.map(f => f.id))
      const groupTraces = commitTraces.filter(tr =>
        (Array.isArray(tr?.groupIds) && tr.groupIds.includes(group.id))
        || (Array.isArray(tr?.findingIds) && tr.findingIds.some(fid => groupFindingIdSet.has(fid)))
      )
      const groupUniqueCommits = collectUniqueCommits(groupTraces)
      const groupCommitCount = groupUniqueCommits.length
      const groupGitKey = `group-git-${group.id}`
      const isGroupGitExpanded = Boolean(gitExpandedMap.get(groupGitKey))
      const executionStatus = deriveGroupExecutionStatus(group, findingsMap, harnessProjectionsMap)
      const isCompleted = executionStatus === 'completed'
      const groupBadgeState = deriveGroupBadgeState(group, findingsMap, harnessProjectionsMap)
      const groupSettledIgnored = groupBadgeState.kind === 'partialIgnored' || groupBadgeState.kind === 'allIgnored'
      const groupStatusCounts = summarizeGroupStatusCounts(groupFindings, finding => deriveHarnessProjection(finding, log, liveQueue))
      const statusCountsExpanded = expandedGroupCountIds.has(group.id)
      const groupStatusBadgeItems = [
        { key: 'completed', label: t('group.status.completed'), count: groupStatusCounts.completed, tone: 'success' },
        { key: 'awaiting', label: t('group.status.awaitingWrapUp'), count: groupStatusCounts.awaitingWrapUp, tone: 'warn' },
        { key: 'submitted', label: t('group.status.submitted'), count: groupStatusCounts.submitted, tone: 'info' },
        { key: 'ignored', label: t('group.status.ignored'), count: groupStatusCounts.ignored, tone: 'neutral' },
      ].filter(item => item.count > 0)
      const wrapUpPlan = planGroupWrapUp(group, findingsMap, harnessProjectionsMap)
      const wrapUpSettleFindings = wrapUpPlan.settleIds
        .map(id => (findingsMap instanceof Map ? findingsMap.get(id) : findingsMap?.[id]))
        .filter(Boolean)
      const wrapUpResolvableCount = wrapUpSettleFindings
        .filter(finding => !isIgnoredFinding(finding) && finding.reviewStatus !== 'resolved').length
      const wrapUpIgnoredCount = wrapUpSettleFindings.filter(isIgnoredFinding).length
      // Wrap-up is only available once the batch is finished: queued/running or
      // unsettled rows keep it disabled (防误触), with an info tip explaining why.
      // Blocked only by real plan blockers: an empty group or a batch whose rows
      // are already static (executed / unknown / reviewed) is wrap-able, matching
      // the server-side plan. A finished-but-not-yet-reviewed batch is not blocked.
      const wrapUpBlockedReason = wrapUpPlan.queuedIds.length > 0
        ? countText(t('group.wrapUpBlockedQueued'), wrapUpPlan.queuedIds.length)
        : wrapUpPlan.runningIds.length > 0
          ? countText(t('group.wrapUpBlockedRunning'), wrapUpPlan.runningIds.length)
          : wrapUpPlan.unsettledIds.length > 0
            ? countText(t('group.wrapUpBlockedUnsettled'), wrapUpPlan.unsettledIds.length)
            : ''
      const wrapUpDisabled = wrapUpBlockedReason !== ''
      const wrapUpTip = wrapUpDisabled
        ? wrapUpBlockedReason
        : (groupFindings.length === 0 ? t('group.wrapUpEmptyHint') : '')
      // Group turn attribution (plan 2026-11-12 B1): the header main number is
      // `groupTurns = charged + attributed`, never the session-wide `elapsed`.
      const turnLabels = describeGroupTurns(groupTurnStatsById.get(group.id), t)
      const turnsExpanded = expandedTurnGroupIds.has(group.id)
      const isDragOver = dragOverGroupId === group.id
      const isGroupExpanded = expandedSet.has(`group-${group.id}`) || isAllExpanded


      return h('div', {
        key: group.id,
        onDragOver: (e) => {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          if (dragOverGroupId !== group.id) setDragOverGroupId(group.id)
        },
        onDragLeave: () => {
          if (dragOverGroupId === group.id) setDragOverGroupId(null)
        },
        onDrop: async (e) => {
          e.preventDefault()
          setDragOverGroupId(null)
          const findingId = e.dataTransfer.getData('text/plain')
          if (findingId) {
            await handleDropFindingToGroup(findingId, group.id)
          }
        },
        style: {
          ...GROUP_CARD_STYLE(group.groupNumber, isDragOver),
          ...(selectedTargetGroupId === group.id
            ? { boxShadow: 'inset 3px 0 0 var(--pd-accent, #5e81ac)' }
            : {}),
          ...(index > 0
            ? {
                marginTop: 6,
                borderTop: `2px solid ${getSequenceTint(Math.max(0, (Number(group.groupNumber) || 1) - 1)).border}`,
              }
            : {}),
        },
      },
      // Group Header — the whole header row folds/unfolds the batch, matching
      // the finding cards so the hit area does not shrink to the caret icon.
      h('div', {
        style: { ...GROUP_HEADER_STYLE(group.groupNumber), cursor: 'pointer' },
        onClick: (event) => {
          if (suppressesRowToggle(event)) return
          toggleExpand(`group-${group.id}`)
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', {
            style: {
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: executionStatus === 'executing'
                ? 'var(--pd-status-running, #0e9f4f)'
                : (groupBadgeState.kind === 'completed' ? NORD.nord14 : (groupSettledIgnored ? 'var(--pd-status-muted, #4c566a)' : NORD.nord9)),
              flexShrink: 0,
            },
          }),
          h('span', {
            style: {
              fontWeight: 600,
              color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          }, t('group.title').replace('{number}', group.groupNumber)),
          h('button', {
            type: 'button',
            title: t('group.statusCountsExpandTip'),
            'aria-label': t('group.statusCountsExpandTip'),
            'aria-expanded': statusCountsExpanded ? 'true' : 'false',
            'data-action': 'group-status-counts',
            onClick: (e) => toggleGroupStatusCounts(group.id, e),
            style: {
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              flexShrink: 0,
            },
          }, h(Badge, {
            tone: groupStatusCounts.awaitingWrapUp > 0 ? 'warn' : (groupSettledIgnored ? 'neutral' : 'info'),
            style: { fontSize: 9, padding: '1px 6px', fontWeight: 'bold', cursor: 'pointer' },
            tip: t('group.statusCountsExpandTip'),
          }, formatGroupCountBadge(groupStatusCounts))),
          h('span', {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              overflow: 'hidden',
              maxWidth: statusCountsExpanded ? 360 : 0,
              opacity: statusCountsExpanded ? 1 : 0,
              transition: 'max-width 180ms ease, opacity 160ms ease',
              whiteSpace: 'nowrap',
            },
          },
            ...groupStatusBadgeItems.map(item => h(Badge, {
              key: item.key,
              tone: item.tone,
              style: { fontSize: 9, padding: '1px 5px', flexShrink: 0 },
            }, `${item.label} ${item.count}`))),
          h('button', {
            type: 'button',
            title: t('group.turnMetricsExpandTip'),
            'aria-label': t('group.turnMetricsExpandTip'),
            'aria-expanded': turnsExpanded ? 'true' : 'false',
            'data-action': 'group-turn-metrics',
            onClick: (e) => toggleTurnMetrics(group.id, e),
            style: {
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              flexShrink: 0,
            },
          }, h(Badge, {
            tone: executionStatus === 'executing' ? 'warn' : 'info',
            style: { fontSize: 10, padding: '1px 6px', fontWeight: 'bold', cursor: 'pointer' },
            tip: turnLabels.turnsTip,
          }, turnLabels.turns)),
          h('span', {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              overflow: 'hidden',
              maxWidth: turnsExpanded ? 220 : 0,
              opacity: turnsExpanded ? 1 : 0,
              transition: 'max-width 180ms ease, opacity 160ms ease',
              whiteSpace: 'nowrap',
            },
          },
            h('span', {
              style: { fontSize: 10, fontWeight: 600, flexShrink: 0, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' },
              tip: turnLabels.triggeredTip,
            }, turnLabels.triggered),
            h('span', {
              style: { fontSize: 10, fontWeight: 600, flexShrink: 0, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' },
              tip: turnLabels.attributedTip,
            }, turnLabels.attributed)),
          groupTraces.length > 0
            ? h('button', {
                type: 'button',
                title: t('group.commitTrace.expandedTitle'),
                'aria-label': t('group.commitTrace.expandedTitle'),
                'data-action': 'group-commit-trace',
                onClick: (e) => {
                  if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                  toggleGitExpand(groupGitKey, isGroupGitExpanded)
                },
                style: {
                  background: 'transparent',
                  border: 'none',
                  padding: 0,
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                },
              }, h(Badge, {
                tone: 'neutral',
                icon: GitCommit,
                style: { fontSize: 9, padding: '1px 5px', cursor: 'pointer' },
              }, groupCommitCount > 0 ? String(groupCommitCount) : null))
            : null),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 } },
          h('button', {
            type: 'button',
            onClick: () => handleTogglePinGroup(group.id),
            title: group.pinned ? t('group.pinLocked') : t('group.pinUnlocked'),
            style: {
              background: 'transparent',
              border: 'none',
              padding: '2px 4px',
              cursor: 'pointer',
              color: group.pinned ? 'var(--dsw-alias-state-warn-primary, #ebcb8b)' : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
              display: 'flex',
              alignItems: 'center',
            },
          },
            h(PushPinSimple, { size: 13, filled: Boolean(group.pinned) })),
          // Wrap-up writes reviewStatus=resolved for the whole batch. It used to be a
          // bare one-click text button; now it is icon+label and requires an inline
          // two-step confirmation that states how many findings will be settled.
          wrapUpConfirmId === group.id
            ? h('div', { key: 'wrap-up-confirm', style: { display: 'flex', alignItems: 'center', gap: 4 } },
                h('span', {
                  style: { fontSize: 10, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #a3be8c))' },
                }, (wrapUpResolvableCount > 0
                  ? countText(t('group.wrapUpConfirm'), wrapUpResolvableCount)
                  : t('group.wrapUpConfirmNothing'))
                  + (wrapUpIgnoredCount > 0 ? t('group.wrapUpConfirmIgnored').replace('{count}', String(wrapUpIgnoredCount)) : '')),
                h('button', {
                  key: 'wrap-up-yes',
                  type: 'button',
                  onClick: () => { setWrapUpConfirmId(null); handleArchiveGroup(group.id) },
                  title: t('group.wrapUpConfirmYes'),
                  'aria-label': t('group.wrapUpConfirmYes'),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: 10,
                    fontWeight: 600,
                    cursor: 'pointer',
                    background: nordTint(NORD.nord14, 0.28),
                    border: `1px solid ${nordTint(NORD.nord14, 0.75)}`,
                    color: 'var(--dsw-alias-state-success-primary, #a3be8c)',
                  },
                }, h(CheckCircle, { size: 12 }), t('group.wrapUpConfirmYes')),
                h('button', {
                  key: 'wrap-up-cancel',
                  type: 'button',
                  onClick: () => setWrapUpConfirmId(null),
                  title: t('group.wrapUpCancel'),
                  'aria-label': t('group.wrapUpCancel'),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '2px 8px',
                    borderRadius: 6,
                    fontSize: 10,
                    cursor: 'pointer',
                    background: 'transparent',
                    border: '1px solid var(--pd-border-subtle, rgba(255, 255, 255, 0.18))',
                    color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                  },
                }, h(X, { size: 12 }), t('group.wrapUpCancel')))
            : h('span', {
                style: { display: 'inline-flex' },
                ...(wrapUpTip ? { tip: wrapUpTip } : {}),
              }, h('button', {
                type: 'button',
                disabled: wrapUpDisabled,
                onClick: () => { if (!wrapUpDisabled) setWrapUpConfirmId(group.id) },
                title: wrapUpTip || t('group.wrapUpAria'),
                'aria-label': wrapUpTip || t('group.wrapUpAria'),
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  padding: '2px 8px',
                  borderRadius: 6,
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: wrapUpDisabled ? 'not-allowed' : 'pointer',
                  opacity: wrapUpDisabled ? 0.55 : 1,
                  background: isCompleted ? nordTint(NORD.nord14, 0.10) : 'transparent',
                  border: isCompleted ? `1px solid ${nordTint(NORD.nord14, 0.40)}` : `1px solid ${nordTint(NORD.nord14, 0.28)}`,
                  color: 'var(--dsw-alias-state-success-primary, #a3be8c)',
                  transition: 'background 0.15s ease, border-color 0.15s ease',
                },
              }, h(CheckCircle, { size: 12 }), t('group.wrapUpAction'))),
          h(Button, {
            variant: 'icon',
            icon: isGroupExpanded ? CaretDown : CaretRight,
            title: isGroupExpanded ? t('finding.collapse') : t('finding.expand'),
            onClick: () => toggleExpand(`group-${group.id}`),
          }))),
      groupTraces.length > 0 && isGroupGitExpanded
        ? h('div', { style: { padding: '0 8px 6px' } },
            renderTraceDetailsBlock(groupTraces, { headerTitle: t('group.commitTrace.expandedTitle') }))
        : null,
      // Group Items (rendered when group expanded)
      isGroupExpanded
        ? (groupFindings.length === 0
            ? h('div', { style: { padding: '10px 12px', fontSize: 11, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                t('group.empty'))
            : h('div', { style: { display: 'flex', flexDirection: 'column' } },
                groupFindings.map((f, idx) => renderFindingItem(f, { inGroup: true, last: idx === groupFindings.length - 1 }))))
        : null)
    }

    const turnActionItems = Array.isArray(turnActionsState?.items) ? turnActionsState.items : []
    // The group header previews the prompt submitted for that turn. PromptLog
    // is already loaded for the submitted tab; reuse it instead of another call.
    const turnActionPrompts = React.useMemo(() => {
      const map = new Map()
      for (const row of Array.isArray(log) ? log : []) {
        if (!row || typeof row.turn !== 'number' || map.has(row.turn)) continue
        const text = typeof row.promptText === 'string' && row.promptText.trim()
          ? row.promptText
          : (typeof row.excerpt === 'string' ? row.excerpt : '')
        if (text.trim()) map.set(row.turn, text)
      }
      return map
    }, [log])
    const actionsPendingCount = React.useMemo(() => {
      return turnActionItems.filter(item => item && item.status === 'open' && (item.confidence === 'high' || !item.confidence)).length
    }, [turnActionItems])
    const submittedCount = log.length

    const isBottomOpen = bottomSectionOpen && submittedLogOpen
    const toggleBottomOpen = () => {
      setBottomSectionOpen(open => {
        const next = !open
        setSubmittedLogOpen(next)
        return next
      })
    }

    const hasActions = turnActionItems.length > 0
    const hasSubmitted = submittedCount > 0

    let submitted = null
    if (!hasActions && !hasSubmitted) {
      submitted = null
    } else if (!hasActions && hasSubmitted) {
      // Actions=0 & Submitted>0: Single Submitted section
      submitted = h('div', {
        id: 'submittedSection',
        style: SUBMITTED_SECTION_STYLE(isBottomOpen),
      },
        h('div', {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': isBottomOpen,
          title: isBottomOpen ? t('finding.collapse') : t('finding.expand'),
          onClick: toggleBottomOpen,
          onKeyDown: event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggleBottomOpen()
          },
          style: SUBMITTED_HEADER_STYLE,
        },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            isBottomOpen ? h(CaretDown, { size: 12 }) : h(CaretRight, { size: 12 }),
            t('submitted.title')),
          h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { style: SUBMITTED_COUNT_STYLE }, String(submittedCount)),
            h('button', {
              type: 'button',
              disabled: isRescanningActions,
              title: t('turnActions.action.rescan'),
              'aria-label': t('turnActions.action.rescan'),
              onClick: handleRescanActions,
              style: {
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                cursor: isRescanningActions ? 'not-allowed' : 'pointer',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 4,
              },
            }, isRescanningActions ? h(CircleNotch, { size: 12, className: 'ph-spin' }) : h(ArrowCounterClockwise, { size: 12 })))),
        isBottomOpen ? h(SubmittedList, { entries: log }) : null)
    } else if (hasActions && !hasSubmitted) {
      // Actions>0 & Submitted=0: Single Actions section
      submitted = h('div', {
        id: 'turnActionsSection',
        style: SUBMITTED_SECTION_STYLE(isBottomOpen),
      },
        h('div', {
          role: 'button',
          tabIndex: 0,
          'aria-expanded': isBottomOpen,
          title: isBottomOpen ? t('finding.collapse') : t('finding.expand'),
          onClick: toggleBottomOpen,
          onKeyDown: event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            toggleBottomOpen()
          },
          style: SUBMITTED_HEADER_STYLE,
        },
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            isBottomOpen ? h(CaretDown, { size: 12 }) : h(CaretRight, { size: 12 }),
            t('turnActions.tabActions')),
          h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { style: SUBMITTED_COUNT_STYLE }, String(actionsPendingCount)),
            h('button', {
              type: 'button',
              disabled: isRescanningActions,
              title: t('turnActions.action.rescan'),
              'aria-label': t('turnActions.action.rescan'),
              onClick: handleRescanActions,
              style: {
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                cursor: isRescanningActions ? 'not-allowed' : 'pointer',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 4,
              },
            }, isRescanningActions ? h(CircleNotch, { size: 12, className: 'ph-spin' }) : h(ArrowCounterClockwise, { size: 12 })))),
        isBottomOpen
          ? h(ActionCardList, {
              items: turnActionItems,
              turnPrompts: turnActionPrompts,
              onConfirm: handleConfirmAction,
              onDismiss: handleDismissAction,
              onUndo: handleUndoAction,
              onRevealQuestion: handleRevealQuestion,
              onViewContext: handleViewContext,
              onViewFinding: handleViewFinding,
              highlightedId: highlightedActionId,
            })
          : null)
    } else {
      // Actions>0 & Submitted>0: Tabbed Container (default tab is 'actions')
      const isActionsActive = activeBottomTab === 'actions'
      submitted = h('div', {
        id: 'turnActionsAndSubmittedSection',
        style: SUBMITTED_SECTION_STYLE(isBottomOpen),
      },
        h('div', {
          'data-testid': 'turn-actions-tabs',
          style: {
            ...SUBMITTED_HEADER_STYLE,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '4px 8px',
          },
        },
          h('div', {
            role: 'tablist',
            'aria-label': 'Bottom section tabs',
            style: { display: 'inline-flex', alignItems: 'center', gap: 4 },
          },
            h('button', {
              role: 'tab',
              type: 'button',
              'aria-selected': isActionsActive,
              'data-tab': 'actions',
              onClick: () => {
                setActiveBottomTab('actions')
                setBottomSectionOpen(true)
                setSubmittedLogOpen(true)
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                borderRadius: 6,
                border: 'none',
                background: isActionsActive ? 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(136, 192, 208, 0.16)))' : 'transparent',
                color: isActionsActive ? 'var(--pd-accent, var(--dsw-alias-label-primary, #88c0d0))' : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                fontWeight: isActionsActive ? 600 : 500,
                fontSize: 11,
                cursor: 'pointer',
              },
            },
              h('span', null, t('turnActions.tabActions')),
              h('span', { style: SUBMITTED_COUNT_STYLE }, String(actionsPendingCount))),
            h('span', { style: { color: 'var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))', fontSize: 10 } }, '│'),
            h('button', {
              role: 'tab',
              type: 'button',
              'aria-selected': !isActionsActive,
              'data-tab': 'submitted',
              onClick: () => {
                setActiveBottomTab('submitted')
                setBottomSectionOpen(true)
                setSubmittedLogOpen(true)
              },
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 8px',
                borderRadius: 6,
                border: 'none',
                background: !isActionsActive ? 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(136, 192, 208, 0.16)))' : 'transparent',
                color: !isActionsActive ? 'var(--pd-accent, var(--dsw-alias-label-primary, #88c0d0))' : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                fontWeight: !isActionsActive ? 600 : 500,
                fontSize: 11,
                cursor: 'pointer',
              },
            },
              h('span', null, t('turnActions.tabSubmitted')),
              h('span', { style: SUBMITTED_COUNT_STYLE }, String(submittedCount)))),
          h('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('button', {
              type: 'button',
              disabled: isRescanningActions,
              title: t('turnActions.action.rescan'),
              'aria-label': t('turnActions.action.rescan'),
              onClick: handleRescanActions,
              style: {
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                cursor: isRescanningActions ? 'not-allowed' : 'pointer',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 4,
              },
            }, isRescanningActions ? h(CircleNotch, { size: 12, className: 'ph-spin' }) : h(ArrowCounterClockwise, { size: 12 })),
            h('button', {
              type: 'button',
              'aria-expanded': isBottomOpen,
              title: isBottomOpen ? t('finding.collapse') : t('finding.expand'),
              onClick: toggleBottomOpen,
              style: {
                background: 'transparent',
                border: 'none',
                padding: '2px 4px',
                cursor: 'pointer',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                display: 'inline-flex',
                alignItems: 'center',
              },
            }, isBottomOpen ? h(CaretDown, { size: 12 }) : h(CaretRight, { size: 12 })))),

        isBottomOpen
          ? h('div', {
              role: 'tabpanel',
              style: { padding: '4px 0' },
            },
              isActionsActive
                ? h(ActionCardList, {
                    items: turnActionItems,
                    turnPrompts: turnActionPrompts,
                    onConfirm: handleConfirmAction,
                    onDismiss: handleDismissAction,
                    onUndo: handleUndoAction,
                    onRevealQuestion: handleRevealQuestion,
                    onViewContext: handleViewContext,
                    onViewFinding: handleViewFinding,
                    highlightedId: highlightedActionId,
                  })
                : h(SubmittedList, { entries: log }))
          : null)
    }

    const editingEntry = editingFindingId ? findingsMap.get(editingFindingId) : null
    const editingNumber = editingEntry?.thoughtNo || 1

    const renderImportModal = () => {
      const currentSource = otherSessionsData.find(s => s.sessionId === importSourceSessionId) || otherSessionsData[0]
      const currentFindings = currentSource ? currentSource.findings : []
      const allSelected = currentFindings.length > 0 && currentFindings.every(f => importSelectedIds.has(f.id))
      const selectedCount = currentFindings.filter(f => importSelectedIds.has(f.id)).length

      const currentActionSource = archivedActionsData.find(s => s.sessionId === importSourceActionSessionId) || archivedActionsData[0]
      const currentActionItems = currentActionSource ? currentActionSource.items : []
      const allActionsSelected = currentActionItems.length > 0 && currentActionItems.every(it => importSelectedActionIds.has(it.id || itemOriginKey(it)))
      const selectedActionCount = currentActionItems.filter(it => importSelectedActionIds.has(it.id || itemOriginKey(it))).length

      return h('div', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('pool.importTitle'),
        onClick: e => {
          if (e.target === e.currentTarget && !importing) {
            setIsImportModalOpen(false)
            setImportNotice(null)
          }
        },
        style: {
          position: 'absolute',
          inset: 0,
          background: nordTint(NORD.nord0, 0.42),
          backdropFilter: 'blur(2px)',
          zIndex: 80,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 12,
        },
      },
        h('div', {
          style: {
            background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
            border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
            borderRadius: 12,
            boxShadow: `0 12px 28px ${nordTint(NORD.nord0, 0.22)}`,
            width: '100%',
            maxWidth: 420,
            maxHeight: '85%',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        },
          // Header
          h('div', {
            style: {
              padding: '10px 14px',
              borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            },
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
              h(ArrowCounterClockwise, { size: 16, style: { color: 'var(--pd-accent, #88c0d0)' } }),
              h('div', null,
                h('div', { style: { fontWeight: 600, fontSize: 13, color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))' } },
                  t('pool.importTitle')),
                h('div', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', marginTop: 1 } },
                  t('pool.importDesc')))),
            h('button', {
              type: 'button',
              disabled: importing,
              onClick: () => {
                setIsImportModalOpen(false)
                setImportNotice(null)
              },
              style: {
                background: 'transparent',
                border: 'none',
                color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                cursor: importing ? 'not-allowed' : 'pointer',
                fontSize: 14,
                padding: '4px 6px',
                lineHeight: 1,
              },
            }, h(X, { size: 14 }))),

          // Notice
          importNotice
            ? h('div', {
                role: importNotice.error ? 'alert' : 'status',
                style: {
                  padding: '6px 14px',
                  fontSize: 11,
                  background: importNotice.error ? nordTint(NORD.nord11, 0.15) : nordTint(NORD.nord14, 0.15),
                  color: importNotice.error ? NORD.nord11 : NORD.nord14,
                  borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.05)))',
                },
              }, importNotice.text)
            : null,

          // Body
          h('div', {
            style: {
              padding: '12px 14px',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              overflowY: 'auto',
              flex: 1,
              minHeight: 0,
            },
          },
            // Sub-tabs: Unsubmitted Findings vs Archived Turn Actions
            h('div', {
              style: {
                display: 'flex',
                gap: 6,
                padding: '2px',
                background: 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.08)))',
                borderRadius: 8,
              },
            },
              h('button', {
                type: 'button',
                disabled: importing,
                'aria-selected': inheritModalTab === 'findings',
                'data-inherit-tab': 'findings',
                onClick: () => setInheritModalTab('findings'),
                style: {
                  flex: 1,
                  padding: '5px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: inheritModalTab === 'findings' ? 600 : 500,
                  cursor: importing ? 'not-allowed' : 'pointer',
                  border: 'none',
                  background: inheritModalTab === 'findings' ? 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))' : 'transparent',
                  color: inheritModalTab === 'findings' ? 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))' : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                  boxShadow: inheritModalTab === 'findings' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                },
              }, t('turnActions.inheritSourceTabFindings')),
              h('button', {
                type: 'button',
                disabled: importing,
                'aria-selected': inheritModalTab === 'actions',
                'data-inherit-tab': 'actions',
                onClick: () => setInheritModalTab('actions'),
                style: {
                  flex: 1,
                  padding: '5px 10px',
                  borderRadius: 6,
                  fontSize: 11,
                  fontWeight: inheritModalTab === 'actions' ? 600 : 500,
                  cursor: importing ? 'not-allowed' : 'pointer',
                  border: 'none',
                  background: inheritModalTab === 'actions' ? 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))' : 'transparent',
                  color: inheritModalTab === 'actions' ? 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))' : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                  boxShadow: inheritModalTab === 'actions' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none',
                },
              }, t('turnActions.inheritTab'))),

            // Inheritance scope: persisted preference with modal-level instant switching
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              h('label', {
                style: { fontSize: 11, fontWeight: 500, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))' },
              }, t('pool.importScope')),
              h('div', { style: { display: 'flex', gap: 6 } },
                ...[['workspace', t('pool.importScopeWorkspace')], ['all', t('pool.importScopeAll')]].map(([value, label]) => {
                  const active = inheritScope === value
                  return h('button', {
                    key: value,
                    type: 'button',
                    disabled: importing,
                    'aria-pressed': active,
                    onClick: () => {
                      if (active || importing) return
                      setInheritScope(value)
                      Promise.resolve(persistInheritScope(services.store, value))
                        .then(next => {
                          if (mounted.current) {
                            setInheritScope(next)
                            setPanePrefs(prev => ({ ...prev, inheritScope: next }))
                          }
                        })
                        .catch(() => {})
                    },
                    style: {
                      padding: '3px 10px',
                      borderRadius: 12,
                      fontSize: 11,
                      cursor: importing ? 'not-allowed' : 'pointer',
                      background: active ? nordTint(NORD.nord8, 0.16) : 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                      border: active ? '1px solid ' + nordTint(NORD.nord8, 0.55) : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12)))',
                      color: active ? NORD.nord8 : 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
                      fontWeight: active ? 600 : 500,
                    },
                  }, label)
                })),
              inheritScope === 'all'
                ? h('div', {
                    style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' },
                  }, t('pool.importScopeHint'))
                : null),

            inheritModalTab === 'actions'
              ? [
                  // Source archived session selection
                  h('div', { key: 'action-source', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('label', {
                      style: { fontSize: 11, fontWeight: 500, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))' },
                    }, t('pool.importSourceSession')),
                    archivedActionsData.length === 0
                      ? h('div', {
                          style: {
                            fontSize: 11,
                            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                            padding: '12px 8px',
                            textAlign: 'center',
                            background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                            borderRadius: 6,
                          },
                        }, t('turnActions.inheritEmpty'))
                      : h('select', {
                          value: importSourceActionSessionId || (archivedActionsData[0]?.sessionId || ''),
                          disabled: importing,
                          onChange: e => {
                            const newSid = e.target.value
                            setImportSourceActionSessionId(newSid)
                            const target = archivedActionsData.find(s => s.sessionId === newSid)
                            if (target) {
                              setImportSelectedActionIds(new Set(target.items.map(it => it.id || itemOriginKey(it))))
                            } else {
                              setImportSelectedActionIds(new Set())
                            }
                          },
                          style: {
                            padding: '6px 10px',
                            fontSize: 12,
                            borderRadius: 6,
                            border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                            background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                            color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))',
                            outline: 'none',
                          },
                        },
                          archivedActionsData.map(s =>
                            h('option', { key: s.sessionId, value: s.sessionId }, `${s.title} (${s.items.length})`)))),

                  // Actions list
                  currentActionItems.length > 0
                    ? h('div', { key: 'action-items', style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                        // Select all header
                        h('div', {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '4px 2px',
                            fontSize: 11,
                            color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
                          },
                        },
                          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
                            h('input', {
                              type: 'checkbox',
                              checked: allActionsSelected,
                              disabled: importing,
                              onChange: () => {
                                if (allActionsSelected) {
                                  setImportSelectedActionIds(new Set())
                                } else {
                                  setImportSelectedActionIds(new Set(currentActionItems.map(it => it.id || itemOriginKey(it))))
                                }
                              },
                              style: { cursor: 'pointer', margin: 0 },
                            }),
                            h('span', null, allActionsSelected ? t('pool.importDeselectAll') : t('pool.importSelectAll'))),
                          h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                            t('turnActions.inheritSelectedCount').replace('{selected}', String(selectedActionCount)).replace('{total}', String(currentActionItems.length)))),

                        // Action cards list
                        h('div', {
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            maxHeight: 220,
                            overflowY: 'auto',
                            paddingRight: 2,
                          },
                        },
                          currentActionItems.map(item => {
                            const itemKey = item.id || itemOriginKey(item)
                            const isChecked = importSelectedActionIds.has(itemKey)
                            return h('label', {
                              key: itemKey,
                              style: {
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 6,
                                background: isChecked ? nordTint(NORD.nord8, 0.08) : 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                                border: isChecked ? `1px solid ${nordTint(NORD.nord8, 0.35)}` : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                                cursor: importing ? 'not-allowed' : 'pointer',
                                transition: 'all 0.15s ease',
                              },
                            },
                              h('input', {
                                type: 'checkbox',
                                checked: isChecked,
                                disabled: importing,
                                onChange: () => {
                                  setImportSelectedActionIds(prev => {
                                    const next = new Set(prev)
                                    if (next.has(itemKey)) next.delete(itemKey)
                                    else next.add(itemKey)
                                    return next
                                  })
                                },
                                style: { cursor: 'pointer', marginTop: 2 },
                              }),
                              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 } },
                                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                                  h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                                    `Turn ${item.turn || 0}`),
                                  h(Badge, {
                                    tone: KIND_TONES[item.kind] || 'neutral',
                                    style: { fontSize: 9, padding: '1px 4px' },
                                  }, t(KIND_LOCALE_KEYS[item.kind] || 'turnActions.kind.confirm')),
                                  item.confidence
                                    ? h(Badge, { tone: 'neutral', style: { fontSize: 9, padding: '1px 4px' } }, t(item.confidence === 'high' ? 'turnActions.confidenceHigh' : 'turnActions.confidenceMedium'))
                                    : null),
                                h('div', {
                                  style: {
                                    fontSize: 11,
                                    fontWeight: 600,
                                    color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  },
                                }, item.title || t('entry.untitled')),
                                item.quote
                                  ? h('div', {
                                      style: {
                                        fontSize: 10,
                                        color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                      },
                                    }, item.quote)
                                  : null))
                          })))
                    : null
                ]
              : [
                  // Source session selection
                  h('div', { key: 'findings-source', style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    h('label', {
                      style: { fontSize: 11, fontWeight: 500, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))' },
                    }, t('pool.importSourceSession')),
                    otherSessionsData.length === 0
                      ? h('div', {
                          style: {
                            fontSize: 11,
                            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                            padding: '12px 8px',
                            textAlign: 'center',
                            background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                            borderRadius: 6,
                          },
                        }, t('pool.importEmptySource'))
                      : h('select', {
                          value: importSourceSessionId || (otherSessionsData[0]?.sessionId || ''),
                          disabled: importing,
                          onChange: e => {
                            const newSid = e.target.value
                            setImportSourceSessionId(newSid)
                            const target = otherSessionsData.find(s => s.sessionId === newSid)
                            if (target) {
                              setImportSelectedIds(new Set(target.findings.map(f => f.id)))
                            } else {
                              setImportSelectedIds(new Set())
                            }
                          },
                          style: {
                            padding: '6px 10px',
                            fontSize: 12,
                            borderRadius: 6,
                            border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                            background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                            color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))',
                            outline: 'none',
                          },
                        },
                          otherSessionsData.map(s =>
                            h('option', { key: s.sessionId, value: s.sessionId }, `${s.title} (${s.findings.length})`)))),

                  // Findings list
                  currentFindings.length > 0
                    ? h('div', { key: 'findings-items', style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 } },
                        // Select all header
                        h('div', {
                          style: {
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '4px 2px',
                            fontSize: 11,
                            color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
                          },
                        },
                          h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' } },
                            h('input', {
                              type: 'checkbox',
                              checked: allSelected,
                              disabled: importing,
                              onChange: () => {
                                if (allSelected) {
                                  setImportSelectedIds(new Set())
                                } else {
                                  setImportSelectedIds(new Set(currentFindings.map(f => f.id)))
                                }
                              },
                              style: { cursor: 'pointer', margin: 0 },
                            }),
                            h('span', null, allSelected ? t('pool.importDeselectAll') : t('pool.importSelectAll'))),
                          h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                            t('pool.importSelectedCount').replace('{selected}', String(selectedCount)).replace('{total}', String(currentFindings.length)))),

                        // Findings cards
                        h('div', {
                          style: {
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 6,
                            maxHeight: 220,
                            overflowY: 'auto',
                            paddingRight: 2,
                          },
                        },
                          currentFindings.map((f, idx) => {
                            const isChecked = importSelectedIds.has(f.id)
                            const tagKey = f.tag || f.severity || 'optimize'
                            const tagStyle = getTagStyle(tagKey, tagCustomIndex(tagKey), tagExplicitColor(tagKey))
                            const tagText = tagLabelOf(tagKey)
                            const contentText = f.title || f.text || f.body || f.summary || ''

                            return h('label', {
                              key: f.id,
                              style: {
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 8,
                                padding: '6px 8px',
                                borderRadius: 6,
                                background: isChecked ? nordTint(NORD.nord8, 0.08) : 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                                border: isChecked ? `1px solid ${nordTint(NORD.nord8, 0.35)}` : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                                cursor: importing ? 'not-allowed' : 'pointer',
                                transition: 'all 0.15s ease',
                              },
                            },
                              h('input', {
                                type: 'checkbox',
                                checked: isChecked,
                                disabled: importing,
                                onChange: () => {
                                  setImportSelectedIds(prev => {
                                    const next = new Set(prev)
                                    if (next.has(f.id)) next.delete(f.id)
                                    else next.add(f.id)
                                    return next
                                  })
                                },
                                style: { cursor: 'pointer', marginTop: 2 },
                              }),
                              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 } },
                                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                                  h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                                    `#${idx + 1}`),
                                  h('span', {
                                    style: {
                                      ...tagStyle,
                                      padding: '1px 5px',
                                      borderRadius: 4,
                                      fontSize: 9,
                                      fontWeight: 600,
                                    },
                                  }, tagText)),
                                h('div', {
                                  style: {
                                    fontSize: 11,
                                    color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  },
                                }, contentText || t('entry.untitled'))))
                          })))
                    : null
                ]),

          // Footer Actions
          h('div', {
            style: {
              padding: '10px 14px',
              borderTop: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
              background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              gap: 8,
            },
          },
            inheritModalTab === 'actions'
              ? [
                  h(Button, {
                    key: 'cancel',
                    variant: 'ghost',
                    disabled: importing,
                    onClick: () => {
                      setIsImportModalOpen(false)
                      setImportNotice(null)
                    },
                    style: { padding: '4px 10px', fontSize: 11 },
                  }, t('finding.cancel')),
                  currentActionSource?.crossWorkspace
                    ? h(Button, {
                        key: 'copy',
                        variant: 'primary',
                        disabled: selectedActionCount === 0 || importing || sessionArchived,
                        tip: t('pool.importCrossWorkspaceCopyOnly'),
                        onClick: handleInheritActionsConfirm,
                        style: { padding: '4px 10px', fontSize: 11, fontWeight: 600 },
                      }, `${t('turnActions.inheritModeCopy')}${selectedActionCount > 0 ? ` (${selectedActionCount})` : ''}`)
                    : h(Button, {
                        key: 'confirm',
                        variant: 'primary',
                        disabled: selectedActionCount === 0 || importing || sessionArchived,
                        onClick: handleInheritActionsConfirm,
                        style: { padding: '4px 10px', fontSize: 11, fontWeight: 600 },
                      }, `${(inheritScope === 'workspace' ? t('turnActions.inheritModeMove') : t('turnActions.inheritModeCopy'))}${selectedActionCount > 0 ? ` (${selectedActionCount})` : ''}`),
                ]
              : [
                  h(Button, {
                    key: 'cancel',
                    variant: 'ghost',
                    disabled: importing,
                    onClick: () => {
                      setIsImportModalOpen(false)
                      setImportNotice(null)
                    },
                    style: { padding: '4px 10px', fontSize: 11 },
                  }, t('finding.cancel')),
                  h(Button, {
                    key: 'copy',
                    variant: 'default',
                    disabled: selectedCount === 0 || importing || sessionArchived,
                    onClick: () => handleExecuteInherit('copy'),
                    style: { padding: '4px 10px', fontSize: 11 },
                  }, `${t('pool.importCopyAction')}${selectedCount > 0 ? ` (${selectedCount})` : ''}`),
                  h(Button, {
                    key: 'move',
                    variant: 'primary',
                    disabled: selectedCount === 0 || importing || sessionArchived || Boolean(currentSource?.crossWorkspace),
                    tip: currentSource?.crossWorkspace ? t('pool.importCrossWorkspaceCopyOnly') : undefined,
                    onClick: () => handleExecuteInherit('move'),
                    style: { padding: '4px 10px', fontSize: 11, fontWeight: 600 },
                  }, `${t('pool.importMoveAction')}${selectedCount > 0 ? ` (${selectedCount})` : ''}`),
                ])))
    }

    // Maintenance-window bar copy (spec §10.4): one line per derivation reason.
    // The ready variant shows the remaining auto-unlock minutes; the expired
    // variant tells the user submissions resumed and where to apply the plan.
    const distillBarText = distillLock.reason === 'ready'
      ? t('distill.lock.barReady').replace('{minutes}', String(Math.max(1, Math.ceil(((distillLock.expiresAt ?? Date.now()) - Date.now()) / 60000))))
      : distillLock.reason === 'ready-ttl-expired'
        ? t('distill.lock.barReadyExpired')
        : distillLock.reason === 'pre-analysis'
          ? t('distill.lock.barPreparing')
          : t('distill.lock.barAnalyzing')

    return h('div', { style: PANE_CONTAINER_STYLE, ref: paneRef },
      // 1. Drawer Header
      h('div', { style: DRAWER_HEADER_STYLE },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h(PunchDeskLogoMono, { size: 18, color: 'currentColor' }),
          h('h3', { style: { margin: 0, fontSize: 13, fontWeight: 700 } }, t('desk.title'))),
        sessionArchived
          ? h(Badge, {
              tone: 'warn',
              tip: t('session.archivedLocked'),
              style: { fontSize: 10, padding: '1px 6px' },
            }, t('session.archivedBadge'))
          : null,
        h('div', {
          id: 'drawerHeaderStatus',
          tip: (needsWrapUp && awaitingWrapUpCount === 0)
            ? t('pool.needsWrapUpGroups').replace('{groups}', String(headerWork.awaitingGroups || 1))
            : t('pool.quickStatusHint')
            .replace('{active}', String(activeGroupItemsCount))
            .replace('{wrapUp}', String(awaitingWrapUpCount))
            .replace('{executing}', String(executingItemsCount))
            .replace('{total}', String(totalOpenCount))
            .replace('{draft}', String(openPoolEntries.length)),
          style: {
            padding: '2px 8px',
            borderRadius: 12,
            background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
            border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
            fontSize: 11,
            fontFamily: 'monospace',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexWrap: 'wrap',
          },
        },
          h('span', {
            className: breathing ? 'pd-breathe' : undefined,
            title: breathing ? t('pool.executingNow').replace('{count}', String(executingItemsCount)) : undefined,
            style: {
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: statusColor,
            },
          }),
          h('strong', { style: { color: statusTextColor } }, `${activeGroupItemsCount}/${totalOpenCount}`),
          h('span', { style: { fontSize: 9, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))', whiteSpace: 'nowrap' }, tip: t('group.statsTip') },
            t('group.statsSubmitted').replace('{count}', String(headerWork.statusCounts?.submitted || 0))),
          h('span', { style: { fontSize: 9, color: 'var(--pd-status-warn-text, #7a5a00)', whiteSpace: 'nowrap' } },
            t('group.statsAwaiting').replace('{count}', String(headerWork.statusCounts?.awaitingReview || 0))),
          h('span', { style: { fontSize: 9, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', whiteSpace: 'nowrap' } },
            t('group.statsCompleted').replace('{count}', String(headerWork.statusCounts?.completed || 0))),
          breathing
            ? h('span', {
                style: {
                  fontSize: 9,
                  fontWeight: 600,
                  color: 'var(--pd-status-running-text, #0a6b36)',
                },
              }, t('pool.executingNow').replace('{count}', String(executingItemsCount)))
            : null,
          needsWrapUp
            ? h('span', {
                style: {
                  fontSize: 9,
                  fontWeight: 600,
                  color: 'var(--pd-status-warn-text, #7a5a00)',
                },
              }, awaitingGroupsCount > 0
                ? t('pool.awaitingWrapUpGroups').replace('{groups}', String(awaitingGroupsCount))
                : t('pool.awaitingWrapUp'))
            : null)),

      // 1.5 Distillation maintenance window bar (spec §10.4): resident while
      // the drawer is open, scoped to this workspace only, with the explicit
      // 「取消本次精炼」 exit. Honest boundary (tip): it pauses plugin submission
      // entries only — the host's main input box keeps working.
      distillLock.run
        ? h('div', {
            id: 'distillLockBar',
            tip: t('distill.lock.honestBoundary'),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              fontSize: 11,
              color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #4c566a))',
              background: distillLock.locked
                ? nordTint(NORD.nord13, 0.12)
                : 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
              borderLeft: distillLock.locked ? `3px solid ${NORD.nord13}` : '3px solid transparent',
              borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
            },
          },
            h(Brain, { size: 13, color: 'currentColor' }),
            h('span', { style: { flex: 1, minWidth: 0 } }, distillBarText),
            h(Button, {
              icon: X,
              disabled: distillCancelBusy,
              onClick: handleCancelDistill,
              title: t('distill.lock.cancel'),
              style: { fontSize: 10, padding: '3px 8px', flexShrink: 0 },
            }, t('distill.lock.cancel')))
        : null,

      // 2. Master Input Composer
      h('div', { style: COMPOSER_BOX_STYLE },
        editingFindingId
          ? h('div', { style: EDIT_RIBBON_STYLE },
              h('span', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                h(PencilSimple, { size: 13 }),
                h('span', null, t('composer.editingRibbon').replace('{number}', String(editingNumber)))),
              h('button', {
                type: 'button',
                onClick: cancelEditingCard,
                style: {
                  background: 'transparent',
                  border: 'none',
                  color: NORD.nord12,
                  fontSize: 11,
                  textDecoration: 'underline',
                  cursor: 'pointer',
                  padding: 0,
                },
              }, t('finding.cancel')))
          : null,
        renderPopover(),
        h('textarea', {
          ref: textareaRef,
          className: neonArmed ? NEON_CLASS : undefined,
          value: text,
          placeholder: t('composer.placeholder'),
          onChange: e => {
            const val = e.target.value
            setText(val)
            if (captureError) setCaptureError('')
            checkPopover(val, e.target.selectionStart)
          },
          onKeyDown: handleTextareaKeyDown,
          onClick: e => checkPopover(e.target.value, e.target.selectionStart),
          onKeyUp: e => {
            if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter' && e.key !== 'Tab' && e.key !== 'Escape') {
              checkPopover(e.target.value, e.target.selectionStart)
            }
          },
          rows: panePrefs.composerRows ?? 4,
          style: COMPOSER_TEXTAREA_STYLE,
        }),
        anchors.length > 0
          ? h('div', { style: ANCHOR_HINT_STYLE },
              h(Badge, {
                tone: 'info',
                icon: (anchors[0]?.type === 'quote' || anchors[0]?.kind === 'quote') ? ChatTeardropText : Clock,
                ...(typeof anchors[0]?.text === 'string' && anchors[0].text.trim() !== ''
                  ? { tip: anchors[0].text.trim() }
                  : {}),
              }, `${t('capture.anchor')} · ${anchorText(anchors[0], t)}`))
          : null,
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              tagCatalog.map(def => {
                const isSelected = selectedTag === def.key
                return h('button', {
                  key: def.key,
                  type: 'button',
                  onClick: () => setSelectedTag(def.key),
                  style: getTagPillStyle(def.key, isSelected, tagCustomIndex(def.key), tagExplicitColor(def.key)),
                }, formatTagLabel(def.label))
              })),
            text.length > 0
              ? h('span', {
                  style: {
                    fontSize: 10,
                    fontFamily: 'monospace',
                    color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                    padding: '2px 4px',
                    borderRadius: 4,
                  },
                  tip: t('composer.charCount'),
                }, countText(t('composer.charCountValue'), text.length))
              : null),
          (() => {
            const saveDisabled = text.trim() === '' || busy
            return h(Button, {
              variant: 'primary',
              icon: editingFindingId ? CheckCircle : Plus,
              disabled: saveDisabled,
              onClick: handleSaveComposer,
              style: {
                background: saveDisabled ? 'var(--pd-merge-btn-disabled-bg, rgba(0, 0, 0, 0.06))' : 'var(--pd-accent, #5e81ac)',
                color: saveDisabled ? 'var(--pd-merge-btn-disabled-fg, #4c566a)' : 'var(--pd-accent-fg, #ffffff)',
                fontWeight: saveDisabled ? 500 : 700,
                border: saveDisabled ? 'var(--pd-merge-btn-disabled-border, 1px solid rgba(0, 0, 0, 0.12))' : '1px solid var(--pd-accent, #5e81ac)',
                opacity: 1,
              },
            }, editingFindingId ? t('composer.saveChanges') : t('composer.saveToPool'))
          })())),

      // Alerts / Notifications
      captureError
        ? h('div', { role: 'alert', style: { padding: '6px 12px', background: nordTint(NORD.nord11, 0.15), color: NORD.nord11, fontSize: 11 } }, captureError)
        : null,
      notice
        ? h('div', {
            role: notice.error ? 'alert' : 'status',
            ...(notice.tip ? { tip: notice.tip } : {}),
            style: { padding: '6px 12px', background: notice.error ? nordTint(NORD.nord11, 0.15) : nordTint(NORD.nord14, 0.15), color: notice.error ? NORD.nord11 : NORD.nord14, fontSize: 11 },
          }, notice.text)
        : null,
      quotaWarning
        ? h('div', { role: 'alert', style: WARNING_STYLE },
            h('div', { style: WARNING_TEXT_STYLE }, t('store.quota')))
        : null,

      // 3. Toolbar: Thought Pool Controls + Expand/Collapse all + Merge selected
      h('div', { style: TOOLBAR_STYLE },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('input', {
            type: 'checkbox',
            id: 'selectAllCheckbox',
            checked: allPoolSelected,
            onChange: toggleSelectAllPool,
            style: { cursor: 'pointer', margin: 0 },
          }),
          h('span', { style: { fontWeight: 500, color: 'var(--dsw-alias-label-secondary, #d8dee9)' } },
            t('pool.draftCount').replace('{count}', String(openPoolEntries.length))),
          actionsPendingCount > 0
            ? h('button', {
                type: 'button',
                'data-action': 'scroll-to-actions',
                onClick: () => {
                  setBottomSectionOpen(true)
                  setSubmittedLogOpen(true)
                  setActiveBottomTab('actions')
                  const el = document.getElementById('turnActionsSection') || document.getElementById('turnActionsAndSubmittedSection')
                  if (el) el.scrollIntoView({ behavior: 'smooth' })
                },
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '1px 6px',
                  borderRadius: 10,
                  fontSize: 10,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: nordTint(NORD.nord13, 0.15),
                  border: `1px solid ${nordTint(NORD.nord13, 0.4)}`,
                  color: NORD.nord13,
                },
                title: t('turnActions.pillPendingCount').replace('{n}', String(actionsPendingCount)),
              },
                h(Clock, { size: 10 }),
                t('turnActions.pillPendingCount').replace('{n}', String(actionsPendingCount)))
            : null),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h(Button, {
            variant: 'default',
            icon: ArrowCounterClockwise,
            title: t('pool.importTitle'),
            onClick: () => {
              loadOtherSessions()
              loadArchivedActions()
              setIsImportModalOpen(true)
            },
            style: { padding: '2px 8px', fontSize: 10 },
          }, t('pool.importBtn')),
          h(Button, {
            variant: 'default',
            icon: isAllExpanded ? CaretDown : CaretRight,
            title: isAllExpanded ? t('finding.collapseAll') : t('finding.expandAll'),
            onClick: toggleAllExpand,
            style: { padding: '2px 8px', fontSize: 10 },
          }, isAllExpanded ? t('finding.collapseAll') : t('finding.expandAll')),
          (() => {
            const canMerge = selectedPoolCount >= 2 && !busy
            return h(Button, {
              variant: canMerge ? 'primary' : 'default',
              icon: GitDiff,
              disabled: !canMerge,
              title: canMerge ? `${t('pool.mergeSelected')} (${selectedPoolCount})` : t('pool.mergeSelected'),
              onClick: handleMergeSelected,
              style: {
                padding: '3px 10px',
                fontSize: 11,
                fontWeight: canMerge ? 700 : 500,
                background: canMerge
                  ? 'var(--pd-merge-btn-solid-bg, linear-gradient(135deg, #88c0d0 0%, #81a1c1 100%))'
                  : 'var(--pd-merge-btn-disabled-bg, rgba(255, 255, 255, 0.06))',
                border: canMerge
                  ? 'var(--pd-merge-btn-solid-border, 1px solid #8fbcbb)'
                  : 'var(--pd-merge-btn-disabled-border, 1px solid rgba(0, 0, 0, 0.12))',
                color: canMerge
                  ? 'var(--pd-merge-btn-solid-fg, #242933)'
                  : 'var(--pd-merge-btn-disabled-fg, var(--dsw-alias-label-secondary, #d8dee9))',
                boxShadow: canMerge
                  ? 'var(--pd-merge-btn-solid-shadow, 0 0 14px rgba(136, 192, 208, 0.6), 0 2px 6px rgba(0, 0, 0, 0.35))'
                  : 'none',
                cursor: canMerge ? 'pointer' : 'not-allowed',
                opacity: canMerge ? 1 : 0.8,
                transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
              },
            }, `${t('pool.mergeSelected')}${canMerge ? ` (${selectedPoolCount})` : ''}`)
          })(),
          h(Button, {
            variant: 'ghost',
            icon: Trash,
            title: t('clear.tooltip'),
            onClick: handleOpenClearModal,
            style: {
              padding: '2px 6px',
              fontSize: 10,
              color: 'var(--dsw-alias-state-danger-primary, #bf616a)',
              border: `1px solid ${nordTint(NORD.nord11, 0.25)}`,
              background: nordTint(NORD.nord11, 0.08),
              borderRadius: 6,
            },
          }, t('clear.action')))),

      // 4. Cards Stream: Active Groups + Draft Pool
      h('div', { style: STREAM_CONTAINER_STYLE, id: 'cardsListContainer' },
        // Active Groups section
        activeGroups.length > 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              activeGroups.map((group, index) => renderActiveGroup(group, index)))
          : null,

        // Draft pool section
        openPoolEntries.length === 0
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h(Empty, {
                icon: Kanban,
                style: {
                  padding: '24px 12px',
                  border: '1px dashed var(--pd-border-default, var(--dsw-alias-border-l2, #d8dee9))',
                  borderRadius: 10,
                },
              }, t('pool.empty')),
              (() => {
                const totalOtherInheritable = otherSessionsData.reduce((sum, s) => sum + s.findings.length, 0)
                if (totalOtherInheritable > 0) {
                  return h('button', {
                    type: 'button',
                    onClick: () => {
                      loadOtherSessions()
                      loadArchivedActions()
                      setIsImportModalOpen(true)
                    },
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderRadius: 8,
                      border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l2, #d8dee9))',
                      background: 'var(--pd-bg-element, var(--dsw-alias-bg-layer-2, rgba(136, 192, 208, 0.08)))',
                      color: 'var(--pd-accent, #88c0d0)',
                      fontSize: 11,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    },
                  },
                    h(ArrowCounterClockwise, { size: 13 }),
                    h('span', null, t('pool.importPillHint').replace('{count}', String(totalOtherInheritable))))
                }
                return null
              })())
          : h('div', { style: { display: 'flex', flexDirection: 'column' } },
              openPoolEntries.map((f, idx) => renderFindingItem(f, { inGroup: false, last: idx === openPoolEntries.length - 1 }))),

        submitted),

      // 5. Bottom Staging & Real Submission Dock
      h('div', { style: DOCK_STYLE, id: 'submissionDockContainer' },
        // Tweak Popover / Sheet (if toggled)
        showTweakPopover
          ? h('div', { style: TWEAK_POPOVER_STYLE(isMaximizedPopover) },
              // Popover header
              h('div', {
                style: {
                  padding: '8px 12px',
                  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                  borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 11,
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))' } },
                  h(Sliders, { size: 14 }),
                  h('span', null, t('dock.tweakTitle'))),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                  h('button', {
                    type: 'button',
                    onClick: () => setIsMaximizedPopover(prev => !prev),
                    style: {
                      background: 'transparent',
                      border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l2, #d8dee9))',
                      borderRadius: 4,
                      color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                      padding: '2px 6px',
                      fontSize: 10,
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    },
                  },
                    h(ArrowsOut, { size: 11 }),
                    h('span', null, isMaximizedPopover ? t('dock.tweakRestore') : t('dock.tweakMaximize'))),
                  h('button', {
                    type: 'button',
                    onClick: () => setShowTweakPopover(false),
                    style: {
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                      cursor: 'pointer',
                      fontSize: 12,
                    },
                  }, h(X, { size: 14 })))),
              // Popover body
              h('div', { style: { padding: 10, display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 } },
                h('textarea', {
                  value: tweakPromptText,
                  onChange: e => setTweakPromptText(e.target.value),
                  rows: isMaximizedPopover ? 14 : 7,
                  style: {
                    ...COMPOSER_TEXTAREA_STYLE,
                    flex: 1,
                    minHeight: isMaximizedPopover ? 260 : 120,
                  },
                }),
                h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                  h('span', null, t('dock.tweakHint')),
                  h('button', {
                    type: 'button',
                    onClick: () => {
                      if (navigator.clipboard) navigator.clipboard.writeText(tweakPromptText)
                      say(t('dock.promptCopied'))
                    },
                    style: {
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))',
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      fontSize: 10,
                    },
                  }, t('dock.copyPrompt')))),
              // Popover footer
              h('div', {
                style: {
                  padding: '8px 12px',
                  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                  borderTop: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  gap: 8,
                },
              },
                h(Button, {
                  variant: 'ghost',
                  onClick: () => setShowTweakPopover(false),
                  style: { fontSize: 11 },
                }, t('finding.cancel')),
                h(Button, {
                  variant: 'primary',
                  icon: PaperPlaneRight,
                  disabled: busy || !tweakPromptText.trim() || needTarget,
                  onClick: () => requestSubmit('combined', { customPrompt: tweakPromptText }),
                  style: { fontSize: 11 },
                }, t('dock.confirmCombined1Turn'))))
          : null,

        // Row 1: Target Selector (+G1, +G2, ... + 新建组) + 微调指令 button
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11 } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h('span', { style: { fontFamily: 'monospace', color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, t('dock.target')),
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
              activeGroups.map(g => {
                const isSelected = selectedTargetGroupId === g.id
                const loadCount = (g.items || []).length
                const chipHint = t('dock.targetHint')
                  .replace('{target}', 'G' + g.groupNumber)
                  .replace('{count}', String(loadCount))
                return h('button', {
                  key: g.id,
                  type: 'button',
                  onClick: () => {
                    setSelectedTargetGroupId(isSelected ? null : g.id)
                    setCapPopoverOpen(false)
                  },
                  tip: chipHint,
                  'aria-label': chipHint,
                  style: {
                    padding: '2px 7px',
                    borderRadius: 4,
                    fontSize: 11,
                    fontFamily: 'monospace',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    background: isSelected ? 'var(--pd-accent, #5e81ac)' : 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                    border: isSelected ? '1px solid var(--pd-accent, #5e81ac)' : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                    color: isSelected ? 'var(--pd-accent-fg, #ffffff)' : 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                    transition: 'all 0.15s ease',
                  },
                }, '+G' + g.groupNumber,
                h('span', { style: { fontSize: 9, fontWeight: 500, opacity: isSelected ? 0.85 : 0.65 } }, String(loadCount)))
              }),
              h('button', {
                type: 'button',
                disabled: busy,
                'aria-expanded': capPopoverOpen,
                'aria-label': canCreate ? t('group.new') : t('dock.capTitle'),
                tip: canCreate ? undefined : t('dock.capTitle'),
                onClick: () => {
                  if (canCreate) { handleCreateGroup(); setCapPopoverOpen(false); return }
                  setCapPopoverOpen(prev => !prev)
                },
                style: {
                  padding: '2px 7px',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'monospace',
                  fontWeight: 'bold',
                  cursor: busy ? 'not-allowed' : 'pointer',
                  opacity: busy ? 0.5 : 1,
                  background: selectedTargetGroupId === 'new' ? 'var(--pd-accent, #5e81ac)' : 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                  border: selectedTargetGroupId === 'new'
                    ? '1px solid var(--pd-accent, #5e81ac)'
                    : (canCreate ? '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))' : '1px dashed var(--dsw-alias-state-warn-primary, #ebcb8b)'),
                  color: selectedTargetGroupId === 'new' ? 'var(--pd-accent-fg, #ffffff)' : (canCreate ? 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))' : 'var(--dsw-alias-state-warn-primary, #ebcb8b)'),
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  height: 22,
                  minWidth: 26,
                  boxSizing: 'border-box',
                },
              }, h(Plus, { size: 11 })),
              h('span', {
                style: {
                  fontSize: 10,
                  color: activeGroups.length >= 3
                    ? 'var(--dsw-alias-state-warn-primary, #ebcb8b)'
                    : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                },
              }, t('dock.capUsage').replace('{used}', String(activeGroups.length)).replace('{limit}', '3')),
              breathing
                ? h('span', {
                    className: 'pd-breathe',
                    tip: t('dock.executingHint').replace('{count}', String(headerWork.executingGroups)),
                    'aria-label': t('dock.executingHint').replace('{count}', String(headerWork.executingGroups)),
                    style: {
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'var(--pd-status-running, #0e9f4f)',
                      display: 'inline-block',
                      marginLeft: 4,
                    },
                  })
                : null)),
          h('button', {
            type: 'button',
            onClick: () => setShowTweakPopover(prev => !prev),
            title: t('dock.tweak'),
            'aria-label': t('dock.tweak'),
            style: {
              background: 'transparent',
              border: 'none',
              color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))',
              padding: '4px',
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
            },
          },
            h(Sliders, { size: 14 }))),

        // Capacity notice — flat inline sheet anchored above the dock. No drop
        // shadow, no filled grey block: a hairline card with a warn accent rule,
        // a capacity read-out and one flat action per active group.
        !canCreate && capPopoverOpen
          ? h('div', {
              role: 'dialog',
              'aria-label': t('dock.capTitle'),
              style: {
                position: 'absolute',
                bottom: '100%',
                left: 8,
                right: 8,
                marginBottom: 8,
                zIndex: 40,
                display: 'flex',
                flexDirection: 'column',
                // Layered surface: the card base keeps text contrast, while the
                // warn-tinted overlay lifts the sheet off the white dock without
                // falling back to a flat grey block.
                background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
                backgroundImage: `linear-gradient(${nordTint(NORD.nord13, 0.12)}, ${nordTint(NORD.nord13, 0.12)})`,
                border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                borderLeft: '2px solid var(--dsw-alias-state-warn-primary, #ebcb8b)',
                borderRadius: 8,
                overflow: 'hidden',
              },
            },
              // Header: limit state + capacity read-out + dismiss
              h('div', {
                style: {
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 10px 0 12px',
                },
              },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 } },
                  h('span', {
                    style: {
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: 'var(--dsw-alias-state-warn-primary, #ebcb8b)',
                      flexShrink: 0,
                    },
                  }),
                  h('span', {
                    style: {
                      fontSize: 11,
                      fontWeight: 600,
                      color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
                    },
                  }, t('dock.capTitle')),
                  h('span', {
                    style: {
                      fontSize: 10,
                      fontVariantNumeric: 'tabular-nums',
                      color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                    },
                  }, t('dock.capUsage').replace('{used}', String(activeGroups.length)).replace('{limit}', '3'))),
                h('button', {
                  type: 'button',
                  title: t('dock.capClose'),
                  'aria-label': t('dock.capClose'),
                  onClick: () => { setCapPopoverOpen(false); setCapWrapConfirmId(null) },
                  style: {
                    background: 'transparent',
                    border: 'none',
                    padding: 2,
                    cursor: 'pointer',
                    color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                    display: 'flex',
                    alignItems: 'center',
                  },
                }, h(X, { size: 12 }))),
              // Hint: one sentence, aligned under the title
              h('div', {
                style: {
                  padding: '3px 10px 9px 25px',
                  fontSize: 10,
                  lineHeight: 1.5,
                  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                },
              }, t('dock.capHint')),
              // Actions: one flat pill per group; the pill only changes border and
              // text colour when it is armed for confirmation.
              h('div', {
                style: {
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  padding: '8px 10px',
                  borderTop: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(76, 86, 106, 0.16)))',
                },
              },
                activeGroups.map(g => {
                  const itemCount = (g.items || []).length
                  const confirmPlan = planGroupWrapUp(g, findingsMap, harnessProjectionsMap)
                  const capBlockedReason = confirmPlan.queuedIds.length > 0
                    ? countText(t('group.wrapUpBlockedQueued'), confirmPlan.queuedIds.length)
                    : confirmPlan.runningIds.length > 0
                      ? countText(t('group.wrapUpBlockedRunning'), confirmPlan.runningIds.length)
                      : confirmPlan.unsettledIds.length > 0
                        ? countText(t('group.wrapUpBlockedUnsettled'), confirmPlan.unsettledIds.length)
                        : ''
                  const capDisabled = capBlockedReason !== ''
                  const capPendingCount = confirmPlan.settleIds
                    .map(id => (findingsMap instanceof Map ? findingsMap.get(id) : findingsMap?.[id]))
                    .filter(f => f && !isIgnoredFinding(f) && f.reviewStatus !== 'resolved').length
                  const confirming = capWrapConfirmId === g.id
                  const label = confirming
                    ? t('dock.capWrapConfirm').replace('{number}', String(g.groupNumber))
                    : (capPendingCount > 0
                        ? t('dock.capWrapUpCount').replace('{number}', String(g.groupNumber)).replace('{count}', String(capPendingCount))
                        : t('dock.capWrapUpPlain').replace('{number}', String(g.groupNumber)))
                  const pill = h('button', {
                    key: g.id,
                    type: 'button',
                    disabled: capDisabled,
                    title: capDisabled ? capBlockedReason : label,
                    'aria-label': capDisabled ? capBlockedReason : label,
                    onClick: async () => {
                      if (capDisabled) return
                      if (confirming) {
                        setCapWrapConfirmId(null)
                        setCapPopoverOpen(false)
                        await handleArchiveGroup(g.id)
                      } else {
                        setCapWrapConfirmId(g.id)
                      }
                    },
                    style: {
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '3px 9px',
                      borderRadius: 999,
                      fontSize: 10,
                      fontWeight: 600,
                      cursor: capDisabled ? 'not-allowed' : 'pointer',
                      opacity: capDisabled ? 0.55 : 1,
                      background: 'transparent',
                      border: confirming
                        ? '1px solid var(--dsw-alias-state-success-primary, #a3be8c)'
                        : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                      color: confirming
                        ? 'var(--dsw-alias-state-success-primary, #a3be8c)'
                        : 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                    },
                  }, h(CheckCircle, { size: 12 }), label)
                  return capDisabled
                    ? h('span', { key: g.id, style: { display: 'inline-flex' }, tip: capBlockedReason }, pill)
                    : pill
                })))
          : null,

        // Row 1.6: target caption — destination and post-append size BEFORE an
        // irreversible submission, not after it.
        targetCaption
          ? h('div', {
              style: {
                fontSize: 10,
                marginBottom: 4,
                color: needTarget
                  ? 'var(--dsw-alias-state-warn-primary, #ebcb8b)'
                  : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
              },
            }, targetCaption)
          : null,

        // Row 1.7: append confirmation — a second explicit step when the target
        // group already holds findings (silent appends are the reported hazard).
        pendingAppend
          ? h('div', {
              role: 'alert',
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '6px 10px',
                marginBottom: 6,
                borderRadius: 6,
                background: 'rgba(208, 135, 112, 0.12)',
                border: '1px solid rgba(208, 135, 112, 0.4)',
                fontSize: 11,
              },
            },
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 } },
                h('span', { style: { fontWeight: 600 } },
                  t('dock.appendConfirm')
                    .replace('{target}', 'G' + (groups.find(g => g.id === pendingAppend.targetId)?.groupNumber ?? '?'))
                    .replace('{before}', String(pendingAppend.before))
                    .replace('{count}', String(pendingAppend.count))),
                h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                  t('dock.appendConfirmHint').replace('{after}', String(pendingAppend.after)))),
              h('div', { style: { display: 'flex', gap: 6, flexShrink: 0 } },
                h(Button, {
                  icon: CheckCircle,
                  onClick: () => {
                    const pending = pendingAppend
                    setPendingAppend(null)
                    submitSelected(pending.mode, { customPrompt: pending.customPrompt })
                  },
                  style: { fontSize: 11 },
                }, t('dock.appendConfirmYes')),
                h(Button, {
                  variant: 'ghost',
                  icon: X,
                  onClick: () => setPendingAppend(null),
                  style: { fontSize: 11 },
                }, t('finding.cancel'))))
          : null,

        // Row 1.9: visible prompt budget — a 1M-token context still costs time,
        // money and replay weight; show the estimate before the irreversible click.
        (() => {
          const chosen = entries.filter(entry => selected.has(entry.id)
            && (entry.submissionStatus === 'unsubmitted' || entry.status === 'open'))
          if (chosen.length === 0) return null
          const options = {
            promptTail: panePrefs.promptTail,
            texts: {
              a: panePrefs.promptTailTextA,
              b: panePrefs.promptTailTextB,
              c: panePrefs.promptTailTextC,
            },
            tags: tagCatalog,
          }
          let combined = null
          let sequential = null
          try {
            combined = estimatePromptBudget(composeCombinedPrompt(chosen, options))
            sequential = estimatePromptBudget(chosen.map(entry => composeSequentialPrompt(entry, options)).join('\n'))
          } catch {
            return null
          }
          if (!combined || !sequential) return null
          const soft = combined.softExceeded || sequential.softExceeded
          const pct = (combined.contextShare * 100).toFixed(2)
          const label = t('dock.budget')
            .replace('{tokens}', String(combined.tokens))
            .replace('{seqTokens}', String(sequential.tokens))
            .replace('{pct}', pct)
          return h('div', {
            'data-pd-budget': 'true',
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              fontSize: 10,
              lineHeight: 1.4,
              color: soft ? 'var(--pd-status-warn, #ebcb8b)' : 'var(--pd-text-tertiary, #4c566a)',
              marginBottom: 6,
            },
          },
            h('span', null, label),
            soft
              ? h('span', { style: { fontWeight: 600 } }, t('dock.budgetSoft'))
              : null)
        })(),

        // Row 2: Real Submission Buttons (合并提交 1 Turn + 逐条排队)
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          (() => {
            const submitDisabled = busy || selectedPoolCount === 0 || sessionArchived || needTarget || distillLock.locked
            const combinedLabel = targetLabel
              ? t('dock.submitTo').replace('{target}', targetLabel).replace('{count}', String(selectedPoolCount))
              : t('dock.submitCombined1Turn')
            return h(Button, {
              variant: 'primary',
              icon: PaperPlaneRight,
              disabled: submitDisabled,
              onClick: () => requestSubmit('combined'),
              title: combinedLabel,
              tip: distillLock.locked ? t('distill.lock.submitPausedTip') : undefined,
              style: {
                flex: 1,
                padding: '7px 12px',
                fontSize: 12,
                justifyContent: 'center',
                background: submitDisabled ? 'var(--pd-merge-btn-disabled-bg, rgba(0,0,0,0.06))' : 'var(--dsw-alias-state-success-primary, #a3be8c)',
                color: submitDisabled ? 'var(--pd-merge-btn-disabled-fg, #4c566a)' : 'var(--pd-merge-btn-solid-fg, #ffffff)',
                fontWeight: submitDisabled ? 500 : 700,
                border: submitDisabled ? 'var(--pd-merge-btn-disabled-border, 1px solid rgba(0,0,0,0.12))' : '1px solid var(--dsw-alias-state-success-primary, #a3be8c)',
                opacity: 1,
              },
            }, combinedLabel)
          })(),
          h(Button, {
            variant: 'default',
            icon: List,
            disabled: busy || selectedPoolCount === 0 || sessionArchived || needTarget || distillLock.locked,
            onClick: () => requestSubmit('sequential'),
            tip: distillLock.locked ? t('distill.lock.submitPausedTip') : undefined,
            title: targetLabel
              ? t('dock.queueTo').replace('{target}', targetLabel).replace('{count}', String(selectedPoolCount))
              : t('dock.submitSequential'),
            style: { padding: '7px 12px', fontSize: 12 },
          }, targetLabel
            ? t('dock.queueTo').replace('{target}', targetLabel).replace('{count}', String(selectedPoolCount))
            : t('dock.submitSequential')))),

        // Row 2.5: sequential turn cost — the queue physically consumes one turn
        // per finding, so the cost must be visible BEFORE the irreversible click
        // (US4; tuned by prefs.sequentialCostHint: threshold / always / off).
        (() => {
          const costMode = panePrefs.sequentialCostHint
          const showCost = costMode === 'always'
            ? selectedPoolCount >= 1
            : costMode === 'threshold'
              ? selectedPoolCount >= 2
              : false
          return showCost
            ? h('div', {
                id: 'dockSequentialCost',
                style: {
                  fontSize: 10,
                  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                },
              }, countText(t('dock.sequentialCost'), selectedPoolCount))
            : null
        })(),

      // 6. Bottom Collapsible: Archived Milestone Groups (已结项历史手账组折叠归档)
      archivedGroups.length > 0
        ? h('div', {
            id: 'archivedSectionContainer',
            style: {
              borderTop: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
              background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
              fontSize: 11,
              // Cap the whole section (header + scrollable list) according to
              // archivedHistoryHeight ('compact': 240px, 'tall': 360px, 'half': min(50vh, 480px));
              // flexible shrink keeps it from clipping when the drawer is short.
              display: 'flex',
              flexDirection: 'column',
              maxHeight: panePrefs.archivedHistoryHeight === 'compact'
                ? 240
                : panePrefs.archivedHistoryHeight === 'tall'
                  ? 360
                  : 'min(50vh, 480px)',
              overflow: 'hidden',
              flexShrink: 1,
              minHeight: 0,
            },
          },
            h('div', {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                paddingRight: 8,
                borderBottom: '1px solid transparent',
              },
            },
              h('button', {
                type: 'button',
                onClick: () => setShowArchivedSection(prev => !prev),
                style: {
                  flex: '1 1 auto',
                  minWidth: 0,
                  boxSizing: 'border-box',
                  padding: '8px 4px 8px 12px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  cursor: 'pointer',
                },
              },
                h('span', { style: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 } },
                  h(showArchivedSection ? CaretDown : CaretRight, { size: 12 }),
                  h('span', null, countText(t('group.archivedCount'), archivedGroups.length))),
                h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } },
                  showArchivedSection ? t('group.archivedCollapse') : t('group.archivedExpand'))),
              h('button', {
                type: 'button',
                title: archivedSortDesc ? t('group.archivedSortToAsc') : t('group.archivedSortToDesc'),
                'aria-label': archivedSortDesc ? t('group.archivedSortToAsc') : t('group.archivedSortToDesc'),
                'data-sort-order': archivedSortDesc ? 'desc' : 'asc',
                onClick: () => setArchivedSortDesc(prev => !prev),
                style: {
                  flexShrink: 0,
                  background: 'transparent',
                  border: 'none',
                  padding: 6,
                  cursor: 'pointer',
                  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                },
              }, h(ArrowsDownUp, { size: 13 }))),
            showArchivedSection
              ? h('div', {
                  id: 'archivedContent',
                  style: {
                    padding: '4px 10px 10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    // Content adapts to the groups it holds; the section cap
                    // above (half viewport) turns overflow into scrolling.
                    flex: '1 1 auto',
                    minHeight: 0,
                    overflowY: 'auto',
                  },
                },
                  archivedGroups.map(ag => {
                    // Archived groups read the write-once window snapshot frozen at
                    // wrap-up (archivedTurn/archivedCharged/archivedAttributed).
                    // Missing snapshots fall back to the live derivation and are
                    // labelled 未冻结 rather than pretending they froze.
                    const turnLabels = describeGroupTurns(groupTurnStatsById.get(ag.id), t)
                    const turnsExpanded = expandedTurnGroupIds.has(ag.id)
                    const groupItemIds = new Set((ag.items || []).map(it => it.findingId))
                    const agFindings = entries.filter(e => e.assignedGroupId === ag.id || groupItemIds.has(e.id))
                    const agStatusCounts = summarizeGroupStatusCounts(agFindings, finding => deriveHarnessProjection(finding, log, liveQueue))
                    const agStatusCountsExpanded = expandedGroupCountIds.has(ag.id)
                    const agStatusBadgeItems = [
                      { key: 'completed', label: t('group.status.completed'), count: agStatusCounts.completed, tone: 'success' },
                      { key: 'awaiting', label: t('group.status.awaitingWrapUp'), count: agStatusCounts.awaitingWrapUp, tone: 'warn' },
                      { key: 'submitted', label: t('group.status.submitted'), count: agStatusCounts.submitted, tone: 'info' },
                      { key: 'ignored', label: t('group.status.ignored'), count: agStatusCounts.ignored, tone: 'neutral' },
                    ].filter(item => item.count > 0)
                    const agFindingIdSet = new Set(agFindings.map(f => f.id))
                    const agTraces = commitTraces.filter(tr =>
                      (Array.isArray(tr?.groupIds) && tr.groupIds.includes(ag.id))
                      || (Array.isArray(tr?.findingIds) && tr.findingIds.some(fid => agFindingIdSet.has(fid)))
                    )
                    const agUniqueCommits = collectUniqueCommits(agTraces)
                    const agCommitCount = agUniqueCommits.length
                    const agGitKey = `group-git-${ag.id}`
                    const isAgGitExpanded = Boolean(gitExpandedMap.get(agGitKey))
                    const isAgExpanded = expandedSet.has(`archived-${ag.id}`) || isAllExpanded

                    return h('div', {
                      key: ag.id,
                      style: {
                        padding: '8px 10px',
                        borderRadius: 8,
                        background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #e5e9f0))',
                        border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l2, #d8dee9))',
                        borderLeft: `3px solid ${getSequenceTint(Math.max(0, (Number(ag.groupNumber) || 1) - 1)).accent}`,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                        fontSize: 11,
                        fontFamily: 'monospace',
                      },
                    },
                      // Archived Group Header Row — full-row click target, same
                      // as the active group header.
                      h('div', {
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          width: '100%',
                          cursor: 'pointer',
                        },
                        onClick: (event) => {
                          if (suppressesRowToggle(event)) return
                          toggleExpand(`archived-${ag.id}`)
                        },
                      },
                        h('div', {
                          style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
                        },
                          h(isAgExpanded ? CaretDown : CaretRight, { size: 12 }),
                          h('span', { style: { fontWeight: 600, color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 } },
                            ag.title || t('group.title').replace('{number}', String(ag.groupNumber))),
                          h('button', {
                            type: 'button',
                            title: t('group.statusCountsExpandTip'),
                            'aria-label': t('group.statusCountsExpandTip'),
                            'aria-expanded': agStatusCountsExpanded ? 'true' : 'false',
                            'data-action': 'group-status-counts',
                            onClick: (e) => toggleGroupStatusCounts(ag.id, e),
                            style: {
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              flexShrink: 0,
                            },
                          }, h(Badge, {
                            tone: agStatusCounts.awaitingWrapUp > 0 ? 'warn' : 'neutral',
                            style: { fontSize: 9, padding: '1px 5px', fontWeight: 'bold', cursor: 'pointer' },
                            tip: t('group.statusCountsExpandTip'),
                          }, formatGroupCountBadge(agStatusCounts))),
                          h('span', {
                            style: {
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              overflow: 'hidden',
                              maxWidth: agStatusCountsExpanded ? 360 : 0,
                              opacity: agStatusCountsExpanded ? 1 : 0,
                              transition: 'max-width 180ms ease, opacity 160ms ease',
                              whiteSpace: 'nowrap',
                            },
                          },
                            ...agStatusBadgeItems.map(item => h(Badge, {
                              key: item.key,
                              tone: item.tone,
                              style: { fontSize: 9, padding: '1px 5px', flexShrink: 0 },
                            }, `${item.label} ${item.count}`))),
                          h('button', {
                            type: 'button',
                            title: t('group.turnMetricsExpandTip'),
                            'aria-label': t('group.turnMetricsExpandTip'),
                            'aria-expanded': turnsExpanded ? 'true' : 'false',
                            'data-action': 'group-turn-metrics',
                            onClick: (e) => toggleTurnMetrics(ag.id, e),
                            style: {
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              display: 'inline-flex',
                              alignItems: 'center',
                              flexShrink: 0,
                            },
                          }, h(Badge, {
                            tone: 'neutral',
                            style: {
                              fontSize: 9,
                              padding: '1px 5px',
                              fontWeight: 'bold',
                              background: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))',
                              color: 'var(--pd-accent-fg, var(--dsw-alias-label-primary-inverted, #ffffff))',
                              cursor: 'pointer',
                            },
                            tip: turnLabels.turnsTip,
                          }, turnLabels.turns)),
                          h('span', {
                            style: {
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              overflow: 'hidden',
                              maxWidth: turnsExpanded ? 220 : 0,
                              opacity: turnsExpanded ? 1 : 0,
                              transition: 'max-width 180ms ease, opacity 160ms ease',
                              whiteSpace: 'nowrap',
                            },
                          },
                            h('span', {
                              style: { fontSize: 9, fontWeight: 600, flexShrink: 0, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' },
                              tip: turnLabels.triggeredTip,
                            }, turnLabels.triggered),
                            h('span', {
                              style: { fontSize: 9, fontWeight: 600, flexShrink: 0, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))' },
                              tip: turnLabels.attributedTip,
                            }, turnLabels.attributed)),
                          agTraces.length > 0
                            ? h('button', {
                                type: 'button',
                                title: t('group.commitTrace.expandedTitle'),
                                'aria-label': t('group.commitTrace.expandedTitle'),
                                'data-action': 'group-commit-trace',
                                onClick: (e) => {
                                  if (e && typeof e.stopPropagation === 'function') e.stopPropagation()
                                  toggleGitExpand(agGitKey, isAgGitExpanded)
                                },
                                style: {
                                  background: 'transparent',
                                  border: 'none',
                                  padding: 0,
                                  cursor: 'pointer',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                },
                              }, h(Badge, {
                                tone: 'neutral',
                                icon: GitCommit,
                                style: { fontSize: 9, padding: '1px 5px', cursor: 'pointer' },
                              }, agCommitCount > 0 ? String(agCommitCount) : null))
                            : null),
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
                          h('button', {
                            type: 'button',
                            onClick: () => handleTogglePinGroup(ag.id),
                            title: ag.pinned ? t('group.pinLocked') : t('group.pinUnlocked'),
                            style: {
                              background: 'transparent',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              color: ag.pinned ? 'var(--dsw-alias-state-warn-primary, #ebcb8b)' : 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
                              display: 'flex',
                              alignItems: 'center',
                            },
                          },
                            h(PushPinSimple, { size: 13, filled: Boolean(ag.pinned) })),
                          h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-state-success-primary, #a3be8c)', fontWeight: 'bold' } },
                            t('group.wrappedUp')))),
                      agTraces.length > 0 && isAgGitExpanded
                        ? renderTraceDetailsBlock(agTraces, { headerTitle: t('group.commitTrace.expandedTitle') })
                        : null,
                      // Archived Group Findings (Visible when expanded)
                      isAgExpanded
                        ? (agFindings.length === 0
                            ? h('div', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))', padding: '4px 6px' } }, t('group.emptyArchived'))
                            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4, borderTop: '1px dashed var(--pd-border-default, var(--dsw-alias-border-l2, #d8dee9))', paddingTop: 4 } },
                                agFindings.map((f, idx) => renderFindingItem(f, { inGroup: true, last: idx === agFindings.length - 1 }))))
                        : null)
                  }))
              : null)
        : null,
      isImportModalOpen ? renderImportModal() : null,
      isClearModalOpen
        ? clearModal({
            compact: true,
            scrim: 'absolute',
            maxWidth: 380,
            clearOptions,
            setClearOptions,
            clearing,
            notice: clearNotice,
            onClose: () => { setIsClearModalOpen(false); setClearNotice(null) },
            onConfirm: handleExecuteClear,
          })
        : null)
  }
}
