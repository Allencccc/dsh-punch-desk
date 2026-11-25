import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_TAGS,
  MAX_TAGS,
  PRESET_TAG_KEYS,
  addCustomTag,
  buildTagFramework,
  findTag,
  normalizeTagCatalog,
  removeCustomTag,
  updateTagColor,
  updateTagGuidance,
  updateTagLabel,
} from '../src/domain/tags.js'
import { composeCombinedPrompt } from '../src/domain/prompt.js'
import { DEFAULT_PREFS, normalizePrefs } from '../src/client/prefs.js'

test('defaults: four presets in fixed order, each marked preset', () => {
  assert.deepEqual(DEFAULT_TAGS.map(tag => tag.key), ['optimize', 'refactor', 'blocker', 'context'])
  assert.deepEqual(PRESET_TAG_KEYS, ['optimize', 'refactor', 'blocker', 'context'])
  for (const tag of DEFAULT_TAGS) {
    assert.equal(tag.preset, true)
    assert.ok(tag.label.length > 0)
    assert.ok(tag.guidance.length > 0)
  }
})

test('normalize keeps presets even when storage is empty or malformed', () => {
  for (const raw of [undefined, null, {}, 'nope', [null, 42]]) {
    const tags = normalizeTagCatalog(raw)
    assert.equal(tags.length, 4)
    assert.deepEqual(tags.map(tag => tag.key), PRESET_TAG_KEYS)
  }
})

test('normalize lets presets keep their guidance override but never their label', () => {
  const tags = normalizeTagCatalog([
    { key: 'blocker', label: '被篡改', guidance: '先定位根因' },
    { key: 'optimize', guidance: '' },
  ])
  const blocker = findTag(tags, 'blocker')
  assert.equal(blocker.label, '问题')
  assert.equal(blocker.guidance, '先定位根因')
  assert.equal(findTag(tags, 'optimize').guidance, '', 'empty guidance is meaningful')
})

test('normalize dedupes custom tags and caps the catalog at ten', () => {
  const custom = Array.from({ length: 12 }, (_, i) => ({ key: `c${i}`, label: `标签${i}`, guidance: '' }))
  const tags = normalizeTagCatalog(custom)
  assert.equal(tags.length, MAX_TAGS)
  assert.equal(tags.filter(tag => tag.preset === false).length, MAX_TAGS - 4)

  const duped = normalizeTagCatalog([
    { key: 'c1', label: 'A', guidance: '' },
    { key: 'c1', label: 'B', guidance: '' },
  ])
  assert.equal(duped.filter(tag => tag.key === 'c1').length, 1)
  assert.equal(findTag(duped, 'c1').label, 'A')

  const invalid = normalizeTagCatalog([{ key: 'bad key!', label: 'x' }, { key: 'c2', label: '   ' }])
  assert.equal(invalid.length, 4)
})

test('addCustomTag enforces the cap, uniqueness and a non-empty label', () => {
  let tags = normalizeTagCatalog(DEFAULT_TAGS)
  for (let i = 0; i < 6; i += 1) {
    const added = addCustomTag(tags, { key: `custom-${i}`, label: `自定义${i}`, guidance: '方向' })
    assert.equal(added.ok, true)
    tags = added.tags
  }
  assert.equal(tags.length, MAX_TAGS)
  assert.equal(addCustomTag(tags, { key: 'custom-x', label: '溢出' }).error, 'tag-limit')
  assert.equal(addCustomTag(tags.slice(0, 4), { key: 'blocker', label: '重复' }).error, 'tag-duplicate')
  assert.equal(addCustomTag(tags.slice(0, 4), { key: '', label: '无键' }).error, 'tag-invalid')
  assert.equal(addCustomTag(tags.slice(0, 4), { key: 'ok-key', label: '   ' }).error, 'tag-invalid')
})

test('removeCustomTag never removes presets', () => {
  const tags = normalizeTagCatalog([{ key: 'custom-1', label: '无障碍', guidance: '' }])
  const removedCustom = removeCustomTag(tags, 'custom-1')
  assert.equal(removedCustom.length, 4)
  const removedPreset = removeCustomTag(tags, 'blocker')
  assert.equal(removedPreset.length, 5, 'preset survives an attempted delete')
  assert.ok(findTag(removedPreset, 'blocker'))
})

test('guidance is editable for presets and custom tags; labels only for custom', () => {
  const tags = normalizeTagCatalog([{ key: 'custom-1', label: '无障碍', guidance: '旧' }])
  const withGuidance = updateTagGuidance(tags, 'optimize', '新的优化方向')
  assert.equal(findTag(withGuidance, 'optimize').guidance, '新的优化方向')
  assert.equal(findTag(withGuidance, 'custom-1').guidance, '旧')

  const renamed = updateTagLabel(tags, 'custom-1', '可访问性')
  assert.equal(findTag(renamed, 'custom-1').label, '可访问性')
  const presetRename = updateTagLabel(tags, 'optimize', '改名尝试')
  assert.equal(findTag(presetRename, 'optimize').label, '优化')
})

test('buildTagFramework renders key, label and guidance, and skips empty catalogs', () => {
  const framework = buildTagFramework([
    { key: 'blocker', label: '问题', guidance: '先给最小修复' },
    { key: 'custom-1', label: '无障碍', guidance: '' },
  ])
  assert.match(framework, /^【分析要点】/)
  assert.match(framework, /- \[blocker\] 问题：先给最小修复/)
  assert.match(framework, /- \[custom-1\] 无障碍$/)
  assert.equal(buildTagFramework([]), '')
  assert.equal(buildTagFramework(undefined), '')
})

test('analysis points only include tags used by the submitted findings', () => {
  const tags = normalizeTagCatalog([
    { key: 'custom-1', label: '无障碍', guidance: '关注键盘可达性' },
    { key: 'custom-2', label: '性能', guidance: '关注渲染成本' },
  ])
  const entries = [
    { id: 'f1', title: 'A', tag: 'optimize' },
    { id: 'f2', title: 'B', tag: 'custom-2' },
  ]
  const text = composeCombinedPrompt(entries, { tags, promptTail: 'minimal' })
  assert.match(text, /【分析要点】/)
  assert.match(text, /\[custom-2\] 性能/)
  assert.doesNotMatch(text, /\[custom-1\] 无障碍/)
  assert.doesNotMatch(text, /\[blocker\]/)
})

test('composed prompt prefixes entries with the tag and injects the framework once', () => {
  const entry = { id: 'f1', title: '标题', body: '', tag: 'custom-1', severity: 'minor', anchors: [] }
  const tags = normalizeTagCatalog([{ key: 'custom-1', label: '无障碍', guidance: '关注键盘可达性' }])
  const text = composeCombinedPrompt([entry], { tags, promptTail: 'minimal' })
  assert.match(text, /1\. \[custom-1\] 标题/)
  assert.doesNotMatch(text, /\[minor\]/, 'tag wins over the legacy severity field')
  assert.match(text, /【分析要点】/)
  assert.ok(text.indexOf('【分析要点】') < text.indexOf('【回复要求】'), 'framework sits before the reply contract')
  assert.equal(text.match(/【分析要点】/g).length, 1)

  const legacy = composeCombinedPrompt([{ ...entry, tag: undefined }], { promptTail: 'minimal' })
  assert.match(legacy, /1\. \[minor\] 标题/, 'rows without a tag fall back to severity')
  assert.doesNotMatch(legacy, /【分析要点】/)
})

test('prefs normalize the catalog and cap custom tags at six', () => {
  const defaults = normalizePrefs({})
  assert.equal(defaults.findingTags.length, 4)
  assert.deepEqual(defaults.findingTags.map(tag => tag.key), PRESET_TAG_KEYS)

  const many = Array.from({ length: 9 }, (_, i) => ({ key: `custom-${i}`, label: `标签${i}` }))
  const normalized = normalizePrefs({ findingTags: many })
  assert.equal(normalized.findingTags.length, MAX_TAGS)
  assert.equal(normalized.findingTags.filter(tag => !tag.preset).length, MAX_TAGS - 4)
  assert.equal(DEFAULT_PREFS.findingTags.length, 4)
})
test('custom tag colors are validated, persisted and never applied to presets', () => {
  const tags = normalizeTagCatalog([
    { key: 'custom-1', label: '无障碍', color: '#88C0D0' },
    { key: 'custom-2', label: '性能', color: 'red' },
    { key: 'blocker', label: '问题', color: '#bf616a' },
  ])
  assert.equal(findTag(tags, 'custom-1').color, '#88c0d0')
  assert.equal(findTag(tags, 'custom-2').color, '', 'invalid colors fall back to the palette')
  assert.equal(findTag(tags, 'blocker').color, undefined, 'presets keep their design-system color')

  const added = addCustomTag(tags, { key: 'custom-3', label: '安全', color: '#B48EAD' })
  assert.equal(added.ok, true)
  assert.equal(findTag(added.tags, 'custom-3').color, '#b48ead')

  const recolored = updateTagColor(added.tags, 'custom-3', '#5E81AC')
  assert.equal(findTag(recolored, 'custom-3').color, '#5e81ac')
  const presetAttempt = updateTagColor(recolored, 'blocker', '#5E81AC')
  assert.equal(findTag(presetAttempt, 'blocker').color, undefined)

  const prefs = normalizePrefs({ findingTags: recolored })
  assert.equal(findTag(prefs.findingTags, 'custom-3').color, '#5e81ac')
})