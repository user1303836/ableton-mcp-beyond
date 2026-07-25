# Deterministic checkpoint

Run the following from the repository root:

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm pack --dry-run
git diff --check
```

A valid checkpoint requires every command to succeed and the diff to contain
only the intended documentation and implementation changes. Review `git
status --short` before any commit. Do not add local dependencies, generated
`dist/` output, credentials, device artifacts, or unavailable external test
evidence.

The checkpoint proves local compilation and automated behavior only. It does
not prove Ableton Live connectivity, Windows/macOS integration, signing,
notarization, release readiness, performance at production scale, or any
unimplemented capability. The benchmark proves only its fixed in-process
budgets and NDJSON fixtures; it is not realtime or device performance
evidence. A deterministic checkpoint may commit and push only validated
changes on the existing feature branch when explicitly permitted. Never
include `extensions-sdk-1.0.0-beta.0`, generated `dist/`, credentials, or
external-runtime claims.
