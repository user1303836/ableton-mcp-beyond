//! Pure focus and change pictures used by the full-screen app.
use crate::tui::{
    style::{hex, palette, ColorDepth, Rgb, Style},
    width::{text_width, truncate},
    wrap::Span,
};
use kumi_common::js::{number, string};
use kumi_runtime::{core::contracts::*, integrations::ableton::project::since};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::LazyLock};

pub fn is_command(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('/') else { return false };
    let letters = rest.bytes().take_while(u8::is_ascii_alphabetic).count();
    letters > 0 && (letters == rest.len() || rest[letters..].chars().next().is_some_and(|c| string::trim(&c.to_string()).is_empty()))
}

pub fn chip_color(color: Option<&str>) -> Rgb {
    let Some(rgb) = color.and_then(|s| hex(s).ok()) else { return palette::DIM };
    let luminance = (0.2126 * rgb[0] as f64 + 0.7152 * rgb[1] as f64 + 0.0722 * rgb[2] as f64) / 255.;
    if luminance >= 0.3 {
        rgb
    } else {
        rgb.map(|c| number::round(c as f64 + (255. - c as f64) * 0.45) as u8)
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FocusPath {
    pub crumbs: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub context: String,
}
pub fn focus_path(focus: &LiveFocus) -> FocusPath {
    let mut crumbs = vec![];
    let mut value = None;
    if let Some(track) = &focus.track {
        crumbs.push(track.name.clone());
    }
    if focus.detail == Some(LiveDetail::Clip) && focus.clip.is_some() {
        crumbs.push(focus.clip.as_ref().filter(|s| !s.is_empty()).cloned().unwrap_or_else(|| "Untitled clip".into()));
    } else if focus.detail == Some(LiveDetail::Device) && focus.device.as_ref().is_some_and(|s| !s.is_empty()) {
        crumbs.push(focus.device.clone().unwrap());
        if let Some(p) = focus.parameter.as_ref().filter(|p| p.owner.as_ref().is_none_or(|s| s.is_empty()) || p.owner == focus.device) {
            crumbs.push(p.name.clone());
            value = p.value.clone().filter(|s| !s.is_empty());
        }
    } else if let Some(scene) = focus.scene.as_ref().filter(|s| !s.is_empty()) {
        crumbs.push(scene.clone());
    }
    let mut context = vec![];
    if let Some(view) = focus.view {
        context.push(
            match view {
                LiveView::Session => "Session",
                LiveView::Arrangement => "Arrangement",
            }
            .into(),
        );
    }
    if let Some(detail) = focus.detail {
        context.push(
            match detail {
                LiveDetail::Clip => "Clip view",
                LiveDetail::Device => "Device view",
            }
            .into(),
        );
    }
    if let Some(n) = focus.selected_notes.filter(|n| *n != 0) {
        context.push(format!("{n} {} selected", if n == 1 { "note" } else { "notes" }));
    }
    FocusPath { crumbs, value, context: context.join(" · ") }
}
pub fn fit_crumbs(crumbs: &[String], width: i32) -> Vec<String> {
    if crumbs.is_empty() || text_width(&crumbs.join(" › ")) <= width {
        return crumbs.to_vec();
    }
    let first = truncate(&crumbs[0], 12);
    if crumbs.len() > 2 {
        let collapsed = vec![crumbs[0].clone(), "…".into(), crumbs.last().unwrap().clone()];
        if text_width(&collapsed.join(" › ")) <= width {
            return collapsed;
        }
        return vec![first.clone(), "…".into(), truncate(crumbs.last().unwrap(), (width - text_width(&first) - 6).max(1))];
    }
    if crumbs.len() == 2 {
        vec![first.clone(), truncate(&crumbs[1], (width - text_width(&first) - 3).max(1))]
    } else {
        vec![truncate(&crumbs[0], width)]
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Touched {
    Device,
    Clip,
    Session,
    Arrangement,
}
pub fn touched_next(before: Option<&LiveFocus>, after: Option<&LiveFocus>, was: Option<Touched>) -> Option<Touched> {
    let after = after?;
    let clip = if after.view == Some(LiveView::Arrangement) { Touched::Arrangement } else { Touched::Clip };
    let view = if after.view == Some(LiveView::Arrangement) { Touched::Arrangement } else { Touched::Session };
    let Some(before) = before else {
        return Some(match after.detail {
            Some(LiveDetail::Clip) => clip,
            Some(LiveDetail::Device) => Touched::Device,
            None => view,
        });
    };
    Some(if after.view != before.view {
        view
    } else if after.scene_index != before.scene_index && after.view == Some(LiveView::Session) {
        Touched::Session
    } else if after.detail == Some(LiveDetail::Clip)
        && (before.detail != Some(LiveDetail::Clip) || after.slot_ref != before.slot_ref || after.clip != before.clip)
    {
        clip
    } else if after.detail == Some(LiveDetail::Device)
        && (before.detail != Some(LiveDetail::Device)
            || after.device != before.device
            || after.chain != before.chain
            || after.track_ref != before.track_ref)
    {
        Touched::Device
    } else {
        was.unwrap_or(view)
    })
}
pub fn set_name_from(label: &str) -> Option<String> {
    let (name, suffix) = label.strip_prefix("Current open Set: ")?.rsplit_once(" — ")?;
    if suffix.contains('—') || name.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let name = string::trim(name);
    (!name.is_empty()).then(|| name.into())
}
/// English display names for every two/three-letter language accepted by voice settings,
/// extracted from the reference runtime's ICU data; unknown codes retain their spelling.
pub fn language_name(code: &str) -> String {
    static NAMES: LazyLock<HashMap<String, String>> = LazyLock::new(|| serde_json::from_str(include_str!("language-names.json")).unwrap());
    if code == "auto" {
        "any language".into()
    } else {
        NAMES.get(&code.to_ascii_lowercase()).cloned().unwrap_or_else(|| code.into())
    }
}
pub fn catch_up_text(catch: &CatchUp, now: f64) -> String {
    let when = since(catch.last_seen_at as f64, now);
    let more = if catch.more != 0 { format!("; and {} more", catch.more) } else { String::new() };
    if catch.after_reconnect == Some(true) {
        format!("While Live was away, {} changed: {}{more}.", catch.set, catch.lines.join("; "))
    } else if catch.lines.is_empty() {
        format!("Nothing changed in {} since you were last here, {when}.", catch.set)
    } else {
        format!("Since you were last here ({when}): {}{more}.", catch.lines.join("; "))
    }
}
#[allow(dead_code)] // Used by the app orchestration port in progress.
pub(super) fn clock_of(ms: f64) -> String {
    let whole = (ms / 1000.).floor().max(0.) as u64;
    let (hours, minutes, seconds) = (whole / 3600, whole % 3600 / 60, whole % 60);
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}
#[allow(dead_code)]
pub(super) fn elapsed(ms: f64) -> String {
    format!("{}s", number::to_fixed(ms.max(0.) / 1000., 1))
}
#[allow(dead_code)]
pub(super) fn mix_rgb(from: Rgb, to: Rgb, amount: f64) -> Rgb {
    std::array::from_fn(|i| number::round(from[i] as f64 + (to[i] as f64 - from[i] as f64) * amount) as u8)
}
#[allow(dead_code)]
pub(super) fn chunk(text: &str, width: usize) -> Vec<String> {
    text.encode_utf16().collect::<Vec<_>>().chunks(width.max(1)).map(String::from_utf16_lossy).collect()
}
fn span(text: impl Into<String>, color: Rgb) -> Span {
    Span::styled(text, Style::fg(color))
}
pub fn change_picture(change: &ChangeRecord, width: i32, depth: ColorDepth) -> Option<Vec<Vec<Span>>> {
    if let Some(clip) = &change.clip {
        return clip_picture(
            clip.length,
            &clip.notes.iter().map(|n| ClipViewNote { note: n.clone(), selected: None }).collect::<Vec<_>>(),
            width,
            2,
        );
    }
    if let Some(devices) = &change.devices {
        return devices_picture(devices, width);
    }
    if let Some(colors) = &change.colors {
        if matches!(depth, ColorDepth::Colors16 | ColorDepth::None) {
            return None;
        }
        let mut row = vec![];
        if let Some(from) = colors.from.as_ref().filter(|s| !s.is_empty()) {
            row.extend([span("████", chip_color(Some(from))), span(" → ", palette::FAINT)]);
        }
        row.push(span("████", chip_color(Some(&colors.to))));
        return Some(vec![row]);
    }
    let (from, to, [min, max]) = (change.from?, change.to?, change.range?);
    if max <= min {
        return None;
    }
    let cells = ((width - 3) as f64 / 2.).floor().clamp(4., 12.) as usize;
    let bar = |value: f64| {
        let filled = number::round(((value - min) / (max - min)).clamp(0., 1.) * cells as f64) as usize;
        "█".repeat(filled) + &"░".repeat(cells - filled)
    };
    Some(vec![vec![span(bar(from), palette::FAINT), span(" → ", palette::FAINT), span(bar(to), palette::ACCENT)]])
}
fn device_row(devices: &[String], lit: Option<f64>, room: i32) -> Vec<Span> {
    let names: Vec<_> = devices.iter().map(|s| truncate(if s.is_empty() { "Device" } else { s }, 16)).collect();
    if names.is_empty() {
        return vec![span("empty", palette::FAINT)];
    }
    let end = (names.len() - 1) as f64;
    let cost = |from: f64, to: f64| {
        names[from as usize..((to + 1.) as usize).min(names.len())].iter().map(|s| text_width(s) as f64).sum::<f64>()
            + 3. * (to - from)
            + if from > 0. { 4. } else { 0. }
            + if to < end { 4. } else { 0. }
    };
    let mut first = lit.filter(|n| *n >= 0. && *n < names.len() as f64).unwrap_or(end);
    let mut last = first;
    loop {
        let mut grew = false;
        if last < end && cost(first, last + 1.) <= room as f64 {
            last += 1.;
            grew = true;
        }
        if first > 0. && cost(first - 1., last) <= room as f64 {
            first -= 1.;
            grew = true;
        }
        if !grew {
            break;
        }
    }
    let mut spans = vec![];
    if first > 0. {
        spans.extend([span("…", palette::FAINT), span(" → ", palette::FAINT)]);
    }
    for (offset, name) in names[(first as usize).min(names.len())..((last + 1.) as usize).min(names.len())].iter().enumerate() {
        if offset > 0 {
            spans.push(span(" → ", palette::FAINT));
        }
        spans.push(span(name, if Some(first + offset as f64) == lit { palette::ACCENT } else { palette::DIM }));
    }
    if last < end {
        spans.extend([span(" → ", palette::FAINT), span("…", palette::FAINT)]);
    }
    spans
}
fn devices_picture(placement: &DevicePlacement, width: i32) -> Option<Vec<Vec<Span>>> {
    let chains = placement.chains.as_deref().unwrap_or_default();
    if chains.is_empty() {
        return placement.devices.as_ref().filter(|v| !v.is_empty()).map(|v| vec![device_row(v, placement.index, width)]);
    }
    let focus = placement.chain.unwrap_or(0.).clamp(0., (chains.len() - 1) as f64);
    assert!(focus.fract() == 0., "a chain picture needs an existing chain");
    let focus = focus as usize;
    let shown = if chains.len() == 1 {
        vec![focus]
    } else if focus < chains.len() - 1 {
        vec![focus, focus + 1]
    } else {
        vec![focus - 1, focus]
    };
    let more = chains.len() - shown.len();
    let name_width = shown.iter().map(|i| text_width(&chains[*i].name)).max().unwrap_or(0).min(10);
    Some(
        shown
            .iter()
            .enumerate()
            .map(|(line, index)| {
                let glyph = if shown.len() == 1 {
                    "╶ "
                } else if line == 0 {
                    "╭ "
                } else {
                    "╰ "
                };
                let name = truncate(&chains[*index].name, name_width);
                let tail = if line == shown.len() - 1 && more > 0 { format!("  +{more}") } else { String::new() };
                let room = (width - 2 - name_width - 2 - tail.len() as i32).max(8);
                let mut row = vec![
                    span(glyph, palette::FAINT),
                    span(
                        format!("{name}{}  ", " ".repeat((name_width - text_width(&name)).max(0) as usize)),
                        if *index == focus {
                            if placement.index.is_none() {
                                palette::ACCENT
                            } else {
                                palette::TEXT
                            }
                        } else {
                            palette::FAINT
                        },
                    ),
                ];
                row.extend(device_row(&chains[*index].devices, (*index == focus).then_some(placement.index).flatten(), room));
                if !tail.is_empty() {
                    row.push(span(tail, palette::FAINT));
                }
                row
            })
            .collect(),
    )
}
pub fn clip_picture(length: f64, notes: &[ClipViewNote], width: i32, rows: usize) -> Option<Vec<Vec<Span>>> {
    if length <= 0. || notes.is_empty() {
        return None;
    }
    let cells = width.clamp(8, 32) as usize;
    let (columns, lanes) = (cells * 2, rows * 4);
    let mut pitches: Vec<f64> = notes.iter().map(|n| n.note.pitch).collect();
    pitches.sort_by(|a, b| b.total_cmp(a));
    pitches.dedup();
    let (high, low) = (pitches[0], *pitches.last().unwrap());
    let top = ((lanes as f64 - 1. - (high - low)) / 2.).floor();
    let lane = |pitch: f64| {
        if high - low < lanes as f64 {
            top + high - pitch
        } else if pitches.len() <= lanes {
            number::round(pitches.iter().position(|p| *p == pitch).unwrap() as f64 * (lanes - 1) as f64 / (pitches.len() - 1) as f64)
        } else {
            number::round((high - pitch) * (lanes - 1) as f64 / (high - low))
        }
    };
    let marking = notes.iter().any(|n| n.selected == Some(true));
    let mut dots = vec![vec![0f64; columns]; lanes];
    for note in notes {
        let n = &note.note;
        let first = (n.start / length * columns as f64).floor().clamp(0., (columns - 1) as f64) as usize;
        let last = (((n.start + n.duration) / length * columns as f64).ceil() - 1.).min((columns - 1) as f64).max(first as f64) as usize;
        let row = &mut dots[lane(n.pitch) as usize];
        let weight = if marking {
            if note.selected == Some(true) {
                127.
            } else {
                1.
            }
        } else {
            n.velocity
        };
        for value in &mut row[first..=last] {
            *value = value.max(weight);
        }
    }
    const BRAILLE: [[u32; 2]; 4] = [[1, 8], [2, 16], [4, 32], [64, 128]];
    Some(
        (0..rows)
            .map(|text_row| {
                let mut spans: Vec<Span> = vec![];
                for cell in 0..cells {
                    let (mut bits, mut loudest) = (0, 0f64);
                    for dy in 0..4 {
                        for dx in 0..2 {
                            let velocity = dots[text_row * 4 + dy][cell * 2 + dx];
                            if velocity != 0. {
                                bits |= BRAILLE[dy][dx];
                                loudest = loudest.max(velocity);
                            }
                        }
                    }
                    let style = Style::fg(if loudest >= 64. { palette::ACCENT } else { palette::DIM });
                    let text = char::from_u32(0x2800 + bits).unwrap();
                    if let Some(last) = spans.last_mut().filter(|s| *s.style == style) {
                        last.text.push(text);
                    } else {
                        spans.push(Span::styled(text.to_string(), style));
                    }
                }
                spans
            })
            .collect(),
    )
}
