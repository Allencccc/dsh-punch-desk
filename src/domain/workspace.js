/**
 * WorkspaceRecord domain model: pure data, no I/O.
 * Schema v2 workspace record definition, validation, and factory helpers.
 */

export const WORKSPACE_STATUSES = ['active', 'init', 'archived']
export const SPEC_SYNC_STATUSES = ['synced', 'pending']

/**
 * @typedef {object} WorkspaceRecord
 * @property {string} id Host WorkspaceId
 * @property {string} name Display name
 * @property {string} path Local filesystem absolute path
 * @property {string} gitBranch Current git branch (empty string if unavailable)
 * @property {'active'|'init'|'archived'} status Workspace status
 * @property {'synced'|'pending'} specSyncStatus Spec sync status
 * @property {number} createdAt Milliseconds since epoch
 * @property {number} updatedAt Milliseconds since epoch
 */

/**
 * @param {any} record
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWorkspaceRecord(record) {
  const errors = []
  if (record === null || typeof record !== 'object') {
    return { ok: false, errors: ['record must be an object'] }
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    errors.push('id is required')
  }
  if (typeof record.name !== 'string') {
    errors.push('name must be a string')
  }
  if (typeof record.path !== 'string') {
    errors.push('path must be a string')
  }
  if (typeof record.gitBranch !== 'string') {
    errors.push('gitBranch must be a string')
  }
  if (!WORKSPACE_STATUSES.includes(record.status)) {
    errors.push(`invalid status: ${record.status}`)
  }
  if (!SPEC_SYNC_STATUSES.includes(record.specSyncStatus)) {
    errors.push(`invalid specSyncStatus: ${record.specSyncStatus}`)
  }
  if (typeof record.createdAt !== 'number' || Number.isNaN(record.createdAt)) {
    errors.push('createdAt must be a number')
  }
  if (typeof record.updatedAt !== 'number' || Number.isNaN(record.updatedAt)) {
    errors.push('updatedAt must be a number')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * @param {object} input
 * @param {{ now?: () => number }} [deps]
 * @returns {WorkspaceRecord}
 */
export function createWorkspaceRecord(input, { now = Date.now } = {}) {
  if (!input || typeof input !== 'object') throw new Error('input must be an object')
  if (typeof input.id !== 'string' || input.id.trim() === '') {
    throw new Error('id is required')
  }
  const id = input.id.trim()
  const record = {
    id,
    name: typeof input.name === 'string' ? input.name : id,
    path: typeof input.path === 'string' ? input.path : '',
    gitBranch: typeof input.gitBranch === 'string' ? input.gitBranch : '',
    status: WORKSPACE_STATUSES.includes(input.status) ? input.status : 'active',
    specSyncStatus: SPEC_SYNC_STATUSES.includes(input.specSyncStatus) ? input.specSyncStatus : 'synced',
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now(),
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now(),
  }
  const check = validateWorkspaceRecord(record)
  if (!check.ok) throw new Error(check.errors.join('; '))
  return record
}

/**
 * @param {WorkspaceRecord} record
 * @param {Partial<WorkspaceRecord>} updates
 * @param {{ now?: () => number }} [deps]
 * @returns {WorkspaceRecord}
 */
export function updateWorkspaceRecord(record, updates, { now = Date.now } = {}) {
  if (!record || typeof record !== 'object') throw new Error('record must be an object')
  const next = {
    ...record,
    ...updates,
    updatedAt: now(),
  }
  const check = validateWorkspaceRecord(next)
  if (!check.ok) throw new Error(check.errors.join('; '))
  return next
}
