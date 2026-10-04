//! Current-turn reference authority, short names, and discovery cursor bindings.
use super::{
    changes::{hex_color, KnownTrack, REFERENCE_FIELDS},
    context::{payload, query_key, ObservationError, PARENTS},
};
use crate::{
    core::contracts::{JsonObject, ToolResult},
    mcp::types::CallToolResult,
};
use indexmap::IndexMap;
use kumi_common::js::{
    json::stringify,
    string::{head, utf16_len},
};
use regex::Regex;
use serde_json::{json, Value};
use std::sync::LazyLock;
#[derive(Default)]
pub struct References {
    pub refs: IndexMap<String, String>,
    pub cursors: IndexMap<String, String>,
    pub known: IndexMap<String, KnownTrack>,
    short: IndexMap<String, String>,
    long: IndexMap<String, String>,
    counts: IndexMap<String, u64>,
}
/// Overflow also requires the owner to invalidate its observation lease.
#[derive(Debug, Clone)]
pub struct ReferenceError {
    pub error: ObservationError,
    pub invalidate: bool,
}
impl From<ObservationError> for ReferenceError {
    fn from(error: ObservationError) -> Self {
        Self { error, invalidate: false }
    }
}
impl std::fmt::Display for ReferenceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(f)
    }
}
impl std::error::Error for ReferenceError {}
fn error(message: impl Into<String>) -> ObservationError {
    ObservationError(message.into())
}
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(v)) => v.clone(),
        Some(Value::Array(v)) => {
            v.iter().map(|v| if v.is_null() { String::new() } else { js_string(Some(v)) }).collect::<Vec<_>>().join(",")
        }
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(value) => stringify(value),
    }
}
fn ref_key(key: &str) -> bool {
    key == "ref" || key == "parent" || key.ends_with("Ref") || key.ends_with("Refs")
}
impl References {
    /// Retired names never acquire a different object; counters continue across retirement.
    pub fn clear_names(&mut self) {
        self.short.clear();
        self.long.clear();
    }
    pub fn unname(&mut self, reference: &str) {
        if let Some(short) = self.short.shift_remove(reference) {
            self.long.shift_remove(&short);
        }
    }
    pub fn retire(&mut self, reference: &str) {
        self.refs.shift_remove(reference);
        self.known.shift_remove(reference);
        self.unname(reference);
    }
    pub fn named_references(&self) -> Vec<String> {
        self.short.keys().cloned().collect()
    }
    pub fn invalidate(&mut self) {
        self.refs.clear();
        self.cursors.clear();
        self.known.clear();
    }
    pub fn register_rows(
        &mut self,
        kind: &str,
        rows: &[JsonObject],
        args: &JsonObject,
        next_cursor: Option<&str>,
    ) -> Result<(), ReferenceError> {
        for row in rows {
            if args.contains_key("parent") && !same_primitive(row.get("parentRef"), args.get("parent")) {
                return Err(error("Discovery returned a different parent; result discarded").into());
            }
            if let Some(reference) = row.get("ref").and_then(Value::as_str).filter(|s| !s.is_empty() && utf16_len(s) <= 256) {
                self.refs.insert(reference.into(), kind.into());
                if kind == "clip-slot" {
                    if let Some(clip) = row.get("clipRef").and_then(Value::as_str).filter(|s| utf16_len(s) <= 256) {
                        self.refs.insert(clip.into(), "session-clip".into());
                    }
                }
                if kind == "device" {
                    if let Some(chains) = row.get("chainList").and_then(Value::as_array) {
                        for chain in chains {
                            if let Some(reference) = chain.get("ref").and_then(Value::as_str).filter(|s| utf16_len(s) <= 256) {
                                self.refs.insert(reference.into(), "chain".into());
                            }
                        }
                    }
                }
                if kind.ends_with("track") {
                    if let Some(name) = row.get("name").and_then(Value::as_str) {
                        self.known
                            .insert(reference.into(), KnownTrack { name: head(name, 256), color: row.get("color").and_then(hex_color) });
                    }
                }
            }
        }
        if self.refs.len() > 1_000_000 {
            self.invalidate();
            return Err(ReferenceError { error: error("Too many current references; refresh and narrow the request"), invalidate: true });
        }
        if let Some(cursor) = next_cursor.filter(|s| !s.is_empty()) {
            if args.get("cursor").and_then(Value::as_str) == Some(cursor) {
                return Err(error("Discovery cursor repeated; narrow the request").into());
            }
            self.cursors.insert(cursor.into(), query_key(args));
            if self.cursors.len() > 100_000 {
                self.invalidate();
                return Err(ReferenceError { error: error("Too many page cursors; refresh and narrow the request"), invalidate: true });
            }
        }
        Ok(())
    }
    pub fn validate_parent_and_cursor(&self, args: &JsonObject) -> Result<(), ObservationError> {
        let kind = js_string(args.get("kind"));
        let parent_kinds = PARENTS.get(&kind).and_then(Value::as_array);
        if parent_kinds.is_some() || args.contains_key("parent") {
            let parent = args.get("parent").and_then(Value::as_str).and_then(|s| self.refs.get(s));
            let takes = parent_kinds.map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_else(|| vec!["set"]);
            let parent = parent.ok_or_else(|| {
                if !args.contains_key("parent") {
                    error(format!("{kind} needs a parent: a {} from this turn", takes.join(" or ")))
                } else {
                    error("A fresh authoritative parent is required; discover the parent in this turn, not from history")
                }
            })?;
            if !takes.contains(&parent.as_str()) {
                return Err(error(format!(
                    "{kind} takes a {} as its parent, not a {parent}{}",
                    takes.join(" or "),
                    if kind == "session-clip" && parent == "track" {
                        ": discover the track's clip-slots, each gives its clipRef"
                    } else {
                        ""
                    }
                )));
            }
        }
        if let Some(cursor) = args.get("cursor") {
            if cursor.as_str().and_then(|s| self.cursors.get(s)) != Some(&query_key(args)) {
                return Err(error("Cursor is stale or belongs to another query; rediscover without it"));
            }
        }
        Ok(())
    }
    pub fn short_ref(&mut self, reference: &str) -> String {
        static LIVE_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9]+:([a-z][a-z_]{0,31}):").unwrap());
        let Some(captures) = LIVE_REF.captures(reference) else { return reference.into() };
        if let Some(name) = self.short.get(reference) {
            return name.clone();
        }
        if self.short.len() >= 10_000_000 {
            self.short.clear();
            self.long.clear();
        }
        let kind = &captures[1];
        let count = self.counts.entry(kind.into()).or_insert(0);
        *count += 1;
        let name = format!("{kind}:{count}");
        self.short.insert(reference.into(), name.clone());
        self.long.insert(name.clone(), reference.into());
        name
    }
    pub fn shorten(&mut self, value: &Value) -> Value {
        self.shorten_at(value, "", 0)
    }
    fn shorten_at(&mut self, value: &Value, key: &str, depth: usize) -> Value {
        if depth > 32 {
            return value.clone();
        }
        match value {
            Value::String(s) if ref_key(key) => json!(self.short_ref(s)),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.shorten_at(v, key, depth + 1)).collect()),
            Value::Object(row) => {
                Value::Object(row.iter().map(|(key, value)| (key.clone(), self.shorten_at(value, key, depth + 1))).collect())
            }
            _ => value.clone(),
        }
    }
    pub fn lengthen(&self, value: &Value) -> Value {
        self.lengthen_at(value, "", 0)
    }
    fn lengthen_at(&self, value: &Value, key: &str, depth: usize) -> Value {
        if depth > 32 {
            return value.clone();
        }
        match value {
            Value::String(s) if ref_key(key) => json!(self.long.get(s).unwrap_or(s)),
            Value::Array(items) => Value::Array(items.iter().map(|v| self.lengthen_at(v, key, depth + 1)).collect()),
            Value::Object(row) => {
                Value::Object(row.iter().map(|(key, value)| (key.clone(), self.lengthen_at(value, key, depth + 1))).collect())
            }
            _ => value.clone(),
        }
    }
    pub fn require_fresh_references(&self, args: &JsonObject) -> Result<(), ObservationError> {
        self.require_at(args, 0)
    }
    fn require_at(&self, args: &JsonObject, depth: usize) -> Result<(), ObservationError> {
        for field in REFERENCE_FIELDS.iter() {
            if let Some(value) = args.get(field) {
                if !value.as_str().is_some_and(|s| self.refs.contains_key(s)) {
                    return Err(error(format!(
                        "{field} must come from discovery in this turn; discover it again{}",
                        if field == "parameterRef" {
                            " (or name the parameter instead, with parameter \"Filter Freq\", and the device's deviceRef from this turn's observation)"
                        } else {
                            ""
                        }
                    )));
                }
            }
        }
        if depth < 2 {
            for value in args.values() {
                if let Some(items) = value.as_array() {
                    for item in items {
                        if let Some(row) = item.as_object() {
                            self.require_at(row, depth + 1)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    pub fn encode(&mut self, result: &CallToolResult, epoch: f64, slim: bool, observed_at: &str, generation: &str) -> ToolResult {
        if result.is_error == Some(true) {
            return ToolResult::error(stringify(&serde_json::to_value(result).unwrap()));
        }
        let mut live = payload(result).map(Value::Object).unwrap_or_else(|_| serde_json::to_value(result).unwrap());
        if slim {
            if let Some(row) = live.as_object() {
                live = Value::Object(slim_mixers(row));
            }
        }
        let text = stringify(
            &json!({"live":self.shorten(&live),"observation":{"observedAt":observed_at,"connectionGeneration":generation,"epoch":epoch,"coverage":"Bounded read; preserve truncated/nextCursor markers. Traversal completeness is not established."}}),
        );
        if text.len() > 64 * 1024 {
            ToolResult::error("Result too large; narrow fields/parent/page.")
        } else {
            ToolResult::text(text)
        }
    }
}
pub fn slim_mixers(content: &JsonObject) -> JsonObject {
    let Some(items) = content.get("items").and_then(Value::as_array) else { return content.clone() };
    if !items.iter().any(|v| v.as_object().is_some_and(|r| r.contains_key("mixer"))) {
        return content.clone();
    }
    let keep = ["volume", "pan", "mute", "solo", "cueVolume", "sends", "volumeDisplay", "panDisplay", "cueVolumeDisplay", "sendDisplays"];
    let items: Vec<_> = items
        .iter()
        .map(|item| {
            let Some(row) = item.as_object() else { return item.clone() };
            let Some(mixer) = row.get("mixer").filter(|v| v.is_object() || v.is_array()) else { return item.clone() };
            let mut row = row.clone();
            row.insert(
                "mixer".into(),
                Value::Object(
                    mixer
                        .as_object()
                        .map(|m| m.iter().filter(|(key, _)| keep.contains(&key.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect())
                        .unwrap_or_default(),
                ),
            );
            Value::Object(row)
        })
        .collect();
    let mut result = content.clone();
    result.insert("items".into(), json!(items));
    result
}

fn same_primitive(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        _ => false,
    }
}
