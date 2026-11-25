/**
 * Distill plan domain: ChangePlan contract, pure validation and deterministic
 * Markdown synthesis (spec 2026-11-11 finding-distillation §5.2 / §8.3 / §8.4 /
 * §9 / §12). Pure data, no I/O: this module never touches fs / child_process /
 * network. Disk reads, SHA-256 of files, snapshot collection and the navigation
 * tree read belong to `src/store/distill-host.js`; the domain only consumes the
 * collected `TargetSurfaceSnapshot`.
 *
 * Snapshot anchor convention (shared with the host collector — reuse
 * `collectAtxAnchors` to guarantee identical semantics):
 * - `startLine` / `endLine` are 0-based line indexes into the BOM/CRLF
 *   normalized content; `endLine` is EXCLUSIVE (section spans
 *   `[startLine, endLine)`).
 * - A section runs from its ATX heading line up to (not including) the next
 *   heading of the same or higher level, so child sections are included.
 * - Pseudo headings inside fenced code blocks are excluded; setext headings
 *   are not recognized.
 */

import { createHash } from 'node:crypto'

export const PLAN_SCHEMA_VERSION = 1
export const CHANGE_KINDS = ['append-section', 'insert-into-section', 'replace-block', 'create-file']
export const EVIDENCE_GRADES = ['resolved', 'commit', 'submitted', 'dismissed']
/** resolved > commit > submitted; dismissed is negative context only. */
export const GRADE_RANK = { resolved: 3, commit: 2, submitted: 1, dismissed: 0 }
/** D15: code wins / adopt the newer session / leave to human arbitration. */
export const CONFLICT_RESOLUTIONS = ['code', 'session', 'unresolved']
export const ROOT_FILES = ['AGENTS.md', 'README.md']
/** §8.3.6 batch limits; §5.2 evidenceSnippet cap. */
export const LIMITS = { maxFiles: 10, maxTotalBytes: 500 * 1024, maxEvidenceSnippet: 300 }

const SHA256_RE = /^[0-9a-f]{64}$/
/** ChangeLog row shape: a Markdown table row carrying an ISO date (§9 变更闭环). */
const CHANGELOG_ROW_RE = /^\s*\|.*\d{4}-\d{2}-\d{2}.*\|\s*$/m
const encoder = new TextEncoder()

/**
 * @param {string} text
 * @returns {number} UTF-8 byte length
 */
function byteLength(text) {
  return encoder.encode(text).byteLength
}

/**
 * Normalize file encoding for synthesis: strip a leading BOM and unify
 * CRLF / lone CR to LF (§8.4). Idempotent.
 * @param {string} text
 * @returns {string}
 */
export function normalizeNewlines(text) {
  if (typeof text !== 'string') return ''
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

/**
 * Split normalized content into lines without the phantom empty element a
 * trailing newline would produce ('a\n' -> ['a'], 'a\n\n' -> ['a', '']).
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  if (content === '') return []
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '' && content.endsWith('\n')) lines.pop()
  return lines
}

/**
 * §8.3 rules 1–3 (pure part): `.md` only; normalized relative path must be
 * `AGENTS.md` | `README.md` | `docs/**`; reject absolute paths, `..`, empty
 * segments, `.` segments, backslashes and hidden (`.`-prefixed) segments.
 * Symlink / directory-existence checks are host-side (lstat), not pure.
 * @param {any} file
 * @returns {boolean}
 */
export function isAllowedDocPath(file) {
  if (typeof file !== 'string' || file === '') return false
  if (file.includes('\\') || file.includes('\0')) return false
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) return false
  if (!file.endsWith('.md')) return false
  const segments = file.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return false
  return file === 'AGENTS.md' || file === 'README.md' || file.startsWith('docs/')
}

/**
 * Recognize a single ATX heading line (§8.4 锚点细则): ≤3 leading spaces,
 * 1–6 `#` followed by whitespace or end of line, optional closing `#`
 * sequence (whitespace-preceded). Setext is NOT recognized. Text is returned
 * with trailing whitespace stripped; case is preserved.
 * @param {string} line
 * @returns {{ level: number, text: string } | null}
 */
export function parseAtxHeading(line) {
  if (typeof line !== 'string') return null
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line)
  if (!m) return null
  let text = m[2] ?? ''
  text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '')
  return { level: m[1].length, text }
}

/**
 * Fenced-code-aware ATX heading collection over normalized content. Produces
 * the snapshot anchor shape `{ text, level, startLine, endLine }` (0-based,
 * endLine exclusive, child sections included). Host collectors should reuse
 * this pure helper so snapshot anchors and domain synthesis agree exactly.
 * @param {string} content
 * @returns {Array<{ text: string, level: number, startLine: number, endLine: number }>}
 */
export function collectAtxAnchors(content) {
  const lines = splitLines(normalizeNewlines(content))
  const headings = []
  let fence = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (!fence) {
        fence = { char: marker[0], length: marker.length }
      } else if (marker[0] === fence.char && marker.length >= fence.length && fenceMatch[2].trim() === '') {
        fence = null
      }
      continue
    }
    if (fence) continue
    const heading = parseAtxHeading(line)
    if (heading) headings.push({ ...heading, line: i })
  }
  return headings.map((h, idx) => {
    let end = lines.length
    for (let j = idx + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) { end = headings[j].line; break }
    }
    return { text: h.text, level: h.level, startLine: h.line, endLine: end }
  })
}

/**
 * Fingerprint normalization (§12.1): Unicode NFC; newlines unified to `\n`;
 * trailing whitespace stripped per line; runs of >2 consecutive blank lines
 * collapse to 1 (1–2 blank lines are kept); heading lines keep their level
 * (only trailing whitespace is removed). Idempotent.
 * @param {string} text
 * @returns {string}
 */
export function normalizeForFingerprint(text) {
  if (typeof text !== 'string') return ''
  const lines = normalizeNewlines(text.normalize('NFC')).split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  const out = []
  let blankRun = 0
  const flush = () => {
    if (blankRun === 0) return
    const keep = blankRun > 2 ? 1 : blankRun
    for (let i = 0; i < keep; i++) out.push('')
    blankRun = 0
  }
  for (const line of lines) {
    if (line === '') { blankRun++; continue }
    flush()
    out.push(line)
  }
  flush()
  return out.join('\n')
}

/**
 * Canonical anchor value for fingerprints: ATX anchors normalize to
 * `'#'.repeat(level) + ' ' + text` (closing `#` / leading spaces / trailing
 * whitespace removed); an omitted anchor (append-section) is `''` (§8.4).
 * @param {string | null | undefined} sectionAnchor
 * @returns {string}
 */
function canonicalAnchor(sectionAnchor) {
  if (typeof sectionAnchor !== 'string' || sectionAnchor.trim() === '') return ''
  const parsed = parseAtxHeading(normalizeNewlines(sectionAnchor).replace(/[ \t]+$/, ''))
  if (!parsed) return sectionAnchor.replace(/[ \t]+$/, '')
  return parsed.text === '' ? '#'.repeat(parsed.level) : `${'#'.repeat(parsed.level)} ${parsed.text}`
}

/**
 * Canonical fingerprint input (§12.1): the tuple
 * `(targetFile, sectionAnchor 归一化, proposedText 归一化)` serialized
 * deterministically. Hashing this string yields the fingerprint id.
 * @param {{ targetFile: string, sectionAnchor?: string | null, proposedText: string }} input
 * @returns {string}
 */
export function fingerprintInput({ targetFile, sectionAnchor, proposedText }) {
  return JSON.stringify([targetFile, canonicalAnchor(sectionAnchor), normalizeForFingerprint(proposedText)])
}

/**
 * Fingerprint hash (§12.1): sha256 over the canonical fingerprint input.
 * Pure computation over in-memory strings (file hashing stays host-side).
 * @param {{ targetFile: string, sectionAnchor?: string | null, proposedText: string }} input
 * @returns {string} 64-char lowercase hex
 */
export function computeFingerprint(input) {
  return createHash('sha256').update(fingerprintInput(input), 'utf8').digest('hex')
}

/**
 * Equivalence check on FINAL file content (§8.4 / §12.4): two contents are
 * equivalent when their fingerprint normalizations are identical. The host
 * compares the synthesized final content against the current disk content
 * and downgrades equivalent applications to「已存在，跳过」.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function isEquivalentContent(a, b) {
  return normalizeForFingerprint(a) === normalizeForFingerprint(b)
}

/**
 * Effective evidence grade of a change: the highest positive grade among its
 * evidence items (resolved > commit > submitted). `dismissed` is negative
 * context only; returns null when no positive grade exists.
 * @param {any} change
 * @returns {'resolved' | 'commit' | 'submitted' | null}
 */
export function changeGrade(change) {
  let best = null
  let bestRank = 0
  for (const ev of Array.isArray(change?.evidence) ? change.evidence : []) {
    const rank = GRADE_RANK[ev?.grade] ?? 0
    if (rank > bestRank) { bestRank = rank; best = ev.grade }
  }
  return best
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== ''
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isOptionalTurn(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0)
}

/**
 * ChangePlan schema validation (§5.2 constraints). Returns every violation;
 * `ok` means the plan is structurally applicable for further snapshot checks.
 * @param {any} plan
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateChangePlan(plan) {
  const errors = []
  if (plan === null || typeof plan !== 'object') return { ok: false, errors: ['plan must be an object'] }
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) errors.push(`schemaVersion must be ${PLAN_SCHEMA_VERSION}`)
  if (!isNonEmptyString(plan.runId)) errors.push('runId required')
  if (!isNonEmptyString(plan.workspaceId) || plan.workspaceId === 'default') errors.push('workspaceId required (empty/default rejected)')
  if (!isNonEmptyString(plan.summary)) errors.push('summary required')
  const nav = plan.navigation
  if (nav === null || typeof nav !== 'object') {
    errors.push('navigation required')
  } else {
    if (typeof nav.source !== 'string') errors.push('navigation.source must be a string')
    if (!['tree', 'fallback'].includes(nav.mode)) errors.push('navigation.mode must be tree|fallback')
    if (typeof nav.fallback !== 'boolean') errors.push('navigation.fallback must be boolean')
    else if (['tree', 'fallback'].includes(nav.mode) && nav.fallback !== (nav.mode === 'fallback')) {
      errors.push('navigation.fallback must match navigation.mode')
    }
  }
  if (typeof plan.truncated !== 'boolean') errors.push('truncated must be boolean')

  const targets = Array.isArray(plan.targets) ? plan.targets : []
  if (!Array.isArray(plan.targets) || targets.length === 0) errors.push('targets must be a non-empty array')
  const seenFiles = new Set()
  const changeIds = new Map()
  const allChanges = []
  targets.forEach((target, ti) => {
    const at = `targets[${ti}]`
    if (target === null || typeof target !== 'object') { errors.push(`${at} must be an object`); return }
    if (!isAllowedDocPath(target.file)) errors.push(`${at}.file violates §8.3 path boundary: ${String(target.file)}`)
    if (seenFiles.has(target.file)) errors.push(`${at}.file duplicated: ${target.file}`)
    seenFiles.add(target.file)
    if (!['update', 'create'].includes(target.action)) errors.push(`${at}.action must be update|create`)
    if (typeof target.navRef !== 'string') errors.push(`${at}.navRef must be a string`)
    else if (nav && nav.mode === 'tree' && target.navRef === '') errors.push(`${at}.navRef required in tree mode`)
    if (target.action === 'create') {
      if (target.fileBaseHash !== null) errors.push(`${at}.fileBaseHash must be null for create`)
    } else if (target.action === 'update') {
      if (!isNonEmptyString(target.fileBaseHash) || !SHA256_RE.test(target.fileBaseHash)) {
        errors.push(`${at}.fileBaseHash must be a sha256 hex for update`)
      }
    }
    const changes = Array.isArray(target.changes) ? target.changes : []
    if (!Array.isArray(target.changes) || changes.length === 0) {
      errors.push(`${at}.changes must be a non-empty array`)
      return
    }
    if (target.action === 'create' && (changes.length !== 1 || changes[0]?.kind !== 'create-file')) {
      errors.push(`${at} create target must contain exactly one create-file change`)
    }
    if (target.action === 'update' && changes.some((c) => c?.kind === 'create-file')) {
      errors.push(`${at} update target must not contain create-file changes`)
    }
    changes.forEach((change, ci) => {
      const cat = `${at}.changes[${ci}]`
      if (change === null || typeof change !== 'object') { errors.push(`${cat} must be an object`); return }
      allChanges.push({ change, file: target.file, at: cat })
      if (!isNonEmptyString(change.id)) errors.push(`${cat}.id required`)
      else if (changeIds.has(change.id)) errors.push(`${cat}.id duplicated: ${change.id}`)
      else changeIds.set(change.id, { file: target.file, at: cat })
      if (!CHANGE_KINDS.includes(change.kind)) errors.push(`${cat}.kind invalid: ${String(change.kind)}`)
      if (!isNonEmptyString(change.proposedText)) errors.push(`${cat}.proposedText required`)
      else if ((change.kind === 'append-section' || change.kind === 'create-file')) {
        const first = normalizeNewlines(change.proposedText).split('\n').find((l) => l.trim() !== '')
        if (!first || !parseAtxHeading(first)) errors.push(`${cat}.proposedText must start with an ATX heading for ${change.kind}`)
      }
      if (!isNonEmptyString(change.rationale)) errors.push(`${cat}.rationale required`)
      if (typeof change.evidenceSnippet !== 'string') errors.push(`${cat}.evidenceSnippet must be a string`)
      else if ([...change.evidenceSnippet].length > LIMITS.maxEvidenceSnippet) errors.push(`${cat}.evidenceSnippet exceeds ${LIMITS.maxEvidenceSnippet} chars`)
      const anchor = change.sectionAnchor
      if (change.kind === 'insert-into-section' || change.kind === 'replace-block') {
        if (!isNonEmptyString(anchor)) errors.push(`${cat}.sectionAnchor required for ${change.kind}`)
      } else if (change.kind === 'create-file') {
        if (anchor !== undefined && anchor !== null && anchor !== '') errors.push(`${cat}.sectionAnchor forbidden for create-file`)
      } else if (change.kind === 'append-section' && anchor !== undefined && anchor !== null && typeof anchor !== 'string') {
        errors.push(`${cat}.sectionAnchor must be a string when present`)
      }
      const evidence = Array.isArray(change.evidence) ? change.evidence : []
      if (!Array.isArray(change.evidence) || evidence.length === 0) errors.push(`${cat}.evidence must be a non-empty array`)
      evidence.forEach((ev, ei) => {
        const eat = `${cat}.evidence[${ei}]`
        if (ev === null || typeof ev !== 'object') { errors.push(`${eat} must be an object`); return }
        if (!isNonEmptyString(ev.sessionId)) errors.push(`${eat}.sessionId required`)
        if (!isNonEmptyString(ev.messageId)) errors.push(`${eat}.messageId required`)
        if (!EVIDENCE_GRADES.includes(ev.grade)) errors.push(`${eat}.grade invalid: ${String(ev.grade)}`)
        if (!isOptionalTurn(ev.turn)) errors.push(`${eat}.turn must be a non-negative integer`)
        if (ev.grade === 'commit' && !isNonEmptyString(ev.commit)) errors.push(`${eat}.commit required for commit grade`)
      })
      const grade = changeGrade(change)
      if (Array.isArray(change.evidence) && evidence.length > 0 && grade === null) {
        errors.push(`${cat} dismissed-only evidence cannot be written as a rule`)
      }
      if (grade === 'submitted' && isNonEmptyString(change.rationale) && !change.rationale.startsWith('待确认')) {
        errors.push(`${cat}.rationale must start with 待确认 for submitted grade`)
      }
      if (!Array.isArray(change.dependsOn) || change.dependsOn.some((d) => typeof d !== 'string')) {
        errors.push(`${cat}.dependsOn must be an array of change ids`)
      }
    })
  })

  for (const { change, at } of allChanges) {
    if (!Array.isArray(change.dependsOn)) continue
    for (const dep of change.dependsOn) {
      if (dep === change.id) errors.push(`${at}.dependsOn self-reference: ${dep}`)
      else if (!changeIds.has(dep)) errors.push(`${at}.dependsOn unknown change id: ${dep}`)
    }
  }
  // Cycle detection over dependsOn (iterative DFS, deterministic order).
  const depsOf = new Map(allChanges.map(({ change }) => [change.id, Array.isArray(change.dependsOn) ? change.dependsOn : []]))
  const state = new Map()
  const visit = (id, stack) => {
    if (state.get(id) === 'done') return
    if (state.get(id) === 'open') {
      errors.push(`dependsOn cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`)
      return
    }
    state.set(id, 'open')
    for (const dep of depsOf.get(id) ?? []) {
      if (depsOf.has(dep)) visit(dep, [...stack, id])
    }
    state.set(id, 'done')
  }
  for (const id of depsOf.keys()) visit(id, [])

  const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : []
  if (!Array.isArray(plan.conflicts)) errors.push('conflicts must be an array')
  conflicts.forEach((conflict, ci) => {
    const cat = `conflicts[${ci}]`
    if (conflict === null || typeof conflict !== 'object') { errors.push(`${cat} must be an object`); return }
    if (!isNonEmptyString(conflict.topic)) errors.push(`${cat}.topic required`)
    if (!CONFLICT_RESOLUTIONS.includes(conflict.resolvedBy)) errors.push(`${cat}.resolvedBy must be code|session|unresolved`)
    if (conflict.resolvedBy === 'code' && (!Array.isArray(conflict.codeEvidence) || conflict.codeEvidence.length === 0)) {
      errors.push(`${cat}.codeEvidence required when resolvedBy=code`)
    }
    if (Array.isArray(conflict.codeEvidence)) {
      conflict.codeEvidence.forEach((ev, ei) => {
        const eat = `${cat}.codeEvidence[${ei}]`
        if (!isNonEmptyString(ev?.commit)) errors.push(`${eat}.commit required`)
        if (typeof ev?.committedAt !== 'number') errors.push(`${eat}.committedAt must be a number`)
        if (!isNonEmptyString(ev?.path)) errors.push(`${eat}.path required`)
      })
    }
    if (conflict.note !== undefined && typeof conflict.note !== 'string') errors.push(`${cat}.note must be a string`)
    const claims = Array.isArray(conflict.claims) ? conflict.claims : []
    if (!Array.isArray(conflict.claims) || claims.length < 2) errors.push(`${cat}.claims must contain at least 2 claims`)
    claims.forEach((claim, cli) => {
      const eat = `${cat}.claims[${cli}]`
      if (!isNonEmptyString(claim?.sessionId)) errors.push(`${eat}.sessionId required`)
      if (!isNonEmptyString(claim?.messageId)) errors.push(`${eat}.messageId required`)
      if (!isNonEmptyString(claim?.claim)) errors.push(`${eat}.claim required`)
      if (!EVIDENCE_GRADES.includes(claim?.evidenceGrade)) errors.push(`${eat}.evidenceGrade invalid`)
      if (!isOptionalTurn(claim?.turn)) errors.push(`${eat}.turn must be a non-negative integer`)
    })
  })

  const stats = plan.stats
  const gradeCounts = { resolved: 0, commit: 0, submitted: 0 }
  for (const { change } of allChanges) {
    const grade = changeGrade(change)
    if (grade && grade in gradeCounts) gradeCounts[grade]++
  }
  if (stats === null || typeof stats !== 'object') {
    errors.push('stats required')
  } else {
    if (stats.targets !== targets.length) errors.push(`stats.targets mismatch: ${stats.targets} != ${targets.length}`)
    if (stats.changes !== allChanges.length) errors.push(`stats.changes mismatch: ${stats.changes} != ${allChanges.length}`)
    const byGrade = stats.byGrade
    if (byGrade === null || typeof byGrade !== 'object') {
      errors.push('stats.byGrade required')
    } else {
      for (const grade of ['resolved', 'commit', 'submitted']) {
        if (byGrade[grade] !== gradeCounts[grade]) errors.push(`stats.byGrade.${grade} mismatch: ${byGrade[grade]} != ${gradeCounts[grade]}`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * §9 导航归属 helpers. In tree mode a root-file update is only legal as the
 * paired「新文档登记 / 导航变更」entry of a create; a create needs the paired
 * AGENTS.md navigation-registration update in the same plan.
 * @param {any} plan
 * @returns {{ hasCreate: boolean, hasAgentsUpdate: boolean }}
 */
function navigationPairs(plan) {
  return {
    hasCreate: plan.targets.some((t) => t.action === 'create'),
    hasAgentsUpdate: plan.targets.some((t) => t.action === 'update' && t.file === 'AGENTS.md'),
  }
}

/**
 * @param {any} anchors
 * @returns {boolean}
 */
function anchorsShapeValid(anchors) {
  return Array.isArray(anchors) && anchors.every((a) => a !== null && typeof a === 'object'
    && typeof a.text === 'string'
    && Number.isInteger(a.level) && a.level >= 1 && a.level <= 6
    && Number.isInteger(a.startLine) && a.startLine >= 0
    && Number.isInteger(a.endLine) && a.endLine > a.startLine)
}

/**
 * Resolve one change's sectionAnchor against snapshot anchors. Matching is
 * exact on (level, text) after trailing-whitespace strip, case-sensitive;
 * the anchor must be unique (§8.4). Returns the anchor or an error.
 * @param {any} change
 * @param {Array<{ text: string, level: number, startLine: number, endLine: number }>} anchors
 * @returns {{ anchor?: object, error?: { code: string, message: string, changeId?: string } }}
 */
function resolveAnchor(change, anchors) {
  const raw = normalizeNewlines(String(change.sectionAnchor)).replace(/[ \t]+$/, '')
  const parsed = parseAtxHeading(raw)
  if (!parsed) {
    return { error: { code: 'ANCHOR_PARSE', message: `sectionAnchor is not a parseable ATX heading: ${change.sectionAnchor}`, changeId: change.id } }
  }
  const matches = anchors.filter((a) => a.text === parsed.text && a.level === parsed.level)
  if (matches.length === 0) {
    return { error: { code: 'ANCHOR_MISSING', message: `sectionAnchor not found: ${change.sectionAnchor}`, changeId: change.id } }
  }
  if (matches.length > 1) {
    return { error: { code: 'ANCHOR_DUPLICATE', message: `sectionAnchor is not unique (${matches.length} matches): ${change.sectionAnchor}`, changeId: change.id } }
  }
  return { anchor: matches[0] }
}

/**
 * Shared §8.4 structural analysis for one update file: validates the snapshot
 * anchors against the content, resolves every change anchor and rejects
 * ambiguous same-section combinations and intersecting section ranges
 * (including parent/child). All offsets refer to the ORIGINAL snapshot.
 * @param {{ content: string, anchors: any[], changes: any[] }} input
 * @returns {{ lines: string[], ops: Array<{ change: any, kind: string, anchor: object | null, start: number, end: number }>, errors: Array<{ code: string, message: string, changeId?: string }> }}
 */
function analyzeFileChanges({ content, anchors, changes }) {
  const errors = []
  const normalized = normalizeNewlines(content)
  const lines = splitLines(normalized)
  const ops = []
  if (!anchorsShapeValid(anchors)) {
    errors.push({ code: 'ANCHOR_SHAPE', message: 'snapshot anchors malformed (text/level/startLine/endLine)' })
    return { lines, ops, errors }
  }
  const derived = collectAtxAnchors(normalized)
  if (JSON.stringify(derived) !== JSON.stringify(anchors)) {
    errors.push({ code: 'ANCHOR_MISMATCH', message: 'snapshot anchors do not match the content (stale or inconsistent snapshot)' })
    return { lines, ops, errors }
  }
  /** @type {Map<number, { anchor: object, ops: Array<{ change: any, kind: string }> }>} */
  const bySection = new Map()
  for (const change of changes) {
    if (change.kind === 'create-file') {
      errors.push({ code: 'CREATE_IN_UPDATE', message: 'create-file change inside update target', changeId: change.id })
      continue
    }
    if (change.kind === 'append-section') {
      let anchor = null
      if (isNonEmptyString(change.sectionAnchor)) {
        const resolved = resolveAnchor(change, anchors)
        if (resolved.error) { errors.push(resolved.error); continue }
        anchor = resolved.anchor
        if (anchor.endLine !== lines.length) {
          errors.push({ code: 'APPEND_ANCHOR', message: `append-section anchor must be the last section: ${change.sectionAnchor}`, changeId: change.id })
          continue
        }
      }
      ops.push({ change, kind: change.kind, anchor, start: lines.length, end: lines.length })
      continue
    }
    // insert-into-section / replace-block: anchor required (schema-checked).
    const resolved = resolveAnchor(change, anchors)
    if (resolved.error) { errors.push(resolved.error); continue }
    const anchor = resolved.anchor
    const start = change.kind === 'replace-block' ? anchor.startLine + 1 : anchor.endLine
    const end = anchor.endLine
    ops.push({ change, kind: change.kind, anchor, start, end })
    const group = bySection.get(anchor.startLine) ?? { anchor, ops: [] }
    group.ops.push({ change, kind: change.kind })
    bySection.set(anchor.startLine, group)
  }
  for (const { anchor, ops: sectionOps } of bySection.values()) {
    const hasReplace = sectionOps.some((o) => o.kind === 'replace-block')
    if (hasReplace && sectionOps.length > 1) {
      errors.push({
        code: 'SECTION_CONFLICT',
        message: `replace-block cannot share section "${anchor.text}" with other modifications`,
        changeId: sectionOps.find((o) => o.kind === 'replace-block').change.id,
      })
    }
  }
  const distinct = [...bySection.values()].map((g) => g.anchor)
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const a = distinct[i]
      const b = distinct[j]
      if (a.startLine < b.endLine && b.startLine < a.endLine) {
        errors.push({
          code: 'SECTION_OVERLAP',
          message: `section ranges overlap (parent/child or intersecting): "${a.text}" vs "${b.text}"`,
        })
      }
    }
  }
  return { lines, ops, errors }
}

/**
 * Trim leading/trailing blank lines of a fragment and normalize its newlines.
 * Internal blank lines are preserved.
 * @param {string} text
 * @returns {string[]}
 */
function fragmentLines(text) {
  const lines = splitLines(normalizeNewlines(text))
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines
}

/**
 * §8.4 deterministic synthesis for ONE target file. All offsets are computed
 * on the original snapshot; edits are never re-located against rewritten
 * text. Same-anchor inserts concatenate in `changes` order; same-file
 * appends append in `changes` order; inserts and appends sharing the EOF
 * position interleave in `changes` order. Output uses LF, no BOM, and ends
 * with exactly one trailing newline. Empty or oversized results are refused.
 * @param {{ action: 'update' | 'create', content?: string | null, anchors?: any[], changes: any[] }} input
 * @returns {{ ok: boolean, content: string | null, errors: Array<{ code: string, message: string, changeId?: string }> }}
 */
export function synthesizeFileContent({ action, content, anchors, changes }) {
  const errors = []
  const list = Array.isArray(changes) ? changes : []
  if (action === 'create') {
    if (list.length !== 1 || list[0]?.kind !== 'create-file') {
      return { ok: false, content: null, errors: [{ code: 'CREATE_SHAPE', message: 'create target must contain exactly one create-file change' }] }
    }
    const change = list[0]
    const fragment = fragmentLines(change.proposedText ?? '')
    if (fragment.length === 0 || !parseAtxHeading(fragment[0])) {
      return { ok: false, content: null, errors: [{ code: 'EMPTY_TEXT', message: 'create-file proposedText must be non-empty and start with an ATX heading', changeId: change.id }] }
    }
    const result = `${fragment.join('\n')}\n`
    if (byteLength(result) > LIMITS.maxTotalBytes) {
      return { ok: false, content: null, errors: [{ code: 'SIZE', message: 'created file exceeds the §8.3 size limit', changeId: change.id }] }
    }
    return { ok: true, content: result, errors: [] }
  }
  if (action !== 'update') {
    return { ok: false, content: null, errors: [{ code: 'ACTION', message: `unknown action: ${String(action)}` }] }
  }
  if (typeof content !== 'string') {
    return { ok: false, content: null, errors: [{ code: 'SNAPSHOT_INCOMPLETE', message: 'update target requires snapshot content' }] }
  }
  const analysis = analyzeFileChanges({ content, anchors: anchors ?? [], changes: list })
  errors.push(...analysis.errors)
  if (errors.length > 0) return { ok: false, content: null, errors }
  const { lines, ops } = analysis
  /** @type {Map<string, { start: number, end: number, fragments: string[][], order: number }>} */
  const edits = new Map()
  ops.forEach((op, index) => {
    const fragment = fragmentLines(op.change.proposedText ?? '')
    if (fragment.length === 0) {
      errors.push({ code: 'EMPTY_TEXT', message: 'proposedText is empty after trimming blank lines', changeId: op.change.id })
      return
    }
    const key = `${op.start}:${op.end}`
    const edit = edits.get(key) ?? { start: op.start, end: op.end, fragments: [], order: index }
    edit.fragments.push(fragment)
    edits.set(key, edit)
  })
  if (errors.length > 0) return { ok: false, content: null, errors }
  const working = [...lines]
  const ordered = [...edits.values()].sort((a, b) => (b.start - a.start) || (b.order - a.order))
  for (const edit of ordered) {
    const merged = []
    edit.fragments.forEach((fragment, i) => {
      if (i > 0) merged.push('')
      merged.push(...fragment)
    })
    const before = edit.start > 0 && lines[edit.start - 1] !== '' ? [''] : []
    const after = edit.end < lines.length && lines[edit.end] !== '' ? [''] : []
    working.splice(edit.start, edit.end - edit.start, ...before, ...merged, ...after)
  }
  let result = working.join('\n').replace(/\n+$/, '')
  if (result.trim() === '') {
    return { ok: false, content: null, errors: [{ code: 'EMPTY_RESULT', message: 'synthesized content is empty' }] }
  }
  result += '\n'
  if (byteLength(result) > LIMITS.maxTotalBytes) {
    return { ok: false, content: null, errors: [{ code: 'SIZE', message: 'synthesized file exceeds the §8.3 size limit' }] }
  }
  return { ok: true, content: result, errors: [] }
}

/**
 * GitHub-style heading slug for the warn-level cross-link check.
 * @param {string} text
 * @returns {string}
 */
function headingSlug(text) {
  return text.toLowerCase().trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-')
}

/**
 * Lexical posix path join + normalization (no fs). Returns null when the
 * path escapes above the repository root.
 * @param {string} fromFile
 * @param {string} rel
 * @returns {string | null}
 */
function resolveRelativePath(fromFile, rel) {
  if (rel.startsWith('/')) return null
  const base = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : ''
  const segments = [...(base === '' ? [] : base.split('/')), ...rel.split('/')]
  const out = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out.join('/')
}

/**
 * §9 static validator (pure). Runs the ChangePlan schema first; when the
 * schema fails only SCHEMA errors are returned (later checks need a
 * structurally valid plan). Otherwise every §9 checklist row is evaluated
 * against the collected TargetSurfaceSnapshot. `error` forbids application;
 * `warn` allows human confirmation.
 *
 * Note: `snapshot` is the sole *environment* input (no fs); the plan itself
 * is the first argument.
 * @param {any} plan ChangePlan (§5.2)
 * @param {{ navigation: { content: string, mode: 'tree' | 'fallback' }, targets: Array<{ file: string, exists: boolean, content?: string, fileBaseHash: string | null, anchors: any[], navRegistered: boolean }>, plannedFiles: string[] }} snapshot TargetSurfaceSnapshot (§9)
 * @returns {{ ok: boolean, checks: Array<{ level: 'error' | 'warn', code: string, message: string, file?: string, changeId?: string }> }}
 */
export function validatePlan(plan, snapshot) {
  const checks = []
  const push = (level, code, message, extra = {}) => checks.push({ level, code, message, ...extra })
  const schema = validateChangePlan(plan)
  if (!schema.ok) {
    for (const error of schema.errors) push('error', 'SCHEMA', error)
    return { ok: false, checks }
  }
  if (snapshot === null || typeof snapshot !== 'object'
    || snapshot.navigation === null || typeof snapshot.navigation !== 'object'
    || !['tree', 'fallback'].includes(snapshot.navigation.mode)
    || !Array.isArray(snapshot.targets) || !Array.isArray(snapshot.plannedFiles)) {
    push('error', 'SNAPSHOT', 'snapshot must provide navigation{content,mode}, targets[] and plannedFiles[]')
    return { ok: false, checks }
  }
  const mode = snapshot.navigation.mode
  const snapByFile = new Map()
  for (const st of snapshot.targets) {
    if (st === null || typeof st !== 'object' || typeof st.file !== 'string') {
      push('error', 'SNAPSHOT', 'snapshot target entries must carry a file path')
      continue
    }
    snapByFile.set(st.file, st)
  }
  if (plan.navigation.mode !== mode) {
    push('error', 'NAV_MODE', `plan navigation mode ${plan.navigation.mode} != snapshot mode ${mode}`)
  }

  // plannedFiles <-> create-file targets, both directions (§8.4 / §9 结构合成).
  const createFiles = plan.targets.filter((t) => t.action === 'create').map((t) => t.file)
  const planned = new Set()
  for (const file of snapshot.plannedFiles) {
    if (typeof file !== 'string') { push('error', 'PLANNED_FILES', 'plannedFiles entries must be strings'); continue }
    if (planned.has(file)) push('error', 'PLANNED_FILES', `plannedFiles duplicate: ${file}`)
    planned.add(file)
    if (!createFiles.includes(file)) push('error', 'PLANNED_FILES', `plannedFiles entry has no create-file target: ${file}`)
  }
  for (const file of createFiles) {
    if (!planned.has(file)) push('error', 'PLANNED_FILES', `create-file target missing from plannedFiles: ${file}`)
  }

  const pairs = navigationPairs(plan)
  for (const target of plan.targets) {
    const st = snapByFile.get(target.file)
    if (!st) {
      push('error', 'SNAPSHOT', `snapshot missing target entry: ${target.file}`, { file: target.file })
      continue
    }
    // 基线哈希 / 存在性（磁盘比对由 host 采集快照完成，此处比对快照权威值）.
    if (target.action === 'create') {
      if (st.exists === true) push('error', 'CREATE_EXISTS', `create target already exists on disk: ${target.file}`, { file: target.file })
      if (st.fileBaseHash !== null) push('error', 'BASELINE_HASH', `create target snapshot hash must be null: ${target.file}`, { file: target.file })
    } else {
      if (st.exists === false) push('error', 'UPDATE_MISSING', `update target no longer exists: ${target.file}`, { file: target.file })
      if (typeof st.content !== 'string') push('error', 'SNAPSHOT_INCOMPLETE', `update target missing snapshot content: ${target.file}`, { file: target.file })
      if (st.fileBaseHash !== target.fileBaseHash) {
        push('error', 'BASELINE_HASH', `fileBaseHash differs from snapshot baseline: ${target.file}`, { file: target.file })
      }
    }
    // 导航归属.
    if (mode === 'fallback') {
      if (!ROOT_FILES.includes(target.file)) push('error', 'NAV_FALLBACK', `fallback mode only allows root AGENTS.md/README.md: ${target.file}`, { file: target.file })
      if (target.action === 'create') push('error', 'NAV_FALLBACK_CREATE', `fallback mode forbids create: ${target.file}`, { file: target.file })
    } else {
      if (target.action === 'update' && st.navRegistered !== true) {
        push('error', 'NAV_TREE', `update target not registered in the navigation tree: ${target.file}`, { file: target.file })
      }
      if (target.action === 'update' && ROOT_FILES.includes(target.file) && !pairs.hasCreate) {
        push('error', 'NAV_ROOT', `tree mode allows root ${target.file} only as paired navigation registration`, { file: target.file })
      }
      if (target.action === 'create' && !pairs.hasAgentsUpdate) {
        push('error', 'NAV_CREATE_PAIR', `create target requires a paired AGENTS.md navigation-registration update: ${target.file}`, { file: target.file })
      }
    }
    // 变更闭环：docs/arch/** update 必须带 ChangeLog 行形态.
    if (target.action === 'update' && target.file.startsWith('docs/arch/')) {
      const hasChangeLogRow = target.changes.some((c) => CHANGELOG_ROW_RE.test(c.proposedText))
      if (!hasChangeLogRow) {
        push('error', 'CHANGELOG', `docs/arch update must include a ChangeLog table row: ${target.file}`, { file: target.file })
      }
    }
    // 结构合成（§8.4）.
    if (target.action === 'update' && typeof st.content === 'string') {
      const analysis = analyzeFileChanges({ content: st.content, anchors: st.anchors, changes: target.changes })
      for (const error of analysis.errors) {
        push('error', error.code, error.message, { file: target.file, ...(error.changeId ? { changeId: error.changeId } : {}) })
      }
      if (target.file.startsWith('docs/arch/')) {
        for (const op of analysis.ops) {
          if (op.kind === 'replace-block' && op.anchor && op.anchor.startLine === 0) {
            push('error', 'ARCH_WHOLESALE', `docs/arch forbids whole-file replacement (replace-block on the document title): ${target.file}`, { file: target.file, changeId: op.change.id })
          }
        }
      }
    }
    // 互链与锚点（warn）+ 测试基线数字（warn）.
    for (const change of target.changes) {
      checkLinks(change, target.file, snapByFile, plan, snapshot.plannedFiles, push)
      if (/\d+\s*(?:项|用例|passed)/i.test(change.proposedText) || /\d+\s*\/\s*\d+\s*passed/i.test(change.proposedText)) {
        push('warn', 'TEST_BASELINE', 'proposedText touches test-baseline numbers; verify the baseline manually', { file: target.file, changeId: change.id })
      }
    }
  }

  // 计划体量（§8.3.6）：文件数与总写入字节（保守上界估计）.
  if (plan.targets.length > LIMITS.maxFiles) {
    push('error', 'SIZE_FILES', `batch exceeds ${LIMITS.maxFiles} files: ${plan.targets.length}`)
  }
  let totalBytes = 0
  for (const target of plan.targets) {
    const st = snapByFile.get(target.file)
    if (target.action === 'create') {
      totalBytes += byteLength(target.changes[0]?.proposedText ?? '')
    } else if (st && typeof st.content === 'string') {
      totalBytes += byteLength(st.content) + target.changes.reduce((sum, c) => sum + byteLength(c.proposedText ?? ''), 0)
    }
  }
  if (totalBytes > LIMITS.maxTotalBytes) {
    push('error', 'SIZE_BYTES', `batch exceeds ${LIMITS.maxTotalBytes} bytes of writes (estimated ${totalBytes})`)
  }

  // 冲突未决（warn）.
  for (const conflict of plan.conflicts) {
    if (conflict.resolvedBy === 'unresolved') {
      push('warn', 'CONFLICT_UNRESOLVED', `unresolved conflict must not be written as a rule: ${conflict.topic}`)
    }
  }
  return { ok: !checks.some((c) => c.level === 'error'), checks }
}

/**
 * Warn-level cross-link / anchor check for one change's proposedText.
 * @param {any} change
 * @param {string} file
 * @param {Map<string, any>} snapByFile
 * @param {any} plan
 * @param {string[]} plannedFiles
 * @param {(level: string, code: string, message: string, extra?: object) => void} push
 */
function checkLinks(change, file, snapByFile, plan, plannedFiles, push) {
  const knownFiles = new Set([
    ...snapByFile.keys(),
    ...plan.targets.map((t) => t.file),
    ...(Array.isArray(plannedFiles) ? plannedFiles : []),
  ])
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = linkRe.exec(change.proposedText)) !== null) {
    let target = m[1].trim().split(/\s+/)[0]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue
    const hashAt = target.indexOf('#')
    const pathPart = hashAt >= 0 ? target.slice(0, hashAt) : target
    const anchorPart = hashAt >= 0 ? target.slice(hashAt + 1) : ''
    let resolvedFile = file
    if (pathPart !== '') {
      resolvedFile = resolveRelativePath(file, pathPart)
      if (resolvedFile === null) {
        push('warn', 'LINK_TARGET', `relative link escapes the repository: ${target}`, { file, changeId: change.id })
        continue
      }
      if (!knownFiles.has(resolvedFile)) {
        push('warn', 'LINK_TARGET', `relative link target not present in the known target surface: ${target}`, { file, changeId: change.id })
        continue
      }
    }
    if (anchorPart === '') continue
    const st = snapByFile.get(resolvedFile)
    let headings = null
    if (st && typeof st.content === 'string') headings = collectAtxAnchors(st.content).map((a) => headingSlug(a.text))
    else if (resolvedFile === file && change.kind === 'create-file') headings = collectAtxAnchors(change.proposedText).map((a) => headingSlug(a.text))
    if (headings === null) {
      push('warn', 'LINK_ANCHOR', `cannot verify #${anchorPart} (no heading set for ${resolvedFile})`, { file, changeId: change.id })
    } else if (!headings.includes(headingSlug(anchorPart))) {
      push('warn', 'LINK_ANCHOR', `#${anchorPart} not found in ${resolvedFile} heading set`, { file, changeId: change.id })
    }
  }
}

/**
 * Default two-level selection (§10.2 / §5.2): only `resolved` / `commit`
 * changes are checked by default; `submitted` (待确认) and dismissed-only
 * changes are never default-checked. Error-level checks exclude the affected
 * change / file; a plan-wide error excludes everything. This is batch
 * checking, NOT auto-apply.
 * @param {any} plan
 * @param {Array<{ level: string, code: string, file?: string, changeId?: string }>} [checks] validatePlan output checks
 * @returns {string[]} change ids in plan order
 */
export function defaultSelection(plan, checks = []) {
  const errors = Array.isArray(checks) ? checks.filter((c) => c.level === 'error') : []
  if (errors.some((c) => !c.file && !c.changeId)) return []
  const blockedFiles = new Set(errors.filter((c) => c.file && !c.changeId).map((c) => c.file))
  const blockedChanges = new Set(errors.filter((c) => c.changeId).map((c) => c.changeId))
  const selected = []
  for (const target of Array.isArray(plan?.targets) ? plan.targets : []) {
    if (blockedFiles.has(target.file)) continue
    for (const change of Array.isArray(target.changes) ? target.changes : []) {
      if (blockedChanges.has(change.id)) continue
      const grade = changeGrade(change)
      if (grade === 'resolved' || grade === 'commit') selected.push(change.id)
    }
  }
  return selected
}

/**
 * Dependency-group second validation at apply time (§9 依赖完整 / §10.3):
 * every `dependsOn` of a selected change must itself be selected. Missing
 * dependencies are reported, never auto-added.
 * @param {any} plan
 * @param {string[]} selectedChangeIds
 * @returns {{ ok: boolean, errors: string[], missing: Array<{ changeId: string, dependsOn: string[] }> }}
 */
export function validateDependencySelection(plan, selectedChangeIds) {
  const errors = []
  const missing = []
  const byId = new Map()
  for (const target of Array.isArray(plan?.targets) ? plan.targets : []) {
    for (const change of Array.isArray(target.changes) ? target.changes : []) byId.set(change.id, change)
  }
  const selected = new Set()
  for (const id of Array.isArray(selectedChangeIds) ? selectedChangeIds : []) {
    if (!byId.has(id)) errors.push(`unknown selected change id: ${id}`)
    selected.add(id)
  }
  for (const id of selected) {
    const change = byId.get(id)
    if (!change) continue
    const absent = (Array.isArray(change.dependsOn) ? change.dependsOn : []).filter((dep) => !selected.has(dep))
    if (absent.length > 0) {
      missing.push({ changeId: id, dependsOn: absent })
      errors.push(`change ${id} missing dependencies: ${absent.join(', ')}`)
    }
  }
  return { ok: errors.length === 0, errors, missing }
}

/**
 * Conflict adjudication tri-state (spec §6.2 / §11 / D15): a commit can only
 * beat the session claims when its commit time is strictly later than the turn
 * hosting each claim; otherwise the conflict stays `unresolved` for a human.
 *
 * Inputs are pure data:
 * - `claims`: `{ sessionId, messageId, claim, evidenceGrade, turn, commit? }[]`
 * - `commitTraces`: Host commit traces (array, or a `sessionKey -> trace[]`
 *   map) carrying `{ sessionId, turn, capturedAt/updatedAt/time, commits[] }`.
 *
 * A claim's "turn time" comes from `claim.turnTime`/`claim.time` when present,
 * otherwise from the commit trace matching `(sessionId, turn)`. Commit `time`
 * values are normalised from unix seconds to milliseconds when needed.
 *
 * @param {object} [input]
 * @param {object[]} [input.claims]
 * @param {object[]|Record<string, object[]>} [input.commitTraces]
 * @returns {{ resolvedBy: 'code'|'session'|'unresolved', reason: string,
 *   winner?: object, codeEvidence?: Array<{ hash: string, time: number }> }}
 */
export function resolveConflictClaim({ claims, commitTraces } = {}) {
  const list = (Array.isArray(claims) ? claims : [])
    .filter(claim => claim !== null && typeof claim === 'object')
  if (list.length === 0) return { resolvedBy: 'unresolved', reason: 'no claims to resolve' }
  if (list.length === 1) {
    return { resolvedBy: 'session', reason: 'single claim needs no adjudication', winner: list[0] }
  }

  const { traces, commits } = flattenCommitEvidence(commitTraces)
  const claimTurnTimes = list.map(claim => claimTurnTimeOf(claim, traces))
  const unresolved = reason => ({ resolvedBy: 'unresolved', reason })

  const codeEvidence = []
  for (const claim of list) {
    const hash = typeof claim.commit === 'string' ? claim.commit.trim().toLowerCase() : ''
    if (!hash) continue
    const commit = commits.find(item => item.hash === hash)
    if (commit && commit.time !== null) codeEvidence.push({ claim, commit })
  }
  if (codeEvidence.length === 0) {
    return unresolved('no commit evidence attached to any claim')
  }
  if (claimTurnTimes.some(time => time === null)) {
    return unresolved('claim turn time is unavailable, cannot prove the commit is later')
  }
  const latestClaimTime = Math.max(...claimTurnTimes)
  const laterCommits = codeEvidence.filter(({ commit }) => commit.time > latestClaimTime)
  if (laterCommits.length === 0) {
    return unresolved('commit evidence predates at least one claim turn; leave to human')
  }
  return {
    resolvedBy: 'code',
    reason: 'commit time is strictly later than every claim turn',
    codeEvidence: laterCommits.map(({ commit }) => ({ hash: commit.hash, time: commit.time })),
  }
}

/** Seconds-vs-milliseconds threshold: git commit times are unix seconds. */
const COMMIT_SECONDS_THRESHOLD = 1e12

/**
 * @param {unknown} value
 * @returns {number|null} milliseconds, or null when not a finite timestamp
 */
function timestampMillis(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value > 0 && value < COMMIT_SECONDS_THRESHOLD ? value * 1000 : value
}

/**
 * @param {unknown} commitTraces
 * @returns {{ traces: Array<{ sessionId: string, turn: number|null, time: number|null }>,
 *   commits: Array<{ hash: string, time: number|null, sessionId: string, turn: number|null }> }}
 */
function flattenCommitEvidence(commitTraces) {
  const traceList = []
  if (Array.isArray(commitTraces)) {
    for (const trace of commitTraces) if (trace && typeof trace === 'object') traceList.push(trace)
  } else if (commitTraces && typeof commitTraces === 'object') {
    for (const bucket of Object.values(commitTraces)) {
      if (!Array.isArray(bucket)) continue
      for (const trace of bucket) if (trace && typeof trace === 'object') traceList.push(trace)
    }
  }
  const traces = []
  const commits = []
  for (const trace of traceList) {
    const turn = Number.isInteger(trace.turn) ? trace.turn : null
    const time = timestampMillis(trace.capturedAt ?? trace.updatedAt ?? trace.time)
    const sessionId = typeof trace.sessionId === 'string' ? trace.sessionId : ''
    traces.push({ sessionId, turn, time })
    for (const commit of Array.isArray(trace.commits) ? trace.commits : []) {
      if (!commit || typeof commit !== 'object') continue
      const hash = typeof commit.hash === 'string' ? commit.hash.trim().toLowerCase() : ''
      if (!hash) continue
      commits.push({ hash, time: timestampMillis(commit.time), sessionId, turn })
    }
  }
  return { traces, commits }
}

/**
 * @param {object} claim
 * @param {Array<{ sessionId: string, turn: number|null, time: number|null }>} traces
 * @returns {number|null}
 */
function claimTurnTimeOf(claim, traces) {
  const direct = timestampMillis(claim.turnTime ?? claim.time ?? claim.capturedAt)
  if (direct !== null) return direct
  const sessionId = typeof claim.sessionId === 'string' ? claim.sessionId : ''
  const turn = Number.isInteger(claim.turn) ? claim.turn : null
  if (!sessionId || turn === null) return null
  const trace = traces.find(item => item.sessionId === sessionId && item.turn === turn)
  return trace ? trace.time : null
}
