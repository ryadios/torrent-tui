# torrent-tui MVP plan

This document tracks the product phases for the MVP. Commits and pull
requests remain grouped by feature or subtask, independently of these phases.

## Phase summary

| Phase | Feature outcome | Status |
| --- | --- | --- |
| 0 | Connect to local Transmission RPC and perform basic torrent operations | Complete |
| 1 | Add, start, stop, remove, and refresh torrent data through stateless operations | Complete |
| 2 | Launch a clean OpenTUI application with separated runtime, UI, and async behavior | Planned |
| 3 | Manage torrents from the TUI with selection, essential status, actions, and manual refresh | Planned |
| 4 | Use readable CLI commands for the same torrent features available in the TUI | Planned |
| 5 | Validate the complete local workflow, persistence behavior, errors, and documentation | Planned |
| 6 | Add live torrent updates after the base MVP is complete | Deferred priority |

## Phase checklist

- [x] Phase 0 — Transmission foundation
- [x] Phase 1 — Torrent lifecycle
- [ ] Phase 2 — TUI foundation
- [ ] Phase 3 — TUI management
- [ ] Phase 4 — Shared CLI
- [ ] Phase 5 — MVP completion
- [ ] Phase 6 — Live updates (deferred priority)

## Phase 0 — Transmission foundation

The app can connect to the local Transmission RPC endpoint and use a typed
client boundary for session negotiation, listing torrents, adding paused
torrents, starting, stopping, and removing torrents without deleting local
data. Client behavior, response types, and focused unit tests are complete.

## Phase 1 — Torrent lifecycle

The torrent layer exposes stateless workflows for the basic lifecycle:

- add a torrent paused;
- start and stop a torrent;
- remove a torrent while keeping local data;
- return the latest torrent list after a mutation; and
- use the stable torrent hash as the torrent identity.

Duplicate torrents and failed operations remain observable through the
Transmission response/error path; this layer does not add caching, polling,
retries, rollback, or a global store.

## Phase 2 — TUI foundation

The project launches an OpenTUI React application. Runtime/bootstrap code,
shared torrent logic, React state/hooks, and UI components have clear
responsibilities. Renderer ownership and cleanup are explicit, and loading,
success, and error states are represented without putting network work in JSX.

Noodle is adopted selectively as the structural reference: TUI bootstrap,
shared request logic, React-side async state, and focused UI components. The
CLI path is added after the corresponding TUI features are working. Noodle
features unrelated to this MVP—REST collections, YAML import/export, OAuth,
cookies, timelines, and its larger command surface—are omitted. Exact visual
layout is reserved for a separate UI/UX plan.

## Phase 3 — TUI management

The TUI displays the essential torrent list, status, and progress; identifies
the selected torrent by stable hash; and supports add, start, stop, remove,
and manual refresh. Loading and failure states are visible, and removal keeps
downloaded files.

Presentation state remains owned by the TUI. There is no global store,
automatic polling, advanced file/peer/tracker view, or other speculative UI
state in the base MVP.

## Phase 4 — Shared CLI

After the corresponding TUI features are working, the CLI supports readable
commands for the same MVP operations:

```text
torrent-tui list
torrent-tui add <source>
torrent-tui start <hash>
torrent-tui stop <hash>
torrent-tui remove <hash>
```

The CLI and TUI use the same TypeScript torrent workflows. The CLI does not
shell out to `transmission-remote`; that command remains a study and
debugging tool. JSON output, remote/custom endpoint configuration, and
advanced automation are outside the MVP.

## Phase 5 — MVP completion

The complete local workflow works through both CLI and TUI with consistent
basic lifecycle behavior. Errors are visible and do not leave misleading
stale state. Closing the TUI leaves Transmission and active downloads running
because the production daemon is owned by systemd; the app does not call
`session-close` during normal exit.

The release is checked with unit tests, separate renderer tests where needed,
manual local Transmission integration, and current setup/documentation.

## Phase 6 — Live updates

After the base MVP is complete, add fixed-interval torrent polling as a
separate capability. Keep application polling separate from OpenTUI renderer
scheduling and define update behavior before adding it to the TUI.

User-configurable intervals, throttling, shared multi-view state, and richer
real-time views remain future work.

## Architecture boundaries

The intended product structure is:

```text
src/
├── app/           # CLI dispatch and TUI bootstrap when both entry paths exist
├── torrent/       # Stateless product workflows
├── transmission/  # RPC boundary and response types
└── ui/            # OpenTUI React components and hooks
```

Do not add `src/store` initially. The TUI can own its presentation state, and
Transmission remains responsible for downloading, peers, persistence, and
protocol behavior.

## MVP boundaries

- Linux-first; run from source with Bun.
- Install Transmission through the operating system package manager.
- Keep the production Transmission daemon alive under systemd.
- Connect to the local default Transmission RPC endpoint only.
- Do not install, start, stop, or supervise the production daemon from the app.
- Do not add a development daemon wrapper yet; the existing Fish lab is enough.
- Do not ship a standalone binary, npm/npx distribution, automatic sudo, or
  postinstall setup.
- Do not support remote Transmission endpoints in the MVP.
- Do not delete local torrent data from the MVP remove operation.
- Do not call `session-close` on normal TUI exit.

See the [Transmission study plan](./transmission-study-plan.md) and
[Noodle study plan](./noodle-study-plan.md) for the practical research and
reference material behind these boundaries.
