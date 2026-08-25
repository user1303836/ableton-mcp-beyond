import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");

const verifyPackageSource = readFileSync(resolve(packageRoot, "scripts/verify-package.mjs"), "utf8");
const stageReleaseSource = readFileSync(resolve(packageRoot, "scripts/stage-release-artifact.mjs"), "utf8");

function extractRuntimeModules(source, file) {
  const match = source.match(/const runtimeModules = (\[[^\]]*\])/);
  assert.ok(match, `${file}: could not locate the runtimeModules literal; update this drift test to match the new source shape`);
  return JSON.parse(match[1]);
}

test("verify-package and stage-release-artifact agree on the runtime module allowlist", () => {
  assert.deepEqual(
    extractRuntimeModules(verifyPackageSource, "verify-package.mjs"),
    extractRuntimeModules(stageReleaseSource, "stage-release-artifact.mjs"),
  );
});

// The packaged-path inventory is built in verify-package.mjs as: the plain
// string literals of expectedNames (package.json, LICENSE.md, release-manifest.json,
// the release-docs names, the remote-script names) plus two dist entries per
// runtime module (template literals, excluded before counting literals).
function expectedPackagedCounts() {
  const runtimeModules = extractRuntimeModules(verifyPackageSource, "verify-package.mjs");
  const line = verifyPackageSource.split("\n").find((entry) => entry.includes("const expectedNames = "));
  assert.ok(line, "verify-package.mjs: could not locate the expectedNames allowlist; update this drift test to match the new source shape");
  const withoutTemplates = line.replace(/`[^`]*`/g, "");
  const literals = withoutTemplates.match(/"[^"]*"/g)?.length ?? 0;
  assert.ok(literals > 0, "verify-package.mjs: expectedNames contains no plain literals; update this drift test to match the new source shape");
  const packaged = literals + runtimeModules.length * 2;
  return { packaged, payload: packaged - 1 };
}

// Tool names are locale-invariant: every user guide names tools in backticks,
// either exactly (`live_undo`) or as combined pairs (`live_tempo_preview/apply`
// expands to `live_tempo_preview` + `live_tempo_apply`). Anchoring to the
// catalog keeps prose snake_case words out of the comparison. The guides
// summarize many tools without naming them; this check enforces cross-locale
// parity of the named inventory so a tool addition cannot silently skip one
// locale (the zh-CN guide missed five entries plus the policy section once).
const catalogSource = readFileSync(resolve(packageRoot, "src/tool-catalog.ts"), "utf8");
const catalogNames = new Set();
for (const match of catalogSource.matchAll(/(?:name|prefix): "([a-z][a-z0-9_]*(?:_\*)?)"/g)) {
  catalogNames.add(match[1].endsWith("_*") ? match[1].slice(0, -2) : match[1]);
}

function documentedTools(path) {
  const found = new Set();
  for (const match of readFileSync(path, "utf8").matchAll(/`([^`\s]+)`/g)) {
    const token = match[1];
    if (/^[a-z][a-z0-9_]*$/.test(token)) {
      if (catalogNames.has(token)) found.add(token);
      continue;
    }
    const pair = token.match(/^([a-z][a-z0-9_]*?)_([a-z]+(?:\/[a-z]+)+)$/);
    if (pair) {
      for (const suffix of pair[2].split("/")) {
        const candidate = `${pair[1]}_${suffix}`;
        if (catalogNames.has(candidate)) found.add(candidate);
      }
    }
  }
  return found;
}

test("en, zh-CN, and ja user guides document the same tool-name inventory", () => {
  const inventories = ["en", "zh-CN", "ja"].map((locale) => [locale, documentedTools(resolve(repositoryRoot, "docs", locale, "USER_GUIDE.md"))]);
  const [[baselineLocale, baseline], ...rest] = inventories;
  assert.ok(baseline.size > 0, "en USER_GUIDE.md names no catalog tools; update this drift test to match the new doc shape");
  for (const [locale, tools] of rest) {
    assert.deepEqual([...tools].sort(), [...baseline].sort(), `${locale} USER_GUIDE.md tool inventory differs from ${baselineLocale}`);
  }
});

// Numeric payload/path-count claims next to allowlist/manifest/tarball wording
// are exactly the claims that went stale before (the "77-file allowlist").
// Documentation should name release-manifest.json as the source of truth; any
// numeral a doc does state must equal the count the verifier independently
// computes. Both phrasings are accepted: payload files (manifest entries) and
// packaged paths (payload plus the manifest itself).
const contextPattern = /allowlist|allow-list|manifest|tarball|payload|允许列表|清单|载荷|负载|許可リスト|マニフェスト|ペイロード/i;
const claimPatterns = [
  /(\d+)\s*[-–]\s*(?:file|path)s?\b/gi,
  /(\d+)\s*ファイル/g,
  /(\d+)\s*パス/g,
  /(\d+)\s*(?:个\s*)?文件/g,
  /(\d+)\s*路径/g,
];

test("no documentation states a payload file count that disagrees with the release manifest", () => {
  const { packaged, payload } = expectedPackagedCounts();
  const docs = execFileSync("git", ["ls-files", "*.md"], { cwd: repositoryRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const stale = [];
  for (const doc of docs) {
    const lines = readFileSync(resolve(repositoryRoot, doc), "utf8").split("\n");
    lines.forEach((text, index) => {
      if (!contextPattern.test(text)) return;
      for (const pattern of claimPatterns) {
        for (const match of text.matchAll(pattern)) {
          const claim = Number(match[1]);
          if (claim !== payload && claim !== packaged) {
            stale.push(`${doc}:${index + 1} claims ${claim}, but the verified allowlist is ${payload} payload files (${packaged} packaged paths)`);
          }
        }
      }
    });
  }
  assert.deepEqual(stale, [], "stale file-count claims found; drop the numeral and name release-manifest.json as the source of truth, or correct the count");
});
