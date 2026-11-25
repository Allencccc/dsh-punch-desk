/**
 * Desk engineering analytics domain model: pure data, no I/O.
 *
 * Migrated verbatim from the retired `src/domain/retrospective.js` (Task 4.2,
 * spec §15 ③): this calculator has nothing to do with distillation write-back,
 * so it keeps its own module instead of joining the distill domain.
 */

/**
 * Calculate engineering metrics and spec conversion statistics.
 *
 * Metrics definitions:
 * - Hand账分类占比 (tag distribution): optimize, refactor, blocker, context
 * - 会话经过轮次阶梯 (turn ladder): 1-5, 6-15, 16-30, 30+
 * - 规范沉淀转化率 (conversion rate): settledRules / Math.max(1, totalTurns) * 100%
 *
 * @param {object} params
 * @param {object[]} params.findings
 * @param {object[]} params.sessions
 * @param {object[]} [params.promptLogs]
 * @returns {{
 *   totalFindings: number,
 *   resolvedFindings: number,
 *   resolvedRatio: number,
 *   tagCounts: Record<string, number>,
 *   tagPercentages: Record<string, number>,
 *   turnsDistribution: Record<string, number>,
 *   totalTurns: number,
 *   conversionRate: number,
 * }} analytics results
 */
export function computeAnalytics({ findings = [], sessions = [], promptLogs = [] }) {
  const safeFindings = Array.isArray(findings) ? findings : []
  const safeSessions = Array.isArray(sessions) ? sessions : []
  const safeLogs = Array.isArray(promptLogs) ? promptLogs : []

  // Tag distribution: seed the four preset keys (stable zero rows) and let
  // any custom tag add its own bucket instead of collapsing into `optimize`.
  const tagCounts = {
    optimize: 0,
    refactor: 0,
    blocker: 0,
    context: 0,
  }

  let resolvedFindings = 0
  for (const f of safeFindings) {
    if (!f) continue
    const tag = typeof f.tag === 'string' && f.tag.trim() !== '' ? f.tag.trim() : 'optimize'
    tagCounts[tag] = (tagCounts[tag] || 0) + 1
    if (f.reviewStatus === 'resolved' || f.status === 'resolved') {
      resolvedFindings += 1
    }
  }

  const totalFindings = safeFindings.length
  const tagPercentages = {}
  for (const [tag, count] of Object.entries(tagCounts)) {
    tagPercentages[tag] = totalFindings > 0 ? Math.round((count / totalFindings) * 100) : 0
  }

  // Session elapsed turns ladder
  const turnsDistribution = {
    '1-5': 0,
    '6-15': 0,
    '16-30': 0,
    '30+': 0,
  }

  let totalTurns = 0
  for (const s of safeSessions) {
    if (!s) continue
    const turns = typeof s.turns === 'number' ? s.turns : (typeof s.promptCount === 'number' ? s.promptCount : 1)
    totalTurns += turns
    if (turns <= 5) turnsDistribution['1-5'] += 1
    else if (turns <= 15) turnsDistribution['6-15'] += 1
    else if (turns <= 30) turnsDistribution['16-30'] += 1
    else turnsDistribution['30+'] += 1
  }

  if (totalTurns === 0 && safeLogs.length > 0) {
    totalTurns = safeLogs.length
  }

  // Spec conversion rate: settled findings / max(1, totalTurns) * 100
  const effectiveTurns = Math.max(1, totalTurns)
  const conversionRate = Math.min(100, Math.round((resolvedFindings / effectiveTurns) * 1000) / 10)
  const resolvedRatio = totalFindings > 0 ? Math.round((resolvedFindings / totalFindings) * 100) : 0

  return {
    totalFindings,
    resolvedFindings,
    resolvedRatio,
    tagCounts,
    tagPercentages,
    turnsDistribution,
    totalTurns,
    conversionRate,
  }
}
