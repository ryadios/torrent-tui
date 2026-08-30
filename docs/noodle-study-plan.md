# Noodle / OpenTUI Study Plan

**Target:** 2–3 focused sessions

**Method:** read + verify, in dependency order

**Reference:** [wilfredinni/noodle](https://github.com/wilfredinni/noodle),
`main` inspected on 2026-08-30. Its manifest currently identifies Noodle as
version `0.4.1` and uses OpenTUI `^0.4.2`; this project uses OpenTUI `^0.5.8`,
so copy ideas rather than version-specific APIs.

## Goal and reading rules

The goal is to understand how Noodle gets from typed data and disk I/O to a
clean, interactive OpenTUI screen. It is a UI reference with a small DAL
study, not a template for copying Noodle's entire product architecture.

Read the rows below in order. Open only the named files first; skim adjacent
files when a symbol is called. After each row, answer the verification question
before moving upward.

Keep the study focused:

- quote only the small excerpts marked below; read full files for context;
- treat `src/ui/` as a composed system, not as a list of every component;
- trace one request from disk to response instead of studying every auth,
  converter, cookie, or editor feature;
- record decisions for `torrent-tui` as **adopt**, **later**, or **defer**.

## Session 1 — foundations and the small DAL

| Order | Read | What to learn | Verify before continuing | torrent-tui impact |
|---|---|---|---|---|
| 1. Repository shape | [`README.md`](https://github.com/wilfredinni/noodle/blob/main/README.md), [`package.json`](https://github.com/wilfredinni/noodle/blob/main/package.json), [`AGENTS.md`](https://github.com/wilfredinni/noodle/blob/main/AGENTS.md), [architecture notes](https://github.com/wilfredinni/noodle/blob/main/.agents/skills/noodle-dev/architecture.md) | Bun scripts, package boundaries, conventions, and the difference between TUI, CLI, automation, and file-backed collections. | Explain what `bun run dev`, `bun test`, `bun run typecheck`, `bun run lint`, and `bun run build:bin` each verify. If docs and scripts disagree, trust `package.json` for execution and record the discrepancy. | Keep the first app small. Do not add Noodle's release, importer, editor, or automation surface just because it exists. |
| 2. Leaf contracts | [`src/schema/index.ts`](https://github.com/wilfredinni/noodle/blob/main/src/schema/index.ts), [`src/auth/defaults.ts`](https://github.com/wilfredinni/noodle/blob/main/src/auth/defaults.ts), pure helpers such as [`src/collectionPath.ts`](https://github.com/wilfredinni/noodle/blob/main/src/collectionPath.ts) and [`src/variableReference.ts`](https://github.com/wilfredinni/noodle/blob/main/src/variableReference.ts) | How domain types stay independent from React and OpenTUI; how unions encode valid request/body/auth states. | Sketch `Request`, `Collection`, `Response`, and `NetworkEvent` without opening the UI. Identify which values are persisted and which are runtime-only. | Keep Transmission response/session types separate from UI props. Reuse plain TypeScript types before introducing a store or class hierarchy. |
| 3. Parse and serialize | [`src/lang/parse.ts`](https://github.com/wilfredinni/noodle/blob/main/src/lang/parse.ts), [`src/lang/serialize.ts`](https://github.com/wilfredinni/noodle/blob/main/src/lang/serialize.ts), [`src/lang/folder.ts`](https://github.com/wilfredinni/noodle/blob/main/src/lang/folder.ts), [`src/lang/auth.ts`](https://github.com/wilfredinni/noodle/blob/main/src/lang/auth.ts) | Strict boundary validation: YAML becomes a typed object, unknown or invalid shapes fail before the UI sees them. | Take one sample request YAML and list the fields that survive parse → edit → serialize. | Treat Transmission RPC payload/result validation as a boundary concern; do not let raw JSON shape leak through every component. |
| 4. File-backed collection | [`src/filestore/load.ts`](https://github.com/wilfredinni/noodle/blob/main/src/filestore/load.ts), [`src/filestore/save.ts`](https://github.com/wilfredinni/noodle/blob/main/src/filestore/save.ts), [`src/filestore/index.ts`](https://github.com/wilfredinni/noodle/blob/main/src/filestore/index.ts), [`src/env/load.ts`](https://github.com/wilfredinni/noodle/blob/main/src/env/load.ts), [`src/env/save.ts`](https://github.com/wilfredinni/noodle/blob/main/src/env/save.ts) | Recursive loading, hidden-directory rules, path safety, parse errors, and the distinction between direct and atomic writes. | Draw `walk()`: directory → folder/request → parse → sort → collection. Note which failures are shown in the UI and which stop startup. | Keep local UI preferences/config separate from Transmission-owned torrent state. Reuse `fetch`/filesystem primitives; add no persistence layer until a real preference needs it. |
| 5. Request execution | [`src/requests/index.ts`](https://github.com/wilfredinni/noodle/blob/main/src/requests/index.ts), [`src/requests/send.ts`](https://github.com/wilfredinni/noodle/blob/main/src/requests/send.ts), [`src/requests/substitute.ts`](https://github.com/wilfredinni/noodle/blob/main/src/requests/substitute.ts), [`src/hooks/useResponse.ts`](https://github.com/wilfredinni/noodle/blob/main/src/hooks/useResponse.ts), [`src/ui/sendState.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/sendState.ts) | The executor is outside the components; the hook owns loading, cancellation, caching, incremental network events, and final success/error state. | Explain the states `idle → sending → done/error`, and what happens when the selected request changes or a send is cancelled. | Apply the shape to `src/transmission.ts`: keep RPC calls outside JSX, normalize errors once, and use `AbortController` for refresh/action cancellation. |

### Tiny DAL trace

```text
request.yml
  → filestore/load.ts
  → lang/parse.ts
  → Collection state
  → draft hook
  → requests/send.ts
  → SendState
  → ResponsePane
```

| Concern | Noodle pattern | What to borrow for torrent-tui |
|---|---|---|
| Network | `fetch` lives in the executor, not in visual components. | Keep Transmission RPC in one client module. Components call named actions such as list/start/stop. |
| Cancellation | `AbortController` cancels active work; aborted sends return to idle. | Cancel stale refreshes when changing views or shutting down. |
| Progress | `onNetworkEvent` updates the sending state before the final response exists. | Show connection/refresh status without blocking the renderer. |
| Non-network I/O | File walking and parsing happen behind `filestore` and `lang` modules. | Keep config/UI-state I/O separate from daemon state. |
| Errors | File and network errors are normalized at the boundary, then rendered as state. | Avoid `try/catch` copies in every pane. |
| Long-running work | Noodle's HTTP request is finite; the TUI remains a client. | Transmission remains the long-running torrent owner; the TUI must not become the engine. |

For the Transmission-specific prerequisite, continue with
[`docs/transmission-study-plan.md`](./transmission-study-plan.md). In
particular, keep the RPC session-token handshake and daemon ownership there;
Noodle only supplies client-side UI and async-state lessons.

## Session 2 — state and visual composition

| Order | Read | What to learn | Verify before continuing | torrent-tui impact |
|---|---|---|---|---|
| 6. Collection and draft state | [`src/hooks/useCollection.ts`](https://github.com/wilfredinni/noodle/blob/main/src/hooks/useCollection.ts), [`src/hooks/useRequestDraft.ts`](https://github.com/wilfredinni/noodle/blob/main/src/hooks/useRequestDraft.ts), [`src/hooks/useEditBrowse.ts`](https://github.com/wilfredinni/noodle/blob/main/src/hooks/useEditBrowse.ts), [`src/hooks/requestDraftReducer.ts`](https://github.com/wilfredinni/noodle/blob/main/src/hooks/requestDraftReducer.ts) | Hooks own state transitions while components receive data and callbacks. Browse/edit modes prevent every keystroke from becoming a disk write. | Explain original data vs draft data, commit vs cancel, dirty state, and why refs are used alongside React state. | Start with direct React state in the current two-file app. Add a shared store only when engine events and several views need the same snapshot. |
| 7. UI leaf primitives | [`src/ui/Frame.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/Frame.tsx), [`src/ui/borders.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/borders.ts), [`src/ui/Badge.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/Badge.tsx), [`src/ui/Tabs.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/Tabs.tsx), [`src/ui/format.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/format.ts) | Small reusable framing, border, badge, tab, and formatting pieces remove visual drift without creating a design system. | Identify which primitive owns border characters, title placement, focus color, and display truncation. | Adopt one small `Frame`-style primitive once the torrent screen has more than one pane. Do not create a component library before repetition appears. |
| 8. Layout shell | [`src/ui/MainView.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/MainView.tsx), [`src/ui/RequestResponseView.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/RequestResponseView.tsx), [`src/ui/Sidebar.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/Sidebar.tsx), [`src/ui/Header.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/Header.tsx), [`src/ui/StatusBar.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/StatusBar.tsx) | Sidebar + workspace composition, stacked/side-by-side panes, minimum sizes, resize handles, contextual footer hints, and narrow-terminal behavior. | Sketch the component tree and mark which boxes grow, shrink, scroll, or own focus. Resize the terminal and identify what must remain visible. | Use one dense shell: torrent list, details pane, and status line. Prefer `gap: 0`, `flexGrow`, `minWidth: 0`, and `minHeight: 0` over decorative spacing. |
| 9. Request/response panes | [`src/ui/RequestPane.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/RequestPane.tsx), [`src/ui/ResponsePane.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/ResponsePane.tsx), [`src/ui/KeyValueSection.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/KeyValueSection.tsx), [`src/ui/EmptyState.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/EmptyState.tsx) | Pane-level rendering, tabs, empty/loading/error states, and keeping large content inside scrollable regions. | For each pane, name its input state, user action, and output state. Confirm no network call is started from render code. | Keep torrent details read-only first; add edit controls only for real Transmission mutations with confirmation requirements. |
| 10. Theme and terminal styling | [`src/ui/theme-data.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/theme-data.ts), [`src/ui/theme.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/theme.tsx), OpenTUI [layout](https://opentui.com/docs/core-concepts/layout/), [components](https://opentui.com/docs/components/), and [React bindings](https://opentui.com/docs/bindings/react/) | Semantic colors, terminal-cell sizing, Yoga-style flex layout, and style props instead of browser CSS. | Produce a five-color semantic palette: background, panel, text, muted text, and active/accent. Test it on a dark terminal and a narrow terminal. | Start with one theme and semantic names. Add theme selection only after contrast and state hierarchy are correct. |

### UI rules worth copying

| Pattern | Why it has impact |
|---|---|
| No gaps between adjacent panels | Preserves scarce terminal columns and makes the app feel like one workspace rather than cards. |
| `flexGrow` plus `minWidth: 0` / `minHeight: 0` | Lets panes actually shrink inside nested flex containers instead of overflowing or stealing the viewport. |
| One reusable frame with active/inactive border colors | Focus is visible without repainting every child component's colors. |
| Scrollboxes for lists and response content | Large collections remain usable while the outer shell stays fixed. |
| Semantic theme fields | Components ask for `theme.primary` or `theme.error`, not scattered color literals. |
| Status-bar hint fitting | The footer remains useful at normal widths and degrades gracefully on small terminals. |
| Explicit empty/loading/error states | A clean TUI communicates what is happening instead of leaving blank panes. |

## Session 3 — interaction, runtime, and verification

| Order | Read | What to learn | Verify before continuing | torrent-tui impact |
|---|---|---|---|---|
| 11. Focus and local interaction | [`src/ui/focus.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/focus.ts), [`src/ui/tree.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/tree.ts), [`src/ui/selection.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/selection.ts), [`src/ui/useJumpMode.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/useJumpMode.ts) | Focus is modeled explicitly; visible tree items, cursor position, and jump targets are separate concepts. | Draw the focus cycle and state what happens when a selected item disappears or a pane is expanded. | Use a small explicit focus union for list/details/status/modal states. Do not infer focus from incidental component mounting. |
| 12. Keybind model | [`src/ui/keybind.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/keybind.ts), [`src/ui/useAppKeymap.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/useAppKeymap.ts), [`src/ui/keymap/layers.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/keymap/layers.ts), [`src/ui/keymap/globalLayers.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/keymap/globalLayers.ts), OpenTUI [keyboard](https://opentui.com/docs/core-concepts/keyboard/) and [keymap](https://opentui.com/docs/keymap/overview/) docs | Named commands, focus/mode conditions, layer priority, fixed vs configurable bindings, and the difference between direct handlers and a shared keymap. | For one key, identify its active layer, enabled condition, command, and propagation behavior. | Direct `useKeyboard` is enough for the current starter. Add `@opentui/keymap` only when several views share commands or mode priority becomes hard to see. |
| 13. Overlays and commands | [`src/ui/overlays/Overlay.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/overlays/Overlay.tsx), [`src/ui/overlays/PickerOverlay.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/overlays/PickerOverlay.tsx), [`src/ui/overlays/CommandPaletteOverlay.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/overlays/CommandPaletteOverlay.tsx), [`src/ui/commands.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/commands.ts), [`src/ui/commandActions.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/commandActions.ts) | One modal container, keyboard isolation, reusable searchable pickers, and command actions shared by palette and keymap. | Open an overlay, press an unused key, and confirm the background does not act. Close it with Escape and verify focus returns. | Use one confirmation/modal mechanism for destructive torrent actions. Defer a command palette until there are enough commands to justify it. |
| 14. Runtime wiring | [`src/app/cli.ts`](https://github.com/wilfredinni/noodle/blob/main/src/app/cli.ts), [`src/app/commands/default.ts`](https://github.com/wilfredinni/noodle/blob/main/src/app/commands/default.ts), [`src/app/main.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/app/main.tsx), [`src/ui/App.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/App.tsx), [`src/ui/AppInner.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/AppInner.tsx), [`src/ui/AppOverlays.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/AppOverlays.tsx) | The final top-down startup path: CLI classification → bootstrap → renderer/providers → root app → orchestration → views/overlays. | Explain renderer ownership and every shutdown path. Confirm `renderer.destroy()` restores the terminal and the TUI does not own the long-running backend. | Keep `src/index.tsx` as the renderer owner initially. Split bootstrap, orchestration, and views only when the current file actually becomes difficult to change. |
| 15. Tests and visual checks | [`tests/testRender.ts`](https://github.com/wilfredinni/noodle/blob/main/tests/testRender.ts), representative [`MainView` tests](https://github.com/wilfredinni/noodle/blob/main/tests/unit/MainView.test.tsx), [`Frame` tests](https://github.com/wilfredinni/noodle/blob/main/tests/unit/Frame.test.tsx), [`Overlay` tests](https://github.com/wilfredinni/noodle/blob/main/tests/unit/Overlay.test.tsx), [`requests` tests](https://github.com/wilfredinni/noodle/blob/main/tests/requests.test.ts) | In-memory rendering, frame assertions, input simulation, pure-helper tests, and self-contained network tests. | Test one layout frame, one overlay isolation case, one key action, one cancellation/error path, and one file/RPC boundary. | For non-trivial torrent UI logic, leave one runnable check behind; do not build a test framework or fixtures before the first behavior exists. |

### Representative keybinds

This is a study subset, not a replacement for Noodle's definitions. Verify the
current values in [`src/ui/keybind.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/keybind.ts).

| Context | Keys | Impact |
|---|---|---|
| Global navigation | `Tab`, `Shift+Tab`, `F1`, `Ctrl+P`, `g` | A small, discoverable command vocabulary beats many undocumented single-key actions. |
| Workspace layout | `Ctrl+L`, `F2` | Layout and focused-pane expansion are separate state transitions. |
| Request actions | `Ctrl+Enter`, `Ctrl+S`, `Return`, `Ctrl+E` | Sending, saving, browsing, and editing have different safety levels. |
| Workspace selection | `Ctrl+O`, `F3`, `F4`, `Ctrl+T` | Separate navigation into collections, environments, settings, and themes. |
| Modal interaction | arrows, `Return`, `Escape` | The active overlay must intercept keys before background panes. |

## Code style observations

| Observation | What to look for |
|---|---|
| Strict TypeScript | Named exports, explicit unions, local prop interfaces, and typed callbacks make UI state readable. |
| Pure helpers before JSX | Width clamps, URL formatting, selection, tree flattening, and status formatting stay testable without a renderer. |
| Hooks own effects | Loading, saving, cancellation, persistence, and subscriptions live in hooks or service modules; components mostly compose and render. |
| Refs supplement state | Refs expose current state to key commands and prevent stale async callbacks without forcing every command through a render. |
| UI is not browser UI | OpenTUI JSX maps to terminal renderables; use `style`, flex layout, cell widths, borders, and scrollboxes rather than CSS assumptions. |
| Central orchestration has a ceiling | `AppInner.tsx` is intentionally the cross-view coordinator. Learn its boundaries, but do not recreate its scale in a two-file starter. |
| Boundary errors are explicit | Parse errors, network errors, cancellation, and shutdown cleanup each have a visible owner. |

## Six small code excerpts to study

These excerpts are intentionally short. Read the linked files around them; the
point is the design decision, not memorizing syntax.

1. **Renderer ownership** — [`src/app/main.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/app/main.tsx)

   ```tsx
   const renderer = await createCliRenderer({ exitOnCtrlC: false })
   createRoot(renderer).render(...)
   ```

   The code that creates the renderer owns terminal startup and cleanup.

2. **Dense flex layout** — [`src/ui/MainView.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/MainView.tsx)

   ```tsx
   style={{
     flexDirection: "row",
     flexGrow: 1,
     gap: 0,
     minHeight: 0,
   }}
   ```

   The important trick is not the row; it is allowing nested panes to grow and
   shrink without wasting terminal cells.

3. **Focus as color** — [`src/ui/Sidebar.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/Sidebar.tsx)

   ```tsx
   borderColor={focused ? theme.primary : theme.borderSubtle}
   ```

   Focus is a stable visual signal applied at the frame boundary.

4. **Modal layering** — [`src/ui/overlays/Overlay.tsx`](https://github.com/wilfredinni/noodle/blob/main/src/ui/overlays/Overlay.tsx)

   ```tsx
   zIndex: 10000,
   backgroundColor: RGBA.fromInts(0, 0, 0, 150),
   ```

   A dimmed, high-priority layer makes modal ownership obvious.

5. **Named binding metadata** — [`src/ui/keybind.ts`](https://github.com/wilfredinni/noodle/blob/main/src/ui/keybind.ts)

   ```ts
   return { default: value, description, fixed, category, contexts }
   ```

   A shortcut is documented data, not an unexplained event branch.

6. **Cancellation handle** — [`src/hooks/useResponse.ts`](https://github.com/wilfredinni/noodle/blob/main/src/hooks/useResponse.ts)

   ```ts
   const controller = new AbortController()
   abortRef.current = controller
   ```

   The hook keeps a direct handle for cancelling work that outlives one render.

## Recommendations for the real torrent-tui

| Decision | Recommendation | Trigger for changing it |
|---|---|---|
| Semantic palette | **Adopt now.** Define a small palette for background, panel, text, muted text, active, success, warning, and error. | Add user-selectable themes only after the first palette has good contrast. |
| Application shell | **Adopt now.** Use a dense list/details shell with an always-visible status line. | Add additional workspaces only when a real feature needs them. |
| Pane framing | **Adopt when the second pane exists.** Centralize border characters and active/inactive focus color. | Extract more primitives only when the same markup repeats. |
| Scrolling | **Adopt for torrent/file/peer lists.** Keep outer layout fixed and scroll only content regions. | Add virtualization or custom renderables only after large collections show a measured problem. |
| Async RPC | **Adopt now.** Keep the Transmission client outside JSX; model idle/loading/success/error and cancellation explicitly. | Add polling throttling or a shared external store only when refresh frequency or consumers require it. |
| Keymap | **Use direct handlers first.** `@opentui/keymap` is not currently installed here. | Add it when multiple views share commands, modes, priorities, or configurable shortcuts. |
| Command palette | **Defer.** A few torrent actions do not need a searchable command registry. | Add it after commands become numerous or discoverability becomes a problem. |
| Theme catalog | **Defer.** Noodle's many themes are product polish, not the first UI milestone. | Add a picker after the semantic palette and focus hierarchy are stable. |
| Persistence | **Keep minimal.** Persist only useful UI preferences such as selected torrent or layout. | Add a file-backed settings module when a preference must survive restart. |
| Noodle DAL features | **Avoid copying.** OAuth, cookies, importers, code generation, YAML editors, and timeline storage do not belong in the first torrent client. | Add a feature only when a torrent-tui requirement—not repository admiration—demands it. |
| Process ownership | **Keep Transmission external.** The TUI is an RPC client and must not stop the daemon on ordinary exit. | Revisit only if the product explicitly becomes a torrent engine. |

## Completion checklist

- [ ] Explain the bottom-up dependency flow from schema to UI.
- [ ] Explain the top-down startup flow from CLI to renderer and root app.
- [ ] Sketch the file/request/response path without opening every Noodle file.
- [ ] Explain why `gap: 0`, minimum sizes, scrollboxes, and semantic colors matter in a terminal.
- [ ] Trace one key through its context, layer, command, and overlay priority.
- [ ] Demonstrate one cancelled async operation and one rendered error state.
- [ ] Choose at least three Noodle patterns to adopt and three to defer in torrent-tui.
- [ ] Revisit the existing [Transmission study plan](./transmission-study-plan.md) before designing daemon-facing architecture.

## Reference commands

Run these from a separate checkout of Noodle, not from this project:

```bash
bun install
bun run dev -- --collection ./collections --env development
bun test
bun run typecheck
bun run lint
bun run build:bin
```

Use the sample collection for observation. The study does not require adding
Noodle dependencies to `torrent-tui`.
