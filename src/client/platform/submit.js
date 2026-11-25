/** Submit findings to a session queue, edit still-queued prompt items in place, and derive entry status changes. */

import {
  composeCombinedPrompt,
  composeSequentialPrompt,
  validateBatch,
  validatePromptText,
} from '../../domain/prompt.js'
import { forkFinding } from '../../domain/entries.js'

/**
 * @typedef {{ code: string, message: string }} SubmitError
 * @typedef {{ entryId: string, requestId: string, acceptedAt?: number, submissionSeq?: number, evidencePending?: true, evidenceError?: SubmitError }} SubmitRequestResult
 *
 * SubmitResult is the union of the send outcome and the acceptance-evidence
 * outcome. Acceptance evidence (`acceptedAt`/`submissionSeq`) is recorded only
 * after `prompt()` resolved accepted; a sole `acceptedAt` or `submissionSeq`
 * is never emitted (the pair is the Finding-level contract).
 *
 * `ok:true, accepted:true, evidencePending:true` means the prompt WAS accepted
 * by the Harness but the acceptance evidence could not be persisted. It is not
 * a send failure: the caller must keep the finding issued with the same
 * `requestId`, must not set `retryPending`, must not prompt again, and only
 * retries the evidence write (same requestId/seq).
 *
 * @typedef {{
 *   ok: boolean,
 *   errors?: string[],
 *   error?: SubmitError,
 *   requestId?: string,
 *   requests?: SubmitRequestResult[],
 *   failedEntryId?: string,
 *   failedRequestId?: string,
 *   accepted?: true,
 *   acceptedAt?: number,
 *   submissionSeq?: number,
 *   evidencePending?: true,
 *   evidenceError?: SubmitError,
 *   unsentEntryIds?: string[],
 * }} SubmitResult
 */

/**
 * Build the submission service. It owns prompt composition and the remote queue
 * calls; persisting the resulting entries stays with the caller (the pane).
 *
 * Every method resolves to a result instead of throwing, so the pane can always
 * restore entries to `open` after a failed submit.
 *
 * @param {{
 *   remote: { session: { prompt: Function, state: Function, updateQueue: Function } },
 *   now?: () => number,
 *   uuid?: () => string,
 *   onPrepare?: (info: { requestId: string, sessionId: string, mode: string, entries: object[] }) => Promise<void>|void,
 *   onAccepted?: (info: {
 *     requestId: string, sessionId: string, mode: string, entries: object[],
 *     acceptedAt?: number, submissionSeq?: number,
 *   }) => Promise<void>|void,
 *   onDiscard?: (info: { requestId: string, sessionId: string, mode: string, entries: object[] }) => void,
 *   submissionSeqAllocator?: {
 *     allocate: (sessionId: string, task: (claim: { sessionId: string, seq: number }) => Promise<void>|void) => Promise<unknown>,
 *   },
 * }} deps `onAccepted` may be async: it is awaited before the next acceptance
 * in the same batch. When `submissionSeqAllocator` is configured (see
 * `createSubmissionSeqAllocator`), the accepted-evidence write runs inside the
 * allocator's per-session critical section and `onAccepted` receives the pair
 * `{ acceptedAt, submissionSeq }`. Without an allocator there is no sequence to
 * persist, so `onAccepted` is awaited as a plain notification.
 */
export function createSubmitService({
  remote,
  now = Date.now,
  uuid = () => globalThis.crypto.randomUUID(),
  onPrepare,
  onAccepted,
  onDiscard,
  submissionSeqAllocator,
}) {
  /** @returns {SubmitError} */
  function failure(error, code) {
    const message = error?.message ?? (error === undefined || error === null ? code : String(error))
    return { code, message }
  }

  /**
   * @param {string} sessionId
   * @param {string} text
   * @param {string} requestId
   * @returns {Promise<SubmitResult & { value?: object }>}
   */
  async function send(sessionId, text, requestId) {
    try {
      const result = await remote.session.prompt({
        requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }],
      })
      if (!result || result.ok === false || result.accepted === false || result.value?.accepted === false) {
        return { ok: false, error: result?.error ?? failure(undefined, 'submit/no-result'), requestId }
      }
      return { ...result, ok: true, requestId }
    } catch (error) {
      return { ok: false, error: failure(error, 'submit/send-failed'), requestId }
    }
  }

  /**
   * @param {unknown} error
   * @param {boolean} ranTask the allocator already ran the persistence task
   *   (its wrapper keeps the original failure in `cause`)
   * @returns {SubmitError} an onAccepted failure keeps its own code when it has one
   */
  function evidenceFailure(error, ranTask) {
    const source = ranTask && error?.cause !== undefined ? error.cause : error
    if (typeof source?.code === 'string' && source.code !== '') return failure(source, source.code)
    return failure(source, 'submit/evidence-failed')
  }

  /**
   * Record the acceptance evidence of an already-accepted prompt.
   *
   * The prompt is accepted at this point, so nothing here may turn into a send
   * failure: an onAccepted throw is reported as `evidencePending` on an
   * otherwise accepted result, keeps the same requestId (and the reserved seq
   * when one exists), and never calls onDiscard or the remote again.
   *
   * @param {{
   *   sessionId: string, requestId: string, mode: string, entries: object[], result: SubmitResult,
   * }} input
   * @returns {Promise<SubmitResult>}
   */
  async function acceptEvidence({ sessionId, requestId, mode, entries, result }) {
    if (typeof onAccepted !== 'function') return result
    const accepted = { ...result, ok: true, accepted: true, requestId }
    let seq
    let acceptedAt
    try {
      if (typeof submissionSeqAllocator?.allocate === 'function') {
        await submissionSeqAllocator.allocate(sessionId, async claim => {
          seq = typeof claim === 'number' ? claim : claim?.seq
          acceptedAt = now()
          await onAccepted({ requestId, sessionId, mode, entries, acceptedAt, submissionSeq: seq })
        })
      } else {
        await onAccepted({ requestId, sessionId, mode, entries })
      }
      if (seq === undefined) return accepted
      return { ...accepted, acceptedAt, submissionSeq: seq }
    } catch (error) {
      const pending = { ...accepted, evidencePending: true, evidenceError: evidenceFailure(error, seq !== undefined) }
      // `seq` is set only when this submission's own persistence task ran. A
      // blocked allocator throws before it runs, so no reservation belongs to
      // this request yet: reporting another submission's seq would corrupt the
      // session order. The caller retries this request's evidence once the
      // session unblocks (allocator retry/invalidate, then a fresh allocation).
      if (seq !== undefined) pending.submissionSeq = seq
      if (acceptedAt !== undefined) pending.acceptedAt = acceptedAt
      return pending
    }
  }

  return {
    /**
     * Query live queue items for a session.
     * @param {string} sessionId
     * @returns {Promise<{ ok: boolean, value: object[] }>}
     */
    async queryQueue(sessionId) {
      if (!sessionId || !remote?.session?.state) return { ok: false, value: [] }
      try {
        const res = await remote.session.state({ sessionId })
        const state = res?.value ?? res?.state ?? res
        return { ok: true, value: Array.isArray(state?.queue) ? state.queue : [] }
      } catch {
        return { ok: false, value: [] }
      }
    },

    /**
     * One queued prompt for the whole batch. All entries share this requestId.
     * @param {string} sessionId
     * @param {object[]} entries
     * @param {string} [requestId]
     * @param {string} [customPrompt]
     * @param {{ promptTail?: string, texts?: object, maxEntries?: number, maxBytes?: number, maxEntryBytes?: number }} [promptOptions]
     * @returns {Promise<SubmitResult>}
     */
    async submitCombined(sessionId, entries, requestId = uuid(), customPrompt, promptOptions) {
      const list = Array.isArray(entries) ? entries : []
      const options = { ...(promptOptions || {}), mode: 'combined' }
      const check = validateBatch(list, options)
      if (!check.ok) return { ok: false, errors: check.errors }
      const hasCustom = typeof customPrompt === 'string' && customPrompt.trim()
      // A hand-edited prompt is still a real prompt: it must respect the same
      // byte budget instead of bypassing validation.
      if (hasCustom) {
        const textCheck = validatePromptText(customPrompt.trim(), { maxBytes: options.maxBytes })
        if (!textCheck.ok) return { ok: false, errors: textCheck.errors }
      }
      const promptText = hasCustom
        ? customPrompt.trim()
        : composeCombinedPrompt(list, promptOptions)
      await onPrepare?.({ requestId, sessionId, mode: 'combined', entries: list })
      const result = await send(sessionId, promptText, requestId)
      if (!result.ok) {
        onDiscard?.({ requestId, sessionId, mode: 'combined', entries: list })
        return result
      }
      // One accepted prompt = one shared seq for the whole batch. Evidence
      // failure is not a send failure (see acceptEvidence).
      return acceptEvidence({ sessionId, requestId, mode: 'combined', entries: list, result })
    },

    /**
     * One queued prompt per entry, each with its own requestId.
     * @param {string} sessionId
     * @param {object[]} entries
     * @param {{ promptTail?: string, texts?: object, maxEntries?: number, maxBytes?: number, maxEntryBytes?: number }} [promptOptions]
     * @returns {Promise<SubmitResult>}
     */
    async submitSequential(sessionId, entries, promptOptions) {
      const list = Array.isArray(entries) ? entries : []
      // Each entry is its own queued prompt: validate per-message, not the sum.
      const options = { ...(promptOptions || {}), mode: 'sequential' }
      const check = validateBatch(list, options)
      if (!check.ok) return { ok: false, errors: check.errors }
      const requests = []
      const unsentEntryIds = []
      let evidenceFailureResult = null
      for (const entry of list) {
        // Once acceptance evidence of an accepted prompt cannot be persisted,
        // the session's seq allocation is blocked. Stop before sending more
        // prompts: their acceptance could never be attributed either, and a
        // prompt that was accepted must never be sent again.
        if (evidenceFailureResult) {
          unsentEntryIds.push(entry.id)
          continue
        }
        const requestId = entry.requestId ?? uuid()
        await onPrepare?.({ requestId, sessionId, mode: 'sequential', entries: [entry] })
        const result = await send(sessionId, composeSequentialPrompt(entry, promptOptions), requestId)
        if (!result.ok) {
          onDiscard?.({ requestId, sessionId, mode: 'sequential', entries: [entry] })
          return { ok: false, error: result.error, requests, failedEntryId: entry.id, failedRequestId: requestId }
        }
        // Each accepted request gets its own seq, allocated serially.
        const accepted = await acceptEvidence({ sessionId, requestId, mode: 'sequential', entries: [entry], result })
        const record = { entryId: entry.id, requestId }
        if (accepted.acceptedAt !== undefined) record.acceptedAt = accepted.acceptedAt
        if (accepted.submissionSeq !== undefined) record.submissionSeq = accepted.submissionSeq
        if (accepted.evidencePending) {
          record.evidencePending = true
          record.evidenceError = accepted.evidenceError
          evidenceFailureResult = accepted
        }
        requests.push(record)
      }
      if (!evidenceFailureResult) return { ok: true, requests }
      const pendingResult = {
        ok: true,
        accepted: true,
        evidencePending: true,
        evidenceError: evidenceFailureResult.evidenceError,
        requests,
      }
      if (unsentEntryIds.length > 0) pendingResult.unsentEntryIds = unsentEntryIds
      return pendingResult
    },

    /**
     * In-place modification for a queued prompt item.
     * Only QueueAction.edit is allowed: the queue belongs to the Harness and
     * submissions are never retracted. A failed edit is reported as a failure;
     * it must never fall back to QueueAction.remove or claim the item was
     * consumed by the model.
     *
     * @param {string} sessionId
     * @param {string} requestId
     * @param {string} newText
     * @returns {Promise<SubmitResult & { method?: 'edit', reason?: string, itemId?: string }>}
     */
    async editQueued(sessionId, requestId, newText) {
      if (!requestId) return { ok: false, reason: 'no-request' }
      try {
        const state = await remote.session.state({ sessionId })
        if (!state || state.ok === false) {
          return { ok: false, error: state?.error ?? failure(undefined, 'submit/state-failed') }
        }
        const queue = state?.value?.queue ?? state?.queue ?? []
        const item = (Array.isArray(queue) ? queue : []).find(item => item.rpcId === requestId)
        if (!item) return { ok: false, reason: 'not-queued' }

        // 1. Try in-place edit
        let editResult
        try {
          editResult = await remote.session.updateQueue({
            sessionId,
            itemId: item.id,
            action: { kind: 'edit', content: [{ type: 'text', text: newText }] },
          })
        } catch (err) {
          editResult = { ok: false, error: failure(err, 'submit/edit-failed') }
        }

        if (!editResult || editResult.ok === false) {
          return { ok: false, error: editResult?.error ?? failure(undefined, 'submit/edit-failed') }
        }

        return { ok: true, method: 'edit', itemId: item.id }
      } catch (error) {
        return { ok: false, error: failure(error, 'submit/edit-failed') }
      }
    },

    /**
     * Reconciles submission status when a prompt call fails or times out.
     * 1. Checks host queue for item with `item.rpcId === finding.requestId`.
     * 2. If not in queue, checks host events for message or turn events matching requestId.
     * 3. If evidence is found, marks submitted with dynamic HarnessTaskProjection.
     * 4. If neither queue nor events have evidence, keeps the submission fact, records lastSubmitError and retryPending: true (never rolls back).
     *
     * @param {string} sessionId
     * @param {{ requestId?: string }} finding
     * @param {any} [error]
     * @returns {Promise<{ submissionStatus: 'submitted'|'unsubmitted', harnessProjection?: 'queued'|'running'|'executed'|'unknown', reconciliationPending: boolean, retryPending: boolean, lastSubmitError?: string }>} The submission fact is never rolled back automatically: only a finding with no requestId can be unsubmitted.
     */
    async reconcileSubmission(sessionId, finding, error) {
      const requestId = finding?.requestId
      if (!requestId) {
        return {
          submissionStatus: 'unsubmitted',
          harnessProjection: 'unknown',
          reconciliationPending: false,
          retryPending: true,
          lastSubmitError: error?.message ?? (typeof error === 'string' ? error : 'submit/no-request-id'),
        }
      }

      // 1. Check queue
      try {
        const state = await remote.session.state({ sessionId })
        const queue = state?.value?.queue ?? state?.queue ?? []
        const queuedItem = (Array.isArray(queue) ? queue : []).find(it => it.rpcId === requestId)
        if (queuedItem) {
          return {
            submissionStatus: 'submitted',
            harnessProjection: 'queued',
            reconciliationPending: false,
            retryPending: false,
            lastSubmitError: undefined,
          }
        }
      } catch {
        // Continue to events check
      }

      // 2. Check events
      try {
        if (typeof remote.session?.events === 'function') {
          const address = { kind: 'session', sessionId }
          const res = await remote.session.events({ address, maxMessages: 50 })
          const page = res?.value ?? res
          const records = Array.isArray(page) ? page : Array.isArray(page?.records) ? page.records : []
          let foundEvent = null
          let hasTurnEnd = false
          let hasTurnStart = false

          for (const rec of records) {
            const ev = rec?.event ?? (rec?.type === 'event' ? rec.event : rec)
            if (!ev) continue
            const data = ev.data ?? {}
            const msg = data.message ?? data
            const rpcId = msg.source?.rpcId ?? msg.rpcId ?? msg.requestId ?? data.rpcId ?? data.requestId
            if (rpcId === requestId) {
              foundEvent = ev
            }
            if (ev.type === 'turn/end' && (foundEvent || rpcId === requestId)) {
              hasTurnEnd = true
            }
            if (ev.type === 'turn/start' && (foundEvent || rpcId === requestId)) {
              hasTurnStart = true
            }
          }

          if (foundEvent) {
            return {
              submissionStatus: 'submitted',
              harnessProjection: hasTurnEnd ? 'executed' : 'running',
              reconciliationPending: false,
              retryPending: false,
              lastSubmitError: undefined,
            }
          }
        }
      } catch {
        // Events query failed
      }

      // 3. No evidence in queue or events. The submission fact is monotonic:
      // never roll it back automatically. Keep the finding submitted/queued with
      // an error + retry flag so the user can retry with the same requestId.
      return {
        submissionStatus: 'submitted',
        harnessProjection: 'unknown',
        reconciliationPending: false,
        retryPending: true,
        lastSubmitError: error?.message ?? (typeof error === 'string' ? error : 'submit/send-failed'),
      }
    },

    /**
     * @param {object} entry
     * @returns {object} entry marked resolved (caller persists it)
     */
    resolve(entry) {
      return { ...entry, status: 'resolved', resolvedAt: now() }
    },

    /**
     * @param {object} entry
     * @returns {object} entry marked dismissed (caller persists it)
     */
    dismiss(entry) {
      return { ...entry, status: 'dismissed', resolvedAt: now() }
    },

    /**
     * Fork an existing finding into a fresh unsubmitted entry with lineage.
     * @param {object} entry
     * @returns {object} fresh forked finding
     */
    fork(entry) {
      return forkFinding(entry, { now, idGenerator: uuid })
    },
  }
}
