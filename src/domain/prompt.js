/** Prompt composition and batch limits: pure text, no I/O. */

import { buildTagFramework } from './tags.js'

/**
 * Default limits. `maxBytes` / `maxEntryBytes` are also user-configurable prefs
 * (settings center) — pass them through `options` to override per submit.
 */
export const LIMITS = { maxEntries: 20, maxBytes: 32768, maxEntryBytes: 8192 }

const encoder = new TextEncoder()

/**
 * Tag token shown as the entry prefix. `tag` wins over the legacy `severity`
 * field so custom tags reach the model; unknown/empty values degrade to no
 * prefix. Brackets and newlines are stripped to keep the prefix well-formed.
 * @param {object} entry
 * @returns {string}
 */
function tagLabel(entry) {
  const raw = typeof entry.tag === 'string' && entry.tag.trim() !== '' ? entry.tag : entry.severity
  if (typeof raw !== 'string' || raw.trim() === '') return ''
  const token = raw.replace(/[\[\]\r\n]/g, '').trim().slice(0, 40)
  return token ? `[${token}] ` : ''
}

/**
 * @param {object} anchor
 * @returns {string}
 */
function anchorLabel(anchor) {
  if (!anchor || typeof anchor !== 'object') return ''
  if (anchor.type === 'file') {
    const path = typeof anchor.path === 'string' ? anchor.path : ''
    return anchor.line ? `${path}:${anchor.line}` : path
  }
  if (anchor.type === 'turn') return `turn ${anchor.turn ?? '?'}`
  if (anchor.type === 'message') return `message ${anchor.messageId ?? '?'}`
  if (anchor.type === 'text') return typeof anchor.quote === 'string' ? anchor.quote.slice(0, 40) : ''
  if (anchor.type === 'quote') return typeof anchor.text === 'string' ? anchor.text.slice(0, 40) : ''
  return ''
}

/**
 * @param {unknown} entry
 * @returns {object}
 */
function asEntry(entry) {
  return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
}

/**
 * @param {object} entry
 * @param {number} index 1-based position in the batch
 * @returns {string}
 */
function entryLines(entry, index) {
  const safe = asEntry(entry)
  const anchors = Array.isArray(safe.anchors) ? safe.anchors : []
  const label = anchorLabel(anchors[0])
  const title = typeof safe.title === 'string' ? safe.title : String(safe.title ?? '')
  const body = typeof safe.body === 'string' ? safe.body : String(safe.body ?? '')
  const line = `${index}. ${tagLabel(safe)}${title}${label ? ` — ${label}` : ''}`
  const trimmed = body.trim()
  return trimmed === '' ? line : `${line}\n   ${trimmed.replace(/\n/g, '\n   ')}`
}

/** @typedef {'minimal'|'standard'|'strict'} PromptTail */

/** Max characters accepted for one editable tail section. */
export const TAIL_TEXT_MAX = 2000

/**
 * Which section keys each preset covers. The preset only selects *coverage* —
 * every section's wording is user-editable (see `DEFAULT_TAIL_TEXTS`).
 * @type {Record<PromptTail, ReadonlyArray<'a'|'b'|'c'>>}
 */
export const PROMPT_TAIL_COVERAGE = {
  minimal: ['a'],
  standard: ['a', 'b'],
  strict: ['a', 'b', 'c'],
}

/**
 * Default section texts. Users can rewrite (or clear) any of them in the
 * settings center, which is why the ordered prompt contract lives here.
 * @type {{ a: string, b: string, c: string }}
 */
export const DEFAULT_TAIL_TEXTS = {
  a: [
    'A. 逐条处置：对上面每条按原编号回复，禁止合并、跳号或改写编号：',
    '   编号. 已修复 —— 改了什么（文件:行）',
    '   编号. 需确认 —— 待确认的具体问题（为什么无法自行判断）',
    '   编号. 不修 —— 理由 + 替代方案 / 为什么无害',
    '   确实未处理时：编号. 未处理 —— 原因',
  ].join('\n'),
  b: [
    'B. 过程播报：每个工具批次开始前只输出一行，写最新结果或判断，不要写工具名、命令或参数：',
    '   - 有新结果：最新结果 / 判断（例如测试通过或失败原因、关键结论）',
    '   - 这一批没有新结果：「仍缺 X，正在取 Y」（X = 还缺的证据，Y = 下一步动作）；同一缺口不要重复播报',
  ].join('\n'),
  c: [
    'C. 收尾（固定四段小标题，缺一不可）：',
    '   经过：3–6 行时间序',
    '   结论：每条编号一句话结论，并与 A 的编号一一对应',
    '   证据：命令 + 输出尾部 / 文件:行号',
    '   未做/未验：显式列出未执行或无法验证的项及原因',
  ].join('\n'),
}

/**
 * Normalise the tail options. Unknown presets fall back to `minimal`, and each
 * section accepts a user override (string) or `null` to keep the default.
 * Empty string means "omit this section".
 * @param {{ promptTail?: string, texts?: { a?: string, b?: string, c?: string } }} [options]
 * @returns {{ promptTail: PromptTail, texts: { a: string, b: string, c: string } }}
 */
export function normalizePromptOptions(options = {}) {
  const src = options && typeof options === 'object' ? options : {}
  const promptTail = src.promptTail === 'standard' || src.promptTail === 'strict'
    ? src.promptTail
    : 'minimal'
  const rawTexts = src.texts && typeof src.texts === 'object' ? src.texts : {}
  const clamp = value => (typeof value === 'string' ? value.trim().slice(0, TAIL_TEXT_MAX) : null)
  const pick = (key) => {
    const override = clamp(rawTexts[key])
    return override === null ? DEFAULT_TAIL_TEXTS[key] : override
  }
  return { promptTail, texts: { a: pick('a'), b: pick('b'), c: pick('c') } }
}

/**
 * Build the tail that replaces the flat "回复要求" line.
 *
 * Coverage: minimal = A, standard = A + B, strict = A + B + C. Sections that
 * are empty after editing are skipped, so a user can build their own contract.
 * @param {{ promptTail?: string, texts?: { a?: string, b?: string, c?: string } }} [options]
 * @returns {string}
 */
export function buildPromptTail(options) {
  const { promptTail, texts } = normalizePromptOptions(options)
  const coverage = PROMPT_TAIL_COVERAGE[promptTail] || PROMPT_TAIL_COVERAGE.minimal
  const blocks = coverage.map(key => texts[key]).filter(Boolean)
  if (blocks.length === 0) return ''
  return ['【回复要求】', ...blocks].join('\n')
}

/**
 * @param {object[]} entries
 * @param {{ promptTail?: string, texts?: object }} [options]
 * @returns {string}
 */
export function composeCombinedPrompt(entries, options) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('no findings')
  const header = `[会话手账 · 评审发现 ${entries.length} 条]`
  const lines = entries.map((entry, index) => entryLines(entry, index + 1)).join('\n')
  // Tag guidance is model-facing: one shared block, injected after the entries
  // and before the reply contract so it never repeats per sequential item.
  const framework = buildTagFramework(options && typeof options === 'object' ? options.tags : undefined, entries)
  const tail = buildPromptTail(options)
  return `${header}\n${lines}${framework ? `\n\n${framework}` : ''}${tail ? `\n\n${tail}` : ''}`
}

/**
 * @param {object} entry
 * @param {{ promptTail?: string, texts?: object }} [options]
 * @returns {string}
 */
export function composeSequentialPrompt(entry, options) {
  return composeCombinedPrompt([entry], options)
}

/**
 * @param {unknown} entry
 * @returns {boolean}
 */
function isMalformed(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
  if (entry.title !== undefined && typeof entry.title !== 'string') return true
  if (entry.body !== undefined && typeof entry.body !== 'string') return true
  if (entry.anchors === undefined) return false
  if (!Array.isArray(entry.anchors)) return true
  return entry.anchors.some(anchor => {
    if (anchor === null || typeof anchor !== 'object') return false
    if (anchor.type === 'text' && typeof anchor.quote !== 'string') return true
    return anchor.type === 'quote' && typeof anchor.text !== 'string'
  })
}

/**
 * @param {unknown} entry
 * @returns {string}
 */
function bodyText(entry) {
  const safe = asEntry(entry)
  return typeof safe.body === 'string' ? safe.body : String(safe.body ?? '')
}

/**
 * Measure a UTF-8 prompt text payload.
 * @param {unknown} text
 * @returns {number}
 */
export function byteLengthOf(text) {
  return encoder.encode(typeof text === 'string' ? text : String(text ?? '')).byteLength
}

/** 1M-class context window: the budget readout uses it to show a percentage. */
export const CONTEXT_WINDOW_TOKENS = 1_000_000
/** Advisory soft threshold for a batch (exceeding it only warns, never blocks). */
export const PROMPT_SOFT_WARN_BYTES = 128 * 1024

/**
 * Cheap local estimate for the dock readout (no model call). Mixed zh/en text
 * runs roughly 0.25–0.35 tokens per UTF-8 byte, so 0.3 is a safe upper bound.
 * @param {string} text
 * @param {{ contextWindowTokens?: number, softWarnBytes?: number }} [options]
 * @returns {{ bytes: number, tokens: number, contextShare: number, softExceeded: boolean }}
 */
export function estimatePromptBudget(text, { contextWindowTokens = CONTEXT_WINDOW_TOKENS, softWarnBytes = PROMPT_SOFT_WARN_BYTES } = {}) {
  const bytes = byteLengthOf(text)
  const tokens = Math.ceil(bytes * 0.3)
  const share = contextWindowTokens > 0 ? tokens / contextWindowTokens : 0
  return { bytes, tokens, contextShare: share, softExceeded: bytes > softWarnBytes }
}

/**
 * Validate one already-composed prompt (e.g. a hand-edited "微调指令" prompt).
 * Never throws; mirrors the batch guard so both paths share one budget.
 * @param {string} text
 * @param {{ maxBytes?: number }} [options]
 * @returns {{ ok: boolean, errors: string[], bytes: number }}
 */
export function validatePromptText(text, { maxBytes = LIMITS.maxBytes } = {}) {
  const bytes = byteLengthOf(text)
  const errors = []
  if (bytes === 0) errors.push('提示词为空，无法提交')
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : LIMITS.maxBytes
  if (bytes > limit) errors.push(`提示词超过 ${limit} 字节（当前 ${bytes} 字节）`)
  return { ok: errors.length === 0, errors, bytes }
}

/**
 * Never throws: Task 8's pre-send guard relies on receiving `{ ok, errors, bytes }`
 * even for malformed entries.
 *
 * - `mode: 'combined'` (default): the whole composed message must fit `maxBytes`.
 * - `mode: 'sequential'`: every item is sent as its own prompt, so each single
 *   composed prompt is checked against `maxBytes`; the batch total is not summed.
 * @param {object[]} entries
 * @param {{ promptTail?: string, texts?: object, maxEntries?: number, maxBytes?: number, maxEntryBytes?: number, mode?: 'combined'|'sequential' }} [options]
 * @returns {{ ok: boolean, errors: string[], bytes: number }}
 */
export function validateBatch(entries, options = {}) {
  const src = options && typeof options === 'object' ? options : {}
  const maxEntries = Number.isFinite(src.maxEntries) && src.maxEntries > 0 ? src.maxEntries : LIMITS.maxEntries
  const maxEntryBytes = Number.isFinite(src.maxEntryBytes) && src.maxEntryBytes > 0 ? src.maxEntryBytes : LIMITS.maxEntryBytes
  const maxBytes = Number.isFinite(src.maxBytes) && src.maxBytes > 0 ? src.maxBytes : LIMITS.maxBytes
  const mode = src.mode === 'sequential' ? 'sequential' : 'combined'
  const errors = []
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) errors.push('no findings')
  if (list.length > maxEntries) errors.push(`最多 ${maxEntries} 条（当前 ${list.length} 条）`)
  const malformed = list.map((entry, index) => (isMalformed(entry) ? index + 1 : 0)).filter(Boolean)
  if (malformed.length > 0) errors.push(`以下条目格式无效，无法生成提示词：第 ${malformed.join(', ')} 条`)
  const tooBig = list
    .map((entry, index) => ({ index: index + 1, bytes: byteLengthOf(bodyText(entry)), id: asEntry(entry).id ?? '?' }))
    .filter(item => item.bytes > maxEntryBytes)
  if (tooBig.length > 0) {
    errors.push(`以下条目正文超过 ${maxEntryBytes} 字节：${tooBig.map(item => `第 ${item.index} 条（${item.bytes} 字节）`).join('、')}`)
  }
  let bytes = 0
  if (list.length > 0 && mode === 'combined') {
    try {
      bytes = byteLengthOf(composeCombinedPrompt(list, src))
    } catch {
      errors.push('无法生成合并消息')
    }
    if (bytes > maxBytes) errors.push(`合并消息超过 ${maxBytes} 字节（当前 ${bytes} 字节）`)
  } else if (mode === 'sequential') {
    let peak = 0
    const oversize = []
    for (let index = 0; index < list.length; index += 1) {
      try {
        const one = byteLengthOf(composeSequentialPrompt(list[index], src))
        peak = Math.max(peak, one)
        if (one > maxBytes) oversize.push(`第 ${index + 1} 条（${one} 字节）`)
      } catch {
        errors.push('无法生成逐条消息')
        break
      }
    }
    bytes = peak
    if (oversize.length > 0) errors.push(`以下逐条消息超过 ${maxBytes} 字节：${oversize.join('、')}`)
  }
  return { ok: errors.length === 0, errors, bytes }
}
