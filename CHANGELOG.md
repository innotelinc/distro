# Changelog

Distro's releases. Entries describe what an operator can do differently, not the
files that moved. Earlier tags (`v0.1.0`–`v0.1.2`) are the pre-console releases;
their history is in `git log`.

## v0.4.0 — 2026-10-20

The operator console, rebuilt on the family **Unity** theme.

### Added

- **Overview** with a 14-day spend trend read from the same `usage_cache` rows
  the quota gate uses, a "needs attention" queue (gateway drift, alerting off,
  accounts without keys, accounts at a cap, the newest alert), top accounts by
  spend, and today's model mix.
- **Per-account drawer**: usage, quota editing with presets, per-model today,
  gateway key state with rotate/revoke, credits balance + ledger + grant, and
  enable/disable/delete. Refreshes no longer overwrite in-progress edits.
- **Settings** surface for the gateway pin, alerting, Magnate billing, the
  Authentik group (with **Sync group users**), the release version, and the
  accounting zone.
- **Command palette** (`Ctrl/Cmd+K`) that jumps to a section or an account.
- **CSV export** for the filtered account list and for audit/alert history.
- **`GET /api/admin/usage`** — the daily series and top spenders, with the
  window clamped and empty days filled as zero rows.
- The release version is answered by `GET /health` and `/api/admin/stats`.

### Changed

- The console wears **Unity** (`operations` scheme), with the canonical
  `unity-theme.css` / `unity-theme.js` served beside it at
  `/admin/unity-theme.*` instead of a private palette pasted into the page.
  Light / dark / system and the three palettes are the shared switch.
- Navigation is **one collapsible left rail**: expanded (252 px) or an icon
  strip (76 px), toggled from the rail or the masthead and remembered per
  browser; `Ctrl/Cmd+B` toggles it. On a narrow screen it is an overlay drawer
  that closes when a section is chosen. There are no nested collapse controls
  to keep in sync with it.
- The old wide accounts table is a calm read-only list; editing moved into the
  account drawer. Key repair, storage probes and audit filters are unchanged in
  behaviour but restyled.

### Fixed

- **The last active admin can no longer disable themselves.** Demotion and
  deletion were already refused; `PATCH {disabled:true}` was the same lockout
  through a different field. The guard is covered by
  `test/last-admin.test.mjs`.
- Alert history reads are capped like the audit reads, so `?limit=` cannot pull
  an unbounded log through the console route.
- The storage provider/pool forms no longer submit twice (the submit button had
  both a click and a submit handler).
- The sign-in popup only accepts a session message from the console's own
  origin.
