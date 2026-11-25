/**
 * Session digest: deterministic phase segmentation and Markdown rendering for a
 * session's prompt log and review findings. Pure text/data, no DOM, store, or ctx.
 */

/** Hard cap from the spec: phases beyond this are merged into the last one. */
export const PHASE_CAP = 50

const BOUNDARY_SOURCES = new Set(['desk-batch', 'desk-draft'])
const RESOLVED = 'resolved'
const DISMISSED = 'dismissed'
const UNSENT_STATUSES = new Set(['queued', 'expired'])
const QUEUE_MESSAGE_PREFIX = 'queue:'

const GOAL_PLACEHOLDER = '（待补充）'
const EMPTY_LEFTOVER = '（无）'
const EMPTY_TIMELINE = '（无提交记录）'
const UNNAMED_FINDING = '（未命名发现）'
const EMPTY_PROMPT = '（空 prompt）'
const UNKNOWN_DATE = '—'
const DEFAULT_TITLE = '未命名会话'

const PLACEHOLDERS = new Set([GOAL_PLACEHOLDER, EMPTY_LEFTOVER, EMPTY_TIMELINE])

/**
 * @param {unknown} value
 * @returns {object|null}
 */
function asEntry(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * @param {unknown} value
 * @returns {object[]}
 */
function entryList(value) {
  return Array.isArray(value) ? value.map(asEntry).filter(Boolean) : []
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function trimText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Collapse whitespace and cap the text so a digest line stays one line.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function summarize(value, max = 120) {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max)}…`
}

/**
 * @param {object} entry
 * @returns {number}
 */
function entryTime(entry) {
  const time = entry.time
  return typeof time === 'number' && Number.isFinite(time) ? time : 0
}

/**
 * @param {object} entry
 * @returns {number|undefined}
 */
function turnNumber(entry) {
  const turn = entry.turn
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : undefined
}

/**
 * @param {object} finding
 * @returns {number}
 */
function findingTime(finding) {
  const submittedAt = finding.submittedAt
  return typeof submittedAt === 'number' && Number.isFinite(submittedAt) ? submittedAt : Number.MAX_SAFE_INTEGER
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * @param {object[]} findings
 * @returns {object[]} new array; submittedAt ascending, untimed last, id as tiebreak
 */
function sortFindings(findings) {
  return findings.slice().sort((a, b) => (
    findingTime(a) - findingTime(b) || compareText(String(a.id ?? ''), String(b.id ?? ''))
  ))
}

/**
 * @param {object[]} prompts
 * @returns {object[]} new array ordered by time, then turn, then original position
 */
function sortPrompts(prompts) {
  return prompts
    .map((prompt, index) => ({ prompt, index }))
    .sort((a, b) => (
      entryTime(a.prompt) - entryTime(b.prompt)
      || (turnNumber(a.prompt) ?? 0) - (turnNumber(b.prompt) ?? 0)
      || a.index - b.index
    ))
    .map(item => item.prompt)
}

/**
 * A prompt row is digestible only once it was actually submitted: `queued`
 * placeholders and `expired` withdrawn rows (including any leftover
 * `queue:<requestId>` row) never reach the timeline.
 * @param {object} prompt
 * @returns {boolean}
 */
function isSubmittedPrompt(prompt) {
  if (UNSENT_STATUSES.has(trimText(prompt.status))) return false
  const messageId = prompt.messageId
  return !(typeof messageId === 'string' && messageId.startsWith(QUEUE_MESSAGE_PREFIX))
}

/**
 * @param {unknown} value
 * @returns {object[]} new array of submitted prompt rows only
 */
export function submittedPrompts(value) {
  return entryList(value).filter(isSubmittedPrompt)
}

/**
 * @param {object} prompt
 * @returns {boolean}
 */
function isBoundary(prompt) {
  return BOUNDARY_SOURCES.has(prompt.source)
}

/**
 * A `desk-batch` prompt continues the current phase only when that phase is
 * itself a `desk-batch` phase for the same non-empty batchId. A sequential
 * batch submits N prompts under one batchId, and they must share one phase.
 * @param {{ promptLog: object[] }|null} current
 * @param {object} prompt
 * @returns {boolean}
 */
function continuesBatch(current, prompt) {
  if (!current || prompt.source !== 'desk-batch') return false
  const first = current.promptLog[0]
  if (!first || first.source !== 'desk-batch') return false
  const batchId = trimText(prompt.batchId)
  return batchId !== '' && trimText(first.batchId) === batchId
}

/**
 * Split already-sorted prompts; a boundary prompt opens a new phase, except a
 * same-batchId `desk-batch` continuing the current batch phase. A leading
 * boundary starts phase 1 directly instead of leaving an empty phase.
 * @param {object[]} prompts
 * @returns {{ promptLog: object[], findings: object[] }[]}
 */
function buildPhases(prompts) {
  /** @type {{ promptLog: object[], findings: object[] }[]} */
  const phases = []
  let current = null
  for (const prompt of prompts) {
    if (!current || (isBoundary(prompt) && !continuesBatch(current, prompt))) {
      current = { promptLog: [], findings: [] }
      phases.push(current)
    }
    current.promptLog.push(prompt)
  }
  return phases
}

/**
 * @param {{ promptLog: object[] }[]} phases
 * @param {number} submittedAt
 * @returns {{ promptLog: object[], findings: object[] }|null} closest phase; ties keep the earlier one
 */
function nearestPhase(phases, submittedAt) {
  let best = null
  let bestDistance = Infinity
  for (const phase of phases) {
    let distance = Infinity
    for (const prompt of phase.promptLog) {
      const diff = Math.abs(entryTime(prompt) - submittedAt)
      if (diff < distance) distance = diff
    }
    if (distance < bestDistance) {
      best = phase
      bestDistance = distance
    }
  }
  return best
}

/**
 * batchId wins over time; an untimed, unbatched finding follows the most recent
 * context (the last phase).
 * @param {{ promptLog: object[], findings: object[] }[]} phases
 * @param {object} finding
 * @returns {{ promptLog: object[], findings: object[] }|null}
 */
function phaseForFinding(phases, finding) {
  const batchId = trimText(finding.batchId)
  if (batchId !== '') {
    const byBatch = phases.find(phase => phase.promptLog.some(prompt => prompt.batchId === batchId))
    if (byBatch) return byBatch
  }
  const submittedAt = finding.submittedAt
  if (typeof submittedAt === 'number' && Number.isFinite(submittedAt)) {
    return nearestPhase(phases, submittedAt)
  }
  return phases[phases.length - 1] ?? null
}

/**
 * @param {{ promptLog: object[], findings: object[] }[]} phases
 * @param {object[]} findings
 * @returns {{ promptLog: object[], findings: object[] }[]}
 */
function assignFindings(phases, findings) {
  for (const finding of findings) {
    const phase = phaseForFinding(phases, finding)
    if (phase) phase.findings.push(finding)
  }
  for (const phase of phases) phase.findings = sortFindings(phase.findings)
  return phases
}

/**
 * @param {{ promptLog: object[], findings: object[] }[]} phases
 * @returns {{ promptLog: object[], findings: object[] }[]}
 */
function capPhases(phases) {
  if (phases.length <= PHASE_CAP) return phases
  const head = phases.slice(0, PHASE_CAP - 1)
  const tail = phases.slice(PHASE_CAP - 1)
  const merged = {
    promptLog: tail.flatMap(phase => phase.promptLog),
    findings: sortFindings(tail.flatMap(phase => phase.findings)),
  }
  return [...head, merged]
}

/**
 * Group a session's submitted prompts into deterministic phases: prompts are
 * ordered by time, and a `desk-batch` / `desk-draft` prompt opens a new phase
 * unless it is another `desk-batch` prompt of the phase's batchId. Findings
 * join by `batchId` first, then by nearest `submittedAt`; whatever is left lands
 * in the last phase. More than 50 phases are merged into the final one.
 *
 * Rows with `status: 'queued' | 'expired'` and `queue:*` placeholders are not
 * submitted prompts and are ignored before segmentation.
 *
 * @param {object[]} promptLog PromptLogEntry rows of one session
 * @param {object[]} findings DeskEntry finding rows of the same session
 * @returns {{ label: string, promptLog: object[], findings: object[] }[]}
 */
export function segmentPhases(promptLog, findings) {
  const prompts = sortPrompts(submittedPrompts(promptLog))
  const list = sortFindings(entryList(findings))

  if (prompts.length === 0) {
    if (list.length === 0) return []
    return [{ label: '阶段 1', promptLog: [], findings: list }]
  }

  const phases = capPhases(assignFindings(buildPhases(prompts), list))
  return phases.map((phase, index) => ({
    label: `阶段 ${index + 1}`,
    promptLog: phase.promptLog,
    findings: phase.findings,
  }))
}

/**
 * @param {object} anchor
 * @returns {string}
 */
function anchorLabel(anchor) {
  if (!anchor || typeof anchor !== 'object') return ''
  if (anchor.type === 'file') {
    const path = typeof anchor.path === 'string' ? anchor.path : ''
    if (path === '') return ''
    return anchor.line ? `${path}:${anchor.line}` : path
  }
  if (anchor.type === 'turn') return `turn ${anchor.turn ?? '?'}`
  if (anchor.type === 'message') return `message ${anchor.messageId ?? '?'}`
  if (anchor.type === 'text') return typeof anchor.quote === 'string' ? anchor.quote.slice(0, 40) : ''
  if (anchor.type === 'quote') return typeof anchor.text === 'string' ? anchor.text.slice(0, 40) : ''
  return ''
}

/**
 * `[severity] title — anchor`; severity and anchor are optional.
 * @param {object} finding
 * @returns {string}
 */
function findingLabel(finding) {
  const severity = trimText(finding.severity)
  const prefix = severity !== '' ? `[${severity}] ` : ''
  const title = summarize(finding.title) || summarize(finding.body) || UNNAMED_FINDING
  const anchors = Array.isArray(finding.anchors) ? finding.anchors : []
  const anchor = anchorLabel(anchors[0])
  return `${prefix}${title}${anchor ? ` — ${anchor}` : ''}`
}

/**
 * @param {object[]} prompts
 * @returns {string}
 */
function turnRange(prompts) {
  const turns = prompts.map(turnNumber).filter(turn => turn !== undefined)
  if (turns.length === 0) return ''
  const min = Math.min(...turns)
  const max = Math.max(...turns)
  return min === max ? `Turn ${min}` : `Turn ${min}-${max}`
}

/**
 * @param {{ promptLog: object[] }} phase
 * @param {number} index 0-based phase position
 * @returns {string}
 */
function phaseName(phase, index) {
  if (phase.promptLog.length === 0) return ''
  const source = phase.promptLog[0]?.source
  if (source === 'desk-batch') return '评审批次'
  if (source === 'desk-draft') return '草稿推进'
  return index === 0 ? '初始实现' : ''
}

/**
 * @param {{ promptLog: object[], findings: object[] }} phase
 * @param {number} index
 * @returns {string}
 */
function renderPhase(phase, index) {
  const lines = []
  let heading = `### 阶段 ${index + 1}`
  const name = phaseName(phase, index)
  const range = turnRange(phase.promptLog)
  if (name !== '') heading += `：${name}`
  if (range !== '') heading += `（${range}）`
  lines.push(heading)

  for (const prompt of phase.promptLog) {
    const excerpt = summarize(prompt.excerpt) || EMPTY_PROMPT
    lines.push(`- **Prompt**: ${excerpt}（工作日志 #${prompt.messageId ?? '?'}）`)
  }

  const [resolved, actionable] = [
    phase.findings.filter(finding => finding.status === RESOLVED),
    phase.findings.filter(finding => finding.status !== RESOLVED && finding.status !== DISMISSED),
  ]
  if (resolved.length > 0) {
    lines.push('- **解决发现**:')
    for (const finding of resolved) lines.push(`  - [x] ${findingLabel(finding)}`)
  }
  if (actionable.length > 0) {
    lines.push('- **遗留问题**:')
    for (const finding of actionable) lines.push(`  - [ ] ${findingLabel(finding)}`)
  }
  return lines.join('\n')
}

/**
 * @param {object[]} prompts prompts of the whole digest, time-ordered
 * @returns {string}
 */
function digestDate(prompts) {
  for (const prompt of prompts) {
    const localDate = trimText(prompt.localDate)
    if (localDate !== '') return localDate
    const time = prompt.time
    if (typeof time === 'number' && Number.isFinite(time)) {
      return new Date(time).toISOString().slice(0, 10)
    }
  }
  return UNKNOWN_DATE
}

/**
 * @param {unknown} decision
 * @returns {string}
 */
function decisionText(decision) {
  if (typeof decision === 'string') return decision.trim()
  const entry = asEntry(decision)
  if (!entry) return ''
  return trimText(entry.title) || trimText(entry.body)
}

/**
 * @param {unknown} decisions
 * @returns {string} `- item` lines, or '' when nothing usable is present
 */
function renderDecisions(decisions) {
  const list = Array.isArray(decisions) ? decisions : []
  return list
    .map(decisionText)
    .filter(line => line !== '')
    .map(line => `- ${line}`)
    .join('\n')
}

/**
 * Render a session digest as deterministic Markdown. The date comes from the
 * prompt log (never the clock) so the same input always produces the same
 * document. `轮次` counts distinct turn numbers; `已解决` counts `resolved`
 * findings, `已忽略` counts `dismissed` ones (shown only when non-zero), and
 * `遗留` counts every finding that is neither. Sections with no data fall back
 * to a Chinese placeholder that `nextDraftText` knows to skip.
 *
 * @param {object} [args]
 * @param {string} [args.sessionTitle]
 * @param {object[]} [args.promptLog]
 * @param {object[]} [args.findings]
 * @param {unknown[]} [args.decisions] strings (or `{ title, body }` entries) recorded by the user
 * @param {string} [args.nextSteps] user-authored suggestion for the next round
 * @returns {string} Markdown ending in a single newline
 */
export function renderDigest({ sessionTitle, promptLog, findings, decisions = [], nextSteps = '' } = {}) {
  const phases = segmentPhases(promptLog, findings)
  const prompts = phases.flatMap(phase => phase.promptLog)
  const list = sortFindings(entryList(findings))

  const title = summarize(sessionTitle, 80) || DEFAULT_TITLE
  const turns = new Set(prompts.map(turnNumber).filter(turn => turn !== undefined)).size
  const resolved = list.filter(finding => finding.status === RESOLVED).length
  const dismissed = list.filter(finding => finding.status === DISMISSED).length
  const leftover = list.filter(finding => finding.status !== RESOLVED && finding.status !== DISMISSED)
  const counts = [`已解决 ${resolved}`]
  if (dismissed > 0) counts.push(`已忽略 ${dismissed}`)
  counts.push(`遗留 ${leftover.length}`)
  const stats = `日期：${digestDate(prompts)} ｜ 轮次：${turns} ｜ 发现：${list.length}（${counts.join('，')}）`

  const goal = summarize(prompts[0]?.excerpt, 200) || GOAL_PLACEHOLDER
  const timeline = phases.length === 0
    ? EMPTY_TIMELINE
    : phases.map((phase, index) => renderPhase(phase, index)).join('\n\n')
  const decisionBlock = renderDecisions(decisions)
  const checklist = leftover.map(finding => `- [ ] ${findingLabel(finding)}`).join('\n')
  const suggestion = trimText(nextSteps)

  return [
    `# 会话手账 · ${title}`,
    stats,
    `## 目标\n${goal}`,
    `## 演进过程与评审时间线\n${timeline}`,
    `## 关键决策与变更\n${decisionBlock || GOAL_PLACEHOLDER}`,
    `## 遗留问题汇总（待处理清单）\n${checklist || EMPTY_LEFTOVER}`,
    `## 下一轮建议\n${suggestion || GOAL_PLACEHOLDER}`,
  ].join('\n\n') + '\n'
}

/**
 * @param {string} heading section heading without the leading `## `
 * @returns {string} the draft-facing title, or '' when the section is skipped
 */
function draftSectionTitle(heading) {
  if (heading.startsWith('目标')) return '目标'
  if (heading.startsWith('遗留问题')) return '遗留问题'
  if (heading.startsWith('下一轮建议')) return '下一轮建议'
  return ''
}

/**
 * @param {string} markdown
 * @returns {Map<string, string[]>} section title → raw body lines
 */
function collectSections(markdown) {
  /** @type {Map<string, string[]>} */
  const sections = new Map()
  let current = null
  for (const line of markdown.split('\n')) {
    if (line.startsWith('## ')) {
      const title = draftSectionTitle(line.slice(3).trim())
      if (title === '' || sections.has(title)) {
        current = null
        continue
      }
      current = []
      sections.set(title, current)
      continue
    }
    if (current) current.push(line)
  }
  return sections
}

/**
 * @param {string[]|undefined} lines
 * @returns {string}
 */
function cleanSectionBody(lines) {
  if (!lines) return ''
  const kept = lines
    .map(line => line.replace(/\s+$/, ''))
    .filter(line => !PLACEHOLDERS.has(line.trim()))
  return kept.join('\n').trim()
}

