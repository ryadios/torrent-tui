# torrent-tui

**A terminal BitTorrent client for focused download management.** Add `.torrent` files, track active transfers, and manage sessions from a clean keyboard-driven interface.

[![npm version](https://img.shields.io/npm/v/torrent-tui?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/torrent-tui)
[![gzipped](https://img.shields.io/badge/gzipped-39%20KB-2563eb?style=for-the-badge)](https://www.npmjs.com/package/torrent-tui)
[![npm unpacked size](https://img.shields.io/npm/unpacked-size/torrent-tui?style=for-the-badge)](https://www.npmjs.com/package/torrent-tui)
[![CI](https://img.shields.io/github/actions/workflow/status/ryadios/torrent-tui/release.yml?branch=main&style=for-the-badge&logo=github)](https://github.com/ryadios/torrent-tui/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/torrent-tui?style=for-the-badge)](./LICENSE)

[Install](#install) · [Quickstart](#quickstart) · [Commands](#commands) · [Configuration](#configuration) · [Development](#development)

![torrent-tui terminal interface](./docs/screenshot.png)

> [!NOTE]
> `torrent-tui` currently requires [Bun](https://bun.sh). Standalone binaries are planned after the npm CLI release path is stable.

> [!IMPORTANT]
> Use torrent clients only with content you have the right to download or share. `torrent-tui` is a client implementation, not a content source.

## Install

Run without installing:

```bash
bunx torrent-tui@latest
```

Or install globally:

```bash
bun add -g torrent-tui
torrent-tui
```

> [!TIP]
> If the global command is not found, add Bun's global bin directory to your shell path:
>
> ```bash
> export PATH="$HOME/.bun/bin:$HOME/.cache/.bun/bin:$PATH"
> ```

## Quickstart

Start the TUI:

```bash
torrent-tui
```

From inside the app:

| Key | Action |
| --- | --- |
| `j` / `k` or arrow keys | Move selection |
| `Tab` | Change focus |
| `a` | Add a `.torrent` file or magnet link |
| `/` in add dialog | Type a magnet link manually |
| `Space` | Pause or resume the selected torrent |
| `d` | Remove the selected torrent |
| `D` | Remove the selected torrent and downloaded files |
| `q` | Quit |

## Commands

The package also exposes a few command-line checks around the same torrent engine:

```bash
torrent-tui --help
torrent-tui --version
torrent-tui file.torrent
torrent-tui 'magnet:?xt=urn:btih:...'
torrent-tui file.torrent --verify
torrent-tui file.torrent --handshake
torrent-tui file.torrent --download
torrent-tui 'magnet:?xt=urn:btih:...' --download
```

| Command | Description |
| --- | --- |
| `torrent-tui` | Start the terminal UI. |
| `torrent-tui <file.torrent>` | Start the TUI and add the torrent. |
| `torrent-tui <magnet-uri>` | Start the TUI, fetch magnet metadata, cache it, and start the torrent. |
| `torrent-tui <file.torrent> --verify` | Create storage and verify local pieces. |
| `torrent-tui <file.torrent> --handshake` | Connect to peers and print a connection summary. |
| `torrent-tui <file.torrent> --download` | Run the downloader without launching the TUI. |
| `torrent-tui <magnet-uri> --download` | Fetch magnet metadata, cache it, then run the downloader without launching the TUI. |

Magnet support currently covers BitTorrent v1 `btih` magnets that include trackers (`tr`) or explicit peers (`x.pe`). DHT-only trackerless magnets are planned for the DHT phase. After metadata is cached, `--verify` and `--handshake` can use the same magnet URI.

## Configuration

Settings are stored at:

```text
${XDG_CONFIG_HOME:-~/.config}/torrent-tui/settings.json
```

Default settings:

```json
{
	"downloadPath": "~/Downloads",
	"maxConnections": 50,
	"torrentFolder": "~/Downloads"
}
```

Resume data is stored under:

```text
${XDG_DATA_HOME:-~/.local/share}/torrent-tui/resume
```

The session registry is stored at:

```text
${XDG_DATA_HOME:-~/.local/share}/torrent-tui/session.json
```

It keeps the list of torrents the TUI should restore on startup.

### Torrent States

The TUI shows detailed per-torrent states while keeping the sidebar filters simple.

| State | Meaning |
| --- | --- |
| `Queued` | The `.torrent` was accepted and is waiting for engine startup. |
| `Metadata` | A magnet link was accepted and metadata is being fetched from peers. |
| `Checking` | Local files are being checked against torrent piece hashes. |
| `Connecting` | Trackers were contacted and the client is connecting to peers. |
| `Downloading` | Pieces are actively being requested or received. |
| `Stalled` | The torrent is incomplete but has no usable peers right now. Press `Space` to retry. |
| `Paused` | The active downloader was paused by the user. |
| `Seeding` | All pieces are present and the torrent can upload to peers. |
| `Stopped` | The torrent is saved in the session but not running. |
| `Error` | Startup, storage, or torrent metadata handling failed. |

The `Downloading` sidebar filter includes queued, checking, connecting, downloading, and stalled torrents so active work stays grouped together.

### What Each Setting Does

| Setting | Purpose | When it applies |
| --- | --- | --- |
| `downloadPath` | Where torrent payload files are written and verified. | On torrent add, resume, verify, and startup restore. |
| `torrentFolder` | Folder shown by the add-torrent dialog. | When you open the add dialog. |
| `maxConnections` | Maximum number of peers the client will connect to per torrent. | During peer discovery and download. |

### Tuning Tips

- Use a fast local SSD for `downloadPath` if you want quicker verification and fewer stalls on reopen.
- Point `torrentFolder` at the directory where you keep `.torrent` files so adding torrents is faster.
- Lower `maxConnections` if your network or CPU struggles with many peers; raise it if you want more parallel peer selection.
- Fresh torrents skip full zero-file verification. Existing files are checked cooperatively, so the TUI should stay responsive during large rechecks.
- If a torrent stays `Stalled`, the client did not find a usable peer. Try again later with `Space`, or check tracker availability.
- Settings are read when the app starts. If you edit `settings.json` manually, restart the app to pick up the changes.
- If the settings file is invalid, torrent-tui falls back to defaults and logs a config warning.
- `session.json` and the resume files are rewritten automatically as torrent state changes, so you normally do not need to edit them by hand.

## Status

`0.0.1` is a basic release intended for early CLI usage.

| Area | Status |
| --- | --- |
| `.torrent` metadata parsing | Available |
| HTTP and UDP trackers | Available |
| Peer handshakes and piece download | Available |
| Resume data | Available |
| Multi-torrent TUI | Available |
| Magnet links | Available for tracker-backed v1 magnets |
| Standalone binaries | Not included yet |

## Development

```bash
bun install
bun run dev
```

Before opening a PR:

```bash
bun run typecheck
bun publish --dry-run
```

For formatting and lint fixes:

```bash
bun run check:fix
```

## Release Flow

Releases are published from GitHub Actions with generated GitHub release notes.

1. Update `package.json` and `src/constants/index.ts` to the new version.
2. Run local checks:

   ```bash
   bun run typecheck
   bun publish --dry-run
   ```

3. Commit and push the version change.
4. Run the **Release** workflow manually with the version number.

The workflow publishes to npm with trusted publishing, creates `vX.Y.Z`, and creates a GitHub release with `--generate-notes`.

## License

MIT
