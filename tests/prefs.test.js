import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PREFS,
  normalizePrefs,
  prefsOf,
  resetPrefs,
  retentionWindowFromPrefs,
  updatePrefs,
} from '../src/client/prefs.js'

test('includeTextHeuristic defaults to false, normalizes booleans, and falls back on invalid values', () => {
  assert.equal(DEFAULT_PREFS.includeTextHeuristic, false)
  assert.equal(normalizePrefs({}).includeTextHeuristic, false)
  assert.equal(normalizePrefs({ includeTextHeuristic: true }).includeTextHeuristic, true)
  assert.equal(normalizePrefs({ includeTextHeuristic: false }).includeTextHeuristic, false)
  assert.equal(normalizePrefs({ includeTextHeuristic: 'yes' }).includeTextHeuristic, false)
  assert.equal(normalizePrefs({ includeTextHeuristic: null }).includeTextHeuristic, false)
  assert.equal(normalizePrefs({ includeTextHeuristic: 1 }).includeTextHeuristic, false)
})

test('promptTail defaults to standard and accepts the three coverage presets', () => {
  assert.equal(DEFAULT_PREFS.promptTail, 'standard')
  assert.equal(normalizePrefs({}).promptTail, 'standard')
  for (const preset of ['minimal', 'standard', 'strict']) {
    assert.equal(normalizePrefs({ promptTail: preset }).promptTail, preset)
  }
  assert.equal(normalizePrefs({ promptTail: 'bogus' }).promptTail, 'standard')
})

test('editable A/B/C section texts default, trim, bound and allow empty', () => {
  const defaults = normalizePrefs({})
  assert.equal(defaults.promptTailTextA, DEFAULT_PREFS.promptTailTextA)
  assert.ok(defaults.promptTailTextA.includes('A. 逐条处置'))
  assert.ok(defaults.promptTailTextB.includes('B. 过程播报'))
  assert.ok(defaults.promptTailTextC.includes('C. 收尾'))

  assert.equal(normalizePrefs({ promptTailTextA: '  custom A  ' }).promptTailTextA, 'custom A')
  assert.equal(normalizePrefs({ promptTailTextA: 'line1\nline2' }).promptTailTextA, 'line1\nline2')
  assert.equal(normalizePrefs({ promptTailTextA: '' }).promptTailTextA, '', 'empty means omit')
  assert.equal(normalizePrefs({ promptTailTextB: 42 }).promptTailTextB, DEFAULT_PREFS.promptTailTextB)
  assert.equal(normalizePrefs({ promptTailTextC: 'x'.repeat(5000) }).promptTailTextC.length, 2000)
  assert.equal('verifyCommand' in normalizePrefs({ verifyCommand: 'pnpm test' }), false)
})

test('normalizePrefs provides full fallback for empty or malformed inputs', () => {
  assert.deepEqual(normalizePrefs(null), DEFAULT_PREFS)
  assert.deepEqual(normalizePrefs(undefined), DEFAULT_PREFS)
  assert.deepEqual(normalizePrefs('not an object'), DEFAULT_PREFS)
  assert.deepEqual(normalizePrefs({}), DEFAULT_PREFS)
  assert.deepEqual(prefsOf({}), DEFAULT_PREFS)
})

test('normalizePrefs discards unknown keys including legacy submitMode', () => {
  const raw = {
    submitMode: 'combined',
    unknownField: 123,
    startSessionBehavior: 'auto',
  }
  const result = normalizePrefs(raw)
  assert.equal(result.startSessionBehavior, 'auto')
  assert.equal('submitMode' in result, false)
  assert.equal('unknownField' in result, false)
})

test('normalizePrefs sanitises invalid values back to defaults', () => {
  const bad = {
    startSessionBehavior: 'magic',
    inheritScope: 'universe',
    draftDefaultVisibility: 'private',
    sequentialCostHint: 'never',
    composerRows: 99,
    archivedHistoryHeight: 'infinity',
    lastWorkspace: 12345,
  }
  const result = normalizePrefs(bad)
  assert.equal(result.startSessionBehavior, 'prefill')
  assert.equal(result.inheritScope, 'workspace')
  assert.equal(result.draftDefaultVisibility, 'workspace')
  assert.equal(result.sequentialCostHint, 'threshold')
  assert.equal(result.composerRows, 4)
  assert.equal(result.archivedHistoryHeight, 'half')
  assert.equal(result.lastWorkspace, null)
})

test('normalizePrefs accepts valid values and stringified valid numbers', () => {
  const valid = {
    startSessionBehavior: 'auto',
    inheritScope: 'all',
    draftDefaultVisibility: 'global',
    sequentialCostHint: 'off',
    composerRows: '5',
    archivedHistoryHeight: 'compact',
    lastWorkspace: 'ws-test',
  }
  const result = normalizePrefs(valid)
  assert.equal(result.startSessionBehavior, 'auto')
  assert.equal(result.inheritScope, 'all')
  assert.equal(result.draftDefaultVisibility, 'global')
  assert.equal(result.sequentialCostHint, 'off')
  assert.equal(result.composerRows, 5)
  assert.equal(result.archivedHistoryHeight, 'compact')
  assert.equal(result.lastWorkspace, 'ws-test')
})

test('updatePrefs performs read-modify-write and persists normalized data', async () => {
  let stored = { ...DEFAULT_PREFS, lastWorkspace: 'active-ws' }
  const mockStore = {
    getPrefs: async () => ({ ...stored }),
    setPrefs: async next => {
      stored = { ...next }
    },
  }

  const updated = await updatePrefs(mockStore, { composerRows: 3, sequentialCostHint: 'always' })
  assert.equal(updated.composerRows, 3)
  assert.equal(updated.sequentialCostHint, 'always')
  assert.equal(updated.lastWorkspace, 'active-ws')
  assert.equal(stored.composerRows, 3)
  assert.equal(stored.sequentialCostHint, 'always')
})

test('updatePrefs throws when store is unavailable or setPrefs fails', async () => {
  await assert.rejects(
    async () => updatePrefs(null, { composerRows: 3 }),
    /store\.setPrefs is unavailable/
  )

  const failingStore = {
    getPrefs: async () => ({ ...DEFAULT_PREFS }),
    setPrefs: async () => {
      throw new Error('disk failure')
    },
  }

  await assert.rejects(
    async () => updatePrefs(failingStore, { composerRows: 3 }),
    /disk failure/
  )
})

test('resetPrefs resets user options while preserving lastWorkspace', async () => {
  let stored = {
    startSessionBehavior: 'auto',
    inheritScope: 'all',
    draftDefaultVisibility: 'global',
    sequentialCostHint: 'off',
    composerRows: 5,
    archivedHistoryHeight: 'tall',
    lastWorkspace: 'my-project',
  }

  const mockStore = {
    getPrefs: async () => ({ ...stored }),
    setPrefs: async next => {
      stored = { ...next }
    },
  }

  const reset = await resetPrefs(mockStore)
  assert.equal(reset.startSessionBehavior, 'prefill')
  assert.equal(reset.inheritScope, 'workspace')
  assert.equal(reset.draftDefaultVisibility, 'workspace')
  assert.equal(reset.sequentialCostHint, 'threshold')
  assert.equal(reset.composerRows, 4)
  assert.equal(reset.archivedHistoryHeight, 'half')
  assert.equal(reset.lastWorkspace, 'my-project')
  assert.equal(stored.lastWorkspace, 'my-project')
})

test('retention window clamps to 7–30 days and 200–1000 rows', () => {
  assert.equal(normalizePrefs({}).promptLogRetentionDays, 30)
  assert.equal(normalizePrefs({}).promptLogRetentionRows, 1000)
  assert.equal(normalizePrefs({ promptLogRetentionDays: 1 }).promptLogRetentionDays, 7)
  assert.equal(normalizePrefs({ promptLogRetentionDays: 999 }).promptLogRetentionDays, 30)
  assert.equal(normalizePrefs({ promptLogRetentionRows: 1 }).promptLogRetentionRows, 200)
  assert.equal(normalizePrefs({ promptLogRetentionRows: 10 ** 6 }).promptLogRetentionRows, 1000)
  assert.equal(normalizePrefs({ promptLogRetentionDays: '14' }).promptLogRetentionDays, 14)
  // The shared clamp is what Host and client pruning both consume.
  assert.deepEqual(retentionWindowFromPrefs({ promptLogRetentionDays: 14, promptLogRetentionRows: 300 }), {
    days: 14, rows: 300, maxAgeMs: 14 * 24 * 3600 * 1000, maxCount: 300,
  })
})

test('byte budgets default to 8 KB / 32 KB and clamp into valid ranges', () => {
  assert.equal(DEFAULT_PREFS.promptMaxEntryBytes, 8192)
  assert.equal(DEFAULT_PREFS.promptMaxBytes, 65536)
  assert.equal(normalizePrefs({}).promptMaxEntryBytes, 8192)
  assert.equal(normalizePrefs({}).promptMaxBytes, 65536)
  // Clamped into the allowed ranges.
  assert.equal(normalizePrefs({ promptMaxEntryBytes: 10 }).promptMaxEntryBytes, 1024)
  // Entry is capped by the total budget minus the tail reserve.
  assert.equal(normalizePrefs({ promptMaxEntryBytes: 10 ** 7 }).promptMaxEntryBytes, 65536 - 2048)
  assert.equal(normalizePrefs({ promptMaxBytes: 10 ** 6, promptMaxEntryBytes: 10 ** 7 }).promptMaxEntryBytes, 65536)
  assert.equal(normalizePrefs({ promptMaxBytes: 1 }).promptMaxBytes, 4096)
  assert.equal(normalizePrefs({ promptMaxBytes: 10 ** 8 }).promptMaxBytes, 262144)
  // Entry + tail reserve can never exceed the total budget.
  const tight = normalizePrefs({ promptMaxBytes: 4096, promptMaxEntryBytes: 65536 })
  assert.equal(tight.promptMaxBytes, 4096)
  assert.equal(tight.promptMaxEntryBytes, 4096 - 2048)
  // Non-finite values fall back to defaults.
  assert.equal(normalizePrefs({ promptMaxEntryBytes: 'big' }).promptMaxEntryBytes, 8192)
  assert.equal(normalizePrefs({ promptMaxBytes: Number.NaN }).promptMaxBytes, 65536)
})
