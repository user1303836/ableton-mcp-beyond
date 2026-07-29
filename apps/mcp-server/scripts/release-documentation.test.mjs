import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { documentTargets, releaseDocumentation, stageReleaseDocumentation, transformReleaseDocument, validatePackagedDocumentation } from "./release-documentation.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const revision = "a".repeat(40);

test("mapping-based transform handles packaged, root, repository-only, HTML, reference, fragment, and external targets", () => {
  const markdown = [
    "[guide](docs/USER_GUIDE.md#install)",
    "[evidence](docs/evidence/)",
    "![logo](docs/assets/logo.svg)",
    '<a href="README.ja.md">日本語</a>',
    '<a href="LICENSE.md">license</a>',
    '<a href="apps/mcp-server/package.json">package</a>',
    "[registry](protocol/ableton-live-v1.operations.json)",
    "[external](https://example.com/path)",
    "[fragment](#local)",
    "[reference]: docs/SUPPORT_MATRIX.md#runtime",
  ].join("\n");
  const transformed = transformReleaseDocument(markdown, { repositoryRoot, sourceRelative: "README.md", revision });
  assert.match(transformed, /\(USER_GUIDE\.md#install\)/);
  assert.match(transformed, new RegExp(`github\\.com/user1303836/ableton-mcp-beyond/tree/${revision}/docs/evidence/`));
  assert.match(transformed, new RegExp(`raw\\.githubusercontent\\.com/user1303836/ableton-mcp-beyond/${revision}/docs/assets/logo\\.svg`));
  assert.match(transformed, new RegExp(`github\\.com/user1303836/ableton-mcp-beyond/blob/${revision}/README\\.ja\\.md`));
  assert.match(transformed, /href="\.\.\/LICENSE\.md"/);
  assert.match(transformed, /href="\.\.\/package\.json"/);
  assert.match(transformed, /\.\.\/remote-script\/AbletonMcpBridge\/ableton-live-v1\.operations\.json/);
  assert.match(transformed, /https:\/\/example\.com\/path/);
  assert.match(transformed, /\(#local\)/);
  assert.match(transformed, /\[reference\]: SUPPORT_MATRIX\.md#runtime/);
  for (const unsafe of ["[drive](C:/Users/example/file.md)", '<a href="C:\\\\Users\\\\example\\\\file.md">drive</a>', "[drive]: C:/Users/example/file.md"]) {
    assert.throws(() => transformReleaseDocument(unsafe, { repositoryRoot, sourceRelative: "README.md", revision }), /unsafe target/);
  }
});

test("docs-relative evidence and mapped sibling links are transformed structurally", () => {
  const transformed = transformReleaseDocument("[oracle](evidence/phase-8-audio-oracle.json) [delivery](DELIVERY.md)", { repositoryRoot, sourceRelative: "docs/AUDIO_INTELLIGENCE.md", revision });
  assert.match(transformed, new RegExp(`github\\.com/user1303836/ableton-mcp-beyond/blob/${revision}/docs/evidence/phase-8-audio-oracle\\.json`));
  assert.match(transformed, /\(DELIVERY\.md\)/);
});

test("all real release documents stage with no broken packaged relative targets", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "ableton-release-docs-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const docsRoot = resolve(root, "release-docs");
  stageReleaseDocumentation({ repositoryRoot, docsRoot, revision });
  cpSync(resolve(repositoryRoot, "LICENSE.md"), resolve(root, "LICENSE.md"));
  cpSync(resolve(packageRoot, "package.json"), resolve(root, "package.json"));
  const registry = resolve(root, "remote-script/AbletonMcpBridge/ableton-live-v1.operations.json");
  mkdirSync(dirname(registry), { recursive: true });
  cpSync(resolve(repositoryRoot, "protocol/ableton-live-v1.operations.json"), registry);
  const names = releaseDocumentation.map(([, destination]) => `release-docs/${destination}`);
  validatePackagedDocumentation(root, names);
  assert.equal(names.length, 15);
  for (const name of names) {
    const targets = documentTargets(readFileSync(resolve(root, name), "utf8"));
    assert.equal(targets.some((target) => /^(?:\.\.\/)?evidence\//.test(target)), false, `${name} retained a local evidence target`);
  }
});

test("validation rejects missing and escaping Markdown, HTML, and reference targets", (context) => {
  const root = mkdtempSync(resolve(tmpdir(), "ableton-release-docs-invalid-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "release-docs"));
  for (const [name, body] of [
    ["markdown.md", "[missing](missing/)"],
    ["html.md", '<img src="missing.svg">'],
    ["reference.md", "[missing]: ../../outside.md"],
    ["windows.md", "[drive](C:/Users/example/file.md)"],
  ]) {
    const path = resolve(root, "release-docs", name);
    writeFileSync(path, body);
    assert.throws(() => validatePackagedDocumentation(root, [`release-docs/${name}`]), /broken internal link|unsafe absolute target/);
  }
});
