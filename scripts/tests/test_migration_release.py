"""Legacy-updater and built-artifact migration probes in isolated temporary homes."""
import hashlib
import functools
import http.server
import threading
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("migration_release", Path(__file__).parents[1] / "build-migration-release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

class MigrationRelease(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="kumi-migration-test-")
        self.root = Path(self.directory.name)
        arch = {"arm64": "aarch64", "aarch64": "aarch64", "AMD64": "x86_64", "x86_64": "x86_64"}[platform.machine()]
        system = {"Darwin": "apple-darwin", "Linux": "unknown-linux-gnu", "Windows": "pc-windows-msvc"}[platform.system()]
        self.target = f"{arch}-{system}"
        self.node = subprocess.check_output(["node", "-p", "process.versions.node"], text=True, encoding="utf-8").strip()
        stage = self.root / "stage"
        stage.mkdir()
        self.binary = "kumi.exe" if os.name == "nt" else "kumi"
        source = self.root / "fixture.rs"
        source.write_text('fn main() { let args: Vec<_> = std::env::args().skip(1).collect(); if args == ["--version"] {println!("Kumi 99.0.0")} else {println!("native fixture: {}", args.join("|"));} }', encoding="utf-8")
        subprocess.run(["rustc", str(source), "-C", "debuginfo=0", "-o", str(stage / self.binary)], check=True)
        (stage / "package.json").write_text(json.dumps({"version":"99.0.0", "bridge":"1.0.73", "runtime":"rust-native"}), encoding="utf-8")
        bundle = f"kumi-{self.target}.tar.gz"
        digest = release.native.archive(stage, self.root / bundle, "", 0)
        self.manifest = self.root / "kumi-release.json"
        self.manifest.write_text(json.dumps({"kumi":"99.0.0", "bridge":"1.0.73", "runtime":"rust-native", "target":self.target, "bundle":bundle, "sha256":digest}), encoding="utf-8")
        self.out = self.root / "release"
        self.index = release.build([self.manifest], self.out, self.node)

    def tearDown(self):
        self.directory.cleanup()

    def unpack(self, folder):
        folder.mkdir(parents=True)
        with tarfile.open(self.out / "kumi.tar.gz") as archive:
            archive.extractall(folder, filter="data")
        return folder / "apps/kumi/bin/kumi.mjs"

    def test_index_and_archive_are_bound_and_old_probe_materializes_native_once(self):
        self.assertEqual(release.native.digest(self.out / "kumi.tar.gz"), self.index["sha256"])
        self.assertEqual(self.index["node"], self.node)
        self.assertEqual(json.loads((self.out / f"kumi-release-{self.target}.json").read_text(encoding="utf-8")), self.index["targets"][self.target])
        app = self.root / "app.new"
        entry = self.unpack(app)
        first = subprocess.run(["node", str(entry), "--version"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, "Kumi 99.0.0\n")
        self.assertTrue((app / self.binary).is_file())
        self.assertFalse((app / "native").exists())
        again = subprocess.run(["node", str(entry), "argument with spaces", "--model=example"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(again.stdout, "native fixture: argument with spaces|--model=example\n")
        self.assertEqual(again.returncode, 0, again.stderr)

    def test_checksum_failure_keeps_unstaged_app_and_aggregator_rejects_tampered_input(self):
        app = self.root / "app.new"
        entry = self.unpack(app)
        archive = next((app / "native").iterdir())
        archive.write_bytes(b"tampered")
        result = subprocess.run(["node", str(entry), "--version"], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 1)
        self.assertIn("checksum", result.stderr)
        self.assertFalse((app / self.binary).exists())
        original = json.loads(self.manifest.read_text(encoding="utf-8"))
        (self.manifest.parent / original["bundle"]).write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "checksum"):
            release.build([self.manifest], self.out, self.node)

    @unittest.skipIf(os.name == "nt", "Unix installer; Windows PowerShell runs in the installer workflow")
    def test_fresh_unix_installer_uses_native_target_without_node_and_preserves_repair_rollback(self):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(self.out)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            home = self.root / "fresh home"
            env = dict(os.environ, KUMI_HOME=str(home), KUMI_RELEASES=f"http://127.0.0.1:{server.server_port}",
                       KUMI_NO_MODIFY_PATH="1", PATH="/usr/bin:/bin:/usr/sbin:/sbin")
            for iteration in range(2):
                run = subprocess.run(["sh", str(release.native.ROOT / "install.sh")], env=env, capture_output=True, text=True, encoding="utf-8")
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertFalse((home / "node").exists())
                result = subprocess.run([str(home / "bin/kumi"), "--version"], env=env, capture_output=True, text=True, encoding="utf-8")
                self.assertEqual(result.stdout, "Kumi 99.0.0\n")
                self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue((home / "app.previous" / self.binary).is_file())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_npm_command_with_cargo_builds_this_checkout_and_forwards_arguments(self):
        tools = self.root / "tools"
        tools.mkdir()
        fixture = self.root / "cargo.rs"
        fixture.write_text('''use std::{env,fs::OpenOptions,io::Write}; fn main() { let args: Vec<_> = env::args().skip(1).collect(); let mut file = OpenOptions::new().create(true).append(true).open(env::var("KUMI_SHIM_LOG").unwrap()).unwrap(); writeln!(file,"{}",args.join("|" )).unwrap(); if args.first().map(String::as_str)==Some("run") { println!("checkout native fixture"); assert!(env::var("KUMI_INSTALLED").is_err()); } }''', encoding="utf-8")
        cargo = tools / ("cargo.exe" if os.name == "nt" else "cargo")
        subprocess.run(["rustc", str(fixture), "-C", "debuginfo=0", "-o", str(cargo)], check=True)
        log = self.root / "cargo.log"
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ["PATH"], KUMI_SHIM_LOG=str(log), KUMI_INSTALLED="1")
        env.pop("KUMI_REFERENCE_RUNTIME", None)
        result = subprocess.run(["node", str(release.native.ROOT / "scripts/native-kumi.mjs"), "--model", "a model with spaces"], env=env, cwd=self.root, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("checkout native fixture", result.stdout)
        self.assertEqual(log.read_text(encoding="utf-8").splitlines(), ["--version", "build|--quiet|--release|--locked|--workspace|--bins", "run|--quiet|--release|--locked|-p|kumi|--|--model|a model with spaces"])

    def test_reference_switch_is_confined_to_npm_shim_and_skips_native_acquisition(self):
        checkout = self.root / "reference checkout"
        (checkout / "scripts").mkdir(parents=True)
        shutil.copyfile(release.native.ROOT / "scripts/native-kumi.mjs", checkout / "scripts/native-kumi.mjs")
        entry = checkout / "apps/kumi/bin/kumi.mjs"
        entry.parent.mkdir(parents=True)
        entry.write_text("console.log('reference fixture: ' + process.argv.slice(2).join('|'))", encoding="utf-8")
        result = subprocess.run(["node", str(checkout / "scripts/native-kumi.mjs"), "--help"], env=dict(os.environ, KUMI_REFERENCE_RUNTIME="1"), capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "reference fixture: --help\n")

    def test_npm_handoff_failure_does_not_log_private_environment_values(self):
        checkout = self.root / "launcher checkout"
        (checkout / "scripts").mkdir(parents=True)
        shutil.copyfile(release.native.ROOT / "scripts/native-kumi.mjs", checkout / "scripts/native-kumi.mjs")
        (checkout / "package.json").write_text('{"version":"99.0.0"}')
        (checkout / "install.sh").write_text("exit 0\n")
        tools = self.root / "launcher tools"
        tools.mkdir()
        system = self.root / "launcher-system-private-marker"
        if os.name == "nt":
            helper = system / "System32/WindowsPowerShell/v1.0/powershell.exe"
            helper.parent.mkdir(parents=True)
            shutil.copyfile(self.root / "stage" / self.binary, helper)
        else:
            helper = tools / "sh"
            helper.symlink_to(shutil.which("sh"))
        env = dict(os.environ, PATH=str(tools), KUMI_TEST_SYSTEM_ROOT=str(system),
                   KUMI_HOME=str(self.root / "launcher-home-private-marker"),
                   KUMI_VERSION="launcher-version-private-marker")
        env.pop("KUMI_REFERENCE_RUNTIME", None)
        for missing_helper in (False, True):
            if missing_helper:
                helper.unlink()
            # Let Node initialize with Windows' real SystemRoot before injecting the test helper path.
            wrapper = "import { pathToFileURL } from 'node:url'; process.env.SystemRoot = process.env.KUMI_TEST_SYSTEM_ROOT; await import(pathToFileURL(process.argv[1]).href);"
            result = subprocess.run([shutil.which("node"), "--input-type=module", "-e", wrapper,
                                     str(checkout / "scripts/native-kumi.mjs"), "--setup"],
                                    env=env, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            self.assertIn("Kumi", result.stderr)
            for marker in ("launcher-system-private-marker", "launcher-home-private-marker", "launcher-version-private-marker"):
                self.assertNotIn(marker, result.stdout + result.stderr)

    @unittest.skipIf(os.name == "nt", "PowerShell acquisition is exercised by installer CI")
    def test_npm_only_handoff_installs_native_without_rust_or_moving_credentials(self):
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *args):
                pass
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(self.out)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            home = self.root / "npm-only home"
            home.mkdir()
            (home / "auth.json").write_text('{"version":1,"credentials":{"fixture":"unchanged"}}', encoding="utf-8")
            env = dict(os.environ, KUMI_HOME=str(home), KUMI_RELEASES=f"http://127.0.0.1:{server.server_port}",
                       KUMI_NO_MODIFY_PATH="1", PATH="/usr/bin:/bin:/usr/sbin:/sbin")
            env.pop("KUMI_REFERENCE_RUNTIME", None)
            result = subprocess.run([shutil.which("node"), str(release.native.ROOT / "scripts/native-kumi.mjs"), "--setup"], env=env, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("switching this npm installation to the native release", result.stdout)
            self.assertEqual((home / "auth.json").read_text(encoding="utf-8"), '{"version":1,"credentials":{"fixture":"unchanged"}}')
            result = subprocess.run([shutil.which("node"), str(release.native.ROOT / "scripts/native-kumi.mjs"), "argument with spaces"], env=env, capture_output=True, text=True, encoding="utf-8")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "native fixture: argument with spaces\n")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def production_environment(self, home, scripts):
        env = dict(os.environ)
        for key in list(env):
            if key.startswith(("KUMI_", "ABLETON_MCP_")) or key in ("AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENCODE_API_KEY", "LM_API_TOKEN"):
                env.pop(key)
        env.update(KUMI_HOME=str(home), KUMI_INSTALLED="1", KUMI_NO_UPDATE_CHECK="1", KUMI_UI="plain",
                   KUMI_REMOTE_SCRIPTS_DIR=str(scripts), KUMI_LIVE_EXTENSIONS_DIR=str(home / "Live Extensions"),
                   KUMI_BRIDGE_WAIT_SECONDS="0")
        if platform.system() == "Darwin":
            # The fixture owns isolated ports/assets; do not make local tests depend on the user's Live.
            # Only its process-list observation is injected. The native lifecycle still validates the receipt.
            tools = home / "test-tools"
            tools.mkdir(parents=True, exist_ok=True)
            pgrep = tools / "pgrep"
            pgrep.write_text('#!/bin/sh\n[ "$#" = 2 ] && [ "$1" = -x ] && [ "$2" = Live ] || exit 2\nexit 1\n', encoding="utf-8")
            pgrep.chmod(0o755)
            env["PATH"] = str(tools) + os.pathsep + env["PATH"]
        return env

    def existing_data(self, home):
        project = str(home / "Existing Set.als")
        project_id = hashlib.sha256(project.encode()).hexdigest()[:32]
        markers = {
            "settings.json": json.dumps({"model":"anthropic/claude-sonnet-5-5", "effort":"high", "panelTab":"history",
                                         "libraryFolders":[], "updateCheck":False, "voice":{"language":"ja","send":True}}),
            "auth.json": json.dumps({"version":1,"credentials":{"anthropic":{"type":"api-key","key":"sk-ant-existing-fixture-private-0000"}}}),
            "input-history": '"/status"\n"/quit"\n',
            "memory.json": '{"version":1,"notes":[{"id":"p1","text":"Keep the kick dry","at":1700000000000}]}',
            "library/sounds.jsonl": json.dumps({"kumiLibrary":"sounds","version":1,"generation":"existing","created":1700000000000}) + "\n" + json.dumps({"path":str(home / "Existing Kick.wav"),"size":4096,"mtime":1700000000000,"seconds":0.5,"kind":"one-shot","class":"kick"}) + "\n",
            f"projects/{project_id}/last-seen.json": json.dumps({"version":1,"path":project,"name":"Existing Set","savedAt":1700000000000,"artifactId":"saved-artifact","pages":[{"tempo":120,"tracks":[]}]}),
            f"projects/{project_id}/current": "saved001",
            f"projects/{project_id}/conversations/saved001.json": json.dumps({"savedAt":1700000000000,"first":"Keep the kick dry","turns":1,"checkpoint":{"version":1,"origin":"anthropic/claude-sonnet-5-5","messages":[{"role":"user","content":"Keep the kick dry"},{"role":"assistant","content":"I'll keep it dry."}]}}),
        }
        for name, text in markers.items():
            file = home / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(text, encoding="utf-8")
        (home / "auth.json").chmod(0o600)
        return {name:(home / name).read_bytes() for name in markers}

    def check_existing_data(self, home, markers):
        for name, contents in markers.items():
            self.assertEqual((home / name).read_bytes(), contents, name)

    def launched(self, command, env, *args, input=None):
        result = subprocess.run([str(command), *args], env=env, input=input, capture_output=True, text=True, encoding="utf-8", timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def legacy_installation(self, home):
        reference_root = Path(os.environ.get("KUMI_TS_REFERENCE", release.native.ROOT))
        home.mkdir()
        markers = self.existing_data(home)
        old_entry = home / "app/apps/kumi/bin/kumi.mjs"
        old_entry.parent.mkdir(parents=True)
        # The actual old launcher and CLI execute; a wrapper resolves its reference build's dependencies.
        shutil.copyfile(reference_root / "apps/kumi/bin/kumi.mjs", old_entry)
        old_cli = home / "app/apps/kumi/dist/src/cli.js"
        old_cli.parent.mkdir(parents=True)
        old_cli.write_text("await import(" + json.dumps((reference_root / "apps/kumi/dist/src/cli.js").as_uri()) + ");\n", encoding="utf-8")
        (home / "app/package.json").write_text('{"version":"1.7.4","type":"module"}', encoding="utf-8")
        original_entry = old_entry.read_bytes()
        node = home / "node" / ("node.exe" if os.name == "nt" else "bin/node")
        node.parent.mkdir(parents=True)
        source_node = Path(shutil.which("node")).resolve()
        shutil.copy2(source_node, node)
        # Homebrew Node uses a relative libnode; official installer Node is self-contained.
        if platform.system() == "Darwin":
            for library in (source_node.parent.parent / "lib").glob("libnode.*.dylib"):
                target = home / "node/lib" / library.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(library, target)
        legacy_root = home / "legacy bridge"
        legacy_root.mkdir()
        installed = subprocess.run(["node", str(release.native.ROOT / "crates/ableton-mcp-server/tests/support/legacy_install.mjs"),
                                    json.dumps({"root":str(legacy_root),"version":"1.0.73","custom":False,"clean":True})],
                                   cwd=reference_root, capture_output=True, text=True, encoding="utf-8", timeout=60)
        self.assertEqual(installed.returncode, 0, installed.stderr)
        old = json.loads(installed.stdout)["receipt"]
        env = self.production_environment(home, Path(old["remoteScriptsDirectory"]))
        self.assertEqual(self.launched(node, env, str(old_entry), "--version"), "Kumi 1.7.4\n")
        return markers, old, original_entry, env

    @unittest.skipUnless(os.environ.get("KUMI_NATIVE_RELEASES"), "built release interoperability runs in installer CI")
    def test_actual_built_bundle_launches_and_reads_existing_data(self):
        artifacts = Path(os.environ["KUMI_NATIVE_RELEASES"])
        manifest = json.loads((artifacts / "kumi-release.json").read_text(encoding="utf-8"))
        target = manifest["targets"][self.target]
        home = self.root / "native existing data"
        app = home / "app"
        app.mkdir(parents=True)
        archive = artifacts / target["bundle"]
        self.assertEqual(release.native.digest(archive), target["sha256"])
        with tarfile.open(archive) as bundle:
            bundle.extractall(app, filter="data")
        markers = self.existing_data(home)
        env = self.production_environment(home, home / "Remote Scripts")
        output = self.launched(app / self.binary, env, "--version")
        self.assertIn(manifest["kumi"], output)
        launcher = home / "bin" / ("kumi.cmd" if os.name == "nt" else "kumi")
        self.assertTrue(launcher.exists(), "the active native app repairs the existing installer's launcher")
        self.assertIn("kumi bridge", self.launched(launcher, env, "--help"))
        self.assertIn("anthropic/claude-sonnet-5-5", self.launched(launcher, env, "model"))
        status = self.launched(launcher, env, "auth")
        self.assertIn("anthropic     API key saved in Kumi", status)
        self.assertNotIn("sk-ant-existing", status)
        self.assertFalse((home / "node").exists(), "native commands must work without a bundled Node runtime")
        self.check_existing_data(home, markers)
        if platform.system() == "Darwin":
            source = release.native.ROOT / "crates/kumi-runtime/src/hands/KumiHands.swift"
            helper = app / "packages/runtime/hands" / ("kumi-hands-" + release.native.digest(source)[:12])
            self.assertTrue(helper.is_file(), "the signed helper retains its legacy installed path")
            subprocess.run(["codesign", "--verify", "--strict", str(helper)], check=True, capture_output=True)
            self.assertEqual(set(subprocess.check_output(["lipo", "-archs", str(helper)], text=True, encoding="utf-8").split()), {"arm64", "x86_64"})
            replies = [json.loads(line) for line in self.launched(helper, env, input=
                '{"id":1,"op":"version"}\n{"id":2,"op":"trusted","prompt":false}\n').splitlines()]
            self.assertEqual([(reply["id"], reply["ok"]) for reply in replies], [(1, True), (2, True)])
            self.assertEqual(replies[0]["version"], 2)
            self.assertIsInstance(replies[1]["trusted"], bool)  # No prompt or Live operation; permission continuity needs a real terminal.
        suffix = ".exe" if os.name == "nt" else ""
        self.assertIn(manifest["bridge"], self.launched(app / ("ableton-mcp-server" + suffix), env, "--version"))
        requests = [
            {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"release-probe","version":"1"}}},
            {"jsonrpc":"2.0","method":"notifications/initialized"},
            {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"live_status","arguments":{}}},
        ]
        replies = [json.loads(line) for line in self.launched(app / ("ableton-mcp-server" + suffix), env,
                         input="".join(json.dumps(request) + "\n" for request in requests)).splitlines()]
        self.assertEqual(len(replies), 2)
        self.assertEqual(next(reply for reply in replies if reply["id"] == 1)["result"]["serverInfo"]["version"], manifest["bridge"])
        status = json.loads(next(reply for reply in replies if reply["id"] == 2)["result"]["content"][0]["text"])
        self.assertFalse(status["connected"])
        self.assertEqual(status["adapter"], "unavailable")
        self.assertNotEqual(status.get("provenance"), "real-live")
        reply = json.loads(self.launched(app / ("ableton-mcp-analysis-worker" + suffix), env,
                              input=json.dumps({"mode":"analyze","source":{"pcmBase64":"AAAAPwAAAL8AAAA/AAAAvw==","sampleRate":48000}})))
        self.assertTrue(reply["ok"])
        self.assertEqual(reply["result"]["sampleCount"], 4)
        self.assertEqual(reply["result"]["peak"], 0.5)

    @unittest.skipUnless(os.environ.get("KUMI_NATIVE_RELEASES"), "built release interoperability runs in installer CI")
    def test_actual_built_bundle_migrates_same_version_bridge_and_restores_legacy_launch(self):
        # Exercise bridge/launcher handoff independently of the separate newer-app updater gate.
        artifacts = Path(os.environ["KUMI_NATIVE_RELEASES"])
        manifest = json.loads((artifacts / "kumi-release.json").read_text(encoding="utf-8"))
        home = self.root / "bridge transition home"
        markers, old, original_entry, env = self.legacy_installation(home)
        config, secret = Path(old["configPath"]), Path(old["secretPath"])
        config_before, secret_before = config.read_bytes(), secret.read_bytes()
        receipt = Path(old["stateDirectory"]) / "install-receipt.json"
        (home / "app").rename(home / "app.previous")
        (home / "app").mkdir()
        archive = artifacts / manifest["targets"][self.target]["bundle"]
        self.assertEqual(release.native.digest(archive), manifest["targets"][self.target]["sha256"])
        with tarfile.open(archive) as bundle:
            bundle.extractall(home / "app", filter="data")
        self.launched(home / "app" / self.binary, env, "--version")
        launcher = home / "bin" / ("kumi.cmd" if os.name == "nt" else "kumi")
        # No new flags or sign-in: the existing bridge reference leads to its original receipt.
        opened = self.launched(launcher, env, input="/quit\n")
        current = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(current["packageVersion"], old["packageVersion"])
        self.assertEqual(current["config"]["bridge"], old["config"]["bridge"])
        self.assertEqual(current["config"]["server"]["args"], ["--config", str(config)], opened)
        self.assertEqual(secret.read_bytes(), secret_before)
        self.check_existing_data(home, markers)
        self.launched(launcher, env, "update", "--rollback")
        self.assertEqual((home / "app/apps/kumi/bin/kumi.mjs").read_bytes(), original_entry)
        self.assertEqual(config.read_bytes(), config_before)
        self.assertEqual(secret.read_bytes(), secret_before)
        self.assertEqual(self.launched(launcher, env, "--version"), "Kumi 1.7.4\n")
        self.assertIn("anthropic     API key saved in Kumi", self.launched(launcher, env, "auth"))
        self.check_existing_data(home, markers)
        self.launched(launcher, env, "update", "--rollback")
        self.assertIn(manifest["kumi"], self.launched(launcher, env, "--version"))
        self.launched(launcher, env, input="/quit\n")
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["config"]["server"]["args"], ["--config", str(config)])
        self.assertEqual(secret.read_bytes(), secret_before)
        self.check_existing_data(home, markers)

    @unittest.skipUnless(os.environ.get("KUMI_NATIVE_RELEASES"), "built release interoperability runs in installer CI")
    def test_actual_built_release_with_authoritative_old_updater(self):
        reference_root = Path(os.environ.get("KUMI_TS_REFERENCE", release.native.ROOT))
        reference = reference_root / "apps/kumi/dist/src/install.js"
        artifacts = Path(os.environ["KUMI_NATIVE_RELEASES"])
        manifest = json.loads((artifacts / "kumi-release.json").read_text(encoding="utf-8"))
        # A current 1.7.4 updater ignores a same-version application release. Keep this gate strict.
        self.assertGreater(tuple(map(int, manifest["kumi"].split("-")[0].split("."))), (1, 7, 4),
                           "the native transition must publish a newer application version than legacy 1.7.4")
        home = self.root / "production home"
        markers, old, original_entry, env = self.legacy_installation(home)
        old_entry = home / "app/apps/kumi/bin/kumi.mjs"
        node = home / "node" / ("node.exe" if os.name == "nt" else "bin/node")
        config, secret = Path(old["configPath"]), Path(old["secretPath"])
        receipt = Path(old["stateDirectory"]) / "install-receipt.json"
        config_before, secret_before = config.read_bytes(), secret.read_bytes()
        test = self.root / "built-updater.mjs"
        test.write_text('''import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {updateInstalled} = await import(pathToFileURL(process.argv[2]));
const release = JSON.parse(readFileSync(process.argv[3] + '/kumi-release.json'));
const env = {...process.env, KUMI_RELEASES:'https://fixture.invalid'};
const io = {env, out:process.stdout, fetcher: async url => new Response(url.endsWith('.json') ? JSON.stringify(release) : readFileSync(process.argv[3] + '/' + release.bundle))};
if (await updateInstalled(io) !== 0) throw new Error('old updater failed');
''', encoding="utf-8")
        self.launched(node, env, str(test), str(reference), str(artifacts))
        self.assertTrue((home / "app" / self.binary).is_file())
        self.assertEqual(config.read_bytes(), config_before, "the old version-only updater leaves the same-version bridge for native startup")
        self.assertIn(manifest["kumi"], self.launched(home / "app" / self.binary, env, "--version"))
        launcher = home / "bin" / ("kumi.cmd" if os.name == "nt" else "kumi")
        self.assertIn("anthropic/claude-sonnet-5-5", self.launched(launcher, env, "model"))
        self.assertIn("anthropic     API key saved in Kumi", self.launched(launcher, env, "auth"))
        self.check_existing_data(home, markers)
        # Opening as usual performs the receipt-bound bridge handoff before the conversation starts.
        self.launched(launcher, env, "--bridge-config", str(config), input="/quit\n")
        current = json.loads(receipt.read_text(encoding="utf-8"))
        self.assertEqual(current["packageVersion"], old["packageVersion"])
        self.assertEqual(current["config"]["bridge"], old["config"]["bridge"])
        self.assertEqual(current["config"]["server"]["args"], ["--config", str(config)])
        self.assertEqual(secret.read_bytes(), secret_before)
        self.check_existing_data(home, markers)
        # Native rollback restores both the app and the exact legacy bridge configuration.
        self.launched(launcher, env, "update", "--rollback")
        self.assertEqual(old_entry.read_bytes(), original_entry)
        self.assertEqual(config.read_bytes(), config_before)
        self.assertEqual(secret.read_bytes(), secret_before)
        self.assertEqual(self.launched(launcher, env, "--version"), "Kumi 1.7.4\n")
        self.assertIn("anthropic/claude-sonnet-5-5", self.launched(launcher, env, "model"))
        self.assertIn("anthropic     API key saved in Kumi", self.launched(launcher, env, "auth"))
        self.check_existing_data(home, markers)
        # The unchanged old rollback command can return to the retained native generation.
        self.launched(launcher, env, "update", "--rollback")
        self.assertIn(manifest["kumi"], self.launched(launcher, env, "--version"))
        self.assertTrue((home / "app" / self.binary).is_file())
        self.launched(launcher, env, "--bridge-config", str(config), input="/quit\n")
        self.assertEqual(json.loads(receipt.read_text(encoding="utf-8"))["config"]["server"]["args"], ["--config", str(config)])
        self.assertEqual(secret.read_bytes(), secret_before)
        self.check_existing_data(home, markers)

    def test_actual_source_installed_updater_swaps_after_native_probe_and_retains_user_data(self):
        reference = Path(os.environ.get("KUMI_TS_REFERENCE", release.native.ROOT)) / "apps/kumi/dist/src/install.js"
        if not reference.exists():
            self.skipTest("build the authoritative TypeScript reference or set KUMI_TS_REFERENCE")
        home = self.root / "home"
        entry = home / "app/apps/kumi/bin/kumi.mjs"
        entry.parent.mkdir(parents=True)
        entry.write_text("console.log('legacy Kumi')", encoding="utf-8")
        (home / "app/package.json").write_text('{"version":"1.7.4"}', encoding="utf-8")
        markers = ["settings.json", "auth.json", "history.json", "library/catalog.json", "conversations/session.json", "memory/producer.json"]
        for name in markers:
            file = home / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(f"unchanged {name}", encoding="utf-8")
        test = self.root / "old-updater.mjs"
        test.write_text('''import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const {updateInstalled, rollbackInstalled} = await import(pathToFileURL(process.argv[2]));
const manifest = JSON.parse(readFileSync(process.argv[3] + '/kumi-release.json'));
const env = {KUMI_HOME:process.argv[4], KUMI_RELEASES:'https://fixture.invalid', KUMI_REMOTE_SCRIPTS_DIR:process.argv[4]+'/absent'};
const io = {env, out:process.stdout, fetcher: async url => new Response(url.endsWith('.json') ? JSON.stringify(manifest) : readFileSync(process.argv[3] + '/' + manifest.bundle))};
if (await updateInstalled(io) !== 0) throw new Error('old update failed');
if (await rollbackInstalled(io) !== 0) throw new Error('old rollback failed');
if (await rollbackInstalled(io) !== 0) throw new Error('old return-to-native failed');
''', encoding="utf-8")
        completed = subprocess.run(["node", str(test), str(reference), str(self.out), str(home)], capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("Kumi is now 99.0.0", completed.stdout)
        self.assertTrue((home / "app" / self.binary).exists())
        self.assertEqual((home / "app.previous/apps/kumi/bin/kumi.mjs").read_text(encoding="utf-8"), "console.log('legacy Kumi')")
        for name in markers:
            self.assertEqual((home / name).read_text(encoding="utf-8"), f"unchanged {name}")

if __name__ == '__main__':
    unittest.main()
