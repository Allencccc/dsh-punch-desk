/**
 * GroupRecord domain model: pure data, no I/O.
 * Schema v2 active group definition, status derivation, and session turns helpers.
 */

import { isIgnoredFinding } from './entries.js'

export const MAX_EXECUTING_GROUPS = 3

/**
 * @typedef {object} GroupItem
 * @property {string} findingId ID of the associated finding
 * @property {number} order Order inside the group
 * @property {string} [batchId] Submission batch ID
 * @property {number} [executedAt] Timestamp when execution finished
 */

/**
 * @typedef {object} GroupRecord
 * @property {string} id Unique identifier e.g. 'g-1'
 * @property {number} groupNumber 1..N monotonic counter within session (never reused)
 * @property {string} sessionId Owning session ID
 * @property {string} workspaceId Owning workspace ID
 * @property {string} [title] Internal target summary
 * @property {number} startTurn Session turn index when this group was created
 * @property {GroupItem[]} items Finding items in this group
 * @property {number} createdAt Milliseconds since epoch
 */

/**
 * @typedef {'executing'|'waiting'|'archived'|'completed'} GroupExecutionStatus
 */

/**
 * Helper to extract finding from Map, array, or object
 * @param {any} findingsMap
 * @param {string} findingId
 * @returns {any}
 */
function getFinding(findingsMap, findingId) {
  if (!findingsMap) return null
  if (findingsMap instanceof Map) return findingsMap.get(findingId)
  if (Array.isArray(findingsMap)) return findingsMap.find(f => f?.id === findingId)
  if (typeof findingsMap === 'object') return findingsMap[findingId]
  return null
}

/**
 * Accept the several shapes callers already use to hand us a findings index:
 * a Map/array/plain object of findings, or `{ findingsById }`.
 * @param {any} findingsById
 * @returns {any}
 */
function resolveFindingsIndex(findingsById) {
  if (!findingsById) return null
  if (findingsById instanceof Map || Array.isArray(findingsById)) return findingsById
  if (typeof findingsById === 'object' && findingsById.findingsById) return findingsById.findingsById
  return findingsById
}

/**
 * Helper to extract harness projection from Map, function, or object
 * @param {any} harnessProjectionsMap
 * @param {string} findingId
 * @param {any} [finding]
 * @returns {string}
 */
function getHarnessProjection(harnessProjectionsMap, findingId, finding) {
  if (!harnessProjectionsMap) return 'unknown'
  let val
  if (harnessProjectionsMap instanceof Map) {
    val = harnessProjectionsMap.get(findingId)
    if (!val && finding?.requestId) val = harnessProjectionsMap.get(finding.requestId)
  } else if (typeof harnessProjectionsMap === 'function') {
    val = harnessProjectionsMap(findingId, finding)
  } else if (typeof harnessProjectionsMap === 'object') {
    val = harnessProjectionsMap[findingId]
    if (!val && finding?.requestId) val = harnessProjectionsMap[finding.requestId]
  }
  return val ?? 'unknown'
}

/**
 * Pure selector: derives group execution status from finding submissions and harness projections.
 * Group execution status is purely derived in memory, never persisted.
 *
 * Rules:
 * - If items is empty -> 'executing' (empty group placeholder counts as executing to reserve quota)
 * - If any finding in group has submissionStatus !== 'submitted' or harness projection !== 'executed' -> 'executing'
 * - If all items in group are 'submitted' AND have harness projection === 'executed' -> 'completed'
 *
 * @param {GroupRecord} group
 * @param {Map<string, any>|Record<string, any>|any[]} [findingsMap]
 * @param {Map<string, string>|Record<string, string>|((id: string, finding?: any) => string)} [harnessProjectionsMap]
 * @returns {GroupExecutionStatus}
 */
export function deriveGroupExecutionStatus(group, findingsMap, harnessProjectionsMap) {
  if (!group) return 'waiting'
  if (group.status === 'archived') return 'archived'
  if (!Array.isArray(group.items) || group.items.length === 0) {
    return 'executing'
  }
  for (const item of group.items) {
    const finding = getFinding(findingsMap, item.findingId)
    if (!finding) return 'executing'

    // Binary submission fact: must be 'submitted'
    const isSubmitted = finding.submissionStatus === 'submitted' ||
      (!finding.submissionStatus && (finding.status === 'submitted' || finding.status === 'sent' || finding.status === 'resolved' || finding.status === 'dismissed' || finding.status === 'completed'))
    if (!isSubmitted) return 'executing'

    // Harness projection / resolution: must be 'executed' or completed/resolved
    if (finding.status === 'completed' || finding.reviewStatus === 'resolved' || isIgnoredFinding(finding)) {
      continue
    }
    const proj = getHarnessProjection(harnessProjectionsMap, item.findingId, finding)
    if (proj !== 'executed') return 'executing'
  }
  return 'completed'
}

/**
 * Calculates session elapsed turns: Math.max(0, currentTurn - group.startTurn).
 * Represents total session turns elapsed since this group was created; does not imply
 * turns were exclusively consumed by this group.
 *
 * @param {GroupRecord} group
 * @param {number} currentTurn
 * @returns {number}
 */
/**
 * Plan a Group wrap-up (结项). A wrap-up is the human confirmation that ends the
 * whole batch, but it only settles **static** rows: a running turn must finish
 * first (same rule as the row-level resolve/dismiss), queued rows block it, and
 * unsubmitted / submission-failed entries block it too. Ignored/resolved rows
 * stay untouched and are filtered by the caller when writing.
 *
 * @param {GroupRecord} group
 * @param {Map<string, any>|Record<string, any>|any[]} [findingsMap]
 * @param {Map<string, string>|Record<string, string>|((id: string, finding?: any) => string)} [harnessProjectionsMap]
 * @returns {{ settleIds: string[], queuedIds: string[], runningIds: string[], unsettledIds: string[] }}
 */
export function planGroupWrapUp(group, findingsMap, harnessProjectionsMap) {
  const ids = (Array.isArray(group?.items) ? group.items : [])
    .map(item => (item && typeof item.findingId === 'string' ? item.findingId : ''))
    .filter(Boolean)
  const settleIds = []
  const queuedIds = []
  const runningIds = []
  const unsettledIds = []
  for (const findingId of ids) {
    const finding = getFinding(findingsMap, findingId)
    if (!finding) {
      unsettledIds.push(findingId)
      continue
    }
    if (finding.submissionStatus !== 'submitted') {
      unsettledIds.push(findingId)
      continue
    }
    if (finding.retryPending || finding.reconciliationPending || finding.lastSubmitError) {
      unsettledIds.push(findingId)
      continue
    }
    const projection = getHarnessProjection(harnessProjectionsMap, findingId, finding)
    if (projection === 'queued') {
      queuedIds.push(findingId)
      continue
    }
    if (projection === 'running') {
      runningIds.push(findingId)
      continue
    }
    settleIds.push(findingId)
  }
  return { settleIds, queuedIds, runningIds, unsettledIds }
}

export function sessionElapsedTurns(group, currentTurn) {
  // Derive all the time from the session turn and the group's creation turn.
  // A persisted `group.turns` is legacy bookkeeping written by old turn
  // attribution code; it must never override the live session count, or a
  // group freezes at its stale value while the session keeps advancing.
  const current = typeof currentTurn === 'number' && Number.isFinite(currentTurn)
    ? Math.max(0, Math.floor(currentTurn))
    : 0
  const start = typeof group?.startTurn === 'number' && Number.isFinite(group.startTurn)
    ? Math.max(0, Math.floor(group.startTurn))
    : 0
  return Math.max(0, current - start)
}

/**
 * Compute the next monotonic group number within a session (1..N, never reused).
 * @param {GroupRecord[]} [existingGroups]
 * @returns {number}
 */
export function nextGroupNumber(existingGroups = []) {
  if (!Array.isArray(existingGroups) || existingGroups.length === 0) return 1
  let max = 0
  for (const group of existingGroups) {
    if (group && typeof group.groupNumber === 'number' && group.groupNumber > max) {
      max = group.groupNumber
    }
  }
  return max + 1
}

/**
 * Validate the group→finding side of invariants I2: every item must resolve to
 * an existing finding that belongs to the same session as the group. The
 * findings index is optional context, supplied by callers that have the store
 * at hand (submit / drag-to-group / wrap-up / inherit / migrate); reading a
 * legacy group without an index stays valid so old data never becomes
 * unreadable.
 *
 * @param {GroupRecord} group
 * @param {Map<string, object>|object[]|Record<string, object>|{ findingsById: any }} [findingsById]
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGroupFindings(group, findingsById) {
  if (group === null || typeof group !== 'object') {
    return { ok: false, errors: ['group must be an object'] }
  }
  if (!Array.isArray(group.items)) {
    return { ok: false, errors: ['items must be an array'] }
  }
  const index = resolveFindingsIndex(findingsById)
  if (!index) return { ok: true, errors: [] }
  const errors = []
  for (const [idx, it] of group.items.entries()) {
    // Shape problems are reported by validateGroupRecord; only resolve real ids.
    if (!it || typeof it !== 'object' || typeof it.findingId !== 'string' || it.findingId.trim() === '') continue
    const finding = getFinding(index, it.findingId)
    if (!finding) {
      errors.push(`item[${idx}] finding not found: ${it.findingId}`)
      continue
    }
    if (finding.sessionId !== group.sessionId) {
      errors.push(`item[${idx}] finding belongs to another session: ${it.findingId}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * @param {GroupRecord} group
 * @param {Map<string, object>|object[]|Record<string, object>|{ findingsById: any }} [findingsById]
 *   Optional findings index. When supplied, items must resolve to findings in
 *   the same session (invariant I2); omitted keeps legacy reads valid.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGroupRecord(group, findingsById) {
  const errors = []
  if (group === null || typeof group !== 'object') {
    return { ok: false, errors: ['group must be an object'] }
  }
  if (typeof group.id !== 'string' || group.id.trim() === '') {
    errors.push('id is required')
  }
  if (typeof group.groupNumber !== 'number' || group.groupNumber <= 0 || !Number.isInteger(group.groupNumber)) {
    errors.push('groupNumber must be a positive integer')
  }
  if (typeof group.sessionId !== 'string' || group.sessionId.trim() === '') {
    errors.push('sessionId is required')
  }
  if (typeof group.workspaceId !== 'string' || group.workspaceId.trim() === '') {
    errors.push('workspaceId is required')
  }
  if (typeof group.startTurn !== 'number' || group.startTurn < 0) {
    errors.push('startTurn must be a non-negative number')
  }
  if (!Array.isArray(group.items)) {
    errors.push('items must be an array')
  } else {
    for (const [idx, it] of group.items.entries()) {
      if (!it || typeof it !== 'object') {
        errors.push(`item[${idx}] must be an object`)
      } else {
        if (typeof it.findingId !== 'string' || it.findingId.trim() === '') {
          errors.push(`item[${idx}].findingId is required`)
        }
        if (typeof it.order !== 'number') {
          errors.push(`item[${idx}].order must be a number`)
        }
      }
    }
  }
  if (typeof group.createdAt !== 'number' || Number.isNaN(group.createdAt)) {
    errors.push('createdAt must be a number')
  }
  if (group.pinned !== undefined && typeof group.pinned !== 'boolean') {
    errors.push('pinned must be a boolean')
  }
  if (Array.isArray(group.items) && findingsById) {
    // Optional cross-record check; without an index the group stays valid.
    for (const error of validateGroupFindings(group, findingsById).errors) errors.push(error)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Factory for GroupRecord.
 * @param {object} input
 * @param {{ now?: () => number, findingsById?: any }} [deps]
 *   `findingsById` is optional: when supplied, items must resolve to findings
 *   in the same session (invariant I2).
 * @returns {GroupRecord}
 */
export function createGroupRecord(input, { now = Date.now, findingsById } = {}) {
  if (!input || typeof input !== 'object') throw new Error('input must be an object')
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) throw new Error('sessionId required')
  if (typeof input.workspaceId !== 'string' || !input.workspaceId.trim()) throw new Error('workspaceId required')

  const groupNumber = typeof input.groupNumber === 'number' ? input.groupNumber : 1
  const id = input.id ?? `g-${groupNumber}`
  const record = {
    id,
    groupNumber,
    sessionId: input.sessionId.trim(),
    workspaceId: input.workspaceId.trim(),
    startTurn: typeof input.startTurn === 'number' ? input.startTurn : 0,
    items: Array.isArray(input.items) ? input.items.map(it => ({ ...it })) : [],
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now(),
    pinned: Boolean(input.pinned),
  }
  if (input.title !== undefined) record.title = input.title
  if (input.status !== undefined) record.status = input.status
  if (input.turns !== undefined && typeof input.turns === 'number') record.turns = input.turns
  const check = validateGroupRecord(record, findingsById)
  if (!check.ok) throw new Error(check.errors.join('; '))
  return record
}

/**
 * Toggle pin state on a group (clones group).
 * Pinned groups are protected and preserved during workspace data clear.
 * @param {GroupRecord} group
 * @returns {GroupRecord}
 */
/**
 * Add a finding to a group (clones group, avoids duplicates).
 * @param {GroupRecord} group
 * @param {string} findingId
 * @param {{ batchId?: string, order?: number }} [opts]
 * @returns {GroupRecord}
 */
export function addItemToGroup(group, findingId, { batchId, order } = {}) {
  if (!group || !Array.isArray(group.items)) throw new Error('invalid group')
  if (typeof findingId !== 'string' || !findingId.trim()) throw new Error('findingId required')
  if (group.items.some(it => it.findingId === findingId)) return group
  const nextOrder = typeof order === 'number' ? order : group.items.length + 1
  const item = { findingId, order: nextOrder }
  if (batchId) item.batchId = batchId
  return {
    ...group,
    items: [...group.items, item],
  }
}

/**
 * Remove a finding from a group (clones group).
 * @param {GroupRecord} group
 * @param {string} findingId
 * @returns {GroupRecord}
 */
export function removeItemFromGroup(group, findingId) {
  if (!group || !Array.isArray(group.items)) return group
  return {
    ...group,
    items: group.items.filter(it => it.findingId !== findingId),
  }
}

/**
 * Count groups currently in 'executing' status.
 * @param {GroupRecord[]} groups
 * @param {any} [findingsMap]
 * @param {any} [harnessProjectionsMap]
 * @returns {number}
 */
export function countExecutingGroups(groups, findingsMap, harnessProjectionsMap) {
  if (!Array.isArray(groups)) return 0
  let count = 0
  for (const group of groups) {
    if (deriveGroupExecutionStatus(group, findingsMap, harnessProjectionsMap) === 'executing') {
      count++
    }
  }
  return count
}

/**
 * Returns true if a new group can be created without exceeding MAX_EXECUTING_GROUPS (3).
 * @param {GroupRecord[]} groups
 * @param {any} [findingsMap]
 * @param {any} [harnessProjectionsMap]
 * @returns {boolean}
 */
export function canCreateGroup(groups, findingsMap, harnessProjectionsMap) {
  return countExecutingGroups(groups, findingsMap, harnessProjectionsMap) < MAX_EXECUTING_GROUPS
}
