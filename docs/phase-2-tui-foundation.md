# Phase 2 — TUI foundation

## Task summary

| Task | Files | Status |
| --- | --- | --- |
| Split runtime bootstrap and lifecycle | `src/index.tsx`, `src/app/main.tsx` | ✓ |
| Build the Noodle-style shell | `src/ui/app.tsx`, `app-inner.tsx`, `header.tsx`, `footer.tsx` | ✓ |
| Add reusable frames and borders | `src/ui/frame.tsx`, `borders.ts` | ✓ |
| Add the presentational torrent list | `src/ui/torrent-list.tsx` | ☐ |
| Add the palette and active key map | `src/ui/theme.ts`, `keybinds.ts` | ✓ |
| Add the standalone confirmation dialog | `src/ui/confirm-dialog.tsx` | ☐ |
| Add renderer behavior tests | `tests/unit/ui/app.test.tsx`, `torrent-list.test.tsx`, `confirm-dialog.test.tsx` | ☐ |
| Record deferred shutdown integration coverage | — | N/A |

## Reference constraint

- Noodle is a structural and visual reference only. Inspect its actual source and adopt only patterns relevant to this phase.
- Do not copy Noodle code, dependencies, features, or abstractions without explaining their fit for torrent-tui.
- Verify OpenTUI APIs against the installed `@opentui/core` and `@opentui/react` version (`^0.5.8`).
- Present any unknown or unapproved API, architecture, or scope change for study and approval before adopting it.

## Decisions

- Use a plain full-screen application box, a `List` frame legend, a centered empty state, and an adaptive contextual footer.
- Show `torrent-tui v<package version>` in the header; omit collection and right-side status labels.
- Use a direct eight-role palette based on Noodle’s `noodleTheme` semantic names; do not add theme context or switching.
- Keep `App` responsible for the static shell and `onQuit`; keep `AppInner` responsible only for local UI routing, with no backend prop or service seam.
- Keep `TorrentList` presentational and reuse `TorrentSummary`, using `hash_string` as the row identity. Selected rows use a Noodle-style left bar and surface highlight.
- Keep Phase 2 runtime empty and keyboard-first. q requests quit; Ctrl+C and SIGTERM/SIGHUP use runtime shutdown.
- Use OpenTUI’s direct keyboard hook and a small active key map; do not add `@opentui/keymap`.
- Keep `ConfirmDialog` standalone until Phase 3; use one renderer-root portal file with a backdrop, Enter confirmation, and Escape cancellation. Do not mount hidden dialog state in the runtime.
- Defer Transmission, torrent actions, async state, polling, CLI, sidebar, details, tabs, command palette, mouse support, global state, and generic overlay extraction.

## Tests

- `app.test.tsx`: normal shell, narrow shell, and q quit callback.
- `torrent-list.test.tsx`: representative rows and selected-row presentation.
- `confirm-dialog.test.tsx`: Enter confirmation and Escape cancellation.
- These are in-process OpenTUI renderer/component tests under `tests/unit/ui`, using targeted frame and input assertions rather than snapshots; they are not daemon integration or E2E tests.
- The runtime keeps OpenTUI’s default synchronous Ctrl+C and signal handling; revisit shutdown integration coverage only if app-owned asynchronous cleanup is introduced.

References: [Noodle App](https://github.com/wilfredinni/noodle/blob/main/src/ui/App.tsx), [Noodle AppInner](https://github.com/wilfredinni/noodle/blob/main/src/ui/AppInner.tsx), [Noodle Header](https://github.com/wilfredinni/noodle/blob/main/src/ui/Header.tsx), [Noodle Frame](https://github.com/wilfredinni/noodle/blob/main/src/ui/Frame.tsx), [Noodle Sidebar](https://github.com/wilfredinni/noodle/blob/main/src/ui/Sidebar.tsx), [Noodle theme data](https://github.com/wilfredinni/noodle/blob/main/src/ui/theme-data.ts), [Noodle Overlay](https://github.com/wilfredinni/noodle/blob/main/src/ui/overlays/Overlay.tsx), [OpenTUI renderer](https://opentui.com/docs/core-concepts/renderer/), and [OpenTUI testing](https://opentui.com/docs/core-concepts/testing/).
