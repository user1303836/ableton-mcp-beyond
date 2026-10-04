// Run from the workspace root after building the TypeScript reference.
import fs from "node:fs";
import { validateSemanticProjectArtifact } from "../../../../apps/mcp-server/dist/src/project-semantic.js";
const base = JSON.parse(fs.readFileSync(new URL("project_semantic_oracle.json", import.meta.url), "utf8")).cases[0].result.ok;
const rows = [];
for (const [kind, counts] of Object.entries({ ascii: [4096, 4097], astral: [2048, 2049], key: [128, 129], object: [64, 65], depth: [20, 21] })) {
  for (const count of counts) {
    const artifact = structuredClone(base);
    let value;
    if (kind === "ascii") value = "x".repeat(count);
    if (kind === "astral") value = "🎹".repeat(count);
    if (kind === "key") value = { ["x".repeat(count)]: true };
    if (kind === "object") value = Object.fromEntries(Array.from({ length: count }, (_, i) => [`field${i}`, true]));
    if (kind === "depth") { value = null; for (let i = 0; i < count; i++) value = [value]; }
    artifact.records[0].data.extra = value;
    try { validateSemanticProjectArtifact(artifact); rows.push({ kind, count, error: null }); }
    catch (error) { rows.push({ kind, count, error: error.message }); }
  }
}
fs.writeFileSync(new URL("project_semantic_bounds_oracle.json", import.meta.url), `${JSON.stringify(rows, null, 2)}\n`);
