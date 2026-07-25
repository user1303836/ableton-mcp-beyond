# Delivery

The supported artifact is the npm package produced from `apps/mcp-server` with
`npm pack`. It contains compiled TypeScript and runs through Node.js on
Windows and macOS without native extensions. CI validates the package build on
Linux, macOS, and Windows for Node.js 20 and 22.

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

`npm pack --dry-run` audits package contents without publishing. CI does not
sign or notarize artifacts. Those actions require a separately approved
release process with real identities and platform evidence.
