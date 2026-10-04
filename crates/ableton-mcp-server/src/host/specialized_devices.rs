//! Published device-family properties, fenced over each family's complete state.
use super::*;
use super::{arrangement::truthy, reads::AUDITION_DEADLINE_MS};
use kumi_common::{abort::Signal, js::json as js_json};
use sha2::{Digest, Sha256};
fn family_fields(family: &str) -> Option<&'static [&'static str]> {
    Some(match family {
        "drift" => &[
            "pitchBendRange",
            "voiceCount",
            "voiceMode",
            "modFilterSource1",
            "modFilterSource2",
            "modLfoSource",
            "modPitchSource1",
            "modPitchSource2",
            "modShapeSource",
            "modSource1",
            "modSource2",
            "modSource3",
            "modTarget1",
            "modTarget2",
            "modTarget3",
        ],
        "drum-cell" => &["gain"],
        "eq8" => &["editMode", "globalMode", "oversample", "selectedBand"],
        "hybrid-reverb" => &["irCategory", "irFile", "attack", "decay", "size"],
        "meld" => &["engine", "unison", "monoPoly", "polyphony"],
        "plugin" => &["presetIndex", "isEditorOpen"],
        "sample" => SAMPLE_FIELDS,
        "wavetable" => WAVETABLE_FIELDS,
        _ => return None,
    })
}
fn row_key(family: &str) -> &str {
    match family {
        "drum-cell" => "drumCell",
        "hybrid-reverb" => "hybridReverb",
        _ => family,
    }
}
fn bounds(field: &str) -> Option<(f64, f64, bool)> {
    Some(match field {
        "pitchBendRange" => (1., 96., true),
        "voiceCount" | "polyphony" => (1., 64., true),
        "voiceMode" => (0., 8., true),
        "modFilterSource1" | "modFilterSource2" | "modLfoSource" | "modPitchSource1" | "modPitchSource2" | "modShapeSource"
        | "modSource1" | "modSource2" | "modSource3" | "modTarget1" | "modTarget2" | "modTarget3" => (0., 1000., true),
        "gain" => (-70., 24., false),
        "editMode" | "globalMode" | "engine" => (0., 4., true),
        "selectedBand" => (0., 8., true),
        "attack" | "size" => (0., 10000., false),
        "decay" | "time" => (0., 100000., false),
        "unison" => (1., 16., true),
        "presetIndex" => (0., 1024., true),
        value if SAMPLE_FIELDS.contains(&value) => (0., 1000000., false),
        value if WAVETABLE_FIELDS.contains(&value) => (0., 100000., true),
        _ => return None,
    })
}
fn digest(v: &Value) -> Result<String, LiveError> {
    Ok(hex::encode(Sha256::digest(canonical_mutation_identity(v)?)))
}
fn state(fields: &[&str], row: &Value) -> Value {
    Value::Object(fields.iter().map(|k| ((*k).into(), row[*k].clone())).collect())
}
fn fence(family: &str, reference: &Value, device: &Value, fields: &[&str]) -> String {
    let mut row = json!({"family":family,"ref":reference});
    if let Some(v) = device.get("objectIdentity") {
        row["objectIdentity"] = v.clone()
    }
    row["state"] = state(fields, &device[row_key(family)]);
    js_json::stringify(&row)
}
impl McpHost {
    pub async fn dispatch_specialized_device_tool(
        &self,
        call: &ToolCall,
        signal: Option<&Signal>,
    ) -> Option<Result<Option<Value>, LiveError>> {
        let p = call.arguments.as_ref().unwrap_or(&Value::Null);
        Some(Ok(match call.name.as_str() {
            "live_device_specialized_preview" => Some(self.live_device_specialized_preview_async(&call.id, p).await),
            "live_device_specialized_apply" => self.live_device_specialized_apply_async(&call.id, p, signal).await,
            _ => return None,
        }))
    }
    pub async fn live_device_specialized_preview_async(&self, id: &Value, p: &Value) -> Value {
        let family = p["family"].as_str().unwrap_or("");
        let Some(fields) = family_fields(family).filter(|_| p.is_object() && is_non_empty_string(&p["deviceRef"], 256)) else {
            return error(id, -32602, "family and deviceRef are required", None);
        };
        let mut allowed = vec!["family", "deviceRef"];
        allowed.extend_from_slice(fields);
        if !has_only(p, &allowed) {
            return error(id, -32602, &format!("only {family} fields are accepted"), None);
        }
        if fields.iter().all(|f| p.get(*f).is_none()) {
            return error(id, -32602, "at least one field is required", None);
        }
        let result=async{
   let status=self.fresh_status(Some(&LiveOperationContext::with_deadline(self.deadline(AUDITION_DEADLINE_MS)))).await?;if !status.connected||!status.capabilities.iter().any(|c|c.as_str()=="session.read"){return Err(LiveError::error("session read capability is unavailable"))}let operation=format!("{family}.set");if !status.has_operation(&operation){return Err(LiveError::error(format!("{operation} is unavailable on this Live shape")))}let snapshot=self.views.view_for(None,&[p["deviceRef"].clone()],None,&[]).await?;let row=self.device_row(&snapshot,p["deviceRef"].as_str().unwrap())?;
   let mut proposed=json!({});for field in fields{let Some(value)=p.get(*field)else{continue};if ["oversample","monoPoly","isEditorOpen"].contains(field){if !value.is_boolean(){return Ok(error(id,-32602,&format!("{field} must be boolean"),None))}}else if ["irCategory","irFile"].contains(field){if !is_non_empty_string(value,256){return Ok(error(id,-32602,&format!("{field} is invalid"),None))}}else if !value.is_number(){return Ok(error(id,-32602,&format!("{field} must be a number"),None))}
    if let Some((low,high,integer))=bounds(field){if value.as_f64().is_some_and(|n|n<low||n>high||integer&&n.fract()!=0.){return Ok(error(id,-32602,&format!("{field} is out of bounds"),None))}}proposed[*field]=value.clone();}
   let family_row=&row.device[row_key(family)];if ["sample","wavetable"].contains(&family)&&!row.device[family].is_object(){return Ok(transaction_error(id,if family=="sample"{"that device isn't a Simpler with a sample"}else{"that device isn't a Wavetable"}))}
   let state=state(fields,family_row);let prior=Value::Object(proposed.as_object().unwrap().keys().map(|k|(k.clone(),family_row[k].clone())).collect());let mut payload=json!({"family":family,"ref":p["deviceRef"]});payload.as_object_mut().unwrap().extend(proposed.as_object().unwrap().clone());if let Some(v)=row.device.get("objectIdentity"){payload["expectedObjectIdentity"]=v.clone()}payload["expectedStateRevision"]=json!(digest(&state)?);
   let t=json!({"id":tempo::transaction_id("devspec"),"epoch":status.epoch,"kind":"device-specialized","fence":fence(family,&p["deviceRef"],&row.device,fields),"payload":payload,"prior":prior,"expiresAt":kumi_common::time::now_ms_f64()+TRANSACTION_TTL_MS,"state":"previewed"});self.retain_bounded_transaction(&self.clip_lifecycle_transactions,t.clone(),"specialized device")?;Ok(success_text(id,&json!({"transactionId":t["id"],"epoch":t["epoch"],"family":family,"deviceRef":p["deviceRef"],"prior":prior,"proposed":proposed,"impact":format!("edits-{family}"),"confirmation":"apply","expiresAt":t["expiresAt"]})))
  }.await;
        result.unwrap_or_else(|e| adapter_tool_error(id, &e, "Specialized-device preview requires fresh authoritative state."))
    }
    pub async fn live_device_specialized_apply_async(&self, id: &Value, p: &Value, signal: Option<&Signal>) -> Option<Value> {
        if !valid_transaction_params(p, "apply") {
            return Some(error(id, -32602, "transactionId, confirmation=apply, and idempotencyKey are required", None));
        }
        let record = self.clip_lifecycle_transactions.get(p["transactionId"].as_str().unwrap());
        let t = record.as_ref().map(|r| r.borrow().clone()).unwrap_or(Value::Null);
        if t["kind"] != "device-specialized"
            || (t["state"] == "previewed" && t["expiresAt"].as_f64().is_some_and(|n| n <= kumi_common::time::now_ms_f64()))
        {
            return Some(transaction_error(id, "Unknown or expired specialized-device transaction"));
        }
        let record = record.unwrap();
        if t["state"] == "applied" && t["applyKey"] == p["idempotencyKey"] {
            return Some(success_text(id, &json!({"transactionId":t["id"],"state":"applied","idempotent":true})));
        }
        let reconcile = t["state"] == "uncertain" && t["applyKey"] == p["idempotencyKey"];
        if t["state"] != "previewed" && !reconcile {
            return Some(transaction_error(id, "Transaction is no longer applicable"));
        }
        if signal.is_some_and(Signal::is_cancelled) {
            return None;
        }
        let result = async {
            if reconcile {
                self.fresh_status(Some(&LiveOperationContext::with_deadline(self.deadline(AUDITION_DEADLINE_MS)))).await?;
            }
            let status = self.require_connected(Some("session.read"))?;
            if json!(status.epoch) != t["epoch"] {
                return Ok(transaction_error(id, "Live connection epoch changed; preview again"));
            }
            let adapter = self.async_adapter();
            let context = self.transaction_context(p, signal, AUDITION_DEADLINE_MS);
            let family = t["payload"]["family"].as_str().unwrap_or("");
            let fields = family_fields(family).unwrap_or(&[]);
            let reference = t["payload"]["ref"].as_str().unwrap_or("");
            if !reconcile {
                let snapshot = self.views.view_for(Some(&context), &[t["payload"]["ref"].clone()], None, &[]).await?;
                let row = self.device_row(&snapshot, reference)?;
                if t["fence"] != fence(family, &t["payload"]["ref"], &row.device, fields) {
                    return Ok(transaction_error(id, "device identity or state changed since preview; preview again"));
                }
            }
            {
                let mut row = record.borrow_mut();
                row["state"] = json!("applying");
                row["applyKey"] = p["idempotencyKey"].clone()
            }
            let mut args = t["payload"].clone();
            args.as_object_mut().unwrap().remove("family");
            let result = adapter.invoke_async(&LiveInvocation::new(&format!("{family}.set"), args), Some(&context)).await?;
            if result.is_null() {
                return Err(LiveError::type_error("Cannot read properties of null (reading 'changed')"));
            }
            if result["changed"] != true {
                return Err(LiveError::error("specialized device change was not confirmed"));
            }
            let snapshot = self.views.view_for(Some(&context), &[t["payload"]["ref"].clone()], None, &[]).await?;
            let device = self.device_row(&snapshot, reference)?.device;
            let verified = &device[row_key(family)];
            for field in fields {
                if let Some(value) = t["payload"].get(*field) {
                    if !same_live_value(verified.get(*field), Some(value)) {
                        return Err(LiveError::error("specialized device postcondition was not confirmed"));
                    }
                }
            }
            {
                let mut row = record.borrow_mut();
                row["applyKey"] = p["idempotencyKey"].clone();
                row["state"] = json!("applied")
            }
            let mut response = json!({"transactionId":t["id"],"state":"applied"});
            if let Some(v) = result.get("revision") {
                response["revision"] = v.clone()
            }
            response["idempotent"] = json!(false);
            Ok(success_text(id, &response))
        }
        .await;
        Some(result.unwrap_or_else(|e| {
            record.borrow_mut()["state"] = json!("uncertain");
            adapter_tool_error(id, &e, "Specialized-device state is uncertain; perform fresh discovery before retrying.")
        }))
    }
    pub async fn undo_specialized_device_async(&self, id: &Value, p: &Value, signal: Option<&Signal>) -> Value {
        let record = p["transactionId"].as_str().and_then(|id| self.clip_lifecycle_transactions.get(id));
        let t = record.as_ref().map(|r| r.borrow().clone()).unwrap_or(Value::Null);
        if t["kind"] != "device-specialized" {
            return transaction_error(id, "Unknown or expired specialized-device transaction");
        }
        let record = record.unwrap();
        if t["state"] == "undone" && t["undoKey"] == p["idempotencyKey"] {
            return success_text(id, &json!({"transactionId":t["id"],"state":"undone","idempotent":true}));
        }
        let reconcile = t["state"] == "uncertain" && t["undoKey"] == p["idempotencyKey"];
        if (t["state"] != "applied" && !reconcile) || !truthy(&t["prior"]) {
            return transaction_error(id, "Only an applied or exact-key uncertain specialized-device transaction can be undone");
        }
        let result = async {
            self.begin_undo_recovery(&record, p["idempotencyKey"].as_str().unwrap_or(""))?;
            let status = self.require_connected(Some("session.read"))?;
            if json!(status.epoch) != t["epoch"] {
                return Ok(transaction_error(id, "Live connection epoch changed; undo refused"));
            }
            let adapter = self.async_adapter();
            let context = self.transaction_context(p, signal, AUDITION_DEADLINE_MS);
            record.borrow_mut()["undoKey"] = p["idempotencyKey"].clone();
            if reconcile {
                self.replay_undo_recovery(&record, adapter.as_ref(), &context).await?;
            }
            let family = t["payload"]["family"].as_str().unwrap_or("");
            let fields = family_fields(family).unwrap_or(&[]);
            let snapshot = self.views.view_for(Some(&context), &[t["payload"]["ref"].clone()], None, &[]).await?;
            let row = self.device_row(&snapshot, t["payload"]["ref"].as_str().unwrap_or(""))?;
            if let Some(moved) = self.undo_target_moved(
                id,
                &record.borrow(),
                "device",
                &t["payload"]["ref"],
                row.device.get("objectIdentity"),
                t["payload"].get("expectedObjectIdentity"),
            )? {
                return Ok(moved);
            }
            let current = &row.device[row_key(family)];
            if !reconcile {
                for field in fields {
                    if let Some(v) = t["payload"].get(*field) {
                        if !same_live_value(current.get(*field), Some(v)) {
                            return Ok(transaction_error(id, "device state changed after apply; undo refused"));
                        }
                    }
                }
            }
            record.borrow_mut()["state"] = json!("undoing");
            let mut args = json!({"ref":t["payload"]["ref"]});
            args.as_object_mut().unwrap().extend(t["prior"].as_object().unwrap().clone());
            if let Some(v) = row.device.get("objectIdentity") {
                args["expectedObjectIdentity"] = v.clone()
            }
            args["expectedStateRevision"] = json!(digest(&state(fields, current))?);
            let result = self.invoke_undo_recovery(&record, adapter.as_ref(), &format!("{family}.set"), &args, &context).await?;
            if result.is_null() {
                return Err(LiveError::type_error("Cannot read properties of null (reading 'changed')"));
            }
            if result["changed"] != true {
                return Err(LiveError::error("specialized device restoration was not confirmed"));
            }
            record.borrow_mut()["state"] = json!("undone");
            Ok(success_text(id, &json!({"transactionId":t["id"],"state":"undone","idempotent":false})))
        }
        .await;
        result.unwrap_or_else(|e| {
            record.borrow_mut()["state"] = json!("uncertain");
            adapter_tool_error(id, &e, "Specialized-device undo is uncertain; perform fresh discovery.")
        })
    }
}
