// Refresh document rewrite expectations from the authoritative JavaScript packager.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseDocumentation, transformReleaseDocument } from '../../apps/mcp-server/scripts/release-documentation.mjs';
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const revision = 'a'.repeat(40);
const docs = Object.fromEntries(releaseDocumentation.map(([sourceRelative]) => [sourceRelative,
  createHash('sha256').update(transformReleaseDocument(readFileSync(resolve(repositoryRoot, sourceRelative), 'utf8'), { repositoryRoot, sourceRelative, revision })).digest('hex')]));
writeFileSync(new URL('./native-release-doc-oracle.json', import.meta.url), JSON.stringify({ revision, docs }, null, 2) + '\n');
