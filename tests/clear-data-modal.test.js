
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createClearDataModal, CLEAR_DATA_CATEGORIES } from '../src/client/ui/clear-data-modal.js'
import { dictionaries } from '../src/locale.js'

const dicts = dictionaries()
const t = key => dicts.zh[key] ?? key
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
const text = node => {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(text).join('')
  return (node.children || []).map(text).join('')
}
const collect = (node, out = []) => {
  if (!node || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children || []) collect(child, out)
  return out
}

function renderModal(overrides = {}) {
  const calls = { close: 0, confirm: 0, options: [] }
  const render = createClearDataModal({ h, t, Button: 'button', Trash: 'svg', X: 'svg' })
  const tree = render({
    titleSuffix: 'dsh-plugins',
    clearOptions: { clearFindings: false, clearGroups: false, clearPromptLogs: false, clearDrafts: false, preservePinned: true },
    setClearOptions: updater => calls.options.push(updater),
    clearing: false,
    notice: null,
    onClose: () => { calls.close += 1 },
    onConfirm: () => { calls.confirm += 1 },
    ...overrides,
  })
  return { tree, calls }
}

test('shared clear-data modal renders the four categories plus pinned guard', () => {
  const { tree } = renderModal()
  const nodes = collect(tree)
  const dialog = nodes.find(n => n.props?.role === 'dialog')
  assert.ok(dialog, 'must render a dialog role')
  assert.equal(dialog.props['aria-modal'], 'true')
  assert.ok(text(tree).includes(t('clear.modalTitle') + ' · dsh-plugins'), 'title must include the scope suffix')
  const checkboxes = nodes.filter(n => n.type === 'input' && n.props?.type === 'checkbox')
  assert.equal(checkboxes.length, 5, '4 categories + preservePinned')
  assert.equal(CLEAR_DATA_CATEGORIES.length, 4)
  for (const key of CLEAR_DATA_CATEGORIES) assert.ok(text(tree).includes(t('clear.' + (key === 'clearFindings' ? 'catFindings' : key === 'clearGroups' ? 'catGroups' : key === 'clearPromptLogs' ? 'catPromptLogs' : 'catDrafts'))), 'missing label for ' + key)
})

test('shared clear-data modal wires options, notice, cancel and confirm', () => {
  const { tree, calls } = renderModal({ notice: { text: 'boom' } })
  assert.ok(text(tree).includes('boom'), 'notice must render')
  const nodes = collect(tree)
  const checkboxes = nodes.filter(n => n.type === 'input' && n.props?.type === 'checkbox')
  checkboxes[0].props.onChange({ target: { checked: true } })
  assert.equal(calls.options.length, 1, 'toggling must ask the parent for an update')
  const next = calls.options[0]({ clearFindings: false })
  assert.equal(next.clearFindings, true, 'updater must flip only the toggled category')
  const buttons = nodes.filter(n => n.type === 'button')
  const cancel = buttons.find(b => text({ children: [b] }).includes(t('clear.cancelBtn')))
  const confirm = buttons.find(b => text({ children: [b] }).includes(t('clear.confirmBtn')))
  assert.ok(cancel && confirm, 'footer actions must exist')
  cancel.props.onClick()
  confirm.props.onClick()
  assert.equal(calls.close, 1)
  assert.equal(calls.confirm, 1)
})

test('desk and session pane share the single modal renderer', () => {
  for (const file of ['src/client/ui/desk.js', 'src/client/ui/session-pane.js']) {
    const source = fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8')
    assert.ok(source.includes("createClearDataModal"), file + ' must import the shared modal')
    assert.ok(!source.includes('const renderClearModal = () => {'), file + ' must not keep the duplicated dialog')
  }
})
