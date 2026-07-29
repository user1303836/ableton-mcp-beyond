<p align="center">
  <img src="docs/assets/logo.svg" width="100" alt="Ableton MCP Beyond logo" />
</p>

<h1 align="center">Ableton MCP Beyond</h1>

<p align="center">
  Safety-first MCP control of Ableton Live 12 —<br/>
  76 tools, an authenticated loopback bridge, and standards-based audio analysis.
</p>

<p align="center">
  English · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a>
</p>

<p align="center">
  <a href="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/user1303836/ableton-mcp-beyond/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license" /></a>
  <a href="apps/mcp-server/package.json"><img src="https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2025-339933?style=flat-square" alt="Node 22 | 24 | 25" /></a>
  <a href="https://modelcontextprotocol.io/specification/2025-11-25"><img src="https://img.shields.io/badge/MCP-2025--11--25-blue?style=flat-square" alt="MCP protocol 2025-11-25" /></a>
  <a href="docs/SUPPORT_MATRIX.md"><img src="https://img.shields.io/badge/Ableton%20Live-12-555555?style=flat-square" alt="Ableton Live 12" /></a>
</p>

---

**An MCP host that never guesses — and never wrecks your Set.**

- **Deep Live control** — transport, Session + Arrangement, clips, MIDI notes, mixer, automation, routing, recording, projects, subscriptions.
- **Device mastery** — recursive rack/chain/pad/macro discovery, guarded parameter edits, Browser search and load.
- **Audio intelligence** — ITU-R BS.1770-5 / EBU R128 loudness, validated true peak, reference-mix comparison. Works without Live.
- **Consent-bound capture** — resample one clip, analyze internally, delete every trace. Watchdog and emergency stop included.
- **Realtime control** — token-fenced UDP/OSC/XY channel with verified writes and an independent emergency stop.
- **Guided journeys** — `plan_user_journey` turns "make a lo-fi beat" into an ordered, confirmable, capability-aware plan.

## Quick start

Requires Node.js 22, 24, or 25. Ableton Live 12 for the bridge; the host, tests, and demo run without it.

```sh
cd apps/mcp-server
npm ci && npm run build
npm run demo      # a real MCP session, no Live required
npm test          # full suite
```

Point your MCP client at the server, and — to control Live — configure the bridge and install the Remote Script:

```sh
npm run setup -- --output /abs/path/client-config.json
npm run setup -- --output /abs/path/bridge-config.json \
  --bridge-host 127.0.0.1 --bridge-port 9000 \
  --secret-file /abs/path/bridge.secret
node dist/src/install-remote-script.js --destination '/abs/.../Remote Scripts/AbletonMcpBridge' --dry-run
```

Restart Live, then verify: `npm run diagnostics -- --config /abs/path/bridge-config.json`.
Full walkthrough: [docs/USER_GUIDE.md](docs/USER_GUIDE.md).

## Safety model

Every mutation follows **discover → preview → confirm → apply → verify → undo**. Idempotency keys, epoch fencing, and an execution ledger make lost acknowledgements safe to reconcile; arbitrary deletes are refused. Without an explicit bridge config the server is fail-closed — it cannot read or touch Live. See [docs/LIVE_SAFETY.md](docs/LIVE_SAFETY.md).

## Compatibility

| Surface | Status |
|---|---|
| Node.js 22 / 24 / 25 | Supported (CI-tested) |
| macOS + Live 12 | Verified against 12.4.5b8 beta ([evidence](docs/evidence/)) |
| Windows host | CI-tested; Windows 11 + Live not yet certified |
| Linux / Live 11 or earlier | Unsupported |

Capabilities are negotiated at connect time, so your agent always knows exactly what a given Live install can do. Full matrix: [docs/SUPPORT_MATRIX.md](docs/SUPPORT_MATRIX.md).

## Docs

| Doc | What it covers |
|---|---|
| [USER_GUIDE](docs/USER_GUIDE.md) | Tool list, mutation workflow, resources, prompts |
| [LIVE_SAFETY](docs/LIVE_SAFETY.md) | The real-Live safety boundary |
| [OPERATIONS](docs/OPERATIONS.md) / [RECOVERY](docs/RECOVERY.md) | Supervision, failure handling, uncertain-state recovery |
| [AUDIO_INTELLIGENCE](docs/AUDIO_INTELLIGENCE.md) | DSP standards, capture consent, privacy limits |
| [USER_JOURNEYS](docs/USER_JOURNEYS.md) | The five guided composition workflows |
| [REALTIME_CONTROL](docs/REALTIME_CONTROL.md) | The armed UDP/OSC/XY control plane |
| [CAPABILITY_MATRIX](docs/CAPABILITY_MATRIX.md) | Per-tool capability and operation requirements |
| [DELIVERY](docs/DELIVERY.md) | Install, upgrade, rollback, uninstall of packed artifacts |
| [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) | What's verified and what's still limited |

## License

Open source under the [MIT License](LICENSE.md). Ableton Live is a trademark of Ableton AG; this project is not affiliated with or endorsed by Ableton AG.
