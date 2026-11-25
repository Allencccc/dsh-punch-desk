/**
 * Finding tag catalog: four presets plus up to six custom tags.
 *
 * A tag is both human-visible (label) and model-visible: `buildTagFramework`
 * renders the used tags' editable guidance into one 「分析要点」 block, and the
 * composed prompt prefixes each entry with `[key]`. The catalog lives in prefs,
 * not in locale — user-defined labels are content and are never translated.
 */

/** Hard cap on preset + custom tags. */
export const MAX_TAGS = 10
export const TAG_KEY_MAX = 40
export const TAG_LABEL_MAX = 24
export const TAG_GUIDANCE_MAX = 200

/**
 * Presets keep their historical keys so existing findings stay meaningful.
 * Their labels are fixed; only `guidance` is user-editable.
 */
export const PRESET_TAGS = Object.freeze([
  { key: 'optimize', label: '优化', guidance: '优先给出可落地的改进方案，说明取舍与影响面' },
  { key: 'refactor', label: '重构', guidance: '关注结构、边界与可维护性，给出可分步迁移的做法' },
  { key: 'blocker', label: '问题', guidance: '定位阻塞点与根因，先给最小修复，再说明回归风险' },
  { key: 'context', label: '上下文', guidance: '补齐背景与约束，说明该结论的适用边界' },
])
export const PRESET_TAG_KEYS = Object.freeze(PRESET_TAGS.map(tag => tag.key))

/** Fresh, mutable copies (each entry marked `preset: true`). */
export const DEFAULT_TAGS = PRESET_TAGS.map(tag => ({ ...tag, preset: true }))

/** Keys are ASCII identifiers; anything else is rejected, never rewritten. */
function normalizeKey(raw) {
  if (typeof raw !== 'string') return ''
  const key = raw.trim()
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return ''
  return key.slice(0, TAG_KEY_MAX)
}

/** @param {unknown} raw @param {string} fallback @returns {string} */
function normalizeLabel(raw, fallback = '') {
  if (typeof raw !== 'string') return fallback
  const clean = raw.replace(/^#+/, '').replace(/\s+/g, ' ').trim()
  return clean.slice(0, TAG_LABEL_MAX) || fallback
}

/** Custom tag color: '#rrggbb' only; anything else falls back to the palette. */
export function normalizeTagColor(raw) {
  if (typeof raw !== 'string') return ''
  const value = raw.trim().toLowerCase()
  return /^#[0-9a-f]{6}$/.test(value) ? value : ''
}

/** Empty string is meaningful (the tag gets no guidance line). */
function normalizeGuidance(raw, fallback = '') {
  if (typeof raw !== 'string') return fallback
  return raw.trim().slice(0, TAG_GUIDANCE_MAX)
}

/**
 * Normalise any stored catalog: presets are always present in fixed order
 * (label fixed, guidance overridable), custom tags are deduped and capped.
 * Malformed input never throws; it degrades to defaults.
 * @param {unknown} raw
 * @returns {Array<{ key: string, label: string, guidance: string, preset: boolean }>}
 */
export function normalizeTagCatalog(raw) {
  const list = Array.isArray(raw) ? raw : []
  const stored = new Map()
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const key = normalizeKey(item.key)
    if (key && !stored.has(key)) stored.set(key, item)
  }

  const tags = PRESET_TAGS.map(preset => ({
    key: preset.key,
    label: preset.label,
    guidance: normalizeGuidance(stored.get(preset.key)?.guidance, preset.guidance),
    preset: true,
  }))

  const seen = new Set(tags.map(tag => tag.key))
  for (const item of list) {
    if (tags.length >= MAX_TAGS) break
    if (!item || typeof item !== 'object') continue
    const key = normalizeKey(item.key)
    const label = normalizeLabel(item.label)
    if (!key || !label || seen.has(key) || PRESET_TAG_KEYS.includes(key)) continue
    seen.add(key)
    tags.push({
      key,
      label,
      guidance: normalizeGuidance(item.guidance, ''),
      color: normalizeTagColor(item.color),
      preset: false,
    })
  }
  return tags
}

/**
 * @param {Array<object>} tags
 * @param {string} key
 * @returns {object|undefined}
 */
export function findTag(tags, key) {
  const list = Array.isArray(tags) ? tags : []
  return list.find(tag => tag && tag.key === key)
}

/**
 * Index among custom tags (for stable palette assignment); -1 when not custom.
 * @param {Array<object>} tags
 * @param {string} key
 * @returns {number}
 */
export function customTagIndex(tags, key) {
  const list = Array.isArray(tags) ? tags : []
  const custom = list.filter(tag => tag && tag.preset !== true)
  return custom.findIndex(tag => tag.key === key)
}

/**
 * Add one custom tag. The caller owns key generation so a deleted key is never
 * reused (historical findings keep pointing at the meaning they were filed with).
 * @param {Array<object>} tags
 * @param {{ key: string, label?: string, guidance?: string }} input
 * @returns {{ ok: boolean, tags: Array<object>, error?: 'tag-limit'|'tag-invalid'|'tag-duplicate' }}
 */
export function addCustomTag(tags, input) {
  const list = normalizeTagCatalog(tags)
  if (list.length >= MAX_TAGS) return { ok: false, tags: list, error: 'tag-limit' }
  const key = normalizeKey(input?.key)
  const label = normalizeLabel(input?.label)
  if (!key || !label) return { ok: false, tags: list, error: 'tag-invalid' }
  if (findTag(list, key)) return { ok: false, tags: list, error: 'tag-duplicate' }
  list.push({
    key,
    label,
    guidance: normalizeGuidance(input?.guidance, ''),
    color: normalizeTagColor(input?.color),
    preset: false,
  })
  return { ok: true, tags: list }
}

/**
 * Remove a custom tag. Presets are never removable; unknown keys are a no-op.
 * @param {Array<object>} tags
 * @param {string} key
 * @returns {Array<object>}
 */
export function removeCustomTag(tags, key) {
  const list = normalizeTagCatalog(tags)
  return list.filter(tag => tag.preset || tag.key !== key)
}

/**
 * Update one tag's guidance. Works for presets and custom tags alike.
 * @param {Array<object>} tags
 * @param {string} key
 * @param {string} guidance
 * @returns {Array<object>}
 */
export function updateTagGuidance(tags, key, guidance) {
  return normalizeTagCatalog(tags).map(tag => (
    tag.key === key ? { ...tag, guidance: normalizeGuidance(guidance, tag.guidance) } : tag
  ))
}

/**
 * Rename a custom tag. Preset labels are fixed.
 * @param {Array<object>} tags
 * @param {string} key
 * @param {string} label
 * @returns {Array<object>}
 */
/**
 * Pick a custom color (presets keep their design-system color).
 * @param {Array<object>} tags
 * @param {string} key
 * @param {string} color '#rrggbb'
 * @returns {Array<object>}
 */
export function updateTagColor(tags, key, color) {
  const next = normalizeTagColor(color)
  return normalizeTagCatalog(tags).map(tag => (
    !tag.preset && tag.key === key ? { ...tag, color: next } : tag
  ))
}

export function updateTagLabel(tags, key, label) {
  return normalizeTagCatalog(tags).map(tag => (
    !tag.preset && tag.key === key && normalizeLabel(label) ? { ...tag, label: normalizeLabel(label) } : tag
  ))
}

/**
 * Compose the 「分析要点」 block injected before the reply tail. Returns '' when
 * there is no catalog, so an empty prefs value never produces an empty heading.
 * When `entries` is supplied, only tags used by those submitted findings are
 * included: the model contract must describe this submission, not the whole
 * catalog. Tags without guidance still appear (they map a prefix to a label).
 * @param {unknown} tags
 * @param {object[]} [entries]
 * @returns {string}
 */
export function buildTagFramework(tags, entries) {
  const list = Array.isArray(tags) ? tags : []
  if (list.length === 0) return ''
  const usedKeys = Array.isArray(entries)
    ? new Set(entries.map(entry => {
        const raw = entry && typeof entry === 'object'
          ? (typeof entry.tag === 'string' && entry.tag.trim() !== '' ? entry.tag : entry.severity)
          : ''
        return typeof raw === 'string' ? raw.replace(/[\[\]\r\n]/g, '').trim() : ''
      }).filter(Boolean))
    : null
  const selected = usedKeys ? list.filter(tag => usedKeys.has(tag?.key)) : list
  const lines = selected
    .filter(tag => tag && typeof tag.key === 'string' && tag.key)
    .map(tag => {
      const label = typeof tag.label === 'string' ? tag.label.trim() : ''
      const guidance = typeof tag.guidance === 'string' ? tag.guidance.trim() : ''
      return `- [${tag.key}]${label ? ` ${label}` : ''}${guidance ? `：${guidance}` : ''}`
    })
  if (lines.length === 0) return ''
  return ['【分析要点】', '仅列出本次提交手账涉及的标签，按各自说明确定分析方向：', ...lines].join('\n')
}
