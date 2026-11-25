/**
 * Settings Center view (Sub-view 5 of Desk).
 *
 * Implements:
 * 1. 4 Categories (Submission & Prompts first):
 *    - Submission & Prompts: promptTail preset (coverage) + editable A/B/C
 *      section texts, byte budgets, tag catalog + analysis framework
 *    - Session: startSessionBehavior (S1), sequentialCostHint (S2)
 *    - Drafts & Inheritance: draftDefaultVisibility (S3), inheritScope (S4)
 *    - UI & Density: composerRows (S5), archivedHistoryHeight (S6)
 * 2. Segmented pill options with immediate auto-save (updatePrefs)
 * 3. Error rollback & localized feedback
 * 4. Factory reset to defaults (resetPrefs)
 * 5. Gate A preview banner (active during infrastructure validation)
 */

import {
  ARCHIVED_HISTORY_HEIGHTS,
  COMPOSER_ROWS_OPTIONS,
  DEFAULT_PREFS,
  DRAFT_DEFAULT_VISIBILITIES,
  INHERIT_SCOPES,
  PROMPT_ENTRY_BYTES_RANGE,
  PROMPT_RETENTION_DAYS_RANGE,
  PROMPT_RETENTION_ROWS_RANGE,
  PROMPT_TAILS,
  PROMPT_TOTAL_BYTES_RANGE,
  SEQUENTIAL_COST_HINTS,
  START_SESSION_BEHAVIORS,
  TAIL_TEXT_MAX,
  normalizePrefs,
  resetPrefs,
  updatePrefs,
} from '../prefs.js'
import {
  MAX_TAGS,
  TAG_GUIDANCE_MAX,
  TAG_LABEL_MAX,
  addCustomTag,
  removeCustomTag,
  updateTagColor,
  updateTagGuidance,
  updateTagLabel,
} from '../../domain/tags.js'
import { createBits } from './bits.js'
import { NORD, TAG_COLOR_CHOICES, formatTagLabel } from './nord.js'

const CONTAINER_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  height: '100%',
  minHeight: 0,
  overflowY: 'auto',
  paddingRight: 6,
  boxSizing: 'border-box',
}

const CATEGORY_SECTION_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 0,
  // Without this the scroll container squeezes sections instead of scrolling,
  // and `overflow: hidden` then clips their rows (unreachable fields).
  flexShrink: 0,
  borderRadius: 8,
  background: 'var(--pd-bg-card, var(--dsw-alias-bg-layer-1, #ffffff))',
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  overflow: 'hidden',
}

const CATEGORY_HEADER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  flexShrink: 0,
  padding: '10px 14px',
  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.03)))',
  borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '0.02em',
  color: 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))',
}

const ROW_STYLE = isLast => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
  flexShrink: 0,
  padding: '12px 14px',
  borderBottom: isLast ? 'none' : '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06)))',
  flexWrap: 'wrap',
})

const ROW_INFO_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: 3,
  // Grow but allow shrinking below the old 220px floor on narrow panes.
  flex: '1 1 220px',
  minWidth: 0,
}

const ROW_LABEL_STYLE = {
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
}

const ROW_HINT_STYLE = {
  fontSize: 11,
  lineHeight: 1.45,
  color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))',
}

const PILL_GROUP_STYLE = {
  display: 'inline-flex',
  alignItems: 'stretch',
  flexWrap: 'wrap',
  maxWidth: '100%',
  borderRadius: 6,
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #eceff4))',
  overflow: 'hidden',
  flexShrink: 0,
}

const PILL_OPTION_STYLE = (selected, disabled) => ({
  padding: '5px 12px',
  fontSize: 11,
  fontWeight: selected ? 600 : 500,
  lineHeight: 1.4,
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  background: selected
    ? 'var(--pd-accent, var(--dsw-alias-button-primary-fill, #5e81ac))'
    : 'transparent',
  color: selected
    ? 'var(--pd-accent-fg, var(--dsw-alias-label-primary-inverted, #ffffff))'
    : 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  border: 'none',
  outline: 'none',
  transition: 'background 0.15s ease, color 0.15s ease',
  userSelect: 'none',
  whiteSpace: 'nowrap',
})

const TEXTAREA_STYLE = disabled => ({
  width: 360,
  maxWidth: '100%',
  boxSizing: 'border-box',
  minHeight: 74,
  padding: '8px 10px',
  fontSize: 11.5,
  lineHeight: 1.5,
  fontFamily: 'monospace',
  borderRadius: 6,
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #eceff4))',
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  outline: 'none',
  resize: 'vertical',
  opacity: disabled ? 0.6 : 1,
  cursor: disabled ? 'not-allowed' : 'text',
})

const NUMBER_INPUT_STYLE = disabled => ({
  width: 130,
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '6px 10px',
  fontSize: 12,
  fontFamily: 'monospace',
  borderRadius: 6,
  border: '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
  background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #eceff4))',
  color: 'var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))',
  outline: 'none',
  opacity: disabled ? 0.6 : 1,
  cursor: disabled ? 'not-allowed' : 'text',
})

const FOOTER_STYLE = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexShrink: 0,
  paddingTop: 8,
  paddingBottom: 16,
  flexWrap: 'wrap',
}

/**
 * @param {{ h: Function, React: object, services: object }} deps
 * @returns {Function} the SettingsView React component
 */
export function createSettingsView({ h, React, services }) {
  const { Badge, Button, icons } = createBits(h)
  const t = services.t

  return function SettingsView({ store, prefs: externalPrefs, onPrefsChange, retentionUsage = null }) {
    const isStoreAvailable = Boolean(store && typeof store.getPrefs === 'function' && typeof store.setPrefs === 'function')

    const [currentPrefs, setCurrentPrefs] = React.useState(() => normalizePrefs(externalPrefs ?? DEFAULT_PREFS))
    const [saving, setSaving] = React.useState(false)
    const [statusTone, setStatusTone] = React.useState(null) // 'saved' | 'reset' | 'error' | null
    const [statusError, setStatusError] = React.useState(null)
    const [tailDrafts, setTailDrafts] = React.useState(() => {
      const base = normalizePrefs(externalPrefs ?? DEFAULT_PREFS)
      return { a: base.promptTailTextA, b: base.promptTailTextB, c: base.promptTailTextC }
    })
    // Retention sliders keep a local draft so dragging does not write prefs on
    // every input event; the commit happens on pointer/key release.
    const [retentionDrafts, setRetentionDrafts] = React.useState(() => {
      const base = normalizePrefs(externalPrefs ?? DEFAULT_PREFS)
      return { days: base.promptLogRetentionDays, rows: base.promptLogRetentionRows }
    })
    React.useEffect(() => {
      setRetentionDrafts({
        days: currentPrefs.promptLogRetentionDays,
        rows: currentPrefs.promptLogRetentionRows,
      })
    }, [currentPrefs.promptLogRetentionDays, currentPrefs.promptLogRetentionRows])
    const [bytesDrafts, setBytesDrafts] = React.useState(() => {
      const base = normalizePrefs(externalPrefs ?? DEFAULT_PREFS)
      return { promptMaxEntryBytes: String(base.promptMaxEntryBytes), promptMaxBytes: String(base.promptMaxBytes) }
    })
    // New tags are created immediately with a default label and appended after
    // the presets — without this ref the row lands below the fold and looks like
    // "nothing was added". We scroll to it and select the label for renaming.
    const pendingTagFocusRef = React.useRef(null)
    // Only the category header collapses its section; individual rows always
    // show their control (the user asked to keep item-level editing stable).
    const [collapsedCategories, setCollapsedCategories] = React.useState(() => new Set())
    const toggleCategory = key => setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    const isCategoryOpen = key => !collapsedCategories.has(key)
    // Tag drafts: typing stays local, commit happens on blur. Preset labels are
    // fixed; custom labels are editable and custom tags are removable.
    const [tagDrafts, setTagDrafts] = React.useState(() => {
      const base = normalizePrefs(externalPrefs ?? DEFAULT_PREFS)
      const drafts = {}
      for (const tag of base.findingTags) drafts[tag.key] = { label: tag.label, guidance: tag.guidance }
      return drafts
    })
    const fadeTimerRef = React.useRef(null)

    // Sync from external store or externalPrefs
    React.useEffect(() => {
      let alive = true
      if (!isStoreAvailable) return

      const load = async () => {
        try {
          const loaded = await store.getPrefs()
          if (alive && loaded) {
            setCurrentPrefs(normalizePrefs(loaded))
          }
        } catch {
          // Keep current fallback
        }
      }

      void load()

      let unsubscribe = null
      if (typeof store.subscribe === 'function') {
        unsubscribe = store.subscribe(() => {
          void load()
        })
      }

      return () => {
        alive = false
        if (typeof unsubscribe === 'function') unsubscribe()
      }
    }, [store, isStoreAvailable])

    // Keep the editable section drafts in sync when prefs hydrate or reset.
    React.useEffect(() => {
      setTailDrafts({
        a: currentPrefs.promptTailTextA ?? '',
        b: currentPrefs.promptTailTextB ?? '',
        c: currentPrefs.promptTailTextC ?? '',
      })
      setBytesDrafts({
        promptMaxEntryBytes: String(currentPrefs.promptMaxEntryBytes ?? ''),
        promptMaxBytes: String(currentPrefs.promptMaxBytes ?? ''),
      })
    }, [
      currentPrefs.promptTailTextA, currentPrefs.promptTailTextB, currentPrefs.promptTailTextC,
      currentPrefs.promptMaxEntryBytes, currentPrefs.promptMaxBytes,
    ])

    // Keep tag drafts in sync when the catalog hydrates, is edited or reset.
    React.useEffect(() => {
      const drafts = {}
      for (const tag of currentPrefs.findingTags) drafts[tag.key] = { label: tag.label, guidance: tag.guidance }
      setTagDrafts(drafts)
    }, [currentPrefs.findingTags])

    // Clear feedback timer on unmount
    React.useEffect(() => {
      return () => {
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      }
    }, [])

    const triggerFeedback = (tone, error = null) => {
      setStatusTone(tone)
      setStatusError(error)
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current)
      if (tone === 'saved' || tone === 'reset') {
        fadeTimerRef.current = setTimeout(() => {
          setStatusTone(null)
        }, 2000)
      }
    }

    const handleOptionSelect = async (key, val) => {
      if (!isStoreAvailable || saving || currentPrefs[key] === val) return
      const previousValue = currentPrefs[key]
      const nextPrefs = { ...currentPrefs, [key]: val }

      // Optimistic update
      setCurrentPrefs(nextPrefs)
      setSaving(true)
      setStatusTone(null)

      try {
        const persisted = await updatePrefs(store, { [key]: val })
        setCurrentPrefs(persisted)
        if (typeof onPrefsChange === 'function') onPrefsChange(persisted)
        triggerFeedback('saved')
      } catch (err) {
        // Rollback on error
        setCurrentPrefs({ ...currentPrefs, [key]: previousValue })
        triggerFeedback('error', err?.message || t('settings.saveFailed'))
      } finally {
        setSaving(false)
      }
    }

    const SECTION_PREF_KEYS = { a: 'promptTailTextA', b: 'promptTailTextB', c: 'promptTailTextC' }

    const handleTailSectionCommit = async section => {
      if (!isStoreAvailable || saving) return
      const prefKey = SECTION_PREF_KEYS[section]
      if (!prefKey) return
      const next = String(tailDrafts[section] ?? '').trim().slice(0, TAIL_TEXT_MAX)
      if (next === (currentPrefs[prefKey] ?? '')) return
      const previousValue = currentPrefs[prefKey] ?? ''
      setCurrentPrefs({ ...currentPrefs, [prefKey]: next })
      setSaving(true)
      setStatusTone(null)
      try {
        const persisted = await updatePrefs(store, { [prefKey]: next })
        setCurrentPrefs(persisted)
        if (typeof onPrefsChange === 'function') onPrefsChange(persisted)
        triggerFeedback('saved')
      } catch (err) {
        setCurrentPrefs({ ...currentPrefs, [prefKey]: previousValue })
        setTailDrafts(prev => ({ ...prev, [section]: previousValue }))
        triggerFeedback('error', err?.message || t('settings.saveFailed'))
      } finally {
        setSaving(false)
      }
    }

    const BYTES_RANGES = {
      promptMaxEntryBytes: PROMPT_ENTRY_BYTES_RANGE,
      promptMaxBytes: PROMPT_TOTAL_BYTES_RANGE,
    }

    const handleBytesCommit = async key => {
      if (!isStoreAvailable || saving) return
      const range = BYTES_RANGES[key]
      const parsed = Number(String(bytesDrafts[key] ?? '').trim())
      if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
        setBytesDrafts(prev => ({ ...prev, [key]: String(currentPrefs[key] ?? '') }))
        triggerFeedback('error', t('settings.promptBytesInvalid'))
        return
      }
      if (parsed === currentPrefs[key]) return
      const previousValue = currentPrefs[key]
      setSaving(true)
      setStatusTone(null)
      try {
        const persisted = await updatePrefs(store, { [key]: parsed })
        setCurrentPrefs(persisted)
        setBytesDrafts({
          promptMaxEntryBytes: String(persisted.promptMaxEntryBytes),
          promptMaxBytes: String(persisted.promptMaxBytes),
        })
        if (typeof onPrefsChange === 'function') onPrefsChange(persisted)
        triggerFeedback('saved')
      } catch (err) {
        setCurrentPrefs({ ...currentPrefs, [key]: previousValue })
        setBytesDrafts(prev => ({ ...prev, [key]: String(previousValue ?? '') }))
        triggerFeedback('error', err?.message || t('settings.saveFailed'))
      } finally {
        setSaving(false)
      }
    }

    const commitTags = async (nextTags, onError) => {
      if (!isStoreAvailable || saving) return false
      setSaving(true)
      setStatusTone(null)
      try {
        const persisted = await updatePrefs(store, { findingTags: nextTags })
        setCurrentPrefs(persisted)
        if (typeof onPrefsChange === 'function') onPrefsChange(persisted)
        triggerFeedback('saved')
        return true
      } catch (err) {
        if (typeof onError === 'function') onError()
        triggerFeedback('error', err?.message || t('settings.saveFailed'))
        return false
      } finally {
        setSaving(false)
      }
    }

    const currentTag = key => currentPrefs.findingTags.find(tag => tag.key === key)

    const handleTagGuidanceCommit = async key => {
      const tag = currentTag(key)
      if (!tag) return
      const next = String(tagDrafts[key]?.guidance ?? '').trim().slice(0, TAG_GUIDANCE_MAX)
      if (next === tag.guidance) return
      await commitTags(updateTagGuidance(currentPrefs.findingTags, key, next), () => {
        setTagDrafts(prev => ({ ...prev, [key]: { ...prev[key], guidance: tag.guidance } }))
      })
    }

    const handleTagLabelCommit = async key => {
      const tag = currentTag(key)
      if (!tag || tag.preset) return
      const next = String(tagDrafts[key]?.label ?? '').trim().slice(0, TAG_LABEL_MAX)
      if (!next || next === tag.label) {
        setTagDrafts(prev => ({ ...prev, [key]: { ...prev[key], label: tag.label } }))
        return
      }
      await commitTags(updateTagLabel(currentPrefs.findingTags, key, next), () => {
        setTagDrafts(prev => ({ ...prev, [key]: { ...prev[key], label: tag.label } }))
      })
    }

    const handleAddTag = async () => {
      if (saving) return
      // Caller-owned key: a deleted key is never reused, so historical findings
      // keep pointing at the meaning they were filed with.
      const key = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const added = addCustomTag(currentPrefs.findingTags, {
        key,
        label: String(t('settings.tagNewLabel') ?? '').slice(0, TAG_LABEL_MAX),
        guidance: '',
      })
      if (!added.ok) {
        triggerFeedback('error', added.error === 'tag-limit' ? t('settings.tagsFull') : t('settings.saveFailed'))
        return
      }
      pendingTagFocusRef.current = key
      const ok = await commitTags(added.tags)
      if (!ok) pendingTagFocusRef.current = null
    }

    const handleRemoveTag = async key => {
      if (saving) return
      await commitTags(removeCustomTag(currentPrefs.findingTags, key))
    }

    const handleReset = async () => {
      if (!isStoreAvailable || saving) return
      setSaving(true)
      setStatusTone(null)

      try {
        const reset = await resetPrefs(store)
        setCurrentPrefs(reset)
        if (typeof onPrefsChange === 'function') onPrefsChange(reset)
        triggerFeedback('reset')
      } catch (err) {
        triggerFeedback('error', err?.message || t('settings.saveFailed'))
      } finally {
        setSaving(false)
      }
    }

    const renderPillGroup = (key, options, labelsMap) => {
      return h('div', {
        role: 'radiogroup',
        'aria-label': t(`settings.${key}`),
        style: PILL_GROUP_STYLE,
      }, options.map(opt => {
        const isSelected = currentPrefs[key] === opt
        return h('button', {
          key: String(opt),
          type: 'button',
          role: 'radio',
          'aria-checked': isSelected,
          disabled: !isStoreAvailable || saving,
          style: PILL_OPTION_STYLE(isSelected, !isStoreAvailable || saving),
          onClick: () => handleOptionSelect(key, opt),
        }, labelsMap[opt] ?? String(opt))
      }))
    }

    // Category header: click to collapse/expand the section body.
    const renderCategoryHeader = (key, icon, title) => h('div', {
      role: 'button',
      tabIndex: 0,
      'aria-expanded': isCategoryOpen(key),
      onClick: () => toggleCategory(key),
      onKeyDown: event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          toggleCategory(key)
        }
      },
      style: { ...CATEGORY_HEADER_STYLE, justifyContent: 'space-between', cursor: 'pointer', userSelect: 'none' },
    },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h(icon, { size: 14 }),
        h('span', {}, title)),
      h(isCategoryOpen(key) ? icons.CaretDown : icons.CaretRight, {
        size: 14,
        style: { color: 'var(--pd-text-tertiary, var(--dsw-alias-label-tertiary, #4c566a))' },
      }))

    const renderRow = (key, title, hint, control, isLast = false) => h('div', {
      key,
      style: ROW_STYLE(isLast),
    },
      h('div', { style: ROW_INFO_STYLE },
        h('span', { style: ROW_LABEL_STYLE }, title),
        h('span', { style: ROW_HINT_STYLE }, hint)),
      control)

    const renderByteRow = (key, range, step, isLast = false) => h('div', {
      key,
      style: ROW_STYLE(isLast),
    },
      h('div', { style: ROW_INFO_STYLE },
        h('span', { style: ROW_LABEL_STYLE }, t(`settings.${key}`)),
        h('span', { style: ROW_HINT_STYLE }, t(`settings.${key}Hint`))),
      h('input', {
        type: 'number',
        min: range.min,
        max: range.max,
        step,
        value: bytesDrafts[key] ?? '',
        disabled: !isStoreAvailable || saving,
        'aria-label': t(`settings.${key}`),
        style: NUMBER_INPUT_STYLE(!isStoreAvailable || saving),
        onChange: event => setBytesDrafts(prev => ({ ...prev, [key]: String(event.target.value ?? '') })),
        onBlur: () => { void handleBytesCommit(key) },
        onKeyDown: event => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setBytesDrafts(prev => ({ ...prev, [key]: String(currentPrefs[key] ?? '') }))
            event.currentTarget.blur()
          }
        },
      }))

    // One compact block per tag: a single header line (chip + label + delete)
    // and a full-width guidance box. Fixed widths inside a flex row used to
    // overflow the settings pane and repeat the label twice.
    // Tag cards live in a responsive grid (the 4 presets sit side by side on a
    // wide pane). Items themselves never collapse — only the category header.
    const handleTagColor = async (key, color) => {
      const tag = currentTag(key)
      if (!tag || tag.preset) return
      await commitTags(updateTagColor(currentPrefs.findingTags, key, color))
    }

    const renderTagRow = (tag) => {
      const draft = tagDrafts[tag.key] ?? { label: tag.label, guidance: tag.guidance }
      const disabled = !isStoreAvailable || saving
      const selectedColor = typeof tag.color === 'string' ? tag.color.toLowerCase() : ''
      return h('div', {
        key: tag.key,
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          flexShrink: 0,
          minWidth: 0,
          boxSizing: 'border-box',
          padding: '8px 10px',
          borderRadius: 8,
          border: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08)))',
          background: 'var(--pd-bg-panel, var(--dsw-alias-bg-layer-2, #eceff4))',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
          h('span', {
            style: {
              fontFamily: 'monospace',
              fontSize: 11,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              color: selectedColor || 'var(--pd-text-secondary, var(--dsw-alias-label-secondary, #434c5e))',
            },
          }, formatTagLabel(draft.label || tag.label)),
          tag.preset ? h(Badge, { tone: 'neutral' }, t('settings.tagPreset')) : null,
          h('span', { style: { flex: 1 } }),
          tag.preset
            ? null
            : h(Button, {
                icon: icons.Trash,
                variant: 'ghost',
                iconOnly: true,
                disabled,
                title: t('settings.deleteTag'),
                'aria-label': t('settings.deleteTag'),
                style: { padding: 4, flexShrink: 0 },
                onClick: () => { void handleRemoveTag(tag.key) },
              })),
        tag.preset
          ? null
          : h('input', {
              type: 'text',
              value: draft.label,
              maxLength: TAG_LABEL_MAX,
              disabled,
              'aria-label': t('settings.tagLabel'),
              placeholder: t('settings.tagLabelPlaceholder'),
              style: { ...NUMBER_INPUT_STYLE(disabled), width: '100%', maxWidth: '100%', minWidth: 0 },
              ref: el => {
                if (!el || pendingTagFocusRef.current !== tag.key) return
                pendingTagFocusRef.current = null
                const focus = () => { el.focus(); el.select(); el.scrollIntoView?.({ block: 'nearest' }) }
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focus)
                else focus()
              },
              onChange: event => {
                const value = String(event.target.value ?? '')
                setTagDrafts(prev => ({ ...prev, [tag.key]: { ...prev[tag.key], label: value } }))
              },
              onBlur: () => { void handleTagLabelCommit(tag.key) },
            }),
        tag.preset
          ? null
          : h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' } },
              TAG_COLOR_CHOICES.map(hex => h('button', {
                key: hex,
                type: 'button',
                disabled,
                title: hex,
                'aria-label': `${t('settings.tagColor')} ${hex}`,
                onClick: () => { void handleTagColor(tag.key, hex) },
                style: {
                  width: 16,
                  height: 16,
                  padding: 0,
                  borderRadius: 8,
                  background: hex,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  border: selectedColor === hex.toLowerCase()
                    ? '2px solid var(--pd-text-primary, var(--dsw-alias-label-primary, #2e3440))'
                    : '1px solid var(--pd-border-default, var(--dsw-alias-border-l1, #d8dee9))',
                },
              }))),
        h('textarea', {
          value: draft.guidance,
          maxLength: TAG_GUIDANCE_MAX,
          rows: 2,
          disabled,
          'aria-label': `${t('settings.tagGuidance')} ${tag.key}`,
          placeholder: t('settings.tagGuidancePlaceholder'),
          // Grow with the card so a stretched row has no empty gap under the box.
          style: { ...TEXTAREA_STYLE(disabled), width: '100%', maxWidth: '100%', minHeight: 54, flex: 1, boxSizing: 'border-box' },
          onChange: event => {
            const value = String(event.target.value ?? '')
            setTagDrafts(prev => ({ ...prev, [tag.key]: { ...prev[tag.key], guidance: value } }))
          },
          onBlur: () => { void handleTagGuidanceCommit(tag.key) },
          onKeyDown: event => {
            if (event.key === 'Escape') {
              setTagDrafts(prev => ({ ...prev, [tag.key]: { ...prev[tag.key], guidance: tag.guidance } }))
              event.currentTarget.blur()
            }
          },
        }))
    }

    const formatBytes = n => {
      const bytes = Number(n) || 0
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
      return `${bytes} B`
    }

    // Range sliders commit on release (pointer/key/blur) so dragging does not
    // write prefs on every input event.
    const renderRetentionSlider = (key, draftKey, range, unit, ariaKey) => {
      const value = retentionDrafts[draftKey]
      const commit = () => { void handleOptionSelect(key, retentionDrafts[draftKey]) }
      return h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 } },
        h('input', {
          type: 'range',
          min: range.min,
          max: range.max,
          step: 1,
          value,
          disabled: !isStoreAvailable || saving,
          'aria-label': t(ariaKey),
          onChange: event => {
            const next = Number(event.target.value)
            setRetentionDrafts(prev => ({ ...prev, [draftKey]: Number.isFinite(next) ? next : prev[draftKey] }))
          },
          onPointerUp: commit,
          onKeyUp: commit,
          onBlur: commit,
          style: { width: 180, accentColor: 'var(--pd-accent, #5e81ac)' },
        }),
        h('span', {
          style: { fontFamily: 'monospace', fontSize: 12, minWidth: 64, textAlign: 'right', color: 'var(--pd-text-primary)' },
        }, `${value} ${unit}`))
    }

    return h('div', { style: CONTAINER_STYLE },
      // Category 1 (top): Submission & prompts — everything the model receives.
      h('div', { style: CATEGORY_SECTION_STYLE },
        renderCategoryHeader('submit', icons.ChatTeardropText, t('settings.category.submit')),
        isCategoryOpen('submit')
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
              renderRow('promptTail', t('settings.promptTail'), t('settings.promptTailHint'),
                renderPillGroup('promptTail', PROMPT_TAILS, {
                  minimal: t('settings.promptTail.minimal'),
                  standard: t('settings.promptTail.standard'),
                  strict: t('settings.promptTail.strict'),
                })),
              // A/B/C side by side; compact height so the block stays scannable.
              h('div', {
                key: 'tail-sections',
                // Plain block on purpose: a column flex + space-between let the
                // grid row stretch to a bogus height (the div looked far taller
                // than its textareas).
                style: {
                  display: 'block',
                  padding: '12px 14px',
                  borderBottom: '1px solid var(--pd-border-subtle, var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.06)))',
                  flexShrink: 0,
                },
              },
                // No flex shorthand here: `flex-basis: 220px` would become a
                // 220px-tall header inside this column container.
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 } },
                  h('span', { style: ROW_LABEL_STYLE }, t('settings.promptTailSections')),
                  h('span', { style: ROW_HINT_STYLE }, t('settings.promptTailSectionsHint'))),
                h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, marginTop: 8, alignContent: 'start', gridAutoRows: 'max-content' } },
                  ['a', 'b', 'c'].map(section => h('div', {
                    key: section,
                    style: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
                  },
                    h('span', { style: ROW_LABEL_STYLE }, t(`settings.promptTailText${section.toUpperCase()}`)),
                    h('span', { style: ROW_HINT_STYLE }, t(`settings.promptTailText${section.toUpperCase()}Hint`)),
                    h('textarea', {
                      value: tailDrafts[section] ?? '',
                      maxLength: TAIL_TEXT_MAX,
                      rows: 5,
                      disabled: !isStoreAvailable || saving,
                      'aria-label': t(`settings.promptTailText${section.toUpperCase()}`),
                      placeholder: t('settings.promptTailTextPlaceholder'),
                      // Fixed height so all three columns match and the block
                      // does not inherit a stray height from the textarea style.
                      style: { ...TEXTAREA_STYLE(!isStoreAvailable || saving), width: '100%', maxWidth: '100%', height: 140, minHeight: 140, boxSizing: 'border-box' },
                      onChange: event => {
                        const value = String(event.target.value ?? '')
                        setTailDrafts(prev => ({ ...prev, [section]: value }))
                      },
                      onBlur: () => { void handleTailSectionCommit(section) },
                      onKeyDown: event => {
                        if (event.key === 'Escape') {
                          setTailDrafts(prev => ({ ...prev, [section]: currentPrefs[SECTION_PREF_KEYS[section]] ?? '' }))
                          event.currentTarget.blur()
                        }
                      },
                    }))))),
              renderByteRow('promptMaxEntryBytes', PROMPT_ENTRY_BYTES_RANGE, 1024),
              renderByteRow('promptMaxBytes', PROMPT_TOTAL_BYTES_RANGE, 2048),
              // Tags and their analysis framework are part of the prompt contract.
              // Inner section labels stay icon-free and neutral: only category
              // headers carry an icon, so a lone Tag glyph read as an anomaly.
              h('div', { style: { padding: '12px 14px 2px' } },
                h('span', { style: ROW_LABEL_STYLE }, t('settings.category.tags'))),
              h('div', { style: ROW_STYLE(false) },
                h('div', { style: ROW_INFO_STYLE },
                  h('span', { style: ROW_LABEL_STYLE }, t('settings.tags')),
                  h('span', { style: ROW_HINT_STYLE }, t('settings.tagsHint'))),
                h(Button, {
                  icon: icons.Plus,
                  disabled: !isStoreAvailable || saving || currentPrefs.findingTags.length >= MAX_TAGS,
                  title: currentPrefs.findingTags.length >= MAX_TAGS ? t('settings.tagsFull') : t('settings.addTag'),
                  onClick: () => { void handleAddTag() },
                }, t('settings.addTag'))),
              h('div', {
                style: {
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(max(180px, calc(25% - 7.5px)), 1fr))',
                  gridAutoRows: '1fr',
                  gap: 10,
                  width: '100%',
                  padding: '10px 14px',
                  boxSizing: 'border-box',
                },
              }, ...currentPrefs.findingTags.map(tag => renderTagRow(tag))))
          : null),

      // Category 2: Session
      h('div', { style: CATEGORY_SECTION_STYLE },
        renderCategoryHeader('session', icons.Clock, t('settings.category.session')),
        isCategoryOpen('session')
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
              renderRow('startSessionBehavior', t('settings.startBehavior'), t('settings.startBehaviorHint'),
                renderPillGroup('startSessionBehavior', START_SESSION_BEHAVIORS, {
                  prefill: t('settings.startBehavior.prefill'),
                  auto: t('settings.startBehavior.auto'),
                })),
              renderRow('sequentialCostHint', t('settings.sequentialCostHint'), t('settings.sequentialCostHintHint'),
                renderPillGroup('sequentialCostHint', SEQUENTIAL_COST_HINTS, {
                  threshold: t('settings.sequentialCostHint.threshold'),
                  always: t('settings.sequentialCostHint.always'),
                  off: t('settings.sequentialCostHint.off'),
                })),
              renderRow('includeTextHeuristic', t('settings.includeTextHeuristic'), t('settings.includeTextHeuristicHint'),
                renderPillGroup('includeTextHeuristic', [false, true], {
                  false: t('settings.includeTextHeuristic.off'),
                  true: t('settings.includeTextHeuristic.on'),
                }), true))
          : null),

      // Category 3: Drafts & Inheritance
      h('div', { style: CATEGORY_SECTION_STYLE },
        renderCategoryHeader('draft', icons.Brain, t('settings.category.draft')),
        isCategoryOpen('draft')
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
              renderRow('draftDefaultVisibility', t('settings.draftVisibility'), t('settings.draftVisibilityHint'),
                renderPillGroup('draftDefaultVisibility', DRAFT_DEFAULT_VISIBILITIES, {
                  workspace: t('settings.draftVisibility.workspace'),
                  global: t('settings.draftVisibility.global'),
                })),
              renderRow('inheritScope', t('settings.inheritScope'), t('settings.inheritScopeHint'),
                renderPillGroup('inheritScope', INHERIT_SCOPES, {
                  workspace: t('settings.inheritScope.workspace'),
                  all: t('settings.inheritScope.all'),
                }), true))
          : null),

      // Category 4: UI & Density
      h('div', { style: CATEGORY_SECTION_STYLE },
        renderCategoryHeader('ui', icons.Gauge, t('settings.category.ui')),
        isCategoryOpen('ui')
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
              renderRow('composerRows', t('settings.composerRows'), t('settings.composerRowsHint'),
                renderPillGroup('composerRows', COMPOSER_ROWS_OPTIONS, {
                  3: t('settings.composerRows.rows3'),
                  4: t('settings.composerRows.rows4'),
                  5: t('settings.composerRows.rows5'),
                })),
              renderRow('archivedHistoryHeight', t('settings.archivedHeight'), t('settings.archivedHeightHint'),
                renderPillGroup('archivedHistoryHeight', ARCHIVED_HISTORY_HEIGHTS, {
                  compact: t('settings.archivedHeight.compact'),
                  tall: t('settings.archivedHeight.tall'),
                  half: t('settings.archivedHeight.half'),
                }), true))
          : null),

      // Category 5: statistics & retention window (caps, lower-only)
      h('div', { style: CATEGORY_SECTION_STYLE },
        renderCategoryHeader('retention', icons.Clock, t('settings.category.retention')),
        isCategoryOpen('retention')
          ? h('div', { style: { display: 'flex', flexDirection: 'column' } },
              renderRow('promptLogRetentionDays', t('settings.retentionDays'), t('settings.retentionDaysHint'),
                renderRetentionSlider('promptLogRetentionDays', 'days', PROMPT_RETENTION_DAYS_RANGE, t('settings.retentionDaysUnit'), 'settings.retentionDays')),
              renderRow('promptLogRetentionRows', t('settings.retentionRows'), t('settings.retentionRowsHint'),
                renderRetentionSlider('promptLogRetentionRows', 'rows', PROMPT_RETENTION_ROWS_RANGE, t('settings.retentionRowsUnit'), 'settings.retentionRows')),
              h('div', { style: { padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 4 } },
                h('span', { style: { fontSize: 11, color: 'var(--pd-text-secondary)' } },
                  t('settings.retentionUsage')
                    .replace('{rows}', String(retentionUsage?.rows ?? 0))
                    .replace('{size}', formatBytes(retentionUsage?.bytes ?? 0))),
                h('span', { style: { fontSize: 10, lineHeight: 1.5, color: 'var(--pd-text-tertiary)' } }, t('settings.retentionWarn'))))
          : null),

      // Footer Actions
      h('div', { style: FOOTER_STYLE },
        h(Button, {
          icon: icons.ArrowCounterClockwise,
          disabled: !isStoreAvailable || saving,
          title: t('settings.resetHint'),
          onClick: handleReset,
        }, t('settings.reset')),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          !isStoreAvailable
            ? h(Badge, { tone: 'neutral' }, t('settings.unavailable'))
            : saving
              ? h(Badge, { tone: 'neutral', icon: icons.CircleNotch }, t('settings.saved'))
              : statusTone === 'saved'
                ? h(Badge, { tone: 'success', icon: icons.CheckCircle }, t('settings.saved'))
                : statusTone === 'reset'
                  ? h(Badge, { tone: 'success', icon: icons.CheckCircle }, t('settings.resetDone'))
                  : statusTone === 'error'
                    ? h(Badge, { tone: 'danger', icon: icons.Prohibit }, statusError || t('settings.saveFailed'))
                    : null)))
  }
}
