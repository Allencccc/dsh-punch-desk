/**
 * Group turn attribution: pure read-model derivation for "how many work turns
 * belong to this Active Group" (Plan 2026-11-12, Phase 1).
 *
 * Three metrics, deliberately kept apart:
 * - `elapsed`    : session turns since the group was created (session context, NOT group work).
 * - `charged`    : distinct turns actually triggered by this group's accepted submissions (fact).
 * - `attributed` : direct composer input turns attributed to this group by replaying the
 *                  submission/direct event stream (heuristic, sticky to the latest group).
 * - `groupTurns` : `charged + attributed` — the header main number.
 *
 * Rules implemented here (spec §4 / §5 / §6):
 * - latest evidence is `acceptedAt + submissionSeq` only; `submittedAt`, `groupNumber` and
 *   `CommitTrace.turn` are never used for ordering.
 * - failures / `retryPending` / half-present accepted evidence never move `latest`.
 * - legacy data (no accepted evidence) is replayed from PromptLog `desk-batch` rows, or
 *   `source='history'` rows whose `requestId` hits a submitted Finding.
 * - PromptLog rows matching an accepted Finding's `requestId` are deduped: the Finding wins,
 *   the row stays audit/charged evidence only (no second submission event).
 * - `source='history'` without a requestId is unknown (never faked as direct or submission);
 *   with an unmatched requestId it is an inferred direct turn (low confidence, still counted).
 * - direct attribution replays events turn by turn; archive state is judged at event time
 *   (`archivedTurn` / `archivedAt`), so a direct turn that happened before the wrap-up stays
 *   with the original group; only later turns fall back to the latest still-active group.
 * - direct turns without a valid `turn` are idempotent-only (`messageId`): never counted.
 * - charged needs a turn from PromptLog (primary) or Trace (supplementary); otherwise unknown.
 * - `group.turns` is legacy bookkeeping: ignored, never read as a metric.
 *
 * The module is dependency-free and side-effect-free: no I/O, no React, no Host, no clocks.
 */

const NEGATIVE_INFINITY = Number.NEGATIVE_INFINITY
const LEGACY_SUBMITTED_STATUSES = new Set(['submitted', 'sent', 'resolved', 'dismissed', 'completed'])

/**
 * @typedef {'fact'|'legacy'|'live'|'inferred'} AttributionConfidence
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * @param {unknown} value
 * @returns {string|undefined}
 */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Accepts an array, a `Map`, or a plain object keyed by id and returns a clean array.
 * PromptLog/Trace/Findings are addressed as arrays by the store, but keeping the
 * helpers shape-tolerant makes the read model safe to call from partial snapshots.
 * @param {unknown} value
 * @returns {object[]}
 */
function toList(value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object')
  if (value instanceof Map) return [...value.values()].filter(item => item && typeof item === 'object')
  if (typeof value === 'object') return Object.values(value).filter(item => item && typeof item === 'object')
  return []
}

/**
 * Binary submission fact, tolerant of pre-schema-v2 rows (`status: 'sent'`).
 * @param {object} finding
 * @returns {boolean}
 */
function isSubmittedFinding(finding) {
  if (!finding || typeof finding !== 'object') return false
  if (finding.submissionStatus === 'submitted') return true
  if (finding.submissionStatus === undefined || finding.submissionStatus === null) {
    return LEGACY_SUBMITTED_STATUSES.has(finding.status)
  }
  return false
}

/**
 * A legacy submission can only anchor a group when `assignedGroupId` is present.
 * @param {object} finding
 * @returns {boolean}
 */
function isSubmittedWithGroup(finding) {
  return isSubmittedFinding(finding) && nonEmptyString(finding?.assignedGroupId) !== undefined
}

/**
 * Read the persisted acceptance evidence pair.
 *
 * Both fields must be present and valid (`acceptedAt` a non-negative finite epoch
 * millisecond number, `submissionSeq` a positive integer — same invariant as
 * `entries.js#normalizeAcceptedEvidence`); only one of them means "legacy / no evidence"
 * (the pair is written together after `prompt()` resolves `accepted`). `retryPending`
 * findings never contribute: a retry keeps the original `requestId` and the acceptance
 * evidence is only written once the retry is accepted.
 *
 * @param {object} finding
 * @returns {{ acceptedAt: number, submissionSeq: number }|null}
 */
export function readAcceptedEvidence(finding) {
  if (!finding || typeof finding !== 'object') return null
  if (finding.retryPending === true) return null
  if (!isFiniteNumber(finding.acceptedAt) || finding.acceptedAt < 0) return null
  if (!isPositiveInteger(finding.submissionSeq)) return null
  return { acceptedAt: finding.acceptedAt, submissionSeq: finding.submissionSeq }
}

/**
 * Archive fields currently persisted on a group (all optional, write-once).
 * @param {object} group
 * @returns {{ archivedTurn?: number, archivedAt?: number, hasArchiveFields: boolean }}
 */
function archiveFrame(group) {
  const archivedTurn = isFiniteNumber(group?.archivedTurn) ? group.archivedTurn : undefined
  const archivedAt = isFiniteNumber(group?.archivedAt) ? group.archivedAt : undefined
  return { archivedTurn, archivedAt, hasArchiveFields: archivedTurn !== undefined || archivedAt !== undefined }
}

/**
 * Was `group` still active **at the time of** `event`?
 *
 * - `'active'`   : definitely not archived yet at that event.
 * - `'inactive'`  : archived before the event, or group no longer exists.
 * - `'unknown'`  : archived but neither `archivedTurn` nor `archivedAt` lets us place the event.
 *
 * Turn comparison wins when both sides have turns; otherwise fall back to timestamps.
 * Equality means "at or before the wrap-up", which is treated as active (the wrap-up is
 * written after the turn it closes).
 *
 * @param {object|undefined} group
 * @param {{ time?: number, turn?: number }} event
 * @returns {'active'|'inactive'|'unknown'|'missing'}
 */
function groupActivityAt(group, event) {
  if (!group || typeof group !== 'object') return 'missing'
  const { archivedTurn, archivedAt, hasArchiveFields } = archiveFrame(group)
  const archivedFlag = group.status === 'archived' || hasArchiveFields
  if (!archivedFlag) return 'active'
  const eventTurn = isFiniteNumber(event?.turn) ? event.turn : undefined
  const eventTime = isFiniteNumber(event?.time) ? event.time : undefined
  if (eventTurn !== undefined && archivedTurn !== undefined) {
    return eventTurn <= archivedTurn ? 'active' : 'inactive'
  }
  if (eventTime !== undefined && archivedAt !== undefined) {
    return eventTime <= archivedAt ? 'active' : 'inactive'
  }
  return 'unknown'
}

/**
 * Is the group active **now** (for the current read-only `latest`)?
 * Groups archived in the past are not eligible; a group with archive fields is
 * considered archived even if an old writer forgot `status: 'archived'`.
 * @param {object|undefined} group
 * @returns {boolean}
 */
function isGroupCurrentlyActive(group) {
  if (!group || typeof group !== 'object') return false
  if (group.status === 'archived') return false
  return !archiveFrame(group).hasArchiveFields
}

/**
 * @param {object} group
 * @returns {number}
 */
function startTurnOf(group) {
  return isFiniteNumber(group?.startTurn) ? Math.max(0, Math.floor(group.startTurn)) : 0
}

/**
 * Session turns elapsed since the group was created (session context, not group work).
 * Mirrors `sessionElapsedTurns` without importing it, keeping this module standalone.
 * @param {object} group
 * @param {number} currentTurn
 * @returns {number}
 */
function elapsedTurns(group, currentTurn) {
  const current = isFiniteNumber(currentTurn) ? Math.max(0, Math.floor(currentTurn)) : 0
  return Math.max(0, current - startTurnOf(group))
}

/**
 * Build the requestId ownership index so a PromptLog row / Trace / Finding can be
 * attributed to exactly one group. `requestId` is a join key, never a submission
 * verdict by itself (a composer message can carry a host rpcId).
 * @param {object[]} findings
 */
function indexFindings(findings) {
  const findingList = toList(findings)
  const findingById = new Map()
  const findingsByRequestId = new Map()
  const requestIdOwners = new Map()
  for (const finding of findingList) {
    if (typeof finding.id === 'string') findingById.set(finding.id, finding)
    const requestId = nonEmptyString(finding.requestId)
    if (!requestId) continue
    const bucket = findingsByRequestId.get(requestId) ?? []
    bucket.push(finding)
    findingsByRequestId.set(requestId, bucket)
    const groupId = nonEmptyString(finding.assignedGroupId)
    if (!groupId) continue
    const owners = requestIdOwners.get(requestId) ?? new Set()
    owners.add(groupId)
    requestIdOwners.set(requestId, owners)
  }
  return { findingList, findingById, findingsByRequestId, requestIdOwners }
}

/**
 * Deterministic event order (spec §5.2 step 2):
 * 1. timestamp ascending; rows without a timestamp never reach this comparator.
 * 2. same ms: submission before direct.
 * 3. two submissions: `submissionSeq` (legacy rows without a seq sort first), then groupId.
 * 4. two directs: both turns valid -> turn; otherwise messageId.
 * @param {object} left
 * @param {object} right
 * @returns {number}
 */
function compareEvents(left, right) {
  if (left.time !== right.time) return left.time - right.time
  if (left.kind !== right.kind) return left.kind === 'submission' ? -1 : 1
  if (left.kind === 'submission') {
    const leftSeq = isPositiveInteger(left.submissionSeq) ? left.submissionSeq : NEGATIVE_INFINITY
    const rightSeq = isPositiveInteger(right.submissionSeq) ? right.submissionSeq : NEGATIVE_INFINITY
    if (leftSeq !== rightSeq) return leftSeq - rightSeq
    return (left.groupId ?? '').localeCompare(right.groupId ?? '')
  }
  const leftTurn = isFiniteNumber(left.turn) ? left.turn : undefined
  const rightTurn = isFiniteNumber(right.turn) ? right.turn : undefined
  if (leftTurn !== undefined && rightTurn !== undefined && leftTurn !== rightTurn) return leftTurn - rightTurn
  if (leftTurn !== undefined && rightTurn === undefined) return -1
  if (leftTurn === undefined && rightTurn !== undefined) return 1
  return (left.messageId ?? '').localeCompare(right.messageId ?? '')
}

/**
 * Build the merged submission/direct event stream from findings + PromptLog.
 *
 * Submissions come from accepted findings (`acceptedAt + submissionSeq`) and, for legacy
 * rows only, from PromptLog. A PromptLog row whose `requestId` matches accepted evidence
 * is deduped (the Finding wins) whatever its source, so a late `desk-batch`/`history`
 * row can never reorder `latest`.
 *
 * @param {{ groups?: object[]|Map<string, object>, findings?: object[]|Map<string, object>, promptLogs?: object[]|Map<string, object> }} input
 * @returns {{ events: object[], groupById: Map<string, object>, unknownRows: number }}
 */
function buildTimeline({ groups, findings, promptLogs } = {}) {
  const groupById = new Map()
  for (const group of toList(groups)) {
    if (typeof group.id === 'string' && group.id !== '') groupById.set(group.id, group)
  }
  const { findingList, findingsByRequestId } = indexFindings(findings)

  const events = []
  const acceptedByRequestId = new Map()
  const seenAcceptedKeys = new Set()

  for (const finding of findingList) {
    const evidence = readAcceptedEvidence(finding)
    if (!evidence) continue
    const groupId = nonEmptyString(finding.assignedGroupId)
    if (!groupId) continue
    const requestId = nonEmptyString(finding.requestId)
    if (requestId) {
      const prior = acceptedByRequestId.get(requestId)
      const isEarlier = !prior
        || evidence.submissionSeq < prior.submissionSeq
        || (evidence.submissionSeq === prior.submissionSeq && evidence.acceptedAt < prior.acceptedAt)
      if (isEarlier) acceptedByRequestId.set(requestId, { groupId, ...evidence })
    }
    // combined submissions share one requestId (and one seq): one submission event.
    const key = requestId
      ? `request:${requestId}`
      : `group:${groupId}|${evidence.acceptedAt}|${evidence.submissionSeq}`
    if (seenAcceptedKeys.has(key)) continue
    seenAcceptedKeys.add(key)
    events.push({
      kind: 'submission',
      origin: 'accepted',
      confidence: 'fact',
      time: evidence.acceptedAt,
      submissionSeq: evidence.submissionSeq,
      groupId,
      requestId,
    })
  }

  let unknownRows = 0
  for (const row of toList(promptLogs)) {
    const time = isFiniteNumber(row.time) ? row.time : undefined
    const turn = isFiniteNumber(row.turn) ? row.turn : undefined
    const messageId = nonEmptyString(row.messageId)
    const requestId = nonEmptyString(row.requestId)
    const batchId = nonEmptyString(row.batchId)
    const source = nonEmptyString(row.source)
    const submittedMatch = requestId
      ? (findingsByRequestId.get(requestId) ?? []).find(isSubmittedWithGroup)
      : undefined

    /** @type {'submission'|'direct'|'unknown'} */
    let classification = 'unknown'
    if (source === 'composer' && !batchId) classification = 'direct'
    else if (source === 'desk-batch') classification = 'submission'
    else if (source === 'history' && submittedMatch) classification = 'submission'
    else if (source === 'history' && requestId) classification = 'direct'
    else if (source !== 'composer' && batchId) classification = 'submission'

    if (classification === 'unknown') {
      unknownRows += 1
      continue
    }
    // A row that cannot be placed in time cannot be ordered: mark unknown, never guess.
    if (time === undefined) {
      unknownRows += 1
      continue
    }
    if (classification === 'submission') {
      // The Finding owns the submission event once accepted evidence exists; the row
      // remains audit + charged evidence only.
      if (requestId && acceptedByRequestId.has(requestId)) continue
      const groupId = nonEmptyString(row.groupId) ?? batchId ?? nonEmptyString(submittedMatch?.assignedGroupId)
      if (!groupId) {
        unknownRows += 1
        continue
      }
      events.push({
        kind: 'submission',
        origin: source === 'history' ? 'history' : 'promptlog',
        confidence: 'fact',
        time,
        turn,
        messageId,
        requestId,
        groupId,
        submissionSeq: isPositiveInteger(row.submissionSeq) ? row.submissionSeq : undefined,
      })
      continue
    }
    events.push({
      kind: 'direct',
      origin: source === 'composer' ? 'live' : 'history',
      confidence: source === 'composer' ? 'live' : 'inferred',
      time,
      turn,
      messageId,
      requestId,
    })
  }

  events.sort(compareEvents)
  return { events, groupById, unknownRows }
}

/**
 * Replay the merged event stream once and derive every per-group attributed turn.
 *
 * `latest` changes only on submission events. A direct event uses the group that is
 * latest **at that moment** when that group was still active then (sticky), otherwise it
 * falls back to the nearest earlier submission group that was active then; no eligible
 * group means the turn stays unattributed.
 *
 * @param {ReturnType<typeof buildTimeline>} timeline
 * @returns {{
 *   byGroup: Map<string, Set<number>>,
 *   byTurn: Map<number, { groupId: string, confidence: AttributionConfidence, messageId?: string }>,
 *   coverage: { inferred: number, unknown: number, unattributed: number },
 * }}
 */
function replayTimeline({ events, groupById, unknownRows }) {
  const byGroup = new Map()
  const byTurn = new Map()
  const submissionHistory = []
  const seenDirectMessageIds = new Set()
  const coverage = { inferred: 0, unknown: unknownRows, unattributed: 0 }
  // Without a group index the caller cannot expose archive state; treat every
  // submission group as active instead of dropping all attribution.
  const hasGroupIndex = groupById.size > 0
  let currentLatest = null

  for (const event of events) {
    if (event.kind === 'submission') {
      submissionHistory.push(event)
      currentLatest = event.groupId
      continue
    }

    // `messageId` is the idempotency key for the same logged row appearing twice.
    if (event.messageId) {
      if (seenDirectMessageIds.has(event.messageId)) continue
      seenDirectMessageIds.add(event.messageId)
    }

    let resolved = null
    let ambiguous = false
    if (!hasGroupIndex) {
      resolved = submissionHistory.length > 0
        ? submissionHistory[submissionHistory.length - 1].groupId
        : null
    } else {
      if (currentLatest) {
        const state = groupActivityAt(groupById.get(currentLatest), event)
        if (state === 'active') resolved = currentLatest
        else if (state === 'unknown') ambiguous = true
      }
      if (!resolved && !ambiguous) {
        for (let index = submissionHistory.length - 1; index >= 0; index -= 1) {
          const candidate = submissionHistory[index]
          if (groupActivityAt(groupById.get(candidate.groupId), event) === 'active') {
            resolved = candidate.groupId
            break
          }
        }
      }
    }
    if (ambiguous || !resolved) {
      if (ambiguous) coverage.unknown += 1
      else coverage.unattributed += 1
      continue
    }

    // A message without a turn cannot prove one turn happened: messageId is only an
    // idempotency key here, so nothing is counted.
    const turn = isFiniteNumber(event.turn) ? event.turn : undefined
    if (turn === undefined) {
      coverage.unknown += 1
      continue
    }

    let turns = byGroup.get(resolved)
    if (!turns) {
      turns = new Set()
      byGroup.set(resolved, turns)
    }
    turns.add(turn)
    if (event.confidence === 'inferred') coverage.inferred += 1
    byTurn.set(turn, { groupId: resolved, confidence: event.confidence, messageId: event.messageId })
  }

  return { byGroup, byTurn, coverage }
}

/**
 * The group that owns the most recent accepted submission **and is still active**.
 *
 * Only accepted evidence (`acceptedAt + submissionSeq`) orders the candidates; legacy
 * PromptLog submission events are replayed when a finding has no accepted evidence yet.
 * Archived / missing groups are skipped, so the result falls back to the most recent
 * still-active group with an accepted submission. Never consults `submittedAt`,
 * `groupNumber` or trace turns; `currentTurn` is accepted for call-site parity only.
 *
 * @param {{
 *   groups?: object[]|Map<string, object>,
 *   findings?: object[]|Map<string, object>,
 *   promptLogs?: object[]|Map<string, object>,
 *   currentTurn?: number,
 * }} [input]
 * @returns {string|null}
 */
export function deriveLatestGroupId({ groups, findings, promptLogs } = {}) {
  const timeline = buildTimeline({ groups, findings, promptLogs })
  const knownGroups = timeline.groupById.size > 0
  for (let index = timeline.events.length - 1; index >= 0; index -= 1) {
    const event = timeline.events[index]
    if (event.kind !== 'submission') continue
    // Without a group index we cannot prove existence/archival; take the last submission.
    if (!knownGroups) return event.groupId
    if (isGroupCurrentlyActive(timeline.groupById.get(event.groupId))) return event.groupId
  }
  return null
}

/**
 * Attribute one direct-input turn.
 *
 * The whole submission/direct stream is replayed, so `G1 accepted -> direct -> G2 accepted
 * -> direct` yields G1 then G2 instead of assigning every turn to the final group.
 * Archive state is evaluated at the event time, therefore a direct turn that happened
 * before the wrap-up keeps its original group.
 *
 * Returns `null` for a turn that has no direct-input event (a submission turn owns no
 * attributed turn), for a turn that stayed unattributed, or for an undecidable event.
 *
 * @param {number} turn
 * @param {{
 *   groups?: object[]|Map<string, object>,
 *   findings?: object[]|Map<string, object>,
 *   promptLogs?: object[]|Map<string, object>,
 * }} [input]
 * @returns {string|null}
 */
export function latestGroupAt(turn, input = {}) {
  if (!isFiniteNumber(turn)) return null
  const replay = replayTimeline(buildTimeline(input))
  const hit = replay.byTurn.get(turn)
  return hit ? hit.groupId : null
}

/**
 * Distinct executed turns triggered by this group's submissions.
 *
 * Primary evidence is PromptLog (`requestId + turn`): `source='desk-batch'` rows, any row
 * carrying a `batchId`, and `source='history'` rows whose requestId hits a submitted
 * Finding. CommitTrace turns are supplementary and only fill requestIds PromptLog could
 * not place. Combined submissions share one requestId (1 turn); sequential submissions
 * each get their own requestId (N turns); a retried requestId still counts once.
 * Direct composer input never counts.
 *
 * @param {object} group
 * @param {{ findings?: object[]|Map<string, object>, promptLogs?: object[]|Map<string, object>, traces?: object[]|Map<string, object> }} [input]
 * @returns {number}
 */
export function countChargedTurns(group, { findings, promptLogs, traces } = {}) {
  if (!group || typeof group !== 'object') return 0
  const groupId = nonEmptyString(group.id)
  if (!groupId) return 0

  const itemIds = new Set()
  for (const item of Array.isArray(group.items) ? group.items : []) {
    const findingId = nonEmptyString(item?.findingId)
    if (findingId) itemIds.add(findingId)
  }
  const { findingList, findingById, findingsByRequestId, requestIdOwners } = indexFindings(findings)
  const groupRequestIds = new Set()
  for (const finding of findingList) {
    const assignedGroupId = nonEmptyString(finding.assignedGroupId)
    if (assignedGroupId !== groupId && !itemIds.has(finding.id)) continue
    const requestId = nonEmptyString(finding.requestId)
    if (requestId) groupRequestIds.add(requestId)
  }

  /** One turn per requestId (retries reuse the requestId); rows without an id count loosely. */
  const turnByRequestId = new Map()
  const looseTurns = new Set()
  const claimTurn = (requestId, turn) => {
    if (requestId) {
      if (!turnByRequestId.has(requestId)) turnByRequestId.set(requestId, turn)
      return
    }
    looseTurns.add(turn)
  }
  const ownedByThisGroup = requestId => {
    const owners = requestIdOwners.get(requestId)
    if (!owners || owners.size === 0) return true
    return owners.has(groupId)
  }

  for (const row of toList(promptLogs)) {
    const turn = isFiniteNumber(row.turn) ? row.turn : undefined
    if (turn === undefined) continue
    const requestId = nonEmptyString(row.requestId)
    const batchId = nonEmptyString(row.batchId)
    const source = nonEmptyString(row.source)
    const submittedMatch = requestId
      ? (findingsByRequestId.get(requestId) ?? []).find(isSubmittedWithGroup)
      : undefined
    const isSubmissionRow = source === 'desk-batch'
      || (source === 'history' && Boolean(submittedMatch))
      || (source !== 'composer' && Boolean(batchId))
    if (!isSubmissionRow) continue
    if (requestId && !ownedByThisGroup(requestId)) continue
    const rowGroupId = nonEmptyString(row.groupId) ?? batchId
    const belongsToGroup = (requestId !== undefined && groupRequestIds.has(requestId))
      || rowGroupId === groupId
      || nonEmptyString(submittedMatch?.assignedGroupId) === groupId
    if (!belongsToGroup) continue
    claimTurn(requestId, turn)
  }

  for (const trace of toList(traces)) {
    const turn = isFiniteNumber(trace.turn) ? trace.turn : undefined
    if (turn === undefined) continue
    const requestId = nonEmptyString(trace.requestId)
    if (requestId && !ownedByThisGroup(requestId)) continue
    const traceGroupIds = Array.isArray(trace.groupIds) ? trace.groupIds : []
    const traceFindingIds = Array.isArray(trace.findingIds) ? trace.findingIds : []
    const belongsToGroup = traceGroupIds.includes(groupId)
      || traceFindingIds.some(findingId => itemIds.has(findingId)
        || groupId === nonEmptyString(findingById.get(findingId)?.assignedGroupId))
      || (requestId !== undefined && groupRequestIds.has(requestId))
    if (!belongsToGroup) continue
    // Trace only supplements a requestId PromptLog could not place.
    claimTurn(requestId, turn)
  }

  return new Set([...turnByRequestId.values(), ...looseTurns]).size
}

/**
 * Distinct direct-input turns attributed to this group by the replay.
 * @param {object} group
 * @param {{
 *   groups?: object[]|Map<string, object>,
 *   findings?: object[]|Map<string, object>,
 *   promptLogs?: object[]|Map<string, object>,
 *   currentTurn?: number,
 * }} [input]
 * @returns {number}
 */
export function countAttributedTurns(group, input = {}) {
  if (!group || typeof group !== 'object') return 0
  const groupId = nonEmptyString(group.id)
  if (!groupId) return 0
  const replay = replayTimeline(buildTimeline(input))
  return replay.byGroup.get(groupId)?.size ?? 0
}

/**
 * Full group header stats.
 *
 * Archived groups prefer their write-once window snapshot (`archivedCharged /
 * archivedAttributed / archivedElapsed`); when the snapshot is absent the values fall
 * back to live derivation and `frozen` stays `false` (`source: 'live-unfrozen'`).
 *
 * `coverage` is session-level and informational: `inferred` counts low-confidence
 * backfill direct turns, `unknown` counts events whose source/turn/time could not be
 * decided, `unattributed` counts direct turns that had no eligible group.
 *
 * @param {object} group
 * @param {{
 *   groups?: object[]|Map<string, object>,
 *   findings?: object[]|Map<string, object>,
 *   promptLogs?: object[]|Map<string, object>,
 *   traces?: object[]|Map<string, object>,
 *   currentTurn?: number,
 * }} [input]
 * @returns {{
 *   groupId: string|null,
 *   elapsed: number,
 *   charged: number,
 *   attributed: number,
 *   groupTurns: number,
 *   latestGroupId: string|null,
 *   source: 'live'|'archived'|'live-unfrozen',
 *   frozen: boolean,
 *   coverage: { inferred: number, unknown: number, unattributed: number },
 * }}
 */
export function deriveGroupTurnStats(group, { groups, findings, promptLogs, traces, currentTurn } = {}) {
  const latestGroupId = deriveLatestGroupId({ groups, findings, promptLogs })
  if (!group || typeof group !== 'object') {
    return {
      groupId: null,
      elapsed: 0,
      charged: 0,
      attributed: 0,
      groupTurns: 0,
      latestGroupId,
      source: 'live',
      frozen: false,
      coverage: { inferred: 0, unknown: 0, unattributed: 0 },
    }
  }

  const groupId = nonEmptyString(group.id) ?? null
  const frame = archiveFrame(group)
  const archivedTurn = frame.archivedTurn
  // A snapshot may arrive before `status`/`archivedTurn` (partial write); treat any
  // persisted archived value as an archived record.
  const hasSnapshot = isFiniteNumber(group.archivedElapsed)
    || isFiniteNumber(group.archivedCharged)
    || isFiniteNumber(group.archivedAttributed)
  const archived = group.status === 'archived' || frame.hasArchiveFields || hasSnapshot
  const replay = replayTimeline(buildTimeline({ groups, findings, promptLogs }))
  const liveAttributed = groupId ? (replay.byGroup.get(groupId)?.size ?? 0) : 0
  const liveCharged = countChargedTurns(group, { findings, promptLogs, traces })
  const liveElapsed = elapsedTurns(group, currentTurn)

  const snapshotCharged = archived && isFiniteNumber(group.archivedCharged) ? group.archivedCharged : undefined
  const snapshotAttributed = archived && isFiniteNumber(group.archivedAttributed) ? group.archivedAttributed : undefined
  const snapshotElapsed = archived
    ? (isFiniteNumber(group.archivedElapsed)
      ? group.archivedElapsed
      : (archivedTurn !== undefined ? Math.max(0, archivedTurn - startTurnOf(group)) : undefined))
    : undefined

  const charged = snapshotCharged ?? liveCharged
  const attributed = snapshotAttributed ?? liveAttributed
  const frozen = snapshotCharged !== undefined && snapshotAttributed !== undefined

  return {
    groupId,
    elapsed: snapshotElapsed ?? liveElapsed,
    charged,
    attributed,
    groupTurns: charged + attributed,
    latestGroupId,
    source: archived ? (frozen ? 'archived' : 'live-unfrozen') : 'live',
    frozen,
    coverage: {
      inferred: replay.coverage.inferred,
      unknown: replay.coverage.unknown,
      unattributed: replay.coverage.unattributed,
    },
  }
}

/**
 * Write-once archive snapshot. Returns a **new** group object; the input is never mutated.
 *
 * Existing `archived*` fields always win, so archiving twice (or re-rendering a wrap-up)
 * cannot overwrite the frozen window. `status` / `archivedAt` are intentionally left to
 * the caller: the wrap-up path writes them in the same `putGroup` upsert.
 *
 * @param {object} group
 * @param {{ elapsed?: number, charged?: number, attributed?: number }|null|undefined} stats
 * @param {number} [archivedTurn]
 * @returns {object|null}
 */
export function freezeGroupTurnStats(group, stats, archivedTurn) {
  if (!group || typeof group !== 'object') return null
  const { archivedTurn: existingTurn } = archiveFrame(group)
  const next = { ...group }

  let turn = isFiniteNumber(archivedTurn) ? archivedTurn : existingTurn
  if (turn === undefined && isFiniteNumber(stats?.elapsed)) {
    turn = startTurnOf(group) + stats.elapsed
  }

  if (existingTurn !== undefined) next.archivedTurn = existingTurn
  else if (turn !== undefined) next.archivedTurn = turn

  if (isFiniteNumber(group.archivedElapsed)) next.archivedElapsed = group.archivedElapsed
  else if (turn !== undefined) next.archivedElapsed = Math.max(0, turn - startTurnOf(group))
  else if (isFiniteNumber(stats?.elapsed)) next.archivedElapsed = Math.max(0, stats.elapsed)

  if (isFiniteNumber(group.archivedCharged)) next.archivedCharged = group.archivedCharged
  else if (isFiniteNumber(stats?.charged)) next.archivedCharged = stats.charged

  if (isFiniteNumber(group.archivedAttributed)) next.archivedAttributed = group.archivedAttributed
  else if (isFiniteNumber(stats?.attributed)) next.archivedAttributed = stats.attributed

  return next
}
