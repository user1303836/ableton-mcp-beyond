import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = resolve(packageRoot, "..", "..", "remote-script");
const destinationRoot = join(packageRoot, "remote-script");
const source = join(sourceRoot, "ableton_mcp_remote_script.py");
const destination = join(destinationRoot, "ableton_mcp_remote_script.py");
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
copyFileSync(join(sourceRoot, "README.md"), join(destinationRoot, "README.md"));
const packageSource = join(sourceRoot, "AbletonMcpBridge");
const packageDestination = join(destinationRoot, "AbletonMcpBridge");
mkdirSync(packageDestination, { recursive: true });
for (const name of readdirSync(packageSource)) {
  if (name.endsWith(".py")) copyFileSync(join(packageSource, name), join(packageDestination, name));
}
copyFileSync(source, join(packageDestination, "ableton_mcp_remote_script.py"));
const manifestFiles = ["__init__.py", "ableton_mcp_remote_script.py"];
const manifest = Object.fromEntries(manifestFiles.map((name) => [name, createHash("sha256").update(readFileSync(join(packageDestination, name))).digest("hex")]));
writeFileSync(join(packageDestination, "manifest.json"), `${JSON.stringify({ package: "AbletonMcpBridge", algorithm: "sha256", files: manifest })}\n`, { flag: "w" });
