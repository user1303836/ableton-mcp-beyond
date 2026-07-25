# Delivery

The supported artifact is the npm package produced from `apps/mcp-server` with
`npm pack`. It contains compiled TypeScript and uses no native extensions. The
repository provides local Node.js validation; no platform runner or CI result
is evidence in this checkout, so Windows/macOS compatibility remains an
unverified limitation until those environments are exercised.

After `npm run build`, setup writes a versioned MCP client configuration:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

The output path is explicit and existing files are protected unless `--force`
is supplied. Migration accepts the legacy `{ "command": "...", "args": [] }`
shape and emits version 1:

```sh
npm run migrate -- --input /absolute/path/old.json --output /absolute/path/new.json
```

`npm run diagnostics` emits JSON for Node version, architecture, compiled
entrypoint presence, and optional config validity. `ready` means only that the
local host can be launched. Ableton Live, native devices, signing, and
notarization are reported as `unavailable`; they are never inferred from the
host operating system.

Diagnostics do not start Live or validate a client connection. Setup and
migration only write configuration; they do not install, launch, sign, or
publish an artifact. `--force` is an explicit overwrite operation.

`npm pack --dry-run` audits package contents without publishing. CI does not
sign or notarize artifacts. Those actions require a separately approved
release process with real identities and platform evidence.
