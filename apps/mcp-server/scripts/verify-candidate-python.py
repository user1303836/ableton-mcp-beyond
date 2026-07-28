#!/usr/bin/env python3
"""Bind Python contract tests to the exact shared private npm candidate."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile

if len(sys.argv) != 3:
    raise SystemExit("usage: verify-candidate-python.py ARTIFACT METADATA")
artifact = Path(sys.argv[1]).resolve()
metadata = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
actual_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
expected_git = os.environ.get("GITHUB_SHA")
if metadata.get("schema") != "ableton-mcp-candidate/v1" or metadata.get("sha256") != actual_sha:
    raise SystemExit("candidate metadata or SHA-256 mismatch")
if expected_git and metadata.get("gitSha") != expected_git:
    raise SystemExit("candidate Git SHA does not match checkout")
repository = Path(__file__).resolve().parents[3]
expected = {
    "package/remote-script/AbletonMcpBridge/__init__.py": "remote-script/AbletonMcpBridge/__init__.py",
    "package/remote-script/AbletonMcpBridge/ableton_mcp_remote_script.py": "remote-script/ableton_mcp_remote_script.py",
    "package/remote-script/AbletonMcpBridge/ableton-live-v1.operations.json": "protocol/ableton-live-v1.operations.json",
}
with tarfile.open(artifact, "r:gz") as archive:
    members = {member.name: member for member in archive.getmembers()}
    if any(member.issym() or member.islnk() or member.isdev() for member in members.values()):
        raise SystemExit("candidate tarball contains a link or special entry")
    for name, source in expected.items():
        member = members.get(name)
        if member is None or not member.isfile():
            raise SystemExit(f"candidate is missing regular Python contract asset: {name}")
        stream = archive.extractfile(member)
        candidate = stream.read() if stream else b""
        try:
            checkout = subprocess.run(
                ["git", "cat-file", "blob", f"{metadata['gitSha']}:{source}"],
                cwd=repository,
                check=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            ).stdout
        except subprocess.CalledProcessError as error:
            raise SystemExit(f"cannot read exact Git blob for {source}: {error.stderr.decode('utf-8', 'replace')[-512:]}") from error
        if candidate != checkout:
            raise SystemExit(f"candidate Python contract differs from exact Git blob: {name}")
        if name.endswith(".py"):
            compile(candidate, name, "exec")
print(json.dumps({"schema": "ableton-mcp-candidate-python/v1", "gitSha": metadata["gitSha"], "artifactSha256": actual_sha, "assets": len(expected), "exactCheckout": True}))
