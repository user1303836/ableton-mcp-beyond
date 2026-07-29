# Development Notes

The repository ships a TypeScript MCP host, deterministic local PCM analysis,
an authenticated loopback Remote Script adapter, a canonical operation
registry, and dependency-free fake-Live contracts. The default remains
`UnavailableLiveAdapter`; a configured bridge is not evidence of a real Live
runtime. Keep implementation claims aligned with exported code and tests; the
project reference document is context, not an API specification.

## Local development

Use Node.js 22, 24, or 25. Node 23 and unlisted/future majors are unsupported until they pass the complete exact-candidate matrix:

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
dependencies. The host and setup binaries reject unsupported Node majors early;
recovery-oriented migration/lifecycle binaries remain callable so an operator
can inspect or remove a prior receipt, which is not a broader runtime-support
claim. The legacy `--allow-dirty-private-build` spelling is retained only for
CLI compatibility and means an explicit dirty local-development override.

`apps/mcp-server/src/registry.ts` loads and validates the canonical operation
registry and derives its operation identifiers and canonical hash. Do not copy
registry identifiers or hashes into another source file.

## Extension boundary

Do not make tests depend on an installed Ableton Live process, a device, a
platform-specific runner, or local-only reference material. The default
`UnavailableLiveAdapter` is the supported behavior when no explicit
configuration is supplied. Any adapter must preserve the registry, protocol,
epoch, validation, and safety contracts documented in
[`docs/LIVE_SAFETY.md`](docs/LIVE_SAFETY.md).

## Change discipline

Keep stdout protocol-only. Send diagnostics to stderr and redact request data
from diagnostics. Add tests for every new protocol method or Live side effect,
including malformed input and recovery behavior. Do not claim integration or
end-to-end support when the required external runtime is unavailable.

The Promise-based adapter methods are the process-backed boundary, but the
shared TypeScript interface and simulator still retain synchronous compatibility
methods. This is a current limitation, not the final single asynchronous
adapter design. The host's asynchronous request path is required for scene
audition and other process-backed tools.
