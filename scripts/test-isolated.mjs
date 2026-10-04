#!/usr/bin/env node
// Runs `node --test` in a home of its own: HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME and
// KUMI_HOME point into a fresh temporary folder, so no test can reach this machine's Live folders,
// Remote Scripts or ~/.kumi through a default it forgot to override (homedir(), kumiDir() and the like).
// Live's folders set in this shell (KUMI_REMOTE_SCRIPTS_DIR, KUMI_LIVE_EXTENSIONS_DIR) aren't passed on.
// The arguments are node --test's: the test files, or patterns it expands itself.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "kumi-test-home-"));
const env = { ...process.env, KUMI_REFERENCE_RUNTIME: "1", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), XDG_CONFIG_HOME: join(home, ".config"), KUMI_HOME: join(home, ".kumi") };
delete env.KUMI_REMOTE_SCRIPTS_DIR; delete env.KUMI_LIVE_EXTENSIONS_DIR;
const run = spawnSync(process.execPath, ["--test", ...process.argv.slice(2)], { stdio: "inherit", env });
rmSync(home, { recursive: true, force: true });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
