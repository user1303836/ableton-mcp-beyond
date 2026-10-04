#!/usr/bin/env node
// One-time adapter for an already installed JavaScript Kumi updater/launcher.
// The application and every normal launch after the handoff run the native binary.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const extension = process.platform === 'win32' ? '.exe' : '';
const executable = join(app, `kumi${extension}`);
const arch = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
const system = { darwin: 'apple-darwin', linux: 'unknown-linux-gnu', win32: 'pc-windows-msvc' }[process.platform];
try {
  if (!existsSync(executable)) {
    const manifest = JSON.parse(readFileSync(join(app, 'native-targets.json'), 'utf8'));
    const target = arch && system && `${arch}-${system}`;
    const release = target && manifest.targets[target];
    if (!release) throw new Error(`This Kumi release has no native build for ${process.platform}/${process.arch}.`);
    const archive = join(app, 'native', release.bundle);
    if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== release.sha256) {
      throw new Error('The native Kumi bundle did not match its checksum. The previous Kumi stays available.');
    }
    const staging = join(app, `.native-stage-${process.pid}`);
    mkdirSync(staging);
    try {
      const tar = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
      const unpacked = spawnSync(tar, ['-xzf', archive, '-C', staging], { stdio: 'inherit' });
      if (unpacked.error || unpacked.status !== 0) throw new Error('Could not unpack the native Kumi bundle.');
      const probe = spawnSync(join(staging, `kumi${extension}`), ['--version'], { encoding: 'utf8', env: { ...process.env, KUMI_LEGACY_HANDOFF: '0' } });
      if (probe.error || probe.status !== 0 || !probe.stdout.includes(release.kumi)) {
        throw new Error('The native Kumi did not start. The previous Kumi stays available.');
      }
      // The old updater is probing app.new here; it owns the atomic app/previous swap.
      for (const name of readdirSync(staging)) {
        const destination = join(app, name);
        rmSync(destination, { recursive: true, force: true });
        renameSync(join(staging, name), destination);
      }
      rmSync(join(app, 'native'), { recursive: true, force: true });
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit', env: { ...process.env, KUMI_LEGACY_HANDOFF: '1' } });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  else process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(`Kumi: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
