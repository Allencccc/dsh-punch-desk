import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TAIL_TEXTS,
  LIMITS,
  PROMPT_TAIL_COVERAGE,
  buildPromptTail,
  composeCombinedPrompt,
  composeSequentialPrompt,
  normalizePromptOptions,
  estimatePromptBudget,
  validateBatch,
  validatePromptText,
} from '../src/domain/prompt.js'

const base = { kind: 'finding', workspaceKey: 'w', sessionId: 's', status: 'open' }
const e = (over) => ({ ...base, id: over.id ?? 'x', title: over.title ?? 'title', body: over.body ?? '', severity: over.severity ?? 'major', anchors: over.anchors ?? [], ...over })

test('combined prompt numbers entries with severity and anchor', () => {
  const text = composeCombinedPrompt([
    e({ title: '空密码可登录', severity: 'blocker', anchors: [{ type: 'file', path: 'src/auth.ts', line: 42 }] }),
    e({ title: '删除无确认', severity: 'major', anchors: [{ type: 'turn', turn: 4, seq: 9 }] }),
  ])
  assert.match(text, /^\[会话手账 · 评审发现 2 条\]/)
  assert.match(text, /1\. \[blocker\] 空密码可登录 — src\/auth\.ts:42/)
  assert.match(text, /2\. \[major\] 删除无确认 — turn 4/)
  assert.match(text, /【回复要求】/)
  assert.match(text, /A\. 逐条处置/)
})

test('presets only change coverage: minimal = A, standard = A+B, strict = A+B+C', () => {
  const minimal = buildPromptTail({ promptTail: 'minimal' })
  const standard = buildPromptTail({ promptTail: 'standard' })
  const strict = buildPromptTail({ promptTail: 'strict' })

  assert.match(minimal, /A\. 逐条处置/)
  assert.doesNotMatch(minimal, /B\. 过程播报/)
  assert.doesNotMatch(minimal, /C\. 收尾/)

  assert.match(standard, /A\. 逐条处置/)
  assert.match(standard, /B\. 过程播报/)
  assert.doesNotMatch(standard, /C\. 收尾/)

  assert.match(strict, /A\. 逐条处置/)
  assert.match(strict, /B\. 过程播报/)
  assert.match(strict, /C\. 收尾/)
  assert.match(strict, /经过：3–6 行时间序/)
  assert.match(strict, /未做\/未验/)
  assert.deepEqual(PROMPT_TAIL_COVERAGE, { minimal: ['a'], standard: ['a', 'b'], strict: ['a', 'b', 'c'] })
})

test('each A/B/C section text can be rewritten by the user', () => {
  const custom = buildPromptTail({
    promptTail: 'strict',
    texts: { a: 'A. 我的逐条要求', b: 'B. 我的过程要求', c: 'C. 我的收尾要求' },
  })
  assert.match(custom, /A\. 我的逐条要求/)
  assert.match(custom, /B\. 我的过程要求/)
  assert.match(custom, /C\. 我的收尾要求/)
  assert.doesNotMatch(custom, /仍缺 X，正在取 Y/)
})

test('an emptied section is omitted, even when the preset covers it', () => {
  const text = buildPromptTail({ promptTail: 'strict', texts: { a: 'A. only this', b: '', c: '' } })
  assert.equal(text, '【回复要求】\nA. only this')
  assert.equal(buildPromptTail({ promptTail: 'standard', texts: { a: '', b: '' } }), '')
})

test('malformed tail options fall back to the default coverage and texts', () => {
  const legacy = composeCombinedPrompt([e({})])
  assert.equal(composeCombinedPrompt([e({})], { promptTail: 'nope' }), legacy)
  assert.equal(composeCombinedPrompt([e({})], null), legacy)
  const normalized = normalizePromptOptions({ texts: { a: 42, b: null } })
  assert.deepEqual(normalized.texts, { a: DEFAULT_TAIL_TEXTS.a, b: DEFAULT_TAIL_TEXTS.b, c: DEFAULT_TAIL_TEXTS.c })
  assert.equal(normalizePromptOptions({ promptTail: 'strict' }).promptTail, 'strict')
  assert.equal(normalizePromptOptions({ promptTail: 'minimal' }).promptTail, 'minimal')
})

test('section text overrides are trimmed and bounded', () => {
  const huge = 'x'.repeat(5000)
  const normalized = normalizePromptOptions({ texts: { a: `  ${huge}  ` } })
  assert.equal(normalized.texts.a.length, 2000)
  assert.equal(normalizePromptOptions({ texts: { a: '  wrapped  ' } }).texts.a, 'wrapped')
  assert.match(normalizePromptOptions({ texts: { b: 'line1\nline2' } }).texts.b, /line1\nline2/)
})

test('the tail no longer contains any verification-command clause', () => {
  const text = composeCombinedPrompt([e({})], { promptTail: 'strict' })
  assert.doesNotMatch(text, /运行.*并贴/)
  assert.doesNotMatch(text, /验证命令/)
  assert.doesNotMatch(text, /\bD\./)
})

test('byte budgets are configurable per submit and reported with real numbers', () => {
  const one = e({ body: 'x'.repeat(3000) })
  // Default budget allows it (8 KB entry cap).
  assert.equal(validateBatch([one]).ok, true)
  // A tighter configured cap rejects it and names the actual size.
  const tight = validateBatch([one], { maxEntryBytes: 2048 })
  assert.equal(tight.ok, false)
  assert.match(tight.errors.join(';'), /2048 字节.*3000 字节/)

  const many = Array.from({ length: 6 }, (_, i) => e({ id: `e${i}`, body: 'x'.repeat(3000) }))
  // Combined mode sums the composed message.
  assert.equal(validateBatch(many, { maxBytes: 8192 }).ok, false)
  // Sequential mode only checks each single message.
  assert.equal(validateBatch(many, { maxBytes: 8192, mode: 'sequential' }).ok, true)
  assert.equal(validateBatch(many, { maxBytes: 3000, mode: 'sequential' }).ok, false)
})

test('a hand-edited prompt is validated against the same budget', () => {
  assert.equal(validatePromptText('hello', { maxBytes: 100 }).ok, true)
  const tooLong = validatePromptText('x'.repeat(200), { maxBytes: 100 })
  assert.equal(tooLong.ok, false)
  assert.match(tooLong.errors.join(';'), /100 字节.*200 字节/)
  assert.equal(validatePromptText('', { maxBytes: 100 }).ok, false)
})

test('the dock budget estimate reports tokens, context share and the soft threshold', () => {
  const small = estimatePromptBudget('hello')
  assert.equal(small.bytes, 5)
  assert.equal(small.tokens, 2)
  assert.equal(small.softExceeded, false)
  assert.ok(small.contextShare > 0 && small.contextShare < 0.00001)

  const big = estimatePromptBudget('x'.repeat(140 * 1024))
  assert.equal(big.softExceeded, true)
  assert.ok(big.tokens > 40000)
})
