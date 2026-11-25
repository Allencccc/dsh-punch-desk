/** Desk export helpers: trigger a browser download for generated Markdown. */

export const MARKDOWN_MIME = 'text/markdown;charset=utf-8'

/**
 * Build a Blob, click a temporary anchor and clean up. Returns false instead of
 * throwing so the caller can surface a retryable notice.
 *
 * @param {{
 *   filename: string,
 *   text: string,
 *   mime?: string,
 *   doc?: object,
 *   url?: object,
 *   BlobCtor?: Function,
 *   schedule?: Function,
 * }} input
 * @returns {boolean}
 */
export function downloadText({
  filename,
  text,
  mime = 'text/plain;charset=utf-8',
  doc = globalThis.document,
  url = globalThis.URL,
  BlobCtor = globalThis.Blob,
  schedule = globalThis.setTimeout,
} = {}) {
  if (typeof filename !== 'string' || filename === '' || typeof text !== 'string') return false
  if (!doc || typeof doc.createElement !== 'function' || typeof BlobCtor !== 'function') return false
  if (!url || typeof url.createObjectURL !== 'function') return false
  let objectUrl = ''
  let anchor = null
  try {
    objectUrl = url.createObjectURL(new BlobCtor([text], { type: mime }))
    anchor = doc.createElement('a')
    anchor.href = objectUrl
    anchor.download = filename
    anchor.rel = 'noopener'
    if (anchor.style) anchor.style.display = 'none'
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(anchor)
    if (typeof anchor.click !== 'function') return false
    anchor.click()
    return true
  } catch {
    return false
  } finally {
    try {
      if (anchor && typeof anchor.remove === 'function') anchor.remove()
    } catch {
      // A cleanup failure must not mask the download result.
    }
    if (objectUrl !== '' && typeof url.revokeObjectURL === 'function') {
      const revoke = () => {
        try {
          url.revokeObjectURL(objectUrl)
        } catch {
          // Revocation is best-effort.
        }
      }
      // Revoking in the same tick can cancel the download in some browsers, so
      // hand the URL back once the click has been dispatched.
      let deferred = false
      if (typeof schedule === 'function') {
        try {
          schedule(revoke, 0)
          deferred = true
        } catch {
          // Fall through to the synchronous revoke.
        }
      }
      if (!deferred) revoke()
    }
  }
}
