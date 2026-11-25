/**
 * Plugin preference for the asset-inheritance scope.
 *
 * The scope decides how far the inherit modal looks for source sessions:
 * `workspace` (default) only offers sessions of the current workspace,
 * `all` also offers sessions from other workspaces (copy-only).
 */

import { normalizePrefs, updatePrefs } from './prefs.js'

/**
 * Normalize a persisted prefs record to a supported scope. Unknown values (an
 * older build, hand-edited storage) mean the safe default.
 * @param {object|null|undefined} prefs
 * @returns {'workspace'|'all'}
 */
export function inheritScopeOf(prefs) {
  return normalizePrefs(prefs).inheritScope
}

/**
 * Persist only the inherit scope, preserving every other preference.
 *
 * `setPrefs` replaces the whole record, so the current prefs are read first.
 * A store without prefs support resolves to the requested value for this
 * session without writing anything.
 *
 * @param {object|null|undefined} store
 * @param {'workspace'|'all'} scope
 * @returns {Promise<'workspace'|'all'>}
 */
export async function persistInheritScope(store, scope) {
  const next = scope === 'all' ? 'all' : 'workspace'
  if (store === null || typeof store !== 'object' || typeof store.setPrefs !== 'function') return next
  const current = typeof store.getPrefs === 'function' ? await store.getPrefs() : {}
  await store.setPrefs({
    ...(current !== null && typeof current === 'object' ? current : {}),
    inheritScope: next,
  })
  return next
}
