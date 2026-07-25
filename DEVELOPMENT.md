# Development Notes

The repository currently ships a TypeScript MCP host and deterministic local
PCM analysis. It does not ship a Live adapter. Keep implementation claims
aligned with the exported code and tests; the project reference document is
context, not an API specification.

## Local development

Use Node.js 20 or newer:

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
```

`npm test` builds TypeScript into `dist/` and runs the compiled Node test files.
The package is ESM, exports `dist/src/index.js`, and exposes the
`ableton-mcp-server`, `ableton-mcp-setup`, `ableton-mcp-migrate`, and
`ableton-mcp-diagnostics` binaries after a build. CI exercises the portable
Node distribution on Linux, macOS, and Windows; native Live, installer,
signing, and notarization evidence remains unavailable without those external
dependencies.

## Extension boundary

Do not make tests depend on an installed Ableton Live process, a device, a
platform-specific runner, or local-only reference material. The default
`UnavailableLiveAdapter` is the supported behavior until a real adapter is
implemented and tested. Any future adapter must preserve the protocol and
safety contracts documented in [`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md).

## Change discipline

Keep stdout protocol-only. Send diagnostics to stderr and redact request data
from diagnostics. Add tests for every new protocol method or Live side effect,
including malformed input and recovery behavior. Do not claim integration or
end-to-end support when the required external runtime is unavailable.
