/**
 * Enhanced Text Selection Quote Surface
 *
 * Safely decorates DSH's native [data-text-interaction-surface] bubble
 * by adding a companion [手账引用 / Quote to Desk] button beside the native [引用文本] button.
 *
 * Strictly avoids colliding with @deepseek-ai/dsh-message-quotes slot registration,
 * and leaves surface visibility controls intact to guarantee clean lifecycle repeat.
 */

function findSelectionContext() {
  if (typeof window === 'undefined') return {}
  try {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return {}
    const range = sel.getRangeAt(0)
    let node = range.commonAncestorContainer
    if (node && node.nodeType === 3) node = node.parentNode

    let turn = undefined
    let messageId = undefined

    let cur = node
    while (cur && cur !== document.body) {
      if (!messageId) {
        const mid = cur.getAttribute?.('data-message-id') || cur.dataset?.messageId
        if (mid) messageId = mid
      }
      if (turn === undefined) {
        const t = cur.getAttribute?.('data-chat-turn') || cur.dataset?.chatTurn
        if (t !== undefined && t !== null) {
          const num = parseInt(t, 10)
          if (!isNaN(num)) turn = num
        }
      }
      cur = cur.parentElement
    }
    return { turn, messageId }
  } catch {
    return {}
  }
}

export function registerQuoteInteraction(ctx, { h, t, NS, services }) {
  if (typeof document === 'undefined') return

  const tryEnhanceSurface = () => {
    try {
      const surface = document.querySelector('[data-text-interaction-surface]')
      if (!surface) return

      const isHidden = surface.getAttribute('aria-hidden') === 'true' || surface.style.visibility === 'hidden'
      const existingDeskBtn = surface.querySelector('[data-punch-desk-quote]')

      if (isHidden) {
        if (existingDeskBtn) {
          existingDeskBtn.remove()
        }
        return
      }

      if (existingDeskBtn) return

      const nativeBtn = surface.querySelector('button:not([data-punch-desk-quote])')
      if (!nativeBtn) return

      surface.style.display = 'inline-flex'
      surface.style.alignItems = 'center'
      surface.style.gap = '4px'

      const deskBtn = document.createElement('button')
      deskBtn.type = 'button'
      deskBtn.setAttribute('data-punch-desk-quote', 'true')
      deskBtn.className = nativeBtn.className || ''
      deskBtn.title = t('quote.deskTitle')
      deskBtn.style.display = 'inline-flex'
      deskBtn.style.alignItems = 'center'
      deskBtn.style.gap = '4px'
      deskBtn.style.fontWeight = '600'
      deskBtn.style.color = 'var(--dsw-alias-button-primary-fill, #88c0d0)'
      deskBtn.innerHTML = `
        <svg viewBox="0 0 256 256" width="13" height="13" fill="currentColor" style="vertical-align: middle">
          <path d="M192 24H64a16 16 0 0 0-16 16v184a8 8 0 0 0 12.8 6.4L128 178.7l67.2 47.7A8 8 0 0 0 208 224V40a16 16 0 0 0-16-16Z" />
        </svg>
        <span>${t('quote.desk')}</span>
      `

      deskBtn.onpointerdown = (e) => {
        e.preventDefault()
        e.stopPropagation()
      }

      deskBtn.onclick = (e) => {
        e.preventDefault()
        e.stopPropagation()

        const sel = window.getSelection()
        const text = sel ? sel.toString().trim() : ''
        const { turn, messageId } = findSelectionContext()
        const sid = typeof services.getActiveSessionId === 'function' ? services.getActiveSessionId() : undefined

        if (text && sid && services?.openCapture) {
          services.openCapture(sid, {
            kind: 'quote',
            text,
            turn,
            messageId,
          })
        }

        deskBtn.remove()
        sel?.removeAllRanges()
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }

      surface.appendChild(deskBtn)
    } catch {
      // safe fallback
    }
  }

  const observer = new MutationObserver(() => {
    tryEnhanceSurface()
  })

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-hidden', 'class', 'style'],
  })

  const handleSelectionChange = () => {
    setTimeout(tryEnhanceSurface, 20)
  }
  document.addEventListener('selectionchange', handleSelectionChange)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      observer.disconnect()
      document.removeEventListener('selectionchange', handleSelectionChange)
    }, 'punch-desk: quote interaction observer')
  }
}
