import test from 'node:test'
import assert from 'node:assert/strict'
import { MARKDOWN_MIME, downloadText } from '../src/client/ui/export.js'

test('downloadText builds a Blob, clicks an anchor, and cleans up', () => {
  const revoked = []
  let appended = null
  const anchor = {
    click() {
      assert.equal(this.href, 'blob:1')
      assert.equal(this.download, 'digest.md')
    },
    remove() {
      this.removed = true
    },
  }
  class FakeBlob {
    constructor(parts, options) {
      this.parts = parts
      this.type = options?.type
    }
  }
  const doc = {
    createElement(tag) {
      assert.equal(tag, 'a')
      return anchor
    },
    body: { appendChild(node) { appended = node } },
  }
  const url = {
    createObjectURL(blob) {
      assert.deepEqual(blob.parts, ['# hi'])
      assert.equal(blob.type, MARKDOWN_MIME)
      return 'blob:1'
    },
    revokeObjectURL(value) {
      revoked.push(value)
    },
  }

  const ok = downloadText({
    filename: 'digest.md', text: '# hi', mime: MARKDOWN_MIME, doc, url, BlobCtor: FakeBlob,
    schedule: fn => fn(),
  })
  assert.equal(ok, true)
  assert.equal(appended, anchor)
  assert.equal(anchor.removed, true)
  assert.deepEqual(revoked, ['blob:1'])
})

test('downloadText defers the object-URL revoke until after the click', () => {
  const revoked = []
  let release = null
  const anchor = { click() {}, remove() {} }
  const doc = { createElement: () => anchor, body: { appendChild() {} } }
  const url = {
    createObjectURL: () => 'blob:1',
    revokeObjectURL(value) {
      revoked.push(value)
    },
  }
  const ok = downloadText({
    filename: 'digest.md',
    text: '# hi',
    doc,
    url,
    BlobCtor: class {},
    schedule: fn => { release = fn },
  })
  assert.equal(ok, true)
  // Revoking in the same tick can cancel a browser download.
  assert.deepEqual(revoked, [])
  release()
  assert.deepEqual(revoked, ['blob:1'])
})

test('downloadText returns false instead of throwing when the browser cannot download', () => {
  assert.equal(downloadText({ filename: 'x.md', text: 'x' }), false)
  assert.equal(downloadText({ filename: '', text: 'x', doc: {}, url: {}, BlobCtor: class {} }), false)
  assert.equal(downloadText({ filename: 'x', text: 'x', doc: { createElement: () => ({}) }, url: { createObjectURL: () => 'blob:1' }, BlobCtor: class {} }), false)
  assert.equal(downloadText({
    filename: 'x', text: 'x',
    doc: { createElement: () => ({}) },
    url: { createObjectURL: () => { throw new Error('no') } },
    BlobCtor: class {},
  }), false)
})
