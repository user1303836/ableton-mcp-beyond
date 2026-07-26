# Delivery and platform evidence

The npm artifact allowlists compiled host files, the `AbletonMcpBridge`
package, its bridge module, README, and packaging scripts. The verifier checks
the real tarball in a disposable directory and rejects tests, caches, local
configuration, secrets, temporary output, and protected evidence.

Installation requires an explicit absolute destination. It refuses symlink
trees and overwrite by default; forced replacement moves an existing target to
a timestamped recoverable backup. It installs a manifest containing SHA-256
hashes and never embeds the bridge secret. Supplying `--config` also installs
`AbletonMcpBridge/bridge-reference.json`; that file contains only the absolute
path to the separately protected bridge configuration.

Version 2 configuration references a separate secret file and accepts only a
loopback host, valid port, safe path, and bounded timeout. Diagnostics report
host/package/configuration readiness separately from authenticated reachability
and `liveConnected`. Only the optional authenticated status handshake can set
those active bridge fields; files, ports, processes, or simulators cannot.

Node platform support is reported for Darwin, Linux, and Windows. Windows ACL
permission verification is reported unavailable rather than passed. Signing,
notarization, real Live runtime, accessibility, hardware, and installer-runtime
evidence remain unavailable without dedicated observed runners and identities.

The shipped wrappers reject unknown or repeated options. Version 1 migration
accepts only the legacy command/args shape and produces a versioned host-only
configuration; version 2 additionally validates loopback, bounded ports and
timeouts, absolute non-symlink paths, and the separate secret file.
