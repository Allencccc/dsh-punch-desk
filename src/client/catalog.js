/**
 * Built-in trigger catalog — single source of truth (P1-8).
 *
 * Both consumers read this module:
 *   - factory.js listCommands/listSkills  → host-facing completion items
 *   - session-pane.js DEFAULT_SLASH_*     → in-pane "/" and "$" triggers
 *
 * Descriptions live in src/locale.js under the existing `mention.command.<name>`
 * / `mention.skill.<name>` keys (zh/en pairs), so the same entry renders in both
 * languages without duplicating Chinese literals in code.
 */

/** @typedef {{ name: string, descKey: string }} CatalogEntry */

/** @type {CatalogEntry[]} */
export const COMMAND_CATALOG = [
  { name: 'plan', descKey: 'mention.command.plan' },
  { name: 'goal', descKey: 'mention.command.goal' },
  { name: 'boost', descKey: 'mention.command.boost' },
  { name: 'browser', descKey: 'mention.command.browser' },
  { name: 'schedule', descKey: 'mention.command.schedule' },
  { name: 'compact', descKey: 'mention.command.compact' },
  { name: 'learn', descKey: 'mention.command.learn' },
  { name: 'teamwork', descKey: 'mention.command.teamwork' },
  { name: 'grill-me', descKey: 'mention.command.grill-me' },
  { name: 'model', descKey: 'mention.command.model' },
  { name: 'clear', descKey: 'mention.command.clear' },
]

/** @type {CatalogEntry[]} */
export const SKILL_CATALOG = [
  { name: 'modern-web-guidance', descKey: 'mention.skill.modern-web-guidance' },
  { name: 'design-taste-frontend', descKey: 'mention.skill.design-taste-frontend' },
  { name: 'lightweight-charts', descKey: 'mention.skill.lightweight-charts' },
  { name: 'chrome-devtools', descKey: 'mention.skill.chrome-devtools' },
  { name: 'chrome-extensions', descKey: 'mention.skill.chrome-extensions' },
  { name: 'firebase-firestore', descKey: 'mention.skill.firebase-firestore' },
  { name: 'a11y-debugging', descKey: 'mention.skill.a11y-debugging' },
  { name: 'memory-leak-debugging', descKey: 'mention.skill.memory-leak-debugging' },
  { name: 'debug-optimize-lcp', descKey: 'mention.skill.debug-optimize-lcp' },
  { name: 'pua', descKey: 'mention.skill.pua' },
  { name: 'use-superpowers', descKey: 'mention.skill.use-superpowers' },
  { name: 'automation', descKey: 'mention.skill.automation' },
  { name: 'generative_ui', descKey: 'mention.skill.generative_ui' },
  { name: 'find-skills', descKey: 'mention.skill.find-skills' },
  { name: 'guizang-ppt-skill', descKey: 'mention.skill.guizang-ppt-skill' },
  { name: 'guizang-social-card-skill', descKey: 'mention.skill.guizang-social-card-skill' },
  { name: 'guizang-page-skill', descKey: 'mention.skill.guizang-page-skill' },
  { name: 'literature-search-arxiv', descKey: 'mention.skill.literature-search-arxiv' },
  { name: 'biomolecular-structure-viewer', descKey: 'mention.skill.biomolecular-structure-viewer' },
]

/**
 * Items for the host completion services (description resolved through locale).
 * @param {CatalogEntry[]} entries
 * @param {(key: string) => string} t
 * @returns {{ name: string, label: string, description: string, insert: string }[]}
 */
export function toCatalogItems(entries, t) {
  return entries.map(entry => ({
    name: entry.name,
    label: `/${entry.name}`,
    description: t(entry.descKey),
    insert: `/${entry.name} `,
  }))
}

/**
 * Trigger items that keep the locale key so the pane can resolve it lazily.
 * @param {CatalogEntry[]} entries
 * @returns {{ name: string, label: string, descKey: string, insert: string }[]}
 */
export function toTriggerItems(entries) {
  return entries.map(entry => ({
    name: entry.name,
    label: `/${entry.name}`,
    descKey: entry.descKey,
    insert: `/${entry.name} `,
  }))
}
