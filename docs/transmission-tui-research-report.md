# Transmission TUI Research Report

**Date:** 2026-08-28
**Project:** <code>torrent-tui</code>
**Status:** Research only; no application architecture has been adopted yet.

## Executive decision

<code>torrent-tui</code> should be an OpenTUI client of an independently running
<code>transmission-daemon</code>:

~~~text
torrent-tui (terminal UI) --HTTP JSON-RPC--> transmission-daemon
                                                   |
                                      peers, trackers, files, state
~~~

Closing the TUI should destroy only the terminal renderer and its RPC
connection. It must not call Transmission's <code>session_close</code> RPC. The
daemon must be started and supervised separately so downloads continue after
the terminal closes.

Sources: [Transmission headless usage](https://github.com/transmission/transmission/blob/main/docs/Headless-Usage.md),
[Transmission RPC specification](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md),
[OpenTUI lifecycle](https://opentui.com/docs/core-concepts/lifecycle/).

## Persistence and process ownership

| Concern | Observed/documented behavior | Status |
|---|---|---|
| Torrent engine | <code>transmission-daemon</code> runs headlessly and accepts RPC commands for torrent and session operations. | Baseline |
| Service ownership | Linux distributions commonly provide <code>transmission-daemon.service</code>; systemd owns startup, logs, restart, and shutdown. | Study first |
| TUI ownership | OpenTUI owns the terminal renderer and should call <code>renderer.destroy()</code> during cleanup. | Study first |
| Normal TUI exit | Disconnect RPC and destroy the renderer; leave Transmission running. | Required behavior |
| Daemon shutdown | <code>session_close</code> shuts down the Transmission session. | Explicit action only |
| <code>tmux</code> | Keeps a foreground TUI/process alive after detaching. | Temporary workaround, not architecture |
| <code>nohup</code> | Ignores terminal hangups but does not provide supervision, restart, or boot startup. | Reject as architecture |

The earlier <code>ryadios/torrent-tui</code> repository documents the TUI and a
separate <code>--download</code> workflow, but does not document a separate
Transmission daemon or RPC boundary. That is the structural risk behind a TUI
closing the downloader.
[ryadios/torrent-tui](https://github.com/ryadios/torrent-tui)

## Transmission RPC contract

| Need | Transmission mechanism | Design implication |
|---|---|---|
| Connect | HTTP <code>POST</code> to <code>/transmission/rpc</code>; default port <code>9091</code> | Keep endpoint configurable |
| CSRF/session handshake | Missing or stale <code>X-Transmission-Session-Id</code> returns HTTP <code>409</code> with the current token | Update the token and retry safely |
| Compatibility | <code>session_get</code> exposes version information | Check <code>rpc_version_semver</code> at startup |
| Stable identity | Integer torrent IDs are not stable across daemon restarts | Use <code>hash_string</code> internally |
| List state | <code>torrent_get</code> requires an explicit <code>fields</code> list | Request only fields needed by each view |
| Refresh | <code>recently_active</code> returns changed and removed torrents | Poll from the TUI; Transmission remains authoritative |
| Torrent actions | <code>torrent_start</code>, <code>torrent_stop</code>, <code>torrent_verify</code>, <code>torrent_reannounce</code> | Route through named commands |
| Torrent mutation | <code>torrent_set</code> controls limits, priorities, labels, location, and queue position | Confirm destructive or expensive operations |
| Add/remove | <code>torrent_add</code>, <code>torrent_remove</code> | Removing local data requires explicit confirmation |
| Statistics | <code>session_stats</code> | Use for global speeds and counts |
| Reachability | <code>port_test</code> | Display peer-port status without implementing port tests |
| Security | RPC bind address, whitelist, authentication, host whitelist | Default to localhost; never expose unauthenticated RPC casually |
| Shutdown | <code>session_close</code> | Never issue automatically when the TUI exits |

The current specification describes Transmission 4.1's JSON-RPC 2.0 and
snake_case names. Older RPC spellings remain supported in Transmission 4 but
are deprecated. [RPC specification](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md)

## Noodle reference report

Noodle is useful as a UI organization reference, not as a torrent-backend
reference. It is a Bun, TypeScript, React, and OpenTUI terminal REST client.
[Noodle repository](https://github.com/wilfredinni/noodle),
[Noodle architecture notes](https://raw.githubusercontent.com/wilfredinni/noodle/main/.agents/skills/noodle-dev/architecture.md)

### Structure and execution

| Area | Noodle approach | Relevant lesson |
|---|---|---|
| Runtime | Bun, TypeScript, React, <code>@opentui/core</code>, <code>@opentui/react</code> | Matches this project's runtime direction |
| CLI entry | <code>src/app/cli.ts</code> parses arguments and commands | Keep CLI parsing separate from UI startup |
| Renderer startup | <code>src/app/main.tsx</code> creates the renderer and React root | Have one clear renderer owner |
| Root wiring | <code>App.tsx</code> owns global config/theme; <code>AppInner.tsx</code> wires hooks and views | Separate global wiring from visual components |
| UI composition | <code>MainView</code>, <code>Sidebar</code>, pane components, and overlays | Prefer composed views over one giant component |
| Domain separation | <code>requests</code>, <code>filestore</code>, <code>env</code>, <code>auth</code>, <code>cookies</code>, <code>config</code>, and <code>schema</code> live outside <code>ui</code> | Put Transmission RPC and configuration outside UI |
| State | Hooks own state; refs expose current state to keymap commands | Avoid scattering side effects through render code |
| Development | Bun dev, tests, lint, typecheck, and compiled-binary scripts | Keep a small verification loop |
| Version caveat | Noodle's manifest currently declares OpenTUI <code>^0.4.2</code>; this project uses <code>^0.5.8</code> | Copy patterns, not lockfiles or version assumptions |

### Layout, styling, and interaction

| Concern | Noodle approach | Relevant lesson |
|---|---|---|
| Layout | Yoga/Flexbox-like rows, columns, growth, shrink, gaps, and minimum sizes | Use normal flex flow for the main page |
| Shell | Header, growing main area, and status bar | Good production-level application shell |
| Main view | Sidebar plus growing content pane with draggable resize handle | Suitable for torrent list plus details |
| Panes | Stacked or side-by-side panes with resizable split ratio | Useful for overview/files/peers/trackers |
| Styling | OpenTUI style props; no browser CSS | Learn terminal-cell layout instead of CSS assumptions |
| Reusable framing | <code>Frame.tsx</code> centralizes borders, titles, labels, and focus state | Small shared UI primitives are worthwhile |
| Themes | Semantic colors and 34 built-in themes through a React provider | Start with one semantic theme; add themes later |
| Tabs | Scrollable tab strip with active color, bottom border, and mouse selection | Useful for torrent detail sections |
| Lists | Scrollboxes with scrollbars, auto-scroll, and viewport culling | Needed for many torrents and large file lists |
| Overlays | Portals, dimmed layer, centered modal, keyboard/mouse navigation | Use one overlay mechanism for add/help/confirm/settings |
| Responsive behavior | Measures terminal cell width and truncates or hides labels | Design for narrow terminals |
| Custom editor | Tree-sitter-backed code editor and validation | Reject initially; not needed for a torrent dashboard |

OpenTUI's official layout documentation confirms that it uses Yoga and
terminal-cell dimensions rather than browser CSS.
[OpenTUI layout](https://opentui.com/docs/core-concepts/layout/?path=core)

### Keybindings and focus

| Concern | Noodle approach | Relevant lesson |
|---|---|---|
| Definitions | Typed bindings with names, descriptions, categories, contexts, defaults, and fixed status | Commands should be named and documented |
| Dispatch | <code>@opentui/keymap</code> named commands and layers | Keep key handling out of unrelated components |
| Layers | Global, URL, request, folder, environment, cookie, browse, and edit layers | Add layers only for real modes |
| Focus | Explicit focus values for sidebar, panes, editors, settings, and overlays | Model focus deliberately |
| Modal input | Overlay layers intercept keys before background views | Prevent accidental background actions |
| Overrides | Non-fixed bindings are configurable; safety/navigation keys may be fixed | Add customization after core commands work |
| Local input | <code>useKeyboard</code> handles local scrolling and tab movement | Use direct handlers for truly local behavior |
| Examples | <code>Ctrl+P</code> palette, <code>F1</code> help, <code>Tab</code> focus, <code>Ctrl+L</code> layout, <code>F2</code> expand, <code>/</code> filter, <code>Ctrl+S</code> save | Good patterns for later torrent commands |

OpenTUI recommends direct listeners for small local behavior and layered
keymaps for focus, mode, priority, commands, and sequences.
[OpenTUI keyboard](https://opentui.com/docs/core-concepts/keyboard/),
[OpenTUI keymap](https://opentui.com/docs/keymap/overview/)

### Network, I/O, and long-running behavior

| Area | Noodle approach | Relevant lesson |
|---|---|---|
| Network | <code>src/requests/send.ts</code> contains the request executor and uses <code>fetch</code> | Keep the Transmission RPC client outside UI components |
| Async state | Explicit idle, sending, done, and error states | Model daemon connection and actions similarly |
| Cancellation | <code>AbortController</code> cancels active requests | Cancel stale refresh/action work |
| Late results | Async hooks ignore results after cancellation | Prevent stale RPC responses from overwriting state |
| UI cache | Responses are cached in memory by request ID | Cache views only; Transmission remains authoritative |
| File I/O | YAML collections, config, environments, cookies, and timeline files | Isolate local preferences from RPC logic |
| UI persistence | Debounced writes for selected item, expanded folders, and tabs | Persist only view preferences locally |
| Timeline | Metadata plus compressed sidecars for large bodies | Do not duplicate Transmission's resume/state files |
| Long-running work | Requests are finite; renderer/spinner remains active; no separate service | Noodle does not solve persistent torrent execution |
| Live rendering | OpenTUI rendering and network work are separate | A polling timer should update state; the render loop is not the backend |

## Cross-platform guidance

| Platform | Service model to study | Practical implication |
|---|---|---|
| Linux | systemd service or user service with lingering | Primary learning platform and first release target |
| macOS | <code>launchd</code>, <code>LaunchAgents</code>, and <code>LaunchDaemons</code> | Do not reuse systemd units |
| Windows | Service Control Manager and <code>sc.exe</code> | Service commands and permissions differ |
| Remote daemon | HTTP RPC endpoint | Most portable part of the application |

Recommended direction: make the RPC client portable, but keep service
installation and service control outside the TUI initially. Add platform setup
guides first; add service adapters only after testing on each platform.
[Apple launchd guide](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html),
[Microsoft service control](https://learn.microsoft.com/windows/desktop/Services/controlling-a-service-using-sc)

## Study gate before application architecture

The following concepts are intentionally not treated as adopted until they
have been studied:

- Transmission daemon lifecycle and RPC session-token handling.
- systemd ownership, restart behavior, permissions, and logs.
- OpenTUI renderer destruction, Yoga layout, scrollboxes, and keymap layers.
- Noodle's hook/state pattern and overlay composition.
- Transmission's torrent identity, <code>recently_active</code> polling, and version compatibility.

Do not build a local torrent engine, a TUI-owned daemon, a duplicate resume
database, or a large Noodle-style theme/editor system for the first version.
