//! Original installed-update scenarios, using native bundle layout and executable startup probes.
use async_trait::async_trait;
use futures::FutureExt;
use kumi::{
    bridge_setup::{executable_name, run_program, Ran},
    install::*,
    tui::tty::TtyOutput,
};
use kumi_runtime::{
    ai::{
        error::LanguageModelError,
        http::{Fetch, FetchInit, Response},
    },
    system::{self, Env, SystemProgram},
    KUMI_VERSION,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{cell::RefCell, fs, path::Path, rc::Rc};
#[derive(Default)]
struct Out(RefCell<String>);
impl TtyOutput for Out {
    fn is_tty(&self) -> bool {
        false
    }
    fn columns(&self) -> Option<i32> {
        None
    }
    fn rows(&self) -> Option<i32> {
        None
    }
    fn write(&self, text: &str) {
        self.0.borrow_mut().push_str(text);
    }
}
struct Serve {
    manifest: Value,
    bytes: Vec<u8>,
    status: u16,
    offline: bool,
    calls: RefCell<Vec<String>>,
}
impl Serve {
    fn new(manifest: Value) -> Rc<Self> {
        Rc::new(Self { manifest, bytes: vec![], status: 200, offline: false, calls: RefCell::new(vec![]) })
    }
}
#[async_trait(?Send)]
impl Fetch for Serve {
    async fn fetch(&self, url: &str, init: FetchInit) -> Result<Response, LanguageModelError> {
        assert!(init.signal.is_some());
        self.calls.borrow_mut().push(url.into());
        if self.offline {
            return Err(LanguageModelError::other("offline"));
        }
        if url.ends_with(".json") {
            return Ok(Response::json_response(self.status, self.manifest.clone()));
        }
        Ok(Response {
            body: Some(Box::pin(futures::stream::iter(vec![Ok(self.bytes.clone())]))),
            ..Response::text_response(self.status, "")
        })
    }
}
fn manifest(version: &str) -> Value {
    json!({"kumi":version,"bundle":"kumi.tar.gz","sha256":"a".repeat(64),"runtime":"rust-native","target":native_target()})
}
fn env(dir: &Path) -> Env {
    [
        ("KUMI_HOME".into(), dir.join("home").display().to_string()),
        ("KUMI_RELEASES".into(), "https://example.test/r".into()),
        ("KUMI_REMOTE_SCRIPTS_DIR".into(), dir.join("Remote Scripts").display().to_string()),
        ("HOME".into(), dir.join("user").display().to_string()),
    ]
    .into()
}
fn io(env: &Env) -> (InstalledIo, Rc<Out>) {
    let out = Rc::new(Out::default());
    (InstalledIo::new(out.clone(), env.clone()), out)
}
fn put(path: impl AsRef<Path>, text: impl AsRef<[u8]>) {
    let path = path.as_ref();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}
#[tokio::test]
async fn versions_and_description_checked_before_use() {
    assert!(newer_version("1.1.0", "1.0.9"));
    assert!(newer_version("1.0.10", "1.0.9"));
    assert!(!newer_version("1.0.0", "1.0.0"));
    let good = manifest("1.2.3");
    let serve = Serve::new(good.clone());
    let env = [("KUMI_RELEASES".into(), "https://example.test/r/".into())].into();
    assert_eq!(serde_json::to_value(fetch_manifest(&env, Some(serve.clone())).await.unwrap()).unwrap(), good);
    assert_eq!(*serve.calls.borrow(), vec!["https://example.test/r/kumi-release.json"]);
    for (key, value) in [
        ("sha256", json!("short")),
        ("bundle", json!("../../evil.tar.gz")),
        ("kumi", json!("latest")),
        ("runtime", Value::Null),
        ("target", json!("../target")),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        assert!(fetch_manifest(&env, Some(Serve::new(bad))).await.is_none());
    }
    for serve in [
        Serve { offline: true, ..Rc::try_unwrap(Serve::new(good.clone())).ok().unwrap() },
        Serve { status: 404, ..Rc::try_unwrap(Serve::new(good)).ok().unwrap() },
    ] {
        assert!(fetch_manifest(&env, Some(Rc::new(serve))).await.is_none());
    }
}
#[tokio::test]
async fn release_check_distinguishes_newer_and_unreachable() {
    let env = Env::new();
    assert_eq!(check_release(&env, Some(Serve::new(manifest("99.0.0")))).await.unwrap().as_deref(), Some("99.0.0"));
    assert!(check_release(&env, Some(Serve::new(manifest(KUMI_VERSION)))).await.unwrap().is_none());
    let offline = Serve { offline: true, ..Rc::try_unwrap(Serve::new(Value::Null)).ok().unwrap() };
    assert!(check_release(&env, Some(Rc::new(offline))).await.unwrap_err().message().contains("couldn't reach GitHub"));
}
fn fake_release(dir: &Path, version: &str) -> Vec<u8> {
    let stage = dir.join(format!("stage-{version}"));
    fs::create_dir_all(&stage).unwrap();
    let code = dir.join("main.rs");
    put(&code, format!("fn main() {{ println!(\"Kumi {version}\"); }}"));
    let built = std::process::Command::new("rustc")
        .arg(&code)
        .arg("-o")
        .arg(stage.join(executable_name("kumi")))
        .arg("-C")
        .arg("debuginfo=0")
        .output()
        .unwrap();
    assert!(built.status.success(), "{}", String::from_utf8_lossy(&built.stderr));
    put(stage.join("package.json"), json!({"version":version}).to_string());
    let file = dir.join("kumi.tar.gz");
    assert!(std::process::Command::new(system::system_program_default(SystemProgram::Tar))
        .args(["-czf", file.to_str().unwrap(), "-C", stage.to_str().unwrap(), "."])
        .status()
        .unwrap()
        .success());
    fs::read(file).unwrap()
}
#[tokio::test]
async fn checked_executable_update_swap_and_rollback() {
    let dir = tempfile::tempdir().unwrap();
    let env = env(dir.path());
    let home = Path::new(&env["KUMI_HOME"]);
    put(home.join("app/package.json"), json!({"version":KUMI_VERSION}).to_string());
    put(home.join("app").join(executable_name("kumi")), "earlier");
    put(home.join("settings.json"), "{}");
    let bytes = fake_release(dir.path(), "99.0.0");
    let mut good = manifest("99.0.0");
    good["sha256"] = json!(hex::encode(Sha256::digest(&bytes)));
    let serve = |value: Value| -> Rc<dyn Fetch> {
        Rc::new(Serve { manifest: value, bytes: bytes.clone(), status: 200, offline: false, calls: RefCell::new(vec![]) })
    };
    let (mut tampered, out) = io(&env);
    let mut bad = good.clone();
    bad["sha256"] = json!("b".repeat(64));
    tampered.fetcher = Some(serve(bad));
    assert_eq!(update_installed(tampered).await.unwrap(), 1);
    assert!(out.0.borrow().contains("didn't match its checksum"));
    assert!(!home.join("app.previous").exists());
    let (mut other, out) = io(&env);
    let mut bad = good.clone();
    bad["target"] = json!("another-unknown-target");
    other.fetcher = Some(serve(bad));
    assert_eq!(update_installed(other).await.unwrap(), 1);
    assert!(out.0.borrow().contains("Run the installer again for this computer"));
    let (mut updated, out) = io(&env);
    updated.fetcher = Some(serve(good.clone()));
    let calls = Rc::new(RefCell::new(vec![]));
    let seen = calls.clone();
    updated.run = Some(Rc::new(move |command, args, cwd| {
        seen.borrow_mut().push((command.clone(), args.clone()));
        async move { run_program(&command, &args, cwd.as_deref()).await }.boxed_local()
    }));
    assert_eq!(update_installed(updated).await.unwrap(), 0, "{}", out.0.borrow());
    assert!(out.0.borrow().contains("Kumi is now 99.0.0"));
    assert!(calls.borrow().iter().any(|(cmd, _)| cmd == &system::system_program_default(SystemProgram::Tar)));
    assert!(calls.borrow().iter().any(|(cmd, args)| cmd.ends_with(&executable_name("kumi")) && args == &["--version"]));
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(home.join("app.previous/package.json")).unwrap()).unwrap()["version"],
        KUMI_VERSION
    );
    assert!(!home.join("app.new").exists());
    assert!(!home.join("downloads/kumi.tar.gz").exists());
    assert!(out.0.borrow().contains("To connect Live"));
    assert_eq!(rollback_installed(io(&env).0).await.unwrap(), 0);
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(home.join("app/package.json")).unwrap()).unwrap()["version"], KUMI_VERSION);
    assert_eq!(serde_json::from_slice::<Value>(&fs::read(home.join("app.previous/package.json")).unwrap()).unwrap()["version"], "99.0.0");
    let (mut same, out) = io(&env);
    good["kumi"] = json!(KUMI_VERSION);
    same.fetcher = Some(serve(good));
    assert_eq!(update_installed(same).await.unwrap(), 0);
    assert!(out.0.borrow().contains("up to date"));
}
#[tokio::test]
async fn failed_unpack_or_probe_preserves_current_app() {
    let dir = tempfile::tempdir().unwrap();
    let env = env(dir.path());
    let home = Path::new(&env["KUMI_HOME"]);
    put(home.join("app/v"), "old");
    for (unpack, probe) in [(1, 0), (0, 1), (0, 0)] {
        let (mut io, out) = io(&env);
        let mut value = manifest("99.0.0");
        value["sha256"] = json!(hex::encode(Sha256::digest([])));
        io.fetcher = Some(Serve::new(value));
        io.run = Some(Rc::new(move |command, _, _| {
            async move {
                if command.ends_with(&executable_name("kumi")) {
                    Ran { code: probe, stdout: "wrong version".into(), stderr: "".into() }
                } else {
                    Ran { code: unpack, stdout: "".into(), stderr: "first\nlast\n".into() }
                }
            }
            .boxed_local()
        }));
        assert_eq!(update_installed(io).await.unwrap(), 1);
        assert_eq!(fs::read_to_string(home.join("app/v")).unwrap(), "old");
        assert!(!home.join("app.new").exists());
        assert!(!home.join("downloads/kumi.tar.gz").exists());
        assert!(out.0.borrow().contains(if unpack != 0 { "Unpacking it failed: last" } else { "new Kumi didn't start" }));
    }
}
#[tokio::test]
#[cfg(not(windows))]
async fn uninstall_preserves_producer_files_until_all_requested() {
    let dir = tempfile::tempdir().unwrap();
    let env = env(dir.path());
    let home = Path::new(&env["KUMI_HOME"]);
    for part in ["app", "app.previous", "node", "bin", "projects"] {
        fs::create_dir_all(home.join(part)).unwrap();
    }
    put(home.join("auth.json"), "{}");
    let (mut refused, _) = io(&env);
    refused.confirm = Some(Rc::new(|_| async { false }.boxed_local()));
    assert_eq!(uninstall_installed(refused, UninstallOptions::default()).await.unwrap(), 1);
    assert!(home.join("app").exists());
    assert_eq!(uninstall_installed(io(&env).0, UninstallOptions { all: false, yes: true }).await.unwrap(), 0);
    for part in ["app", "app.previous", "node", "bin"] {
        assert!(!home.join(part).exists());
    }
    assert!(home.join("auth.json").exists());
    assert!(home.join("projects").exists());
    assert_eq!(uninstall_installed(io(&env).0, UninstallOptions { all: true, yes: true }).await.unwrap(), 0);
    assert!(!home.exists());
}
fn with_bridge(dir: &Path) -> Env {
    let mut env = env(dir);
    let home = Path::new(&env["KUMI_HOME"]);
    for part in ["app", "node", "bin"] {
        fs::create_dir_all(home.join(part)).unwrap();
    }
    let package = home.join("bridge/1.0.52-1/package");
    put(package.join("package.json"), json!({"version":"1.0.52"}).to_string());
    put(package.join(executable_name("ableton-mcp-server")), "fixture");
    let config = home.join("bridge/state/bridge-config.json");
    put(
        &config,
        json!({"version":2,"server":{"command":package.join(executable_name("ableton-mcp-server")),"args":["--config",config]}})
            .to_string(),
    );
    put(Path::new(&env["KUMI_REMOTE_SCRIPTS_DIR"]).join("AbletonMcpBridge/bridge-reference.json"), json!({"config":config}).to_string());
    put(home.join("auth.json"), "{}");
    let extensions = dir.join("Ableton/Extensions");
    put(extensions.join("kumi.kumi/manifest.json"), "{}");
    fs::create_dir_all(dir.join("Ableton/Extensions Data/kumi.kumi")).unwrap();
    env.insert("KUMI_LIVE_EXTENSIONS_DIR".into(), extensions.display().to_string());
    env
}
#[tokio::test]
#[cfg(not(windows))]
async fn bridge_files_stay_while_live_uses_them() {
    for kind in ["declined", "live-open", "no-input", "uninstaller-refused", "removed"] {
        let dir = tempfile::tempdir().unwrap();
        let env = with_bridge(dir.path());
        let home = Path::new(&env["KUMI_HOME"]);
        let ext = Path::new(&env["KUMI_LIVE_EXTENSIONS_DIR"]);
        let (mut io, out) = io(&env);
        if kind != "no-input" {
            io.confirm = Some(Rc::new(move |_| async move { kind != "declined" }.boxed_local()));
        }
        io.live_running = Some(Rc::new(move || async move { kind == "live-open" }.boxed_local()));
        let calls = Rc::new(RefCell::new(vec![]));
        let seen = calls.clone();
        io.run = Some(Rc::new(move |command, args, _| {
            seen.borrow_mut().push((command, args));
            async move { Ran { code: if kind == "uninstaller-refused" { 1 } else { 0 }, stdout: "".into(), stderr: "".into() } }
                .boxed_local()
        }));
        assert_eq!(uninstall_installed(io, UninstallOptions { all: kind != "removed", yes: true }).await.unwrap(), 0);
        if kind == "removed" {
            assert!(calls
                .borrow()
                .iter()
                .any(|(cmd, args)| cmd.ends_with(&executable_name("ableton-mcp-server")) && args[0..2] == ["lifecycle", "uninstall"]));
            assert!(!ext.join("kumi.kumi").exists());
            assert!(!dir.path().join("Ableton/Extensions Data/kumi.kumi").exists());
            assert!(!home.join("bridge").exists());
            assert!(home.join("auth.json").exists());
            assert!(out.0.borrow().contains("bridge and Kumi's extension are out"));
        } else {
            assert!(home.join("bridge/state/bridge-config.json").exists());
            assert!(home.join("bridge/1.0.52-1").exists());
            assert!(!home.join("app").exists());
            assert!(!home.join("auth.json").exists());
            assert!(ext.join("kumi.kumi").exists());
            assert!(out.0.borrow().contains("while Live uses it."));
        }
    }
}
#[tokio::test]
#[cfg(not(windows))]
async fn path_removal_honors_zdotdir_and_preserves_unrelated_lines() {
    let dir = tempfile::tempdir().unwrap();
    let mut env = env(dir.path());
    let home = Path::new(&env["KUMI_HOME"]);
    let user = Path::new(&env["HOME"]);
    let zdot = dir.path().join("zdot");
    fs::create_dir_all(home.join("app")).unwrap();
    put(zdot.join(".zshrc"), format!("alias ll='ls -l'\n\n{PATH_MARKER}\nexport PATH=\"{}/bin:$PATH\"\n", home.display()));
    put(user.join(".profile"), format!("{PATH_MARKER}\nexport EDITOR=vim\n"));
    put(user.join(".config/fish/conf.d/kumi.fish"), PATH_MARKER);
    let profile = user.join(".profile");
    let fish = user.join(".config/fish/conf.d/kumi.fish");
    env.insert("ZDOTDIR".into(), zdot.display().to_string());
    uninstall_installed(io(&env).0, UninstallOptions { all: false, yes: true }).await.unwrap();
    assert_eq!(fs::read_to_string(zdot.join(".zshrc")).unwrap(), "alias ll='ls -l'\n\n");
    assert_eq!(fs::read_to_string(profile).unwrap(), "export EDITOR=vim\n");
    assert!(!fish.exists());
}
#[tokio::test]
async fn no_release_is_distinct_from_offline_or_invalid() {
    let dir = tempfile::tempdir().unwrap();
    let env = env(dir.path());
    let notfound = || Rc::new(Serve { status: 404, ..Rc::try_unwrap(Serve::new(Value::Null)).ok().unwrap() });
    assert_eq!(ask_release(&env, Some(notfound())).await, AskedRelease::None);
    assert_eq!(
        ask_release(&env, Some(Rc::new(Serve { offline: true, ..Rc::try_unwrap(Serve::new(Value::Null)).ok().unwrap() }))).await,
        AskedRelease::Offline
    );
    assert_eq!(ask_release(&env, Some(Serve::new(json!("<html>")))).await, AskedRelease::Invalid);
    assert!(check_release(&env, Some(notfound())).await.unwrap_err().message().contains("no Kumi release to get at example.test/r yet"));
    let (mut io, out) = io(&env);
    io.fetcher = Some(notfound());
    assert_eq!(update_installed(io).await.unwrap(), 1);
    assert!(out.0.borrow().contains("no Kumi release to get"));
    assert!(!out.0.borrow().contains("internet"));
}
#[tokio::test]
async fn failed_swap_restores_rollback_copy() {
    let dir = tempfile::tempdir().unwrap();
    let app = dir.path().join("app");
    let prev = dir.path().join("app.previous");
    put(app.join("v"), "2");
    put(prev.join("v"), "1");
    assert!(swap_in(dir.path().join("missing").to_str().unwrap(), app.to_str().unwrap(), prev.to_str().unwrap()).await.is_err());
    assert_eq!(fs::read_to_string(app.join("v")).unwrap(), "2");
    assert_eq!(fs::read_to_string(prev.join("v")).unwrap(), "1");
    let fresh = dir.path().join("app.new");
    put(fresh.join("v"), "3");
    swap_in(fresh.to_str().unwrap(), app.to_str().unwrap(), prev.to_str().unwrap()).await.unwrap();
    assert_eq!(fs::read_to_string(app.join("v")).unwrap(), "3");
    assert_eq!(fs::read_to_string(prev.join("v")).unwrap(), "2");
    assert!(!dir.path().join("app.previous.old").exists());
}
#[tokio::test]
async fn release_check_cache_is_daily_private_and_ignores_future_clock() {
    let dir = tempfile::tempdir().unwrap();
    let cache = dir.path().join("latest.json");
    let cache = cache.to_str().unwrap();
    let serve = Serve::new(manifest("99.0.0"));
    assert_eq!(newer_release(cache, &Env::new(), Some(1000.), Some(serve.clone())).await.as_deref(), Some("99.0.0"));
    assert_eq!(serve.calls.borrow().len(), 1);
    assert_eq!(newer_release(cache, &Env::new(), Some(2000.), Some(serve.clone())).await.as_deref(), Some("99.0.0"));
    assert_eq!(serve.calls.borrow().len(), 1);
    newer_release(cache, &Env::new(), Some(999.), Some(serve.clone())).await;
    assert_eq!(serve.calls.borrow().len(), 2);
    newer_release(cache, &Env::new(), Some(999. + 86400000.), Some(serve.clone())).await;
    assert_eq!(serve.calls.borrow().len(), 3);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(cache).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test]
async fn installed_update_migrates_equal_version_legacy_bridge_after_live_closes() {
    let dir = tempfile::tempdir().unwrap();
    let env = env(dir.path());
    let home = Path::new(&env["KUMI_HOME"]);
    let config = home.join("bridge/state/bridge-config.json");
    put(home.join("app/package.json"), json!({"version":KUMI_VERSION,"bridge":"1.0.73"}).to_string());
    put(home.join("bridge/old/package/package.json"), json!({"version":"1.0.73"}).to_string());
    put(
        &config,
        json!({"server":{"command":"node","args":[home.join("bridge/old/package/dist/src/index.js"),"--config",config]}}).to_string(),
    );
    put(Path::new(&env["KUMI_REMOTE_SCRIPTS_DIR"]).join("AbletonMcpBridge/bridge-reference.json"), json!({"config":config}).to_string());
    for live in [true, false] {
        let (mut io, out) = io(&env);
        io.fetcher = Some(Serve::new(manifest(KUMI_VERSION)));
        io.live_running = Some(Rc::new(move || async move { live }.boxed_local()));
        let calls = Rc::new(RefCell::new(Vec::new()));
        io.update_bridge = Some(Rc::new({
            let calls = calls.clone();
            move |app| {
                calls.borrow_mut().push(app);
                async { 0 }.boxed_local()
            }
        }));
        assert_eq!(update_installed(io).await.unwrap(), 0);
        assert_eq!(calls.borrow().len(), usize::from(!live));
        assert!(out.0.borrow().contains("includes the native bridge (1.0.73)"));
    }
}

#[tokio::test]
async fn native_client_selects_target_from_legacy_compatible_release_index() {
    let selected = manifest("99.0.0");
    let mut index = json!({"kumi":"99.0.0","node":"24.0.0","bundle":"kumi.tar.gz","sha256":"b".repeat(64),"targets":{}});
    index["targets"][native_target()] = selected.clone();
    assert_eq!(serde_json::to_value(fetch_manifest(&Env::new(), Some(Serve::new(index.clone()))).await.unwrap()).unwrap(), selected);
    index["targets"] = json!({"another-platform": selected});
    assert_eq!(ask_release(&Env::new(), Some(Serve::new(index))).await, AskedRelease::Invalid);
}

#[tokio::test]
async fn launcher_handoff_skips_probes_and_rollback_restores_legacy_app_without_moving_user_data() {
    let dir = tempfile::tempdir().unwrap();
    let mut env = env(dir.path());
    env.insert("KUMI_INSTALLED".into(), "1".into());
    let home = Path::new(&env["KUMI_HOME"]);
    let app = home.join("app");
    let previous = home.join("app.previous");
    let binary = app.join(executable_name("kumi"));
    put(&binary, "native runtime fixture");
    put(app.join("package.json"), json!({"version":KUMI_VERSION}).to_string());
    put(previous.join("package.json"), json!({"version":"1.7.3"}).to_string());
    put(previous.join("apps/kumi/bin/kumi.mjs"), "console.log('legacy')");
    put(home.join("node/retained-marker"), "for explicit rollback");
    let markers =
        ["auth.json", "settings.json", "history.json", "library/catalog.json", "memory/producer.json", "conversations/prior.json"];
    for marker in markers {
        put(home.join(marker), format!("preserve {marker}"));
    }
    let launcher_file = home.join("bin").join(if cfg!(windows) { "kumi.cmd" } else { "kumi" });
    put(&launcher_file, "old launcher");
    let fresh = home.join("app.new").join(executable_name("kumi"));
    put(&fresh, "probe fixture");
    assert!(!ensure_native_launcher(&env, &fresh).unwrap());
    assert_eq!(fs::read_to_string(&launcher_file).unwrap(), "old launcher");
    assert!(ensure_native_launcher(&env, &binary).unwrap());
    assert_eq!(fs::read_to_string(&launcher_file).unwrap(), launcher(cfg!(windows)));
    assert_eq!(rollback_installed(io(&env).0).await.unwrap(), 0);
    assert!(app.join("apps/kumi/bin/kumi.mjs").is_file());
    assert!(previous.join(executable_name("kumi")).is_file());
    assert!(home.join("node/retained-marker").exists());
    for marker in markers {
        assert_eq!(fs::read_to_string(home.join(marker)).unwrap(), format!("preserve {marker}"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&launcher_file).unwrap().permissions().mode() & 0o777, 0o755);
    }
}

#[tokio::test]
async fn rollback_to_legacy_requires_closed_live_and_retained_legacy_bridge_generation() {
    for scenario in ["open", "missing", "refused", "ok"] {
        let dir = tempfile::tempdir().unwrap();
        let env = env(dir.path());
        let home = Path::new(&env["KUMI_HOME"]);
        let native = home.join("bridge/native/package");
        let old = home.join("bridge/legacy/package");
        let state = home.join("bridge/state");
        let config = state.join("bridge-config.json");
        let secret = state.join("bridge.secret");
        let scripts = Path::new(&env["KUMI_REMOTE_SCRIPTS_DIR"]);
        put(home.join("app").join(executable_name("kumi")), "native application");
        put(home.join("app/package.json"), json!({"version":KUMI_VERSION}).to_string());
        put(home.join("app.previous/apps/kumi/bin/kumi.mjs"), "legacy application");
        put(home.join("app.previous/package.json"), "{\"version\":\"1.7.3\"}");
        put(native.join("package.json"), "{\"version\":\"1.0.73\"}");
        put(native.join("release-manifest.json"), "{\"schema\":\"ableton-mcp-native-release/v1\"}");
        if scenario != "missing" {
            put(old.join("release-manifest.json"), "{\"schema\":\"ableton-mcp-release/v2\"}");
        }
        put(
            &config,
            json!({"server":{"command":native.join(executable_name("ableton-mcp-server")),"args":["--config",config]}}).to_string(),
        );
        put(scripts.join("AbletonMcpBridge/bridge-reference.json"), json!({"config":config}).to_string());
        let receipt = state.join("install-receipt.json");
        put(&receipt, json!({"version":1,"packageRoot":native,"stateDirectory":state,"configPath":config,"secretPath":secret,"remoteScriptsDirectory":scripts,"previous":{"packageRoot":old}}).to_string());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&receipt, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let (mut io, _) = io(&env);
        io.live_running = Some(Rc::new(move || async move { scenario == "open" }.boxed_local()));
        let calls = Rc::new(RefCell::new(Vec::new()));
        io.run = Some(Rc::new({
            let calls = calls.clone();
            move |command, args, _| {
                calls.borrow_mut().push((command, args));
                async move {
                    if scenario == "refused" {
                        Ran { code: 1, stdout: json!({"reason":"receipt drift"}).to_string(), stderr: String::new() }
                    } else {
                        Ran { code: 0, stdout: json!({"state":"completed"}).to_string(), stderr: String::new() }
                    }
                }
                .boxed_local()
            }
        }));
        let result = rollback_installed(io).await;
        if scenario == "ok" {
            assert_eq!(result.unwrap(), 0);
            assert!(home.join("app/apps/kumi/bin/kumi.mjs").is_file());
            let calls = calls.borrow();
            assert_eq!(calls.len(), 1);
            assert_eq!(&calls[0].1[..2], ["lifecycle", "rollback"]);
            assert!(calls[0].1.contains(&"--confirm-live-stopped".into()));
        } else {
            assert!(result.is_err());
            assert!(home.join("app").join(executable_name("kumi")).is_file());
            assert!(home.join("app.previous/apps/kumi/bin/kumi.mjs").is_file());
            assert_eq!(calls.borrow().len(), usize::from(scenario == "refused"));
        }
    }
}
