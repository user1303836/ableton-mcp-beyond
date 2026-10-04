use ableton_mcp_server::{live::*, transactions::batch::*};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
fn patch(state: &mut Value, patches: &Value) {
    for patch in patches.as_array().unwrap() {
        let parts: Vec<_> = patch[0].as_str().unwrap().split('.').collect();
        let mut parent = &mut *state;
        for part in &parts[..parts.len() - 1] {
            parent = if parent.is_array() { &mut parent[part.parse::<usize>().unwrap()] } else { &mut parent[*part] };
        }
        let key = parts.last().unwrap();
        if patch[1] == "$delete" {
            parent.as_object_mut().unwrap().shift_remove(*key);
        } else if parent.is_array() {
            parent[key.parse::<usize>().unwrap()] = patch[1].clone();
        } else {
            parent[*key] = patch[1].clone();
        }
    }
}
fn same(left: &Value, right: &Value, label: &str) {
    assert_eq!(canonical(left).unwrap(), canonical(right).unwrap(), "{label}");
}
#[tokio::test]
async fn batch_preview_validation_and_authority_plans_match_typescript() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/batch-oracle.json")).unwrap();
    for row in fixture["validation"].as_array().unwrap() {
        let sim = Rc::new(DeterministicLiveSimulator::new());
        if let Some(patches) = row.get("patch") {
            patch(&mut sim.state.borrow_mut(), patches);
        }
        let manager = BatchTransactionManager::new(sim, None, None);
        let result = manager.preview_async(&row["request"]).await;
        if let Some(error) = row.get("error") {
            assert_eq!(result.unwrap_err().message(), error.as_str().unwrap(), "{}", row["name"]);
        } else {
            let mut result = result.unwrap_or_else(|error| panic!("{}: {error}", row["name"]));
            result.as_object_mut().unwrap().shift_remove("transactionId");
            result.as_object_mut().unwrap().shift_remove("expiresAt");
            same(&result, &row["result"], row["name"].as_str().unwrap());
        }
    }
}
#[derive(Default)]
struct Faults {
    deny: Cell<bool>,
    deny_read: Cell<usize>,
    reads: Cell<usize>,
    lost_at: Cell<usize>,
    executions: Cell<usize>,
    replays: Cell<usize>,
    ledger: RefCell<HashMap<String, Value>>,
    calls: RefCell<Vec<Value>>,
}
struct Adapter {
    sim: Rc<DeterministicLiveSimulator>,
    faults: Rc<Faults>,
}
impl LiveAdapter for Adapter {
    fn status(&self) -> Result<LiveStatus, LiveError> {
        self.sim.status()
    }
    fn snapshot(&self) -> Result<LiveSnapshot, LiveError> {
        self.sim.snapshot()
    }
    fn get(&self, r: &LiveRef) -> Result<Option<Value>, LiveError> {
        self.sim.get(r)
    }
    fn invoke(&self, i: &LiveInvocation) -> Result<Value, LiveError> {
        self.sim.invoke(i)
    }
    fn subscribe(&self, l: LiveListener) -> Result<Unsubscribe, LiveError> {
        self.sim.subscribe(l)
    }
    fn reconnect(&self) -> Result<LiveStatus, LiveError> {
        self.sim.reconnect()
    }
}
#[async_trait::async_trait(?Send)]
impl AsyncLiveAdapter for Adapter {
    async fn snapshot_async(&self, _: Option<&LiveOperationContext>, _: Option<&LiveSnapshotRequest>) -> Result<LiveSnapshot, LiveError> {
        self.faults.reads.set(self.faults.reads.get() + 1);
        let result = self.sim.snapshot();
        if self.faults.reads.get() == self.faults.deny_read.get() {
            self.faults.deny.set(true);
        }
        result
    }
    async fn discover_async(&self, _: &LiveDiscoveryRequest, _: Option<&LiveOperationContext>) -> Result<LiveDiscoveryResult, LiveError> {
        Err(LiveError::error("unused discovery"))
    }
    async fn get_async(&self, r: &LiveRef, _: Option<&LiveOperationContext>) -> Result<Option<Value>, LiveError> {
        self.sim.get(r)
    }
    async fn invoke_async(&self, i: &LiveInvocation, c: Option<&LiveOperationContext>) -> Result<Value, LiveError> {
        let value = serde_json::to_value(i).unwrap();
        self.faults.calls.borrow_mut().push(value.clone());
        let key = format!(
            "{}:{}:{}",
            c.and_then(|c| c.transaction_id.as_deref()).unwrap_or("undefined"),
            c.and_then(|c| c.idempotency_key.as_deref()).unwrap_or("undefined"),
            kumi_common::js::json::stringify(&value)
        );
        if let Some(result) = self.faults.ledger.borrow().get(&key) {
            self.faults.replays.set(self.faults.replays.get() + 1);
            return Ok(result.clone());
        }
        let result = self.sim.invoke(i)?;
        self.faults.ledger.borrow_mut().insert(key, result.clone());
        let executions = self.faults.executions.get() + 1;
        self.faults.executions.set(executions);
        if executions == self.faults.lost_at.get() {
            return Err(LiveError::error("remote adapter request state uncertain after dispatch timeout"));
        }
        Ok(result)
    }
    async fn reconnect_async(&self, _: Option<&LiveOperationContext>) -> Result<LiveStatus, LiveError> {
        self.sim.reconnect()
    }
    async fn close(&self) -> Result<(), LiveError> {
        Ok(())
    }
}
#[tokio::test]
async fn batch_results_dispatches_recovery_and_state_match_typescript() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/batch-oracle.json")).unwrap();
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let sim = Rc::new(DeterministicLiveSimulator::new());
        let faults = Rc::new(Faults::default());
        faults.deny_read.set(scenario["fault"]["denyRead"].as_u64().unwrap_or(0) as usize);
        faults.lost_at.set(scenario["fault"]["lostAt"].as_u64().unwrap_or(0) as usize);
        let adapter = Rc::new(Adapter { sim: sim.clone(), faults: faults.clone() });
        let policy_faults = faults.clone();
        let manager = BatchTransactionManager::new(
            adapter,
            Some(Rc::new(move |_| if policy_faults.deny.get() { Err(LiveError::error("policy denied")) } else { Ok(()) })),
            None,
        );
        let mut id = String::new();
        for step in scenario["steps"].as_array().unwrap() {
            let action = &step["action"];
            let key = action["key"].as_str();
            let label = format!("{}: {action}", scenario["name"]);
            let result: Result<Option<Value>, LiveError> = match action["method"].as_str().unwrap() {
                "preview" => manager.preview_async(&json!({"operations":scenario["operations"]})).await.map(|result| {
                    id = result["transactionId"].as_str().unwrap().into();
                    Some(result)
                }),
                "apply" => manager
                    .apply_async(&id, action.get("confirmation").unwrap_or(&json!("apply")), key.unwrap_or("batch-apply"), None)
                    .await
                    .map(Some),
                "undo" => manager
                    .undo_async(&id, action.get("confirmation").unwrap_or(&json!("undo")), key.unwrap_or("batch-undo"), None)
                    .await
                    .map(Some),
                "edit" => sim
                    .simulate_external_edit(
                        &LiveRef::from(action["ref"].as_str().unwrap()),
                        action["property"].as_str().unwrap(),
                        action["value"].clone(),
                    )
                    .map(|_| None),
                "patch" => {
                    patch(&mut sim.state.borrow_mut(), &action["patch"]);
                    Ok(None)
                }
                "deny" => {
                    faults.deny.set(action["value"].as_bool().unwrap());
                    Ok(None)
                }
                "release" => Ok(Some(json!(manager.release(&id)))),
                "finalize" => manager.finalize(&id).map(Some),
                "reconnect" => sim.reconnect().map(|_| None),
                other => panic!("{other}"),
            };
            if let Some(error) = step.get("error") {
                assert_eq!(result.unwrap_err().message(), error.as_str().unwrap(), "{label}");
            } else {
                let mut result = result.unwrap_or_else(|error| panic!("{label}: {error}"));
                if let Some(Value::Object(object)) = &mut result {
                    if object.get("transactionId").is_some() {
                        object.insert("transactionId".into(), "$transaction".into());
                    }
                    object.shift_remove("expiresAt");
                }
                match step.get("result") {
                    Some(expected) => same(result.as_ref().unwrap(), expected, &label),
                    None => assert!(result.is_none(), "{label}"),
                }
            }
            assert_eq!(fingerprint(&sim.state.borrow()).unwrap(), step["stateHash"].as_str().unwrap(), "state {label}");
        }
        same(&json!(*faults.calls.borrow()), &scenario["calls"], &format!("{} dispatches", scenario["name"]));
        assert_eq!(json!(faults.executions.get()), scenario["executions"], "{}", scenario["name"]);
        assert_eq!(json!(faults.replays.get()), scenario["replays"], "{}", scenario["name"]);
    }
}
#[test]
fn parameter_helpers_preserve_macro_alias_order_and_float_tolerance() {
    let rows = json!([{"ref":"p1","objectIdentity":"i1","value":1},{"ref":"p1","objectIdentity":"i1","value":2},{"ref":"p2","objectIdentity":"i2"},{"ref":"p1","objectIdentity":"i3"}]);
    assert_eq!(unique_parameter_rows(rows.as_array().unwrap()), vec![rows[0].clone(), rows[2].clone(), rows[3].clone()]);
    assert!(same_parameter_value(&json!(0.29999998), &json!(0.3)));
    assert!(!same_parameter_value(&json!(0.2999), &json!(0.3)));
    let snapshot = json!({"tracks":[{"ref":"t","objectIdentity":"ti","devices":[{"ref":"d","objectIdentity":"di","parameters":[rows[0]],"macros":[rows[1],rows[2]]}]}]});
    let authority = parameter_authority(&snapshot, "p2").unwrap();
    assert_eq!(authority["siblings"], json!([{"ref":"p1","objectIdentity":"i1"},{"ref":"p2","objectIdentity":"i2"}]));
    let nested =
        json!([{"ref":"root","chains":[{"devices":[{"ref":"chain-child"}]}],"drumPads":[{"chains":[{"devices":[{"ref":"pad-child"}]}]}]}]);
    assert_eq!(
        flatten_device_rows(&nested).iter().map(|row| row["ref"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["root", "chain-child", "pad-child"]
    );
}
