# Testing

English · [简体中文](../zh-CN/TESTING.md) · [日本語](../ja/TESTING.md)

How to run the tests of each part of the repository, what they need, and what
CI runs. None of the ordinary tests need Live or a sign-in.

## Quick start

From a checkout, with Node 22/24 (Node 24 LTS recommended):

```sh
npm run setup                                   # install and build everything
npm test                                        # Kumi: the app, the runtime and the Live extension
(cd apps/mcp-server && npm test)                # the bridge
python3 -m unittest discover -s remote-script -p 'test_*.py'   # the Remote Script
```

Some checks need more than Node:

| Needs | For |
| --- | --- |
| Python 3 on PATH (`python3`, or `python.exe` on Windows; CI uses 3.11) | the Remote Script tests, `package:verify`, `journey:verify` |
| `ffmpeg` on PATH | `audio:oracle` |
| A locally supplied Extensions SDK in `vendor/` | building or type-checking the Live extension (its tests don't need it) |

On Windows, a few tests create symlinks, which needs Developer Mode or an
administrator account. Without it, some of them skip and a few fail with
`EPERM`; CI's Windows runner has the right.

## Kumi

Run from the repository root.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Builds the runtime, then type-checks the app and the runtime |
| `npm test` | Builds, then runs the app's, the runtime's and the Live extension's tests |
| `KUMI_TEST_BRIDGE=1 npm test` | The same, with the bridge interoperability test required rather than skipped; build the bridge first (`npm run setup` does) |

`npm test` gives the tests a home of their own: `HOME`, `USERPROFILE`,
`APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME` and `KUMI_HOME` point into a fresh
temporary folder, and `KUMI_REMOTE_SCRIPTS_DIR` and `KUMI_LIVE_EXTENSIONS_DIR`
are dropped, so no test can reach your Live folders or `~/.kumi`.

## The bridge

Run from `apps/mcp-server`, after `npm ci`.

| Command | What it does |
| --- | --- |
| `npm run typecheck` | Type-checks the bridge |
| `npm test` | Builds, runs every test file one at a time, then the script tests: release docs, capability manifest, docs drift and CI retention |
| `npm run property-test` | Property tests of the audio analysis on generated audio: bounded, finite, no raw PCM in results |
| `npm run coverage` | Tests with V8 coverage: at least 85% of lines, 65% of branches and 84% of functions overall, a floor for every module, and higher bars for delivery, lifecycle, host, remote-adapter, project and Session MIDI |
| `npm run benchmark` | Latency at the largest audio input, uninstrumented; not part of `npm test` or coverage |
| `npm run audio:oracle` | Compares the loudness and true-peak measurements with FFmpeg's `ebur128` on generated audio |
| `npm run compatibility` | `policy:verify` (the Node policy in package.json, CI and the docs), then this Node and system |
| `npm run package:verify` | Packs the bridge, installs the tarball and checks it (below) |
| `npm run journey:verify` | Installs the packed bridge and drives the five user journeys through it, against a fake Live |
| `npm run capability:manifest` | Regenerates `docs/evidence/capability-manifest.json` after a registry change; a test compares it |

`package:verify` refuses any file outside its own list, checks every hash in
`release-manifest.json` and that `LICENSE.md` matches the repository's. Then it
starts the installed server in both MCP protocol eras, runs `setup`, `migrate`
and `diagnostics`, runs the lifecycle (install, an activation that can't reach
Live, repair, a refused rollback, uninstall) in a folder whose name has spaces
and non-ASCII letters, and has the installed Remote Script answer an
authenticated discovery against a fake Live. `ABLETON_MCP_ARTIFACT=<tarball>`
makes `package:verify` and `journey:verify` check a given tarball instead of
packing one.

## The Remote Script

From the repository root:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
python3 -m compileall -q remote-script/AbletonMcpBridge
```

The tests run the Remote Script against fake Live objects: authentication,
sequencing, the main-thread queue, the registry and its hash, discovery,
transactions, capture and realtime safety, and the optional Willington provider.

## Kumi's Live extension

Root `npm test` runs `apps/live-extension/test`, which loads the committed
`dist/extension.js` against a fake Live and checks it against its recorded
sha256. Building it (`npm run build` in `apps/live-extension`) needs the
Extensions SDK in `vendor/`; without it, the committed build stays as it is.
After a rebuild, commit `dist/extension.js` with its `.sha256`.

## Checks with Live or a model

These are opt-in. They change real things or spend real tokens, so CI doesn't
run them.

| Command (from the root) | Needs | What it does |
| --- | --- | --- |
| `npm run accept:live --workspace @kumi/app -- --set "<Set>"` | Live with a disposable copy of a Set open | Makes every kind of change Kumi can, undoes each with Kumi's undo, plays, bounces, listens and watches, and times reads of a big Set. No model. |
| `npm run eval:changes --workspace @kumi/app [-- <case>, <case>]` | Your sign-in and model | How the model uses Kumi's tools, against a synthetic bridge with the real bridge's tool schemas. Never touches Live. Each case says its time, its tools' share of it, and how many model calls it took; `EVAL_EFFORT` sets the model's reasoning effort, and `EVAL_TRACE=1` prints each call. |
| `npm run probe:inference --workspace @kumi/app` | Your sign-in | One authenticated request with a harmless tool. Never touches Live. |

After the bridge's tools change, run `node apps/kumi/scripts/make-bridge-tools.mjs`
(with the bridge built) to refresh the schemas `eval:changes` uses. Its Operator,
Saturator and EQ Eight have every parameter Live 12.4 gives them, read from Live
into `apps/kumi/scripts/live-devices.json`, and it runs Kumi's own scripts for
setting parameters as Live does.

The bridge also has an operator-only capture check, `npm run audio:live-verify`
in `apps/mcp-server`. It needs a bridge installed by the lifecycle and activated
on real Live, a prepared disposable Set, and `PHASE8_CLI`, `PHASE8_RECEIPT`,
`PHASE8_EXPECTED_GIT_SHA`, `PHASE8_TARBALL_SHA`,
`PHASE8_EXPECTED_REGISTRY_HASH` and `PHASE8_OUTPUT_SAFETY_PROVENANCE` (optional:
`PHASE8_CONFIG`, `PHASE8_SET_NAME`, `PHASE8_LIVE_VERSION`,
`PHASE8_SOURCE_TRACK_INDEX`, `PHASE8_DESTINATION_TRACK_INDEX`,
`PHASE8_RECORDED_DIRECTORY`). It checks the installed files against the receipt
before touching Live, then records, cancels and recovers a capture, and puts
back everything it changed.

## Docs

After editing docs, from `apps/mcp-server` (once `npm ci` has run there):

```sh
npm run policy:verify
node --test scripts/docs-drift.test.mjs scripts/release-documentation.test.mjs
```

`policy:verify` checks that the docs stating the supported Node versions, and
the README badges, still say 22 and 24. The drift test checks that the English,
Chinese and Japanese user guides name the same tools, and that no file count
sits next to words like manifest or tarball (name `release-manifest.json`
instead). The release-documentation test stages the bridge's packed guides
and checks every link in them. `npm run package:verify` checks the same guides
inside the installed package.

## CI

Three workflows run on every pull request and every push to `main`:

| Workflow | Jobs | What runs |
| --- | --- | --- |
| **CI** | `Build exact local candidate` (Ubuntu, Node 24) | Whitespace check; packs the bridge twice (the second time from a fresh clone) and requires identical bytes; keeps the tarball as the `exact-local-candidate` artifact for 90 days |
| | `Coverage, benchmarks and the audio oracle` (Ubuntu, Node 24, beside the candidate) | The bridge's typecheck, coverage (the functional tests), the release scripts' tests, property tests, benchmark, `audio:oracle`, `compatibility` and `package:verify` |
| | `Node 22, 24 / ubuntu-24.04`, `Node 24 / macos-15`, `Node 24 / windows-2025 / candidate` and `/ tests 1/4` to `4/4` | The bridge's typecheck and tests (on Windows in four shards balanced by what each file costs there; `TEST_SHARD=1/4` picks one), property tests and `compatibility`; `package:verify`, `scripts/verify-candidate.mjs` and `journey:verify` against that same tarball; setup, migration and diagnostics |
| | `Python Remote Script contract` (the same three systems, Python 3.11) | Checks the Remote Script files against the tarball, runs the Python tests, compiles the package |
| | `Required CI` | Passes only when all of the above passed |
| **Kumi** | `Kumi / Node 22`, `Kumi / Node 24` (Ubuntu), `Kumi / macOS / Node 24`, `Kumi / Windows / Node 24` | Root typecheck, builds the bridge, `npm test` with `KUMI_TEST_BRIDGE=1`, `git diff --check` |
| **Installer** | `Build Kumi's Mac helper`, `Build the release bundle`, then `Install / macOS`, `Linux`, `Windows` | Builds the helper Kumi uses Live's menus with on a Mac (universal, signed), then the bundle with it, and serves it locally. On each system: installs as producers do (Windows PowerShell 5.1 on Windows), checks the version, `doctor` and the bridge loading, installs again as a repair, runs `kumi bridge --yes` into a scratch Remote Scripts folder, `kumi update` (and `--rollback` on macOS and Linux), and `kumi uninstall`. On a `v*` tag, `publish` then attaches the bundle to the release. |

To merge into `main`, `Required CI` and the four Kumi jobs must pass. The
Installer isn't required. [Releases and distribution](DISTRIBUTION_POLICY.md#merge-gate)
has the rest of the rules.

## What passing means

Passing shows the code behaves as its tests say, the packages install and run
on macOS, Linux and Windows, and the installer works on GitHub's runners. It
doesn't show that the Remote Script loads in your Live, that Live's API has the
shape the fakes have, how anything sounds, or that a terminal or screen reader
works with Kumi. The opt-in checks above, and the records in
[implementation status](IMPLEMENTATION_STATUS.md#evidence), cover real Live.

## Writing tests

For every new protocol method or change to Live, add a test that it works and
tests that it refuses what it should: stale references, revisions and epochs,
expired confirmations, a reused idempotency key, timeouts, cancellation before
and after it's sent, disconnects, a lost acknowledgement, partial changes,
failed compensation, a change made in Live meanwhile, and undo. Keep fake Live,
the simulator and real Live apart in what a test claims (`fake-live`,
`simulator` and `real-live` provenance). Keep fixtures small and free of
private data, and never let a test reach real Live folders or `~/.kumi`.
