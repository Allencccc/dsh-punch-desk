/** Entry domain model: pure data, no I/O. */

import { TAG_KEY_MAX } from './tags.js'

export const KINDS = ['draft', 'finding', 'digest']
export const DRAFT_STATUSES = ['idea', 'ready', 'prefilled', 'started']
/**
 * Draft visibility scopes. `global` drafts live in the shared pool every
 * workspace sees; `workspace` drafts are only visible in the workspace they
 * were filed under (`workspaceId`). Legacy drafts without the field are global.
 */
export const DRAFT_VISIBILITIES = ['global', 'workspace']
export const FINDING_STATUSES = ['open', 'queued', 'sent', 'submitted', 'resolved', 'dismissed']
export const DIGEST_STATUSES = ['draft', 'final']
export const SEVERITIES = ['blocker', 'major', 'minor', 'question', 'idea']

export const FINDING_TAGS = ['optimize', 'refactor', 'blocker', 'context']
export const SUBMISSION_STATUSES = ['unsubmitted', 'submitted']
export const REVIEW_STATUSES = ['pending', 'resolved', 'dismissed']
/**
 * A finding is "ignored" by reviewStatus, or by legacy `status:'dismissed'` rows
 * that predate reviewStatus. Every layer (row badge, group badge, projection,
 * header counter, wrap-up) must use this single predicate.
 * @param {any} finding
 * @returns {boolean}
 */
export function isIgnoredFinding(finding) {
  return Boolean(finding)
    && (finding.reviewStatus === 'dismissed' || (!finding.reviewStatus && finding.status === 'dismissed'))
}
/**
 * @param {string} kind
 * @returns {string}
 */
export function defaultStatus(kind) {
  if (kind === 'draft') return 'idea'
  if (kind === 'finding') return 'open'
  if (kind === 'digest') return 'draft'
  throw new Error(`unknown kind: ${kind}`)
}

/**
 * @param {string} cwd
 * @returns {string}
 */
export function workspaceKeyFromCwd(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return 'unknown'
  const trimmed = cwd.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/**
 * Get the derived status for a finding.
 * - If reviewStatus === 'resolved' return 'resolved'
 * - If reviewStatus === 'dismissed' return 'dismissed'
 * - If submissionStatus === 'submitted' return 'submitted'
 * - Else return 'open'
 * @param {object} finding
 * @returns {string}
 */
export function findingStatus(finding) {
  if (!finding) return 'open'
  if (finding.reviewStatus === 'resolved') return 'resolved'
  if (finding.reviewStatus === 'dismissed') return 'dismissed'
  if (finding.submissionStatus === 'submitted') return 'submitted'
  if (finding.submissionStatus === 'unsubmitted') return 'open'
  return finding.status ?? 'open'
}

/**
 * Attach the dynamic status getter & setter to a FindingRecord.
 * @param {object} finding
 * @returns {object}
 */
export function attachFindingStatus(finding) {
  if (!finding || typeof finding !== 'object') return finding
  Object.defineProperty(finding, 'status', {
    get() {
      if (this.reviewStatus === 'resolved') return 'resolved'
      if (this.reviewStatus === 'dismissed') return 'dismissed'
      if (this.submissionStatus === 'submitted') return 'submitted'
      return 'open'
    },
    set(val) {
      if (val === 'resolved') {
        this.reviewStatus = 'resolved'
        this.submissionStatus = 'submitted'
      } else if (val === 'dismissed') {
        this.reviewStatus = 'dismissed'
        this.submissionStatus = 'submitted'
      } else if (val === 'submitted' || val === 'sent' || val === 'queued') {
        this.submissionStatus = 'submitted'
        if (!this.reviewStatus) this.reviewStatus = 'pending'
      } else if (val === 'open') {
        this.submissionStatus = 'unsubmitted'
        if (!this.reviewStatus) this.reviewStatus = 'pending'
      }
    },
    enumerable: true,
    configurable: true,
  })
  return finding
}

/**
 * Submission-acceptance evidence: the pair `acceptedAt` + `submissionSeq`,
 * written only after `prompt()` returns accepted (see the group-turn
 * attribution spec §5.1). Both fields are optional and only meaningful
 * together:
 * - `acceptedAt` must be a finite, non-negative epoch millisecond number;
 * - `submissionSeq` must be a positive integer, allocated per session;
 * - a partial or invalid pair is not evidence at all: callers must treat the
 *   record as legacy (no acceptance evidence) instead of guessing the rest.
 *
 * This helper is the single source of truth for that invariant: createEntry,
 * createFindingRecord and migrateFinding all route the pair through it, so
 * new UI-created findings (which never set the fields) stay legacy by
 * default while persisted/imported pairs survive the round trip.
 *
 * @param {object} [source]
 * @returns {{ acceptedAt?: number, submissionSeq?: number }}
 */
export function normalizeAcceptedEvidence(source) {
  if (!source || typeof source !== 'object') return {}
  const acceptedAt = source.acceptedAt
  const submissionSeq = source.submissionSeq
  const validAt = typeof acceptedAt === 'number' && Number.isFinite(acceptedAt) && acceptedAt >= 0
  const validSeq = typeof submissionSeq === 'number' && Number.isInteger(submissionSeq) && submissionSeq > 0
  if (!validAt || !validSeq) return {}
  return { acceptedAt, submissionSeq }
}

/**
 * True when a finding carries a complete, valid acceptance-evidence pair.
 * @param {object} [finding]
 * @returns {boolean}
 */
export function hasAcceptedEvidence(finding) {
  return normalizeAcceptedEvidence(finding).submissionSeq !== undefined
}

/**
 * @param {object} entry
 * @returns {{ ok: boolean, errors: string[] }}
 */
/** Hard safety cap for stored bodies (submission limits are separate + configurable). */
export const BODY_HARD_CAP_BYTES = 65536

export function validateEntry(entry) {
  const errors = []
  if (entry === null || typeof entry !== 'object') return { ok: false, errors: ['entry must be an object'] }
  if (!KINDS.includes(entry.kind)) errors.push('invalid kind')
  if (typeof entry.workspaceKey !== 'string' || entry.workspaceKey === '') errors.push('workspaceKey required')
  if (!entry.title && !entry.body && !entry.text) errors.push('title or body required')
  if (entry.title && entry.title.length > 200) errors.push('title too long')
  const bodyContent = entry.body || entry.text
  if (bodyContent && new TextEncoder().encode(bodyContent).byteLength > BODY_HARD_CAP_BYTES) errors.push('body too large')
  if (entry.kind === 'finding' && !entry.sessionId) errors.push('finding requires sessionId')
  if (entry.kind === 'finding' && entry.assignedGroupId !== undefined && entry.assignedGroupId !== null
    && (typeof entry.assignedGroupId !== 'string' || entry.assignedGroupId.trim() === '')) {
    errors.push('invalid assignedGroupId')
  }
  if (entry.kind === 'digest' && !entry.sessionId) errors.push('digest requires sessionId')
  if (entry.kind === 'draft' && entry.sessionId && !['prefilled', 'started'].includes(entry.status)) {
    errors.push('draft sessionId requires prefilled or started')
  }
  if (entry.kind === 'draft' && entry.visibility !== undefined && !DRAFT_VISIBILITIES.includes(entry.visibility)) {
    errors.push('invalid draft visibility')
  }
  if (entry.kind === 'draft' && entry.visibility === 'workspace'
    && (typeof entry.workspaceId !== 'string' || entry.workspaceId === '')) {
    errors.push('workspace draft requires workspaceId')
  }
  if (entry.severity && !SEVERITIES.includes(entry.severity) && !FINDING_TAGS.includes(entry.severity)) errors.push('invalid severity')
  // Tags are user-extensible (prefs catalog), so the domain only enforces the
  // shape here. Catalog membership is a UI concern, not an audit invariant.
  if (entry.tag !== undefined
    && (typeof entry.tag !== 'string' || entry.tag.trim() === '' || entry.tag.length > TAG_KEY_MAX)) {
    errors.push('invalid tag')
  }
  const statuses = entry.kind === 'draft' ? DRAFT_STATUSES : entry.kind === 'finding' ? FINDING_STATUSES : DIGEST_STATUSES
  if (!statuses.includes(entry.status)) errors.push('invalid status')
  return { ok: errors.length === 0, errors }
}

/**
 * @param {object} input
 * @param {{ now?: () => number, uuid?: () => string }} [deps]
 * @returns {object}
 */
export function createEntry(input, { now = Date.now, uuid = () => globalThis.crypto.randomUUID() } = {}) {
  const kind = input.kind
  if (!KINDS.includes(kind)) throw new Error(`unknown kind: ${kind}`)
  const entry = {
    id: uuid(),
    schemaVersion: 1,
    workspaceKey: input.workspaceKey ?? (input.sessionId ? `session:${input.sessionId}` : undefined),
    kind,
    title: input.title ?? '',
    body: input.body ?? input.text ?? '',
    status: input.status ?? defaultStatus(kind),
    createdAt: now(),
    updatedAt: now(),
  }
  for (const key of ['sessionId', 'sessionTitle', 'thoughtNo', 'severity', 'anchors', 'tags', 'batchId', 'previousBatchIds', 'promptLogId', 'sourceMessageIds', 'requestId', 'submittedVia', 'submittedAt', 'resolvedAt', 'reopenedAt', 'assignedGroupId', 'submitMode', 'reconciliationPending', 'lastSubmitError', 'retryPending', 'sourceFindingId', 'gitFootprint', 'visibility', 'workspaceId', 'completedVia', 'reviewRound', 'roundNote', 'origin', 'originKey', 'sourceTurn', 'sourceSeq', 'sourceKind', 'sourceConfidence', 'sourceCallId', 'sourceFindingNo', 'generatedAt']) {
    if (input[key] !== undefined) entry[key] = input[key]
  }
  // Acceptance evidence is persisted as an all-or-nothing pair; a caller that
  // only knows one half (or passes an invalid value) stays legacy.
  const accepted = normalizeAcceptedEvidence(input)
  if (accepted.submissionSeq !== undefined) {
    entry.acceptedAt = accepted.acceptedAt
    entry.submissionSeq = accepted.submissionSeq
  }
  if (kind === 'finding') {
    entry.text = input.text ?? entry.body
    entry.workspaceId = input.workspaceId ?? entry.workspaceKey
    if (input.tag) entry.tag = input.tag
    if (input.submissionStatus !== undefined) {
      entry.submissionStatus = input.submissionStatus
    } else {
      entry.submissionStatus = (entry.status === 'sent' || entry.status === 'submitted' || entry.status === 'resolved' || entry.status === 'dismissed') ? 'submitted' : 'unsubmitted'
    }
    if (input.reviewStatus !== undefined) {
      entry.reviewStatus = input.reviewStatus
    } else {
      entry.reviewStatus = (entry.status === 'resolved' || entry.status === 'dismissed') ? entry.status : 'pending'
    }
  }
  const check = validateEntry(entry)
  if (!check.ok) throw new Error(check.errors.join('; '))
  return entry
}

/**
 * Validate a Schema v2 FindingRecord
 * @param {object} finding
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFindingRecord(finding) {
  const errors = []
  if (finding === null || typeof finding !== 'object') {
    return { ok: false, errors: ['finding must be an object'] }
  }
  if (typeof finding.id !== 'string' || finding.id.trim() === '') {
    errors.push('id is required')
  }
  if (typeof finding.sessionId !== 'string' || finding.sessionId.trim() === '') {
    errors.push('sessionId is required')
  }
  if (typeof finding.workspaceId !== 'string') {
    errors.push('workspaceId must be a string')
  }
  if (typeof finding.text !== 'string' || finding.text.trim() === '') {
    errors.push('text is required')
  }
  if (finding.text && new TextEncoder().encode(finding.text).byteLength > BODY_HARD_CAP_BYTES) {
    errors.push('text too large')
  }
  if (typeof finding.tag !== 'string' || finding.tag.trim() === '' || finding.tag.length > TAG_KEY_MAX) {
    errors.push(`invalid tag: ${finding.tag}`)
  }
  if (!SEVERITIES.includes(finding.severity)) {
    errors.push(`invalid severity: ${finding.severity}`)
  }
  if (!SUBMISSION_STATUSES.includes(finding.submissionStatus)) {
    errors.push(`invalid submissionStatus: ${finding.submissionStatus}`)
  }
  // A non-empty `assignedGroupId` must be a real reference; absence (undefined
  // or null) keeps legacy rows readable, but an empty/whitespace/non-string
  // value is a broken link and must be rejected before it is persisted.
  if (finding.assignedGroupId !== undefined && finding.assignedGroupId !== null
    && (typeof finding.assignedGroupId !== 'string' || finding.assignedGroupId.trim() === '')) {
    errors.push(`invalid assignedGroupId: ${finding.assignedGroupId}`)
  }
  // Acceptance evidence is all-or-nothing: a record that carries only one half
  // of the pair (or an invalid value) is not a valid FindingRecord; writers
  // must drop the pair and stay legacy instead.
  if (finding.acceptedAt !== undefined || finding.submissionSeq !== undefined) {
    if (normalizeAcceptedEvidence(finding).submissionSeq === undefined) {
      errors.push('acceptedAt/submissionSeq must be a valid pair')
    }
  }
  if (finding.reviewStatus && !REVIEW_STATUSES.includes(finding.reviewStatus)) {
    errors.push(`invalid reviewStatus: ${finding.reviewStatus}`)
  }
  if (finding.thoughtNo !== undefined && (typeof finding.thoughtNo !== 'number' || isNaN(finding.thoughtNo))) {
    errors.push('thoughtNo must be a number')
  }
  if (finding.reviewRound !== undefined && (!Number.isInteger(finding.reviewRound) || finding.reviewRound < 1)) {
    errors.push('reviewRound must be a positive integer')
  }
  if (finding.roundNote !== undefined && typeof finding.roundNote !== 'string') {
    errors.push('roundNote must be a string')
  }
  if (typeof finding.createdAt !== 'number') {
    errors.push('createdAt must be a number')
  }
  if (typeof finding.updatedAt !== 'number') {
    errors.push('updatedAt must be a number')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Validate the Finding ↔ ActiveGroup relationship (invariants I1/I2):
 * - the finding must be an item of the group (no orphan link);
 * - the finding and the group must belong to the same session;
 * - a non-empty `assignedGroupId` must point at that same group.
 *
 * This is the cross-record half of Phase 4 validation. `validateFindingRecord`
 * can only check that `assignedGroupId` is a non-empty string; resolving it
 * needs the group context, so callers (submit, drag-to-group, wrap-up,
 * inherit, migrate) use this helper where a group is available. Kept in this
 * module (not active-group.js) so the dependency stays one-way: active-group
 * already imports entries.
 *
 * @param {object} finding
 * @param {object} group
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateFindingGroupLink(finding, group) {
  const errors = []
  if (!finding || typeof finding !== 'object') {
    return { ok: false, errors: ['finding must be an object'] }
  }
  if (!group || typeof group !== 'object') {
    return { ok: false, errors: ['group must be an object'] }
  }
  if (typeof finding.id !== 'string' || finding.id.trim() === '') {
    errors.push('finding id is required')
  }
  if (typeof group.id !== 'string' || group.id.trim() === '') {
    errors.push('group id is required')
  }
  if (!Array.isArray(group.items)) {
    errors.push('group items must be an array')
  } else if (!group.items.some(item => item && item.findingId === finding.id)) {
    errors.push(`finding ${finding.id} is not an item of group ${group.id}`)
  }
  if (finding.sessionId !== group.sessionId) {
    errors.push('finding and group belong to different sessions')
  }
  if (finding.assignedGroupId !== undefined && finding.assignedGroupId !== null
    && finding.assignedGroupId !== group.id) {
    errors.push(`assignedGroupId ${finding.assignedGroupId} does not match group ${group.id}`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Create a Schema v2 FindingRecord
 * @param {object} input
 * @param {{ now?: () => number, uuid?: () => string }} [deps]
 * @returns {object}
 */
export function createFindingRecord(input, { now = Date.now, uuid = () => globalThis.crypto.randomUUID() } = {}) {
  if (!input || typeof input !== 'object') throw new Error('input must be an object')
  if (typeof input.sessionId !== 'string' || !input.sessionId.trim()) throw new Error('sessionId required')

  const id = input.id ?? uuid()
  const workspaceId = input.workspaceId ?? input.workspaceKey ?? ''
  const text = input.text ?? input.body ?? input.title ?? ''
  const tag = typeof input.tag === 'string' && input.tag.trim() !== ''
    ? input.tag.trim().slice(0, TAG_KEY_MAX)
    : 'optimize'
  const severity = SEVERITIES.includes(input.severity) ? input.severity : 'minor'
  const submissionStatus = SUBMISSION_STATUSES.includes(input.submissionStatus) ? input.submissionStatus : 'unsubmitted'
  const reviewStatus = REVIEW_STATUSES.includes(input.reviewStatus) ? input.reviewStatus : 'pending'

  const record = {
    id,
    sessionId: input.sessionId.trim(),
    workspaceId,
    text,
    tag,
    severity,
    submissionStatus,
    reviewStatus,
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : now(),
    updatedAt: typeof input.updatedAt === 'number' ? input.updatedAt : now(),
  }

  if (input.thoughtNo !== undefined) record.thoughtNo = input.thoughtNo
  if (input.sourceFindingId !== undefined) record.sourceFindingId = input.sourceFindingId
  if (input.reconciliationPending !== undefined) record.reconciliationPending = input.reconciliationPending
  if (input.lastSubmitError !== undefined) record.lastSubmitError = input.lastSubmitError
  if (input.retryPending !== undefined) record.retryPending = input.retryPending
  if (input.sourceMessageId !== undefined) record.sourceMessageId = input.sourceMessageId
  if (input.assignedGroupId !== undefined) record.assignedGroupId = input.assignedGroupId
  if (input.batchId !== undefined) record.batchId = input.batchId
  if (input.previousBatchIds !== undefined) record.previousBatchIds = [...input.previousBatchIds]
  if (input.submitMode !== undefined) record.submitMode = input.submitMode
  if (input.requestId !== undefined) record.requestId = input.requestId
  if (input.submittedAt !== undefined) record.submittedAt = input.submittedAt
  if (input.resolvedAt !== undefined) record.resolvedAt = input.resolvedAt
  if (input.reopenedAt !== undefined) record.reopenedAt = input.reopenedAt
  if (input.gitFootprint !== undefined) {
    record.gitFootprint = typeof input.gitFootprint === 'object' && input.gitFootprint !== null ? { ...input.gitFootprint } : input.gitFootprint
  }
  if (input.completedVia !== undefined) record.completedVia = input.completedVia
  // Provenance fields (Turn Action Inbox)
  if (input.origin !== undefined) record.origin = input.origin
  if (input.originKey !== undefined) record.originKey = input.originKey
  if (input.sourceTurn !== undefined) record.sourceTurn = input.sourceTurn
  if (input.sourceSeq !== undefined) record.sourceSeq = input.sourceSeq
  if (input.sourceKind !== undefined) record.sourceKind = input.sourceKind
  if (input.sourceConfidence !== undefined) record.sourceConfidence = input.sourceConfidence
  if (input.sourceCallId !== undefined) record.sourceCallId = input.sourceCallId
  if (input.sourceFindingNo !== undefined) record.sourceFindingNo = input.sourceFindingNo
  if (input.generatedAt !== undefined) record.generatedAt = input.generatedAt
  // Persisted/imported acceptance evidence survives the round trip; a new
  // UI-created finding never sets the pair and therefore stays legacy.
  const accepted = normalizeAcceptedEvidence(input)
  if (accepted.submissionSeq !== undefined) {
    record.acceptedAt = accepted.acceptedAt
    record.submissionSeq = accepted.submissionSeq
  }

  // Backward compatibility
  record.kind = 'finding'
  record.body = text
  record.workspaceKey = workspaceId

  attachFindingStatus(record)
  const check = validateFindingRecord(record)
  if (!check.ok) throw new Error(check.errors.join('; '))
  return record
}

/**
 * Historical migration helper: converts a legacy v1 finding to Schema v2 FindingRecord.
 * - status === 'sent' -> submissionStatus: 'submitted', reviewStatus: 'pending'
 * - status === 'open' -> submissionStatus: 'unsubmitted', reviewStatus: 'pending'
 * - status === 'resolved' -> submissionStatus: 'submitted', reviewStatus: 'resolved'
 * - status === 'dismissed' -> submissionStatus: 'submitted', reviewStatus: 'dismissed'
 * @param {object} legacyEntry
 * @returns {object}
 */
export function migrateFinding(legacyEntry) {
  if (!legacyEntry || typeof legacyEntry !== 'object') throw new Error('legacyEntry must be an object')
  let submissionStatus = 'unsubmitted'
  let reviewStatus = 'pending'

  if (legacyEntry.submissionStatus) {
    submissionStatus = legacyEntry.submissionStatus
    reviewStatus = legacyEntry.reviewStatus ?? 'pending'
  } else if (legacyEntry.status === 'sent' || legacyEntry.status === 'queued') {
    submissionStatus = 'submitted'
    reviewStatus = 'pending'
  } else if (legacyEntry.status === 'resolved') {
    submissionStatus = 'submitted'
    reviewStatus = 'resolved'
  } else if (legacyEntry.status === 'dismissed') {
    submissionStatus = 'submitted'
    reviewStatus = 'dismissed'
  } else if (legacyEntry.status === 'open') {
    submissionStatus = 'unsubmitted'
    reviewStatus = 'pending'
  }

  const text = legacyEntry.text ?? legacyEntry.body ?? legacyEntry.title ?? ''
  const workspaceId = legacyEntry.workspaceId ?? legacyEntry.workspaceKey ?? ''
  const tag = legacyEntry.tag ?? (Array.isArray(legacyEntry.tags) && legacyEntry.tags[0] ? legacyEntry.tags[0] : 'optimize')
  const severity = legacyEntry.severity ?? 'minor'

  const record = {
    id: legacyEntry.id,
    sessionId: legacyEntry.sessionId,
    workspaceId,
    text,
    tag,
    severity,
    submissionStatus,
    reviewStatus,
    createdAt: legacyEntry.createdAt ?? Date.now(),
    updatedAt: legacyEntry.updatedAt ?? Date.now(),
  }

  if (legacyEntry.thoughtNo !== undefined) record.thoughtNo = legacyEntry.thoughtNo
  if (legacyEntry.sourceFindingId !== undefined) record.sourceFindingId = legacyEntry.sourceFindingId
  if (legacyEntry.reconciliationPending !== undefined) record.reconciliationPending = legacyEntry.reconciliationPending
  if (legacyEntry.lastSubmitError !== undefined) record.lastSubmitError = legacyEntry.lastSubmitError
  if (legacyEntry.retryPending !== undefined) record.retryPending = legacyEntry.retryPending
  if (legacyEntry.sourceMessageId !== undefined) record.sourceMessageId = legacyEntry.sourceMessageId
  if (legacyEntry.assignedGroupId !== undefined) record.assignedGroupId = legacyEntry.assignedGroupId
  if (legacyEntry.batchId !== undefined) record.batchId = legacyEntry.batchId
  if (legacyEntry.previousBatchIds !== undefined) record.previousBatchIds = [...legacyEntry.previousBatchIds]
  if (legacyEntry.submitMode !== undefined) record.submitMode = legacyEntry.submitMode
  if (legacyEntry.requestId !== undefined) record.requestId = legacyEntry.requestId
  if (legacyEntry.submittedAt !== undefined) record.submittedAt = legacyEntry.submittedAt
  if (legacyEntry.resolvedAt !== undefined) record.resolvedAt = legacyEntry.resolvedAt
  if (legacyEntry.reopenedAt !== undefined) record.reopenedAt = legacyEntry.reopenedAt
  if (legacyEntry.gitFootprint !== undefined) record.gitFootprint = legacyEntry.gitFootprint
  if (legacyEntry.completedVia !== undefined) record.completedVia = legacyEntry.completedVia
  // Provenance fields (Turn Action Inbox)
  if (legacyEntry.origin !== undefined) record.origin = legacyEntry.origin
  if (legacyEntry.originKey !== undefined) record.originKey = legacyEntry.originKey
  if (legacyEntry.sourceTurn !== undefined) record.sourceTurn = legacyEntry.sourceTurn
  if (legacyEntry.sourceSeq !== undefined) record.sourceSeq = legacyEntry.sourceSeq
  if (legacyEntry.sourceKind !== undefined) record.sourceKind = legacyEntry.sourceKind
  if (legacyEntry.sourceConfidence !== undefined) record.sourceConfidence = legacyEntry.sourceConfidence
  if (legacyEntry.sourceCallId !== undefined) record.sourceCallId = legacyEntry.sourceCallId
  if (legacyEntry.sourceFindingNo !== undefined) record.sourceFindingNo = legacyEntry.sourceFindingNo
  if (legacyEntry.generatedAt !== undefined) record.generatedAt = legacyEntry.generatedAt
  // Migration must not drop acceptance evidence that a newer writer persisted;
  // an incomplete/invalid pair degrades to legacy instead of being half-copied.
  const accepted = normalizeAcceptedEvidence(legacyEntry)
  if (accepted.submissionSeq !== undefined) {
    record.acceptedAt = accepted.acceptedAt
    record.submissionSeq = accepted.submissionSeq
  }

  record.kind = 'finding'
  record.body = text
  record.workspaceKey = workspaceId

  attachFindingStatus(record)
  return record
}

/**
 * @param {object[]} entries
 * @returns {string}
 */
export function findingBatchStatus(entries) {
  if (entries.length === 0) return 'empty'
  const statuses = entries.map(entry => entry.status)
  const active = statuses.some(status => status === 'sent' || status === 'queued' || status === 'submitted')
  const settled = statuses.some(status => status === 'resolved' || status === 'dismissed')
  if (statuses.every(status => status === 'resolved' || status === 'dismissed')) return 'archived'
  // A batch that mixes submitted/queued items with resolved/dismissed ones has
  // only been partly dealt with; calling it `sent` would hide that.
  if (active && settled) return 'partially-resolved'
  if ((statuses.some(status => status === 'sent') || statuses.some(status => status === 'submitted')) && statuses.some(status => status === 'open')) return 'partially-resolved'
  if (statuses.some(status => status === 'sent') || statuses.some(status => status === 'submitted')) return 'sent'
  if (statuses.some(status => status === 'queued')) return 'queued'
  return 'open'
}

/**
 * Rank prompt-log rows for one requestId: a real delivery (`sent` or
 * `completed`) must win over a stale `queue:` placeholder, and an `expired`
 * placeholder must not hide an already delivered message.
 * @param {string|undefined} status
 * @returns {number}
 */
function promptRowRank(status) {
  if (status === 'sent' || status === 'completed') return 3
  if (status === 'expired') return 2
  return 1
}

/**
 * Reconcile queued findings with the prompt log that the session index keeps.
 *
 * A queued finding is linked to its prompt by `requestId` only. Once that row
 * is `sent` or `completed`, the finding becomes `sent` and records the log row
 * as `promptLogId`; an `expired` row means the queued prompt was withdrawn or
 * cancelled before delivery, so the finding returns to `open` without a batch
 * or request id. Every returned entry is a new object with a fresh
 * `updatedAt`; unchanged entries are omitted so callers can persist just the
 * transitions.
 *
 * @param {object[]} entries
 * @param {object[]} promptLog
 * @param {{ now?: () => number }} [deps]
 * @returns {object[]} changed entries only
 */
export function reconcileFindingStatuses(entries, promptLog, { now = Date.now } = {}) {
  /** @type {Map<string, object>} */
  const byRequestId = new Map()
  for (const row of Array.isArray(promptLog) ? promptLog : []) {
    if (!row || typeof row.requestId !== 'string' || row.requestId === '') continue
    const existing = byRequestId.get(row.requestId)
    if (!existing || promptRowRank(row.status) > promptRowRank(existing.status)) {
      byRequestId.set(row.requestId, row)
    }
  }

  const changed = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || entry.status !== 'queued' || typeof entry.requestId !== 'string' || entry.requestId === '') continue
    const row = byRequestId.get(entry.requestId)
    if (!row) continue
    if (row.status === 'sent' || row.status === 'completed') {
      const next = {
        ...entry,
        status: 'sent',
        submissionStatus: 'submitted',
        reviewStatus: 'pending',
        promptLogId: row.messageId,
        updatedAt: now(),
      }
      changed.push(next)
    } else if (row.status === 'expired') {
      const reopened = {
        ...entry,
        status: 'open',
        submissionStatus: 'unsubmitted',
        reviewStatus: 'pending',
        updatedAt: now(),
      }
      delete reopened.batchId
      delete reopened.requestId
      // The prompt never delivered, so its acceptance evidence is void too;
      // keeping it would make a withdrawn submission look like the latest one.
      delete reopened.acceptedAt
      delete reopened.submissionSeq
      changed.push(reopened)
    }
  }
  return changed
}

/**
 * Reopen a finding to start a new submission cycle:
 * - resets submissionStatus: 'unsubmitted', reviewStatus: 'pending'
 * - unassigns assignedGroupId
 * - appends batchId to previousBatchIds
 * - sets reopenedAt: now(), updatedAt: now()
 * - clears batchId, requestId, resolvedAt
 *
 * @param {object} entry
 * @param {{ now?: () => number }} [deps]
 * @returns {object}
 */
export function reopenFinding(entry, { now = Date.now } = {}) {
  if (!entry || (entry.kind && entry.kind !== 'finding')) throw new Error('not a finding')
  const status = entry.status ?? (entry.submissionStatus === 'submitted' ? 'submitted' : 'open')
  if (!['sent', 'submitted', 'resolved', 'dismissed'].includes(status)) return entry
  // Always clone: the entry handed back must not alias the caller's array.
  const previous = [...(entry.previousBatchIds ?? [])]
  if (entry.batchId) previous.push(entry.batchId)
  const next = {
    ...entry,
    submissionStatus: 'unsubmitted',
    reviewStatus: 'pending',
    reopenedAt: now(),
    updatedAt: now(),
    previousBatchIds: previous,
  }
  delete next.assignedGroupId
  delete next.batchId
  delete next.requestId
  delete next.resolvedAt
  // A new submission cycle allocates a fresh per-session sequence; carrying the
  // old pair over would misreport `latestGroupId` until it is overwritten.
  delete next.acceptedAt
  delete next.submissionSeq
  attachFindingStatus(next)
  return next
}

/**
 * Next per-session display number (`thoughtNo`). A forked/copied finding must
 * be renumbered from the current entries instead of inheriting the source's
 * number; the sequence is display identity, not conversation provenance.
 * @param {object[]} entries
 * @returns {number}
 */
export function nextThoughtNo(entries) {
  let max = 0
  for (const entry of Array.isArray(entries) ? entries : []) {
    const value = Number(entry?.thoughtNo)
    if (Number.isFinite(value) && value > max) max = value
  }
  return max + 1
}

/**
 * Fork an existing finding into a fresh unsubmitted entry in the draft pool.
 * Fully preserves original finding as an immutable audit record.
 * Allocates a new UUID, records sourceFindingId lineage, and resets submission & review state.
 * Clears previous batch and scheduling traces: batchId, requestId, submittedAt, resolvedAt, assignedGroupId, submittedVia.
 * Does NOT inherit `thoughtNo`: the caller assigns a fresh number from the
 * current entries with `nextThoughtNo`, so the fork never duplicates a number.
 * Historical entries with reopenedAt remain read-only compatible.
 *
 * @param {object} entry Original finding
 * @param {{ now?: () => number, idGenerator?: () => string }} [deps]
 * @returns {object} Fresh forked finding record
 */
export function forkFinding(entry, { now = Date.now, idGenerator } = {}) {
  if (!entry || typeof entry !== 'object') throw new Error('entry must be an object')
  if (entry.kind && entry.kind !== 'finding') throw new Error('not a finding')

  const id = idGenerator ? idGenerator() : (globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random()))
  const timestamp = now()
  const text = entry.text ?? entry.body ?? entry.title ?? ''
  const tag = entry.tag ?? (Array.isArray(entry.tags) && entry.tags[0] ? entry.tags[0] : 'optimize')
  const tags = Array.isArray(entry.tags) ? [...entry.tags] : (entry.tag ? [entry.tag] : ['optimize'])
  const severity = entry.severity ?? 'minor'
  const sessionId = entry.sessionId ?? ''
  const workspaceId = entry.workspaceId ?? entry.workspaceKey ?? ''
  const workspaceKey = entry.workspaceKey ?? (sessionId ? `session:${sessionId}` : undefined)

  const forked = {
    id,
    sourceFindingId: entry.id,
    sessionId,
    workspaceId,
    workspaceKey,
    text,
    body: text,
    title: entry.title ?? '',
    tag,
    tags,
    severity,
    status: 'open',
    submissionStatus: 'unsubmitted',
    reviewStatus: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    kind: 'finding',
    schemaVersion: entry.schemaVersion ?? 1,
  }

  if (entry.sessionTitle !== undefined) forked.sessionTitle = entry.sessionTitle
  if (Array.isArray(entry.anchors)) forked.anchors = [...entry.anchors]

  attachFindingStatus(forked)
  return forked
}

/**
 * Filter all open, unsubmitted findings that are eligible for cross-session inheritance/triage.
 * Strictly excludes running, queued, submitted, resolved, or dismissed findings.
 * If targetWorkspaceId is provided, strictly filters entries belonging to that workspace.
 *
 * @param {Array<object>} entries
 * Findings that may be inherited into `targetWorkspaceId`.
 *
 * `options.scope`:
 * - `'workspace'` (default): only findings owned by the target workspace;
 * - `'all'`: also findings from other workspaces. Callers must treat those
 *   as copy-only so a project's assets never disappear from it.
 *
 * @param {Array<object>} entries
 * @param {string} [targetWorkspaceId]
 * @param {{ scope?: 'workspace'|'all' }} [options]
 * @returns {Array<object>}
 */
export function filterInheritableFindings(entries, targetWorkspaceId, options = {}) {
  if (!Array.isArray(entries)) return []
  const scope = options?.scope === 'all' ? 'all' : 'workspace'
  return entries.filter(e => {
    if (!e || e.kind !== 'finding') return false
    if (e.status !== 'open' && e.submissionStatus !== 'unsubmitted') return false
    if (e.assignedGroupId || e.submittedAt) return false
    if (e.reviewStatus === 'resolved' || e.reviewStatus === 'dismissed') return false
    if (scope !== 'all' && targetWorkspaceId) {
      const ws = e.workspaceId || e.workspaceKey
      if (ws !== targetWorkspaceId && e.workspaceId !== targetWorkspaceId) return false
    }
    return true
  })
}

/**
 * Execute asset inheritance / migration from source session to target session.
 *
 * @param {object} params
 * @param {Array<object>} params.findings - The selected findings to inherit
 * @param {string} params.targetSessionId - Destination session ID
 * @param {'move'|'copy'} [params.mode='move'] - 'move' (default, transfers ownership) or 'copy' (clones with new ID)
 * @param {() => string} [params.uuidGenerator] - ID generator for copy mode
 * @param {() => number} [params.now] - Timestamp generator
 * @returns {{
 *   upsertTarget: Array<object>,  // Entries to write to target session
 *   deleteSource: Array<object>,  // Entries to delete from source session (if move)
 * }}
 */
function maxThoughtNo(list) {
  let max = 0
  for (const value of Array.isArray(list) ? list : []) {
    const n = Number(value)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

export function inheritFindings({
  findings,
  targetSessionId,
  mode = 'move',
  source = null,
  existingThoughtNos = [],
  uuidGenerator = () => globalThis.crypto?.randomUUID?.() || String(Date.now() + Math.random()),
  now = Date.now,
}) {
  if (!Array.isArray(findings) || findings.length === 0 || !targetSessionId) {
    return { upsertTarget: [], deleteSource: [] }
  }

  const targetWsKey = `session:${targetSessionId}`
  const timestamp = now()

  // Inherited entries must be renumbered inside the target session; keeping the
  // source numbering produces duplicate thoughtNo values in the destination.
  const startThoughtNo = maxThoughtNo(existingThoughtNos) + 1

  if (mode === 'copy') {
    const upsertTarget = findings.map((f, index) => {
      const copy = {
        ...f,
        id: uuidGenerator(),
        thoughtNo: startThoughtNo + index,
        sessionId: targetSessionId,
        workspaceKey: targetWsKey,
        createdAt: timestamp,
        updatedAt: timestamp,
        status: 'open',
        submissionStatus: 'unsubmitted',
        reviewStatus: 'pending',
        ...(source ? { inheritedFrom: { sessionId: source.sessionId ?? null, workspaceId: source.workspaceId ?? null, at: timestamp } } : {}),
      }
      delete copy.assignedGroupId
      delete copy.batchId
      delete copy.requestId
      delete copy.submittedAt
      delete copy.resolvedAt
      // Inherited assets are unsubmitted candidates in a new session; any
      // acceptance evidence belongs to the source session's submission.
      delete copy.acceptedAt
      delete copy.submissionSeq
      return copy
    })
    return { upsertTarget, deleteSource: [] }
  }

  // mode === 'move' (default)
  const upsertTarget = findings.map((f, index) => {
    const moved = {
      ...f,
      thoughtNo: startThoughtNo + index,
      sessionId: targetSessionId,
      workspaceKey: targetWsKey,
      updatedAt: timestamp,
      status: 'open',
      submissionStatus: 'unsubmitted',
      reviewStatus: 'pending',
      ...(source ? { inheritedFrom: { sessionId: source.sessionId ?? null, workspaceId: source.workspaceId ?? null, at: timestamp } } : {}),
    }
    delete moved.assignedGroupId
    delete moved.batchId
    delete moved.requestId
    delete moved.submittedAt
    delete moved.resolvedAt
    delete moved.acceptedAt
    delete moved.submissionSeq
    return moved
  })

  return { upsertTarget, deleteSource: findings }
}


