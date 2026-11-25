/** Conversation capture entry: one per finalized assistant message. */

import { PunchDeskLogoMono } from './icons.js'

const BUTTON_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 24,
  height: 24,
  padding: 0,
  border: 'none',
  borderRadius: 4,
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #d8dee9)',
  cursor: 'pointer',
  transition: 'all 0.15s ease',
}

/**
 * Register the capture button on the conversation surface. The entry hands a
 * message anchor payload to the session pane, which opens the right-side tab and
 * carries the anchor into the next finding.
 *
 * Implements Icon-Only button pattern strictly adhering to AGENTS.md Rule 8
 * and mockup design (size: 24x24, BookmarkSimple vector icon, native tooltip).
 * @param {object} ctx client plugin context
 * @param {{ h: Function, t: Function, NS: string, services: object }} deps
 * @returns {void}
 */
export function registerCaptureActions(ctx, { h, t, NS, services }) {
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'punch-desk-capture',
      order: 30,
      locale: NS,
    }, function CaptureAction({ messageId, sessionId }) {
      return h('button', {
        type: 'button',
        title: t('capture.add'),
        'aria-label': t('capture.add'),
        'data-punch-desk-capture': 'message',
        style: BUTTON_STYLE,
        onClick: () => services.openCapture(sessionId, { kind: 'message', messageId }),
      },
        PunchDeskLogoMono({ size: 14, h, color: 'var(--dsw-alias-button-primary-fill, #88c0d0)' }))
    }))
}
