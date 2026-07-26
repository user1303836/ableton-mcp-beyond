# Deterministic checkpoint

This is a repository-contract checkpoint, not Live certification or release
approval.

From `apps/mcp-server`, run serially:

```sh
npm ci
npm run typecheck
npm test
npm run property-test
npm run benchmark
npm run compatibility
npm run package:verify
npm pack --dry-run --json
```

From the repository root, run:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
git diff --check
git diff --cached --check
```

Before staging, verify the intended branch, an empty index, and an allowlisted
diff. Exclude `dist/`, tarballs, credentials, device/platform artifacts,
Smithers state, workflow files, and `extensions-sdk-1.0.0-beta.0`. Preserve
unrelated changes.

The checks cover TypeScript, protocol framing, async adapter behavior,
transactions, fake-Live mapping, analysis, packaging, configuration, and
installer contracts. They do not prove real Live connectivity, a supported
Live version, realtime performance, hardware, accessibility, signing,
notarization, or installer runtime on every platform.
