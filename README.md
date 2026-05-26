# torrent-tui

**A Bun-powered terminal BitTorrent client.** Add `.torrent` files, manage active downloads, and inspect transfer state from a focused TUI.

[![npm version](https://img.shields.io/npm/v/torrent-tui?style=for-the-badge&logo=npm)](https://www.npmjs.com/package/torrent-tui)
[![CI](https://img.shields.io/github/actions/workflow/status/ryadios/torrent-tui/ci.yml?branch=main&style=for-the-badge&logo=github)](https://github.com/ryadios/torrent-tui/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/torrent-tui?style=for-the-badge)](./LICENSE)

[Install](#install) · [Quickstart](#quickstart) · [Commands](#commands) · [Configuration](#configuration) · [Development](#development)

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
| `a` | Add a `.torrent` file |
| `Space` | Pause or resume the selected torrent |
| `d` | Remove the selected torrent |
| `D` | Remove the selected torrent and downloaded files |
| `q` | Quit |

## Commands

The package also exposes a few command-line checks around the same torrent engine:

```bash
torrent-tui --help
torrent-tui --version
torrent-tui file.torrent --verify
torrent-tui file.torrent --handshake
torrent-tui file.torrent --download
```

| Command | Description |
| --- | --- |
| `torrent-tui` | Start the terminal UI. |
| `torrent-tui <file.torrent>` | Announce to trackers and print peers. |
| `torrent-tui <file.torrent> --verify` | Create storage and verify local pieces. |
| `torrent-tui <file.torrent> --handshake` | Connect to peers and print a connection summary. |
| `torrent-tui <file.torrent> --download` | Run the downloader without launching the TUI. |

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

## Status

`0.0.1` is a basic release intended for early CLI usage.

| Area | Status |
| --- | --- |
| `.torrent` metadata parsing | Available |
| HTTP and UDP trackers | Available |
| Peer handshakes and piece download | Available |
| Resume data | Available |
| Multi-torrent TUI | Available |
| Magnet links | Not included yet |
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
