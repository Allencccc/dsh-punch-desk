/** Draft editor: create, edit, save, delete, and switch status for global drafts. */

import {
  GLOBAL_DRAFT_VISIBILITY, WORKSPACE_DRAFT_VISIBILITY,
  draftStatusOptions, draftVisibility, isDeleteArmed, saveDraftEntry,
} from '../../domain/desk.js'
import { validateEntry } from '../../domain/entries.js'
import { SPEC_CANVAS_TEMPLATE } from '../../domain/desk-canvas.js'
import { createBits } from './bits.js'

/** Locale keys for a draft status label. */
const STATUS_LABEL_KEY = {
  idea: 'draft.status.idea',
  ready: 'draft.status.ready',
  archived: 'draft.status.archived',
  prefilled: 'draft.status.prefilled',
  started: 'draft.status.started',
}

/** Badge tone for a draft status. @type {Record<string, import('./bits.js').BadgeTone>} */
export const DRAFT_STATUS_TONE = {
  idea: 'neutral',
  ready: 'success',
  archived: 'neutral',
  prefilled: 'info',
  started: 'info',
}

/**
 * Localized draft status label. Unknown statuses render verbatim so an older
 * record never becomes blank.
 * @param {string|undefined} status
 * @param {Function} t
 * @returns {string}
 */
export function draftStatusText(status, t) {
  if (typeof status !== 'string' || status === '') return ''
  const key = STATUS_LABEL_KEY[status]
  return key ? t(key) : status
}

/** Locale keys for a draft visibility label. */
const VISIBILITY_LABEL_KEY = {
  global: 'desk.draft.visibilityGlobal',
  workspace: 'desk.draft.visibilityWorkspace',
}

/**
 * Localized draft visibility label: `global` is the shared pool every
 * workspace sees, `workspace` is the current workspace only.
 * @param {string|undefined} visibility
 * @param {Function} t
 * @returns {string}
 */
export function draftVisibilityText(visibility, t) {
  return t(VISIBILITY_LABEL_KEY[visibility] ?? VISIBILITY_LABEL_KEY.global)
}

const FIELD_STYLE = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 9px',
  borderRadius: 6,
  fontFamily: 'inherit',
  fontSize: 13,
  lineHeight: 1.5,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
}

// The canvas body fills the window-driven editor height; it scrolls inside
// itself instead of forcing the page to grow (resize stays off so the fixed
// bottom toolbar keeps its position).
const BODY_STYLE = {
  ...FIELD_STYLE,
  flex: 1,
  minHeight: 0,
  resize: 'none',
}

const BODY_FIELD_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  gap: 4,
}

const EDITOR_CARD_STYLE = {
  padding: 12,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  height: '100%',
  minHeight: 0,
  boxSizing: 'border-box',
}

const LABEL_STYLE = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
}

const HEADER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  flexShrink: 0,
}

const TITLE_STYLE = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  overflowWrap: 'anywhere',
}

// The visibility/status/action toolbar is pinned to the bottom of the canvas
// card; the body flexes above it so the toolbar never scrolls away.
const ACTION_ROW_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexWrap: 'wrap',
  flexShrink: 0,
  paddingTop: 8,
  borderTop: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
}

const NOTICE_STYLE = {
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
}

const ERROR_STYLE = {
  ...NOTICE_STYLE,
  color: 'var(--dsw-alias-state-error-primary)',
}

const DELETE_STYLE = {
  color: 'var(--dsw-alias-state-error-primary)',
}

/** Statuses a draft that already belongs to a session may keep. */
const SESSION_DRAFT_STATUSES = ['prefilled', 'started']

/**
 * The notice a `startFromDraft` result should show.
 *
 * `reason` wins over `manual`: `manual` is also set for `no-workspace`/
 * `no-ui-workspace`, and the manual copy ("a session was started…") would be a
 * lie when no session was actually requested. The manual copy is reserved for
 * `manual-fallback`/`start-failed`/`connect-failed`, where the platform really
 * did attempt a session but could not hand back an id.
 *
 * An auto start that degraded to prefill is a successful prefill with a
 * different explanation: the 3-second readiness timeout and a rejected prompt
 * each get their own copy so the user knows why the prompt was not sent.
 *
 * `startedPersistFailed` is also a success: the prompt was accepted, only the
 * draft's `started` marker could not be saved. It gets its own non-error notice
 * so the user does not press Start again and send the body a second time.
 * @param {object|undefined} result
 * @returns {{ key: string, error: boolean }}
 */
export function startNotice(result) {
  if (result?.startedPersistFailed) {
    return { key: 'desk.draft.startAutoPersistFailed', error: false }
  }
  if (result?.reason === 'auto-fallback') {
    return {
      key: result.autoFailure === 'timeout' ? 'desk.draft.startAutoTimeout' : 'desk.draft.startAutoFallback',
      error: false,
    }
  }
  if (result?.ok) {
    return {
      key: result.mode === 'auto' ? 'desk.draft.startAutoSent' : 'desk.draft.startPrefilled',
      error: false,
    }
  }
  switch (result?.reason) {
    case 'no-workspace':
    case 'no-ui-workspace':
      return { key: 'desk.draft.startNoWorkspace', error: true }
    case 'empty-body':
      return { key: 'desk.draft.startEmpty', error: true }
    case 'manual-fallback':
    case 'start-failed':
    case 'connect-failed':
      return { key: 'desk.draft.startManual', error: false }
    default:
      if (result?.manual) return { key: 'desk.draft.startManual', error: false }
      return { key: 'desk.draft.startError', error: true }
  }
}

/**
 * @param {{ h: Function, React: object, services: object }} deps
 * @returns {Function} the DraftEditor React component
 */
export function createDraftEditor({ h, React, services }) {
  const { Button, Badge, Card, Empty, icons } = createBits(h)
  const t = services.t

  return function DraftEditor({
    draft, isNew = false, workspaceId, workspaceName = '', startBehavior = 'prefill',
    defaultVisibility: preferredVisibility = 'workspace',
    onNew, onCreate, onSave, onDelete,
  }) {
    const [title, setTitle] = React.useState(() => draft?.title ?? '')
    const [body, setBody] = React.useState(() => draft?.body ?? '')
    const [status, setStatus] = React.useState(() => draft?.status ?? 'idea')
    // A new draft defaults according to plugin preferences (draftDefaultVisibility),
    // scoped to the current workspace when available, or falling back to global.
    // Legacy drafts and programmatic creations keep their existing visibility.
    const hasWorkspace = typeof workspaceId === 'string' && workspaceId !== ''
    const initialVisibility = preferredVisibility === GLOBAL_DRAFT_VISIBILITY || !hasWorkspace
      ? GLOBAL_DRAFT_VISIBILITY
      : WORKSPACE_DRAFT_VISIBILITY
    const defaultVisibility = isNew || draft === null
      ? initialVisibility
      : draftVisibility(draft)
    const [visibility, setVisibility] = React.useState(() => defaultVisibility)
    const [busy, setBusy] = React.useState(false)
    const [armedDeleteId, setArmedDeleteId] = React.useState(null)
    /** @type {null | { text: string, error: boolean }} */
    const [notice, setNotice] = React.useState(null)

    // Re-sync when the selected draft or the new/blank mode changes. The
    // persisted revision is not a dependency: a store notify caused by an
    // unrelated write (or by this draft's own save) must not clobber typing.
    React.useEffect(() => {
      setTitle(draft?.title ?? '')
      setBody(draft?.body ?? '')
      setStatus(draft?.status ?? 'idea')
      setVisibility(defaultVisibility)
      setArmedDeleteId(null)
      setNotice(null)
    }, [draft?.id, isNew, workspaceId])

    // A derived status (set by session-start/the composer bridge) must win over
    // stale local state, so the badge and select cannot keep saying `idea` after
    // the draft was actually prefilled or started. Only the status is resynced;
    // other field edits and the current notice stay untouched.
    const derivedStatus = draft?.status === 'prefilled' || draft?.status === 'started'
    React.useEffect(() => {
      if (derivedStatus) setStatus(draft.status)
    }, [derivedStatus, draft?.status])

    const dirty = isNew
      ? title.trim() !== '' || body.trim() !== '' || visibility !== defaultVisibility
      : title !== (draft?.title ?? '') || body !== (draft?.body ?? '')
        || status !== (draft?.status ?? 'idea') || visibility !== draftVisibility(draft)
    // A workspace-scoped draft keeps its original owner; a new (or re-scoped)
    // draft binds to the workspace the desk currently shows.
    const scopeWorkspaceId = visibility === WORKSPACE_DRAFT_VISIBILITY
      ? (typeof draft?.workspaceId === 'string' && draft.workspaceId !== ''
          ? draft.workspaceId
          : (typeof workspaceId === 'string' ? workspaceId : ''))
      : ''
    const canScopeToWorkspace = (typeof workspaceId === 'string' && workspaceId !== '')
      || (typeof draft?.workspaceId === 'string' && draft.workspaceId !== '')
    const canDelete = !isNew && typeof draft?.id === 'string'
    // Only a prefilled draft can be cancelled. A started draft already sent
    // its body, so bringing it back to `ready` would invite a duplicate send.
    const canCancelPrefill = !isNew && draft?.status === 'prefilled'
      && typeof draft?.sessionId === 'string' && draft.sessionId !== ''
    const deleteArmed = canDelete && isDeleteArmed(armedDeleteId, draft.id)

    /** @param {string} message @param {boolean} [error] */
    const say = (message, error = false) => setNotice({ text: message, error })

    const clearNotice = () => {
      if (notice) setNotice(null)
    }

    const insertTemplate = () => {
      const nextBody = body.trim() ? `${body.trim()}\n\n${SPEC_CANVAS_TEMPLATE}` : SPEC_CANVAS_TEMPLATE
      setBody(nextBody)
      say(t('canvas.template.inserted'))
    }

    /**
     * Persist the form. A new draft is only created on save/start, so an
     * abandoned "New draft" click leaves no empty record behind.
     * @returns {Promise<object|null>} the persisted entry, or null when invalid
     */
    const persistForm = async () => {
      // A draft that already started a session may only be prefilled/started;
      // otherwise `saveDraftEntry` would fail with the generic byte-limit copy
      // for what is really a status conflict.
      if (!isNew && typeof draft?.sessionId === 'string' && draft.sessionId !== ''
        && !SESSION_DRAFT_STATUSES.includes(status)) {
        say(t('desk.draft.statusLocked'), true)
        return null
      }
      if (visibility === WORKSPACE_DRAFT_VISIBILITY && scopeWorkspaceId === '') {
        say(t('desk.draft.visibilityNeedsWorkspace'), true)
        return null
      }
      const result = saveDraftEntry({
        draft, isNew, title, body, status,
        visibility,
        ...(visibility === WORKSPACE_DRAFT_VISIBILITY ? { workspaceId: scopeWorkspaceId } : {}),
        ...(typeof services.uuid === 'function' ? { uuid: services.uuid } : {}),
      })
      if (!result.ok) {
        say(t(result.reason === 'empty' ? 'desk.draft.required' : 'desk.draft.error'), true)
        return null
      }
      await services.store.putEntry(result.entry)
      if (isNew) onCreate?.(result.entry)
      else onSave?.(result.entry)
      setTitle(result.entry.title)
      setBody(result.entry.body)
      setStatus(result.entry.status)
      setVisibility(draftVisibility(result.entry))
      return result.entry
    }

    const save = async () => {
      if (busy) return
      setBusy(true)
      try {
        const entry = await persistForm()
        if (entry) say(t('desk.draft.saved'))
      } catch {
        say(t('desk.draft.error'), true)
      } finally {
        setBusy(false)
      }
    }

    /**
     * Save the form, then let the platform layer create the session and park
     * the composer handoff. In auto mode the platform may instead send the body
     * as the first prompt, so the draft can come back `started`; otherwise it
     * only becomes `prefilled` after the handoff succeeds.
     */
    const start = async () => {
      if (busy) return
      if (body.trim() === '') {
        say(t('desk.draft.startEmpty'), true)
        return
      }
      if (typeof services.startFromDraft !== 'function') {
        say(t('desk.draft.startUnavailable'), true)
        return
      }
      setBusy(true)
      try {
        const entry = await persistForm()
        if (!entry) return
        const behavior = startBehavior === 'auto' ? 'auto' : 'prefill'
        // A workspace-scoped draft opens its session in the workspace it was
        // filed under; a global draft keeps the historical "current workspace".
        const startWorkspaceId = visibility === WORKSPACE_DRAFT_VISIBILITY
          ? (scopeWorkspaceId || workspaceId)
          : workspaceId
        const result = await services.startFromDraft({
          draft: entry,
          behavior,
          ...(typeof startWorkspaceId === 'string' && startWorkspaceId !== '' ? { workspaceId: startWorkspaceId } : {}),
        })
        if (result?.ok) setStatus(result.mode === 'auto' ? 'started' : 'prefilled')
        const notice = startNotice(result)
        say(t(notice.key), notice.error)
      } catch {
        say(t('desk.draft.error'), true)
      } finally {
        setBusy(false)
      }
    }

    /**
     * Undo a prefill: drop the parked handoff, clear the draft's `sessionId`,
     * and persist it back to `ready` (or `idea` when the body was emptied).
     * The handoff must be gone before the status write so a composer mounted
     * mid-cancel cannot still seed the old body.
     */
    const cancelPrefill = async () => {
      if (busy || !canCancelPrefill) return
      setBusy(true)
      try {
        if (typeof services.store.deleteHandoff !== 'function') {
          throw new Error('deleteHandoff unavailable')
        }
        await services.store.deleteHandoff(draft.sessionId)
        // Fall back to the persisted fields if the user cleared the form: a
        // prefilled draft always had a body, and cancel must never strand it
        // in `prefilled` because the current form no longer validates.
        const nextTitle = title.trim() || (typeof draft.title === 'string' ? draft.title : '')
        const nextBody = body.trim() || (typeof draft.body === 'string' ? draft.body : '')
        const nextStatus = nextBody === '' ? 'idea' : 'ready'
        const next = {
          ...draft,
          title: nextTitle,
          body: nextBody,
          status: nextStatus,
          updatedAt: typeof services.now === 'function' ? services.now() : Date.now(),
        }
        delete next.sessionId
        const check = validateEntry(next)
        if (!check.ok) {
          say(t('desk.draft.error'), true)
          return
        }
        await services.store.putEntry(next)
        setStatus(next.status)
        onSave?.(next)
        say(t('desk.draft.cancelPrefillDone'))
      } catch {
        say(t('desk.draft.error'), true)
      } finally {
        setBusy(false)
      }
    }

    /** Two-step delete keeps a single click from dropping a draft. */
    const remove = async () => {
      if (busy || !canDelete) return
      if (!deleteArmed) {
        setArmedDeleteId(draft.id)
        return
      }
      setBusy(true)
      try {
        await services.store.deleteEntry(draft.workspaceKey, draft.id)
        // A deleted draft must not leave a one-shot prefill behind for the
        // composer to consume after the draft itself is gone.
        if (typeof draft.sessionId === 'string' && draft.sessionId !== ''
          && typeof services.store.deleteHandoff === 'function') {
          try {
            await services.store.deleteHandoff(draft.sessionId)
          } catch {
            // Best-effort: the draft is already gone, and the bridge refuses to
            // apply a handoff whose draft cannot be found later.
          }
        }
        setArmedDeleteId(null)
        onDelete?.(draft.id)
      } catch {
        say(t('desk.draft.error'), true)
        setArmedDeleteId(null)
      } finally {
        setBusy(false)
      }
    }

    if (!isNew && !draft) {
      return h(Card, { style: EDITOR_CARD_STYLE },
        h(Empty, null, t('desk.draft.select')),
        h('div', { style: { display: 'flex', justifyContent: 'center' } },
          h(Button, { variant: 'primary', onClick: onNew }, t('desk.draft.new'))))
    }

    return h(Card, { style: EDITOR_CARD_STYLE },
      h('div', { style: HEADER_STYLE },
        h('span', { style: TITLE_STYLE }, isNew ? t('desk.draft.new') : (title.trim() || t('desk.draft.untitled'))),
        dirty ? h(Badge, { tone: 'warn' }, t('desk.draft.dirty')) : null,
        h(Badge, { tone: DRAFT_STATUS_TONE[status] ?? 'neutral' }, draftStatusText(status, t))),
      h('label', { style: LABEL_STYLE },
        t('desk.draft.title'),
        h('input', {
          type: 'text',
          value: title,
          placeholder: t('desk.draft.titlePlaceholder'),
          maxLength: 200,
          onChange: event => {
            setTitle(event.target.value)
            clearNotice()
          },
          style: { ...FIELD_STYLE, marginTop: 4 },
        })),
      h('label', { style: { ...LABEL_STYLE, ...BODY_FIELD_STYLE } },
        t('desk.draft.body'),
        h('textarea', {
          value: body,
          placeholder: t('desk.draft.bodyPlaceholder'),
          onChange: event => {
            setBody(event.target.value)
            clearNotice()
          },
          style: BODY_STYLE,
        })),
      notice
        ? h('div', { role: notice.error ? 'alert' : 'status', style: notice.error ? ERROR_STYLE : NOTICE_STYLE }, notice.text)
        : null,
      h('div', { style: ACTION_ROW_STYLE },
        h('label', { style: { ...LABEL_STYLE, fontWeight: 500 } },
          t('desk.draft.visibility'),
          h('select', {
            value: visibility,
            title: visibility === WORKSPACE_DRAFT_VISIBILITY
              ? `${t('desk.draft.visibilityWorkspaceHint')}${workspaceName ? ` · ${workspaceName}` : ''}`
              : t('desk.draft.visibilityGlobalHint'),
            'aria-label': t('desk.draft.visibility'),
            onChange: event => {
              setVisibility(event.target.value === WORKSPACE_DRAFT_VISIBILITY
                ? WORKSPACE_DRAFT_VISIBILITY
                : GLOBAL_DRAFT_VISIBILITY)
              clearNotice()
            },
            style: { ...FIELD_STYLE, width: 'auto', marginLeft: 6 },
          },
            h('option', { value: GLOBAL_DRAFT_VISIBILITY }, draftVisibilityText(GLOBAL_DRAFT_VISIBILITY, t)),
            h('option', { value: WORKSPACE_DRAFT_VISIBILITY, disabled: !canScopeToWorkspace },
              draftVisibilityText(WORKSPACE_DRAFT_VISIBILITY, t)))),
        h('label', { style: { ...LABEL_STYLE, fontWeight: 500 } },
          t('desk.draft.status'),
          h('select', {
            value: status,
            onChange: event => {
              setStatus(event.target.value)
              clearNotice()
            },
            style: { ...FIELD_STYLE, width: 'auto', marginLeft: 6 },
          }, draftStatusOptions(status).map(value => h('option', { key: value, value }, draftStatusText(value, t))))),
        h(Button, {
          variant: 'ghost',
          icon: icons.Brain,
          onClick: insertTemplate,
          title: t('canvas.template.insert'),
          style: { fontSize: 12 },
        }, t('canvas.template.insert')),
        h('span', { style: { flex: 1 } }),
        canCancelPrefill
          ? h(Button, { icon: icons.ArrowCounterClockwise, disabled: busy, onClick: cancelPrefill }, t('desk.draft.cancelPrefill'))
          : null,
        canDelete
          ? h(Button, {
              icon: icons.Trash,
              disabled: busy,
              onClick: remove,
              style: deleteArmed ? DELETE_STYLE : undefined,
            }, deleteArmed ? t('desk.draft.confirmDelete') : t('desk.draft.delete'))
          : null,
        h(Button, { icon: icons.CheckCircle, disabled: busy, onClick: save }, t('desk.draft.save')),
        h('span', {
          id: 'draftStartHint',
          style: {
            fontSize: 11,
            color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
            marginRight: 4,
          },
        }, startBehavior === 'auto'
          ? t('desk.canvas.startHintAuto')
          : t('desk.canvas.startHintPrefill')),
        h(Button, {
          variant: 'primary',
          icon: icons.Play,
          disabled: busy || body.trim() === '',
          onClick: start,
        }, t('desk.draft.start'))))
  }
}
