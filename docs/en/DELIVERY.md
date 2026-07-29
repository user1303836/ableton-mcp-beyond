# Cross-platform delivery and lifecycle

English · [简体中文](../zh-CN/DELIVERY.md) · [日本語](../ja/DELIVERY.md)

## Release artifact and channel

The release artifact is an exact-SHA npm tarball from `npm pack`, installed by
local path and SHA-256. It is unsigned, unnotarized, and not published to npm.
The repository source is MIT-licensed; the packaged `package.json` still
carries `private`/`UNLICENSED` metadata from before the repository went
public, which the lifecycle verifier enforces and which is tracked for a
release-pipeline update.

`package:verify` rejects every
path outside the exact allowlist and verifies `release-manifest.json` against
every compiled runtime, Remote Script, registry, document, and license byte.
The tarball may contain only compiled runtime JavaScript and declarations, the
Remote Script with its registry and manifest, the release manifest and package
metadata, the MIT license file, and the allowlisted user/safety/operations
documents. Tests, verification scripts, source maps, dependencies, secrets,
configs, state, backups, logs, captured media, evidence, and protected local
material are excluded.

The manifest records the package version, exact source commit and dirty flag,
Node range, host/bridge protocol, canonical registry hash, distribution channel,
signing/notarization/publication state, file roles, and SHA-256 values. A
release candidate must come from a clean commit. SHA-256 proves byte integrity,
not publisher identity.

## Supported matrix

Node 22, 24, and 25 are explicit supported majors. Linux, macOS, and Windows
host/package contracts run in CI. Live certification is separate and is never
inferred from a host test; see [SUPPORT_MATRIX.md](SUPPORT_MATRIX.md).

## Exact platform setup

### macOS 15 (bash/zsh)

Use the user Remote Scripts directory; do not write inside the Live application
bundle. Preserve spaces exactly:

```sh
ARTIFACT="$(cd "$(dirname '/absolute/candidate.tgz')" && pwd)/$(basename '/absolute/candidate.tgz')"
ARTIFACT_SHA="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
INSTALL_ROOT="$HOME/Library/Application Support/AbletonMcp/package"
STATE="$HOME/Library/Application Support/AbletonMcp/state"
REMOTE_SCRIPTS="$HOME/Music/Ableton/User Library/Remote Scripts"
mkdir -p "$INSTALL_ROOT" "$REMOTE_SCRIPTS"
npm install --prefix "$INSTALL_ROOT" --ignore-scripts --no-audit --no-fund "$ARTIFACT"
PACKAGE_ROOT="$INSTALL_ROOT/node_modules/@ableton-mcp/mcp-server"
LIFECYCLE="$INSTALL_ROOT/node_modules/.bin/ableton-mcp-lifecycle"
```

Stop Live from its normal UI and verify it has exited; the lifecycle never
kills it. Run the install commands below. Restart Live, open **Live → Settings
→ Link, Tempo & MIDI**, choose `AbletonMcpBridge` in a Control Surface row, then
run `activate`. For uninstall, run lifecycle uninstall while Live is stopped,
restart Live to unload the script, update MCP client configuration, then remove
`$INSTALL_ROOT` only after status/evidence is retained.

### Windows Server 2025 host contract / Windows Live procedure (PowerShell)

The hosted host contract uses Windows Server 2025. Windows 11 + Ableton Live is
not certified; these are the exact operator steps to gather that missing cell,
not a passing claim:

```powershell
$Artifact = (Resolve-Path 'C:\absolute\candidate.tgz').Path
$ArtifactSha = (Get-FileHash -Algorithm SHA256 $Artifact).Hash.ToLowerInvariant()
$InstallRoot = Join-Path $env:LOCALAPPDATA 'AbletonMcp\package'
$State = Join-Path $env:LOCALAPPDATA 'AbletonMcp\state'
$RemoteScripts = Join-Path ([Environment]::GetFolderPath('MyMusic')) 'Ableton\User Library\Remote Scripts'
New-Item -ItemType Directory -Force $InstallRoot,$RemoteScripts | Out-Null
npm install --prefix $InstallRoot --ignore-scripts --no-audit --no-fund $Artifact
$PackageRoot = Join-Path $InstallRoot 'node_modules\@ableton-mcp\mcp-server'
$Lifecycle = Join-Path $InstallRoot 'node_modules\.bin\ableton-mcp-lifecycle.cmd'
& $Lifecycle install --remote-scripts-dir $RemoteScripts --state-dir $State `
  --package-root $PackageRoot --artifact $Artifact --artifact-sha256 $ArtifactSha
& $Lifecycle install --remote-scripts-dir $RemoteScripts --state-dir $State `
  --package-root $PackageRoot --artifact $Artifact --artifact-sha256 $ArtifactSha `
  --apply --confirm-live-stopped
```

First omit `--apply` and inspect the JSON plan. Stop Live visibly in its UI and
confirm in Task Manager before the second command; do not automate process
termination. Restart Live, select `AbletonMcpBridge` under **Options →
Preferences → Link, Tempo & MIDI**, then run:

```powershell
& $Lifecycle activate --remote-scripts-dir $RemoteScripts --state-dir $State --package-root $PackageRoot
```

For upgrade, install the new tarball into a separate `$NewInstallRoot`, compute
its hash with `Get-FileHash`, stop Live, and use the same `upgrade` syntax shown
below with the new package/tarball paths. For uninstall, stop Live, run plan then
`uninstall --apply --confirm-live-stopped`; restart Live, update clients, retain
receipt/quarantine evidence, then remove the npm prefix. Never use an installer
or `Remove-Item -Recurse` against a path not proven by the receipt.

## Receipt-driven lifecycle CLI

All examples use the installed artifact's `ableton-mcp-lifecycle`. Always pass
the exact Live **Remote Scripts parent directory** for the selected Live
installation. Paths may contain spaces and Unicode. The tool never guesses an
application-bundle path, selects a Control Surface, kills Live, or follows a
symlink/junction ancestor.

Choose owner-controlled state and exact candidate values:

The remaining examples use POSIX shell variables from the macOS setup above.
On Windows use the corresponding PowerShell variables and invoke
`& $Lifecycle`; option names and safety gates are identical.

Every mutating command first supports a non-mutating plan (omit `--apply`).
Install, upgrade, rollback, and uninstall additionally require the operator to
stop Live and pass `--confirm-live-stopped`; the tool never treats process
absence as proof and never kills a process.

### Install

```sh
"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA"

"$LIFECYCLE" install --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --artifact "$ARTIFACT" --artifact-sha256 "$ARTIFACT_SHA" \
  --apply --confirm-live-stopped
```

Preflight hashes the exact local tarball bytes, binds the tarball's embedded
release manifest and complete strict inventory/payload hashes to the extracted
package root, verifies the release manifest, empty owned
destinations, ancestor/link safety, distinct loopback ports, and port
availability before creating state. Apply creates an owner-only secret and
config, atomically installs the Remote Script/registry/manifest/reference, then
writes an owner-only receipt and journal. Any injected or real failure after
secret, config, or bridge staging removes new authority and restores the prior
state. Success is `installed-restart-required`, not activation.

### Activation

1. Restart Live.
2. Select `AbletonMcpBridge` as a Control Surface in Live preferences.
3. Run:

```sh
"$LIFECYCLE" activate --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
```

Activation is read-only. It records `activated` only after authenticated status,
canonical registry identity, bounded discovery, and `real-live` provenance.
Fake, simulator, unavailable, stale, or wrong-registry responses remain
`activation-required` with restart/select remediation.

### Upgrade

Install the new tarball at a separate package path, stop Live, review the plan,
then apply:

```sh
"$LIFECYCLE" upgrade --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root '/absolute/new/package/root' \
  --artifact '/absolute/path/to/new-candidate.tgz' \
  --artifact-sha256 '<new-tarball-sha>'

"$LIFECYCLE" upgrade --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root '/absolute/new/package/root' \
  --artifact '/absolute/path/to/new-candidate.tgz' \
  --artifact-sha256 '<new-tarball-sha>' \
  --apply --confirm-live-stopped
```

Upgrade refuses drift and an identical candidate, preserves the owner secret,
stages the new config/bridge, retains the previous config and exact Remote
Script generation, verifies hashes, and records rollback identity. Failure
restores the prior bridge/config and leaves the owner receipt unchanged.
Restart and activate afterward.

### Repair

```sh
"$LIFECYCLE" repair --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
"$LIFECYCLE" repair --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" --apply
```

Repair compares receipt-owned hashes, unknown files, config digest, and secret
permissions. A clean repair is idempotent. Apply moves a drifted tree/config to
owner-only quarantine and restores only manifest-owned payload. A missing
secret is never regenerated silently because that would manufacture new bridge
authority. Restart and activate after changed repair.

### Rollback

```sh
"$LIFECYCLE" rollback --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --apply --confirm-live-stopped
```

Rollback requires a receipt-bound retained generation, verifies its files,
swaps bridge/config atomically, quarantines the failed generation for reverse
rollback, and records another restart/activation requirement. It refuses when
no exact previous generation exists.

### Uninstall

```sh
"$LIFECYCLE" uninstall --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT" \
  --apply --confirm-live-stopped
```

Exact receipt-owned bridge files and an unchanged managed config are removed.
Modified or unknown bridge content is moved to quarantine rather than deleted.
The secret is preserved by default; add `--purge-secret` only for a secret the
receipt proves this lifecycle created. Purge is ordinary unlink, not a forensic
secure-erasure claim. The final receipt records `uninstalled`; remove the npm
package separately only after client configs no longer point to it. Restart
Live to unload the Control Surface.

### Configuration migration

The migration CLI preserves legacy/v1 output by default. To produce an exact
version-2 bridge config, provide every authority-bearing bridge field and an
existing owner-only secret; the entrypoint must already be absolute:

```sh
ableton-mcp-migrate --input '/absolute/legacy-or-v1.json' \
  --output '/absolute/bridge-v2.json' \
  --bridge-host 127.0.0.1 --bridge-port 9765 \
  --realtime-port 9766 --secret-file '/absolute/bridge.secret'
```

It never creates a secret during migration, never accepts non-loopback hosts,
and refuses malformed ports, linked/unsafe secrets, and replacement unless
`--force` is explicit.

### Status, journal, and recovery

```sh
"$LIFECYCLE" status --remote-scripts-dir "$REMOTE_SCRIPTS" \
  --state-dir "$STATE" --package-root "$PACKAGE_ROOT"
```

Status is read-only and separates receipt state, package/config/Remote Script
integrity, file drift, permissions, rollback availability, retained cleanup or
preserved paths, and the historical activation receipt. Historical activation
is never current-connectivity evidence and is downgraded to an effective
restart-required status when installation integrity drifts. The installer owns
an empty regular file named `__pycache__` at Python's cache-directory path. That
receipt-bound blocker prevents Live from generating or loading unverified
bytecode while leaving the source modules readable. Replacing it with a
directory, cache payload, link, or any other entry is actionable drift. This
invariant is enforced even for legacy receipts that did not list the blocker;
status/activation fail closed and `repair --apply` migrates that generation.
`lifecycle-journal.json` records the last transaction result without secrets. On interruption, do not retry blindly:
inspect the receipt, journal, quarantine, Live process, and status; use repair
or rollback as indicated.

## Tested failure matrix

Unit and installed-tarball tests cover spaces/Unicode, non-mutating plans,
explicit stopped confirmation, occupied ports, owner permissions, leaf and
ancestor symlinks, install failures after each commit boundary, drift/unknown
files, receipt-bound Python bytecode-cache blocking, quarantine, idempotent repair, upgrade rollback, explicit rollback,
upgraded-generation retirement, retryable uninstall cleanup, uninstall
preserve/purge, malformed options, restart-required state, and
truthful unavailable activation. Hosted Windows runs add native DACL and
held-file/process behavior; macOS runs add POSIX modes/link behavior. A passing
lifecycle test is still not a loaded Windows Live Control Surface observation.

## Layered diagnostics

Diagnostics now reports five separate layers: package, configured bridge,
authenticated bridge, real-Live operational, and release-certified. The legacy
`ready` summary is true only for authenticated real-Live operation. Release
certification remains false until exact-candidate matrix and external gates are
complete. Probe failures return a bounded error code rather than becoming
positive evidence.
