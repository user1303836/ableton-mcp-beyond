import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const testDirectory = resolve("dist/test");
const testFiles = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => resolve(testDirectory, file));

if (testFiles.length === 0) throw new Error(`no compiled test files found in ${testDirectory}`);

const result = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
