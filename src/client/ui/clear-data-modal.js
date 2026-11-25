/**
 * Shared "clear workspace data" modal (P1-8 dedupe).
 *
 * Desk and Session Pane used to carry two ~60%-identical copies of this dialog.
 * This module is the single renderer: callers own the state (clearOptions /
 * clearing / notice) and the actual destructive execution.
 */
import { NORD, nordTint } from './nord.js'

const CATEGORIES = [
  { key: 'clearFindings', labelKey: 'clear.catFindings', descKey: 'clear.catFindingsDesc' },
  { key: 'clearGroups', labelKey: 'clear.catGroups', descKey: 'clear.catGroupsDesc' },
  { key: 'clearPromptLogs', labelKey: 'clear.catPromptLogs', descKey: 'clear.catPromptLogsDesc' },
  { key: 'clearDrafts', labelKey: 'clear.catDrafts', descKey: 'clear.catDraftsDesc' },
]

const CARD_STYLE = {
  background: 'var(--pd-bg-floating, var(--dsw-alias-bg-layer-1, #2e3440))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1)))',
  borderRadius: 12,
  boxShadow: '0 16px 36px ' + nordTint(NORD.nord0, 0.45),
  width: '100%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
}

const CATEGORY_BOX_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: 'var(--pd-bg-element, rgba(0, 0, 0, 0.12))',
  padding: 10,
  borderRadius: 8,
  border: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.05)))',
}

const LABEL_STYLE = { display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }
const STACK_STYLE = { display: 'flex', flexDirection: 'column' }

/** @param {{ h: Function, t: (key: string) => string, Button: Function, Trash: Function, X: Function }} deps */
export function createClearDataModal({ h, t, Button, Trash, X }) {
  return function renderClearDataModal({
    titleSuffix = null,
    scrim = 'fixed',
    maxWidth = 440,
    compact = false,
    clearOptions,
    setClearOptions,
    clearing = false,
    notice = null,
    onClose,
    onConfirm,
  }) {
    const headerPad = compact ? '12px 14px' : '12px 16px'
    const bodyPad = compact ? '12px 14px' : '14px 16px'
    const footerPad = compact ? '10px 14px' : '10px 16px'
    const box = (checked, disabled, onToggle) => h('input', {
      type: 'checkbox',
      checked,
      disabled,
      onChange: e => onToggle(Boolean(e.target.checked)),
      style: { marginTop: 2 },
    })
    return h('div', {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': t('clear.modalTitle'),
      onClick: e => { if (e.target === e.currentTarget && !clearing) onClose() },
      style: {
        position: scrim === 'absolute' ? 'absolute' : 'fixed',
        inset: 0,
        background: nordTint(NORD.nord0, 0.55),
        backdropFilter: 'blur(3px)',
        zIndex: scrim === 'absolute' ? 80 : 999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: compact ? 12 : 16,
      },
    },
      h('div', { style: { ...CARD_STYLE, maxWidth } },
        // Header
        h('div', {
          style: {
            padding: headerPad,
            borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08)))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
            h(Trash, { size: 16, color: 'var(--dsw-alias-state-danger-primary, #bf616a)' }),
            h('span', { style: { fontSize: 13, fontWeight: 700, color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))' } },
              titleSuffix ? t('clear.modalTitle') + ' · ' + titleSuffix : t('clear.modalTitle'))),
          h('button', {
            type: 'button',
            'aria-label': t('clear.cancelBtn'),
            disabled: clearing,
            onClick: onClose,
            style: {
              background: 'none',
              border: 'none',
              color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
              cursor: clearing ? 'not-allowed' : 'pointer',
              fontSize: 14,
              padding: '4px 6px',
              lineHeight: 1,
            },
          }, h(X, { size: 14 }))),

        // Notice
        notice
          ? h('div', {
              role: 'alert',
              style: {
                padding: compact ? '6px 14px' : '6px 16px',
                fontSize: 11,
                background: nordTint(NORD.nord11, 0.15),
                color: NORD.nord11,
                borderBottom: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.05)))',
              },
            }, notice.text)
          : null,

        // Body
        h('div', {
          style: {
            padding: bodyPad,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            maxHeight: '65vh',
            overflowY: 'auto',
          },
        },
          h('div', {
            style: {
              fontSize: 11,
              color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))',
              lineHeight: 1.5,
            },
          }, t('clear.modalDesc')),
          h('div', { style: CATEGORY_BOX_STYLE },
            CATEGORIES.map(cat => h('label', { key: cat.key, style: LABEL_STYLE },
              box(clearOptions[cat.key], clearing, next => setClearOptions(prev => ({ ...prev, [cat.key]: next }))),
              h('div', { style: STACK_STYLE },
                h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #eceff4))' } }, t(cat.labelKey)),
                h('span', { style: { fontSize: 10, color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' } }, t(cat.descKey)))))),
          // Pinned-asset safety switch
          h('div', {
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 8,
              background: nordTint(NORD.nord14, 0.12),
              border: '1px solid ' + nordTint(NORD.nord14, 0.3),
            },
          },
            h('label', { style: { ...LABEL_STYLE, width: '100%' } },
              box(clearOptions.preservePinned, clearing, next => setClearOptions(prev => ({ ...prev, preservePinned: next }))),
              h('div', { style: STACK_STYLE },
                h('span', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-state-success-primary, #a3be8c)' } }, t('clear.preservePinned')),
                h('span', { style: { fontSize: 10, color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #d8dee9))' } }, t('clear.preservePinnedDesc'))))),

        // Footer
        h('div', {
          style: {
            padding: footerPad,
            borderTop: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08)))',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 8,
          },
        },
          h(Button, {
            variant: 'ghost',
            disabled: clearing,
            onClick: onClose,
            style: { padding: '4px 10px', fontSize: 11 },
          }, t('clear.cancelBtn')),
          h(Button, {
            variant: 'danger',
            disabled: clearing,
            onClick: onConfirm,
            style: {
              padding: '4px 12px',
              fontSize: 11,
              fontWeight: 600,
              background: 'var(--dsw-alias-state-danger-primary, #bf616a)',
              color: '#ffffff',
              border: 'none',
            },
          }, clearing ? t('clear.clearing') : t('clear.confirmBtn'))))))
  }
}

export const CLEAR_DATA_CATEGORIES = CATEGORIES.map(cat => cat.key)