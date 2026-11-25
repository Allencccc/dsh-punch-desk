/**
 * Per-session serial allocator for Finding acceptance evidence
 * (`acceptedAt` + `submissionSeq`).
 *
 * Contract (Group Turn Attribution plan Phase 2 / T-GTA-25):
 *
 * - `submissionSeq` is allocated only for an **accepted** prompt, as
 *   `persisted max + still-open reservations + 1`. There is no persisted
 *   counter of its own: the persisted max is read from the accepted findings.
 * - Each session owns an async critical section. The persistence task (the
 *   work that writes `acceptedAt/submissionSeq` and awaits the store) runs
 *   **inside** that section, so overlapping acceptances are serialized and a
 *   later acceptance can never overtake a slower earlier one.
 * - A reservation is never reused in this process. If the persistence task
 *   throws, the reservation is kept, the session is blocked, and every later
 *   `allocate` for that session rejects with `SubmissionSeqBlockedError` until
 *   `retry(sessionId)` succeeds or `invalidate(sessionId, seq)` explicitly
 *   releases the reservation. Both paths keep the sequence number above the
 *   failed one, so it is never handed out again.
 * - Reading the persisted max happens lazily, once per session, inside the
 *   critical section. A read failure consumes no sequence and does not block
 *   the session (the next allocation retries the read).
 *
 * Reservations are process-local by design: a crash or reload before the write
 * completes must not fabricate a persisted sequence. On the next start the
 * allocator reads the persisted max again and continues from there; the latest
 * group attribution can first fall back to PromptLog replay.
 */

/** @typedef {{ sessionId: string, seq: number }} SubmissionSeqClaim */

function describeError(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  return error?.message ? String(error.message) : String(error)
}

/** The session is blocked by an unpersisted reservation; the same seq stays reserved. */
export class SubmissionSeqBlockedError extends Error {
  /**
   * @param {string} sessionId
   * @param {number} seq
   * @param {unknown} cause
   */
  constructor(sessionId, seq, cause) {
    super(`submissionSeq reservation ${seq} for session "${sessionId}" is not persisted yet: ${describeError(cause)}`)
    this.name = 'SubmissionSeqBlockedError'
    this.code = 'submit/seq-blocked'
    this.sessionId = sessionId
    this.seq = seq
    this.cause = cause
  }
}

/** The persisted maximum could not be read; no sequence was consumed. */
export class SubmissionSeqReadError extends Error {
  /**
   * @param {string} sessionId
   * @param {unknown} cause
   */
  constructor(sessionId, cause) {
    super(`cannot read the persisted submissionSeq max for session "${sessionId}": ${describeError(cause)}`)
    this.name = 'SubmissionSeqReadError'
    this.code = 'submit/seq-unreadable'
    this.sessionId = sessionId
    this.cause = cause
  }
}

/** Invalidation was requested for a session/reservation that is not blocked. */
export class SubmissionSeqInvalidationError extends Error {
  /**
   * @param {string} sessionId
   * @param {number|undefined} seq
   * @param {string} reason
   */
  constructor(sessionId, seq, reason) {
    super(`cannot invalidate submissionSeq reservation for session "${sessionId}"${seq === undefined ? '' : ` (seq ${seq})`}: ${reason}`)
    this.name = 'SubmissionSeqInvalidationError'
    this.code = 'submit/seq-invalidation'
    this.sessionId = sessionId
    this.seq = seq
  }
}

/** `retry()` was called on a session with no failed reservation. */
export class SubmissionSeqStateError extends Error {
  /** @param {string} sessionId */
  constructor(sessionId) {
    super(`session "${sessionId}" has no failed submissionSeq reservation to retry`)
    this.name = 'SubmissionSeqStateError'
    this.code = 'submit/seq-no-failure'
    this.sessionId = sessionId
  }
}

/** @returns {number} a finite non-negative integer, or throws SubmissionSeqReadError */
function normalizePersistedMax(value, sessionId) {
  if (value === undefined || value === null || value === '') return 0
  let num
  try {
    num = typeof value === 'number' ? value : Number(value)
  } catch (error) {
    throw new SubmissionSeqReadError(sessionId, error)
  }
  if (!Number.isFinite(num) || num < 0) {
    throw new SubmissionSeqReadError(sessionId, new Error(`readMax resolved to ${String(value)}`))
  }
  return Math.floor(num)
}

/**
 * @param {{
 *   readMax: (sessionId: string) => number | Promise<number>,
 *   persist?: (claim: SubmissionSeqClaim) => unknown | Promise<unknown>,
 * }} deps
 */
export function createSubmissionSeqAllocator({ readMax, persist } = {}) {
  if (typeof readMax !== 'function') {
    throw new TypeError('createSubmissionSeqAllocator requires a readMax(sessionId) function')
  }
  if (persist !== undefined && typeof persist !== 'function') {
    throw new TypeError('createSubmissionSeqAllocator persist must be a function when provided')
  }

  /** @type {Map<string, {sessionId: string, chain: Promise<any>, loaded: boolean, persistedMax: number, highWater: number, pending: Map<number, Function>, failure: {seq: number, task: Function, error: unknown} | null}>} */
  const sessions = new Map()

  function stateFor(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {
        sessionId,
        chain: Promise.resolve(),
        loaded: false,
        persistedMax: 0,
        highWater: 0,
        pending: new Map(),
        failure: null,
      }
      sessions.set(sessionId, state)
    }
    return state
  }

  /** Run `work` strictly after the previous critical section of this session. */
  function enqueue(state, work) {
    const run = state.chain.then(() => work())
    // The chain must survive a rejected section, otherwise one failure would
    // silently drop every later allocation instead of blocking it explicitly.
    state.chain = run.then(() => undefined, () => undefined)
    return run
  }

  function assertSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new TypeError('sessionId must be a non-empty string')
    }
  }

  function invoke(sessionId, seq, task) {
    const claim = Object.freeze({ sessionId, seq })
    return task(claim)
  }

  return {
    /**
     * Reserve the next sequence for a session and run `task` with it inside the
     * session's critical section. The reservation is released only after
     * `task` resolves; if it rejects the reservation stays reserved and blocks
     * the session.
     *
     * @param {string} sessionId
     * @param {(claim: SubmissionSeqClaim) => unknown} [task] defaults to the
     *   allocator's `persist` hook
     * @returns {Promise<{ sessionId: string, seq: number, value: unknown }>}
     */
    async allocate(sessionId, task = persist) {
      assertSessionId(sessionId)
      if (typeof task !== 'function') {
        throw new TypeError('allocate(sessionId, task) needs a task(claim) function (or a persist hook)')
      }
      const state = stateFor(sessionId)
      return enqueue(state, async () => {
        if (state.failure) {
          throw new SubmissionSeqBlockedError(sessionId, state.failure.seq, state.failure.error)
        }
        if (!state.loaded) {
          let raw
          try {
            raw = await readMax(sessionId)
          } catch (error) {
            throw new SubmissionSeqReadError(sessionId, error)
          }
          state.persistedMax = Math.max(state.persistedMax, normalizePersistedMax(raw, sessionId))
          state.highWater = Math.max(state.highWater, state.persistedMax)
          state.loaded = true
        }
        const seq = Math.max(state.persistedMax, state.highWater, ...state.pending.keys()) + 1
        state.highWater = seq
        state.pending.set(seq, task)
        try {
          const value = await invoke(sessionId, seq, task)
          state.pending.delete(seq)
          return { sessionId, seq, value }
        } catch (error) {
          state.failure = { seq, task, error }
          throw new SubmissionSeqBlockedError(sessionId, seq, error)
        }
      })
    },

    /**
     * Re-run the persistence task of the blocked reservation with its original
     * sequence. Success unblocks the session; failure keeps the block (and the
     * reservation) intact.
     *
     * @param {string} sessionId
     * @returns {Promise<{ sessionId: string, seq: number, value: unknown, retried: true }>}
     */
    async retry(sessionId) {
      assertSessionId(sessionId)
      const state = stateFor(sessionId)
      return enqueue(state, async () => {
        const failure = state.failure
        if (!failure) throw new SubmissionSeqStateError(sessionId)
        try {
          const value = await invoke(sessionId, failure.seq, failure.task)
          state.pending.delete(failure.seq)
          state.failure = null
          return { sessionId, seq: failure.seq, value, retried: true }
        } catch (error) {
          state.failure = { seq: failure.seq, task: failure.task, error }
          throw new SubmissionSeqBlockedError(sessionId, failure.seq, error)
        }
      })
    },

    /**
     * Explicitly abandon a blocked reservation. The sequence is never reused
     * (the next allocation still starts above it); this only lifts the block.
     *
     * @param {string} sessionId
     * @param {number} [seq] when provided it must match the blocked reservation
     * @returns {Promise<{ sessionId: string, seq: number, invalidated: true }>}
     */
    async invalidate(sessionId, seq) {
      assertSessionId(sessionId)
      const state = stateFor(sessionId)
      return enqueue(state, async () => {
        const failure = state.failure
        if (!failure) {
          throw new SubmissionSeqInvalidationError(sessionId, seq, 'no blocked reservation to invalidate')
        }
        if (seq !== undefined && seq !== failure.seq) {
          throw new SubmissionSeqInvalidationError(sessionId, seq, `the blocked reservation is ${failure.seq}`)
        }
        state.pending.delete(failure.seq)
        state.failure = null
        return { sessionId, seq: failure.seq, invalidated: true }
      })
    },

    /** @param {string} sessionId */
    isBlocked(sessionId) {
      return Boolean(sessions.get(sessionId)?.failure)
    },

    /** @param {string} sessionId @returns {number|null} */
    blockedSeq(sessionId) {
      return sessions.get(sessionId)?.failure?.seq ?? null
    },

    /** @param {string} sessionId @returns {unknown|null} */
    lastError(sessionId) {
      return sessions.get(sessionId)?.failure?.error ?? null
    },

    /** @param {string} sessionId @returns {number[]} */
    pendingSeqs(sessionId) {
      return [...(sessions.get(sessionId)?.pending.keys() ?? [])]
    },

    /** @param {string} sessionId */
    snapshot(sessionId) {
      const state = sessions.get(sessionId)
      if (!state) {
        return {
          sessionId, loaded: false, persistedMax: 0, highWater: 0, pendingSeqs: [], blockedSeq: null,
        }
      }
      return {
        sessionId,
        loaded: state.loaded,
        persistedMax: state.persistedMax,
        highWater: state.highWater,
        pendingSeqs: [...state.pending.keys()],
        blockedSeq: state.failure?.seq ?? null,
      }
    },

    /**
     * Drop in-memory reservations. Only for teardown/tests: never call it while
     * a reservation is still unpersisted, or that sequence could be reissued.
     * @param {string} [sessionId] omit to clear every session
     */
    reset(sessionId) {
      if (sessionId === undefined) sessions.clear()
      else sessions.delete(sessionId)
    },
  }
}
