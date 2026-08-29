# Transmission Practical Study Plan

**Time box:** one focused day, two days maximum
**Primary lab:** native Arch Linux with systemd
**Purpose:** learn Transmission before designing <code>torrent-tui</code>

This plan uses Transmission's own daemon and CLI tools. Use only content you
are allowed to download or share. The Arch Linux and Ubuntu release pages are
safe sources for test torrents: [Arch Linux downloads](https://archlinux.org/download/)
and [Ubuntu alternative downloads](https://ubuntu.com/download/alternative-downloads).

## Rules for the lab

1. Start with an isolated configuration directory so the real Transmission
   session is not changed.
2. Use <code>--no-portmap</code> during the first lab so the router is not modified.
3. Stop the daemon before manually editing <code>settings.json</code>;
   Transmission can overwrite settings while exiting.
4. Never map normal TUI exit to <code>session_close</code>.
5. Record the installed Transmission version before studying the RPC shape.
   Transmission 4.1 uses JSON-RPC 2.0 and snake_case; older releases use the
   deprecated RPC spelling described in the compatibility section of the
   specification.

Sources: [headless usage](https://github.com/transmission/transmission/blob/main/docs/Headless-Usage.md),
[RPC specification](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md),
[configuration editing](https://github.com/transmission/transmission/blob/main/docs/Editing-Configuration-Files.md).

## Day 1 — daemon, CLI, RPC, and persistence

### 1. Install and identify the tools — 15 minutes

Install the Arch package and verify the tools:

~~~fish
sudo pacman -S transmission-cli jq curl

transmission-daemon --version
transmission-remote --version
transmission-create --help
transmission-show --help
transmission-edit --help
~~~

Transmission identifies <code>transmission-remote</code> as the preferred CLI
client; <code>transmission-create</code>, <code>transmission-show</code>, and
<code>transmission-edit</code> handle <code>.torrent</code> creation,
inspection, and editing.
[Transmission repository](https://github.com/transmission/transmission),
[transmission-create man page](https://github.com/transmission/transmission/blob/main/utils/transmission-create.1),
[transmission-show man page](https://github.com/transmission/transmission/blob/main/utils/transmission-show.1),
[transmission-edit man page](https://github.com/transmission/transmission/blob/main/utils/transmission-edit.1)

### 2. Learn torrent metadata locally — 30 minutes

Create a small multi-file fixture and inspect its metadata:

~~~fish
set LAB /tmp/transmission-study
mkdir -p "$LAB/source/one" "$LAB/source/two"
printf 'alpha\n' > "$LAB/source/one/alpha.txt"
printf 'beta\n' > "$LAB/source/two/beta.txt"

transmission-create -o "$LAB/local.torrent" "$LAB/source"
transmission-show "$LAB/local.torrent"
transmission-show --magnet "$LAB/local.torrent"
~~~

Learn to identify the name, piece size, piece count, infohash, trackers, and
magnet representation. Do not implement bencoding or piece hashing in
<code>torrent-tui</code>; Transmission already owns those responsibilities.

### 3. Run an isolated foreground daemon — 45 minutes

~~~fish
set LAB /tmp/transmission-study
mkdir -p "$LAB/config" "$LAB/downloads" "$LAB/incomplete" "$LAB/watch" "$LAB/logs"

transmission-daemon \
  --foreground \
  --config-dir "$LAB/config" \
  --download-dir "$LAB/downloads" \
  --incomplete-dir "$LAB/incomplete" \
  --logfile "$LAB/logs/transmission.log" \
  --port 19091 \
  --peerport 51413 \
  --no-portmap
~~~

Keep this terminal open and use another terminal for the remaining commands.
The foreground mode is intentionally temporary: it makes process ownership
visible. It is not the persistence solution for the application.

Inspect the generated state:

~~~fish
set LAB /tmp/transmission-study
transmission-remote 127.0.0.1:19091 --session-info
transmission-remote 127.0.0.1:19091 --session-stats
transmission-remote 127.0.0.1:19091 --list
find "$LAB/config" -maxdepth 2 -type f -print
jq . "$LAB/config/settings.json"
tail -f "$LAB/logs/transmission.log"
~~~

Observe that Transmission owns configuration, torrent metadata, resume data,
and download state. [Configuration files](https://github.com/transmission/transmission/blob/main/docs/Configuration-Files.md)

### 4. Exercise the CLI and torrent lifecycle — 60 minutes

Add the official <code>.torrent</code> downloaded from the Arch or Ubuntu
release page:

~~~fish
set LAB /tmp/transmission-study
transmission-remote 127.0.0.1:19091 --add /absolute/path/to/file.torrent
transmission-remote 127.0.0.1:19091 --list
transmission-remote 127.0.0.1:19091 --torrent ID --info
transmission-remote 127.0.0.1:19091 --torrent ID --info-files
transmission-remote 127.0.0.1:19091 --torrent ID --info-peers
transmission-remote 127.0.0.1:19091 --torrent ID --info-trackers
transmission-remote 127.0.0.1:19091 --torrent ID --start
transmission-remote 127.0.0.1:19091 --torrent ID --stop
transmission-remote 127.0.0.1:19091 --torrent ID --reannounce
~~~

Also add the official release's magnet link with <code>--add</code>, then
observe metadata retrieval before starting it. Test <code>--json</code> output
and note the torrent's <code>hash_string</code>; numeric IDs are not stable
across daemon restarts.

### 5. Make the RPC request manually — 60 minutes

~~~fish
set RPC http://127.0.0.1:19091/transmission/rpc

curl -i -X POST "$RPC" \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"session_get","params":{},"id":1}'
~~~

The first request should demonstrate the HTTP <code>409</code> session-token
response. Capture the token and retry:

~~~fish
set RPC http://127.0.0.1:19091/transmission/rpc
set SID (curl -sD - -o /dev/null -X POST "$RPC" -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"session_get","params":{},"id":1}' | awk 'BEGIN{IGNORECASE=1}/^X-Transmission-Session-Id:/{print $2}' | tr -d '\r')

curl -s -X POST "$RPC" \
  -H 'Content-Type: application/json' \
  -H "X-Transmission-Session-Id: $SID" \
  --data '{"jsonrpc":"2.0","method":"session_get","params":{"fields":["version","rpc_version_semver","download_dir","peer_port"]},"id":1}' \
  | jq
~~~

Study these requests in the RPC specification:

- <code>session_get</code>
- <code>session_stats</code>
- <code>torrent_get</code> with <code>fields</code>
- <code>torrent_get</code> with <code>ids: "recently_active"</code>
- <code>torrent_add</code>
- <code>torrent_start</code> and <code>torrent_stop</code>
- <code>torrent_set</code>
- <code>torrent_remove</code>
- <code>port_test</code>
- <code>session_close</code>

Do not call <code>session_close</code> until the persistence lesson is complete.

### 6. Prove persistence with systemd — 60 minutes

Stop the isolated daemon first, then inspect the packaged unit:

~~~fish
systemctl list-unit-files 'transmission*'
systemctl cat transmission-daemon.service
systemctl show transmission-daemon.service \
  -p User -p Group -p ExecStart -p FragmentPath
~~~

Start and inspect the service:

~~~fish
sudo systemctl enable --now transmission-daemon.service
systemctl --no-pager status transmission-daemon.service
journalctl -u transmission-daemon.service -n 50 --no-pager
transmission-remote 127.0.0.1:9091 --session-info
~~~

Use the service's actual configuration and download paths; do not assume they
match the isolated lab. Close the terminal, log out if practical, and confirm
the service is still active. Restart it and confirm the torrent registry remains:

~~~fish
sudo systemctl restart transmission-daemon.service
transmission-remote 127.0.0.1:9091 --list
~~~

Study user-service lingering separately; it is not needed when using the
distribution's system service:

~~~fish
loginctl show-user "$USER" -p Linger
sudo loginctl enable-linger "$USER"
~~~

Sources: [ArchWiki Transmission](https://wiki.archlinux.org/title/Transmission),
[systemd service](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml),
[loginctl](https://www.freedesktop.org/software/systemd/man/252/loginctl.html).

## Day 2 — features and network services

### 7. File selection, limits, and queues — 75 minutes

Use the locally created multi-file torrent or another legal multi-file torrent.
Inspect and test:

- <code>files_wanted</code> and <code>files_unwanted</code>
- <code>priority_high</code>, <code>priority_normal</code>, and <code>priority_low</code>
- <code>sequential_download</code>
- <code>torrent_verify</code>
- <code>torrent_set_location</code>
- <code>torrent_rename_path</code>
- download/upload limits
- download and seed queue sizes
- seed ratio and idle seeding limits

Use <code>session_get</code> and <code>session_set</code> for session settings,
and <code>torrent_get</code>/<code>torrent_set</code> for torrent settings.
Confirm every mutation by reading the state back.
[RPC specification](https://github.com/transmission/transmission/blob/main/docs/rpc-spec.md),
[configuration options](https://github.com/transmission/transmission/blob/main/docs/Editing-Configuration-Files.md)

### 8. Understand the network services — 75 minutes

Study and observe these services without implementing them:

| Service/feature | What to learn | Practical check |
|---|---|---|
| Trackers | HTTP/UDP announce, scrape, tracker tiers, reannounce | <code>--info-trackers</code>, tracker stats, <code>--reannounce</code> |
| DHT | Distributed peer discovery for public/trackerless torrents | Read logs and inspect <code>dht_enabled</code> |
| PEX | Peer exchange after initial bootstrapping | Inspect peer-source fields and <code>pex_enabled</code> |
| LPD | Local multicast peer discovery | Read BEP 14 and inspect <code>lpd_enabled</code> |
| Peer port | Incoming TCP/UDP peer connections | Inspect <code>peer_port</code> |
| UPnP/NAT-PMP | Router port mapping | Keep disabled initially; study <code>port_forwarding_enabled</code> |
| Port test | External reachability check | RPC <code>port_test</code> with IPv4, optionally IPv6 |
| Web seeds | HTTP/FTP data source alongside peers | Inspect <code>webseeds_ex</code> on a torrent that provides web seeds |
| Encryption | <code>allowed</code>, <code>preferred</code>, or <code>required</code> peer policy | Inspect and change only in the isolated lab |

Sources: [BEP index](https://www.bittorrent.org/beps/bep_0000.html),
[DHT](https://www.bittorrent.org/beps/bep_0005.html),
[magnet metadata](https://www.bittorrent.org/beps/bep_0009.html),
[PEX](https://www.bittorrent.org/beps/bep_0011.html),
[LPD](https://www.bittorrent.org/beps/bep_0014.html),
[web seeds](https://www.bittorrent.org/beps/bep_0019.html),
[port forwarding](https://github.com/transmission/transmission/blob/main/docs/Port-Forwarding-Guide.md).

### 9. Hooks, blocklists, logging, and automation — 45 minutes

Read the completion-hook variables and understand when Transmission invokes
the added, done, and done-seeding scripts. If time permits, configure a
harmless local script that appends its environment to a file in the isolated
lab. Do not run untrusted downloaded scripts as a service user.

Also study:

- <code>message_level</code> and service journal logs.
- <code>blocklist_enabled</code>, <code>blocklist_url</code>, and <code>blocklist_update</code>.
- <code>watch_dir</code> and automatic <code>.torrent</code> ingestion.
- <code>start_paused</code>, incomplete directories, and partial-file naming.

Sources: [Transmission scripts](https://github.com/transmission/transmission/blob/main/docs/Scripts.md),
[blocklists](https://github.com/transmission/transmission/blob/main/docs/Blocklists.md),
[configuration options](https://github.com/transmission/transmission/blob/main/docs/Editing-Configuration-Files.md).

### 10. Cross-platform decision checkpoint — 30 minutes

Answer these questions after the Linux lab:

1. Is the RPC client independent of the operating system? Yes: it talks to an
   HTTP endpoint and handles Transmission's RPC contract.
2. Does the TUI need to install or control services? Not for the first version.
3. Is Linux-only acceptable for v1? It removes service-manager, permissions,
   packaging, and path complexity while preserving a portable RPC boundary.

For future support, study macOS <code>launchd</code> and Windows Service
Control Manager:

- [Apple launchd services](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Microsoft <code>sc.exe</code> service control](https://learn.microsoft.com/windows/desktop/Services/controlling-a-service-using-sc)
- [Transmission platform overview](https://github.com/transmission/transmission)

Recommended conclusion: target Linux first, keep RPC code portable, provide
platform setup documentation later, and do not add service-control adapters
until each platform has been tested directly.

## Completion checklist

The study is complete when you can explain and demonstrate:

- Why closing the TUI does not stop the daemon.
- How systemd starts, supervises, logs, and restarts Transmission.
- Where Transmission stores configuration, torrent metadata, and resume data.
- How the RPC session-token handshake works.
- Why torrent hashes are safer than numeric IDs.
- How to list, add, start, stop, verify, reannounce, move, and remove torrents.
- How <code>recently_active</code> can drive a TUI refresh loop.
- What trackers, DHT, PEX, LPD, UPnP/NAT-PMP, web seeds, and peer ports do.
- Which actions are destructive or security-sensitive.
- Whether the first application release should remain Linux-only.

Do not begin application architecture until these answers are clear. The first
future coding exercise should be a small RPC connection/status prototype, not a
new torrent engine.
