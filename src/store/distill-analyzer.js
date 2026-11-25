import { renderDigest } from '../domain/digest.js'
import { estimateTokens } from '../domain/distill.js'
import { emptyRunUsage, accumulateRunUsage } from '../domain/distill-run.js'
import {
  validateChangePlan,
  collectAtxAnchors,
  normalizeNewlines,
  parseAtxHeading,
} from '../domain/distill-plan.js'

const DEFAULT_STAGE1_TIMEOUT_MS = 120 * 1000
const DEFAULT_STAGE2_TIMEOUT_MS = 240 * 1000
const DEFAULT_PROBE_TIMEOUT_MS = 30 * 1000
const PROBE_MAX_TOKENS = 8000
const DEFAULT_MAX_RAW_RESPONSE_CHARS = 20000
const DEFAULT_RAW_RETENTION_RUNS = 20
const FINGERPRINT_PROMPT_WINDOW_MS = 180 * 24 * 3600 * 1000

const STAGE1_SYSTEM = [
  '你是 Punch Desk 手账精炼的「阶段 1：逐会话候选提炼器」。',
  '输入是单个会话的结果对素材（user prompt + assistant 最终文本，不含工具动作）。',
  '只提炼可写回项目文档的规则/决议候选；dismissed 素材只作否定上下文，不得写成建议。',
  '不得臆造路径、章节、提交或未在素材中出现的证据。',
  '只输出一个 JSON 对象，不要 Markdown 代码块、不要解释：',
  '{"sessionId":"<输入 sessionId>","candidates":[{"rule":"<一句话规则>","evidenceRefs":["<findingId 或 messageId>"],"suggestedTargets":["<docs/...md 或 AGENTS.md>"]}]}',
  '没有候选时输出 {"sessionId":"...","candidates":[]}。',
].join('\n')

const STAGE2_SYSTEM = [
  '你是 Punch Desk 手账精炼的「阶段 2：合并与变更计划器」。',
  '输入：阶段 1 候选、目标仓库导航树原文、已沉淀指纹摘要、目标文档相关片段。',
  '已沉淀指纹摘要只含同 workspace、近 180 天、按文件分组的已应用结论：任何与摘要等价（同文件/同章节/同归一化内容）的变更不得重复提议。',
  '把跨会话候选合并去重，输出一份可人工勾选的变更草案；冲突按「commit 时间晚于 claim 所在 turn 时 code 胜出，否则 unresolved」裁决。',
  'targets[].file 必须落在导航树声明的 Markdown 文档内（fallback 模式仅根 AGENTS.md / README.md）；不得臆造路径或章节。',
  'tree 模式下优先把内容写回 docs/ 下的具体文档；根 AGENTS.md / README.md 只允许作为「新建文档的导航登记」成对出现，内容修改写在这里会被静态校验拒绝。',
  '若目标是 docs/arch/** 文档：change.proposedText 必须包含一行 ChangeLog 表格记录（形如 | **vX.Y** | 2026-11-11 | 变更类型 | 已交付 | 摘要 |），否则静态校验会拒绝整份计划。',
  '你只负责语义：summary、目标文件、变更正文与 rationale、证据引用、冲突裁决。以下结构化字段由 Host 按磁盘快照与素材确定，**不要编造**：',
  'navigation、stats、fileBaseHash、action、changes[].id、dependsOn、truncated。',
  '每条 change 必须给 evidence：sessionId + messageId（或 findingId）+ grade（resolved|commit|submitted|dismissed），来自输入素材；没有证据的条目不要输出。',
  'kind 只能是 append-section | insert-into-section | replace-block | create-file；insert/replace 必须给 sectionAnchor（快照中唯一的 ATX 标题原文）。',
  '同时为每个会话生成一段简短摘要（Markdown，3~5 句），若无法生成可省略该会话。',
  '只输出一个 JSON 对象，不要 Markdown 代码块、不要解释：',
  '{"plan":{"summary":"...","targets":[{"file":"docs/...md","action":"update","navRef":"...","changes":[{"id":"c1","kind":"insert-into-section","sectionAnchor":"## ...","proposedText":"...","rationale":"...","evidenceSnippet":"...","evidence":[{"sessionId":"...","messageId":"...","grade":"commit","commit":"a1b2c3d"}]}]}],"conflicts":[{"topic":"...","claims":[{"sessionId":"...","messageId":"...","claim":"...","evidenceGrade":"resolved"},{"sessionId":"...","messageId":"...","claim":"...","evidenceGrade":"commit"}],"resolvedBy":"code|session|unresolved","codeEvidence":[{"commit":"...","committedAt":1700000000,"path":"..."}],"note":"..."}]},"summaries":[{"sessionId":"...","title":"...","markdown":"..."}]}',
].join('\n')

/**
 * Build one user message in the Host LLM wire shape.
 *
 * `GenerateOptions.messages` takes `RequestMessage[]` whose `content` is a
 * `ContentBlock[]` — the DeepSeek adapter calls `message.content.some(...)` and
 * throws (surfacing as a `finish` chunk with `reason.kind === 'error'`) when it
 * receives a bare string. Always wrap prompts in a text block.
 *
 * @param {string} text
 * @returns {{ role: 'user', content: Array<{ type: 'text', text: string }> }}
 */
function userTextMessage(text) {
  return { role: 'user', content: [{ type: 'text', text: String(text ?? '') }] }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asString(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 * @returns {{ ok: false, error: { code: string, message: string } }}
 */
function failure(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } }
}

/**
 * Optional-service access: `getService` is the orchestrator's safe `ctx.get`
 * wrapper; wrap again so a throwing host proxy can never escape the analyzer.
 * @param {(name: string) => any} getService
 * @param {string} name
 * @returns {any}
 */
function safeService(getService, name) {
  if (typeof getService !== 'function') return null
  try {
    return getService(name) ?? null
  } catch {
    return null
  }
}

/**
 * Remove a fenced code block wrapper / surrounding prose and parse JSON.
 * @param {string} text
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
function parseJsonText(text) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return { ok: false, error: 'empty response' }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  const body = fence ? fence[1].trim() : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  const candidate = start >= 0 && end > start ? body.slice(start, end + 1) : body
  try {
    return { ok: true, value: JSON.parse(candidate) }
  } catch (err) {
    return { ok: false, error: err?.message || 'invalid JSON' }
  }
}

/**
 * @param {unknown} info
 * @param {string} effort
 * @returns {boolean}
 */
function infoSupportsEffort(info, effort) {
  if (!isPlainObject(info)) return false
  const lists = [info.reasoningEfforts, info.reasoningEffort, info?.capabilities?.reasoningEfforts, info?.capabilities?.reasoningEffort]
  for (const list of lists) {
    if (Array.isArray(list) && list.includes(effort)) return true
  }
  return info.reasoningEffort === true
    || info.supportsReasoningEffort === true
    || info?.capabilities?.reasoningEffort === true
    || info?.capabilities?.supportsReasoningEffort === true
}

/**
 * @param {object} params
 * @param {object} params.store Host DeskStore (Task 2.2 three buckets)
 * @param {object} [params.options] optional test hooks (timeouts/retention overrides)
 */
export function createDistillAnalyzer({ getService, store } = {}, options = {}) {
  const stage1TimeoutMs = Number(options.stage1TimeoutMs) > 0 ? options.stage1TimeoutMs : DEFAULT_STAGE1_TIMEOUT_MS
  const stage2TimeoutMs = Number(options.stage2TimeoutMs) > 0 ? options.stage2TimeoutMs : DEFAULT_STAGE2_TIMEOUT_MS
  const probeTimeoutMs = Number(options.probeTimeoutMs) > 0 ? options.probeTimeoutMs : DEFAULT_PROBE_TIMEOUT_MS
  const maxRawResponseChars = Number(options.maxRawResponseChars) > 0
    ? options.maxRawResponseChars
    : DEFAULT_MAX_RAW_RESPONSE_CHARS
  const rawRetentionRuns = Number(options.rawRetentionRuns) > 0
    ? options.rawRetentionRuns
    : DEFAULT_RAW_RETENTION_RUNS
  const clock = typeof options.now === 'function' ? options.now : Date.now

  /** @type {{ model: {provider:string, model:string, reasoningEffort?:string}, contextWindow: number }|null} */
  let probed = null

  /**
   * @param {object} llm
   * @param {string} provider
   * @param {string} model
   * @param {string|undefined} effort
   * @returns {Promise<boolean>}
   */
  async function supportsEffort(llm, provider, model, effort) {
    if (!effort) return false
    try {
      if (typeof llm?.resolveModelInfo !== 'function') return false
      let info = llm.resolveModelInfo({ provider, model })
      if (info && typeof info.then === 'function') info = await info
      return infoSupportsEffort(info, effort)
    } catch {
      return false
    }
  }

  /**
   * Resolve provider/model/effort for a request. Effort is only sent when the
   * provider declares support (§7.1); otherwise it is omitted entirely.
   * @param {object|null} run
   * @returns {Promise<{ provider: string, model: string, reasoningEffort?: string } | { error: object }>}
   */
  async function resolveModel(run = null) {
    const llm = safeService(getService, 'llm')
    const runModel = isPlainObject(run?.model) ? run.model : null
    const fallback = probed?.model || null
    const provider = asString(runModel?.provider) || asString(fallback?.provider)
    const model = asString(runModel?.model) || asString(fallback?.model)
    if (!provider || !model) return { error: { code: 'ANALYZER_UNAVAILABLE', message: '未配置可用模型' } }
    const requested = asString(runModel?.reasoningEffort) || asString(fallback?.reasoningEffort)
    const reasoningEffort = requested && await supportsEffort(llm, provider, model, requested) ? requested : undefined
    return { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
  }

  /**
   * Race a promise against an internal timeout. The controller is aborted on
   * timeout so a hanging prepareCall cannot keep the analyzer alive.
   * @template T
   * @param {Promise<T>} promise
   * @param {number} timeoutMs
   * @param {AbortController} controller
   * @returns {Promise<T>}
   */
  async function withTimeout(promise, timeoutMs, controller) {
    let timer = null
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            const err = new Error('analyzer timeout')
            err.name = 'TimeoutError'
            reject(err)
          }, timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Prepare one model call and consume its stream. Enforces: text-delta
   * accumulation, finish.reason.kind === 'stop', timeout and external abort.
   * @param {object} input
   * @param {{ provider: string, model: string, reasoningEffort?: string }} input.model
   * @param {string} input.system
   * @param {Array<{role: string, content: string}>} input.messages
   * @param {number} input.maxTokens
   * @param {AbortSignal|undefined} input.signal
   * @param {number} input.timeoutMs
   * @returns {Promise<{ ok: true, text: string, usage: { usedTokens: number, modelUsedTokens?: number, modelOutputTokens?: number } }
   *   | { ok: false, error: { code: string, message: string } }>}
   */
  async function requestCompletion({ model, system, messages, maxTokens, signal, timeoutMs }) {
    const llm = safeService(getService, 'llm')
    if (!llm || typeof llm.prepareCall !== 'function') {
      return failure('ANALYZER_UNAVAILABLE', '模型服务不可用')
    }
    if (signal?.aborted) return failure('ABORTED', '精炼已取消')

    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)

    let prepared = null
    let text = ''
    let finishReason = null
    let finishFailure = null
    let modelUsedTokens = 0
    let modelOutputTokens = 0
    // Raw Host `TokenUsage` echo ({ inputTokens, outputTokens, totalTokens?,
    // cacheReadTokens?, cacheWriteTokens? }) kept alongside the legacy
    // usedTokens figure so the lifecycle can accumulate a truthful run.usage.
    const tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    try {
      prepared = await llm.prepareCall({
        provider: model.provider,
        model: model.model,
        maxTokens,
        // §7.1: analysis calls always run at temperature 0 for determinism.
        temperature: 0,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
      }, controller.signal)
      if (!prepared || typeof prepared.stream !== 'function') {
        return failure('ANALYZER_UNAVAILABLE', '模型服务未返回可用的 stream')
      }
      const stream = prepared.stream({
        ...(isPlainObject(prepared.config) ? prepared.config : {}),
        system,
        messages,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk.type === 'usage') {
          const usage = isPlainObject(chunk.usage) ? chunk.usage : chunk
          if (Number.isFinite(usage.inputTokens)) {
            modelUsedTokens = usage.inputTokens
            tokenUsage.inputTokens = usage.inputTokens
          }
          if (Number.isFinite(usage.outputTokens)) {
            modelOutputTokens = usage.outputTokens
            tokenUsage.outputTokens = usage.outputTokens
          }
          if (Number.isFinite(usage.totalTokens)) {
            modelUsedTokens = usage.totalTokens
            tokenUsage.totalTokens = usage.totalTokens
          }
          // Host TokenUsage declares both cache counters as optional numbers.
          if (Number.isFinite(usage.cacheReadTokens)) tokenUsage.cacheReadTokens = usage.cacheReadTokens
          if (Number.isFinite(usage.cacheWriteTokens)) tokenUsage.cacheWriteTokens = usage.cacheWriteTokens
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason?.kind ?? chunk.finish?.reason?.kind ?? null
          // Adapter/transport failures arrive as `reason.kind === 'error'` (or
          // 'aborted') carrying an LlmFailure; keep it so the run error names
          // the real provider problem instead of a bare reason kind.
          const failure = chunk.reason?.failure ?? chunk.finish?.reason?.failure
          if (isPlainObject(failure)) finishFailure = failure
        }
      }
    } catch (err) {
      if (timedOut) return failure('ANALYZER_TIMEOUT', '模型调用超时', { timeoutMs })
      if (signal?.aborted) return failure('ABORTED', '精炼已取消')
      return failure('ANALYZER_UNAVAILABLE', err?.message || '模型调用失败')
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }

    if (timedOut) return failure('ANALYZER_TIMEOUT', '模型调用超时', { timeoutMs })
    if (signal?.aborted) return failure('ABORTED', '精炼已取消')
    if (finishReason !== 'stop') {
      const detail = isPlainObject(finishFailure)
        ? [asString(finishFailure.code), asString(finishFailure.message)].filter(Boolean).join(': ')
        : ''
      return failure(
        'ANALYZER_FINISH_REASON',
        `模型未正常结束（reason.kind=${String(finishReason)}${detail ? `；${detail}` : ''}）`,
        {
          ...(asString(finishFailure?.code) ? { providerCode: asString(finishFailure.code) } : {}),
          ...(Number.isFinite(finishFailure?.status) ? { providerStatus: finishFailure.status } : {}),
        },
      )
    }
    const echoedUsage = modelUsedTokens > 0 || modelOutputTokens > 0
    const estimatedInputTokens = estimateTokens(system) + estimateTokens(JSON.stringify(messages))
    const estimatedOutputTokens = estimateTokens(text)
    const usage = echoedUsage
      ? {
        usedTokens: modelUsedTokens + modelOutputTokens,
        modelUsedTokens,
        modelOutputTokens,
        inputTokens: tokenUsage.inputTokens || modelUsedTokens,
        outputTokens: tokenUsage.outputTokens || modelOutputTokens,
        totalTokens: tokenUsage.totalTokens || (tokenUsage.inputTokens + tokenUsage.outputTokens),
        cacheReadTokens: tokenUsage.cacheReadTokens,
        cacheWriteTokens: tokenUsage.cacheWriteTokens,
        calls: 1,
      }
      : {
        // No usage echo from the provider: estimate locally (never zero the
        // counters, or the run ledger silently under-reports the work done).
        usedTokens: estimatedInputTokens + estimatedOutputTokens,
        inputTokens: estimatedInputTokens,
        outputTokens: estimatedOutputTokens,
        totalTokens: estimatedInputTokens + estimatedOutputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        calls: 1,
        estimated: true,
      }
    return { ok: true, text, usage }
  }

  /**
   * Ask for JSON with schema validation and exactly one repair retry. The
   * original model response is always returned so the caller can keep an audit
   * copy (`rawResponseRef`).
   * @param {object} input
   * @param {{ provider: string, model: string, reasoningEffort?: string }} input.model
   * @param {string} input.system
   * @param {Array<{role: string, content: string}>} input.messages
   * @param {number} input.maxTokens
   * @param {AbortSignal|undefined} input.signal
   * @param {number} input.timeoutMs
   * @param {(value: any) => { ok: true, value: any } | { ok: false, code?: string, message: string, details?: any }} input.validate
   * @returns {Promise<{ ok: true, value: any, raw: string, usage: object }
   *   | { ok: false, error: { code: string, message: string, details?: any }, raw?: string, usage?: object }>}
   */
  async function requestJson({ model, system, messages, maxTokens, signal, timeoutMs, validate }) {
    let conversation = [...messages]
    let lastRaw = ''
    let lastUsage = null
    let lastError = { code: 'PLAN_INVALID', message: '模型输出无法通过校验' }
    // Every physical model call (including the one repair retry) adds to the
    // run ledger; a failed attempt still consumed tokens.
    const usageTotal = emptyRunUsage()

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const completion = await requestCompletion({
        model,
        system,
        messages: conversation,
        maxTokens,
        signal,
        timeoutMs,
      })
      accumulateRunUsage(usageTotal, completion.usage)
      // `usedTokens` is the legacy single figure some callers/tests read; keep
      // it accumulated separately so it never leaks into the run ledger shape.
      usageTotal.usedTokens = (Number(usageTotal.usedTokens) || 0) + (Number(completion.usage?.usedTokens) || 0)
      if (!completion.ok) return { ...completion, usage: usageTotal }
      lastRaw = completion.text
      lastUsage = completion.usage

      const parsed = parseJsonText(lastRaw)
      if (!parsed.ok) {
        lastError = {
          code: 'PLAN_INVALID',
          message: `模型输出不是合法 JSON：${parsed.error}`,
        }
      } else {
        const validation = validate(parsed.value)
        if (validation.ok) {
          return { ok: true, value: validation.value, raw: lastRaw, usage: usageTotal }
        }
        lastError = {
          code: validation.code || 'PLAN_INVALID',
          message: validation.message,
          ...(validation.details !== undefined ? { details: validation.details } : {}),
        }
      }

      if (attempt === 0) {
        // The repair turn stays user-only: a hand-built assistant message would
        // have to carry the Host's durable `source` envelope, and the DeepSeek
        // adapter reads `message.source.replayState` on assistant history
        // (a source-less assistant message crashed stage 2 with
        // "Cannot read properties of undefined (reading 'replayState')").
        // Quoting the rejected output inside the user turn is enough context.
        conversation = [
          ...messages,
          userTextMessage(
            `上一次输出未通过校验：${lastError.message}`
              + `${lastError.details ? `；${JSON.stringify(lastError.details).slice(0, 2000)}` : ''}。\n`
              + `上一次输出（截断）：${lastRaw.slice(0, 4000)}\n`
              + '请只输出修正后的 JSON 对象，不要解释、不要代码块。',
          ),
        ]
      }
    }
    return { ok: false, error: lastError, raw: lastRaw, usage: usageTotal }
  }

  /**
   * Probe the model before creating a run: model selection + contextWindow.
   * Never guesses a default window (§7.1 / §16.17).
   * @returns {Promise<
   *   { ok: true, contextWindow: number, model: {provider: string, model: string, reasoningEffort?: string} }
   *   | { ok: false, error: { code: string, message: string } }
   * >}
   */
  async function probeContextWindow() {
    try {
      const llm = safeService(getService, 'llm')
      if (!llm || typeof llm.prepareCall !== 'function') {
        return failure('ANALYZER_UNAVAILABLE', '模型服务不可用，请检查模型配置后重试')
      }
      const defaultModel = safeService(getService, 'agentDefaultModel')
      let selection = null
      try {
        selection = defaultModel?.currentSelection?.() ?? null
      } catch {
        selection = null
      }
      const provider = asString(selection?.provider)
      const model = asString(selection?.model)
      if (!provider || !model) {
        return failure('ANALYZER_UNAVAILABLE', '未配置可用模型，请先在 DSH 中选择模型')
      }
      const requestedEffort = asString(selection?.reasoningEffort) || asString(options.reasoningEffort)
      const reasoningEffort = requestedEffort && await supportsEffort(llm, provider, model, requestedEffort)
        ? requestedEffort
        : undefined
      const resolvedModel = { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }

      const controller = new AbortController()
      let prepared = null
      try {
        prepared = await withTimeout(
          llm.prepareCall({
            provider,
            model,
            maxTokens: PROBE_MAX_TOKENS,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          }, controller.signal),
          probeTimeoutMs,
          controller,
        )
      } catch {
        return failure('ANALYZER_UNAVAILABLE', '模型服务不可用，无法读取上下文窗口')
      }
      const contextWindow = prepared?.context?.contextWindow
        ?? prepared?.config?.context?.contextWindow
      if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
        return failure('CONTEXT_WINDOW_UNAVAILABLE', '无法读取模型 contextWindow，请检查模型配置后重试')
      }
      probed = { model: resolvedModel, contextWindow }
      return { ok: true, contextWindow, model: resolvedModel }
    } catch (err) {
      return failure('ANALYZER_UNAVAILABLE', err?.message || '模型探测失败')
    }
  }

  /**
   * @param {object[]} materials
   * @returns {object[]}
   */
  function serializeMaterials(materials) {
    return (Array.isArray(materials) ? materials : []).map(material => ({
      findingId: material?.findingId,
      sessionId: material?.sessionId,
      grade: material?.grade,
      title: material?.title,
      text: material?.text,
      turn: material?.turn,
      time: material?.time,
      pendingConfirmation: material?.pendingConfirmation === true,
      negativeContext: material?.negativeContext === true,
      evidence: Array.isArray(material?.commits) && material.commits.length > 0
        ? material.commits.map(commit => ({ hash: commit?.hash, subject: commit?.subject }))
        : undefined,
    }))
  }

  /**
   * @param {number|object} budget
   * @returns {number}
   */
  function maxTokensOf(budget, fallback = 8000) {
    if (Number.isFinite(budget) && budget > 0) return budget
    if (isPlainObject(budget) && Number.isFinite(budget.maxTokens) && budget.maxTokens > 0) return budget.maxTokens
    return fallback
  }

  /**
   * Normalized `run.usage` ledger for one stage call: token counters plus the
   * number of physical model calls (repair retries included). Missing fields
   * add 0 — a provider that omits counters must never fail a stage.
   * @param {object|undefined} usage accumulated call usage
   * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number,
   *   cacheReadTokens: number, cacheWriteTokens: number, calls: number }}
   */
  function ledgerOf(usage) {
    const ledger = emptyRunUsage()
    accumulateRunUsage(ledger, isPlainObject(usage) ? usage : {})
    return ledger
  }

  /**
   * Stage-2 prompt digest for the already-applied fingerprints (§12.3): only
   * the same workspace, the recent 180 days, grouped by target file. Keeps the
   * prompt compact while still letting the model avoid duplicate proposals.
   * @param {object[]} fingerprints
   * @param {string} [workspaceId] the run's workspace; cross-workspace rows are ignored
   * @returns {{ windowDays: number, total: number, byFile: Array<{ file: string, count: number, changes: object[] }> }}
   */
  function buildFingerprintSummary(fingerprints, workspaceId) {
    const cutoff = clock() - FINGERPRINT_PROMPT_WINDOW_MS
    const groups = new Map()
    for (const fingerprint of Array.isArray(fingerprints) ? fingerprints : []) {
      if (!fingerprint || typeof fingerprint.targetFile !== 'string' || fingerprint.targetFile === '') continue
      if (typeof workspaceId === 'string' && workspaceId !== ''
        && typeof fingerprint.workspaceId === 'string' && fingerprint.workspaceId !== ''
        && fingerprint.workspaceId !== workspaceId) continue
      const time = typeof fingerprint.appliedAt === 'number'
        ? fingerprint.appliedAt
        : (typeof fingerprint.updatedAt === 'number'
          ? fingerprint.updatedAt
          : (typeof fingerprint.createdAt === 'number' ? fingerprint.createdAt : null))
      if (time === null || time < cutoff) continue
      if (!groups.has(fingerprint.targetFile)) groups.set(fingerprint.targetFile, [])
      groups.get(fingerprint.targetFile).push({
        changeKind: asString(fingerprint.changeKind),
        ...(asString(fingerprint.sectionAnchor) ? { sectionAnchor: asString(fingerprint.sectionAnchor) } : {}),
        ...(asString(fingerprint.normalizedHash) ? { normalizedHash: asString(fingerprint.normalizedHash) } : {}),
      })
    }
    const byFile = [...groups.entries()]
      .map(([file, changes]) => ({ file, count: changes.length, changes }))
      .sort((a, b) => a.file.localeCompare(b.file))
    return {
      windowDays: FINGERPRINT_PROMPT_WINDOW_MS / (24 * 3600 * 1000),
      total: byFile.reduce((sum, group) => sum + group.count, 0),
      byFile,
    }
  }

  /**
   * @param {object} value
   * @returns {{ ok: true, value: { sessionId?: string, candidates: object[] } } | { ok: false, code?: string, message: string }}
   */
  function validateStage1Output(value) {
    if (!isPlainObject(value)) return { ok: false, code: 'CANDIDATES_INVALID', message: '输出必须是 JSON 对象' }
    const rawCandidates = Array.isArray(value.candidates) ? value.candidates : null
    if (!rawCandidates) return { ok: false, code: 'CANDIDATES_INVALID', message: 'candidates 必须是数组' }
    const candidates = []
    for (const [index, candidate] of rawCandidates.entries()) {
      if (!isPlainObject(candidate)) {
        return { ok: false, code: 'CANDIDATES_INVALID', message: `candidates[${index}] 必须是对象` }
      }
      const rule = asString(candidate.rule).trim()
      if (!rule) return { ok: false, code: 'CANDIDATES_INVALID', message: `candidates[${index}].rule 不能为空` }
      candidates.push({
        rule,
        evidenceRefs: Array.isArray(candidate.evidenceRefs)
          ? candidate.evidenceRefs.filter(item => typeof item === 'string')
          : [],
        suggestedTargets: Array.isArray(candidate.suggestedTargets)
          ? candidate.suggestedTargets.filter(item => typeof item === 'string')
          : [],
      })
    }
    return { ok: true, value: { sessionId: asString(value.sessionId) || undefined, candidates } }
  }

  /** Max code points echoed as `change.beforeText` (Host contract §2.1). */
  const BEFORE_TEXT_MAX_CHARS = 2000

  /**
   * Code-point-safe truncation (never splits a surrogate pair). The confirm
   * page echoes these snippets inside read-only code blocks, so a hard 2000
   * character cap is the contract, not an estimate.
   * @param {string} text
   * @param {number} max
   * @returns {string}
   */
  function truncateBeforeText(text, max) {
    if (typeof text !== 'string' || text === '') return ''
    const chars = Array.from(text)
    return chars.length > max ? chars.slice(0, max).join('') : text
  }

  /**
   * Index the plan-generation target snippets (`[{ file, content }]`, produced
   * by the Host's collectTargetSnippets) by file. A plain `{ file: content }`
   * map is accepted too so older callers keep working.
   * @param {unknown} targetSnippets
   * @returns {Map<string, string>}
   */
  function targetSnippetIndex(targetSnippets) {
    const byFile = new Map()
    const add = (file, content) => {
      if (!file || typeof content !== 'string' || content === '') return
      if (!byFile.has(file)) byFile.set(file, content)
    }
    if (Array.isArray(targetSnippets)) {
      for (const snippet of targetSnippets) {
        if (!isPlainObject(snippet)) continue
        add(asString(snippet.file), snippet.content)
      }
    } else if (isPlainObject(targetSnippets)) {
      for (const [file, content] of Object.entries(targetSnippets)) add(file, content)
    }
    return byFile
  }

  /**
   * Original text of the section a change targets, taken from the plan-time
   * snapshot (never re-read from disk) so the human sees what the model saw.
   * Slices at the change's ATX anchor (child sections included) and falls back
   * to the file head when the anchor is absent or no longer matches. Returns
   * '' when no snapshot exists for the file — old plans are never back-filled.
   * @param {string} snapshot plan-generation file content
   * @param {string|undefined} anchor `sectionAnchor` of the change
   * @returns {string}
   */
  function beforeTextFor(snapshot, anchor) {
    if (typeof snapshot !== 'string' || snapshot === '') return ''
    const normalized = normalizeNewlines(snapshot)
    const parsed = anchor ? parseAtxHeading(anchor) : null
    if (parsed) {
      const match = collectAtxAnchors(normalized)
        .find(entry => entry.level === parsed.level && entry.text === parsed.text)
      if (match) {
        return truncateBeforeText(
          normalized.split('\n').slice(match.startLine, match.endLine).join('\n'),
          BEFORE_TEXT_MAX_CHARS,
        )
      }
    }
    return truncateBeforeText(normalized, BEFORE_TEXT_MAX_CHARS)
  }

  /**
   * Build the plan the Host actually persists from the model's semantic draft.
   *
   * The model owns prose: summary, target files, change bodies, rationale and
   * evidence references. Everything structural is deterministic Host terrain —
   * `navigation` comes from the read navigation tree, `fileBaseHash` comes from
   * the real disk snapshot, `stats` is recount from the changes, change ids are
   * assigned in order and evidence rows are resolved against the frozen
   * materials. A model that invents a hash or forgets `stats`/`navigation` must
   * not fail the run for it. `changes[].beforeText` is the Host snapshot slice
   * used by the confirm page's before/after diff — model text never fills it.
   *
   * @param {object} draft model-authored plan draft
   * @param {{ run?: object, navigation?: object, stage1Results?: object[], budget?: object, targetSnippets?: object, resolveFileFacts?: Function }} context
   * @returns {{ ok: true, plan: object } | { ok: false, message: string, details?: any }}
   */
  function normalizePlanDraft(draft, context = {}) {
    const run = isPlainObject(context.run) ? context.run : {}
    const navigation = isPlainObject(context.navigation) ? context.navigation : {}
    const mode = navigation.mode === 'tree' ? 'tree' : 'fallback'
    // Plan-time snapshots for the before/after diff (§2.1). Missing entries are
    // expected (the model may target a file stage 1 never suggested): the change
    // simply carries no beforeText and the confirm page shows `noBefore`.
    const snippetByFile = targetSnippetIndex(context.targetSnippets)
    const materialsBySession = new Map()
    for (const entry of Array.isArray(context.stage1Results) ? context.stage1Results : []) {
      if (!isPlainObject(entry)) continue
      const sessionId = asString(entry.sessionId)
      if (!sessionId) continue
      materialsBySession.set(sessionId, Array.isArray(entry.materials) ? entry.materials.filter(isPlainObject) : [])
    }
    const candidates = []
    for (const entry of Array.isArray(context.stage1Results) ? context.stage1Results : []) {
      if (!isPlainObject(entry)) continue
      for (const candidate of Array.isArray(entry.candidates) ? entry.candidates : []) {
        if (!isPlainObject(candidate)) continue
        candidates.push({ sessionId: asString(entry.sessionId), candidate })
      }
    }

    const materialOf = (sessionId, ref) => {
      const materials = materialsBySession.get(sessionId) || []
      if (!ref) return null
      return materials.find(material => material.findingId === ref || material.messageId === ref) || null
    }
    const toEvidence = (sessionId, ref) => {
      const material = materialOf(sessionId, ref)
      if (!material) return null
      return {
        sessionId,
        messageId: asString(material.messageId) || asString(ref),
        ...(Number.isFinite(material.turn) ? { turn: material.turn } : {}),
        grade: asString(material.grade) || 'submitted',
        ...(asString(material.grade) === 'commit' && Array.isArray(material.commits) && material.commits[0]?.hash
          ? { commit: String(material.commits[0].hash).slice(0, 7) }
          : {}),
      }
    }
    const evidenceForChange = (rawChange, file, sessionIdHint) => {
      // Model-authored evidence rows are the primary source: keep those that are
      // structurally valid (the human reviews the snippet), enriching them from
      // the frozen materials when the ref resolves.
      const evidence = []
      for (const item of Array.isArray(rawChange?.evidence) ? rawChange.evidence : []) {
        if (!isPlainObject(item)) continue
        const sessionId = asString(item.sessionId) || sessionIdHint
        const messageId = asString(item.messageId)
        const grade = asString(item.grade)
        if (!sessionId || !messageId || !['resolved', 'commit', 'submitted', 'dismissed'].includes(grade)) continue
        const material = materialOf(sessionId, messageId)
        const commit = asString(item.commit) || (Array.isArray(material?.commits) && material.commits[0]?.hash
          ? String(material.commits[0].hash).slice(0, 7)
          : '')
        if (grade === 'commit' && !commit) continue
        evidence.push({
          sessionId,
          messageId,
          grade,
          ...(Number.isFinite(item.turn) ? { turn: item.turn } : (Number.isFinite(material?.turn) ? { turn: material.turn } : {})),
          ...(grade === 'commit' ? { commit } : {}),
        })
      }
      if (evidence.length > 0) return evidence
      // Fall back to the stage-1 candidates that suggested this exact file.
      for (const { sessionId, candidate } of candidates) {
        if (!Array.isArray(candidate.suggestedTargets) || !candidate.suggestedTargets.includes(file)) continue
        for (const ref of Array.isArray(candidate.evidenceRefs) ? candidate.evidenceRefs : []) {
          const resolved = toEvidence(sessionId, ref)
          if (resolved) evidence.push(resolved)
        }
        if (evidence.length > 0) return evidence.slice(0, 3)
        const materials = materialsBySession.get(sessionId) || []
        const best = materials.find(material => material.grade !== 'dismissed')
        if (best) {
          const resolved = toEvidence(sessionId, best.messageId || best.findingId)
          if (resolved) return [resolved]
        }
      }
      return []
    }

    const rawTargets = Array.isArray(draft?.targets) ? draft.targets.filter(isPlainObject) : []
    const targets = []
    let changeSeq = 0
    for (const rawTarget of rawTargets) {
      const file = asString(rawTarget.file)
      if (!file) continue
      const facts = typeof context.resolveFileFacts === 'function'
        ? context.resolveFileFacts(file)
        : null
      const action = facts
        ? (facts.exists ? 'update' : 'create')
        : (rawTarget.action === 'create' ? 'create' : 'update')
      const fileBaseHash = facts
        ? (facts.exists ? asString(facts.fileBaseHash) : null)
        : (action === 'update' ? asString(rawTarget.fileBaseHash) : null)
      const rawChanges = Array.isArray(rawTarget.changes) ? rawTarget.changes.filter(isPlainObject) : []
      const changes = []
      let sessionHint = ''
      for (const rawChange of rawChanges) {
        if (changes.length > 0 && action === 'create') break
        const evidence = evidenceForChange(rawChange, file, sessionHint)
        if (evidence.length === 0) continue
        changeSeq += 1
        const kind = action === 'create'
          ? 'create-file'
          : (typeof rawChange.kind === 'string' ? rawChange.kind : 'append-section')
        const change = {
          id: `c${changeSeq}`,
          kind,
          ...(kind === 'create-file'
            ? {}
            : (typeof rawChange.sectionAnchor === 'string' && rawChange.sectionAnchor
              ? { sectionAnchor: rawChange.sectionAnchor }
              : {})),
          proposedText: asString(rawChange.proposedText),
          rationale: asString(rawChange.rationale) || '由精炼分析生成',
          evidenceSnippet: asString(rawChange.evidenceSnippet).slice(0, 300),
          evidence,
          dependsOn: [],
        }
        if (!change.sectionAnchor && (kind === 'insert-into-section' || kind === 'replace-block')) {
          change.sectionAnchor = asString(rawChange.sectionAnchor)
        }
        // submitted-grade rules must read as pending confirmation (spec §5.2).
        const grade = change.evidence.some(item => item.grade === 'resolved')
          ? 'resolved'
          : change.evidence.some(item => item.grade === 'commit')
            ? 'commit'
            : change.evidence.some(item => item.grade === 'submitted') ? 'submitted' : null
        if (grade === 'submitted' && !change.rationale.startsWith('待确认')) {
          change.rationale = `待确认：${change.rationale}`
        }
        // §2.1 before/after diff: original section text from the plan-time
        // snapshot. A `create` target has no "before" (the UI renders newFile)
        // and a file without a snapshot keeps no beforeText — nothing is faked.
        if (action !== 'create') {
          const snapshot = snippetByFile.get(file)
          if (snapshot !== undefined) {
            const before = beforeTextFor(snapshot, change.sectionAnchor)
            if (before !== '') change.beforeText = before
          }
        }
        changes.push(change)
      }
      if (changes.length === 0) continue
      targets.push({
        file,
        action,
        navRef: asString(rawTarget.navRef) || (mode === 'tree' ? `AGENTS.md §0 → ${file}` : ''),
        fileBaseHash,
        changes,
      })
    }

    // §8.1: in tree mode a root AGENTS.md / README.md update is only legal as the
    // paired navigation registration of a newly created document. Any other root
    // edit would fail static validation with a plan-level error and block the
    // whole apply, so drop it deterministically and say so in the summary.
    const ROOT_FILES = new Set(['AGENTS.md', 'README.md'])
    const CHANGELOG_ROW = /^\s*\|.*\d{4}-\d{2}-\d{2}.*\|\s*$/m
    const createdFiles = targets
      .filter(target => target.action === 'create')
      .flatMap(target => target.changes.map(change => target.file))
    const droppedNotes = []
    const keptTargets = []
    for (const target of targets) {
      // §9 变更闭环: docs/arch updates must carry a ChangeLog row. Dropping is
      // safer than inventing a version/date row into an unrelated section.
      if (target.action === 'update' && target.file.startsWith('docs/arch/')
        && !target.changes.some(change => CHANGELOG_ROW.test(change.proposedText))) {
        droppedNotes.push({ file: target.file, count: target.changes.length, reason: 'no-changelog' })
        continue
      }
      if (mode === 'tree' && ROOT_FILES.has(target.file) && target.action === 'update') {
        const registered = createdFiles.some(file => target.changes.some(change => change.proposedText.includes(file)))
        if (!registered) {
          droppedNotes.push({ file: target.file, count: target.changes.length, reason: 'root-file' })
          continue
        }
      }
      keptTargets.push(target)
    }
    targets.length = 0
    targets.push(...keptTargets)

    const changeIds = new Set(targets.flatMap(target => target.changes.map(change => change.id)))
    for (const target of targets) {
      for (const change of target.changes) {
        change.dependsOn = (Array.isArray(change.dependsOn) ? change.dependsOn : [])
          .filter(dep => typeof dep === 'string' && dep !== change.id && changeIds.has(dep))
      }
    }

    const claimsFor = (rawClaims) => {
      const claims = []
      for (const rawClaim of Array.isArray(rawClaims) ? rawClaims : []) {
        if (!isPlainObject(rawClaim)) continue
        const sessionId = asString(rawClaim.sessionId)
        if (!sessionId) continue
        const ref = asString(rawClaim.messageId)
        const material = ref ? materialOf(sessionId, ref) : null
        const claim = asString(rawClaim.claim)
        if (!claim) continue
        const grade = asString(rawClaim.evidenceGrade)
        const messageId = asString(material?.messageId) || asString(material?.findingId) || ref
        if (!messageId) continue
        claims.push({
          sessionId,
          messageId,
          claim,
          evidenceGrade: ['resolved', 'commit', 'submitted', 'dismissed'].includes(grade)
            ? grade
            : (asString(material?.grade) || 'submitted'),
          ...(Number.isFinite(rawClaim.turn) ? { turn: rawClaim.turn } : (Number.isFinite(material?.turn) ? { turn: material.turn } : {})),
        })
      }
      return claims
    }
    const conflicts = []
    for (const rawConflict of Array.isArray(draft?.conflicts) ? draft.conflicts : []) {
      if (!isPlainObject(rawConflict)) continue
      const claims = claimsFor(rawConflict.claims)
      if (claims.length < 2) continue
      const requested = ['code', 'session', 'unresolved'].includes(rawConflict.resolvedBy)
        ? rawConflict.resolvedBy
        : 'unresolved'
      const codeEvidence = (Array.isArray(rawConflict.codeEvidence) ? rawConflict.codeEvidence : [])
        .filter(item => isPlainObject(item) && asString(item.commit) && typeof item.committedAt === 'number' && asString(item.path))
        .map(item => ({ commit: asString(item.commit), committedAt: item.committedAt, path: asString(item.path) }))
      const resolvedBy = requested === 'code' && codeEvidence.length === 0 ? 'unresolved' : requested
      conflicts.push({
        topic: asString(rawConflict.topic) || '未命名冲突',
        claims,
        resolvedBy,
        ...(codeEvidence.length > 0 ? { codeEvidence } : {}),
        ...(asString(rawConflict.note) ? { note: asString(rawConflict.note) } : {}),
      })
    }

    const byGrade = { resolved: 0, commit: 0, submitted: 0 }
    let changeCount = 0
    for (const target of targets) {
      for (const change of target.changes) {
        changeCount += 1
        const grade = change.evidence.some(item => item.grade === 'resolved')
          ? 'resolved'
          : change.evidence.some(item => item.grade === 'commit')
            ? 'commit'
            : 'submitted'
        byGrade[grade] += 1
      }
    }

    let summary = asString(draft?.summary)
    // A dropped proposal must stay visible: silently shortening the plan made
    // users think the model never produced their change. `dropped` carries the
    // machine reason (the confirm page localises it) and the summary keeps a
    // human sentence for the result page / non-UI consumers.
    const DROPPED_REASON_TEXT = {
      'no-changelog': 'arch 文档缺少 ChangeLog 行',
      'root-file': 'tree 模式下根文件只用于新文档导航登记',
    }
    for (const note of droppedNotes) {
      const reasonText = DROPPED_REASON_TEXT[note.reason] || note.reason
      summary = `${summary}${summary ? ' ' : ''}（已省略 ${note.file} 的 ${note.count} 条变更：${reasonText}。）`
    }

    const plan = {
      schemaVersion: 1,
      runId: asString(run.id),
      workspaceId: asString(run.workspaceId),
      summary,
      navigation: {
        source: mode === 'tree' ? 'AGENTS.md#0' : 'fallback',
        mode,
        fallback: mode === 'fallback',
      },
      targets,
      conflicts,
      stats: { targets: targets.length, changes: changeCount, byGrade },
      // Proposals discarded by deterministic shaping, so the confirmation page can
      // say why they are missing instead of the user assuming they were never proposed.
      dropped: droppedNotes.map(note => ({ file: note.file, count: note.count, reason: note.reason })),
      truncated: context.budget?.truncated === true,
    }
    if (targets.length === 0) {
      return { ok: false, message: '模型中没有任何带证据的写回条目', details: ['targets must be a non-empty array with evidence'] }
    }
    return { ok: true, plan }
  }

  /**
   * Accept either a bare ChangePlan or `{plan, summaries}` (§7 wrapper used so
   * stage 2 can return per-session summaries without a second model call).
   * The semantic draft is normalized into the Host-owned ChangePlan shape first,
   * then validated against the strict schema.
   * @param {object} value
   * @param {object} [context]
   * @returns {{ ok: true, value: { plan: object, summaries: object[] } } | { ok: false, code?: string, message: string, details?: any }}
   */
  function validateStage2Output(value, context = {}) {
    if (!isPlainObject(value)) return { ok: false, code: 'PLAN_INVALID', message: '输出必须是 JSON 对象' }
    const draft = isPlainObject(value.plan) ? value.plan : value
    const normalized = normalizePlanDraft(draft, context)
    if (!normalized.ok) {
      return { ok: false, code: 'PLAN_INVALID', message: normalized.message, details: normalized.details }
    }
    const schema = validateChangePlan(normalized.plan)
    if (!schema.ok) {
      return { ok: false, code: 'PLAN_INVALID', message: 'ChangePlan 校验失败', details: schema.errors }
    }
    const summaries = Array.isArray(value.summaries)
      ? value.summaries
        .filter(item => isPlainObject(item)
          && typeof item.sessionId === 'string'
          && typeof item.markdown === 'string'
          && item.markdown.trim() !== '')
        .map(item => ({
          sessionId: item.sessionId,
          ...(typeof item.title === 'string' && item.title ? { title: item.title } : {}),
          markdown: item.markdown,
          source: 'llm',
        }))
      : []
    return { ok: true, value: { plan: normalized.plan, summaries } }
  }

  /**
   * @param {object[]} stage1Results
   * @returns {Map<string, object>}
   */
  function sessionResultMap(stage1Results) {
    const map = new Map()
    for (const entry of Array.isArray(stage1Results) ? stage1Results : []) {
      if (!isPlainObject(entry)) continue
      const sessionId = asString(entry.sessionId)
      if (sessionId) map.set(sessionId, entry)
    }
    return map
  }

  /**
   * Build per-session summaries: model-provided (`llm`) wins, otherwise a
   * deterministic `renderDigest` document (`digest`), and genuinely empty
   * sessions still get an explicit empty-state document.
   * @param {object} run
   * @param {object[]} stage1Results
   * @param {object[]} llmSummaries
   * @returns {Array<{ sessionId: string, title?: string, markdown: string, source: 'digest'|'llm' }>}
   */
  function buildSummaries(run, stage1Results, llmSummaries) {
    const sessions = Array.isArray(run?.sessions) ? run.sessions.filter(item => isPlainObject(item)) : []
    const bySession = sessionResultMap(stage1Results)
    const llmBySession = new Map()
    for (const summary of Array.isArray(llmSummaries) ? llmSummaries : []) {
      if (!summary?.sessionId || !summary?.markdown) continue
      llmBySession.set(summary.sessionId, summary)
    }
    const sessionIds = []
    for (const session of sessions) {
      const sessionId = asString(session.sessionId)
      if (sessionId && !sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    }
    for (const sessionId of bySession.keys()) {
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    }
    for (const sessionId of llmBySession.keys()) {
      if (!sessionIds.includes(sessionId)) sessionIds.push(sessionId)
    }

    return sessionIds.map(sessionId => {
      const session = sessions.find(item => asString(item.sessionId) === sessionId) || {}
      const title = asString(session.title) || asString(llmBySession.get(sessionId)?.title) || undefined
      const llm = llmBySession.get(sessionId)
      if (llm) {
        return { sessionId, ...(title ? { title } : {}), markdown: llm.markdown, source: 'llm' }
      }
      const entry = bySession.get(sessionId) || {}
      const materials = Array.isArray(entry.materials) ? entry.materials : []
      const findings = Array.isArray(entry.findings)
        ? entry.findings
        : materials.map(material => ({
          status: material?.grade === 'resolved'
            ? 'resolved'
            : (material?.grade === 'dismissed' ? 'dismissed' : 'open'),
          title: asString(material?.title) || asString(material?.text).slice(0, 80),
          body: asString(material?.text),
        }))
      const promptLog = Array.isArray(entry.promptLog)
        ? entry.promptLog
        : materials.map(material => ({
          excerpt: asString(material?.userText) || asString(material?.text).slice(0, 200),
          turn: material?.turn,
          time: material?.time,
        }))
      const markdown = renderDigest({
        sessionTitle: title,
        promptLog,
        findings,
        decisions: Array.isArray(entry.decisions) ? entry.decisions : [],
        nextSteps: asString(entry.nextSteps),
      })
      return { sessionId, ...(title ? { title } : {}), markdown, source: 'digest' }
    })
  }

  /**
   * Persist the raw response audit copy and trim the copies of runs outside the
   * newest-20 window. Best-effort + idempotent: failures never fail the stage.
   * @param {object} plan
   * @param {string} raw
   * @returns {Promise<void>}
   */
  async function persistRawResponse(plan, raw) {
    if (!store || typeof store.putDistillPlan !== 'function') return
    const runId = asString(plan?.runId)
    if (!runId) return
    const rawResponseRef = typeof raw === 'string' ? raw.slice(0, maxRawResponseChars) : ''
    if (!rawResponseRef) return
    try {
      await store.putDistillPlan({ ...plan, rawResponseRef })
    } catch {
      return
    }
    const workspaceId = asString(plan?.workspaceId)
    if (!workspaceId
      || typeof store.listDistillRuns !== 'function'
      || typeof store.getDistillPlan !== 'function') return
    try {
      const runs = await store.listDistillRuns(workspaceId)
      for (let index = rawRetentionRuns; index < runs.length; index += 1) {
        const oldRunId = asString(runs[index]?.id)
        if (!oldRunId || oldRunId === runId) continue
        const oldPlan = await store.getDistillPlan(oldRunId)
        if (!oldPlan || typeof oldPlan !== 'object' || !('rawResponseRef' in oldPlan)) continue
        const nextPlan = { ...oldPlan }
        delete nextPlan.rawResponseRef
        await store.putDistillPlan(nextPlan)
      }
    } catch {
      // Best-effort: the next runStage2 call retries the cleanup.
    }
  }

  /**
   * @param {object[]} stage1Results
   * @returns {object[]}
   */
  function normalizeStage1Results(stage1Results) {
    return (Array.isArray(stage1Results) ? stage1Results : [])
      .filter(entry => isPlainObject(entry))
      .map(entry => ({
        ...entry,
        candidates: Array.isArray(entry.candidates) ? entry.candidates : [],
      }))
  }

  /**
   * Per-session candidate extraction (stage 1). 120s timeout, AbortSignal and
   * per-call progress `{stage:'stage1', completed, total, sessionId}`.
   * @param {object} input
   * @returns {Promise<{ ok: true, candidates: object[], usage: { usedTokens: number, truncated: boolean } }
   *   | { ok: false, error: { code: string, message: string } }>}
   */
  async function runStage1({ sessionId, materials, budget, signal, onProgress } = {}) {
    try {
      if (typeof sessionId !== 'string' || sessionId.trim() === '') {
        return failure('INVALID_INPUT', 'runStage1 需要 sessionId')
      }
      const probe = probed ? { ok: true, ...probed } : await probeContextWindow()
      if (!probe.ok) return probe
      const model = await resolveModel(null)
      if (model.error) return { ok: false, error: model.error }

      const sessionMaterials = (Array.isArray(materials) ? materials : [])
        .filter(material => isPlainObject(material))
        .filter(material => !material.sessionId || material.sessionId === sessionId)
      const notify = progress => {
        if (typeof onProgress !== 'function') return
        try { onProgress(progress) } catch {}
      }
      notify({ stage: 'stage1', completed: 0, total: 1, sessionId })

      const result = await requestJson({
        model,
        system: STAGE1_SYSTEM,
        messages: [userTextMessage(
          JSON.stringify({ sessionId, materials: serializeMaterials(sessionMaterials) }),
        )],
        maxTokens: maxTokensOf(budget),
        signal,
        timeoutMs: stage1TimeoutMs,
        validate: validateStage1Output,
      })
      if (!result.ok) {
        return { ok: false, error: result.error, ...(result.raw !== undefined ? { raw: result.raw } : {}) }
      }
      notify({ stage: 'stage1', completed: 1, total: 1, sessionId })
      return {
        ok: true,
        candidates: result.value.candidates,
        usage: {
          usedTokens: Number(result.usage?.usedTokens) || 0,
          // Raw call ledger (§1.5): the lifecycle accumulates it into run.usage.
          ...ledgerOf(result.usage),
          truncated: isPlainObject(budget) ? budget.truncated === true : false,
        },
      }
    } catch (err) {
      return failure('ANALYZER_INTERNAL', err?.message || '阶段 1 执行失败')
    }
  }

  /**
   * Merge stage-1 candidates into a ChangePlan + per-session summaries
   * (stage 2). 240s timeout, JSON schema validation with one repair retry,
   * rawResponseRef audit copy and best-effort retention cleanup.
   * @param {object} input
   * @returns {Promise<{
   *   ok: true,
   *   plan: object,
   *   summaries: Array<{ sessionId: string, title?: string, markdown: string, source: 'digest'|'llm' }>,
   *   usage: { usedTokens: number, truncated: boolean },
   * } | { ok: false, error: { code: string, message: string } }>}
   */
  async function runStage2({
    run,
    stage1Results,
    navigation,
    fingerprints,
    targetSnippets,
    budget,
    signal,
    onProgress,
    resolveFileFacts,
  } = {}) {
    try {
      if (!isPlainObject(run) || !asString(run.id) || !asString(run.workspaceId)) {
        return failure('INVALID_INPUT', 'runStage2 需要 run.id 与 run.workspaceId')
      }
      const probe = probed ? { ok: true, ...probed } : await probeContextWindow()
      if (!probe.ok) return probe
      const model = await resolveModel(run)
      if (model.error) return { ok: false, error: model.error }

      const notify = progress => {
        if (typeof onProgress !== 'function') return
        try { onProgress(progress) } catch {}
      }
      notify({ stage: 'stage2', completed: 0, total: 1 })

      const result = await requestJson({
        model,
        system: STAGE2_SYSTEM,
        messages: [userTextMessage(JSON.stringify({
          run: {
            id: run.id,
            workspaceId: run.workspaceId,
            sessions: Array.isArray(run.sessions) ? run.sessions : [],
            scope: run.scope ?? {},
          },
          stage1Results: normalizeStage1Results(stage1Results),
          navigation: navigation ?? null,
          targetSnippets: targetSnippets ?? {},
          fingerprintSummary: buildFingerprintSummary(fingerprints, run.workspaceId),
        }))],
        maxTokens: maxTokensOf(budget),
        signal,
        timeoutMs: stage2TimeoutMs,
        validate: value => validateStage2Output(value, {
          run,
          navigation,
          stage1Results,
          budget,
          targetSnippets,
          resolveFileFacts,
        }),
      })
      if (!result.ok) {
        return { ok: false, error: result.error, ...(result.raw !== undefined ? { raw: result.raw } : {}) }
      }

      const { plan, summaries: llmSummaries } = result.value
      const summaries = buildSummaries(run, stage1Results, llmSummaries)
      await persistRawResponse(plan, result.raw)
      notify({ stage: 'stage2', completed: 1, total: 1 })
      return {
        ok: true,
        plan,
        summaries,
        usage: {
          usedTokens: Number(result.usage?.usedTokens) || 0,
          ...ledgerOf(result.usage),
          truncated: isPlainObject(budget) ? budget.truncated === true : false,
        },
      }
    } catch (err) {
      return failure('ANALYZER_INTERNAL', err?.message || '阶段 2 执行失败')
    }
  }

  return { probeContextWindow, runStage1, runStage2 }
}
