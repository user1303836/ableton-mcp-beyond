# Supported and evidenced platform matrix

“Supported” is split into host/package support and real Ableton Live
certification. A green host cell is never promoted to a Live cell.

## Runtime and operating systems

| Surface | Version / architecture | Status | Evidence |
|---|---|---|---|
| Node.js | 22.x, 24.x, 25.x | Supported host/package contract only for a candidate whose exact-SHA matrix is green | `.github/workflows/ci.yml`; configuration or a result from another SHA is not evidence |
| Node.js | 26.x or future majors | Unsupported release runtime | Requires an explicit matrix and engine-range update |
| macOS host | GitHub `macos-15`; local macOS arm64 environment | Supported host/package contract only when the exact-SHA jobs pass | Node/package/lifecycle gates; separate local Live evidence is required |
| Windows host | GitHub Windows Server 2025 x64 (`windows-2025`) | Supported host/package contract only when the exact-SHA jobs pass | Node/package/lifecycle/ACL/junction/held-file gates; not Windows 11 or Live evidence |
| Windows desktop | Windows 11 x64 | Procedure documented, not certified | Requires exact-candidate host plus Live evidence; must not inherit Server status |
| Linux host | Ubuntu 24.04 x64 (`ubuntu-24.04`) | Supported host contract only | Node/package gates; no Live claim |

The package engine range is `>=22 <26`; an exact release may use Node 22, 24,
or 25. OS vendor lifecycle changes require a matrix update rather than implicit
support.

## Ableton Live

| OS | Live version / edition | Status | Evidence / limitation |
|---|---|---|---|
| macOS | Live 12.4.5b8 beta; installed edition is not exposed by the Remote Script status API | Observed engineering target, not a public release certification | `docs/evidence/`; must be rerun for the final candidate digest; edition remains explicitly unknown |
| macOS | Live 12 Suite | Negotiated contract, edition-specific certification missing | Common API is discovered at runtime; Suite devices/content are never assumed |
| macOS | Live 12 Standard | Negotiated contract, edition-specific certification missing | Missing devices/content remain unavailable |
| macOS | Live 12 Intro | Negotiated contract, edition-specific certification missing | Reduced feature/content surface remains unavailable |
| Windows 11 | Live 12 Suite / Standard / Intro | Not certified / external environment unavailable | Server-host CI is not Windows Live; each edition needs install, activation, mutation, restart, recovery, and uninstall evidence |
| Linux | Any | Unsupported | Ableton Live is not provided for Linux by this product |
| Live 11 or earlier | Any | Unsupported/unverified | Protocol/API compatibility is not claimed |

## Accessibility

The server-owned stdio text contract is tested for semantic order, plain text,
non-color status, and no pointer dependency. VoiceOver, Narrator, Ableton Live,
plug-in windows, terminals, and third-party MCP clients are version-dependent
external surfaces and are not certified by the server tests.

## Release implications

The private artifact can be built and lifecycle-tested without signing.
A private candidate is host-release-ready only when every exact-SHA Server
matrix job passes. Windows Server host evidence does not certify Windows 11,
Ableton Live, Narrator, or plug-in windows. Those external cells remain
explicitly unavailable until a suitable environment produces candidate-bound
evidence; they must not be rewritten as passing cells.
