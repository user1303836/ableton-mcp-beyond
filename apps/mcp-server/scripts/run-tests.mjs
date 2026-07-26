import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const testDirectory = resolve("dist/test");
const testFiles = readdirSync(testDirectory)
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => resolve(testDirectory, file));

if (testFiles.length === 0) throw new Error(`no compiled test files found in ${testDirectory}`);

// Performance-gate tests share the same process resources as functional tests.
// Run files serially so CI load from unrelated test workers cannot turn their
// wall-clock budgets into flaky failures; `npm run benchmark` repeats the gates
// in a dedicated process after this suite.
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
