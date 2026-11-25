/**
 * Nord Design System & DSH Theme Token Integration
 *
 * Implements the Nord 16-color palette (Polar Night, Snow Storm, Frost, Aurora)
 * and semantic mappings to host `--dsw-alias-*` tokens for Punch Desk v2.0.
 *
 * Strictly NO Tailwind color names or classes allowed.
 */

/**
 * Complete Nord 16-color palette constants.
 * @see https://www.nordtheme.com/docs/colors-and-palettes
 */
export const NORD = Object.freeze({
  // Polar Night (Dark neutral base)
  nord0: '#2e3440',
  nord1: '#3b4252',
  nord2: '#434c5e',
  nord3: '#4c566a',

  // Snow Storm (Light neutral text & surfaces)
  nord4: '#d8dee9',
  nord5: '#e5e9f0',
  nord6: '#eceff4',

  // Frost (Cool accent & brand accents)
  nord7: '#8fbcbb',
  nord8: '#88c0d0',
  nord9: '#81a1c1',
  nord10: '#5e81ac',

  // Aurora (Semantic status & category colors)
  nord11: '#bf616a',
  nord12: '#d08770',
  nord13: '#ebcb8b',
  nord14: '#a3be8c',
  nord15: '#b48ead',
})

export const {
  nord0, nord1, nord2, nord3,
  nord4, nord5, nord6,
  nord7, nord8, nord9, nord10,
  nord11, nord12, nord13, nord14, nord15,
} = NORD

/**
 * Palette groupings for inspection and modular theming.
 */
export const POLAR_NIGHT = Object.freeze([nord0, nord1, nord2, nord3])
export const SNOW_STORM = Object.freeze([nord4, nord5, nord6])
export const FROST = Object.freeze([nord7, nord8, nord9, nord10])
export const AURORA = Object.freeze([nord11, nord12, nord13, nord14, nord15])

/**
 * Semantic mappings to `--dsw-alias-*` host design tokens.
 * Fallbacks to canonical Nord colors ensure reliable rendering across environments.
 */
export const SEMANTIC_TOKENS = Object.freeze({
  // Surfaces & Backgrounds
  surfaceCanvas: 'var(--dsw-alias-bg-base, #242933)',
  surfaceCard: 'var(--dsw-alias-bg-layer-1, #2e3440)',
  surfacePanel: 'var(--dsw-alias-bg-layer-2, #3b4252)',
  surfaceHover: 'var(--dsw-alias-interactive-bg-hover, rgba(59, 66, 82, 0.6))',
  surfaceActive: 'var(--dsw-alias-interactive-bg-active, #434c5e)',

  // Borders
  borderDefault: 'var(--dsw-alias-border-l1, #434c5e)',
  borderSubtle: 'var(--dsw-alias-border-l2, #4c566a)',

  // Typography
  textPrimary: 'var(--dsw-alias-label-primary, #eceff4)',
  textSecondary: 'var(--dsw-alias-label-secondary, #d8dee9)',
  textTertiary: 'var(--dsw-alias-label-tertiary, #4c566a)',
  textInverted: 'var(--dsw-alias-label-primary-inverted, #2e3440)',

  // Buttons & Interactions
  buttonPrimaryFill: 'var(--dsw-alias-button-primary-fill, #88c0d0)',
  buttonDefaultFill: 'var(--dsw-alias-bg-layer-2, #3b4252)',

  // Semantic Status Tones
  primary: 'var(--dsw-alias-state-business-primary, #88c0d0)',
  success: 'var(--dsw-alias-state-success-primary, #a3be8c)',
  warning: 'var(--dsw-alias-state-warn-primary, #d08770)',
  danger: 'var(--dsw-alias-state-error-primary, #bf616a)',
  info: 'var(--dsw-alias-state-business-primary, #81a1c1)',
})

/**
 * Finding tag category color mapping per v2.0 spec.
 * - optimize: nord8 (Frost ice blue)
 * - refactor: nord15 (Aurora purple)
 * - context: nord13 (Aurora amber)
 * - blocker: nord11 (Aurora red)
 */
export const TAG_COLORS = Object.freeze({
  optimize: nord8,
  refactor: nord15,
  context: nord13,
  blocker: nord11,
})

/**
 * Palette for user-defined tags (up to 6). Assigning by catalog index keeps
 * colors stable while the tag exists; presets keep their documented colors.
 */
export const CUSTOM_TAG_COLORS = Object.freeze([nord9, nord12, nord14, nord7, nord10, nord15])

/** Palette offered when a user picks a color for a custom tag (Nord only). */
export const TAG_COLOR_CHOICES = Object.freeze([nord8, nord9, nord10, nord7, nord12, nord14, nord11, nord15])

/**
 * Finding severity color mapping per v2.0 spec and plan.
 * - blocker: nord11 (Aurora red)
 * - major: nord12 (Aurora orange)
 * - minor: nord14 (Aurora green)
 * - question: nord13 (Aurora yellow)
 * - idea: nord13 (Aurora yellow)
 */
export const SEVERITY_COLORS = Object.freeze({
  blocker: nord11,
  major: nord12,
  minor: nord14,
  question: nord13,
  idea: nord13,
})

/**
 * Task and Group execution status color mapping.
 * - running: nord12 (legacy spinner base; the running UI indicator now uses --pd-status-running)
 * - queued: nord13 (Aurora yellow circle)
 * - executed / resolved: nord14 (Aurora green check)
 * - dismissed: nord3 (Polar night subtle)
 */
export const STATUS_COLORS = Object.freeze({
  running: nord12,
  queued: nord13,
  executed: nord14,
  resolved: nord14,
  dismissed: nord3,
})

export const PUNCH_DESK_STYLE_ID = 'dsh-punch-desk-theme-styles'

export const PUNCH_DESK_THEME_CSS = `
/* Punch Desk Adaptive Theme Tokens for Light & Dark mode */
:root,
body {
  --pd-text-primary: var(--dsw-alias-label-primary, #2e3440);
  --pd-text-secondary: var(--dsw-alias-label-secondary, #4c566a);
  --pd-text-tertiary: var(--dsw-alias-label-tertiary, #4c566a);
  --pd-bg-base: var(--dsw-alias-bg-base, #ffffff);
  --pd-bg-card: var(--dsw-alias-bg-layer-1, #ffffff);
  --pd-bg-surface: var(--dsw-alias-bg-base, #eceff4);
  --pd-bg-panel: var(--dsw-alias-bg-layer-2, #e5e9f0);
  --pd-bg-floating: var(--dsw-alias-bg-overlay, #ffffff);
  --pd-border-default: var(--dsw-alias-border-l1, #d8dee9);
  --pd-border-subtle: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  --pd-accent: var(--dsw-alias-button-primary-fill, #5e81ac);
  --pd-accent-fg: var(--dsw-alias-label-primary-inverted, #ffffff);
  /* Status dots/text must stay semantic Nord colours: the host accent token can
     resolve to white, which made the breathing dot and count invisible. */
  --pd-status-running: #0e9f4f;   /* high-saturation forest green — in-flight (light) */
  --pd-status-running-text: #0a6b36; /* readable green for 9–11px text (light) */
  --pd-status-warn-text: #7a5a00;  /* readable amber for 9–11px text (light) */
  --pd-status-muted: #4c566a;     /* settled / ignored dot (light) */
  --pd-status-warn: #ebcb8b;      /* Nord Aurora yellow — awaiting wrap-up */
  --pd-status-idle: #5e81ac;      /* Nord Frost blue — idle accent */
  --pd-card-focused-bg: linear-gradient(135deg, rgba(136, 192, 208, 0.22) 0%, rgba(129, 161, 193, 0.12) 100%);
  --pd-card-focused-border: 1.5px solid var(--dsw-alias-button-primary-fill, #5e81ac);
  --pd-card-focused-shadow: 0 4px 14px rgba(94, 129, 172, 0.18), 0 0 1px #5e81ac;
  --pd-card-focused-title: var(--dsw-alias-button-primary-fill, #5e81ac);
  --pd-card-focused-title-shadow: none;
  --pd-merge-btn-solid-bg: linear-gradient(135deg, #5e81ac 0%, #81a1c1 100%);
  --pd-merge-btn-solid-fg: #ffffff;
  --pd-merge-btn-solid-border: 1px solid #4c709e;
  --pd-merge-btn-solid-shadow: 0 2px 8px rgba(94, 129, 172, 0.35);
  --pd-merge-btn-disabled-bg: rgba(0, 0, 0, 0.04);
  --pd-merge-btn-disabled-border: 1px solid rgba(0, 0, 0, 0.12);
  --pd-merge-btn-disabled-fg: var(--dsw-alias-label-secondary, #434c5e);
  --pd-popover-item-hover: var(--dsw-alias-interactive-bg-hover, #d8dee9);
  --pd-popover-item-active-fg: var(--dsw-alias-button-primary-fill, #5e81ac);

  /* Tag Badges - Light Mode: Nord Frost / Aurora only (no Tailwind palette). */
  --pd-tag-optimize-fg: #5e81ac;
  --pd-tag-optimize-bg: rgba(94, 129, 172, 0.12);
  --pd-tag-optimize-border: rgba(94, 129, 172, 0.38);

  --pd-tag-blocker-fg: #bf616a;
  --pd-tag-blocker-bg: rgba(191, 97, 106, 0.12);
  --pd-tag-blocker-border: rgba(191, 97, 106, 0.38);

  --pd-tag-refactor-fg: #b48ead;
  --pd-tag-refactor-bg: rgba(180, 142, 173, 0.12);
  --pd-tag-refactor-border: rgba(180, 142, 173, 0.38);

  --pd-tag-context-fg: #d08770;
  --pd-tag-context-bg: rgba(208, 135, 112, 0.12);
  --pd-tag-context-border: rgba(208, 135, 112, 0.38);
}

body[data-ds-dark-theme],
[data-ds-dark-theme],
html[data-pd-dark],
html[style*="color-scheme: dark"],
html.dark, body.dark, .dark, [data-theme="dark"] {
  --pd-text-primary: var(--dsw-alias-label-primary, #eceff4);
  --pd-status-running: #22c55e;   /* high-saturation forest green — in-flight (dark) */
  --pd-status-running-text: #22c55e; /* readable green for 9–11px text (dark) */
  --pd-status-warn-text: #ebcb8b;  /* readable amber for 9–11px text (dark) */
  --pd-status-muted: #81a1c1;     /* settled / ignored dot (dark) */
  --pd-text-secondary: var(--dsw-alias-label-secondary, #d8dee9);
  --pd-text-tertiary: var(--dsw-alias-label-tertiary, #4c566a);
  --pd-bg-base: var(--dsw-alias-bg-base, #1e222a);
  --pd-bg-card: var(--dsw-alias-bg-layer-1, #242933);
  --pd-bg-surface: var(--dsw-alias-bg-base, #1e222a);
  --pd-bg-panel: var(--dsw-alias-bg-layer-2, #2e3440);
  --pd-bg-floating: var(--dsw-alias-bg-overlay, #242933);
  --pd-border-default: var(--dsw-alias-border-l1, #434c5e);
  --pd-border-subtle: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.08));
  --pd-accent: var(--dsw-alias-button-primary-fill, #88c0d0);
  --pd-accent-fg: var(--dsw-alias-label-primary-inverted, #242933);
  --pd-card-focused-bg: linear-gradient(135deg, rgba(136, 192, 208, 0.20) 0%, rgba(94, 129, 172, 0.14) 50%, rgba(180, 142, 173, 0.22) 100%);
  --pd-card-focused-border: 1.5px solid #88c0d0;
  --pd-card-focused-shadow: 0 0 16px rgba(136, 192, 208, 0.45), 0 0 2px #88c0d0, inset 0 0 14px rgba(136, 192, 208, 0.12);
  --pd-card-focused-title: #88c0d0;
  --pd-card-focused-title-shadow: 0 0 10px rgba(136, 192, 208, 0.7);
  --pd-merge-btn-solid-bg: linear-gradient(135deg, #88c0d0 0%, #81a1c1 100%);
  --pd-merge-btn-solid-fg: #242933;
  --pd-merge-btn-solid-border: 1px solid #8fbcbb;
  --pd-merge-btn-solid-shadow: 0 0 14px rgba(136, 192, 208, 0.6), 0 2px 6px rgba(0, 0, 0, 0.35);
  --pd-merge-btn-disabled-bg: rgba(255, 255, 255, 0.06);
  --pd-merge-btn-disabled-border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.20));
  --pd-merge-btn-disabled-fg: var(--dsw-alias-label-secondary, #d8dee9);
  --pd-popover-item-hover: var(--dsw-alias-interactive-bg-hover, #3b4252);
  --pd-popover-item-active-fg: var(--dsw-alias-button-primary-fill, #88c0d0);

  /* Tag Badges - Dark Mode: luminous, vibrant Nord tones */
  --pd-tag-optimize-fg: #88c0d0;
  --pd-tag-optimize-bg: rgba(136, 192, 208, 0.18);
  --pd-tag-optimize-border: rgba(136, 192, 208, 0.45);

  --pd-tag-blocker-fg: #bf616a;
  --pd-tag-blocker-bg: rgba(191, 97, 106, 0.20);
  --pd-tag-blocker-border: rgba(191, 97, 106, 0.50);

  --pd-tag-refactor-fg: #b48ead;
  --pd-tag-refactor-bg: rgba(180, 142, 173, 0.20);
  --pd-tag-refactor-border: rgba(180, 142, 173, 0.50);

  --pd-tag-context-fg: #ebcb8b;
  --pd-tag-context-bg: rgba(235, 203, 139, 0.20);
  --pd-tag-context-border: rgba(235, 203, 139, 0.50);
}

/* Execution breathing dot: running batches must be visible in the header/dock. */
@keyframes pd-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.85); }
}
.pd-breathe { animation: pd-breathe 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .pd-breathe { animation: none; }
}

/* Composer glow (easter egg, code-only by request — do not document it).
   Fires live while the composer body contains the marker. Rainbow flashing is a
   deliberate user-requested exception to the Nord-only rule and is scoped to
   this input border/glow only. */
@keyframes pd-neon {
  0% { border-color: #ff3b30; box-shadow: 0 0 4px #ff3b30, 0 0 12px rgba(255, 59, 48, 0.55); }
  17% { border-color: #ff9500; box-shadow: 0 0 4px #ff9500, 0 0 12px rgba(255, 149, 0, 0.55); }
  33% { border-color: #ffcc00; box-shadow: 0 0 4px #ffcc00, 0 0 12px rgba(255, 204, 0, 0.55); }
  50% { border-color: #34c759; box-shadow: 0 0 4px #34c759, 0 0 12px rgba(52, 199, 89, 0.55); }
  67% { border-color: #00c7ff; box-shadow: 0 0 4px #00c7ff, 0 0 12px rgba(0, 199, 255, 0.55); }
  83% { border-color: #5856d6; box-shadow: 0 0 4px #5856d6, 0 0 12px rgba(88, 86, 214, 0.55); }
  100% { border-color: #ff3b30; box-shadow: 0 0 4px #ff3b30, 0 0 12px rgba(255, 59, 48, 0.55); }
}
.pd-neon { animation: pd-neon 2.4s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .pd-neon { animation: none; border-color: #00c7ff; box-shadow: 0 0 0 1px #00c7ff; }
}

@keyframes ph-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`

/**
 * Injects Punch Desk adaptive theme CSS styles into document head.
 * Completely idempotent and SSR-safe.
 */
export function injectPunchDeskStyles() {
  if (typeof document === 'undefined') return
  try {
    const existing = document.getElementById(PUNCH_DESK_STYLE_ID)
    if (!existing) {
      const styleEl = document.createElement('style')
      styleEl.id = PUNCH_DESK_STYLE_ID
      styleEl.textContent = PUNCH_DESK_THEME_CSS
      document.head.appendChild(styleEl)
    } else if (existing.textContent !== PUNCH_DESK_THEME_CSS) {
      // A client-plugin remount/HMR (or a bundle upgrade without a full page
      // reload) reuses the previous <style> element. Skipping the update kept
      // old CSS alive — new keyframes (e.g. pd-breathe) never applied.
      existing.textContent = PUNCH_DESK_THEME_CSS
    }
  } catch {}

  // Reactive theme observer ensuring instant mode switching on DSH theme toggling
  if (typeof window !== 'undefined' && typeof MutationObserver !== 'undefined' && document.body) {
    if (!window.__pd_theme_observer_attached__) {
      window.__pd_theme_observer_attached__ = true
      const syncTheme = () => {
        try {
          const bodyHasDark = !!(typeof document.body?.hasAttribute === 'function' && document.body.hasAttribute('data-ds-dark-theme'))
          const htmlDark = !!(
            document.documentElement?.style?.colorScheme === 'dark' ||
            (typeof document.documentElement?.getAttribute === 'function' && document.documentElement.getAttribute('data-theme') === 'dark')
          )
          const systemDark = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches
          const hasExplicitScheme = !!(document.documentElement?.style?.colorScheme || bodyHasDark)
          const isDark = bodyHasDark || htmlDark || (!hasExplicitScheme && systemDark)
          if (typeof document.documentElement?.toggleAttribute === 'function') {
            document.documentElement.toggleAttribute('data-pd-dark', !!isDark)
          }
        } catch {}
      }
      syncTheme()
      try {
        const observer = new MutationObserver(syncTheme)
        if (document.body) {
          observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] })
        }
        if (document.documentElement) {
          observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] })
        }
        if (typeof matchMedia !== 'undefined') {
          const media = matchMedia('(prefers-color-scheme: dark)')
          if (media.addEventListener) {
            media.addEventListener('change', syncTheme)
          }
        }
      } catch {}
    }
  }
}

/**
 * Retrieve the color for a finding severity level.
 * @param {string} severity
 * @returns {string} Hex color code
 */
export function getSeverityColor(severity) {
  if (typeof severity !== 'string') return nord4
  const key = severity.toLowerCase().trim()
  return SEVERITY_COLORS[key] ?? nord4
}

/**
 * Normalizes any tag input into one of the canonical 4 tag keys:
 * 'optimize' | 'blocker' | 'refactor' | 'context'
 *
 * @param {string} tag
 * @returns {'optimize'|'blocker'|'refactor'|'context'}
 */
/**
 * Resolve legacy aliases without collapsing unknown keys, so custom tags can
 * keep their own identity (and their own CSS variable namespace).
 * @param {string} tag
 * @returns {string}
 */
function aliasTagKey(tag) {
  if (typeof tag !== 'string') return ''
  const key = tag.toLowerCase().replace(/^#+/, '').trim()
  if (key === '问题' || key === '卡点' || key === 'bug' || key === 'issue' || key === 'blocker') return 'blocker'
  if (key === '重构' || key === 'refactor') return 'refactor'
  if (key === '上下文' || key === 'context') return 'context'
  if (key === '优化' || key === 'optimize' || key === 'feature') return 'optimize'
  return key
}

export function normalizeTagKey(tag) {
  const key = aliasTagKey(tag)
  return key in TAG_COLORS ? key : 'optimize'
}

/**
 * Retrieve the color for a finding tag.
 * @param {string} tag
 * @returns {string} Hex color code
 */
export function getTagColor(tag, customIndex = -1, explicitColor = '') {
  const key = aliasTagKey(tag)
  if (key in TAG_COLORS) return TAG_COLORS[key]
  if (typeof explicitColor === 'string' && /^#[0-9a-f]{6}$/i.test(explicitColor.trim())) {
    return explicitColor.trim().toLowerCase()
  }
  if (Number.isInteger(customIndex) && customIndex >= 0) {
    return CUSTOM_TAG_COLORS[customIndex % CUSTOM_TAG_COLORS.length]
  }
  return nord8
}

/**
 * Formats an explicit label (no locale lookup). Used for user-defined tags where
 * the label is content, and for preset labels stored in the catalog.
 * @param {string} label
 * @returns {string}
 */
export function formatTagLabel(label) {
  const clean = String(label ?? '').replace(/^#+/, '').trim()
  return `#${clean}`
}

/**
 * Formats a tag string ensuring exactly one '#' prefix and localized text.
 * Avoids accidental '##tag' when the locale definition already contains '#'.
 *
 * @param {string} tag
 * @param {(key: string) => string} [t] Optional translator function
 * @returns {string} Formatted tag label (e.g. '#优化', '#问题')
 */
export function formatTagText(tag, t) {
  const key = normalizeTagKey(tag)
  const translated = typeof t === 'function' ? t(`tag.${key}`) : key
  const clean = String(translated || key).replace(/^#+/, '').trim()
  return `#${clean}`
}

/**
 * Retrieve the color for a task or group status.
 * @param {string} status
 * @returns {string} Hex color code
 */
export function getStatusColor(status) {
  if (typeof status !== 'string') return nord3
  const key = status.toLowerCase().trim()
  return STATUS_COLORS[key] ?? nord3
}

/**
 * Retrieve a semantic design token by key with safe fallback.
 * @param {keyof typeof SEMANTIC_TOKENS} tokenName
 * @param {string} [fallback]
 * @returns {string}
 */
export function getThemeToken(tokenName, fallback) {
  return SEMANTIC_TOKENS[tokenName] ?? fallback ?? nord4
}

/**
 * Generate style properties for a finding tag badge.
 * Leverages high-contrast adaptive CSS variables with solid Nord fallbacks.
 *
 * @param {string} tag
 * @returns {{ color: string, background: string, borderColor: string }}
 */
export function getTagStyle(tag, customIndex = -1, explicitColor = '') {
  const key = aliasTagKey(tag) || 'optimize'
  const varKey = key.replace(/[^A-Za-z0-9_-]/g, '') || 'optimize'
  const defaultHex = getTagColor(tag, customIndex, explicitColor)
  return {
    color: `var(--pd-tag-${varKey}-fg, ${defaultHex})`,
    background: `var(--pd-tag-${varKey}-bg, ${defaultHex}24)`,
    borderColor: `var(--pd-tag-${varKey}-border, ${defaultHex}66)`,
  }
}

/**
 * Generate style properties for a finding severity badge.
 * @param {string} severity
 * @returns {{ color: string, background: string, borderColor: string }}
 */
export function getSeverityStyle(severity) {
  const color = getSeverityColor(severity)
  return {
    color,
    background: `${color}18`,
    borderColor: `${color}40`,
  }
}

/**
 * Shared pastel tints for sequential items (Active Groups, Draft cards/rows).
 * Cycles through Frost & Aurora palette tones (Nord8, Nord14, Nord13, Nord15, Nord12).
 */
export const SEQUENCE_TINTS = Object.freeze([
  { bg: 'rgba(136, 192, 208, 0.10)', border: 'rgba(136, 192, 208, 0.35)', accent: NORD.nord8, tone: 'info' },   // 1: Frost Ice Blue (nord8)
  { bg: 'rgba(163, 190, 140, 0.12)', border: 'rgba(163, 190, 140, 0.35)', accent: NORD.nord14, tone: 'success' },// 2: Aurora Green (nord14)
  { bg: 'rgba(235, 203, 139, 0.12)', border: 'rgba(235, 203, 139, 0.35)', accent: NORD.nord13, tone: 'warn' },   // 3: Aurora Gold (nord13)
  { bg: 'rgba(180, 142, 173, 0.12)', border: 'rgba(180, 142, 173, 0.35)', accent: NORD.nord15, tone: 'purple' }, // 4: Aurora Purple (nord15)
  { bg: 'rgba(208, 135, 112, 0.12)', border: 'rgba(208, 135, 112, 0.35)', accent: NORD.nord12, tone: 'orange' }, // 5: Aurora Orange (nord12)
])

/**
 * Retrieve the sequence tint for a 0-based or 1-based index with cyclic wrapping.
 * @param {number} index
 * @returns {{ bg: string, border: string, accent: string, tone: string }}
 */
export function getSequenceTint(index = 0) {
  const safeIdx = Math.max(0, Math.floor(Number(index) || 0))
  return SEQUENCE_TINTS[safeIdx % SEQUENCE_TINTS.length]
}
/**
 * Blend a Nord palette color with an alpha channel. Translucent tints must be
 * derived from the shared palette instead of hardcoded rgb()/rgba() literals.
 * @param {string} hex palette color such as NORD.nord14
 * @param {number} alpha 0..1
 * @returns {string}
 */
export function nordTint(hex, alpha) {
  const raw = String(hex).replace('#', '')
  const full = raw.length === 3 ? raw.split('').map(char => char + char).join('') : raw
  const value = Number.parseInt(full, 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}
