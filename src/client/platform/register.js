/** Right-side session tab type id; reused as the conversation-view id in fallback mode. */
export const TAB_ID = 'dsh-punch-desk'
/** Main-panel seat key for the desk placeholder. */
export const PANEL_ID = 'dsh-punch-desk'
/** Conversation-view id the pane registers under when the tab path is unavailable. */
export const CONVERSATION_VIEW_ID = 'conversation'
/** Dev switch: force the conversation.view fallback even when the right sidebar exists. */
export const FORCE_FALLBACK = false

/**
 * Open the punch desk pane for the active session.
 * Prefers the right sidebar tab, then the conversation view that
 * `registerSeats` uses as its fallback. The main panel is only the Desk
 * placeholder, so selecting it would never show the pane.
 * @param {object} ctx client plugin context
 * @returns {boolean} whether a pane was opened
 */
export function openSessionPane(ctx) {
  const tabs = FORCE_FALLBACK ? undefined : ctx.get?.('sidebarRightTabs')
  const right = FORCE_FALLBACK ? undefined : ctx.get?.('sidebarRight')
  if (tabs && typeof tabs.register === 'function' && right && typeof right.openTab === 'function') {
    right.openTab(TAB_ID)
    return true
  }
  const layout = ctx.get?.('layout')
  if (layout && typeof layout.selectPanel === 'function') {
    layout.selectPanel(CONVERSATION_VIEW_ID)
    return true
  }
  return false
}

/**
 * Register the right-side tab (or the conversation.view fallback), the main
 * Desk panel, and the left-side panellist entry.
 *
 * The right-side services are mounted by the Web shell and are not guaranteed
 * to exist at plugin apply time. Reading them with `ctx.get` once raced that
 * ordering and silently skipped the tab (the panellist still appeared). Wait
 * for the services with `ctx.inject`; keep a bounded fallback for hosts that
 * genuinely have no right sidebar.
 * @param {object} ctx client plugin context
 * @param {{h: Function, t: Function, NS: string, SessionPane: Function, DeskPage: Function, PanelIcon?: Function, DeskIcon?: Function, DrawerIcon?: Function}} seats
 * @returns {object|undefined} the sidebarRight service when available at call time
 */
export function registerSeats(ctx, { h, t, NS, SessionPane, DeskPage, PanelIcon, DeskIcon, DrawerIcon }) {
  let tabSettled = false
  let fallbackRegistered = false

  const EffectiveDeskIcon = DeskIcon || PanelIcon
  const EffectiveDrawerIcon = DrawerIcon || PanelIcon

  const registerFallbackView = (scope) => {
    if (fallbackRegistered) return
    fallbackRegistered = true
    scope.slots.inject('conversation.view', () =>
      scope.slots.register({ name: 'conversation.view', id: TAB_ID, order: 40, label: () => t('tab.title'), locale: NS }, SessionPane))
  }

  const fallbackTimer = setTimeout(() => {
    if (tabSettled) return
    tabSettled = true
    registerFallbackView(ctx)
  }, 2500)
  ctx.effect(() => () => clearTimeout(fallbackTimer), 'punch-desk: fallback timer')

  if (FORCE_FALLBACK) {
    tabSettled = true
    clearTimeout(fallbackTimer)
    registerFallbackView(ctx)
  } else {
    ctx.inject(['sidebarRightTabs', 'sidebarRight'], (scope) => {
      if (tabSettled) return
      const tabs = scope.get?.('sidebarRightTabs')
      if (!tabs || typeof tabs.register !== 'function') return
      tabSettled = true
      clearTimeout(fallbackTimer)
      scope.effect(() => tabs.register({
        id: TAB_ID,
        kind: TAB_ID,
        title: () => t('tab.title'),
        icon: EffectiveDrawerIcon,
        guide: [{
          id: 'open',
          order: 70,
          title: () => t('tab.title'),
          description: () => t('tab.description'),
          icon: EffectiveDrawerIcon,
        }],
        keepMounted: true,
      }), 'punch-desk: tab type')

      scope.slots.inject('sidebar.right.pane.tab', () =>
        scope.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, SessionPane))
      scope.slots.inject('sidebar.right.pane.tab.title', () =>
        scope.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, () =>
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
            h(EffectiveDrawerIcon, { size: 14 }),
            h('span', null, t('tab.title')))))
    })
  }

  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, DeskPage))
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      order: 7,
      label: () => t('desk.title'),
      icon: EffectiveDeskIcon,
      locale: NS,
    }, EffectiveDeskIcon))

  return FORCE_FALLBACK ? undefined : ctx.get?.('sidebarRight')
}
