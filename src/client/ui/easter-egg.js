/**
 * Small delight for the session composer: saving a finding whose body contains
 * the `[AC]` marker makes the composer border flash a rainbow for a few seconds.
 * Plugin-side only (no host DOM), nothing persisted — reloading starts unarmed.
 */

/** The marker that arms the glow. */
export const NEON_MARK = '[AC]'

/** Class name added to the composer while the glow window is open. */
export const NEON_CLASS = 'pd-neon'

/** How long the glow stays on after a successful save. */
export const NEON_DURATION_MS = 9000

/**
 * @param {unknown} text
 * @returns {boolean} true when the saved body carries the marker.
 */
export function hasNeonMark(text) {
  return typeof text === 'string' && text.includes(NEON_MARK)
}

/**
 * Arm/expire signal shared by neon-capable surfaces.
 * @param {{durationMs?: number, now?: () => number}} [options]
 */
export function createNeonSignal({ durationMs = NEON_DURATION_MS, now = () => Date.now() } = {}) {
  let armedAt = null
  const listeners = new Set()

  const notify = () => {
    for (const listener of listeners) {
      try {
        listener(isArmed())
      } catch {
        // A listener must never break the save path.
      }
    }
  }

  const isArmed = () => armedAt !== null && now() - armedAt < durationMs

  return {
    arm() {
      armedAt = now()
      notify()
    },
    isArmed,
    remaining() {
      if (!isArmed()) return 0
      return Math.max(0, durationMs - (now() - armedAt))
    },
    clear() {
      if (armedAt === null) return
      const wasArmed = isArmed()
      armedAt = null
      if (wasArmed) notify()
    },
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Shared signal used by the real UI. */
export const neonSignal = createNeonSignal()
