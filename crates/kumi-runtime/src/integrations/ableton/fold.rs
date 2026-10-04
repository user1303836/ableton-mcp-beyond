//! Bound the visible track list while retaining the tracks in focus.
use crate::core::contracts::JsonObject;
use kumi_common::js::{json::stringify, string::head};
use serde::{Deserialize, Serialize};
use serde_json::Value;
pub const OBSERVATION_TRACK_BYTES: usize = 12 * 1024;
pub const FOLDED_NOTE:&str="A big Set: only the tracks in focus (selected in Live, pinned, or changed lately) list their devices; each other track is one line: \"ref name (type, in its group) · its first devices +how many more\" (or \"· N devices\"). For another track's devices, discover kind device with parent that track's ref.";
fn string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|v| if v.is_null() { String::new() } else { string(v) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        v => stringify(v),
    }
}
fn field(track: &JsonObject, name: &str, default: &str) -> String {
    track.get(name).filter(|v| !v.is_null()).map(string).unwrap_or(default.into())
}
fn devices(track: &JsonObject) -> &[Value] {
    track.get("devices").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
pub fn track_line(track: &JsonObject, names: bool) -> String {
    let mut location = vec![];
    if let Some(t) = track.get("type").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        location.push(t.to_owned());
    }
    if let Some(group) = track.get("group").and_then(Value::as_str) {
        location.push(format!("in {group}"));
    }
    let devices = devices(track);
    let list = if devices.is_empty() {
        String::new()
    } else if names {
        let first = devices
            .iter()
            .take(2)
            .map(|d| head(&d.get("name").filter(|v| !v.is_null()).map(string).unwrap_or("?".into()), 40))
            .collect::<Vec<_>>()
            .join(", ");
        format!(" · {first}{}", if devices.len() > 2 { format!(" +{}", devices.len() - 2) } else { String::new() })
    } else {
        format!(" · {} device{}", devices.len(), if devices.len() == 1 { "" } else { "s" })
    };
    format!(
        "{} {}{}{list}",
        field(track, "ref", "?"),
        head(&field(track, "name", "(unnamed)"), 60),
        if location.is_empty() { String::new() } else { format!(" ({})", location.join(", ")) }
    )
}
fn chains_counted(track: &JsonObject) -> JsonObject {
    let mut out = track.clone();
    if track.get("devices").is_some_and(Value::is_array) {
        out.insert(
            "devices".into(),
            Value::Array(
                devices(track)
                    .iter()
                    .map(|device| {
                        if let Some(chains) = device.get("chains").and_then(Value::as_array) {
                            let mut d = device.as_object().cloned().unwrap_or_default();
                            d.insert(
                                "chains".into(),
                                Value::Array(chains.iter().map(|c| c.get("name").cloned().unwrap_or(Value::Null)).collect()),
                            );
                            Value::Object(d)
                        } else {
                            device.clone()
                        }
                    })
                    .collect(),
            ),
        );
    }
    out
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoldedTracks {
    pub tracks: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folded: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub more_tracks: Option<String>,
}
pub fn fold_tracks(tracks: &[JsonObject], in_focus: impl Fn(&JsonObject) -> bool, budget: Option<usize>) -> FoldedTracks {
    let budget = budget.unwrap_or(OBSERVATION_TRACK_BYTES);
    let all: Vec<_> = tracks.iter().cloned().map(Value::Object).collect();
    let size = |rows: &Vec<Value>| stringify(&Value::Array(rows.clone())).len();
    if size(&all) <= budget {
        return FoldedTracks { tracks: all, folded: None, more_tracks: None };
    }
    let focus: Vec<_> = tracks.iter().map(in_focus).collect();
    for step in 0..3 {
        let rows = tracks
            .iter()
            .enumerate()
            .map(|(i, track)| match (step, focus[i]) {
                (0, false) | (2, true) => Value::Object(chains_counted(track)),
                (_, true) => Value::Object(track.clone()),
                (_, false) => Value::String(track_line(track, step == 1)),
            })
            .collect::<Vec<_>>();
        if size(&rows) <= budget {
            return FoldedTracks { tracks: rows, folded: Some(FOLDED_NOTE.into()), more_tracks: None };
        }
    }
    let mut kept = vec![];
    let mut used = 2;
    let mut left = 0;
    for (i, track) in tracks.iter().enumerate() {
        let row = if focus[i] { Value::Object(chains_counted(track)) } else { Value::String(track_line(track, false)) };
        let cost = stringify(&row).len() + 1;
        if focus[i] || used + cost <= budget {
            kept.push(row);
            used += cost;
        } else {
            left += 1;
        }
    }
    FoldedTracks {
        tracks: kept,
        folded: Some(FOLDED_NOTE.into()),
        more_tracks: (left > 0).then(|| format!("{left} more tracks aren't listed; discover kind track (with cursor) for them")),
    }
}
