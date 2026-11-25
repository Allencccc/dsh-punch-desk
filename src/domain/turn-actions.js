/**
 * Turn Action Inbox domain logic.
 *
 * Implements TurnDigest derivation, disposition section parsing (Section A),
 * PromptLog to Finding accurate attribution, and TurnActionItem state management.
 * Pure deterministic domain functions, no DOM or I/O.
 */

import { createEntry, forkFinding } from './entries.js'

export const VERDICT_WORDS = ['已修复', '需你确认', '需确认', '待确认', '不修', '未处理']
export const VERDICT_PATTERN = '(已修复|需你确认|需确认|待确认|不修|未处理)'

export const QUOTE_MAX_BYTES = 8 * 1024 // 8 KB（quote 上限：修正早期规范 2KB 笔误，满足多 step 长上下文）
export const BODY_MAX_BYTES = 32 * 1024  // 32 KB（body 上限：修正早期规范 8KB 笔误，防爆同时保障现场完整）
export const TITLE_MAX_CHARS = 120
export const ANSWER_EXCERPT_MAX_CHARS = 500

/**
 * Map Chinese verdict keywords to domain verdict kinds.
 * @param {string} v
 * @returns {'fixed'|'confirm'|'wontfix'|'unaddressed'|null}
 */
export function mapVerdict(v) {
  if (v === '已修复') return 'fixed'
  if (v === '需你确认' || v === '需确认' || v === '待确认') return 'confirm'
  if (v === '不修') return 'wontfix'
  if (v === '未处理') return 'unaddressed'
  return null
}

/**
 * Extract verdict from a single line or segment.
 * Strictly checks:
 * 1. Line start (optional status prefix like 状态/结论): ^(?:状态|...)?[:：]?(已修复|...)
 * 2. Separator: [—–-](已修复|...)
 * 3. Prefix: (?:状态|...): (已修复|...)
 * Rejects verdict keywords embedded in regular prose (e.g. "需要你确认").
 *
 * @param {string} s
 * @returns {'fixed'|'confirm'|'wontfix'|'unaddressed'|null}
 */
export function verdictOf(s) {
  if (typeof s !== 'string') return null
  const cleaned = s.replace(/\*\*/g, '').trim()

  // 1. Line start with optional prefix
  let m = cleaned.match(new RegExp('^(?:状态|结论|处置|判定|结果)?\\s*[:：]?\\s*' + VERDICT_PATTERN))
  if (m) return mapVerdict(m[1])

  // 2. Followed by em-dash / en-dash / hyphen separator
  m = cleaned.match(new RegExp('[—–-]\\s*' + VERDICT_PATTERN))
  if (m) return mapVerdict(m[1])

  // 3. Explicit status/verdict label prefix
  m = cleaned.match(new RegExp('(?:状态|结论|处置|判定|结果)\\s*[:：]\\s*' + VERDICT_PATTERN))
  if (m) return mapVerdict(m[1])

  return null
}

/**
 * Section A disposition section strict parser.
 * Extracts numbered items (1..N) and identifies verdicts:
 * - fixed (已修复) / wontfix (不修) -> resolution evidence
 * - confirm (需确认/待确认) / unaddressed (未处理) -> action candidates
 * Supports multiline status (e.g. next line `**状态：需确认**` / `结论：需确认`).
 * Trims detail / quote to <= QUOTE_MAX_BYTES (8 KB).
 *
 * @param {string} text
 * @param {{ includeUnparsed?: boolean }} [options]
 * @returns {Array<{ no: number|null, verdict: 'fixed'|'confirm'|'wontfix'|'unaddressed'|null, detail: string, raw?: string, prose?: boolean, unparsed?: boolean }>}
 */
export function parseDispositionSection(text, { includeUnparsed = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return []
  const lines = text.split('\n')
  const all = []
  let current = null
  // Unnumbered confirmation prose is a real action in the wild:
  // `另有一处需你确认（…）` / `一处需你确认：…`. Keep it strict: the line
  // must start with the confirm phrase (optional 另有/一处 prefix) and carry
  // text after it, so a bare `**需确认**` line remains unparsed.
  const proseConfirm = /^(?:(?:另|还)?有?一?处\s*)?需(?:你)?确认\s*(?:[:：（(]\s*)?(.+)$/u

  for (const raw of lines) {
    // Strip markdown list/header prefixes and bold markers for pattern matching
    const c = raw.replace(/^\s*(?:#{1,6}\s*|[-*+]\s+)/, '').replace(/\*\*/g, '').trim()
    const m = c.match(/^(\d{1,3})\s*[.、)）:：]\s*(.+)$/)
    if (m) {
      const no = Number(m[1])
      const detail = m[2].slice(0, QUOTE_MAX_BYTES)
      const verdict = verdictOf(detail)
      current = {
        no,
        verdict,
        detail,
        raw,
        ...(verdict ? {} : { unparsed: true }),
      }
      all.push(current)
      continue
    }

    // Unnumbered prose confirmation: capture the whole line as its own item.
    // Skip headings so a section title cannot become an action.
    if (c && !/^\s*#{1,6}\s/.test(raw) && !/^\s{2,}/.test(raw)) {
      const prose = c.match(proseConfirm)
      if (prose) {
        all.push({
          no: null,
          verdict: 'confirm',
          detail: c.slice(0, QUOTE_MAX_BYTES),
          raw,
          prose: true,
        })
        current = null
        continue
      }
    }

    // Multiline continuation: append detail, and if verdict was not found, check for explicit status line
    if (current && c && !/^\s*#{1,6}\s/.test(raw)) {
      if (!current.verdict && /^(?:状态|结论|处置|判定|结果)\s*[:：]/.test(c)) {
        const v = verdictOf(c)
        if (v) {
          current.verdict = v
          delete current.unparsed
        }
      }
      current.detail = (current.detail + ' ' + c).slice(0, QUOTE_MAX_BYTES)
    }
  }

  return includeUnparsed ? all : all.filter(item => Boolean(item.verdict))
}

/**
 * Classify final assistant answer:
 * - 'none': no non-empty text
 * - 'narration': answerSeq !== lastAmSeq (subsequent non-text assistant messages followed)
 * - 'question': ends with ? / ？ or contains ❓
 * - 'conclusion': regular conclusion text
 *
 * @param {object} t Turn tracker
 * @returns {'conclusion'|'question'|'narration'|'none'}
 */
export function classifyFinalAnswer(t) {
  if (!t || !t.answerText || t.answerText.trim() === '') return 'none'
  const trimmed = t.answerText.trim()
  // Spec §5.1 order: question wins over narration, so a text question followed
  // by a non-text assistant frame is still classified as a question.
  if (/[?？]\s*$/.test(trimmed) || /❓/.test(trimmed)) return 'question'
  if (t.lastAmSeq && t.answerSeq && t.answerSeq !== t.lastAmSeq) return 'narration'
  return 'conclusion'
}

/**
 * Generate idempotent originKey for a TurnActionItem.
 * Format: sessionId|turn|source|evidenceSeq|(findingNo ?? '-')
 *
 * @param {object} item
 * @returns {string}
 */
export function itemOriginKey(item) {
  if (!item || typeof item !== 'object') return ''
  const sessionId = item.sessionId ?? ''
  const turn = item.turn ?? 0
  const source = item.source ?? 'unknown'
  const evidenceSeq = item.evidenceSeq ?? 0
  const findingNo = item.findingNo !== undefined && item.findingNo !== null ? item.findingNo : '-'
  return `${sessionId}|${turn}|${source}|${evidenceSeq}|${findingNo}`
}

/**
 * Look up an existing Finding by its originKey in a findings collection (Array, Map, or Object).
 * Handles single match, not found, or multiple matches gracefully.
 *
 * @param {Array<object>|Map<string, object>|Record<string, object>} findings
 * @param {string} originKey
 * @returns {object|null}
 */
export function findFindingByOriginKey(findings, originKey) {
  if (!originKey || !findings) return null
  let list = []
  if (Array.isArray(findings)) {
    list = findings
  } else if (findings instanceof Map) {
    list = Array.from(findings.values())
  } else if (typeof findings === 'object') {
    list = Object.values(findings)
  }
  for (const f of list) {
    if (f && typeof f === 'object' && f.originKey === originKey) {
      return f
    }
  }
  return null
}

/**
 * Convert a TurnActionItem into a draft finding.
 * If parentFinding is provided (e.g. from item.relatedFindingId), uses forkFinding()
 * and explicitly overrides the quadruple fields: sessionId, workspaceKey, workspaceId, sessionTitle.
 * Otherwise creates a new finding via createEntry().
 * Idempotently assigns originKey and provenance.
 *
 * @param {object} params
 * @param {object} params.item TurnActionItem
 * @param {object} [params.parentFinding] Optional related finding to fork
 * @param {string} params.targetSessionId Target session ID
 * @param {string} [params.targetWorkspaceKey] Target workspace key
 * @param {string} [params.targetWorkspaceId] Target workspace ID
 * @param {string} [params.targetSessionTitle] Target session title
 * @param {number} [params.thoughtNo=1] Thought sequence number
 * @param {() => number} [params.now=Date.now] Clock function
 * @param {() => string} [params.idGenerator] UUID generator
 * @returns {object} Draft finding
 */
export function convertTurnActionToFinding({
  item,
  parentFinding = null,
  targetSessionId,
  targetWorkspaceKey,
  targetWorkspaceId,
  targetSessionTitle = '',
  thoughtNo = 1,
  now = Date.now,
  idGenerator,
}) {
  if (!item || typeof item !== 'object') {
    throw new Error('item must be an object')
  }

  const originKey = item.originKey || itemOriginKey(item)
  const effectiveSessionId = targetSessionId || item.sessionId || ''
  const effectiveWorkspaceKey = targetWorkspaceKey || (effectiveSessionId ? `session:${effectiveSessionId}` : undefined)
  const effectiveWorkspaceId = targetWorkspaceId || effectiveWorkspaceKey || ''

  if (parentFinding && typeof parentFinding === 'object') {
    const forked = forkFinding(parentFinding, { now, idGenerator })
    const parentRound = Number.isFinite(parentFinding.reviewRound) ? parentFinding.reviewRound : 1
    forked.reviewRound = parentRound + 1

    // Explicit 4 fields override to prevent falling back to frozen/archived session or wrong workspace:
    forked.sessionId = effectiveSessionId
    forked.workspaceKey = effectiveWorkspaceKey
    forked.workspaceId = effectiveWorkspaceId
    forked.sessionTitle = targetSessionTitle
    forked.thoughtNo = thoughtNo

    // A Fork must reflect the new action, not the parent's original text.
    const body = item.body || item.quote || forked.text || ''
    forked.title = item.title || forked.title || ''
    forked.text = body
    forked.body = body
    const tag = item.kind === 'turn-failed' ? 'blocker' : 'context'
    forked.tag = tag
    forked.tags = [tag]

    // Provenance
    forked.origin = 'turn-action'
    forked.originKey = originKey
    forked.sourceTurn = item.turn
    forked.sourceSeq = item.evidenceSeq
    forked.sourceKind = item.source
    forked.sourceConfidence = item.confidence
    if (item.findingNo !== undefined && item.findingNo !== null) forked.sourceFindingNo = item.findingNo
    if (item.callId) forked.sourceCallId = item.callId
    forked.generatedAt = now()

    return forked
  }

  // Regular createEntry
  return createEntry({
    kind: 'finding',
    title: item.title || `Turn ${item.turn || 0} Action`,
    body: item.body || item.quote || '',
    sessionId: effectiveSessionId,
    workspaceKey: effectiveWorkspaceKey,
    workspaceId: effectiveWorkspaceId,
    sessionTitle: targetSessionTitle,
    thoughtNo,
    status: 'open',
    submissionStatus: 'unsubmitted',
    tag: item.kind === 'turn-failed' ? 'blocker' : 'context',
    origin: 'turn-action',
    originKey,
    sourceTurn: item.turn,
    sourceSeq: item.evidenceSeq,
    sourceKind: item.source,
    sourceConfidence: item.confidence,
    ...(item.findingNo !== undefined && item.findingNo !== null ? { sourceFindingNo: item.findingNo } : {}),
    ...(item.callId ? { sourceCallId: item.callId } : {}),
    generatedAt: now(),
  }, { now, uuid: idGenerator })
}

/**
 * Execute inheritance/triage for TurnActionItems from archived session to active session.
 * Supports:
 * - 'move' (same-workspace): targets created, source items marked converted.
 * - 'copy' (cross-workspace): targets created, source items remain open.
 * - Idempotency: reuses existing finding matching originKey in active session.
 * - Quadruple field override on fork.
 *
 * @param {object} params
 * @param {Array<object>} params.items
 * @param {string} params.targetSessionId
 * @param {string} [params.targetWorkspaceKey]
 * @param {string} [params.targetWorkspaceId]
 * @param {string} [params.targetSessionTitle]
 * @param {'move'|'copy'} [params.mode='move']
 * @param {Array<object>} [params.existingEntries=[]]
 * @param {Map<string, object>} [params.parentFindingsMap=new Map()]
 * @param {() => number} [params.now=Date.now]
 * @param {() => string} [params.idGenerator]
 * @returns {{ createdFindings: object[], convertedSourceItems: object[] }}
 */
export function inheritTurnActions({
  items = [],
  targetSessionId,
  targetWorkspaceKey,
  targetWorkspaceId,
  targetSessionTitle = '',
  mode = 'move',
  existingEntries = [],
  parentFindingsMap = new Map(),
  now = Date.now,
  idGenerator,
}) {
  let currentMaxNo = 0
  for (const e of existingEntries) {
    if (typeof e.thoughtNo === 'number' && e.thoughtNo > currentMaxNo) {
      currentMaxNo = e.thoughtNo
    }
  }

  const createdFindings = []
  const convertedSourceItems = []
  const activeEntries = [...existingEntries]

  for (const item of items) {
    if (!item) continue
    const originKey = item.originKey || itemOriginKey(item)
    const existing = findFindingByOriginKey(activeEntries, originKey)
    if (existing) {
      createdFindings.push(existing)
      if (mode === 'move') {
        convertedSourceItems.push({
          ...item,
          status: 'converted',
          findingId: existing.id,
          decidedAt: now(),
        })
      }
      continue
    }

    currentMaxNo += 1
    const parent = item.relatedFindingId ? parentFindingsMap.get(item.relatedFindingId) : null
    const newFinding = convertTurnActionToFinding({
      item,
      parentFinding: parent,
      targetSessionId,
      targetWorkspaceKey,
      targetWorkspaceId,
      targetSessionTitle,
      thoughtNo: currentMaxNo,
      now,
      idGenerator,
    })

    createdFindings.push(newFinding)
    activeEntries.push(newFinding)

    if (mode === 'move') {
      convertedSourceItems.push({
        ...item,
        status: 'converted',
        findingId: newFinding.id,
        decidedAt: now(),
      })
    }
  }

  return {
    createdFindings,
    convertedSourceItems,
  }
}

/**
 * Merge existing turn action items with newly incoming items.
 * Already converted / dismissed items take precedence and maintain their status and finding link.
 * Unresolved items (open or stale) are updated with incoming evidence.
 *
 * @param {object[]} [existing=[]]
 * @param {object[]} [incoming=[]]
 * @returns {object[]}
 */
export function mergeTurnActionItems(existing = [], incoming = []) {
  const map = new Map()
  for (const item of Array.isArray(existing) ? existing : []) {
    if (!item) continue
    const key = item.id || itemOriginKey(item)
    if (key) map.set(key, item)
  }
  for (const item of Array.isArray(incoming) ? incoming : []) {
    if (!item) continue
    const key = item.id || itemOriginKey(item)
    if (!key) continue
    if (map.has(key)) {
      const prev = map.get(key)
      if (prev.status === 'converted' || prev.status === 'dismissed') {
        map.set(key, {
          ...item,
          status: prev.status,
          findingId: prev.findingId,
          decidedAt: prev.decidedAt,
        })
      } else {
        map.set(key, { ...prev, ...item })
      }
    } else {
      map.set(key, item)
    }
  }
  return Array.from(map.values())
}

/**
 * Prune excess items in a session while defending open items.
 *
 * Rule: never prune `open` items, even if their count exceeds maxItems (default 500).
 * Prioritize pruning converted, dismissed, and stale items (oldest first).
 *
 * @param {Array<object>} items
 * @param {number} [maxItems=500]
 * @returns {Array<object>}
 */
export function pruneTurnActionItems(items, maxItems = 500) {
  if (!Array.isArray(items) || items.length <= maxItems) {
    return Array.isArray(items) ? [...items] : []
  }

  const openItems = []
  const closedItems = []

  for (const item of items) {
    if (!item) continue
    if (item.status === 'open') {
      openItems.push(item)
    } else {
      closedItems.push(item)
    }
  }

  // If open items alone exceed or match maxItems, keep ALL open items (never prune open items)
  if (openItems.length >= maxItems) {
    return openItems
  }

  const allowedClosedCount = maxItems - openItems.length
  // Sort closed items descending by recency so the newest are kept
  closedItems.sort((a, b) => {
    const timeA = Number(a.decidedAt || a.createdAt || 0)
    const timeB = Number(b.decidedAt || b.createdAt || 0)
    return timeB - timeA
  })

  const keptClosed = closedItems.slice(0, allowedClosedCount)
  const combined = [...openItems, ...keptClosed]

  // Re-sort to preserve natural timeline order
  combined.sort((a, b) => {
    const turnA = Number.isFinite(a.turn) ? a.turn : 0
    const turnB = Number.isFinite(b.turn) ? b.turn : 0
    if (turnA !== turnB) return turnA - turnB
    const seqA = Number.isFinite(a.evidenceSeq) ? a.evidenceSeq : 0
    const seqB = Number.isFinite(b.evidenceSeq) ? b.evidenceSeq : 0
    if (seqA !== seqB) return seqA - seqB
    const timeA = Number(a.createdAt || 0)
    const timeB = Number(b.createdAt || 0)
    return timeA - timeB
  })

  return combined
}

/**
 * Accurately match a Section A item number against the PromptLog promptText for the turn,
 * and locate the corresponding Finding ID from findingsByRequest.
 *
 * @param {object} params
 * @param {number} params.turn - Current turn number
 * @param {Map|Array|Record} params.promptLogTurns - Prompt log rows indexed by turn or collection
 * @param {number} params.findingNo - Section A item number (1..N)
 * @param {Map|Array|Record} params.findingsByRequest - Findings indexed by requestId/batchId
 * @returns {string|null} Matched findingId or null
 */
export function matchPromptLogFinding({ turn, promptLogTurns, findingNo, findingsByRequest }) {
  if (turn === undefined || turn === null || findingNo === undefined || findingNo === null) return null
  if (!promptLogTurns || !findingsByRequest) return null

  // 1. Retrieve PromptLog row for turn
  let logRow = null
  if (promptLogTurns instanceof Map) {
    logRow = promptLogTurns.get(turn)
  } else if (Array.isArray(promptLogTurns)) {
    logRow = promptLogTurns.find(row => row && row.turn === turn)
  } else if (typeof promptLogTurns === 'object') {
    logRow = promptLogTurns[turn] || promptLogTurns[String(turn)]
  }
  if (!logRow || typeof logRow !== 'object') return null

  const promptText = logRow.promptText ?? logRow.text ?? logRow.prompt ?? ''
  const requestId = logRow.requestId || logRow.batchId
  if (!promptText || typeof promptText !== 'string' || !requestId) return null

  // 2. Parse top-level blocks from promptText
  const lines = promptText.split('\n')
  const blocks = []
  let currentBlock = null

  for (const raw of lines) {
    const m = raw.match(/^(\d+)\.\s+(.*)$/)
    if (m) {
      currentBlock = {
        no: Number(m[1]),
        header: m[2].trim(),
        bodyLines: [],
      }
      blocks.push(currentBlock)
      continue
    }
    if (currentBlock && /^\s{3,}/.test(raw)) {
      currentBlock.bodyLines.push(raw.trim())
    }
  }

  // Sequential submissions only have block 1. If sequential and findingNo != 1, return null
  const isSequential = logRow.mode === 'sequential' || (blocks.length === 1 && blocks[0].no === 1 && logRow.mode !== 'combined')
  if (isSequential && findingNo !== 1) {
    return null
  }

  const targetBlock = blocks.find(b => b.no === findingNo)
  if (!targetBlock) return null

  // 3. Retrieve candidates for requestId
  let candidates = []
  if (findingsByRequest instanceof Map) {
    candidates = findingsByRequest.get(requestId) || []
  } else if (typeof findingsByRequest === 'object' && !Array.isArray(findingsByRequest)) {
    candidates = findingsByRequest[requestId] || []
  } else if (Array.isArray(findingsByRequest)) {
    candidates = findingsByRequest.filter(f => f && (f.requestId === requestId || f.batchId === requestId))
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return null

  // 4. Match against candidates
  const headerMatch = targetBlock.header.match(/^(?:\[([^\]]+)\]\s*)?(.*)$/)
  const blockTag = headerMatch ? (headerMatch[1] || '') : ''
  const blockTitle = headerMatch ? (headerMatch[2] || '').trim() : targetBlock.header.trim()
  const blockBody = targetBlock.bodyLines.join(' ').trim()

  const matchesCandidate = (f) => {
    if (!f || typeof f !== 'object') return false
    const fTag = f.tag || (Array.isArray(f.tags) ? f.tags[0] : '') || ''
    const fTitle = (f.title || '').trim()
    const fText = (f.text || f.body || '').trim()

    if (fTitle) {
      const tagMatches = !blockTag || !fTag || blockTag.toLowerCase() === fTag.toLowerCase()
      if (tagMatches && (blockTitle.includes(fTitle) || fTitle.includes(blockTitle))) {
        return true
      }
    }
    if (fText && blockBody) {
      if (blockBody.startsWith(fText.slice(0, 30)) || fText.startsWith(blockBody.slice(0, 30))) {
        return true
      }
    } else if (fText && blockTitle) {
      if (blockTitle.startsWith(fText.slice(0, 30)) || fText.startsWith(blockTitle.slice(0, 30))) {
        return true
      }
    }
    return false
  }

  // Handle duplicate text across entries in the same request by sequence
  let duplicateIndex = 0
  for (const b of blocks) {
    if (b.no === findingNo) break
    if (b.header === targetBlock.header && b.bodyLines.join(' ') === targetBlock.bodyLines.join(' ')) {
      duplicateIndex++
    }
  }

  const matchedCandidates = []
  for (const c of candidates) {
    if (matchesCandidate(c)) {
      matchedCandidates.push(c)
    }
  }

  if (matchedCandidates.length > 0) {
    const matched = matchedCandidates[duplicateIndex] || matchedCandidates[0]
    return matched.id || null
  }

  // Positional fallback if candidates match the block count and candidate at findingNo - 1 exists
  if (candidates.length >= findingNo && candidates[findingNo - 1]) {
    const candidateAtPos = candidates[findingNo - 1]
    if (matchesCandidate(candidateAtPos)) {
      return candidateAtPos.id || null
    }
  }

  return null
}

/**
 * Derive TurnDigests and TurnActionItems from session events.
 *
 * @param {Array<object>} events - Session events
 * @param {object} [options={}]
 * @param {string} [options.sessionId]
 * @param {string} [options.workspaceKey]
 * @param {boolean} [options.includeTextHeuristic=false]
 * @param {Map|Array|Record} [options.promptLogTurns]
 * @param {Map|Array|Record} [options.findingsByRequest]
 * @param {number} [options.maxTurns]
 * @param {number} [options.sessionMaxTurn]
 * @returns {Array<object>} Array of TurnDigest objects
 */
export function deriveTurnDigests(events, options = {}) {
  const turns = new Map()
  const calls = new Map()
  const approvals = new Map()
  let currentTurn = null

  const ensureTurn = (turnNo) => {
    let t = turns.get(turnNo)
    if (!t) {
      t = {
        turn: turnNo,
        startSeq: null,
        endSeq: null,
        reason: null,
        am: 0,
        answerText: null,
        answerSeq: null,
        lastAmSeq: null,
        lastAmBlocks: null,
        interrupted: 0,
        calls: [],
      }
      turns.set(turnNo, t)
    }
    return t
  }

  const list = Array.isArray(events) ? events : []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const ev = e.event ?? (e.type === 'event' ? e.event : e)
    const type = ev.type || e.type || ''
    const d = ev.data || ev.payload || e.data || {}
    const seq = typeof ev.seq === 'number' ? ev.seq : (typeof e.seq === 'number' ? e.seq : 0)

    if (type === 'turn/start') {
      const turnNo = typeof d.turn === 'number' ? d.turn : currentTurn
      if (typeof turnNo === 'number') {
        const t = ensureTurn(turnNo)
        t.startSeq = seq
        currentTurn = turnNo
      }
      continue
    }

    if (type === 'turn/end') {
      const turnNo = typeof d.turn === 'number' ? d.turn : currentTurn
      if (typeof turnNo === 'number') {
        const t = ensureTurn(turnNo)
        t.endSeq = seq
        const reasonKind = (typeof d.reason === 'object' && d.reason?.kind)
          ? d.reason.kind
          : (typeof d.reason === 'string' ? d.reason : 'none')
        t.reason = reasonKind
        if (currentTurn === turnNo) currentTurn = null
      }
      continue
    }

    if (type === 'assistant/message') {
      const turnNo = typeof d.turn === 'number' ? d.turn : currentTurn
      if (typeof turnNo === 'number') {
        const t = ensureTurn(turnNo)
        t.am += 1
        const blocks = Array.isArray(d.message?.content)
          ? d.message.content
          : (Array.isArray(d.content) ? d.content : [])
        let text = ''
        if (typeof d.message?.text === 'string') {
          text = d.message.text
        } else if (typeof d.text === 'string') {
          text = d.text
        } else if (typeof d.message?.content === 'string') {
          text = d.message.content
        } else if (typeof d.content === 'string') {
          text = d.content
        } else if (blocks.length > 0) {
          text = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
        }
        if (text.trim() !== '') {
          t.answerText = text
          t.answerSeq = seq
        }
        t.lastAmSeq = seq
        t.lastAmBlocks = blocks.map(b => b && b.type)
        if (d.interrupted === true) t.interrupted += 1
      }
      continue
    }

    if (type === 'tool/call') {
      const turnNo = typeof d.turn === 'number' ? d.turn : currentTurn
      const callId = d.callId || d.id
      if (callId && typeof turnNo === 'number') {
        const rec = { callId, turn: turnNo, name: d.name || d.toolName, seq, result: undefined }
        calls.set(callId, rec)
        ensureTurn(turnNo).calls.push(rec)
      }
      continue
    }

    if (type === 'tool/result') {
      const toolCallId = d.message?.toolCallId || d.toolCallId || d.callId
      if (toolCallId) {
        const rec = calls.get(toolCallId)
        if (rec) rec.result = ev
      }
      continue
    }

    if (type === 'approval/asked') {
      const id = d.id || ev.id
      if (id) {
        const turnNo = typeof d.turn === 'number' ? d.turn : currentTurn
        approvals.set(id, {
          id,
          turn: turnNo,
          seq,
          toolName: d.toolName || d.name,
          reason: d.reason,
          outcome: undefined,
        })
      }
      continue
    }

    if (type === 'approval/decided') {
      const id = d.id || ev.id
      if (id) {
        const rec = approvals.get(id)
        if (rec) rec.outcome = d.outcome ?? d.decision ?? 'decided'
      }
      continue
    }
  }

  const turnNumbers = Array.from(turns.keys())
  const batchMaxTurn = turnNumbers.length > 0 ? Math.max(...turnNumbers) : 0
  const sessionMaxTurn = typeof options.sessionMaxTurn === 'number' ? options.sessionMaxTurn : batchMaxTurn

  turnNumbers.sort((a, b) => a - b)
  const slicedTurnNumbers = (typeof options.maxTurns === 'number' && options.maxTurns > 0)
    ? turnNumbers.slice(-options.maxTurns)
    : turnNumbers

  const out = []
  for (const n of slicedTurnNumbers) {
    const t = turns.get(n)
    const answerKind = classifyFinalAnswer(t)
    const items = []

    // 1. Section A dispositions
    if (t.answerText) {
      const dispositions = parseDispositionSection(t.answerText)
      for (const v of dispositions) {
        if (v.verdict === 'confirm' || v.verdict === 'unaddressed') {
          const quote = (v.detail || '').slice(0, QUOTE_MAX_BYTES)
          const verdictLabel = v.verdict === 'confirm' ? '需确认' : '未处理'
          const numberLabel = Number.isFinite(v.no) ? ` #${v.no}` : ''
          const item = {
            id: '',
            sessionId: options.sessionId || '',
            workspaceKey: options.workspaceKey || '',
            turn: n,
            source: 'prompt-tail',
            kind: v.verdict,
            confidence: 'high',
            title: `Turn ${n} · ${verdictLabel}${numberLabel}: ${quote.slice(0, 80)}`.slice(0, TITLE_MAX_CHARS),
            body: `来源：Turn ${n} · prompt-tail${numberLabel} · 置信度 high\n原文：${quote}${t.interrupted > 0 ? '\n（被中断的半截回复）' : ''}`,
            quote,
            evidenceSeq: t.answerSeq ?? t.startSeq ?? 0,
            ...(Number.isFinite(v.no) ? { findingNo: v.no } : {}),
            status: 'open',
            createdAt: Date.now(),
          }

          if (Number.isFinite(v.no) && options.promptLogTurns && options.findingsByRequest) {
            const matchedFindingId = matchPromptLogFinding({
              turn: n,
              promptLogTurns: options.promptLogTurns,
              findingNo: v.no,
              findingsByRequest: options.findingsByRequest,
            })
            if (matchedFindingId) {
              item.relatedFindingId = matchedFindingId
            }
          }

          item.id = itemOriginKey(item)
          items.push(item)
        }
      }
    }

    // 2. ask_user_question
    for (const c of t.calls) {
      if (c.name !== 'ask_user_question') continue
      const r = c.result
      if (!r) {
        const item = {
          id: '',
          sessionId: options.sessionId || '',
          workspaceKey: options.workspaceKey || '',
          turn: n,
          source: 'ask-user',
          kind: 'question-pending',
          confidence: 'high',
          callId: c.callId,
          evidenceSeq: c.seq,
          title: `Turn ${n} · 待回答提问`.slice(0, TITLE_MAX_CHARS),
          body: `来源：Turn ${n} · ask-user · 置信度 high\n状态：缺失结果 (pending)`,
          quote: 'no result',
          status: 'open',
          createdAt: Date.now(),
        }
        item.id = itemOriginKey(item)
        items.push(item)
        continue
      }

      const rd = r.data || r.payload || {}
      if (rd.message?.isError === true || rd.isError === true) {
        const errDetail = JSON.stringify(rd.error || rd.message?.error || {})
        const item = {
          id: '',
          sessionId: options.sessionId || '',
          workspaceKey: options.workspaceKey || '',
          turn: n,
          source: 'ask-user',
          kind: 'question-error',
          confidence: 'high',
          callId: c.callId,
          evidenceSeq: r.seq,
          title: `Turn ${n} · 提问错误`.slice(0, TITLE_MAX_CHARS),
          body: `来源：Turn ${n} · ask-user · 置信度 high\n错误：${errDetail}`,
          quote: errDetail.slice(0, QUOTE_MAX_BYTES),
          status: 'open',
          createdAt: Date.now(),
        }
        item.id = itemOriginKey(item)
        items.push(item)
        continue
      }

      const txt = rd.message?.content?.[0]?.text ?? (typeof rd.message?.text === 'string' ? rd.message.text : '')
      let parsed = null
      try { parsed = JSON.parse(txt) } catch {}

      if (parsed && parsed.pending === true) {
        const msg = String(parsed.message || '待回答')
        const item = {
          id: '',
          sessionId: options.sessionId || '',
          workspaceKey: options.workspaceKey || '',
          turn: n,
          source: 'ask-user',
          kind: 'question-pending',
          confidence: 'high',
          callId: c.callId,
          evidenceSeq: r.seq,
          title: `Turn ${n} · 待回答提问`.slice(0, TITLE_MAX_CHARS),
          body: `来源：Turn ${n} · ask-user · 置信度 high\n提问：${msg}`,
          quote: msg.slice(0, QUOTE_MAX_BYTES),
          status: 'open',
          createdAt: Date.now(),
        }
        item.id = itemOriginKey(item)
        items.push(item)
      }
      // If parsed contains answers or regular answered result, 0 items produced
    }

    // 3. approval
    for (const a of approvals.values()) {
      if (a.turn !== n) continue
      if (a.outcome === undefined) {
        const quote = String(a.reason || '').slice(0, QUOTE_MAX_BYTES)
        const item = {
          id: '',
          sessionId: options.sessionId || '',
          workspaceKey: options.workspaceKey || '',
          turn: n,
          source: 'approval',
          kind: 'approval-pending',
          confidence: 'high',
          evidenceSeq: a.seq,
          title: `Turn ${n} · 待审批: ${quote.slice(0, 80)}`.slice(0, TITLE_MAX_CHARS),
          body: `来源：Turn ${n} · approval · 置信度 high\n原因：${quote}`,
          quote,
          status: 'open',
          createdAt: Date.now(),
        }
        item.id = itemOriginKey(item)
        items.push(item)
      }
    }

    // 4. turn failure
    if (t.reason === 'error' || t.reason === 'aborted') {
      const isLatest = n === sessionMaxTurn
      const itemStatus = isLatest ? 'open' : 'stale'
      const item = {
        id: '',
        sessionId: options.sessionId || '',
        workspaceKey: options.workspaceKey || '',
        turn: n,
        source: 'turn-outcome',
        kind: 'turn-failed',
        confidence: 'high',
        evidenceSeq: t.endSeq ?? t.startSeq ?? 0,
        title: `Turn ${n} · 执行失败 (${t.reason})`.slice(0, TITLE_MAX_CHARS),
        body: `来源：Turn ${n} · turn-outcome · 置信度 high\n原因：${t.reason}`,
        quote: String(t.reason),
        status: itemStatus,
        createdAt: Date.now(),
      }
      item.id = itemOriginKey(item)
      items.push(item)
    }

    // 5. text-heuristic (P1 medium)
    if (options.includeTextHeuristic && items.length === 0 && answerKind === 'question' && t.answerText) {
      const quote = t.answerText.slice(0, 300)
      const item = {
        id: '',
        sessionId: options.sessionId || '',
        workspaceKey: options.workspaceKey || '',
        turn: n,
        source: 'text-heuristic',
        kind: 'text-question',
        confidence: 'medium',
        evidenceSeq: t.answerSeq ?? t.startSeq ?? 0,
        title: `Turn ${n} · 疑问待确认: ${quote.slice(0, 80)}`.slice(0, TITLE_MAX_CHARS),
        body: `来源：Turn ${n} · text-heuristic · 置信度 medium\n原文：${quote}${t.interrupted > 0 ? '\n（被中断的半截回复）' : ''}`,
        quote,
        status: 'open',
        createdAt: Date.now(),
      }
      item.id = itemOriginKey(item)
      items.push(item)
    }

    // Enforce the storage caps centrally so every producer path obeys
    // quote ≤ 8 KB and body ≤ 32 KB.
    for (const item of items) {
      item.quote = String(item.quote ?? '').slice(0, QUOTE_MAX_BYTES)
      item.body = String(item.body ?? '').slice(0, BODY_MAX_BYTES)
    }

    const digest = {
      turn: n,
      startSeq: t.startSeq ?? 0,
      endSeq: t.endSeq ?? undefined,
      reason: t.reason || 'none',
      answerSeq: t.answerSeq || undefined,
      answerKind,
      answerExcerpt: t.answerText ? t.answerText.slice(0, ANSWER_EXCERPT_MAX_CHARS) : undefined,
      items,
    }
    out.push(digest)
  }

  return out
}
