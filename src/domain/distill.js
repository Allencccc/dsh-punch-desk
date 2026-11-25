/**
 * Finding distillation material selection and budget: pure data, no I/O.
 *
 * Contract truth: docs/superpowers/specs/2026-11-11-punch-desk-finding-distillation-design.md
 * §5.1 (snapshot/byGrade), §6 (material scope), §16.17 (CONTEXT_WINDOW_UNAVAILABLE).
 * Time is injected (`now`), never read from the clock; no fs/network/child_process.
 */

import { findingStatus, isIgnoredFinding } from './entries.js'

/** Evidence grades in truncation priority order (spec §6.2). */
export const GRADES = ['resolved', 'commit', 'submitted', 'dismissed']
/** @type {Readonly<Record<string, number>>} lower rank = higher priority */
export const GRADE_RANK = Object.freeze({ resolved: 0, commit: 1, submitted: 2, dismissed: 3 })

/** Hard cap for run budget (spec §6.3 item 5). */
export const MAX_BUDGET_TOKENS = 200000
/**
 * Output reserve subtracted from contextWindow. The spec leaves the number to
 * the analyzer contract; §7.1 prepares calls with `maxTokens: 8000`, so the
 * reserve matches that output ceiling.
 */
export const OUTPUT_RESERVE_TOKENS = 8000
/** Single-turn result pair character ceiling (spec §6.3 item 3). */
export const MAX_PAIR_CHARS = 20000
/** Unanchored-turn assistant excerpt ceiling (spec §6.3 item 2). */
export const MAX_EXCERPT_CHARS = 500
/** Code blocks fold to path + line count + first N lines (spec §6.3 item 3). */
export const CODE_FOLD_HEAD_LINES = 10
/** commitTraces retention window, mirrors store pruneCommitTraces (spec §6.2). */
export const TRACE_MAX_AGE_MS = 30 * 24 * 3600 * 1000
/** Error code when contextWindow is missing or the budget is unusable (§16.17). */
export const CONTEXT_WINDOW_UNAVAILABLE = 'CONTEXT_WINDOW_UNAVAILABLE'

const HEAD40 = /^[0-9a-f]{40}$/i
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Join the text blocks of a message `content` array. Non-text blocks (images,
 * tool payloads, ...) never enter material text.
 * @param {unknown} content
 * @returns {string}
 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/**
 * An assistant message counts as interrupted when either the message or its
 * event data carries `interrupted: true` (host shapes differ across versions).
 * @param {{ message: object, data: object }} entry
 * @returns {boolean}
 */
function isInterrupted(entry) {
  return entry?.message?.interrupted === true || entry?.data?.interrupted === true
}

/**
 * Derive turns and the `messageId → turn` reverse index from a raw session
 * event stream (spec §6.3 item 1: anchors' turn is unreliable, the index is
 * derived from `turn/start` and message order).
 *
 * Accepted events: `turn/start`, `turn/end`, `user/message`, `assistant/message`.
 * `tool/call` / `tool/result` bodies are never read. User messages must be
 * genuinely user-authored (`source.kind === 'user'`, same rule as backfill).
 * Messages after a turn's `turn/end` never join that turn's result pair.
 *
 * @param {unknown} events chronological session events `{ type, time, data }`
 * @returns {{ turns: Map<number, object>, messageTurns: Map<string, number> }}
 */
function parseSessionEvents(events) {
  /** @type {Map<number, { turn: number, ended: boolean, user: object[], assistant: object[], time: number|undefined }>} */
  const turns = new Map()
  /** @type {Map<string, number>} */
  const messageTurns = new Map()
  let currentTurn

  /** @param {number} turn */
  const ensureTurn = (turn) => {
    let rec = turns.get(turn)
    if (!rec) {
      rec = { turn, ended: false, user: [], assistant: [], time: undefined }
      turns.set(turn, rec)
    }
    return rec
  }

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object') continue
    const data = event.data
    if (event.type === 'turn/start') {
      if (isFiniteNumber(data?.turn)) {
        currentTurn = data.turn
        ensureTurn(currentTurn)
      }
      continue
    }
    if (event.type === 'turn/end') {
      const turn = isFiniteNumber(data?.turn) ? data.turn : currentTurn
      if (isFiniteNumber(turn)) ensureTurn(turn).ended = true
      continue
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    // Current hosts put the message directly in `event.data`; older payloads
    // wrap it as `{ message, turn }` (AGENTS.md §5). Accept both.
    const message = data?.message ?? data
    if (!message || typeof message !== 'object') continue
    if (typeof message.id !== 'string' || message.id === '') continue
    if (event.type === 'user/message' && message.source?.kind !== 'user') continue
    const turn = isFiniteNumber(data?.turn) ? data.turn
      : isFiniteNumber(message.turn) ? message.turn
        : currentTurn
    if (!isFiniteNumber(turn)) continue
    const rec = ensureTurn(turn)
    if (rec.ended) continue
    const entry = {
      message,
      data,
      time: isFiniteNumber(event.time) ? event.time : undefined,
    }
    if (event.type === 'user/message') rec.user.push(entry)
    else rec.assistant.push(entry)
    messageTurns.set(message.id, turn)
    if (rec.time === undefined && entry.time !== undefined) rec.time = entry.time
  }
  return { turns, messageTurns }
}

/**
 * Result pair of one turn (spec §2 / §6.3): the full user prompt plus the last
 * `interrupted !== true` assistant message before `turn/end`. An unfinished
 * turn (no `turn/end`) has no result pair. When the last non-interrupted
 * assistant message is empty (tool-only tail), the previous non-interrupted
 * message with text is used; a turn without any usable assistant text has no
 * pair.
 * @param {object|undefined} rec turn record from parseSessionEvents
 * @returns {{ userText: string, assistantText: string, userEntry: object|undefined, assistantEntry: object }|null}
 */
function turnResult(rec) {
  if (!rec || !rec.ended) return null
  const candidates = rec.assistant.filter(entry => !isInterrupted(entry))
  let assistantEntry
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    if (textOfContent(candidates[i].message.content) !== '') {
      assistantEntry = candidates[i]
      break
    }
  }
  if (!assistantEntry) return null
  const userEntry = rec.user[0]
  return {
    userText: userEntry ? textOfContent(userEntry.message.content) : '',
    assistantText: textOfContent(assistantEntry.message.content),
    userEntry,
    assistantEntry,
  }
}

/**
 * Fold one fenced code block to「path + line count + first 10 lines」
 * (spec §6.3 item 3). The info string's first token is treated as a path when
 * it looks like one, otherwise as a language label.
 * @param {string} info fence info string
 * @param {string[]} body lines inside the fence
 * @returns {string}
 */
function formatCodeFold(info, body) {
  const firstToken = info.split(/\s+/)[0] ?? ''
  const looksLikePath = firstToken.includes('/') || firstToken.startsWith('.') || /\.[A-Za-z0-9]+$/.test(firstToken)
  const label = looksLikePath ? `路径: ${firstToken}` : (firstToken !== '' ? `语言: ${firstToken}` : '无标识')
  const head = body.slice(0, CODE_FOLD_HEAD_LINES).join('\n')
  return `[代码块折叠 · ${label} · 共 ${body.length} 行]\n${head}\n[折叠结束]`
}

/**
 * Replace every fenced code block (``` or ~~~) with its fold summary. Unclosed
 * fences fold through end of text. Inline code is left untouched.
 * @param {string} text
 * @returns {string}
 */
function foldCodeBlocks(text) {
  if (typeof text !== 'string' || text === '') return ''
  const lines = text.split('\n')
  const out = []
  let i = 0
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i])
    if (!open) {
      out.push(lines[i])
      i += 1
      continue
    }
    const fence = open[1]
    const info = open[2].trim()
    const body = []
    let j = i + 1
    let closed = false
    while (j < lines.length) {
      const close = FENCE_CLOSE.exec(lines[j])
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
        closed = true
        break
      }
      body.push(lines[j])
      j += 1
    }
    out.push(formatCodeFold(info, body))
    i = closed ? j + 1 : j
  }
  return out.join('\n')
}

/**
 * First non-empty paragraph (blank-line separated), capped at `cap` chars.
 * @param {string} text
 * @param {number} cap
 * @returns {string}
 */
function firstParagraph(text, cap) {
  if (typeof text !== 'string') return ''
  let first = ''
  for (const block of text.split(/\n[ \t]*\n/)) {
    if (block.trim() !== '') {
      first = block
      break
    }
  }
  const trimmed = first.trim()
  return trimmed.length > cap ? trimmed.slice(0, cap) : trimmed
}

/**
 * Cap a result pair at `limit` chars by keeping paragraph head and tail and
 * marking the removed middle (spec §6.3 item 3「超出按段落头尾截断并标记」).
 * The result never exceeds `limit`.
 * @param {string} text
 * @param {number} limit
 * @returns {{ text: string, truncated: boolean }}
 */
function truncatePairText(text, limit) {
  if (text.length <= limit) return { text, truncated: false }
  const marker = `\n…[中间截断，原文 ${text.length} 字符]…\n`
  const budget = Math.max(0, limit - marker.length)
  const headTarget = Math.floor(budget / 2)
  const tailTarget = budget - headTarget
  let headEnd = text.lastIndexOf('\n\n', headTarget)
  if (headEnd <= 0) headEnd = headTarget
  let tailStart = text.indexOf('\n\n', text.length - tailTarget)
  if (tailStart === -1) tailStart = text.length - tailTarget
  else tailStart += 2
  return { text: text.slice(0, headEnd) + marker + text.slice(tailStart), truncated: true }
}

/**
 * Deterministic token estimate for budget math: CJK/fullwidth characters count
 * as one token, other characters as a quarter token (rounded up). Heuristic
 * only — the run's `usedTokens` echo comes from the model usage when available.
 * @param {unknown} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let wide = 0
  let narrow = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)
    const isWide = (code >= 0x2E80 && code <= 0x9FFF)
      || (code >= 0xF900 && code <= 0xFAFF)
      || (code >= 0xFE30 && code <= 0xFFEF)
      || (code >= 0x20000 && code <= 0x3FFFF)
    if (isWide) wide += 1
    else narrow += 1
  }
  return wide + Math.ceil(narrow / 4)
}

/**
 * Timestamp used for trace retention, mirroring store `pruneCommitTraces`:
 * `capturedAt ?? updatedAt ?? time ?? 0`.
 * @param {object} trace
 * @returns {number}
 */
function traceTimestamp(trace) {
  if (isFiniteNumber(trace?.capturedAt)) return trace.capturedAt
  if (isFiniteNumber(trace?.updatedAt)) return trace.updatedAt
  if (isFiniteNumber(trace?.time)) return trace.time
  return 0
}

/**
 * Pick the newest qualifying commit trace for a finding (spec §6.2 `commit`):
 * `findingIds` hit, same session, `status: 'complete'`, 40-hex `preHead` and
 * `postHead`, at least one commit. When `now` is injected, traces older than
 * the 30-day retention window are expired and do not qualify (the demotion to
 * `submitted` is reflected in `byGrade`); legacy traces without any timestamp
 * are kept, exactly like store pruning. Without `now` the bucket is trusted
 * as already pruned.
 * @param {object} finding
 * @param {object[]} traces
 * @param {number|undefined} now injected epoch ms
 * @returns {object|null}
 */
function commitTraceFor(finding, traces, now) {
  let best = null
  let bestTime = -1
  for (const trace of traces) {
    if (!trace || typeof trace !== 'object') continue
    if (!Array.isArray(trace.findingIds) || !trace.findingIds.includes(finding.id)) continue
    if (typeof trace.sessionId === 'string' && typeof finding.sessionId === 'string'
      && trace.sessionId !== finding.sessionId) continue
    if (trace.status !== 'complete') continue
    if (typeof trace.preHead !== 'string' || !HEAD40.test(trace.preHead)) continue
    if (typeof trace.postHead !== 'string' || !HEAD40.test(trace.postHead)) continue
    if (!Array.isArray(trace.commits) || trace.commits.length === 0) continue
    const ts = traceTimestamp(trace)
    if (isFiniteNumber(now) && ts !== 0 && ts < now - TRACE_MAX_AGE_MS) continue
    if (ts > bestTime || (ts === bestTime && (trace.turn ?? 0) > (best?.turn ?? 0))) {
      best = trace
      bestTime = ts
    }
  }
  return best
}

/**
 * Evidence grade of one finding (spec §6.2). `open` / unsubmitted findings are
 * excluded (null). `resolved` requires human wrap-up via group-wrap-up; any
 * other resolved path falls back to the submitted ladder.
 * @param {object} finding
 * @param {object[]} traces
 * @param {number|undefined} now injected epoch ms
 * @returns {{ grade: string, trace?: object }|null}
 */
function gradeOf(finding, traces, now) {
  if (isIgnoredFinding(finding)) return { grade: 'dismissed' }
  const status = findingStatus(finding)
  if (status === 'open') return null
  if (status === 'resolved' && finding.completedVia === 'group-wrap-up') return { grade: 'resolved' }
  const trace = commitTraceFor(finding, traces, now)
  return trace ? { grade: 'commit', trace } : { grade: 'submitted' }
}

/**
 * Resolve the anchored turn of a finding. The `messageId → turn` reverse index
 * is authoritative (capture anchors carry only a messageId; their `turn` is
 * unreliable). Only when no anchor messageId resolves do we fall back to an
 * explicit `turn` anchor / the anchor's own turn hint.
 * @param {object} finding
 * @param {Map<string, number>} messageTurns
 * @returns {{ turn: number, messageId: string|null, turnSource: string }|null}
 */
function resolveAnchor(finding, messageTurns) {
  const anchors = (Array.isArray(finding.anchors) ? finding.anchors : [])
    .filter(anchor => anchor && typeof anchor === 'object')
  for (const anchor of anchors) {
    const messageId = typeof anchor.messageId === 'string' && anchor.messageId !== '' ? anchor.messageId : null
    if (messageId && messageTurns.has(messageId)) {
      return { turn: messageTurns.get(messageId), messageId, turnSource: 'lookup' }
    }
  }
  for (const anchor of anchors) {
    const kind = anchor.type ?? anchor.kind
    const messageId = typeof anchor.messageId === 'string' && anchor.messageId !== '' ? anchor.messageId : null
    if (kind === 'turn' && isFiniteNumber(anchor.turn)) {
      return { turn: anchor.turn, messageId: null, turnSource: 'anchor' }
    }
    if (isFiniteNumber(anchor.turn)) {
      return { turn: anchor.turn, messageId, turnSource: 'anchor-fallback' }
    }
  }
  return null
}

/**
 * Recency fallback for materials without a result pair: finding timestamps.
 * @param {object} finding
 * @returns {number}
 */
function findingTime(finding) {
  for (const key of ['resolvedAt', 'submittedAt', 'createdAt']) {
    if (isFiniteNumber(finding?.[key])) return finding[key]
  }
  return 0
}

/**
 * Stable material ordering: evidence grade first (resolved > commit >
 * submitted > dismissed), then time recency (newest first), then input order.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareMaterials(a, b) {
  const rank = (GRADE_RANK[a.grade] ?? GRADES.length) - (GRADE_RANK[b.grade] ?? GRADES.length)
  if (rank !== 0) return rank
  const time = (b.time ?? 0) - (a.time ?? 0)
  if (time !== 0) return time
  return (a.index ?? 0) - (b.index ?? 0)
}

/**
 * Accept either a flat trace array or the store's per-session bucket map.
 * @param {unknown} commitTraces
 * @returns {object[]}
 */
function normalizeTraces(commitTraces) {
  if (Array.isArray(commitTraces)) return commitTraces
  if (commitTraces && typeof commitTraces === 'object') {
    const out = []
    for (const value of Object.values(commitTraces)) {
      if (Array.isArray(value)) out.push(...value)
    }
    return out
  }
  return []
}

/**
 * Build one material from a graded finding. Dismissed findings are negative
 * context only: counted, never pair-extracted, zero tokens (spec §5.1/§6.2).
 * @param {{ finding: object, graded: object, sessionId: string|null, session: object|undefined, anchor: object|null }} item
 * @param {Map<string, Set<number>>} anchoredTurns per-session anchored turn sets
 * @param {number} index input order, stable-sort tiebreaker
 * @returns {object}
 */
function buildMaterial(item, anchoredTurns, index) {
  const { finding, graded, sessionId, session, anchor } = item
  const { grade, trace } = graded
  /** @type {Record<string, any>} */
  const material = {
    findingId: finding.id,
    sessionId,
    grade,
    title: typeof finding.title === 'string' ? finding.title : '',
    body: typeof finding.body === 'string' ? finding.body : '',
    messageId: null,
    turn: null,
    turnSource: null,
    anchored: false,
    userText: '',
    assistantText: '',
    text: '',
    pairTruncated: false,
    contextTurns: [],
    tokens: 0,
    time: findingTime(finding),
    pendingConfirmation: false,
    negativeContext: grade === 'dismissed',
    index,
  }
  if (grade === 'dismissed') return material

  // Unarchived (in-progress) sessions: non-commit conclusions are demoted to
  // 「待确认」(spec §6.2 / §16.13). `submitted` is always pending confirmation.
  const archived = session ? session.archived === true : false
  material.pendingConfirmation = grade === 'submitted' || (!archived && grade !== 'commit')

  if (grade === 'commit' && trace) {
    material.traceId = trace.id
    material.preHead = trace.preHead
    material.postHead = trace.postHead
    material.commits = trace.commits.map(commit => ({
      hash: commit?.hash,
      shortHash: commit?.shortHash ?? (typeof commit?.hash === 'string' ? commit.hash.slice(0, 7) : ''),
      subject: commit?.subject ?? '',
      time: commit?.time ?? 0,
    }))
  }

  if (!anchor || !session) return material
  material.anchored = true
  material.turn = anchor.turn
  material.messageId = anchor.messageId
  material.turnSource = anchor.turnSource
  const rec = session.turns.get(anchor.turn)
  const result = turnResult(rec)
  if (!result) return material

  const userText = foldCodeBlocks(result.userText)
  const assistantText = foldCodeBlocks(result.assistantText)
  const pair = `[user]\n${userText}\n\n[assistant]\n${assistantText}`
  const capped = truncatePairText(pair, MAX_PAIR_CHARS)
  material.userText = userText
  material.assistantText = assistantText
  material.text = capped.text
  material.pairTruncated = capped.truncated
  const pairTime = result.assistantEntry?.time ?? result.userEntry?.time ?? rec?.time
  if (isFiniteNumber(pairTime)) material.time = pairTime

  // Session-level context: only ±1 adjacent turns, and only unanchored ones;
  // each contributes the assistant first paragraph ≤500 chars (spec §6.3).
  const anchoredSet = anchoredTurns.get(sessionId) ?? new Set()
  for (const neighbor of [anchor.turn - 1, anchor.turn + 1]) {
    if (anchoredSet.has(neighbor)) continue
    const neighborResult = turnResult(session.turns.get(neighbor))
    if (!neighborResult) continue
    const excerpt = firstParagraph(foldCodeBlocks(neighborResult.assistantText), MAX_EXCERPT_CHARS)
    if (excerpt === '') continue
    material.contextTurns.push({ turn: neighbor, excerpt })
  }
  material.tokens = estimateTokens(material.text)
    + material.contextTurns.reduce((sum, context) => sum + estimateTokens(context.excerpt), 0)
  return material
}

/**
 * Select distillation materials from findings, commit traces and raw session
 * history (spec §6). Pure: time is injected via `now`, never read from a clock.
 *
 * @param {{
 *   findings?: object[],
 *   commitTraces?: object[]|Record<string, object[]>,
 *   sessionTurns?: Array<{ sessionId: string, archived?: boolean, events?: object[] }>,
 *   now?: number,
 * }} [input]
 *   `sessionTurns` carries one entry per session with the raw `sessionQuery`
 *   event stream (`turn/start`, `user/message`, `assistant/message`,
 *   `tool/call`, `tool/result`, `turn/end`); turns and the messageId reverse
 *   index are derived here. `archived` defaults to false (in-progress sessions
 *   demote non-commit conclusions). `commitTraces` is a flat trace array (the
 *   store's per-session bucket map is also accepted). When `now` (epoch ms) is
 *   provided, traces older than 30 days demote `commit` → `submitted`.
 * @returns {{
 *   materials: object[],
 *   byGrade: { resolved: number, commit: number, submitted: number, dismissed: number },
 *   materialCount: number,
 * }}
 *   `materials` is sorted by evidence grade then time recency (newest first),
 *   ready for `truncateMaterials`. Each material carries
 *   `{ findingId, sessionId, grade, title, body, messageId, turn, turnSource,
 *      anchored, userText, assistantText, text, pairTruncated, contextTurns,
 *      tokens, time, pendingConfirmation, negativeContext, index }`;
 *   commit-grade materials add `{ traceId, preHead, postHead, commits }`.
 *   `materialCount === materials.length === sum(byGrade)`; dismissed findings
 *   are counted as negative context only (no pair text, zero tokens).
 */
export function selectMaterials({ findings, commitTraces, sessionTurns, now } = {}) {
  const findingList = Array.isArray(findings) ? findings : []
  const traces = normalizeTraces(commitTraces)
  /** @type {Map<string, { archived: boolean, turns: Map<number, object>, messageTurns: Map<string, number> }>} */
  const sessions = new Map()
  for (const entry of Array.isArray(sessionTurns) ? sessionTurns : []) {
    if (!entry || typeof entry !== 'object' || typeof entry.sessionId !== 'string') continue
    const parsed = parseSessionEvents(entry.events)
    sessions.set(entry.sessionId, { archived: entry.archived === true, ...parsed })
  }

  // Phase 1: grade every finding and resolve anchors, so the per-session
  // anchored-turn sets are complete before ±1 context is assembled.
  const anchoredTurns = new Map()
  const resolved = []
  for (const finding of findingList) {
    if (!finding || typeof finding !== 'object' || typeof finding.id !== 'string' || finding.id === '') continue
    const graded = gradeOf(finding, traces, now)
    if (!graded) continue
    const sessionId = typeof finding.sessionId === 'string' && finding.sessionId !== '' ? finding.sessionId : null
    const session = sessionId ? sessions.get(sessionId) : undefined
    const anchor = session ? resolveAnchor(finding, session.messageTurns) : null
    if (anchor && sessionId) {
      if (!anchoredTurns.has(sessionId)) anchoredTurns.set(sessionId, new Set())
      anchoredTurns.get(sessionId).add(anchor.turn)
    }
    resolved.push({ finding, graded, sessionId, session, anchor })
  }

  // Phase 2: extract result pairs and context, then order by grade → recency.
  const materials = resolved.map((item, index) => buildMaterial(item, anchoredTurns, index))
  materials.sort(compareMaterials)
  const byGrade = { resolved: 0, commit: 0, submitted: 0, dismissed: 0 }
  for (const material of materials) byGrade[material.grade] += 1
  return { materials, byGrade, materialCount: materials.length }
}

/**
 * Run-level budget (spec §6.3 item 5 / §16.17). Independent of material
 * extraction: `maxTokens = min(200000, contextWindow - OUTPUT_RESERVE_TOKENS)`.
 * A missing/non-numeric contextWindow or a budget ≤ 0 rejects with
 * `CONTEXT_WINDOW_UNAVAILABLE` — never a guessed default.
 *
 * @param {{ contextWindow?: number, materialTokens?: number }} [input]
 *   `materialTokens` is the estimated total token demand of the materials
 *   (e.g. the sum of `material.tokens`); it only drives the `truncated` echo.
 * @returns {{ ok: true, maxTokens: number, usedTokens: number, truncated: boolean }
 *   | { ok: false, error: { code: string, message: string } }}
 */
export function computeBudget({ contextWindow, materialTokens } = {}) {
  if (!isFiniteNumber(contextWindow) || contextWindow <= 0) {
    return {
      ok: false,
      error: {
        code: CONTEXT_WINDOW_UNAVAILABLE,
        message: '无法读取模型 contextWindow，请检查模型配置后重试',
      },
    }
  }
  const maxTokens = Math.min(MAX_BUDGET_TOKENS, contextWindow - OUTPUT_RESERVE_TOKENS)
  if (maxTokens <= 0) {
    return {
      ok: false,
      error: {
        code: CONTEXT_WINDOW_UNAVAILABLE,
        message: `模型 contextWindow（${contextWindow}）不足以覆盖输出预留（${OUTPUT_RESERVE_TOKENS} tokens），请更换更大上下文的模型`,
      },
    }
  }
  const usedTokens = isFiniteNumber(materialTokens) && materialTokens > 0 ? Math.ceil(materialTokens) : 0
  return { ok: true, maxTokens, usedTokens, truncated: usedTokens > maxTokens }
}

/**
 * Truncate materials by「证据等级 → 时间新近」(spec §6.3 item 5): keep the
 * highest-priority prefix that fits `maxTokens`, drop the tail, and echo
 * `truncated`. Input is re-sorted defensively, so callers may pass materials
 * in any order; `selectMaterials` output is already ordered.
 *
 * @param {object[]} materials materials carrying `grade`, `time`, `tokens`
 * @param {number} maxTokens budget from computeBudget
 * @returns {{ materials: object[], usedTokens: number, truncated: boolean }}
 */
export function truncateMaterials(materials, maxTokens) {
  const list = (Array.isArray(materials) ? materials : [])
    .filter(material => material && typeof material === 'object')
  const sorted = [...list].sort(compareMaterials)
  if (!isFiniteNumber(maxTokens) || maxTokens <= 0) {
    return { materials: [], usedTokens: 0, truncated: sorted.length > 0 }
  }
  const kept = []
  let usedTokens = 0
  let truncated = false
  for (const material of sorted) {
    const tokens = isFiniteNumber(material.tokens) && material.tokens > 0 ? material.tokens : 0
    if (usedTokens + tokens > maxTokens) {
      truncated = true
      break
    }
    kept.push(material)
    usedTokens += tokens
  }
  return { materials: kept, usedTokens, truncated }
}