# Distribution, signing, and publication policy

## Chosen channel

The only release channel for this branch is a **private, local npm tarball**
created with `npm pack`. The package is marked `private` and `UNLICENSED`; it is
not published to npm or another registry. Installation is by exact local path
and SHA-256. The SHA proves byte integrity, not publisher identity.

The private artifact is unsigned and is not Apple-notarized. Native macOS or
Windows installers are not shipped. Public publication, code signing,
notarization, trademark review, and a redistribution license require a
separate owner decision, authorized identities, and dedicated release gates.
No current test or hash is represented as signing or notarization.

## Artifact allowlist

The tarball may contain only:

- compiled runtime JavaScript and declarations (no source maps or tests);
- the Remote Script, canonical operation registry, and their manifest;
- the release manifest/provenance record and package metadata;
- the private license notice; and
- the allowlisted user, safety, operations, recovery, testing, support,
  distribution, and implementation-status documents.

It must not contain verification/test runners, test fixtures, dependencies,
credentials, configuration, local state, logs, backups, captured media,
generated evidence, or any protected local SDK material. `package:verify`
rejects every path outside the independently enumerated allowlist and verifies
all manifest hashes. Release provenance records the exact Node, npm, and
TypeScript versions, platform/architecture and hosted image identifiers,
package-lock/workflow SHA-256 values, source commit/dirty state, and runnable
recipe. CI is configured to repeat packing from a fresh detached local clone and fresh
`npm ci` before comparing bytes; only an executed exact-SHA job proves it.

## Evidence boundaries

Linux is a host/package-contract platform only; Ableton Live is not certified
there. macOS real-Live evidence currently covers the explicitly recorded Live
12.4.5b8 beta environment. Windows CI can prove host, ACL, lifecycle, and
package contracts but is not Windows Live evidence. An exact supported matrix
and its unavailable cells are in `SUPPORT_MATRIX.md`.

A release candidate is eligible for private use only when the same tarball is
reproducible, its manifest identifies the exact clean Git commit, all local and
hosted gates for that SHA pass, and the applicable real-Live evidence names the
same artifact digest. Historical, simulator, fake-Live, or stale evidence never
fills a missing candidate cell.
