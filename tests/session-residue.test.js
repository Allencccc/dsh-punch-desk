import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostDeskStore } from '../src/store/host.js'
import { createLocalDeskStore } from '../src/store/local.js'
import { isSessionCardVisible, summarizeSession } from '../src/domain/desk.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-session-residue-'))
}

function finding(over = {}) {
  return {
    id: 'f-1',
    kind: 'finding',
    workspaceKey: 'session:session-a',
    sessionId: 'session-a',
    text: 'A finding',
    status: 'open',
    submissionStatus: 'unsubmitted',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function promptRow(over = {}) {
  return {
    messageId: 'm-1',
    sessionId: 'session-b',
    time: 1,
    excerpt: 'A prompt',
    ...over,
  }
}

function memoryStorage() {
  const data = new Map()
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: key => { data.delete(key) },
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size },
  }
}

test('host store forgets a session once its last finding is deleted', async () => {
  const filePath = path.join(tempDir(), 'punch_desk.json')
  const store = createHostDeskStore({ storageFilePath: filePath, now: () => 1 })

  await store.putEntry(finding())
  assert.deepEqual(await store.listWorkspaces(), ['session:session-a'])

  await store.deleteEntry('session:session-a', 'f-1')
  assert.deepEqual(await store.listWorkspaces(), [], 'a deleted session must not survive as a workspace key')

  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(state.entries['session:session-a'], undefined, 'empty entries bucket must be removed')
  assert.equal(state.workspaces.includes('session:session-a'), false, 'stale workspaces slot must be removed')
})

test('host store forgets a session once its last prompt-log row is deleted', async () => {
  const filePath = path.join(tempDir(), 'punch_desk.json')
  const store = createHostDeskStore({ storageFilePath: filePath, now: () => 1 })

  await store.upsertPromptLog('session:session-b', [promptRow()])
  assert.ok((await store.listWorkspaces()).includes('session:session-b'))

  await store.deletePromptLog('session:session-b', 'm-1')
  assert.equal((await store.listWorkspaces()).includes('session:session-b'), false)

  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(state.promptLogs['session:session-b'], undefined)
  assert.equal(state.workspaces.includes('session:session-b'), false)
})

test('host store treats putEntries with zero rows as clearing the session', async () => {
  const filePath = path.join(tempDir(), 'punch_desk.json')
  const store = createHostDeskStore({ storageFilePath: filePath, now: () => 1 })

  await store.putEntry(finding({ id: 'f-2', workspaceKey: 'session:session-c', sessionId: 'session-c' }))
  assert.ok((await store.listWorkspaces()).includes('session:session-c'))

  await store.putEntries('session:session-c', [])
  assert.equal((await store.listWorkspaces()).includes('session:session-c'), false)
  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(state.entries['session:session-c'], undefined)
})

test('host store self-heals empty session residue written by an older build', async () => {
  const filePath = path.join(tempDir(), 'punch_desk.json')
  fs.writeFileSync(filePath, JSON.stringify({
    version: 4,
    workspaceRecords: [],
    workspaces: ['session:session-ghost'],
    groups: {},
    entries: { 'session:session-ghost': [] },
    promptLogs: {},
    commitTraces: {},
    distillRuns: {},
    distillPlans: {},
    distillFingerprints: {},
    handoffs: {},
    prefs: {},
  }), 'utf8')

  const store = createHostDeskStore({ storageFilePath: filePath })
  assert.deepEqual(await store.listWorkspaces(), [], 'a stale empty bucket must not advertise a session')

  const state = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(state.entries['session:session-ghost'], undefined, 'the first read heals the file')
  assert.equal(state.workspaces.includes('session:session-ghost'), false)
})

test('local store index hides a session whose rows were all deleted', async () => {
  const store = createLocalDeskStore({ storage: memoryStorage(), now: () => 1 })

  await store.putEntry(finding({ workspaceKey: 'session:session-l', sessionId: 'session-l' }))
  assert.deepEqual(await store.listWorkspaces(), ['session:session-l'])

  await store.deleteEntry('session:session-l', 'f-1')
  assert.deepEqual(await store.listWorkspaces(), [], 'the client index must mirror the host prune')
})

test('local store index ignores a hydrated empty bucket', async () => {
  const hostStore = {
    exportDump: async () => ({
      entries: { 'session:session-h': [] },
      promptLogs: {},
      commitTraces: {},
      groups: {},
      workspaceRecords: [],
      handoffs: {},
      prefs: {},
      workspaces: ['session:session-h'],
    }),
  }
  const store = createLocalDeskStore({ hostStore })
  await store.whenHydrated()
  assert.deepEqual(await store.listWorkspaces(), [])
})

test('isSessionCardVisible hides residue rows and keeps sessions with data', () => {
  assert.equal(isSessionCardVisible(null), false)
  assert.equal(isSessionCardVisible({ findingCount: 0, entryCount: 0 }), false)
  assert.equal(isSessionCardVisible({ findingCount: 0, entryCount: 0, turns: 0 }), false)
  assert.equal(isSessionCardVisible({ findingCount: 1, entryCount: 1 }), true)
  assert.equal(isSessionCardVisible({ findingCount: 0, entryCount: 0, turns: 3 }), true)
  assert.equal(
    isSessionCardVisible(summarizeSession('session:s', [], [{ messageId: 'm', turn: 2 }], [])),
    true,
    'a session known only from backfilled prompts stays visible',
  )
  assert.equal(
    isSessionCardVisible(summarizeSession('session:s', [], [], [])),
    false,
    'an empty session summary is residue',
  )
})
