import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const testDirectory = resolve("dist/test");
const testFiles = readdirSync(testDirectory).filter((file) => file.endsWith(".test.js")).sort().map((file) => resolve(testDirectory, file));
if (testFiles.length === 0) throw new Error("no compiled tests are available for coverage");
const args = [
  "--test", "--test-concurrency=1", "--experimental-test-coverage", "--test-coverage-include=dist/src/**/*.js",
  "--test-coverage-exclude=dist/src/benchmark.js", "--test-coverage-exclude=dist/src/analysis-worker.js",
  "--test-coverage-lines=85", "--test-coverage-branches=65", "--test-coverage-functions=84", ...testFiles,
];
const result = spawnSync(process.execPath, args, { encoding: "utf8" });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const measured = new Map();
for (const line of `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/)) {
  const match = /^\s*(?:ℹ\s*)?(\S+\.js)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)/.exec(line);
  if (match) measured.set(match[1], { lines: Number(match[2]), branches: Number(match[3]), functions: Number(match[4]) });
}
if (measured.size < 15) throw new Error(`coverage parser found only ${measured.size} production modules`);
const failures = [];
for (const [name, values] of measured) {
  if (values.lines < 60 || values.branches < 5 || values.functions < 20) failures.push(`${name} falls below the production-module floor: ${JSON.stringify(values)}`);
}
const critical = {
  "delivery.js": { lines: 80, branches: 60, functions: 85 },
  "lifecycle.js": { lines: 88, branches: 55, functions: 95 },
  "host.js": { lines: 80, branches: 55, functions: 85 },
  "remote-adapter.js": { lines: 85, branches: 65, functions: 65 },
  "project.js": { lines: 90, branches: 75, functions: 90 },
  "session-midi.js": { lines: 85, branches: 60, functions: 90 },
};
for (const [name, thresholds] of Object.entries(critical)) {
  const values = measured.get(name);
  if (!values) { failures.push(`${name} is absent from coverage`); continue; }
  for (const metric of ["lines", "branches", "functions"]) if (values[metric] < thresholds[metric]) failures.push(`${name} ${metric} ${values[metric]} is below ${thresholds[metric]}`);
}
if (failures.length > 0) throw new Error(`per-module coverage policy failed:\n${failures.join("\n")}`);
console.error(`coverage policy ok: ${measured.size} production modules, aggregate and delivery-critical thresholds satisfied`);
