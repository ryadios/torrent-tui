# Agent Guidelines for torrent-tui

## Build Commands

```bash
bun run src/index.ts    # Run the app
bun run dev             # Development mode (watch)
bun run check:fix       # Format and fix lint issues
```

## Project Overview

- **Runtime**: Bun | **UI**: @opentui/core (Core API) | **Validation**: Zod | **Language**: TypeScript (strict)

## Code Style

- **Formatter**: Biome | **Indentation**: Tabs | **Quotes**: Double
- **TypeScript**: Strict mode, explicit param types, prefer interfaces, no implicit `any`
- **Imports**: Relative paths, group external → internal → types, no barrel exports

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Classes | PascalCase | `App`, `Store`, `TorrentSession` |
| Methods/Variables | camelCase | `getState()`, `selectedIndex` |
| Files/Directories | kebab-case | `app-controller.ts`, `peer/` |

## Architecture

```
src/
├── index.ts                          # Entry: CLI arg → add torrent, then TUI
├── app.ts                            # TUI orchestration
├── torrent/                          # === BITTORRENT ENGINE ===
│   ├── parser.ts                     # Bencode encode/decode
│   ├── metadata.ts                   # TorrentMetadata class
│   ├── storage.ts                    # File I/O, piece read/write, hash verification
│   ├── session.ts                    # TorrentSession — top-level engine, event emitter
│   ├── piece-picker.ts               # Rarest-first selection, availability tracking
│   ├── types.ts                      # Core types: PeerInfo, PieceState, TorrentStatus
│   ├── tracker/                      # HTTP + UDP tracker clients
│   └── peer/                         # Peer ID, listener, connection, protocol, handshake, manager
├── store/                            # State management (Store class)
├── layout/                           # UI components (absolute positioning, update in-place)
├── controllers/                      # Keyboard + engine event handling
├── config/                           # Configuration I/O
├── theme/ └── constants/ └── types/ └── utils/
```

### Key Patterns

- **Store**: `getState()`, `setState(partial)`, `subscribe(listener)` — engine calls `setState()`, TUI subscribes
- **Engine → TUI**: EventEmitter via `store.setState()`, TUI render-throttled at 10 FPS
- **Components**: Build once in constructor with absolute positioning, `update()` modifies in-place, `updateLayout()` handles resize
- **Engine**: Single-threaded, async chunked hashing (one piece per tick), no workers
- **Never** call `process.exit()` — use `renderer.destroy()`

## Common Commands

```bash
bun add <package>       # Add dependency
npx tsc --noEmit        # Type check without building
```
