use async_trait::async_trait;
use futures::FutureExt;
use kumi_common::abort::{Signal, SignalExt};
use kumi_runtime::{
    core::{contracts::*, errors::RuntimeError},
    integrations::ableton::{
        integration::Ableton,
        observation::ObservationHost,
        options::{AbletonOptions, HandsSetup},
    },
    mcp::{
        client::{McpEndpoint, StderrStatus},
        types::{CallToolResult, Implementation, ListToolsResult},
    },
};
use serde_json::{json, Value};
use std::{cell::Cell, rc::Rc};

struct Fixture {
    case: Value,
    catalog: Value,
    closed: Cell<usize>,
}
#[async_trait(?Send)]
impl McpEndpoint for Fixture {
    fn pid(&self) -> Option<u32> {
        None
    }
    fn server_info(&self) -> Option<Implementation> {
        Some(
            serde_json::from_value(
                json!({"name":"fixture","version":self.case["config"].get("version").cloned().unwrap_or(json!("1.0.73"))}),
            )
            .unwrap(),
        )
    }
    async fn list(&self, _: Option<&str>, signal: Signal) -> Result<ListToolsResult, RuntimeError> {
        signal.check()?;
        Ok(serde_json::from_value(json!({"tools":self.catalog})).unwrap())
    }
    async fn call(&self, name: &str, _: JsonObject, _: Signal) -> Result<CallToolResult, RuntimeError> {
        panic!("unexpected bridge call {name}")
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
        self.closed.set(self.closed.get() + 1);
        Ok(())
    }
}

#[tokio::test(flavor = "current_thread")]
async fn complete_public_tool_catalog_matches_source_versions_capabilities_and_schemas() {
    tokio::task::LocalSet::new().run_until(async{
        let source:Value=serde_json::from_str(include_str!("support/public-tools-oracle.json")).unwrap();
        for (index,case) in source["cases"].as_array().unwrap().iter().enumerate(){
            let expand=|v:&Value|Value::Array(v.as_array().unwrap().iter().map(|id|source["pool"][id.as_u64().unwrap() as usize].clone()).collect());
            let endpoint=Rc::new(Fixture{case:case.clone(),catalog:expand(&case["catalog"]),closed:Cell::new(0)});
            let connect=endpoint.clone();
            let mut options=AbletonOptions::new(Rc::new(|_,_|{}));
            options.connect=Some(Rc::new(move |_|{let connect=connect.clone();async move{Ok(connect as Rc<dyn McpEndpoint>)}.boxed_local()}));
            options.hands=Some(if case["config"]["hands"]==false{HandsSetup::Disabled}else{HandsSetup::Open(Rc::new(||async{Ok(None)}.boxed_local()))});
            let integration=Ableton::new(options);
            integration.start(Signal::new()).await.unwrap();
            integration.connection.tools().unwrap().refresh(Signal::new()).await.unwrap();
            integration.connection.epoch.set(Some(7.));
            let definitions:Vec<_>=integration.definitions().iter().map(|tool|json!({"name":tool.name(),"description":tool.description(),"inputSchema":tool.input_schema(),"stream":tool.stream(Signal::new(),Rc::new(||{})).is_some()})).collect();
            assert_eq!(json!(definitions),expand(&case["definitions"]),"catalog {index} config {}",case["config"]);
            assert!(integration.has_undo()&&integration.has_audio_file()&&integration.has_stop_live()&&integration.has_device_tree()&&integration.has_clip_view()&&integration.has_session_strip()&&integration.has_arrangement_strip()&&integration.has_audition()&&integration.has_goal()&&integration.has_hear());
            let (first,second)=futures::join!(integration.close(),integration.close());first.unwrap();second.unwrap();
            assert_eq!(endpoint.closed.get(),1);
        }
    }).await;
}
