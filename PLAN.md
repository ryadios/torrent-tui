# Torrent Client — Implementation Plan

> Stack: Bun + TypeScript + opentui.
> Keep this file focused on active and future work. Completed phase bodies were removed to reduce AI-agent context cost.

---

## How to Use This Plan

- **Start with the first non-complete phase** and update task status as work lands: `❌ Not started` → `🔄 In progress` → `✅ Done`.
- **Use `REPORT.md` for prioritization**. The scored problem list and reasoning live there, not in this file.
- **Avoid adding summary-table output** for future TUI phases unless the work is engine-only and can be verified with plain CLI args.

---

## Progress Overview

| Phase | Title | Status | User-visible result |
|---|---|---|---|
| **0** | Foundation — parse, announce, get peers | ✅ Complete | CLI can read a `.torrent`, contact trackers, and print discovered peers |
| **1** | Metadata & Storage | ✅ Complete | Client understands torrent contents and prepares/verifies files on disk |
| **2** | Peer Connection & Handshake | ✅ Complete | Client can connect to real peers and show handshake/availability results |
| **3** | Piece Download + Resume | ✅ Complete | CLI can download pieces, save progress, and resume after restart |
| **4** | Multi-Peer, Seeding & Choking | ✅ Complete | Downloads can use multiple peers and upload verified pieces back to the swarm |
| **5** | UDP Tracker | ✅ Complete | Torrents with UDP trackers can find peers instead of failing tracker discovery |
| **6** | TUI Integration | ✅ Complete | TUI shows live torrent progress, speed, status, and add-torrent flow |
| **7** | Multi-Torrent, Pause/Resume, Delete | ✅ Complete | Users can manage multiple torrents, pause/resume, delete, and restore sessions |
| **8** | Detail Panel (Pieces / Peers / Files) | ✅ Complete | Users can inspect selected torrent pieces, peers, and files in the TUI |
| **9** | Test Harness and Engine Fixtures | ✅ Complete | Users see fewer regressions; contributors can change engine code with confidence |
| **10** | Recheck and Hashing Performance | ✅ Complete | Large torrents verify faster and the TUI stays responsive during checks |
| **11** | Download Reliability | ✅ Complete | Downloads finish more consistently and peer lists stay fresh over time |
| **12** | Extension Protocol and Magnet Metadata | ✅ Complete | Users can add magnet links, not only `.torrent` files |
| **13** | Peer Discovery Expansion | ✅ Complete | More torrents find peers even when trackers are missing, stale, or incomplete |
| **14** | Engine Controls | ✅ Complete | Users cap bandwidth; file picker dialog selects which files to download before start |
| **15** | Additional Protocol Reliability | ✅ Complete | More edge-case torrents and network environments work correctly |
| **16** | CLI and API Polish | ✅ Complete | CLI becomes easier to script, document, complete, and integrate |
| **17** | TUI Search and Categories | ✅ Complete | Users can quickly find torrents and route new torrents into category paths |
| **18** | TUI Sources and Tracker Controls | ❌ Not started | Users can diagnose peer sources and manage tracker health from the details panel |
| **19** | Optional and Niche Features | ❌ Not started | Adds non-core workflows only if project direction expands |

---

## Completed Work Archive

Phases 0-7 are complete and their detailed implementation plans were removed from this document to keep it small for AI agents. Use git history if the old task tables, console-output examples, or interface-contract notes are needed.

Current completed capability baseline:

| Area | Implemented capability |
|---|---|
| Torrent parsing | Bencode encode/decode, metadata parsing, info hash calculation, single-file and multi-file layout |
| Trackers | HTTP trackers, BEP 12 announce-list, UDP trackers, compact peer parsing |
| Peer protocol | Peer ID, handshake, message buffer, protocol encode/decode, bitfield/have/request/piece/cancel handling |
| Download engine | Storage setup, piece verification, resume data, multi-peer download, rarest-first picker, pipelining |
| Swarm behavior | Inbound listener, peer manager, choking/optimistic unchoke, seeding verified pieces |
| TUI | Status bar, torrent table, add torrent dialog, toast/confirm dialogs, sidebar status filtering |
| Multi-torrent | Concurrent torrents, pause/resume, delete with/without files, persisted session registry |

Important retained implementation notes:

- Do not call `process.exit()` from TUI code; use renderer cleanup.
- `loadResume()` must not override `verifyAll()`; verification is the source of truth after files are deleted or changed.
- OpenTUI shifted keys report as lowercase plus `key.shift: true`; do not rely on uppercase key names.
- Normal piece completion must not send `cancel`; `cancel` belongs to endgame mode only.

---

## Phase 8: Detail Panel ✅ Complete

### Goal

Add a TUI-only detail panel for the selected torrent. Phase 8 does not add logging/debugging output; verification is based on visible TUI behavior and typecheck.

**User-visible result:** Selecting a torrent now reveals a bottom details area where users can switch between piece progress, connected peers, and torrent file contents.

### TUI Behavior

| Feature | Behavior |
|---|---|
| Detail panel layout | Bottom split under the torrent table, same width as the torrent table, with its own border |
| Tabs | `Pieces`, `Peers`, `Files` |
| Tab navigation | `h` / `l` and `[` / `]` switch detail tabs while details is focused |
| Focus navigation | `Tab` cycles sidebar → table → details |
| CLI arg entry | `bun run start file.torrent` opens the TUI and adds/starts the torrent |

### Tasks

| # | Task | Status | Observable Output |
|---|---|---|---|
| 8.1 | Update store torrent detail shape for pieces, peers, and files | ✅ Done | `TorrentState` includes `pieceLength`, `peerDetails`, and `files` |
| 8.2 | Add same-width bordered `DetailPanel` bottom split with Pieces tab | ✅ Done | TUI shows a bottom `DetailPanel` with `Pieces` tab and progress metadata |
| 8.3 | Add Peers tab | ✅ Done | TUI shows peer count and peer rows when peer details are available |
| 8.4 | Add Files tab | ✅ Done | TUI shows torrent payload file paths and sizes |
| 8.5 | Wire details focus and `h` / `l` plus `[` / `]` detail tab navigation | ✅ Done | `Tab` focuses details; detail keys change the highlighted detail tab |
| 8.6 | Add CLI arg TUI entry | ✅ Done | `bun run start test.torrent` opens the TUI and adds/starts the torrent |

### Phase 8 Verification

1. `bun run typecheck` passes.
2. `bun run smoke` passes.
3. `bun run start test.torrent` opens the TUI and shows the torrent list.
4. Detail panel appears at the bottom of the content window with the same width as the torrent table and a separate border.
5. `Pieces` tab shows selected torrent progress.
6. `Tab` cycles sidebar → table → details, and `h` / `l` or `[` / `]` switches between `Pieces`, `Peers`, and `Files` while details is focused.
7. `Peers` tab shows connected peer details when peers are available.
8. `Files` tab shows torrent file paths and sizes.

---

## Long-Term Roadmap

Future work should prioritize **performance >= reliability/protocol features > CLI quality > UI/UX**. See `REPORT.md` for scoring and reasoning.

### Phase 9: Test Harness and Engine Fixtures

**Goal:** Build a regression safety net before larger protocol and performance changes.

**User-visible result:** Users should experience fewer broken releases and fewer regressions after future engine changes.

| # | Task | Status | Verification |
|---|---|---|---|
| 9.1 | Add Bun test setup and fixture conventions | ✅ Done | `bun test` discovers torrent engine tests |
| 9.2 | Add parser and metadata fixtures | ✅ Done | Bencode round trips, `info_hash`, single-file, and multi-file cases pass |
| 9.3 | Add peer protocol/message-buffer fixtures | ✅ Done | Partial TCP frames and message encode/decode cases pass |
| 9.4 | Add tracker response fixtures | ✅ Done | HTTP/UDP compact peer parsing and tracker errors are covered |
| 9.5 | Add storage, resume, and downloader state tests | ✅ Done | Piece verification, stale resume, pause/resume, and completion cases pass |

### Phase 10: Recheck and Hashing Performance

**Goal:** Improve large-torrent verification throughput while keeping the TUI responsive.

**User-visible result:** Opening or resuming large torrents should spend less time checking files, and the TUI should not feel frozen while checking.

| # | Task | Status | Verification |
|---|---|---|---|
| 10.1 | Benchmark current verification behavior on representative fixture sizes | ✅ Done | CLI benchmark output records pieces/sec and max event-loop delay |
| 10.2 | Improve verification scheduling and cancellation | ✅ Done | TUI remains responsive while checking; stopped torrents cancel cleanly |
| 10.3 | Add worker-backed or parallel hashing path if benchmarks justify it | ✅ Done | Benchmarks stayed below the worker threshold without corrupting storage state |
| 10.4 | Add regression coverage for verification progress and resume consistency | ✅ Done | `bun test` covers valid, missing, and corrupt piece states |

### Phase 11: Download Reliability ✅ Complete

**Goal:** Fix completion stalls and tracker lifecycle gaps before adding larger peer-discovery systems.

**User-visible result:** Downloads should be less likely to stall near the end, and long-running torrents should keep finding peers without restarting the app.

| # | Task | Status | Verification |
|---|---|---|---|
| 11.1 | Add endgame mode for the final outstanding blocks | ✅ Done | Last pieces can be requested from multiple peers and duplicate responses are ignored safely |
| 11.2 | Send `cancel` only for redundant endgame requests | ✅ Done | Protocol tests confirm normal piece completion does not send cancel |
| 11.3 | Re-announce to trackers at their returned intervals | ✅ Done | Peer refresh happens without restarting the torrent |
| 11.4 | Send tracker `started`, `completed`, and `stopped` events | ✅ Done | CLI download emits correct tracker lifecycle requests |
| 11.5 | Add tracker retry/backoff and peer merge behavior | ✅ Done | Failed trackers do not block healthy trackers or existing peers |

### Phase 12: Extension Protocol and Magnet Metadata ✅ Complete

**Goal:** Complete BEP 10 support and use it to add BEP 9 magnet metadata downloads.

**User-visible result:** Users can paste or open magnet links directly; the client fetches metadata from peers and starts the torrent without a `.torrent` file.

| # | Task | Status | Verification |
|---|---|---|---|
| 12.1 | Parse and advertise BEP 10 extension handshakes | ✅ Done | `extension.ts` builds reserved bytes and encodes/decodes extension handshakes; `PeerConnection` sends the handshake on connect when `extensionCapable` |
| 12.2 | Add extension message routing in `PeerConnection` | ✅ Done | `onExtendedMessage` routes to extension handshake or `ut_metadata` handler; unknown extensions are logged and ignored safely |
| 12.3 | Parse magnet URIs in CLI and TUI add flows | ✅ Done | `parseMagnetUri` handles hex/base32 btih, trackers, x.pe peers, display name; `app.ts` and `index.ts` both route magnet inputs to `bridge.addMagnet`; add-torrent dialog accepts magnet input |
| 12.4 | Implement BEP 9 `ut_metadata` request/response flow | ✅ Done | `magnet-resolver.ts` discovers peers, fetches all metadata pieces via extension protocol, assembles and verifies by info hash, builds a `.torrent` file in memory |
| 12.5 | Persist fetched metadata for future starts | ✅ Done | Fetched metadata is written to `~/.local/share/torrent-tui/metadata/<hash>.torrent`; resolver checks cache before connecting to peers |

### Phase 13: Peer Discovery Expansion ✅ Complete

**Goal:** Reduce dependence on trackers by adding DHT first, then PEX.

**User-visible result:** Torrents with dead, weak, or missing trackers should still find peers through DHT and peer exchange.

| # | Task | Status | Verification |
|---|---|---|---|
| 13.1 | Implement BEP 5 DHT node ID, routing table, and bootstrap | ✅ Done | DHT node IDs persist, bootstrap nodes seed a bounded routing table, and torrent `nodes` are parsed |
| 13.2 | Implement DHT `get_peers` / `announce_peer` flow | ✅ Done | Trackerless magnets and torrents can discover peers from DHT; complete torrents announce back to DHT |
| 13.3 | Merge DHT peers into the existing peer manager | ✅ Done | Tracker, DHT, and PEX peers flow through one `PeerManager.connect()` path with duplicate and banned-peer filtering |
| 13.4 | Implement BEP 11 PEX over the extension protocol | ✅ Done | Peers advertise `ut_pex`, decode incoming PEX peers, and send added/dropped peer batches |

### Phase 14: Engine Controls ✅ Complete

**Goal:** Add controls that make downloads predictable and manageable for real users.

**User-visible result:** Users can cap download/upload speeds and skip unwanted files in multi-file torrents.

| # | Task | Status | Verification |
|---|---|---|---|
| 14.1 | Add download/upload speed limits | ✅ Done | `downloadRateLimitBps` / `uploadRateLimitBps` in settings.json; token-bucket enforced in Downloader |
| 14.2 | Improve bandwidth accounting across peers and torrents | ✅ Done | Speed reported via 1s setInterval; per-file ━━━ progress bars in Files tab |
| 14.3 | Add file selection picker | ✅ Done | `FilePickerDialog` opens after add for multi-file torrents; `skippedFileIndices` drives piece picker; persisted to resume |
| 14.4 | Single-file torrents skip picker | ✅ Done | Picker only appears when torrent has >1 file; single-file starts immediately |

### Phase 15: Additional Protocol Reliability

**Goal:** Fill mature-client protocol gaps after core discovery, completion, and controls are stable.

**User-visible result:** More torrents work in real-world conditions, including torrents with web seeds, padding files, LAN peers, or peers requiring encryption.

| # | Task | Status | Verification |
|---|---|---|---|
| 15.1 | Add BEP 19 WebSeed support | ✅ Done | Torrents with HTTP seeds can download and verify pieces from web seeds |
| 15.2 | Add blocklist loading and peer filtering | ✅ Done | Blocked peers are not connected or accepted inbound |
| 15.3 | Add protocol encryption / MSE-PE | ✅ Done | Encrypted-capable peers can connect without breaking plaintext peers |
| 15.4 | Add BEP 47 padding file handling | ✅ Done | Padding files are not exposed as normal user payload files |
| 15.5 | Add LSD peer discovery | ✅ Done | LAN peers can be discovered without trackers |

### Phase 16: CLI and API Polish ✅ Complete

**Goal:** Improve power-user workflows once the engine behavior is reliable.

**User-visible result:** Users can inspect torrents from the CLI and read man-page help.

| # | Task | Status | Verification |
|---|---|---|---|
| 16.1 | Add `torrent-tui <file.torrent> --info` | ✅ Done | CLI prints torrent metadata without starting the TUI |
| 16.2 | Add shell completions | ⏭️ Dropped | Dropped after review because Bun global installs cannot activate them reliably or automatically |
| 16.3 | Add a man page | ✅ Done | Packaged install includes local CLI documentation |
| 16.4 | Add stable programmatic engine exports | ⏭️ Dropped | Dropped after scope review; keep package focused on the CLI/TUI for now |
| 16.5 | Add scripting hooks | ⏭️ Deferred | Deferred by product decision; automation hooks can be planned later |

### Phase 17: TUI Search and Categories ✅ Complete

**Goal:** Add the low-risk TUI organization workflow from mature clients before deeper source diagnostics.

**User-visible result:** Users can search the torrent list by name, manage category save-path presets, and choose a category/save directory while adding a torrent.

#### Product Direction

qBittorrent's category model is the best fit for this project because it maps a simple user choice to a concrete save path. Transmission labels and Deluge add options point in the same direction: users expect to choose where a torrent lands during add, without editing global config for every torrent.

- qBittorrent-style categories as save-path presets during add, implemented with a small local config shape rather than automatic torrent management.
- A name-only quick search for the table; sorting and advanced filtering stay out of this phase.
- Category sidebar filters were dropped after implementation review. Categories now route save paths and can be managed, but the sidebar remains status-only.
- Tags stay secondary. Add them only as non-routing labels if they fit cleanly after category paths are working.

#### Architecture Notes

- Treat **category** as the path-driving preset: one torrent has at most one category, and each category may define a default save path.
- Treat **tags** as non-routing labels. Do not add tag-driven paths in this phase; add tags only if they can be represented cleanly as metadata labels without changing storage behavior.
- Per-torrent save paths require `TorrentBridge` / `TorrentEntry` to stop assuming the global `downloadPath` for every active torrent.
- Existing sessions without category/save-path metadata must continue to restore using the current global download path behavior.

| # | Task | Status | Verification |
|---|---|---|---|
| 17.1 | Add category settings with default save paths | ✅ Done | Settings persist categories with name and save path; invalid defaults are normalized |
| 17.2 | Add per-torrent category and save-path state | ✅ Done | `TorrentState` and the session registry preserve category, category name, frozen save path, and target path without breaking existing sessions |
| 17.3 | Add category/save-path selection to the add flow | ✅ Done | After choosing a `.torrent` or resolving magnet metadata, users choose category/save path before file selection/start; the chosen path is used for storage and resume |
| 17.4 | Add sidebar category section | ⏭️ Dropped | Category/uncategorized sidebar filters were removed; the sidebar now stays status-only while categories remain save-path presets |
| 17.5 | Add name-only quick search for the torrent table | ✅ Done | `/` opens search mode; torrent rows narrow by name only; clearing search restores the current status view |
| 17.6 | Persist category/save-path restore behavior | ✅ Done | Restored torrents keep their category, save path, selected files, and progress after app restart |
| 17.7 | Add category management and path-picking dialogs | ✅ Done | Users can create/edit/delete category presets, browse paths within the home directory, and see long paths trimmed with `~` home abbreviation |

#### Phase 17 Verification

1. `bun test` passes, including focused tests for category settings, per-torrent save paths, restore behavior, category dialogs, directory picking, sidebar rows, and name search filtering.
2. `npx tsc --noEmit` passes.
3. `bun run check:fix` passes.
4. TUI add flow can choose a category path, select files if needed, and start the torrent from that path.
5. Restarting the app restores category, save path, and file selection without corrupting existing sessions.

### Phase 18: TUI Sources and Tracker Controls

**Goal:** Surface the engine's discovery behavior so users can diagnose stalled torrents without logs.

**User-visible result:** Users can inspect trackers, DHT, PEX, LSD, and web seeds in a `Sources` tab and refresh tracker discovery from the TUI.

#### Product Direction

qBittorrent, Transmission, Deluge, and rTorrent all expose more than aggregate speed/progress once a user selects a torrent. This phase keeps that power scoped to diagnostics and tracker controls:

- qBittorrent-style tracker/source visibility and controls, rendered as a compact TUI `Sources` tab.
- Transmission-style peer-source and tracker runtime fields, kept in app state instead of requiring an external RPC layer.
- Runtime diagnostics first; persist only user-owned tracker overrides.

#### Architecture Notes

- Do not mutate original `.torrent` files when users add/edit trackers.
- Keep source diagnostics runtime-first. Persist tracker overrides only if add/remove tracker actions land.
- Tracker/source state should flow from `TrackerCoordinator` / `DiscoveryCoordinator` into `TorrentBridge`, then into `TorrentState`.
- If tracker editing risks delaying the phase, ship read-only diagnostics plus manual refresh first and leave edit actions as a follow-up task.

| # | Task | Status | Verification |
|---|---|---|---|
| 18.1 | Add source diagnostics state for trackers, DHT, PEX, LSD, and web seeds | ❌ Not started | Store state can show tracker URL/status/error/seed/leech counts, source peer counts, web seed availability, and last/next announce data for the selected torrent |
| 18.2 | Add a `Sources` detail tab | ❌ Not started | Detail panel includes `Sources`; users can inspect tracker/source health for the selected torrent |
| 18.3 | Add manual source refresh/reannounce | ❌ Not started | Users can trigger tracker refresh/reannounce from the TUI and see source state update |
| 18.4 | Add tracker edit actions if the data model is ready | ❌ Not started | Users can add/remove tracker URLs without modifying the original `.torrent`; overrides persist across restart |
| 18.5 | Add source-state regression coverage | ❌ Not started | Tests cover tracker success/failure state, DHT/PEX/LSD peer source counts, and refresh actions |

#### Phase 18 Verification

1. `bun test` passes, including focused tests for source-state mapping and manual refresh actions.
2. `npx tsc --noEmit` passes.
3. `Sources` tab shows tracker/source diagnostics for a real torrent.
4. Manual refresh/reannounce updates source state without restarting the torrent.
5. Tracker overrides, if implemented, survive restart without modifying original `.torrent` files.

### Phase 19: Optional and Niche Features

**Goal:** Only pursue these if project goals expand beyond the current download-first Bun TUI.

**User-visible result:** Adds secondary workflows such as sequential downloading, torrent creation, custom themes, or broader runtime/peer-transport compatibility.

| # | Task | Status | Verification |
|---|---|---|---|
| 19.1 | Add sequential download mode | ❌ Not started | Piece picker can switch between rarest-first and sequential modes |
| 19.2 | Add torrent creation | ❌ Not started | CLI can create valid single-file and multi-file `.torrent` files |
| 19.3 | Add color customization | ❌ Not started | User theme settings load from config |
| 19.4 | Reconsider Node.js compatibility | ❌ Not started | Decision record explains runtime tradeoffs before code changes |
| 19.5 | Reconsider WebRTC support | ❌ Not started | Decision record explains whether WebTorrent compatibility is a goal |

---

## Reference: BitTorrent Protocol Facts

- **Block size**: 2^14 = 16,384 bytes. Close connections requesting more.
- **Pipelining**: Keep several piece requests queued at once; libtorrent default is 10-20.
- **Keepalive**: Send every 2 minutes. Timeout dead connections quickly when data is expected.
- **Choking**: Recalculate every 10 seconds. Unchoke top 4 by download rate, or upload rate when seeding. Use 1 optimistic unchoke rotating every 30 seconds.
- **Cancel messages**: Only send during endgame mode. Do not send cancel on normal piece completion.
- **Bitfield**: Sent as first message after handshake. Skip if client has no pieces yet.
- **Peer count**: Above roughly 25 peers, new peers are unlikely to increase download speed much. Default 50 is fine; effective ceiling is about 30-40 active peers.
- **Port**: Try 6881 first, then 6882-6889.
- **Inbound connections**: Required for full swarm participation. Without it, peers discovered via tracker cannot connect back to you.
