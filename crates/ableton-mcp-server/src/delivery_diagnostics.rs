//! Read-only package and authenticated bridge evidence.
use super::*;
use crate::{
    bridge::remote_adapter::{RemoteScriptEndpoint, RemoteScriptLiveAdapter},
    live::*,
};

pub type DiagnosticReport = Value;
pub fn default_package_root() -> PathBuf {
    std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf)).unwrap_or_else(|| PathBuf::from("."))
}
pub fn native_entrypoint(package_root: &Path) -> PathBuf {
    package_root.join(if cfg!(windows) { "ableton-mcp-server.exe" } else { "ableton-mcp-server" })
}
pub fn diagnostics(package_root: Option<&Path>, config_path: Option<&Path>) -> DiagnosticReport {
    let root = package_root.map(Path::to_path_buf).unwrap_or_else(default_package_root);
    let entrypoint = native_entrypoint(&root);
    let config_valid = config_path.is_some_and(|path| path.exists() && read_any_config(path).is_ok());
    let entrypoint_present = entrypoint.is_file();
    let platform_supported = is_supported_platform(None);
    let host_ready = platform_supported && entrypoint_present;
    let package_directory = root.join("remote-script").join(REMOTE_SCRIPT_PACKAGE);
    let remote_script_installed = package_directory.join("__init__.py").exists() && package_directory.join(REMOTE_SCRIPT_ASSET).exists();
    let package_assets_valid = (|| -> Result<bool, LiveError> {
        let manifest: Value = serde_json::from_slice(&read(&package_directory.join("manifest.json"))?)?;
        if manifest["algorithm"] != "sha256" || manifest["registryHash"] != registry_digest() {
            return Ok(false);
        }
        for name in ["__init__.py", REMOTE_SCRIPT_ASSET, OPERATION_REGISTRY_ASSET] {
            if manifest["files"][name] != install::file_digest(&package_directory.join(name))? {
                return Ok(false);
            }
        }
        Ok(true)
    })()
    .unwrap_or(false);
    let mut bridge_configured = false;
    let mut permissions = SecretPermissions::Unavailable;
    if config_valid {
        let config = read_any_config(config_path.unwrap());
        match config {
            Ok(AnyConfig::Bridge(config)) => match read_secret_file(&config.bridge.secret_file) {
                Ok(secret) => {
                    bridge_configured = kumi_common::js::string::utf16_len(&secret) >= 32;
                    permissions = secret_permissions(&config.bridge.secret_file);
                }
                Err(_) => permissions = SecretPermissions::Invalid,
            },
            Err(_) => permissions = SecretPermissions::Invalid,
            _ => {}
        }
    }
    let policy = match crate::tool_catalog::tool_policy_from_env(&std::env::vars().collect()) {
        Ok(policy) => json!({"profile":policy.profile,"allowOverrides":policy.allow,"denyOverrides":policy.deny}),
        Err(_) => json!({"profile":"invalid","allowOverrides":[],"denyOverrides":[]}),
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        arch => arch,
    };
    json!({
        "platform":current_platform(),"arch":arch,"runtime":"rust-native","runtimeSupported":true,"compatibilityError":null,
        "platformSupported":platform_supported,"packageRoot":root,
        "entrypoint":{"path":entrypoint,"present":entrypoint_present},
        "config":{"path":config_path,"present":config_path.is_some_and(Path::exists),"valid":config_valid},
        "hostReady":host_ready,"remoteScriptInstalled":remote_script_installed,"bridgeConfigured":bridge_configured,
        "packageAssetsValid":package_assets_valid,"secretPermissions":permissions,"authenticatedReachable":false,
        "roundTripLatency":null,"adapterProtocol":null,"adapterEpoch":null,"adapterOperations":[],"registryHash":null,
        "discoveryKinds":[],"provenance":"unknown","discoveryReachable":false,"liveConnected":false,"simulator":false,
        "evidence":if host_ready { "local-contract" } else { "unavailable" },
        "external":{"abletonLive":"unavailable","signing":"unavailable","notarization":"unavailable"},"toolPolicy":policy,
        "readiness":{"package":host_ready && package_assets_valid,"configured":bridge_configured,"authenticatedBridge":false,"realLiveOperational":false,"releaseCertified":false},
        "diagnosticErrors":[],"ready":false
    })
}
/// Requires a Tokio LocalSet, like the authenticated adapter it probes.
pub async fn diagnostics_async(package_root: Option<&Path>, config_path: Option<&Path>) -> DiagnosticReport {
    let mut report = diagnostics(package_root, config_path);
    if report["runtimeSupported"] != true
        || report["platformSupported"] != true
        || report["bridgeConfigured"] != true
        || config_path.is_none()
    {
        return report;
    }
    let probe = async {
        let AnyConfig::Bridge(config) = read_any_config(config_path.unwrap())? else { return Ok(None); };
        let started = std::time::Instant::now();
        let adapter = RemoteScriptLiveAdapter::connect(RemoteScriptEndpoint {
            host: config.bridge.host, port: config.bridge.port, secret: read_secret_file(&config.bridge.secret_file)?,
            timeout_ms: Some(config.bridge.timeout_ms), mutation_path: None, retire_after: None,
        }).await?;
        let result = async {
            let status = adapter.status()?;
            let operations = status.operations.clone().unwrap_or_default();
            if !operations.iter().any(|operation| operation == "discover") || !operations.iter().any(|operation| operation == "session.playback") {
                return Err(fail("required read-only discovery operations are unavailable"));
            }
            let mut discovered_kinds = vec![];
            let mut scenes = vec![];
            let mut tracks = vec![];
            for kind in [LiveDiscoveryKind::Set, LiveDiscoveryKind::Scene, LiveDiscoveryKind::Track, LiveDiscoveryKind::SessionPlayback, LiveDiscoveryKind::ClipSlot] {
                let mut request = LiveDiscoveryRequest::of(kind);
                request.limit = Some(16); request.budget = Some(256);
                if kind == LiveDiscoveryKind::ClipSlot {
                    request.parent = tracks.iter().find_map(|item: &serde_json::Map<String, Value>| item.get("ref").and_then(Value::as_str).map(str::to_owned));
                    if request.parent.is_none() { continue; }
                }
                let result = adapter.discover_async(&request, None).await?;
                discovered_kinds.push(serde_json::to_value(kind)?);
                if kind == LiveDiscoveryKind::Scene { scenes = result.items; }
                else if kind == LiveDiscoveryKind::Track { tracks = result.items; }
            }
            if scenes.is_empty() { return Err(fail("scene discovery returned no authoritative scenes")); }
            let provenance = if status.provenance == Some(LiveProvenance::RealLive) { "real-live" }
                else if status.adapter == LiveAdapterKind::Simulator { "simulator" }
                else if status.adapter == LiveAdapterKind::RemoteScript { "fake-live" } else { "unknown" };
            let operational = status.connected && status.adapter == LiveAdapterKind::RemoteScript && provenance == "real-live";
            let latency = (started.elapsed().as_secs_f64() * 1_000_000.0).round() / 1000.0;
            Ok(json!({"authenticatedReachable":true,"roundTripLatency":latency,"adapterProtocol":status.protocol,
                "adapterEpoch":status.epoch,"adapterOperations":operations,"registryHash":status.registry_hash,
                "discoveryReachable":true,"discoveryKinds":discovered_kinds,"provenance":provenance,"liveConnected":operational,
                "simulator":status.adapter == LiveAdapterKind::Simulator,"evidence":"authenticated-bridge",
                "external":{"abletonLive":if provenance == "real-live" { "verified" } else { "unavailable" },"signing":"unavailable","notarization":"unavailable"},
                "readiness":{"package":report["readiness"]["package"],"configured":true,"authenticatedBridge":true,"realLiveOperational":operational,"releaseCertified":false},
                "ready":report["readiness"]["package"] == true && operational}))
        }.await;
        adapter.close().await?;
        result.map(Some)
    }.await;
    match probe {
        Ok(Some(probe)) => report.as_object_mut().unwrap().extend(probe.as_object().unwrap().clone()),
        Ok(None) => {}
        Err(_) => report["diagnosticErrors"].as_array_mut().unwrap().push(json!("authenticated-bridge-probe-failed")),
    }
    report
}
