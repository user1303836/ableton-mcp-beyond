use async_trait::async_trait;
use futures::FutureExt;
use kumi_common::{
    abort::{Signal, SignalExt},
    js::json::stringify,
};
use kumi_runtime::{
    core::{contracts::*, errors::RuntimeError},
    hands::*,
    integrations::ableton::{
        command_tools::{CommandTools, CommandToolsOptions},
        connection::{ConnectionOptions, LiveConnection},
        history::History,
        options::HandsSetup,
        remember::Remember,
    },
    mcp::{
        client::{McpEndpoint, StderrStatus},
        types::{CallToolResult, ListToolsResult},
    },
};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
struct Fixture {
    config: Value,
    changed: Cell<bool>,
    calls: RefCell<Vec<Value>>,
    hands_calls: RefCell<Vec<Value>>,
    counts: RefCell<HashMap<String, usize>>,
}
fn wrap(value: Value) -> CallToolResult {
    serde_json::from_value(if value.is_object() {
        json!({"content":[{"type":"text","text":stringify(&value)}],"structuredContent":value})
    } else {
        json!({"content":[{"type":"text","text":stringify(&value)}]})
    })
    .unwrap()
}
impl Fixture {
    fn hand(&self, method: &str, args: Vec<Value>) -> Result<Value, HandsError> {
        let mut call = vec![json!(method)];
        call.extend(args);
        self.hands_calls.borrow_mut().push(json!(call));
        let mut counts = self.counts.borrow_mut();
        let count = counts.entry(method.into()).or_default();
        let configured = self.config["hands"][method].as_array().and_then(|v| v.get(*count).or_else(|| v.last()));
        *count += 1;
        if let Some(error) = configured.and_then(|v| v.get("throw")).and_then(Value::as_str) {
            return Err(HandsError::new(error, HandsErrorKind::Failed));
        }
        if method == "menu" || method == "keys" {
            self.changed.set(true);
        }
        Ok(configured.cloned().unwrap_or_else(|| match method {
            "trusted" => json!(true),
            "menus" => json!([{"path":["Edit","Freeze Track"],"enabled":true,"key":"f","modifiers":1048576},{"path":["Edit","Unfreeze Track"],"enabled":true},{"path":["Edit","Flatten Track"],"enabled":true},{"path":["Edit","Group Tracks"],"enabled":true},{"path":["Edit","Ungroup Tracks"],"enabled":true},{"path":["File","Save Live Set"],"enabled":true},{"path":["Edit","Duplicate"],"enabled":true},{"path":["Create","Consolidate"],"enabled":true}]),
            "dialog" => json!({"open":false}),
            _ => json!({"ok":true}),
        }))
    }
}
#[async_trait(?Send)]
impl Hands for Fixture {
    async fn trusted(&self, prompt: bool) -> Result<bool, HandsError> {
        Ok(self.hand("trusted", vec![json!(prompt)])?.as_bool().unwrap())
    }
    async fn menus(&self, _: Option<Signal>) -> Result<Vec<MenuItem>, HandsError> {
        Ok(serde_json::from_value(self.hand("menus", vec![])?).unwrap())
    }
    async fn tracks(&self, tracks: &[Track], _: Option<Signal>) -> Result<HandsReply, HandsError> {
        Ok(serde_json::from_value(self.hand("tracks", vec![json!(tracks)])?).unwrap())
    }
    async fn menu(&self, path: &[String], options: MenuOptions) -> Result<HandsReply, HandsError> {
        let options = if options.titles.is_empty() { json!({}) } else { json!({"titles":options.titles}) };
        Ok(serde_json::from_value(self.hand("menu", vec![json!(path), options])?).unwrap())
    }
    async fn keys(&self, keys: &[String], _: KeysOptions) -> Result<HandsReply, HandsError> {
        Ok(serde_json::from_value(self.hand("keys", vec![json!(keys), json!({})])?).unwrap())
    }
    async fn dialog(&self, _: Option<Signal>) -> Result<Dialog, HandsError> {
        Ok(serde_json::from_value(self.hand("dialog", vec![])?).unwrap())
    }
    async fn answer(&self, answer: &str, _: Option<Signal>) -> Result<HandsReply, HandsError> {
        Ok(serde_json::from_value(self.hand("answer", vec![json!(answer)])?).unwrap())
    }
    async fn windows(&self, _: Option<Signal>) -> Result<Vec<Window>, HandsError> {
        unreachable!()
    }
    fn close(&self) {}
}
#[async_trait(?Send)]
impl McpEndpoint for Fixture {
    fn pid(&self) -> Option<u32> {
        None
    }
    fn server_info(&self) -> Option<kumi_runtime::mcp::types::Implementation> {
        Some(serde_json::from_value(json!({"name":"fixture","version":"1.0.73"})).unwrap())
    }
    async fn list(&self, _: Option<&str>, _: Signal) -> Result<ListToolsResult, RuntimeError> {
        Ok(serde_json::from_value(json!({"tools":(["live_status","live_discover","live_device_read"].iter().map(|name|json!({"name":name,"inputSchema":{"type":"object"}})).collect::<Vec<_>>())})).unwrap())
    }
    async fn call(&self, name: &str, args: JsonObject, signal: Signal) -> Result<CallToolResult, RuntimeError> {
        signal.check()?;
        self.calls.borrow_mut().push(json!({"name":name,"args":args}));
        if let Some(error) = self.config["throwRead"].as_str() {
            return Err(RuntimeError::plain(error));
        }
        if name == "live_device_read" {
            return Ok(self
                .config
                .get("deviceRead")
                .map(|v| serde_json::from_value(v.clone()).unwrap())
                .unwrap_or_else(|| wrap(json!({"names":self.config.get("names").cloned().unwrap_or(json!(["Cutoff","Drive"]))}))));
        }
        if args.get("kind") == Some(&json!("device")) {
            return Ok(self
                .config
                .get("deviceDiscovery")
                .map(|v| serde_json::from_value(v.clone()).unwrap())
                .unwrap_or_else(|| wrap(json!({"items":[{"ref":"7:device:0:0","name":self.config.get("deviceName").cloned().unwrap_or(json!("Unknown Synth"))}]}))));
        }
        if args.get("kind") == Some(&json!("parameter")) {
            return Ok(self
                .config
                .get("parameterRead")
                .map(|v| serde_json::from_value(v.clone()).unwrap())
                .unwrap_or_else(|| wrap(json!({"items":self.config.get("parameters").cloned().unwrap_or(json!([{"ref":"7:parameter:0:0:0","name":"Device On"},{"ref":"7:parameter:0:0:1","name":"Cutoff","displayValue":"1 kHz"}]))}))));
        }
        let tracks = self.config.get("tracks").cloned().unwrap_or(json!([{"ref":"7:track:0","name":"Bass","kind":"midi","isFrozen":false,"isVisible":true},{"ref":"7:track:1","name":"Drums","kind":"audio","isFrozen":true,"isVisible":true}]));
        let tracks = if self.changed.get() { self.config.get("after").cloned().unwrap_or(tracks) } else { tracks };
        Ok(wrap(
            json!({"epoch":7,"kind":args["kind"],"items":if args["kind"]=="track"{tracks}else{json!([])},"revision":"r1","truncated":false}),
        ))
    }
    fn on_catalog_changed(&self, _: Rc<dyn Fn()>) -> Box<dyn Fn()> {
        Box::new(|| {})
    }
    fn on_disconnect(&self, _: Rc<dyn Fn()>) -> Box<dyn Fn()> {
        Box::new(|| {})
    }
    fn stderr_status(&self) -> StderrStatus {
        StderrStatus { bytes: 0, truncated: false }
    }
    async fn close(&self) -> Result<(), RuntimeError> {
        Ok(())
    }
}
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(o) => {
            let mut keys = o.keys().collect::<Vec<_>>();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), canonical(&o[k]))).collect())
        }
        Value::Array(v) => json!(v.iter().map(canonical).collect::<Vec<_>>()),
        _ => v.clone(),
    }
}
fn eq(a: Value, b: &Value, label: &str) {
    assert_eq!(stringify(&canonical(&a)), stringify(&canonical(b)), "{label}");
}
#[tokio::test(flavor = "current_thread", start_paused = true)]
async fn command_and_plugin_traces_match_typescript() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let fixture: Value = serde_json::from_str(include_str!("support/command-tools-oracle.json")).unwrap();
            for case in fixture["cases"].as_array().unwrap() {
                let label = case["label"].as_str().unwrap();
                let config = &case["config"];
                let endpoint = Rc::new(Fixture {
                    config: config.clone(),
                    changed: Cell::new(false),
                    calls: RefCell::new(vec![]),
                    hands_calls: RefCell::new(vec![]),
                    counts: RefCell::new(HashMap::new()),
                });
                let connected = endpoint.clone();
                let mut options = ConnectionOptions::new(Rc::new(|_, _| {}));
                options.connect = Some(Rc::new(move |_| {
                    let ep: Rc<dyn McpEndpoint> = connected.clone();
                    async move { Ok(ep) }.boxed_local()
                }));
                options.now =
                    Some(Rc::new(|| chrono::DateTime::parse_from_rfc3339("2026-10-03T12:00:00Z").unwrap().with_timezone(&chrono::Utc)));
                options.generation = Some("connection".into());
                let library = tempfile::tempdir().unwrap();
                let connection = LiveConnection::new(options);
                connection.start(Signal::new()).await.unwrap();
                connection.tools().unwrap().refresh(Signal::new()).await.unwrap();
                connection.available.set(config["available"] != false);
                connection.lost.set(config["lost"] == true);
                connection.epoch.set(if config["noEpoch"] == true { None } else { Some(7.0) });
                if let Some(refs) = config["refs"].as_array() {
                    for r in refs {
                        connection.references.borrow_mut().refs.insert(r[0].as_str().unwrap().into(), r[1].as_str().unwrap().into());
                    }
                }
                if let Some(shorts) = config["shorts"].as_array() {
                    for r in shorts {
                        connection.references.borrow_mut().short_ref(r.as_str().unwrap());
                    }
                }
                let events = Rc::new(RefCell::new(vec![]));
                let out = events.clone();
                let remember = Remember::new(connection.clone(), None, None);
                let history = Rc::new(History::new(
                    connection.clone(),
                    remember.clone(),
                    None,
                    Some(Rc::new(move |r| {
                        let mut r = serde_json::to_value(r).unwrap();
                        r["id"] = json!("<id>");
                        out.borrow_mut().push(r);
                    })),
                ));
                let actions = Rc::new(RefCell::new(vec![]));
                let out = actions.clone();
                let hands = endpoint.clone();
                let no_hands = config["noHands"] == true;
                let hands = if config["disabled"] == true {
                    HandsSetup::Disabled
                } else {
                    HandsSetup::Open(Rc::new(move || {
                        let hands: Rc<dyn Hands> = hands.clone();
                        async move { Ok(if no_hands { None } else { Some(hands) }) }.boxed_local()
                    }))
                };
                let act_calls = Rc::new(RefCell::new(vec![]));
                let out_act = act_calls.clone();
                let act_throw = config["actThrow"].as_str().map(str::to_owned);
                let observation_throw = config["observationThrow"] == true;
                let act_reply = config.get("act").cloned().unwrap_or(json!({"text":"selected","isError":false}));
                let commands = CommandTools::new(
                    connection.clone(),
                    history.clone(),
                    remember,
                    CommandToolsOptions {
                        user_library: Some(library.path().to_string_lossy().into()),
                        hands: Some(hands),
                        on_action: Some(Rc::new(move |a| out.borrow_mut().push(json!(a)))),
                        ..Default::default()
                    },
                    Rc::new(move |name, args, _| {
                        out_act.borrow_mut().push(json!([name,args]));
                        let result = act_reply.clone();
                        let error = act_throw.clone();
                        async move {
                            if let Some(error) = error {
                                return Err(if observation_throw { RuntimeError::Observation(error) } else { RuntimeError::plain(error) });
                            }
                            Ok(if result["isError"] == true {
                                ToolResult::error(result["text"].as_str().unwrap())
                            } else {
                                ToolResult::text(result["text"].as_str().unwrap())
                            })
                        }
                        .boxed_local()
                    }),
                );
                let mut results = Vec::new();
                for op in case["ops"].as_array().unwrap() {
                    let signal = Signal::new();
                    if op["abort"] == true {
                        signal.cancel();
                    }
                    let input = op["input"].as_object().unwrap();
                    let result = if op["plugin"] == true {
                        commands.plugin_tool(input, signal).await
                    } else {
                        commands.live_command(input, signal).await
                    };
                    let result = match result {
                        Ok(r) => json!({"text":r.text,"isError":r.is_error}),
                        Err(RuntimeError::Aborted) => json!({"error":"cancelled"}),
                        Err(e) => json!({"error":e.to_string()}),
                    };
                    let refs = connection.references.borrow();
                    results.push(json!({"result":result,"state":{"epoch":connection.epoch.get(),"lease":connection.lease.get(),"refs":refs.refs.iter().collect::<Vec<_>>(),"known":refs.known.iter().collect::<Vec<_>>(),"cursors":refs.cursors.iter().collect::<Vec<_>>()}}));
                }
                connection.close().await.unwrap();
                // JSON objects in text are compared structurally; all plain messages stay exact.
                let mut expected = case["results"].clone();
                let mut actual = json!(results);
                for list in [&mut expected, &mut actual] {
                    for r in list.as_array_mut().unwrap() {
                        if let Some(s) = r["result"]["text"].as_str() {
                            if let Ok(v) = serde_json::from_str::<Value>(s) {
                                r["result"]["text"] = v;
                            }
                        }
                    }
                }
                normalize_paths(&mut actual, library.path().to_str().unwrap());
                if !cfg!(target_os="macos") && (config["disabled"]==true || config["noHands"]==true) { for item in expected.as_array_mut().unwrap() { item["result"]["text"]=json!("Kumi can\'t use Live\'s menus on this computer."); } }
                eq(actual, &expected, &format!("{label} results"));
                eq(json!(*endpoint.calls.borrow()), &case["calls"], &format!("{label} dispatches"));
                eq(json!(*endpoint.hands_calls.borrow()), &case["handsCalls"], &format!("{label} hands"));
                eq(json!(*act_calls.borrow()), &case["actCalls"], &format!("{label} acts"));
                eq(json!(*actions.borrow()), &case["actions"], &format!("{label} actions"));
                eq(json!(*events.borrow()), &case["events"], &format!("{label} history"));
                assert!(history.entries.borrow().is_empty());
                let folder = library.path().join("Kumi/Wavetables");
                let mut files = if folder.exists() {
                    std::fs::read_dir(&folder).unwrap().map(|entry| entry.unwrap().path()).collect::<Vec<_>>()
                } else {
                    vec![]
                };
                files.sort();
                use sha2::{Digest, Sha256};
                let files = files.iter().map(|path| json!({"name":path.file_name().unwrap().to_str().unwrap(),"sha256":hex::encode(Sha256::digest(std::fs::read(path).unwrap()))})).collect::<Vec<_>>();
                eq(json!(files), &case["files"], &format!("{label} files"));
            }
        })
        .await;
}

fn normalize_paths(value: &mut Value, library: &str) {
    match value {
        Value::String(text) if text.starts_with(library) => *text = format!("<library>{}", text[library.len()..].replace('\\', "/")),
        Value::Array(values) => {
            for value in values {
                normalize_paths(value, library)
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                normalize_paths(value, library)
            }
        }
        _ => {}
    }
}
