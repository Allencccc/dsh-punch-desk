/**
 * Preferences manager for Punch Desk Settings Center.
 *
 * Provides a single source of truth for preference normalization, read-modify-write,
 * and resetting to defaults with strict whitelist enforcement.
 */

import { normalizeTagCatalog } from '../domain/tags.js'
import {
  ARCHIVED_HISTORY_HEIGHTS,
  COMPOSER_ROWS_OPTIONS,
  DEFAULT_PREFS,
  DRAFT_DEFAULT_VISIBILITIES,
  INHERIT_SCOPES,
  PROMPT_ENTRY_BYTES_DEFAULT,
  PROMPT_ENTRY_BYTES_RANGE,
  PROMPT_SOFT_WARN_BYTES,
  PROMPT_TAILS,
  PROMPT_RETENTION_DAYS_RANGE,
  PROMPT_RETENTION_ROWS_RANGE,
  retentionWindowFromPrefs,
  PROMPT_TOTAL_BYTES_DEFAULT,
  PROMPT_TOTAL_BYTES_RANGE,
  PROMPT_TAIL_RESERVE_BYTES,
  SEQUENTIAL_COST_HINTS,
  START_SESSION_BEHAVIORS,
  TAIL_TEXT_MAX,
} from '../store/contract.js'

export {
  ARCHIVED_HISTORY_HEIGHTS,
  PROMPT_RETENTION_DAYS_RANGE,
  PROMPT_RETENTION_ROWS_RANGE,
  retentionWindowFromPrefs,
  COMPOSER_ROWS_OPTIONS,
  DEFAULT_PREFS,
  DRAFT_DEFAULT_VISIBILITIES,
  INHERIT_SCOPES,
  PROMPT_ENTRY_BYTES_DEFAULT,
  PROMPT_ENTRY_BYTES_RANGE,
  PROMPT_SOFT_WARN_BYTES,
  PROMPT_TAILS,
  PROMPT_TOTAL_BYTES_DEFAULT,
  PROMPT_TOTAL_BYTES_RANGE,
  PROMPT_TAIL_RESERVE_BYTES,
  SEQUENTIAL_COST_HINTS,
  START_SESSION_BEHAVIORS,
  TAIL_TEXT_MAX,
}

/**
 * Clamp a byte budget pref into its allowed range (non-finite falls back).
 * @param {unknown} raw
 * @param {number} fallback
 * @param {{ min: number, max: number }} range
 * @returns {number}
 */
function clampBytes(raw, fallback, range) {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : fallback
  return Math.min(range.max, Math.max(range.min, value))
}

/**
 * Normalise one editable tail section. Non-strings fall back to the default,
 * strings are trimmed and bounded (empty string = section omitted).
 * @param {unknown} raw
 * @param {string} fallback
 * @returns {string}
 */
function normalizeSectionText(raw, fallback) {
  return typeof raw === 'string' ? raw.trim().slice(0, TAIL_TEXT_MAX) : fallback
}

/**
 * Normalise any raw preference object by whitelist validation.
 * Unknown keys (such as legacy `submitMode`) are discarded.
 * Invalid values fall back to their safe default.
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULT_PREFS}
 */
export function normalizePrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const parsedRows = Number(src.composerRows)

  const promptMaxBytes = clampBytes(src.promptMaxBytes, PROMPT_TOTAL_BYTES_DEFAULT, PROMPT_TOTAL_BYTES_RANGE)
  const retention = retentionWindowFromPrefs(src)
  // One entry + header + tail must still fit inside a single composed prompt,
  // otherwise a user could configure an "always invalid" combination.
  const maxEntryCeiling = Math.max(PROMPT_ENTRY_BYTES_RANGE.min, promptMaxBytes - PROMPT_TAIL_RESERVE_BYTES)
  const promptMaxEntryBytes = Math.min(
    clampBytes(src.promptMaxEntryBytes, PROMPT_ENTRY_BYTES_DEFAULT, PROMPT_ENTRY_BYTES_RANGE),
    maxEntryCeiling,
  )

  return {
    lastWorkspace: typeof src.lastWorkspace === 'string' && src.lastWorkspace.trim() ? src.lastWorkspace : null,
    includeTextHeuristic: typeof src.includeTextHeuristic === 'boolean'
      ? src.includeTextHeuristic
      : DEFAULT_PREFS.includeTextHeuristic,
    startSessionBehavior: START_SESSION_BEHAVIORS.includes(src.startSessionBehavior)
      ? src.startSessionBehavior
      : DEFAULT_PREFS.startSessionBehavior,
    inheritScope: INHERIT_SCOPES.includes(src.inheritScope)
      ? src.inheritScope
      : DEFAULT_PREFS.inheritScope,
    draftDefaultVisibility: DRAFT_DEFAULT_VISIBILITIES.includes(src.draftDefaultVisibility)
      ? src.draftDefaultVisibility
      : DEFAULT_PREFS.draftDefaultVisibility,
    sequentialCostHint: SEQUENTIAL_COST_HINTS.includes(src.sequentialCostHint)
      ? src.sequentialCostHint
      : DEFAULT_PREFS.sequentialCostHint,
    composerRows: COMPOSER_ROWS_OPTIONS.includes(parsedRows)
      ? parsedRows
      : DEFAULT_PREFS.composerRows,
    archivedHistoryHeight: ARCHIVED_HISTORY_HEIGHTS.includes(src.archivedHistoryHeight)
      ? src.archivedHistoryHeight
      : DEFAULT_PREFS.archivedHistoryHeight,
    promptTail: PROMPT_TAILS.includes(src.promptTail)
      ? src.promptTail
      : DEFAULT_PREFS.promptTail,
    // Editable A/B/C section texts. Multi-line on purpose: only the outer
    // whitespace is trimmed, internal line breaks are the user's own layout.
    // An empty string is meaningful: that section is omitted from the tail.
    promptTailTextA: normalizeSectionText(src.promptTailTextA, DEFAULT_PREFS.promptTailTextA),
    promptTailTextB: normalizeSectionText(src.promptTailTextB, DEFAULT_PREFS.promptTailTextB),
    promptTailTextC: normalizeSectionText(src.promptTailTextC, DEFAULT_PREFS.promptTailTextC),
    promptMaxEntryBytes,
    promptMaxBytes,
    promptLogRetentionDays: retention.days,
    promptLogRetentionRows: retention.rows,
    // Tag catalog: presets always exist, custom tags are deduped and capped.
    // Labels are user content (no zh/en pairs), guidance is prompt material.
    findingTags: normalizeTagCatalog(src.findingTags),
  }
}

/**
 * Alias for normalizePrefs.
 * @param {unknown} raw
 * @returns {typeof DEFAULT_PREFS}
 */
export function prefsOf(raw) {
  return normalizePrefs(raw)
}

/**
 * Read-modify-write helper for updating preferences.
 * Throws on failure to allow caller to roll back UI and display errors.
 *
 * @param {{ getPrefs?: Function, setPrefs?: Function }} store
 * @param {Partial<typeof DEFAULT_PREFS>} patch
 * @returns {Promise<typeof DEFAULT_PREFS>}
 */
export async function updatePrefs(store, patch) {
  if (!store || typeof store.getPrefs !== 'function' || typeof store.setPrefs !== 'function') {
    throw new Error('store.setPrefs is unavailable')
  }
  const current = await store.getPrefs()
  const merged = { ...current, ...patch }
  const normalized = normalizePrefs(merged)
  await store.setPrefs(normalized)
  return normalized
}

/**
 * Reset all user-facing preferences to initial defaults.
 * Preserves `lastWorkspace` to avoid disrupting active project context.
 *
 * @param {{ getPrefs?: Function, setPrefs?: Function }} store
 * @returns {Promise<typeof DEFAULT_PREFS>}
 */
export async function resetPrefs(store) {
  if (!store || typeof store.getPrefs !== 'function' || typeof store.setPrefs !== 'function') {
    throw new Error('store.setPrefs is unavailable')
  }
  const current = await store.getPrefs()
  const lastWorkspace = typeof current?.lastWorkspace === 'string' ? current.lastWorkspace : null
  // Tag definitions are user content (custom labels + edited guidance), so a
  // global reset must not silently destroy them. Individual tags stay editable.
  const findingTags = normalizeTagCatalog(current?.findingTags)
  const resetValues = {
    ...DEFAULT_PREFS,
    lastWorkspace,
    findingTags,
  }
  const normalized = normalizePrefs(resetValues)
  await store.setPrefs(normalized)
  return normalized
}
