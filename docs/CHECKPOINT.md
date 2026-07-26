# Deterministic checkpoint

This checkpoint validates repository-controlled behavior only. It is not a
release, signing, notarization, or Ableton Live certification procedure.

Run the following from the repository root:

```sh
cd apps/mcp-server
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm run compatibility
npm run package:verify
npm pack --dry-run
git diff --check
```

From the repository root, validate the independent Python boundary:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
```

A valid checkpoint requires every command to succeed and the diff to contain
only the intended documentation and implementation changes. Review `git
status --short` before any commit. Do not add local dependencies, generated
`dist/` output, credentials, device artifacts, or unavailable external test
evidence.

After the build, the executable smoke path is `node dist/src/cli.js`; verify
that stdout contains only JSON-RPC responses and that valid traffic produces
no stderr. `dist/src/index.js` is an import/export entrypoint, not the stdio
server. The package `npm start` script launches the stdio server through
`dist/src/cli.js`.

The checkpoint proves local compilation and automated behavior only. It does
not prove Ableton Live connectivity, Windows/macOS integration, signing,
notarization, release readiness, performance at production scale, or any
unimplemented capability. The benchmark proves only its fixed in-process
budgets and NDJSON fixtures; it is not realtime or device performance
evidence. A deterministic checkpoint may commit and push only validated
changes on the existing feature branch when explicitly permitted. Never
include `extensions-sdk-1.0.0-beta.0`, generated `dist/`, credentials, or
external-runtime claims.

Before recording completion, confirm that the working tree contains no changes
to `extensions-sdk-1.0.0-beta.0` and that no generated `dist/`, tarball,
credential, device, or platform artifact is staged. Preserve unrelated user
changes when reviewing or committing the checkpoint.

The package verifier installs the actual tarball and exercises the handshake,
setup, migration, and diagnostics helpers. It also requires diagnostics to
report external Ableton Live as `unavailable`. From the repository root, run
`python3 -m unittest discover -s remote-script -p 'test_*.py'` for the
independent transport shim tests.

The connected-adapter tempo workflow is tested only with the deterministic
in-memory simulator. That evidence covers explicit confirmation, idempotency,
epoch conflict checks, postcondition verification, and guarded undo; it is not
Ableton Live evidence.
