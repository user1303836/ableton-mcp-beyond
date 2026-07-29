# Distribution, signing, and publication policy

## Chosen channel

The only release channel configured in this repository is an **exact local npm
tarball** created with `npm pack`. The software and tarball are licensed under
the [MIT License](../LICENSE.md). Package metadata remains `private: true` to
prevent accidental `npm publish`; candidates are not published to npm, GitHub
Releases, or another registry. Installation is by exact local path and SHA-256.
The SHA proves byte integrity, not publisher identity.

The local artifact is unsigned and is not Apple-notarized. Native macOS or
Windows installers are not shipped. Public publication, code signing,
notarization, and trademark review require a separate owner decision,
authorized identities, and dedicated release gates. MIT grants software reuse
and redistribution rights; it does not grant Ableton trademark rights, imply
Ableton endorsement, establish publisher identity, or certify a platform.

## Artifact allowlist

The tarball may contain only:

- compiled runtime JavaScript and declarations (no source maps or tests);
- the Remote Script, canonical operation registry, and their manifest;
- the release manifest/provenance record and package metadata;
- the MIT license notice; and
- the allowlisted user, safety, operations, recovery, testing, support,
  distribution, and implementation-status documents.

It must not contain verification/test runners, test fixtures, dependencies,
credentials, configuration, local state, logs, backups, captured media,
generated evidence, or any protected local SDK material. `package:verify`
rejects every path outside the independently enumerated allowlist and verifies
all manifest hashes. Release provenance records the exact Node, npm, and
TypeScript versions, platform/architecture and hosted image identifiers,
package-lock/workflow SHA-256 values, source commit/dirty state, and runnable
recipe. CI repeats packing from a fresh detached local clone and fresh `npm ci`
before comparing bytes; only an executed exact-SHA job proves it.

## Required checks and emergency procedure

`Required CI` is the stable merge-gate context. It succeeds only when the exact
candidate build, complete Node/OS installed-candidate matrix, and complete
Python Remote Script matrix all succeed. The repository should have no standing
ruleset bypass actor.

An emergency settings change is reserved to the repository owner only. Before
changing the rule, the owner must open an incident issue recording the reason,
exact commit SHA, failed/unavailable check, risk, and recovery plan. The owner
may then temporarily change only the blocking setting, merge the recorded SHA,
immediately restore the rule, run the full exact-candidate matrix, and record a
post-bypass review and result in the incident. A bypass never converts missing
or failed evidence into a passing claim.

## Evidence boundaries

Linux is a host/package-contract platform only; Ableton Live is not certified
there. macOS real-Live evidence currently covers the explicitly recorded Live
12.4.5b8 beta environment. Windows CI can prove host, ACL, lifecycle, and
package contracts but is not Windows Live evidence. An exact supported matrix
and its unavailable cells are in `SUPPORT_MATRIX.md`.

A release candidate is eligible for the configured local channel only when the
same tarball is reproducible, its manifest identifies the exact clean Git
commit, all local and hosted gates for that SHA pass, and applicable real-Live
evidence names the same artifact digest. Historical, simulator, fake-Live, or
stale evidence never fills a missing candidate cell.
