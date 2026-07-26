# Delivery

The supported artifact is the npm package produced from `apps/mcp-server` with
`npm pack`. It contains compiled TypeScript and uses no native extensions, so
the same host artifact targets Node.js on macOS (`darwin`), Windows (`win32`),
and Linux (`linux`). It does not currently package or install the Python Remote
Script. Local compatibility and package smoke checks do not substitute for an
unavailable platform runner or Live runtime.

`npm run compatibility` fails unless the current runner uses Node 20 or newer
and is macOS, Windows, or Linux. This is a portable Node package, so no
platform-specific installer or native extension is claimed. The real tarball
is installed and exercised by `npm run package:verify` on the current runner.

Run the local artifact check with:

```sh
npm run package:verify
```

This creates the tarball and installs it under a disposable temporary
directory. It verifies the executable and delivery helpers are present and
that the artifact contains neither dependencies nor the protected SDK. The
installed artifact is tested through the protocol handshake, setup, legacy
migration, and diagnostics commands; diagnostics must report Live as
`unavailable`.

After `npm run build`, setup writes a versioned MCP client configuration whose
server command targets the packaged `cli.js` executable:

```sh
npm run setup -- --output /absolute/path/client-config.json
```

The output path is explicit and existing files are protected unless `--force`
is supplied. Migration accepts the legacy `{ "command": "...", "args": [] }`
shape and emits version 1:

```sh
npm run migrate -- --input /absolute/path/old.json --output /absolute/path/new.json
```

`npm run diagnostics` emits JSON for Node version, architecture, supported
platform, compiled executable presence, and optional config validity. `ready`
means only that the local host can be launched on a supported Node platform.
Ableton Live, native devices, signing, and notarization are reported as
`unavailable`; they are never inferred from the host operating system.

Diagnostics do not start Live or validate a client connection. Setup and
migration only write configuration; they do not install a Remote Script,
launch Live, sign, or publish an artifact. `--force` is an explicit overwrite
operation. Configuration writes refuse directories and symbolic links and use
atomic staging with recovery on supported filesystems.

`npm pack --dry-run` audits package contents without publishing. CI does not
sign or notarize artifacts. Those actions require a separately approved
release process with real identities and platform evidence.
