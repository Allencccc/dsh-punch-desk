/**
 * Git client API for Punch Desk.
 * Consumes Host routes:
 * - GET api/punch-desk/git-head?workspaceId=...
 * - GET api/punch-desk/git-commit-range?workspaceId=...&from=...&to=...
 * - GET api/punch-desk/commit-trace-lookup?workspaceId=...&hash=...
 */

function makeError(status, error, detail) {
  const err = new Error(error || `HTTP ${status}`)
  err.status = status
  err.error = error
  if (detail) err.detail = detail
  return err
}

export function createGitApi({ fetch = globalThis.fetch } = {}) {
  return {
    async head(workspaceId) {
      if (!workspaceId) throw makeError(400, 'Missing workspaceId')
      const qs = new URLSearchParams({ workspaceId: String(workspaceId) })
      const res = await fetch(`api/punch-desk/git-head?${qs}`)
      let data
      try {
        data = await res.json()
      } catch {
        throw makeError(res.status, res.statusText || 'parse-error')
      }
      if (!res.ok || !data || data.ok === false) {
        throw makeError(data?.status || res.status, data?.error || res.statusText || 'head-failed')
      }
      return {
        ok: true,
        isRepo: Boolean(data.isRepo),
        ...(data.gitBranch ? { gitBranch: data.gitBranch } : {}),
        ...(data.gitHead ? { gitHead: data.gitHead } : {}),
      }
    },

    async range(workspaceId, from, to) {
      if (!workspaceId) throw makeError(400, 'Missing workspaceId')
      if (!from || !to) throw makeError(400, 'Missing from or to commit')
      const qs = new URLSearchParams({
        workspaceId: String(workspaceId),
        from: String(from),
        to: String(to),
      })
      const res = await fetch(`api/punch-desk/git-commit-range?${qs}`)
      let data
      try {
        data = await res.json()
      } catch {
        throw makeError(res.status, res.statusText || 'parse-error')
      }
      if (!res.ok || !data || data.ok === false) {
        throw makeError(data?.status || res.status, data?.error || res.statusText || 'range-failed', data?.detail)
      }
      return {
        ok: true,
        truncated: Boolean(data.truncated),
        commits: Array.isArray(data.commits) ? data.commits : [],
        from: data.from ?? from,
        to: data.to ?? to,
      }
    },

    async lookup(workspaceId, hash, limit = 20) {
      if (!workspaceId) throw makeError(400, 'Missing workspaceId')
      if (!hash) throw makeError(400, 'Missing hash')
      const qs = new URLSearchParams({
        workspaceId: String(workspaceId),
        hash: String(hash),
        limit: String(limit),
      })
      const res = await fetch(`api/punch-desk/commit-trace-lookup?${qs}`)
      let data
      try {
        data = await res.json()
      } catch {
        throw makeError(res.status, res.statusText || 'parse-error')
      }
      if (!res.ok || !data || data.ok === false) {
        throw makeError(data?.status || res.status, data?.error || res.statusText || 'lookup-failed')
      }
      return {
        ok: true,
        matches: Array.isArray(data.matches) ? data.matches : [],
      }
    },
  }
}
