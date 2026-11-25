/**
 * Composer bridge: the only place allowed to touch the session composer.
 *
 * The Desk is a root-scope panel and gets no `inputActions`; a session-scoped
 * `conversation.input.dock` entry does. This bridge lives in that dock, consumes
 * the one-shot `handoff.<sessionId>` parked by `startFromDraft`, seeds the input
 * box, and clears the handoff. It then watches the session's event stream for
 * the first gated `user/message` and marks the draft `started`.
 *
 * The bridge renders nothing. If the dock does not expose `inputActions` (an
 * older host), it logs one warning and leaves the handoff in place so a later
 * mount can still apply it.
 */

import { DRAFTS_WORKSPACE_KEY } from '../../domain/desk.js'
import { findPrefilledDraft, gatedUserMessageId, markDraftStarted } from '../platform/session-start.js'

/** Dock order: after the todo (0) and queue (20) docks. */
const DOCK_ORDER = 30

/** Console warning emitted at most once per mounted bridge. */
const WARN_NO_ACTIONS = 'conversation.input.dock has no inputActions; skipping draft handoff'

/**
 * @param {{ h: Function, React: object, services: object }} deps
 * @returns {Function} the ComposerBridge React component
 */
export function createComposerBridge({ h, React, services }) {
  // `h` is part of the shared UI factory contract, but this bridge renders
  // nothing: its whole job happens in layout effects.
  void h

  return function ComposerBridge({ sessionId, inputActions }) {
    const consumedFor = React.useRef(null)
    const warned = React.useRef(false)
    const canSetDraft = inputActions !== null && typeof inputActions === 'object'
      && typeof inputActions.setDraft === 'function'

    // Consume the handoff exactly once per session. A missing handoff releases
    // the latch (the read is retried on store writes and on the next mount) so
    // a handoff parked after `connectWorkspace` reused an already-open session
    // still applies. The latch is set only after `setDraft` ran, so a cleanup
    // that aborts the read can never burn the one-shot opportunity.
    React.useLayoutEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      if (!canSetDraft) {
        if (!warned.current) {
          warned.current = true
          console.warn(`[punch-desk] ${WARN_NO_ACTIONS}`)
        }
        // The handoff is deliberately kept: a mount with the real props can
        // still consume it later.
        return undefined
      }
      if (consumedFor.current === sessionId) return undefined
      const store = services.store
      if (!store || typeof store.getHandoff !== 'function') return undefined

      let alive = true
      let reading = false
      let pendingRetry = false
      /** @type {() => void} */
      let unsubscribe = () => {}

      /** Stop retrying; safe to call more than once. */
      const stopRetry = () => {
        unsubscribe()
        unsubscribe = () => {}
      }

      /** Read and apply the parked handoff; called on mount and store writes. */
      const consume = async () => {
        if (!alive || consumedFor.current === sessionId) return
        if (reading) {
          // A store write landed while a read was in flight; read again once
          // it finishes instead of dropping the notification.
          pendingRetry = true
          return
        }
        reading = true
        try {
          const handoff = await store.getHandoff(sessionId)
          if (!alive) return
          if (handoff === null || typeof handoff !== 'object') {
            // Nothing parked yet (the host may have reused an open blank
            // session). Keep the latch clear so a later handoff can apply.
            if (consumedFor.current === sessionId) consumedFor.current = null
            return
          }
          if (typeof handoff.body !== 'string' || handoff.body.trim() === '') {
            // An empty handoff can never be applied; drop it so a stale entry
            // does not shadow a later start for this session.
            if (typeof store.deleteHandoff === 'function') await store.deleteHandoff(sessionId)
            return
          }
          // Latch before any await so a concurrent store notification cannot
          // apply the same body twice.
          consumedFor.current = sessionId
          stopRetry()
          inputActions.setDraft(handoff.body)
          if (typeof store.deleteHandoff === 'function') await store.deleteHandoff(sessionId)
        } catch (error) {
          console.warn('[punch-desk] failed to apply the draft handoff', error)
        } finally {
          reading = false
          if (pendingRetry) {
            pendingRetry = false
            void consume()
          }
        }
      }

      if (typeof store.subscribe === 'function') {
        unsubscribe = store.subscribe(() => { void consume() })
      }
      void consume()

      return () => {
        alive = false
        stopRetry()
        // A mount aborted before applying must not consume the handoff: a
        // later mount still needs to see the parked body.
        if (consumedFor.current === sessionId) consumedFor.current = null
      }
    }, [sessionId, canSetDraft])

    // Mark the draft `started` on the first real user prompt. The draft is read
    // from the store (never a ref) so this survives a remount, and a store
    // subscription also catches a handoff that lands after this session was
    // already open (connectWorkspace may reuse an existing blank session).
    React.useLayoutEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return undefined
      const store = services.store
      const remote = services.remote
      if (!store || typeof store.listEntries !== 'function' || typeof store.putEntry !== 'function') return undefined
      if (!remote?.session || typeof remote.session.observeEvent !== 'function') return undefined

      let alive = true
      let stopped = false
      /** @type {AbortController|null} */
      let controller = null
      let checking = false
      let pendingCheck = false
      /** @type {() => void} */
      let unsubscribe = () => {}

      /** Stop watching; safe to call more than once. */
      const stop = () => {
        stopped = true
        unsubscribe()
        controller?.abort()
        controller = null
      }

      /** Start observing once a prefilled draft for this session exists. */
      const watch = async () => {
        if (!alive || stopped || controller !== null) return
        if (checking) {
          // A store write landed while a read was in flight; re-check once it
          // finishes instead of dropping the notification.
          pendingCheck = true
          return
        }
        checking = true
        let draft = null
        try {
          draft = findPrefilledDraft(await store.listEntries(DRAFTS_WORKSPACE_KEY), sessionId)
        } catch {
          draft = null
        }
        checking = false
        if (!alive || stopped) return
        if (draft === null) {
          if (pendingCheck) {
            pendingCheck = false
            void watch()
          }
          return
        }
        if (controller !== null) return

        const local = new AbortController()
        controller = local
        try {
          for await (const frame of remote.session.observeEvent(
            { address: { kind: 'session', sessionId } },
            local.signal,
          )) {
            if (!alive || stopped) return
            const messageId = gatedUserMessageId(frame?.event)
            if (messageId === null) continue
            // Re-read the draft before writing: the user may have edited it or
            // cancelled the prefill while this observer was waiting. Only a
            // still-prefilled draft for this session may become started.
            let current = draft
            try {
              current = findPrefilledDraft(await store.listEntries(DRAFTS_WORKSPACE_KEY), sessionId) ?? null
            } catch {
              current = draft
            }
            if (current === null) {
              stop()
              return
            }
            try {
              await store.putEntry(markDraftStarted(current, messageId))
            } catch (error) {
              // A later mount can retry from the still-prefilled draft and the
              // next gated user message.
              console.warn('[punch-desk] failed to mark the draft started', error)
            }
            stop()
            return
          }
        } catch (error) {
          if (!local.signal.aborted) console.warn('[punch-desk] draft start observation stopped', error)
        } finally {
          if (controller === local) controller = null
        }
      }

      if (typeof store.subscribe === 'function') unsubscribe = store.subscribe(() => { void watch() })
      void watch()

      return () => {
        alive = false
        stop()
      }
    }, [sessionId])

    return null
  }
}

/**
 * Register the bridge in the session-scoped composer dock.
 * @param {object} ctx client plugin context
 * @param {{ NS: string, ComposerBridge: Function }} deps
 * @returns {void}
 */
export function registerComposerBridge(ctx, { NS, ComposerBridge }) {
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'punch-desk-bridge',
    order: DOCK_ORDER,
    locale: NS,
  }, ComposerBridge))
}
