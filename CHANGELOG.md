# Changelog

## [0.1.14] - 2026-09-28

### Added
- Root `CHANGELOG.md` tracking repository releases according to Keep a Changelog standard.
- Added `CHANGELOG.md` to `files` in `package.json`.

---

## [0.1.13] - 2026-09-28

### Changed
- Banner image in `README.md` now uses `<img width="100%" ...>` for responsive edge-to-edge full width rendering.

---

## [0.1.12] - 2026-09-28

### Changed
- Removed obsolete comparison section from `README.md`.
- Aligned Architecture documentation with codebase facts: batched 3-dimension evaluation (`has_slop`, `has_unfinished_todo`, `answers_request`), and added Context Guard details under Model Routing.

---

## [0.1.11] - 2026-09-28

### Added
- Root `LICENSE` file (MIT) so GitHub API and shield badges detect repository license properly.
- Manifest `image` in `package.json` for pi.dev package gallery card preview.
- `npm run dev` script for conflict-free local live testing.

### Changed
- Redesigned `README.md` to follow Arnative structure (outline badges, punchy bullets, collapsible architecture accordion).

---

## [0.1.10] - 2026-09-28

### Added
- One key cycles three supervisor modes (`Alt+Shift+J`): `ON` -> `REVIEW` -> `OFF`.

### Fixed
- Model router restores pre-routing model on `agent_settled` instead of `agent_end`.
- Allow scoped globs (e.g. `/tmp/jev-req*.mjs`) in bash interception.
