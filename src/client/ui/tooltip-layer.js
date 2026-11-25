/**
 * Self-drawn hover tooltips.
 *
 * The host webview swallows or delays native `title` tooltips, so the plugin
 * draws its own. Two rules keep the screen quiet:
 *
 * - `title` is **not** a visual tooltip. It is downgraded to `aria-label` at the
 *   single hyperscript boundary, so screen readers keep the label but hovering a
 *   plain action button no longer pops a floating div.
 * - Only information that cannot be read from the UI opts in with `tip`: full
 *   commit hash / branch, why something is locked, what an irreversible action
 *   will do, capacity and counter semantics, truncated content. Action names
 *   (expand / edit / delete / submit / …) stay silent.
 *
 * `installTooltipLayer()` mounts one fixed card on `document.body` driven by
 * delegated pointer/focus listeners; it is inert and also works inside modals.
 */

export const TIP_ATTR = 'data-pd-tip'
const LAYER_ID = 'punch-desk-tooltip-layer'
const VIEWPORT_MARGIN = 6

/** Components that forward title/tip to their DOM node opt in explicitly. */
export function markTipHost(component) {
  if (component && typeof component === 'function') component.__pdTipHost = true
  return component
}

function isTipHost(type) {
  return typeof type === 'string' || Boolean(type && type.__pdTipHost)
}

/**
 * Convert tooltip props at the hyperscript boundary.
 *
 * @param {(type: any, props: any, ...children: any[]) => any} h
 * @returns {(type: any, props: any, ...children: any[]) => any}
 */
export function createTipH(h) {
  return function tipH(type, props, ...children) {
    if (!props || !isTipHost(type)) return h(type, props, ...children)
    const hasTip = typeof props.tip === 'string' && props.tip.trim() !== ''
    const hasTitle = typeof props.title === 'string' && props.title.trim() !== ''
    if (!hasTip && !hasTitle) return h(type, props, ...children)
    const { tip, title, ...rest } = props
    const next = { ...rest }
    if (hasTip) {
      next[TIP_ATTR] = tip
      if (!next['aria-label']) next['aria-label'] = tip
    }
    if (hasTitle) {
      // Never rely on the host's native tooltip; keep the text for a11y only.
      if (!next['aria-label']) next['aria-label'] = title
    }
    return h(type, next, ...children)
  }
}

/**
 * Place the tooltip above its anchor, flipping below when the viewport has no
 * room, and clamp it inside the horizontal margins. Pure so it can be tested
 * without a DOM.
 *
 * @param {{left:number,top:number,width:number,height:number}} anchor
 * @param {{width:number,height:number}} viewport
 * @param {{width:number,height:number}} tip
 * @returns {{left:number, top:number, placement:'top'|'bottom'}}
 */
export function computeTipPosition(anchor, viewport, tip, margin = VIEWPORT_MARGIN) {
  const anchorCenter = anchor.left + anchor.width / 2
  const rawLeft = anchorCenter - tip.width / 2
  const maxLeft = Math.max(margin, viewport.width - tip.width - margin)
  const left = Math.min(Math.max(rawLeft, margin), maxLeft)
  const above = anchor.top - tip.height - margin
  const placement = above >= margin ? 'top' : 'bottom'
  const top = placement === 'top'
    ? above
    : Math.min(anchor.top + anchor.height + margin, Math.max(margin, viewport.height - tip.height - margin))
  return { left, top, placement }
}

/**
 * Mount the single tooltip card. Safe to call from every `apply` while the
 * module is shared between slots: the id check keeps one card per document.
 *
 * @param {Document} [doc]
 * @returns {HTMLElement|null}
 */
export function installTooltipLayer(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || !doc.body || doc.getElementById(LAYER_ID)) return null
  const layer = doc.createElement('div')
  layer.id = LAYER_ID
  layer.setAttribute('role', 'tooltip')
  // Flat card: no drop shadow (matches the capacity-notice decision), hairline
  // border + theme surface only.
  layer.style.cssText = [
    'position:fixed',
    'left:0',
    'top:0',
    'z-index:2147483000',
    'display:none',
    'max-width:280px',
    'padding:5px 8px',
    'border-radius:6px',
    'background:var(--pd-bg-floating, var(--dsw-alias-bg-layer-1, #2e3440))',
    'border:1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #4c566a))',
    'color:var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
    'font-size:10px',
    'line-height:1.6',
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
    'pointer-events:none',
  ].join(';')
  doc.body.appendChild(layer)

  let current = null
  const viewport = () => ({
    width: doc.documentElement?.clientWidth || doc.body.clientWidth || 0,
    height: doc.documentElement?.clientHeight || doc.body.clientHeight || 0,
  })
  const hide = () => {
    current = null
    layer.style.display = 'none'
    layer.textContent = ''
  }
  const show = (anchor) => {
    const text = anchor.getAttribute(TIP_ATTR)
    if (!text) return hide()
    current = anchor
    layer.textContent = text
    layer.style.display = 'block'
    const rect = anchor.getBoundingClientRect()
    const tipRect = layer.getBoundingClientRect()
    const pos = computeTipPosition(rect, viewport(), tipRect)
    layer.style.left = pos.left + 'px'
    layer.style.top = pos.top + 'px'
  }
  const closestTip = (node) => (node && typeof node.closest === 'function' ? node.closest('[' + TIP_ATTR + ']') : null)

  doc.addEventListener('mouseover', (event) => {
    const anchor = closestTip(event.target)
    if (anchor && anchor !== current) show(anchor)
  })
  doc.addEventListener('mouseout', (event) => {
    const anchor = closestTip(event.target)
    if (!anchor) return
    const next = event.relatedTarget
    if (next && anchor.contains(next)) return
    hide()
  })
  doc.addEventListener('focusin', (event) => {
    const anchor = closestTip(event.target)
    if (anchor) show(anchor)
  })
  doc.addEventListener('focusout', (event) => {
    if (closestTip(event.target)) hide()
  })
  doc.addEventListener('scroll', hide, true)
  doc.addEventListener('click', hide, true)
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', hide)
  }
  return layer
}
