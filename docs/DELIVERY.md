# Delivery and platform evidence

The npm artifact allowlists compiled host files, the `AbletonMcpBridge`
package, its bridge module, the versioned operation registry, README, and packaging scripts. The verifier checks the real tarball in a disposable directory and rejects tests, caches, local configuration, secrets, temporary output, and protected evidence. It also installs the tarball, starts the packaged Python bridge with a dependency-free fake Song, authenticates the packaged CLI, and verifies status plus scene discovery. This is production-package/fake-Live evidence, not real Live evidence.

Installation requires an explicit absolute destination. It refuses symlink
trees and overwrite by default; forced replacement moves an existing target to
a timestamped recoverable backup. It installs a manifest containing SHA-256
hashes for every bridge asset, including the registry, and never embeds the
bridge secret. Supplying `--config` also installs
`AbletonMcpBridge/bridge-reference.json`; that file contains only the absolute
path to the separately protected bridge configuration.

Version 2 configuration references a separate secret file, emits the explicit
`--config PATH` server argument, and accepts only a loopback host, valid port,
safe path, and bounded timeout. Diagnostics report
host/package/configuration readiness separately from authenticated reachability
and `liveConnected`. Only the optional authenticated status handshake followed
by bounded read-only discovery can set those active bridge fields; files, ports,
processes, or simulators cannot.

Node platform support is reported for Darwin, Linux, and Windows, with Node 22
as the minimum maintained runtime and Node 22/24 in CI. Windows ACL
permission verification is reported unavailable rather than passed when the
native security descriptor cannot be observed; creation applies and verifies
an owner-only DACL through `icacls.exe` when available. Signing,
notarization, real Live runtime, accessibility, hardware, and installer-runtime
evidence remain unavailable without dedicated observed runners and identities.

The shipped wrappers reject unknown or repeated options. Setup, migration, and
diagnostics are exercised in the Node 22/24 Linux, macOS, and Windows CI
matrix, with Python provisioned for the authenticated package smoke. Version 1 migration
accepts only the legacy command/args shape and produces a versioned host-only
configuration; version 2 additionally validates loopback, bounded ports and
timeouts, absolute non-symlink paths, and the separate secret file. The
generated client arguments contain exactly `--config PATH` for version 2. The current package smoke does not certify an Ableton Live installation, loaded Control Surface, audio output, or scene audition.
