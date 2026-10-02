<h1 align="center">torrent-tui</h1>

<p align="center">
  <strong>A keyboard-driven terminal interface for managing a Transmission session.</strong><br>
  View torrent progress and transfer rates, inspect details and files, and manage downloads from the terminal.
</p>

<p align="center">
  <a href="https://github.com/ryadios/torrent-tui/blob/main/package.json">
    <img alt="Version 0.2.0" src="https://img.shields.io/badge/version-0.2.0-4776e6?style=for-the-badge">
  </a>
  <a href="https://www.npmjs.com/package/torrent-tui">
    <img alt="npm unpacked size" src="https://img.shields.io/npm/unpacked-size/torrent-tui?style=for-the-badge">
  </a>
  <a href="https://www.npmjs.com/package/torrent-tui">
    <img alt="npm license" src="https://img.shields.io/npm/l/torrent-tui?style=for-the-badge">
  </a>
</p>

<p align="center">
  <a href="#install">Install</a> · <a href="#quickstart">Quickstart</a> · <a href="#commands">Commands</a> · <a href="#development">Development</a>
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/ryadios/torrent-tui/main/docs/screenshot.png" alt="torrent-tui terminal interface" width="100%">
</p>

> [!NOTE]
> Requires Bun and a running Transmission daemon with RPC enabled at `http://127.0.0.1:9091/transmission/rpc`. The RPC endpoint is fixed in this version.

## Install

```bash
git clone https://github.com/ryadios/torrent-tui.git
cd torrent-tui
bun install
```

## Quickstart

Start the TUI:

```bash
bun dev
```

| Key | Action |
| --- | --- |
| `j` / `k` or arrow keys | Move through torrents |
| `/` | Search by name; `Enter` applies, `Esc` clears |
| `Tab` / `Shift+Tab` | Switch focus between the list and details |
| `a` | Add a `.torrent` file, magnet link, or URL |
| `s` / `p` | Start / stop the selected torrent |
| `d` | Remove the selected torrent |
| `Enter` / `Shift+Enter` | In the remove prompt, keep / delete downloaded data |
| `←` / `→` | Switch tabs in the details pane |
| `j` / `k`, `Enter` | In the Files tab, move and expand items |
| `q` | Quit |

## Commands

```bash
bun run src/index.tsx --help
bun run src/index.tsx --version
bun run src/index.tsx list
bun run src/index.tsx add ./file.torrent
bun run src/index.tsx start <hash>
bun run src/index.tsx stop <hash>
bun run src/index.tsx remove <hash>
```

`add` accepts a local `.torrent` path, magnet link, or URL. Use a full torrent hash with `start`, `stop`, and `remove`. `remove` keeps downloaded data.

## Development

```bash
bun test
bunx biome check ./src ./tests
bunx tsc --noEmit
```
