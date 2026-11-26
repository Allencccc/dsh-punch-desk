# Changelog

All notable changes to Punch Desk are documented here. Public releases use the versions published in this repository; internal source versions may differ.

## [Unreleased]

- No unreleased changes yet.

## [1.0.1] - 2026-11-26

Source: v0.1.15

- Published `dsh-punch-desk@1.0.1` through the OIDC trusted-publishing release workflow, validating the npm Trusted Publisher configuration.
- Added npm discovery keywords: `dsh`, `deepseek-harness`, and `dsh-plugin`.
- Added npm installation instructions to the README and plugin-detail mirrors.
- No functional changes.

## [1.0.0] - 2026-11-25

Source: v0.1.14

The first public release. It includes the cumulative feature history below.

**Included releases**

- **0.1.13** — Turn Action Inbox, compact row interactions, conditional Session Pane tabs, Host state v4.
- **0.1.12** — Finding Distillation, group turn attribution v2, tag directory and analysis points, configurable submission limits, settings redesign.
- **0.1.12-rc.1** — Finding Distillation release candidate, configurable prompt tail A/B/C, multi-file CAS writeback.
- **0.1.10** — Beta hardening: explicit submission targets, wrap-up guards, cross-session asset inheritance, Host Store migration, import/export, commit-range attribution.
- **Earlier 0.1.x** — packaging and plugin-detail fixes, two-person install verification, import/export merge and replace.
- **M1a/M1b and v2.0** — message-toolbar capture, Flow A/B, prompt index and backfill, dual entry points, Nord/Phosphor design system, four-part architecture canvas.

**Public release engineering**

- Chinese and English manuals, contributor, security and conduct documents.
- Public CI and tag-driven release workflows with tarball and checksum guards.
- App-authenticated incremental snapshots and demo-data previews.

Known limitations are documented in [README.md](README.md). Full version history: [CHANGELOG.md](https://github.com/Allencccc/dsh-punch-desk/blob/main/CHANGELOG.md).

## [0.1.13] - 2026-11-15

Source: v0.1.13

### Added

- **Turn Action Inbox** — step-level evidence is reduced to one turn-level disposition per turn: confirm, unaddressed, question pending, question error, approval pending, turn failed, or text question. Quote and body payloads are capped at 8 KB and 32 KB.
- **Compact row interactions** — dismissed and converted items collapse to a single row with inline undo, check and view actions; expanding a row reveals the full text.
- **Re-parse historical sessions** — a Session Pane action replays older sessions and extracts pending actions on demand.
- **Conditional tabs and pending count** — the Session Pane switches between a single accordion and dual tabs, with an open/high-confidence count in the header.
- **Host state v4 and 19 routes** — storage migrates automatically; archived-session action items can be inherited into the current draft pool.

### Changed

- The old execution-feedback tri-state classifier is removed in favour of Turn Action Inbox.
- Confirmed items link directly to the generated finding; dismissed items remain reversible.

### Known limitations

- Pagination with `beforeSeq` and an independent "all" filter are planned enhancements.
- Older sessions may need the explicit re-parse action before actions appear.

## [0.1.12] - 2026-11-13

Source: v0.1.12

### Added

- **Finding Distillation** — select 3–7 sessions, run a two-stage Host analysis, confirm proposals with two-level checkboxes, and write back through a multi-file CAS transaction. Includes 11 distillation routes, three storage buckets, an exclusive lock, pre-write backups, read-back verification and idempotent fingerprints.
- **Group turn attribution v2** — group headers show charged, attributed and total turns; latest submission uses `acceptedAt` and `submissionSeq`; archived windows are frozen.
- **Tag directory and analysis points** — four preset tags and up to six custom tags with editable descriptions; only tags used by the current submission are injected into the prompt.
- **Configurable submission limits** — per-entry and per-prompt byte limits; a 128 KB soft warning recommends splitting without blocking.
- **Settings center redesign** — five collapsible categories, including submission/prompt, session, draft/inheritance, interface density, and retention.
- **Retention controls** — prompt-log windows can be reduced from 30 days / 1000 rows, with current-usage readings and a permanent-deletion warning.
- **Hand-drawn interface reference and refreshed demo previews** — six key surfaces documented in the design reference and compressed preview images.

### Fixed

- Completed items no longer remain "queued" because a stale queue snapshot is preferred over completed PromptLog rows.
- Dismissed and completed states are separated consistently across row badges, group badges, header counts and wrap-up.

### Known limitations

- A real end-to-end batch containing archived sessions is not part of the acceptance run.
- Distillation session titles fall back to locally recorded titles when the host event is missing.
- Baseline rebase re-aligns the plan but does not recompute its static checks; apply re-validates.
- The "original text" preview covers files proposed in the first pass only.
- Parked runs still expire on the 24-hour TTL; they are never written back automatically.

## [0.1.12-rc.1] - 2026-11-12

Source: v0.1.12-rc.1

### Added

- **Finding Distillation release candidate** — replaces the earlier retrospective writeback with a controlled pipeline: session selection, two-stage analysis, human confirmation, and a multi-file CAS writeback into the documentation set declared by the project.
- **Configurable prompt tail** — minimal (A), standard (A+B, default), and strict (A+B+C) coverage; each section is editable and can be cleared. The old fixed verification-command section is removed.
- **Eighteen host routes** — distillation routes cover docs, run, cancel, baseline, apply, estimate, delete, review, rebase, park and abandon; three buckets hold runs, plans and fingerprints.
- **Safety guards** — Markdown-only path boundaries, exclusive lock, 409 conflict protection, pre-write backup, read-back verification, whole-run rollback and idempotent fingerprints.
- **Real end-to-end acceptance** — two applied batches with backups, read-back and fingerprint checks; the writeback entry is enabled.

### Changed

- The settings center grows to ten configurable keys, adding the prompt tail and its three editable sections.
- Architecture, user cases, README and plugin-detail documents are synchronised with the new feature set.

## [0.1.10] - 2026-11-09

Source: v0.1.10

### Added

- **Beta hardening** — explicit submission targets, a capacity panel, guard rails for group wrap-up, and reversible review actions.
- **Cross-session asset inheritance** — move or copy unsubmitted findings between sessions, with workspace isolation and strict eligibility checks.
- **Host Store migration** — client persistence moves from localStorage to a Host-managed JSON store with read-back verification, stale-marker retry and recovery fallback.
- **Import/export** — merge and replace modes with a pre-import backup and read-back verification.
- **Commit-range attribution** — a read-only Git footprint records branch and HEAD snapshots and links turns to commit ranges.
- **GUI smoke and packaging checks** — a read-only GUI smoke suite and regression checks for the packaged host module closure and plugin detail assets.
- **Dead-code and i18n cleanup** — unused views, locale keys and text-only icon substitutes are removed; UI chrome strings move to paired locale keys.

### Earlier 0.1.x releases

- **0.1.8** — import/export merge and replace verified in real use; backup and read-back checks added.
- **0.1.7** — two-person install verification; packaged host module closure and plugin detail images fixed.
- **0.1.2** — package metadata, README hero, and plugin detail rendering fixes.

### Foundations

- **M1a/M1b** — message-toolbar capture, Flow A (prefill) and Flow B (auto) orchestration, prompt index and historical backfill, and the automated test baseline.
- **v2.0** — dual entry points (Desk and Session Pane), Nord palette and Phosphor icon system, four-part architecture canvas, and the first CAS documentation writeback.

## [0.1.0] - 2026-11-06

- Initial internal prototype: draft notes, session capture and a prompt ledger inside the DSH Web GUI.
