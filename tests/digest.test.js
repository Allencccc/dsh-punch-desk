import test from 'node:test'
import assert from 'node:assert/strict'
import { segmentPhases, renderDigest } from '../src/domain/digest.js'

const prompt = (over = {}) => ({
  messageId: 'm1',
  sessionId: 's1',
  workspaceKey: 'session:s1',
  time: 1000,
  localDate: '2026-11-06',
  turn: 1,
  excerpt: '实现登录页',
  source: 'composer',
  status: 'sent',
  ...over,
})

const finding = (over = {}) => ({
  id: 'f1',
  kind: 'finding',
  title: '空密码可登录',
  body: '',
  severity: 'blocker',
  anchors: [{ type: 'file', path: 'src/auth.ts', line: 42 }],
  status: 'open',
  ...over,
})

test('starts a new phase at desk-batch and desk-draft prompts', () => {
  const phases = segmentPhases([
    prompt({ messageId: 'm1', time: 1000, turn: 1 }),
    prompt({ messageId: 'm2', time: 2000, turn: 2 }),
    prompt({ messageId: 'm3', time: 3000, turn: 4, source: 'desk-batch', batchId: 'b1' }),
    prompt({ messageId: 'm4', time: 4000, turn: 5 }),
    prompt({ messageId: 'm5', time: 5000, turn: 7, source: 'desk-draft' }),
    prompt({ messageId: 'm6', time: 6000, turn: 9, source: 'desk-batch', batchId: 'b2' }),
  ], [])

  assert.deepEqual(phases.map(phase => phase.label), ['阶段 1', '阶段 2', '阶段 3', '阶段 4'])
  assert.deepEqual(
    phases.map(phase => phase.promptLog.map(entry => entry.messageId)),
    [['m1', 'm2'], ['m3', 'm4'], ['m5'], ['m6']],
  )
  assert.ok(phases.every(phase => phase.findings.length === 0))
})

test('opens the first phase at a leading boundary prompt without an empty initial phase', () => {
  const phases = segmentPhases([
    prompt({ messageId: 'm1', time: 1000, source: 'desk-batch', batchId: 'b1' }),
    prompt({ messageId: 'm2', time: 2000 }),
  ], [])

  assert.equal(phases.length, 1)
  assert.equal(phases[0].label, '阶段 1')
  assert.deepEqual(phases[0].promptLog.map(entry => entry.messageId), ['m1', 'm2'])
})

test('groups consecutive desk-batch prompts of one sequential batch into a single phase', () => {
  const phases = segmentPhases([
    prompt({ messageId: 'm1', time: 1000, turn: 1 }),
    prompt({ messageId: 'm2', time: 2000, turn: 2, source: 'desk-batch', batchId: 'b-seq' }),
    prompt({ messageId: 'm3', time: 3000, turn: 3, source: 'desk-batch', batchId: 'b-seq' }),
    prompt({ messageId: 'm4', time: 4000, turn: 4, source: 'desk-batch', batchId: 'b-seq' }),
    prompt({ messageId: 'm5', time: 5000, turn: 5, source: 'desk-batch', batchId: 'b-other' }),
    prompt({ messageId: 'm6', time: 6000, turn: 6, source: 'desk-draft' }),
  ], [
    finding({ id: 'f1', batchId: 'b-seq', submittedAt: 2100 }),
    finding({ id: 'f2', batchId: 'b-seq', submittedAt: 3200 }),
    finding({ id: 'f3', batchId: 'b-seq', submittedAt: 4300 }),
  ])

  assert.deepEqual(phases.map(phase => phase.label), ['阶段 1', '阶段 2', '阶段 3', '阶段 4'])
  assert.deepEqual(phases[1].promptLog.map(entry => entry.messageId), ['m2', 'm3', 'm4'])
  assert.deepEqual(phases[1].findings.map(entry => entry.id), ['f1', 'f2', 'f3'])
  assert.deepEqual(phases[2].promptLog.map(entry => entry.messageId), ['m5'])
  assert.deepEqual(phases[3].promptLog.map(entry => entry.messageId), ['m6'])
})

test('ignores queued and expired prompt rows before segmenting and rendering', () => {
  const promptLog = [
    prompt({ messageId: 'queue:r1', time: 1000, turn: 4, source: 'desk-batch', batchId: 'b1', status: 'queued', excerpt: '' }),
    prompt({ messageId: 'm1', time: 2000, turn: 1, status: 'sent', excerpt: '真实提示' }),
    prompt({ messageId: 'queue:r2', time: 3000, turn: 5, source: 'desk-batch', batchId: 'b2', status: 'expired' }),
    prompt({ messageId: 'm-expired', time: 3500, turn: 6, source: 'desk-batch', batchId: 'b3', status: 'expired' }),
    prompt({ messageId: 'm2', time: 4000, turn: 2, status: 'completed', source: 'desk-batch', batchId: 'b4' }),
    prompt({ messageId: 'm3', time: 5000, turn: 3, status: 'sent' }),
  ]

  const phases = segmentPhases(promptLog, [])
  assert.deepEqual(phases.map(phase => phase.label), ['阶段 1', '阶段 2'])
  assert.deepEqual(
    phases.flatMap(phase => phase.promptLog.map(entry => entry.messageId)),
    ['m1', 'm2', 'm3'],
  )

  const markdown = renderDigest({ sessionTitle: '过滤未提交', promptLog })
  assert.doesNotMatch(markdown, /（空 prompt）/)
  assert.doesNotMatch(markdown, /queue:|m-expired/)
  assert.match(markdown, /## 目标\n真实提示/)
  assert.match(markdown, /轮次：3/)
})

test('assigns findings to their batch phase ahead of submittedAt', () => {
  const phases = segmentPhases([
    prompt({ messageId: 'm1', time: 1000, turn: 1 }),
    prompt({ messageId: 'm2', time: 3000, turn: 3, source: 'desk-batch', batchId: 'b1' }),
    prompt({ messageId: 'm3', time: 5000, turn: 5, source: 'desk-batch', batchId: 'b2' }),
  ], [
    finding({ id: 'f-late', batchId: 'b1', submittedAt: 9000 }),
    finding({ id: 'f-early', batchId: 'b2', submittedAt: 1000 }),
  ])

  assert.deepEqual(
    phases.map(phase => phase.findings.map(entry => entry.id)),
    [[], ['f-late'], ['f-early']],
  )
})

test('places unlinked findings in the nearest phase and untimed ones last', () => {
  const phases = segmentPhases([
    prompt({ messageId: 'm1', time: 1000 }),
    prompt({ messageId: 'm2', time: 3000, source: 'desk-batch', batchId: 'b1' }),
    prompt({ messageId: 'm3', time: 5000, source: 'desk-batch', batchId: 'b2' }),
  ], [
    finding({ id: 'f-mid', submittedAt: 1800 }),
    finding({ id: 'f-early', submittedAt: 1500 }),
    finding({ id: 'f-gap', submittedAt: 2500 }),
    finding({ id: 'f-tail', submittedAt: 9000 }),
    finding({ id: 'f-untimed' }),
  ])

  assert.deepEqual(
    phases.map(phase => phase.findings.map(entry => entry.id)),
    [['f-early', 'f-mid'], ['f-gap'], ['f-tail', 'f-untimed']],
  )
})

test('collapses findings without prompts into a single phase', () => {
  const phases = segmentPhases([], [
    finding({ id: 'f2', submittedAt: 2000 }),
    finding({ id: 'f1', submittedAt: 1000 }),
  ])

  assert.deepEqual(phases.map(phase => phase.label), ['阶段 1'])
  assert.deepEqual(phases[0].promptLog, [])
  assert.deepEqual(phases[0].findings.map(entry => entry.id), ['f1', 'f2'])
})

test('returns no phases when there is nothing to digest', () => {
  assert.deepEqual(segmentPhases([], []), [])
  assert.deepEqual(segmentPhases(null, null), [])
})

test('ignores malformed prompt and finding entries', () => {
  const phases = segmentPhases(
    [null, prompt({ messageId: 'm1' }), 'x'],
    [undefined, finding({ id: 'f1', submittedAt: 1000 })],
  )

  assert.equal(phases.length, 1)
  assert.deepEqual(phases[0].promptLog.map(entry => entry.messageId), ['m1'])
  assert.deepEqual(phases[0].findings.map(entry => entry.id), ['f1'])
})

test('caps phases at 50 by merging the tail', () => {
  const prompts = Array.from({ length: 60 }, (_, index) => prompt({
    messageId: `m${index + 1}`,
    time: (index + 1) * 1000,
    source: 'desk-batch',
    batchId: `b${index + 1}`,
  }))
  const phases = segmentPhases(prompts, [])

  assert.equal(phases.length, 50)
  assert.equal(phases.at(-1).label, '阶段 50')
  assert.equal(phases.at(-1).promptLog.length, 11)
  assert.equal(phases.at(-1).promptLog[0].messageId, 'm50')
})

test('sorts prompts by time without mutating the caller array', () => {
  const input = [
    prompt({ messageId: 'm3', time: 3000 }),
    prompt({ messageId: 'm1', time: 1000 }),
    prompt({ messageId: 'm2', time: 2000 }),
  ]
  const phases = segmentPhases(input, [])

  assert.deepEqual(phases[0].promptLog.map(entry => entry.messageId), ['m1', 'm2', 'm3'])
  assert.deepEqual(input.map(entry => entry.messageId), ['m3', 'm1', 'm2'])
})

test('renders the deterministic Chinese digest', () => {
  const markdown = renderDigest({
    sessionTitle: '登录重构',
    promptLog: [
      prompt({ messageId: 'm-1', time: 1000, turn: 1, excerpt: '实现登录页' }),
      prompt({ messageId: 'm-2', time: 2000, turn: 3, excerpt: '评审发现 2 条', source: 'desk-batch', batchId: 'b-1' }),
      prompt({ messageId: 'm-3', time: 3000, turn: 4, excerpt: '补充测试' }),
    ],
    findings: [
      finding({ id: 'f-1', batchId: 'b-1', submittedAt: 2100, status: 'resolved' }),
      finding({
        id: 'f-2', batchId: 'b-1', submittedAt: 2200, status: 'open', severity: 'major',
        title: '删除无确认', anchors: [{ type: 'file', path: 'src/ui/row.tsx', line: 88 }],
      }),
    ],
    decisions: ['采用 session cookie 而非 JWT'],
    nextSteps: '补齐回归测试',
  })

  assert.equal(markdown, [
    '# 会话手账 · 登录重构',
    '',
    '日期：2026-11-06 ｜ 轮次：3 ｜ 发现：2（已解决 1，遗留 1）',
    '',
    '## 目标',
    '实现登录页',
    '',
    '## 演进过程与评审时间线',
    '### 阶段 1：初始实现（Turn 1）',
    '- **Prompt**: 实现登录页（工作日志 #m-1）',
    '',
    '### 阶段 2：评审批次（Turn 3-4）',
    '- **Prompt**: 评审发现 2 条（工作日志 #m-2）',
    '- **Prompt**: 补充测试（工作日志 #m-3）',
    '- **解决发现**:',
    '  - [x] [blocker] 空密码可登录 — src/auth.ts:42',
    '- **遗留问题**:',
    '  - [ ] [major] 删除无确认 — src/ui/row.tsx:88',
    '',
    '## 关键决策与变更',
    '- 采用 session cookie 而非 JWT',
    '',
    '## 遗留问题汇总（待处理清单）',
    '- [ ] [major] 删除无确认 — src/ui/row.tsx:88',
    '',
    '## 下一轮建议',
    '补齐回归测试',
    '',
  ].join('\n'))
})

test('renders placeholders for an empty session', () => {
  assert.equal(renderDigest({ sessionTitle: '空会话' }), [
    '# 会话手账 · 空会话',
    '',
    '日期：— ｜ 轮次：0 ｜ 发现：0（已解决 0，遗留 0）',
    '',
    '## 目标',
    '（待补充）',
    '',
    '## 演进过程与评审时间线',
    '（无提交记录）',
    '',
    '## 关键决策与变更',
    '（待补充）',
    '',
    '## 遗留问题汇总（待处理清单）',
    '（无）',
    '',
    '## 下一轮建议',
    '（待补充）',
    '',
  ].join('\n'))
})

test('accepts no arguments and falls back to a default title', () => {
  const markdown = renderDigest()
  assert.match(markdown, /^# 会话手账 · 未命名会话/)
  assert.match(markdown, /（无提交记录）/)
})

test('counts dismissed findings but omits them from the timeline and checklist', () => {
  const markdown = renderDigest({
    sessionTitle: '状态统计',
    promptLog: [prompt({ messageId: 'm-1', time: 1000 })],
    findings: [
      finding({ id: 'f-1', submittedAt: 1100, status: 'resolved' }),
      finding({ id: 'f-2', submittedAt: 1200, status: 'dismissed', title: '不修的发现' }),
      finding({ id: 'f-3', submittedAt: 1300, status: 'open', title: '待修的发现' }),
    ],
  })

  assert.match(markdown, /发现：3（已解决 1，已忽略 1，遗留 1）/)
  assert.doesNotMatch(markdown, /不修的发现/)
  assert.match(markdown, /\[x\] \[blocker\] 空密码可登录/)
  assert.match(markdown, /- \[ \] \[blocker\] 待修的发现/)
})

test('renders findings without severity or anchors', () => {
  const markdown = renderDigest({
    sessionTitle: '无锚点',
    promptLog: [prompt({ messageId: 'm-1' })],
    findings: [finding({ id: 'f-1', title: '无锚点发现', severity: undefined, anchors: [], submittedAt: 1100 })],
  })

  assert.match(markdown, /- \[ \] 无锚点发现\n/)
  assert.doesNotMatch(markdown, /\[undefined\]/)
})

test('renders a findings-only digest without prompts', () => {
  const markdown = renderDigest({
    sessionTitle: '仅发现',
    findings: [finding({ id: 'f-1', submittedAt: 1000, title: '遗留缺陷' })],
  })

  assert.match(markdown, /日期：— ｜ 轮次：0 ｜ 发现：1（已解决 0，遗留 1）/)
  assert.match(markdown, /### 阶段 1\n- \*\*遗留问题\*\*:/)
  assert.match(markdown, /## 遗留问题汇总（待处理清单）\n- \[ \] \[blocker\] 遗留缺陷/)
})


test('renders a quote anchor excerpt for a finding', () => {
  const markdown = renderDigest({
    sessionTitle: '引用会话',
    promptLog: [prompt({ turn: 3, messageId: 'm3' })],
    findings: [finding({
      anchors: [{ type: 'quote', text: '不要在渲染层做深拷贝', turn: 3, messageId: 'm3' }],
    })],
  })
  assert.match(markdown, /不要在渲染层做深拷贝/)
})
