//! JavaScript's ways with values, where Kumi's files, hashes and messages depend on them:
//! `JSON.stringify` (numbers as `Number.prototype.toString` writes them, integer-like keys first),
//! and strings measured in UTF-16 code units as `.length` and `.slice()` measure them.

pub mod json {
    use serde_json::Value;

    /// `JSON.stringify(value)`: no spaces, JavaScript's number formatting and key order.
    pub fn stringify(value: &Value) -> String {
        let mut out = String::new();
        write(value, &mut out, None, 0);
        out
    }

    /// `JSON.stringify(value, null, indent)`.
    pub fn stringify_pretty(value: &Value, indent: usize) -> String {
        if indent == 0 {
            return stringify(value);
        }
        stringify_with_indent(value, &" ".repeat(indent.min(10)))
    }

    /// `JSON.stringify(value, null, "\t")`: an indent given as text (JavaScript keeps its first ten characters).
    pub fn stringify_with_indent(value: &Value, indent: &str) -> String {
        let unit: String = indent.chars().take(10).collect();
        if unit.is_empty() {
            return stringify(value);
        }
        let mut out = String::new();
        write(value, &mut out, Some(&unit), 0);
        out
    }

    /// `JSON.stringify(value, null, 2)` with a trailing newline: how Kumi writes its files.
    pub fn file_text(value: &Value) -> String {
        let mut text = stringify_pretty(value, 2);
        text.push('\n');
        text
    }

    /// `Buffer.byteLength(JSON.stringify(value))`.
    pub fn byte_length(value: &Value) -> usize {
        stringify(value).len()
    }

    fn write(value: &Value, out: &mut String, indent: Option<&str>, depth: usize) {
        match value {
            Value::Null => out.push_str("null"),
            Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Value::Number(n) => out.push_str(&number(n)),
            Value::String(s) => escape(s, out),
            Value::Array(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, indent, depth + 1);
                    write(item, out, indent, depth + 1);
                }
                newline(out, indent, depth);
                out.push(']');
            }
            Value::Object(map) => {
                if map.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                let mut first = true;
                for key in ordered_keys(map) {
                    if !first {
                        out.push(',');
                    }
                    first = false;
                    newline(out, indent, depth + 1);
                    escape(key, out);
                    out.push(':');
                    if indent.is_some() {
                        out.push(' ');
                    }
                    write(&map[key], out, indent, depth + 1);
                }
                newline(out, indent, depth);
                out.push('}');
            }
        }
    }

    fn newline(out: &mut String, indent: Option<&str>, depth: usize) {
        if let Some(unit) = indent {
            out.push('\n');
            for _ in 0..depth {
                out.push_str(unit);
            }
        }
    }

    /// JavaScript lists an object's integer-like keys first, ascending, then the rest in insertion order.
    fn ordered_keys(map: &serde_json::Map<String, Value>) -> Vec<&String> {
        let mut indices: Vec<(u32, &String)> = Vec::new();
        let mut rest: Vec<&String> = Vec::new();
        for key in map.keys() {
            match array_index(key) {
                Some(index) => indices.push((index, key)),
                None => rest.push(key),
            }
        }
        if indices.is_empty() {
            return rest;
        }
        indices.sort_by_key(|(index, _)| *index);
        indices.into_iter().map(|(_, key)| key).chain(rest).collect()
    }

    /// A canonical array index: "0", or digits without a leading zero, below 2^32 − 1.
    fn array_index(key: &str) -> Option<u32> {
        if key == "0" {
            return Some(0);
        }
        if key.is_empty() || key.starts_with('0') || !key.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        key.parse::<u32>().ok().filter(|index| *index < u32::MAX)
    }

    /// A number as `JSON.stringify` writes it: `Number.prototype.toString`, or `null` when not finite.
    pub fn number(n: &serde_json::Number) -> String {
        if let Some(i) = n.as_i64() {
            return i.to_string();
        }
        if let Some(u) = n.as_u64() {
            return u.to_string();
        }
        match n.as_f64() {
            Some(f) if f.is_finite() => super::number::to_string(f),
            _ => "null".to_string(),
        }
    }

    /// A string as `JSON.stringify` writes it, quotes included.
    pub fn escape(s: &str, out: &mut String) {
        out.push('"');
        for ch in s.chars() {
            match ch {
                '"' => out.push_str("\\\""),
                '\\' => out.push_str("\\\\"),
                '\u{8}' => out.push_str("\\b"),
                '\u{c}' => out.push_str("\\f"),
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                c => out.push(c),
            }
        }
        out.push('"');
    }

    /// `JSON.stringify(text)`: a string, quoted and escaped.
    pub fn quote(text: &str) -> String {
        let mut out = String::with_capacity(text.len() + 2);
        escape(text, &mut out);
        out
    }
}

pub mod number {
    /// `Number.prototype.toString()` for radix 10 (ECMA-262 Number::toString).
    pub fn to_string(value: f64) -> String {
        if value.is_nan() {
            return "NaN".into();
        }
        if value == 0.0 {
            return "0".into();
        }
        if value.is_infinite() {
            return if value > 0.0 { "Infinity".into() } else { "-Infinity".into() };
        }
        let negative = value < 0.0;
        let magnitude = value.abs();
        // Rust's `{:e}` is the shortest round-tripping representation: "d.ddddde±x".
        let formatted = format!("{magnitude:e}");
        let (mantissa, exponent) = formatted.split_once('e').expect("exponent form");
        let exponent: i32 = exponent.parse().expect("exponent");
        let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
        let digits = digits.trim_end_matches('0');
        let digits = if digits.is_empty() { "0" } else { digits };
        let k = digits.len() as i32;
        let n = exponent + 1;
        let mut out = String::new();
        if negative {
            out.push('-');
        }
        if k <= n && n <= 21 {
            out.push_str(digits);
            for _ in 0..(n - k) {
                out.push('0');
            }
        } else if 0 < n && n <= 21 {
            out.push_str(&digits[..n as usize]);
            out.push('.');
            out.push_str(&digits[n as usize..]);
        } else if -6 < n && n <= 0 {
            out.push_str("0.");
            for _ in 0..(-n) {
                out.push('0');
            }
            out.push_str(digits);
        } else {
            let e = n - 1;
            let sign = if e < 0 { '-' } else { '+' };
            out.push_str(&digits[..1]);
            if k > 1 {
                out.push('.');
                out.push_str(&digits[1..]);
            }
            out.push('e');
            out.push(sign);
            out.push_str(&e.abs().to_string());
        }
        out
    }

    /// `Number(text)` for the common case: a finite decimal, or None (NaN) when it isn't one.
    pub fn parse(text: &str) -> Option<f64> {
        let trimmed = super::string::trim(text);
        if trimmed.is_empty() {
            return Some(0.0);
        }
        if let Some((digits, width)) = trimmed
            .strip_prefix("0x")
            .or_else(|| trimmed.strip_prefix("0X"))
            .map(|v| (v, 4))
            .or_else(|| trimmed.strip_prefix("0o").or_else(|| trimmed.strip_prefix("0O")).map(|v| (v, 3)))
            .or_else(|| trimmed.strip_prefix("0b").or_else(|| trimmed.strip_prefix("0B")).map(|v| (v, 1)))
        {
            if digits.is_empty() {
                return None;
            }
            let mut bits = Vec::with_capacity(digits.len().saturating_mul(width));
            for digit in digits.chars() {
                let value = digit.to_digit(1 << width)?;
                for bit in (0..width).rev() {
                    bits.push((value >> bit) & 1);
                }
            }
            let first = bits.iter().position(|bit| *bit != 0).unwrap_or(bits.len());
            let bits = &bits[first..];
            if bits.len() > 1024 {
                return Some(f64::INFINITY);
            }
            let mut mantissa = bits.iter().take(53).fold(0_u64, |n, bit| (n << 1) | *bit as u64);
            if bits.len() > 53 && bits[53] == 1 && (mantissa & 1 != 0 || bits[54..].contains(&1)) {
                mantissa += 1;
            }
            return Some(mantissa as f64 * 2.0_f64.powi(bits.len().saturating_sub(53) as i32));
        }
        match trimmed {
            "Infinity" | "+Infinity" => return Some(f64::INFINITY),
            "-Infinity" => return Some(f64::NEG_INFINITY),
            _ => {}
        }
        if trimmed.chars().any(|c| !(c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))) {
            return None;
        }
        trimmed.parse::<f64>().ok()
    }

    /// `Number.isSafeInteger(value)`.
    pub fn is_safe_integer(value: f64) -> bool {
        value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
    }

    /// `value.toFixed(digits)`.
    pub fn to_fixed(value: f64, digits: usize) -> String {
        if !value.is_finite() || value.abs() >= 1e21 {
            return to_string(value);
        }
        // ECMA-262 Number.prototype.toFixed: on the exact value of the double, the nearest n / 10^digits,
        // the larger n when two are equally near (a tie rounds up, not to even as Rust's `{:.N}` does), and
        // a "-" kept whenever the value was negative ("-0.00" for -0.001; "0.00" for -0).
        let negative = value < 0.0;
        // Rust prints the exact decimal expansion when asked for enough places (a double has at most 1074).
        let exact = format!("{:.1100}", value.abs());
        let (whole, fraction) = exact.split_once('.').expect("a decimal point");
        let mut kept: Vec<u8> = whole.bytes().chain(fraction.bytes().take(digits)).collect();
        let rest = &fraction.as_bytes()[digits..];
        let round_up = rest.first().is_some_and(|&first| first >= b'5');
        if round_up {
            let mut index = kept.len();
            loop {
                if index == 0 {
                    kept.insert(0, b'1');
                    break;
                }
                index -= 1;
                if kept[index] == b'9' {
                    kept[index] = b'0';
                } else {
                    kept[index] += 1;
                    break;
                }
            }
        }
        let split = kept.len() - digits;
        let mut out = String::with_capacity(kept.len() + 2);
        if negative {
            out.push('-');
        }
        out.push_str(std::str::from_utf8(&kept[..split]).expect("digits"));
        if digits > 0 {
            out.push('.');
            out.push_str(std::str::from_utf8(&kept[split..]).expect("digits"));
        }
        out
    }

    /// `Math.round(value)`: halves round toward +∞, as JavaScript rounds.
    pub fn round(value: f64) -> f64 {
        // The integer nearest `value`, the one toward +∞ when two are equally near; exact, so that
        // 0.49999999999999994 rounds to 0 (floor(value + 0.5) would carry it to 1).
        if !value.is_finite() {
            return value;
        }
        let floor = value.floor();
        if value - floor >= 0.5 {
            floor + 1.0
        } else {
            floor
        }
    }
}

pub mod string {
    pub use crate::locale::{default_locale, locale_compare, locale_compare_numeric_base};
    /// `text.length`: UTF-16 code units.
    pub fn utf16_len(text: &str) -> usize {
        text.encode_utf16().count()
    }

    /// `Buffer.byteLength(text)`: UTF-8 bytes.
    pub fn byte_length(text: &str) -> usize {
        text.len()
    }

    /// `text.slice(start, end)` in UTF-16 code units (negative indices count from the end).
    /// A split surrogate becomes U+FFFD, matching Node's UTF-8 encoding of the sliced string.
    /// Rust strings cannot retain an unpaired surrogate for later JSON `\uDxxx` serialization.
    pub fn slice(text: &str, start: i64, end: Option<i64>) -> String {
        let units: Vec<u16> = text.encode_utf16().collect();
        let len = units.len() as i64;
        let clamp = |i: i64| if i < 0 { (len + i).max(0) } else { i.min(len) };
        let from = clamp(start);
        let to = end.map(clamp).unwrap_or(len);
        if to <= from {
            return String::new();
        }
        String::from_utf16_lossy(&units[from as usize..to as usize])
    }

    /// `text.slice(0, max)`, for bounding what's shown or kept.
    pub fn head(text: &str, max: usize) -> String {
        slice(text, 0, Some(max as i64))
    }

    /// `text.trim()`: JavaScript's white space and line terminators, U+FEFF included.
    pub fn trim(text: &str) -> &str {
        text.trim_matches(is_js_whitespace)
    }

    pub fn trim_start(text: &str) -> &str {
        text.trim_start_matches(is_js_whitespace)
    }

    pub fn trim_end(text: &str) -> &str {
        text.trim_end_matches(is_js_whitespace)
    }

    fn is_js_whitespace(c: char) -> bool {
        matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    }

    /// `text.padEnd(width)` in UTF-16 code units.
    pub fn pad_end(text: &str, width: usize) -> String {
        let mut out = text.to_string();
        for _ in utf16_len(text)..width {
            out.push(' ');
        }
        out
    }

    /// `text.padStart(width, fill)` in UTF-16 code units, with a one-character fill.
    pub fn pad_start(text: &str, width: usize, fill: char) -> String {
        let mut out = String::new();
        for _ in utf16_len(text)..width {
            out.push(fill);
        }
        out.push_str(text);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_parsing_matches_javascript_whitespace_and_radix_rounding() {
        let cases: serde_json::Value = serde_json::from_str(include_str!("../tests/number-oracle.json")).unwrap();
        for case in cases.as_array().unwrap() {
            let actual = number::parse(case["text"].as_str().unwrap()).unwrap_or(f64::NAN);
            if let Some(expected) = case["value"].as_f64() {
                assert_eq!(actual, expected, "{case}");
            } else {
                assert_eq!(number::to_string(actual), case["value"], "{case}");
            }
        }
    }

    #[test]
    fn numbers_print_as_javascript_does() {
        for (value, expected) in [
            (1.0, "1"),
            (-1.0, "-1"),
            (0.5, "0.5"),
            (123.456, "123.456"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1.5e-7, "1.5e-7"),
            (0.1 + 0.2, "0.30000000000000004"),
            (120.0, "120"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (-0.0, "0"),
            (1234.5e-10, "1.2345e-7"),
            (9007199254740993.0, "9007199254740992"),
        ] {
            assert_eq!(number::to_string(value), expected, "{value}");
        }
    }

    #[test]
    fn stringify_matches_json_stringify() {
        let value = json!({"b": 1.0, "2": [true, null, "x\n\"\u{1}"], "1": {"nested": 1.5}, "a": 1e21, "e": [], "o": {}});
        assert_eq!(json::stringify(&value), r#"{"1":{"nested":1.5},"2":[true,null,"x\n\"\u0001"],"b":1,"a":1e+21,"e":[],"o":{}}"#);
        assert_eq!(
            json::stringify_pretty(&json!({"a": [1, {"b": 2}], "c": {}}), 2),
            "{\n  \"a\": [\n    1,\n    {\n      \"b\": 2\n    }\n  ],\n  \"c\": {}\n}"
        );
        assert_eq!(json::stringify(&json!(f64::NAN)), "null");
        assert_eq!(json::quote("hi"), "\"hi\"");
        assert_eq!(json::stringify_with_indent(&json!({"a": [1]}), "\t"), "{\n\t\"a\": [\n\t\t1\n\t]\n}");
    }

    #[test]
    fn strings_measure_in_utf16() {
        assert_eq!(string::utf16_len("a😀b"), 4);
        assert_eq!(string::slice("a😀b", 1, Some(3)), "😀");
        assert_eq!(string::slice("a😀b", 1, Some(2)), "�");
        assert_eq!(string::slice("a😀b", 2, Some(3)), "�");
        assert_eq!(string::slice("a😀b", 2, None), "�b");
        assert_eq!(string::slice("😀😁", 1, Some(3)), "��");
        assert_eq!(string::slice("a😀b", -2, None), "�b");
        assert_eq!(string::head("a😀b", 2), "a�");
        assert_eq!(string::slice("hello", -3, None), "llo");
        assert_eq!(string::head("hello", 2), "he");
        assert_eq!(string::trim("\u{FEFF} x \n"), "x");
        assert_eq!(string::trim("\u{0085}x\u{0085}"), "\u{0085}x\u{0085}");
        assert_eq!(string::trim("\u{2028}x\u{3000}"), "x");
        assert_eq!(string::pad_end("ab", 4), "ab  ");
        assert_eq!(string::pad_start("7", 3, '0'), "007");
    }

    #[test]
    fn number_helpers() {
        // Node's answers: ties on the exact double round up, and a negative value keeps its sign.
        for (value, digits, expected) in [
            (0.0078125, 6, "0.007813"),
            (2.5, 0, "3"),
            (0.25, 1, "0.3"),
            (-0.001, 2, "-0.00"),
            (-0.0, 2, "0.00"),
            (1.005, 2, "1.00"),
            (-2.5, 0, "-3"),
            (1.45, 1, "1.4"),
            (0.5, 0, "1"),
            (1.5, 0, "2"),
            (-1.5, 0, "-2"),
            (123.456, 2, "123.46"),
            (0.000001, 5, "0.00000"),
            (9.995, 2, "9.99"),
            (0.1, 20, "0.10000000000000000555"),
            (1e20, 2, "100000000000000000000.00"),
            (5e-324, 3, "0.000"),
            (0.615, 2, "0.61"),
            (10.235, 2, "10.23"),
            (-0.5, 0, "-1"),
            (1.0000000000000002, 15, "1.000000000000000"),
            (999.9999, 3, "1000.000"),
            (0.0, 0, "0"),
            (12345.6789, 0, "12346"),
            (0.9999, 3, "1.000"),
            (9.9999, 3, "10.000"),
            (1e21, 2, "1e+21"),
            (f64::NAN, 2, "NaN"),
        ] {
            assert_eq!(number::to_fixed(value, digits), expected, "({value}).toFixed({digits})");
        }
        for (value, expected) in
            [(0.49999999999999994, 0.0), (2.5, 3.0), (-2.5, -2.0), (-0.4, 0.0), (1e16 + 1.0, 1e16), (-0.5, 0.0), (0.5, 1.0)]
        {
            assert_eq!(number::round(value), expected, "Math.round({value})");
        }
        assert!(number::is_safe_integer(3.0));
        assert!(!number::is_safe_integer(3.5));
        assert_eq!(number::parse(" 12 "), Some(12.0));
        assert_eq!(number::parse("12px"), None);
        assert_eq!(number::parse(""), Some(0.0));
    }
}
