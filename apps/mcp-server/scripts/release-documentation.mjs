import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve } from "node:path";

export const releaseDocumentation = [
  ["README.md", "README.md"],
  ["docs/en/USER_GUIDE.md", "USER_GUIDE.md"],
  ["docs/en/USER_JOURNEYS.md", "USER_JOURNEYS.md"],
  ["docs/en/OPERATIONS.md", "OPERATIONS.md"],
  ["docs/en/RECOVERY.md", "RECOVERY.md"],
  ["docs/en/LIVE_SAFETY.md", "LIVE_SAFETY.md"],
  ["docs/en/AUDIO_INTELLIGENCE.md", "AUDIO_INTELLIGENCE.md"],
  ["docs/en/REALTIME_CONTROL.md", "REALTIME_CONTROL.md"],
  ["docs/en/DELIVERY.md", "DELIVERY.md"],
  ["docs/en/DEVELOPER_GUIDE.md", "DEVELOPER_GUIDE.md"],
  ["docs/en/TESTING.md", "TESTING.md"],
  ["docs/en/IMPLEMENTATION_STATUS.md", "IMPLEMENTATION_STATUS.md"],
  ["docs/en/DISTRIBUTION_POLICY.md", "DISTRIBUTION_POLICY.md"],
  ["docs/en/SUPPORT_MATRIX.md", "SUPPORT_MATRIX.md"],
  ["docs/en/CAPABILITY_MATRIX.md", "CAPABILITY_MATRIX.md"],
];

const REPOSITORY_WEB = "https://github.com/user1303836/ableton-mcp-beyond";
const REPOSITORY_RAW = "https://raw.githubusercontent.com/user1303836/ableton-mcp-beyond";
const mappedDocuments = new Map(releaseDocumentation);

function splitTarget(target) {
  const marker = target.search(/[?#]/);
  return marker === -1 ? [target, ""] : [target.slice(0, marker), target.slice(marker)];
}

export function isExternalDocumentTarget(target) {
  if (/^[a-z]:[\\/]/i.test(target)) return false;
  return target === "" || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

function repositoryRelativeTarget(sourceRelative, target) {
  const [pathname, suffix] = splitTarget(target);
  if (pathname.startsWith("/") || /^[a-z]:/i.test(pathname) || pathname.includes("\\") || pathname.includes("\0")) throw new Error(`release documentation has an unsafe target: ${sourceRelative} -> ${target}`);
  const normalized = posix.normalize(posix.join(posix.dirname(sourceRelative), pathname));
  if (normalized === ".." || normalized.startsWith("../")) throw new Error(`release documentation target escapes the repository: ${sourceRelative} -> ${target}`);
  return { normalized, suffix };
}

function pinnedRepositoryUrl(repositoryRoot, sourceRelative, target, revision, kind) {
  const { normalized, suffix } = repositoryRelativeTarget(sourceRelative, target);
  const absolute = resolve(repositoryRoot, ...normalized.split("/"));
  if (!existsSync(absolute)) throw new Error(`release documentation source target is missing: ${sourceRelative} -> ${target}`);
  const encoded = normalized.split("/").map(encodeURIComponent).join("/");
  if (kind === "src" && statSync(absolute).isFile()) return `${REPOSITORY_RAW}/${revision}/${encoded}${suffix}`;
  return `${REPOSITORY_WEB}/${statSync(absolute).isDirectory() ? "tree" : "blob"}/${revision}/${encoded}${suffix}`;
}

export function rewriteReleaseTarget({ repositoryRoot, sourceRelative, target, revision, kind = "href" }) {
  if (isExternalDocumentTarget(target)) return target;
  const { normalized, suffix } = repositoryRelativeTarget(sourceRelative, target);
  const mapped = mappedDocuments.get(normalized);
  if (mapped) return `${mapped}${suffix}`;
  if (normalized === "LICENSE.md") return `../LICENSE.md${suffix}`;
  if (normalized === "apps/mcp-server/package.json") return `../package.json${suffix}`;
  if (normalized === "protocol/ableton-live-v1.operations.json") return `../remote-script/AbletonMcpBridge/ableton-live-v1.operations.json${suffix}`;
  return pinnedRepositoryUrl(repositoryRoot, sourceRelative, target, revision, kind);
}

export function transformReleaseDocument(markdown, options) {
  const rewrite = (target, kind) => {
    const bracketed = target.startsWith("<") && target.endsWith(">");
    const value = bracketed ? target.slice(1, -1) : target;
    const rewritten = rewriteReleaseTarget({ ...options, target: value, kind });
    return bracketed ? `<${rewritten}>` : rewritten;
  };
  let output = markdown.replace(/(!?\[[^\]]*\]\(\s*)(<[^>]+>|[^)\s]+)([^)]*\))/g, (_match, prefix, target, suffix) => `${prefix}${rewrite(target, prefix.startsWith("!") ? "src" : "href")}${suffix}`);
  output = output.replace(/(\b(?:href|src)\s*=\s*)(["'])([^"']+)\2/gi, (_match, prefix, quote, target) => `${prefix}${quote}${rewrite(target, /^src/i.test(prefix.trim()) ? "src" : "href")}${quote}`);
  output = output.replace(/^(\s*\[[^\]]+\]:\s*)(<[^>]+>|\S+)(.*)$/gm, (_match, prefix, target, suffix) => `${prefix}${rewrite(target, "href")}${suffix}`);
  return output;
}

export function stageReleaseDocumentation({ repositoryRoot, docsRoot, revision }) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("release documentation requires an exact Git revision");
  mkdirSync(docsRoot, { recursive: true });
  for (const [sourceRelative, destinationName] of releaseDocumentation) {
    const source = resolve(repositoryRoot, ...sourceRelative.split("/"));
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`release documentation is missing: ${sourceRelative}`);
    const packaged = transformReleaseDocument(readFileSync(source, "utf8"), { repositoryRoot, sourceRelative, revision });
    writeFileSync(resolve(docsRoot, destinationName), packaged, "utf8");
  }
}

export function documentTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)[^)]*\)/g)) targets.push(match[1]);
  for (const match of markdown.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) targets.push(match[1]);
  for (const match of markdown.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)) targets.push(match[1]);
  return targets.map((target) => target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target);
}

export function validatePackagedDocumentation(packageRoot, documentNames) {
  for (const name of documentNames) {
    const documentPath = resolve(packageRoot, ...name.split("/"));
    const markdown = readFileSync(documentPath, "utf8");
    for (const rawTarget of documentTargets(markdown)) {
      if (/^[a-z]:[\\/]/i.test(rawTarget)) throw new Error(`packaged documentation has an unsafe absolute target: ${name} -> ${rawTarget}`);
      if (isExternalDocumentTarget(rawTarget)) continue;
      const [target] = splitTarget(rawTarget);
      let decoded;
      try { decoded = decodeURI(target); } catch { throw new Error(`packaged documentation has a malformed target: ${name} -> ${rawTarget}`); }
      const resolvedTarget = resolve(dirname(documentPath), decoded);
      const within = relative(packageRoot, resolvedTarget);
      if (within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within) || !existsSync(resolvedTarget)) throw new Error(`packaged documentation has a broken internal link: ${name} -> ${rawTarget}`);
    }
  }
}
