
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { COMMAND_CATALOG, SKILL_CATALOG, toCatalogItems } from '../src/client/catalog.js'
import { dictionaries } from '../src/locale.js'

const dicts = dictionaries()
const zh = dicts.zh
const en = dicts.en

test('command/skill catalog is a single source of truth with zh+en descriptions', () => {
  assert.equal(COMMAND_CATALOG.length, 11, '11 builtin slash commands')
  assert.equal(SKILL_CATALOG.length, 19, '19 builtin skills')
  const keys = new Set()
  for (const entry of [...COMMAND_CATALOG, ...SKILL_CATALOG]) {
    assert.ok(entry.name, 'entry needs a name')
    assert.ok(entry.descKey, 'entry needs a descKey')
    assert.ok(!keys.has(entry.name), 'duplicate catalog name: ' + entry.name)
    keys.add(entry.name)
    for (const [lang, dict] of [['zh', zh], ['en', en]]) {
      const value = dict[entry.descKey]
      assert.equal(typeof value, 'string', lang + ' missing ' + entry.descKey)
      assert.ok(value.trim().length > 0, lang + ' empty ' + entry.descKey)
      assert.ok(!/[{}]/.test(value), lang + ' unexpected placeholder in ' + entry.descKey)
      assert.ok(!/^\/[a-z-]+ (指令|技能)$/.test(value), lang + ' still uses a generated fallback: ' + entry.descKey)
    }
  }
  // zh and en must actually differ for most entries (no copy-paste placeholder).
  const translated = COMMAND_CATALOG.concat(SKILL_CATALOG).filter(e => zh[e.descKey] !== en[e.descKey]).length
  assert.ok(translated >= keys.size - 2, 'descriptions must be translated, not copied')
})

test('toCatalogItems localises labels and inserts', () => {
  const tZh = key => zh[key] ?? key
  const tEn = key => en[key] ?? key
  const zhItems = toCatalogItems(COMMAND_CATALOG.slice(0, 3), tZh)
  const enItems = toCatalogItems(COMMAND_CATALOG.slice(0, 3), tEn)
  assert.deepEqual(zhItems.map(i => i.label), ['/plan', '/goal', '/boost'])
  assert.deepEqual(zhItems.map(i => i.insert), ['/plan ', '/goal ', '/boost '])
  assert.notEqual(zhItems[0].description, enItems[0].description, 'same entry must localise')
})

test('session-pane derives its triggers from the shared catalog (no second copy)', () => {
  const source = fs.readFileSync(new URL('../src/client/ui/session-pane.js', import.meta.url), 'utf8')
  assert.ok(source.includes('toTriggerItems(COMMAND_CATALOG)'), 'slash commands must come from catalog.js')
  assert.ok(source.includes('toTriggerItems(SKILL_CATALOG)'), 'skills must come from catalog.js')
  assert.ok(!source.includes("descKey: 'mention.command.plan'"), 'pane must not re-declare the catalog')
})

test('factory.js carries no hardcoded Chinese UI strings', () => {
  const source = fs.readFileSync(new URL('../src/client/factory.js', import.meta.url), 'utf8')
  const cjk = source.split('\n').map((line, i) => [i + 1, line]).filter(([, line]) => /[\u4e00-\u9fa5]/.test(line))
  assert.equal(cjk.length, 0, 'Chinese literals must live in locale.js: line ' + (cjk[0] ? cjk[0][0] : '-'))
})
