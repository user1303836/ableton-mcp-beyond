//! Path substitution for cross-platform source fixtures. This changes only test data.
#![allow(dead_code)] // Each independent integration-test executable uses a subset.
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Transform decoded strings, including complete JSON objects/arrays carried inside MCP text.
/// Unchanged embedded JSON retains its original bytes and formatting.
pub fn map_strings(value: &Value, transform: &impl Fn(&str) -> String) -> Value {
    match value {
        Value::String(text) => {
            if let Ok(inner @ (Value::Object(_) | Value::Array(_))) = serde_json::from_str::<Value>(text) {
                let mapped = map_strings(&inner, transform);
                if mapped != inner {
                    return Value::String(kumi_common::js::json::stringify(&mapped));
                }
            }
            Value::String(transform(text))
        }
        Value::Array(values) => Value::Array(values.iter().map(|value| map_strings(value, transform)).collect()),
        Value::Object(values) => Value::Object(values.iter().map(|(key, value)| (key.clone(), map_strings(value, transform))).collect()),
        value => value.clone(),
    }
}

fn without_verbatim(path: &str) -> String {
    path.strip_prefix(r"\\?\UNC\")
        .map(|path| format!(r"\\{path}"))
        .or_else(|| path.strip_prefix(r"\\?\").map(str::to_owned))
        .unwrap_or_else(|| path.to_owned())
}

/// Node realpath returns an ordinary Windows path; Rust canonicalize adds a verbatim prefix.
pub fn native_path(path: &Path) -> PathBuf {
    PathBuf::from(without_verbatim(&path.to_string_lossy()))
}

/// Collapse only a known fixture root and its path separators. Backslashes outside the
/// identified path (for example a quoted error's surrounding text) are left intact.
pub fn normalize_root(text: &str, root: &str, marker: &str) -> String {
    if root.is_empty() {
        return text.to_owned();
    }
    let plain = without_verbatim(root);
    let windows = plain.contains('\\') || (plain.as_bytes().get(1) == Some(&b':') && plain.as_bytes()[0].is_ascii_alphabetic());
    let mut output = text.to_owned();
    // A caller may use Node's plain root while a Rust result carries canonicalize's prefix.
    if windows {
        let backslashes = plain.replace('/', "\\");
        let verbatim =
            if let Some(unc) = backslashes.strip_prefix(r"\\") { format!(r"\\?\UNC\{unc}") } else { format!(r"\\?\{backslashes}") };
        output = output.replace(&verbatim, marker);
    }
    output = output.replace(root, marker);
    if plain != root {
        output = output.replace(&plain, marker);
    }
    if !windows {
        return output;
    }
    output = output.replace(&plain.replace('/', "\\"), marker);
    output = output.replace(&plain.replace('\\', "/"), marker);
    let mut normalized = String::new();
    let mut rest = output.as_str();
    while let Some(index) = rest.find(marker) {
        let end = index + marker.len();
        normalized.push_str(&rest[..end]);
        rest = &rest[end..];
        let end = rest.find(['\'', '"', '\n', '\r', '\0']).unwrap_or(rest.len());
        normalized.push_str(&rest[..end].replace('\\', "/"));
        rest = &rest[end..];
    }
    normalized.push_str(rest);
    normalized
}
