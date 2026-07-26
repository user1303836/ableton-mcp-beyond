# Delivery and platform evidence

The npm artifact contains the compiled MCP host, the allowlisted production
Remote Script module, and the explicit-target installer. It does not select a
Live destination automatically and refuses symbolic links, ambiguous paths,
and overwrite without `--force`. Replacement first moves the existing target
to a timestamped backup; a failed rename restores it.

Host-only configuration remains version 1 for compatibility. Version 2 adds an
explicit loopback bridge endpoint and secret-file reference. Configuration
validation rejects non-loopback hosts, invalid ports, unsafe or symbolic-link
secret files, unknown versions, and missing secrets. Secret contents are never
included in diagnostics or command output.

Diagnostics report host readiness, installed Remote Script assets, bridge
configuration, authenticated reachability, negotiated protocol/epoch/capability
state, and observed Live connectivity independently. File presence and a
running Live process cannot establish authenticated reachability or Live
connectivity. Signing, notarization, and real Live runtime evidence remain
unavailable until the corresponding identity, runner, and disposable Set are
observed.

CI runs Node 20 and 22 checks on Ubuntu, macOS, and Windows plus Python Remote
Script contract tests. These are deterministic repository and packaging checks;
they are not evidence of a connected Ableton Live instance.
