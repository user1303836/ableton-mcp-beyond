use async_trait::async_trait;
use kumi_common::{
    abort::{Signal, SignalExt},
    js::json::stringify,
};
use kumi_runtime::{
    core::{contracts::JsonObject, errors::RuntimeError},
    integrations::ableton::views::{self, ViewHost},
    mcp::types::CallToolResult,
};
use serde_json::{json, Value};
use std::cell::RefCell;
struct Replay {
    case: Value,
    calls: RefCell<Vec<Value>>,
}
#[async_trait(?Send)]
impl ViewHost for Replay {
    fn available(&self) -> bool {
        self.case["settings"]["available"] != false && self.case["settings"]["lost"] != true
    }
    fn has(&self, name: &str) -> bool {
        !self.case["settings"]["missing"].as_array().is_some_and(|a| a.contains(&json!(name)))
    }
    fn version(&self) -> Option<String> {
        self.case["settings"]["version"].as_str().map(str::to_owned)
    }
    async fn call(&self, name: &str, args: JsonObject, signal: Signal) -> Result<CallToolResult, RuntimeError> {
        signal.check()?;
        let index = self.calls.borrow().len();
        self.calls.borrow_mut().push(json!({"name":name,"args":args}));
        let response = &self.case["responses"][index];
        if response["abort"] == true {
            signal.cancel();
            return Err(RuntimeError::Aborted);
        }
        if let Some(message) = response["throw"].as_str() {
            return Err(RuntimeError::plain(message));
        }
        serde_json::from_value(response.clone()).map_err(|e| RuntimeError::plain(format!("fixture response {index}: {e}")))
    }
}
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|key| (key.clone(), canonical(&map[key]))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        other => other.clone(),
    }
}
fn eq(actual: &Value, expected: &Value, label: &str) {
    assert_eq!(stringify(&canonical(actual)), stringify(&canonical(expected)), "{label}");
}
#[tokio::test(flavor = "current_thread")]
async fn paged_collections_and_all_focus_views_match_source_results_and_dispatches() {
    let mut parser = serde_json::Deserializer::from_str(include_str!("support/views-oracle.json"));
    parser.disable_recursion_limit();
    let fixture: Value = serde::Deserialize::deserialize(&mut parser).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let host = Replay { case: case.clone(), calls: RefCell::new(Vec::new()) };
        let signal = Signal::new();
        let args = &case["args"];
        let output: Result<Value, RuntimeError> = match case["method"].as_str().unwrap() {
            "_pages" => {
                views::pages(&host, args[0].as_object().unwrap().clone(), signal.clone()).await.map(|v| serde_json::to_value(v).unwrap())
            }
            "_tree" => views::device_tree(&host, args[0].as_str().unwrap(), signal.clone()).await.map(|v| serde_json::to_value(v).unwrap()),
            "sessionStrip" => views::session_strip(&host, args[0].as_str().unwrap(), args[1].as_f64().unwrap(), signal.clone())
                .await
                .map(|v| serde_json::to_value(v).unwrap()),
            "arrangementStrip" => views::arrangement_strip(&host, signal.clone()).await.map(|v| serde_json::to_value(v).unwrap()),
            "clipView" => {
                views::clip_view(&host, args[0].as_str().unwrap(), signal.clone()).await.map(|v| serde_json::to_value(v).unwrap())
            }
            "_pointed" => {
                Ok(serde_json::to_value(kumi_runtime::integrations::ableton::pins::pointed_pin(args[0].as_object().unwrap())).unwrap())
            }
            "_pin" => {
                let pin: kumi_runtime::core::contracts::PinnedNode = serde_json::from_value(args[0].clone()).unwrap();
                let tree = if pin.live == Some(true) {
                    None
                } else {
                    views::device_tree(&host, &pin.track_ref, signal.clone()).await.ok().flatten()
                };
                let mut book = kumi_runtime::integrations::ableton::references::References::default();
                let value = kumi_runtime::integrations::ableton::pins::pin_context(&pin, Some(7.), tree.as_ref(), &mut book);
                Ok(json!({"value":value,"refs":book.refs.iter().collect::<Vec<_>>()}))
            }
            name => panic!("Unknown fixture method {name}"),
        };
        let value = output.unwrap_or_else(|error| json!({"error":if signal.aborted(){"cancelled".into()}else{error.to_string()}}));
        eq(&value, &case["value"], case["label"].as_str().unwrap());
        eq(&json!(*host.calls.borrow()), &case["calls"], &format!("{} dispatches", case["label"]));
    }
}
