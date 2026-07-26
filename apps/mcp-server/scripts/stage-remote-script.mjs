import { copyFileSync, mkdirSync } from "node:fs";
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
