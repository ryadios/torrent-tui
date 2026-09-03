# Noodle / OpenTUI: Self-Contained Study Plan

**Target:** 2–3 focused sessions

**Method:** read this document first; opening the linked source files is
optional. The links are provenance and deeper references, not prerequisites.

**Reference snapshot:** Noodle `0.8.2`, OpenTUI `^0.5.8`, inspected on
2026-08-31. This project also uses OpenTUI `^0.5.8`.

## The one-page mental model

Noodle is a file-backed REST client. YAML request files are parsed into typed
objects, React hooks turn those objects into screen state, and OpenTUI renders
that state as terminal cells. Network execution stays outside the components.

```text
CLI arguments
  → bootstrap/config/environment
  → OpenTUI renderer + React root + keymap provider
  → App (theme and global settings)
  → AppInner (state, effects, actions, overlays)
  → MainView
  → Sidebar + request/response panes + status bar
```

The data path is separate from the visual path:

```text
request.yml
  → parse and validate
  → Collection state
  → draft/edit state
  → request executor
  → response state
  → ResponsePane
```

### What each layer owns

| Layer | Responsibility | Important behavior | torrent-tui translation |
|---|---|---|---|
| `schema/` | Domain types such as `Request`, `Collection`, `Response`, `Environment`, and `NetworkEvent`. | No React or terminal dependency. Unions describe valid states. | Keep Transmission RPC result types independent from UI props. |
| `lang/` | YAML parsing and serialization. | Rejects invalid or unknown request fields at the boundary. | Validate RPC payload/result shapes once instead of casting raw JSON everywhere. |
| `filestore/` and `env/` | Collection files, settings, environments, and UI state. | Directory walking, path validation, sorting, error collection, and atomic settings writes. | Keep local preferences separate from Transmission's authoritative daemon state. |
| `requests/` | HTTP execution and variable substitution. | Handles timeout, cancellation, redirects, cookies, proxy/TLS policy, and network events. | `src/transmission/client.ts` should remain the single RPC boundary. |
| `hooks/` | React state and asynchronous orchestration. | Loading, drafts, edit modes, cancellation, caching, and subscriptions live here. | Add a hook around polling/actions before adding a global store. |
| `ui/` | OpenTUI components, layout, focus, commands, themes, and overlays. | Components render state and call callbacks; they do not own the network. | Build the torrent list/details shell first. |
| `app/` | CLI dispatch and renderer bootstrap. | TUI, import/export, update, and automation commands are separate entry paths. | Keep the first version's bootstrap small; do not copy every subcommand. |
| `tests/` | Pure helpers, in-memory renderer tests, component tests, and isolated integration tests. | Uses Bun's test runner and destroys renderers after tests. | Keep renderer tests separate from Transmission integration tests. |

### Startup, in plain language

1. `src/app/cli.ts` parses arguments with Citty. An unqualified path or TUI
   flag is routed to the default TUI command; other names route to import,
   export, update, agent, or automation commands.
2. `src/app/main.tsx` loads global config, selects the collection directory,
   classifies it as collection/browse/empty/invalid, loads environments and
   settings, creates the renderer, and mounts React.
3. The renderer is created with Ctrl+C handling disabled so the app can first
   copy a selection or flush resources. Shutdown eventually calls
   `renderer.destroy()`, which releases the terminal.
4. `App` owns global config and the active theme. `AppInner` owns cross-view
   state, refs, effects, command actions, and overlay visibility.
5. `MainView` chooses the folder or request workspace. The request workspace
   contains a sidebar, URL bar, request pane, response pane, and status bar.

## Session 1 — runtime, data, and the small DAL

| Topic | Relevant information to understand | Verification |
|---|---|---|
| Running Noodle | It is a Bun/TypeScript/React/OpenTUI app. `bun run dev -- --collection ./collections --env development` starts the TUI. `bun test`, `bun run typecheck`, `bun run lint`, and `bun run build:bin` cover tests, types, lint, and a compiled binary. | Explain what runs in development and which process owns the terminal. |
| CLI modes | The default command opens the TUI. `--collection` or a positional path selects data, `--env` selects an environment, and `--noproxy` / `--insecure` apply one-run network overrides. Other commands perform automation without a TUI. | Explain why CLI parsing is outside React and why automation can reuse the same service layer. |
| Request model | A request contains method, URL, timeout, headers, params, body, auth, tags, assertions, and optional captures. `Auth`, body type, and form entries are typed unions/records rather than unstructured UI data. | Identify which fields belong in a future torrent view model and which are Noodle-specific. |
| File model | A collection has `settings.yml`, request `.yml` files, optional `folder.yml` overrides, `.environments/*.env`, hidden `.noodle/ui-state.yml`, and optional `.timeline/` history. Request IDs are relative paths without `.yml`. | Explain why a file path is not the same thing as a user-facing label. |
| Collection loading | `walk()` resolves real paths, rejects symlink escapes, skips hidden and known state directories, parses folders/requests, collects file errors, then sorts folders by sequence/name and requests alphabetically. | Draw the load flow without opening the implementation. |
| Persistence safety | Request/folder writes are direct; environment/settings writes use temporary files followed by rename. Save/delete paths reject empty, absolute, traversal, and backslash-containing IDs. | Name one operation that needs atomic replacement and one that needs destructive-action confirmation. |
| Environments | `.env` files provide variables; disabled variables remain declared; secret declarations resolve from the process or OS vault. Substitution happens before execution, while sensitive values are redacted at output boundaries. | Explain why credentials should not be stored in torrent UI state or RPC logs. |
| Request execution | `requests/send.ts` prepares the effective request, calls `fetch`, records network events, follows supported redirects, applies policy, and returns a response. `useResponse` exposes `idle`, `sending`, `done`, and `error`; an `AbortController` cancels active work. | Describe what the UI can show while a request is still running and what happens after cancellation. |

### Small DAL trace for torrent-tui

The useful pattern is smaller than Noodle's REST executor:

```text
TransmissionClient
  → typed SessionInfo / TorrentList / TorrentAddResult
  → React state or hook
  → list/details components
```

Keep these responsibilities distinct:

| Responsibility | Put it here | Do not put it here |
|---|---|---|
| RPC URL, JSON-RPC envelope, session ID, HTTP errors, result decoding | `src/transmission/client.ts` | JSX event handlers and individual panes |
| Session/torrent response shapes | `src/transmission/types/` | `Record<string, unknown>` throughout the UI |
| Polling, cancellation, loading/error state | A hook or one small app-level controller | `setInterval` scattered across components |
| Selection, cursor, active pane, modal state | UI state | Transmission client |
| Torrent truth and long-running download process | `transmission-daemon` | The TUI process |

Noodle's extra OAuth, cookie, proxy, TLS, timeline, and assertion machinery is
useful as boundary-design inspiration, but it is not required for the first
torrent client.

## Session 2 — how the clean UI is built

### React/OpenTUI composition

OpenTUI JSX is not browser DOM. `<box>`, `<text>`, `<input>`, and
`<scrollbox>` become terminal renderables. Layout uses Yoga-like flex sizing
and terminal-cell dimensions; there is no CSS stylesheet or browser box model.

The practical component hierarchy is:

```text
App
└── AppInner
    ├── Header
    ├── MainView
    │   ├── Sidebar
    │   └── RequestResponseView
    │       ├── UrlBar
    │       ├── RequestPane
    │       └── ResponsePane
    ├── AppOverlays
    └── StatusBar
```

`App` is the global wiring layer. `AppInner` is the coordinator. Leaf panes
receive values and callbacks. This keeps visual files from knowing how files
are loaded or how requests are sent.

### Layout rules that create the Noodle feel

| Rule | What it prevents or enables |
|---|---|
| Use rows/columns with `flexGrow: 1` | The main workspace consumes available terminal space. |
| Use `minWidth: 0` and `minHeight: 0` on shrinking nested panes | Text or a child pane does not force the whole layout wider/taller than the terminal. |
| Use `gap: 0` between adjacent panels | The UI stays dense and information-rich. |
| Give lists/content their own `scrollbox` | The shell stays fixed while torrents, files, peers, or response text scroll. |
| Keep a minimum pane size | A split view remains usable rather than collapsing into unreadable cells. |
| Put resize handles between panes | Users can choose whether list or detail information gets more space. |
| Fit or hide status hints at narrow widths | Short terminals still show state instead of wrapping the footer into noise. |

Noodle's main workspace is a sidebar plus a growing content area. The content
can stack request and response vertically or place them side by side. A split
ratio is clamped to minimum widths/heights, and a double-click restores the
default ratio.

### Visual language

Noodle uses a small semantic palette rather than arbitrary colors in every
component:

| Token | Meaning |
|---|---|
| `background`, `backgroundPanel`, `backgroundElement` | Terminal, pane, and selected/hovered surfaces. |
| `text`, `textMuted` | Primary and secondary information. |
| `primary`, `accent` | Focus, active tabs, selection, and important actions. |
| `success`, `warning`, `error`, `info` | State communication. |
| `border`, `borderActive`, `borderSubtle` | Structural and focus borders. |

`Frame` centralizes border/title placement. `FullBorder`, `LeftBar`, and
`PaneBorder` provide consistent border shapes. Focus normally changes the
frame border to `theme.primary`; children do not each invent a focus color.

Tabs are compact, horizontally scrollable, and use active color plus a bottom
rule. Status bars combine request state, environment, errors, and only the
most useful contextual shortcuts. Empty, loading, and error states are
deliberate screens, not accidental blank space.

### State and interaction boundaries

- `useCollection` loads asynchronously and ignores late results after the
  component is cancelled.
- `useRequestDraft` keeps original and unsaved request values separate, which
  makes dirty indicators, cancel, and save predictable.
- `useEditBrowse` models browsing versus editing. Arrow navigation does not
  automatically write to disk; commit and cancel are explicit.
- Refs mirror important current values for commands and async callbacks where
  waiting for a React render would create stale state.

For torrent-tui, the equivalent first state model can be much smaller:

```text
selected torrent + cursor
  → active pane
  → loading/error/last refresh
  → optional confirmation modal
```

Do not introduce a global store until the same engine snapshot is consumed by
several independent views.

## Session 3 — keybinds, overlays, and code quality

### Keybind model

Noodle treats a shortcut as named metadata: default key, description, category,
contexts, and whether the user may override it. The keymap then activates
layers according to focus, view, edit mode, and overlay state.

| Context | Representative keys | Meaning |
|---|---|---|
| Global navigation | `Tab`, `Shift+Tab`, `F1`, `Ctrl+P`, `g` | Move focus, show help/commands, or jump directly to a target. |
| Workspace | `Ctrl+L`, `F2` | Toggle stacked/side-by-side layout or expand the focused pane. |
| Request | `Ctrl+Enter`, `Ctrl+S`, `Return`, `Ctrl+E` | Send, save, enter browse/edit, or open YAML editing. |
| Workspace selection | `Ctrl+O`, `F3`, `F4`, `Ctrl+T` | Collections, environments, settings, and themes. |
| Overlay | arrows, `Return`, `Escape` | Navigate/select/close without allowing the background to act. |

Use direct keyboard handlers when one component owns a small local behavior.
Use `@opentui/keymap` when commands are shared across panes, have priorities,
need mode/focus conditions, or must appear in help and a command palette.

For the current torrent-tui starter, direct handlers are enough. The existing
dependency list does not include `@opentui/keymap`; adding it only to resemble
Noodle would be unnecessary complexity.

### Overlay pattern

Noodle has one generic modal container and builds pickers, confirmations, help,
theme selection, and the command palette on top of it. The container:

1. renders through a portal at the renderer root;
2. covers the screen with a dim background and high z-index;
3. centers a panel with the active theme;
4. installs a higher-priority keyboard interceptor;
5. returns focus when closed.

For torrent-tui, reuse this idea for delete-data and stop/confirm actions
before building a searchable command palette.

### Code style to copy

| Noodle habit | Why it matters |
|---|---|
| Strict TypeScript and named exports | Data flow is visible in imports and types. |
| Pure helpers before JSX | Width clamping, formatting, selection, and tree logic are easy to test. |
| Hooks/services own effects | Components stay mostly declarative. |
| Small reusable primitives | Borders, tabs, badges, and empty states stay visually consistent. |
| Boundary validation and normalized errors | Failure handling is not duplicated across panes. |
| Explicit cleanup | Renderer, signal, timer, subscription, and abort resources have owners. |
| No speculative abstraction | Noodle's scale is a reason to study boundaries, not to reproduce every module. |

### Tests and visual verification

Noodle uses Bun's built-in test runner. Its useful test categories are:

- pure helper tests for formatting, selection, tree, parsing, and keybinds;
- in-memory OpenTUI renderer tests that capture a character frame;
- input tests for focus, overlays, and keymap isolation;
- filesystem tests using temporary directories;
- isolated HTTP loopback tests for request behavior.

For torrent-tui, the first meaningful checks are one unit test for RPC result
decoding/error handling, one renderer test for the list/details frame, and one
interaction test proving a destructive action requires confirmation. Keep
Transmission integration tests separate and do not require a running daemon in
unit tests.

## Six short excerpts worth studying

These snippets contain the important tricks; the surrounding source is
optional context.

### 1. Renderer ownership

From [`src/app/main.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/app/main.tsx):

```tsx
const renderer = await createCliRenderer({ exitOnCtrlC: false })
createRoot(renderer).render(...)
```

The code that creates the renderer owns terminal cleanup.

### 2. Dense nested layout

From [`src/ui/MainView.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/MainView.tsx):

```tsx
style={{
  flexDirection: "row",
  flexGrow: 1,
  gap: 0,
  minHeight: 0,
}}
```

`minHeight: 0` is the subtle part: it allows a growing child to shrink inside
the available terminal height.

### 3. Focus as a frame signal

From [`src/ui/Sidebar.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/Sidebar.tsx):

```tsx
borderColor={focused ? theme.primary : theme.borderSubtle}
```

The pane communicates focus at its boundary instead of recoloring every row.

### 4. Modal ownership

From [`src/ui/overlays/Overlay.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/overlays/Overlay.tsx):

```tsx
zIndex: 10000,
backgroundColor: RGBA.fromInts(0, 0, 0, 150),
```

The dim layer makes it visually and behaviorally clear that the background is
inactive.

### 5. Shortcut metadata

From [`src/ui/keybind.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/keybind.ts):

```ts
return { default: value, description, fixed, category, contexts }
```

Keybinds can power dispatch, help text, and configurable shortcuts from one
definition.

### 6. Cancellation handle

From [`src/hooks/useResponse.ts`](https://github.com/wilfredinni/noodle/blob/main/src/hooks/useResponse.ts):

```ts
const controller = new AbortController()
abortRef.current = controller
```

The hook keeps a direct handle for cancelling work that outlives one render.

## What to adopt in torrent-tui

| Timing | Adopt | Why |
|---|---|---|
| Now | Keep `TransmissionClient` outside JSX and return typed results. | One RPC boundary, one error policy. |
| Now | Model loading, refresh failure, empty data, and selected torrent explicitly. | The UI always communicates state. |
| Now | Use a dense list/details layout with `gap: 0`, `flexGrow`, and minimum sizes. | It matches terminal constraints and Noodle's visual strength. |
| Now | Use a small semantic color palette and an always-visible status line. | Focus and daemon connectivity remain legible. |
| Now | Use `AbortController` for refresh/action cancellation and destroy the renderer on exit. | Prevents stale results and terminal corruption. |
| When panes repeat | Extract a tiny `Frame`/border primitive. | Removes visual drift without a design system. |
| When commands multiply | Add `@opentui/keymap`, named commands, and perhaps a palette. | Shared mode-aware dispatch then pays for itself. |
| When persistence is needed | Persist only layout/selection preferences. | Do not duplicate Transmission's torrent database. |
| Defer | 34-theme catalog, code editor, timeline, cookies, OAuth, converters, secrets vault, update flow, and automation commands. | They solve Noodle product needs, not the first torrent UI need. |

## Completion checklist

- [ ] Explain the bottom-up path: types → parsing → I/O → RPC → hooks → UI.
- [ ] Explain the top-down path: CLI → bootstrap → renderer → `App` → views.
- [ ] Draw the two data flows from memory.
- [ ] Explain why `gap: 0`, `minHeight: 0`, scrollboxes, semantic colors, and active borders matter.
- [ ] Trace `Ctrl+Enter` or `Tab` through focus/context and command handling.
- [ ] Explain why an overlay must intercept input before the background.
- [ ] State which Noodle features are adopted now, later, and deferred.
- [ ] Continue the Transmission-specific work in [`docs/transmission-study-plan.md`](./transmission-study-plan.md).

## Optional source map

Use these only when the condensed explanations leave a question:

- [Noodle README](https://github.com/wilfredinni/noodle)
- [Noodle architecture notes](https://github.com/wilfredinni/noodle/blob/main/.agents/skills/noodle-dev/architecture.md)
- [OpenTUI React bindings](https://opentui.com/docs/bindings/react/)
- [OpenTUI layout](https://opentui.com/docs/core-concepts/layout/)
- [OpenTUI keyboard](https://opentui.com/docs/core-concepts/keyboard/)
- [OpenTUI keymap](https://opentui.com/docs/keymap/overview/)
