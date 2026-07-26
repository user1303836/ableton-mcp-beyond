# Deterministic checkpoint

This is a repository-contract checkpoint, not Live certification, release approval, signing, or notarization. It describes only the exact tested checkout; historical CI evidence does not validate later working-tree changes. Documentation must report the working tree and exact evidence actually inspected.

## Required serial commands

From `apps/mcp-server`:

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

From the repository root:

```sh
python3 -m unittest discover -s remote-script -p 'test_*.py'
git diff --check
git diff --cached --check
```

Before any checkpoint commit, verify the intended feature branch, an empty index before staging, and an allowlisted diff. Audit staged paths and packed contents. Exclude generated `dist/`, archives, credentials, device/platform artifacts, Smithers state, workflow/UI/prompt/agent/runtime files, unrelated changes, and the protected local SDK evidence.

## Evidence interpretation

The gates cover TypeScript, registry constants and hash negotiation, protocol framing, async remote-adapter behavior, bounded stdio, transactions, fake-Live mapping, hierarchical mapper discovery, shape-dependent operation advertisement, device-parameter validation, analysis, configuration, packaging, and installer contracts. The authenticated package smoke observes an installed production Python mapper and fake scene discovery. A missing, skipped, cancelled, stale-SHA, failed, or unavailable external job is not passing evidence. The gates do not prove a real Live runtime, supported Live version, disposable Set, visible or audible state, realtime performance, hardware, accessibility, installer runtime on every platform, signing, notarization, or publication.
