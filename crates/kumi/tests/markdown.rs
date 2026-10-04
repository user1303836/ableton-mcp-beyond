//! Port of `apps/kumi/test/markdown.test.ts`.

use std::rc::Rc;

use kumi::tui::markdown::{inline, render_markdown, MarkdownRow};
use kumi::tui::style::{palette, Style};

fn base() -> Rc<Style> {
    Rc::new(Style::fg(palette::TEXT))
}

fn text(rows: &[MarkdownRow]) -> Vec<String> {
    rows.iter().map(|row| row.spans.iter().map(|span| span.text.as_str()).collect()).collect()
}

#[test]
fn inline_markdown_becomes_styles_and_names_with_underscores_or_lone_asterisks_stay_literal() {
    let spans = inline("**Bass** needs *less* `EQ Eight` at [200 Hz](https://example.com/eq)", &base());
    assert_eq!(
        spans.iter().map(|span| span.text.as_str()).collect::<Vec<_>>(),
        vec!["Bass", " needs ", "less", " ", "EQ Eight", " at ", "200 Hz", " (https://example.com/eq)"]
    );
    assert!(spans[0].style.bold);
    assert!(spans[2].style.italic);
    assert_eq!(spans[4].style.bg, Some(palette::RAISED));
    assert!(spans[6].style.underline);
    assert_eq!(
        inline("Kick_01_final and 2*3*4 and C* minor", &base()).iter().map(|span| span.text.as_str()).collect::<Vec<_>>(),
        vec!["Kick_01_final and 2*3*4 and C* minor"]
    );
    assert_eq!(inline("_really_ loud", &base()).iter().map(|span| span.style.italic).collect::<Vec<_>>(), vec![true, false]);
}

#[test]
fn lists_get_bullets_and_hanging_indents_headings_quotes_and_code_render_without_their_markers() {
    let rows = render_markdown(
        &[
            "## Low end",
            "- The kick and bass are fighting around 200 Hz",
            "  - nested point",
            "2. Then tighten the compressor",
            "> Names are data",
            "```js",
            "const gain = -3;",
            "```",
            "---",
            "| Track | Device |",
            "|---|---|",
            "| Bass | EQ Eight |",
        ]
        .join("\n"),
        24,
        &base(),
    );
    assert_eq!(
        text(&rows),
        vec![
            "Low end",
            "• The kick and bass are",
            "  fighting around 200 Hz",
            "  • nested point",
            "2. Then tighten the",
            "   compressor",
            "│ Names are data",
            "const gain = -3;",
            "────────────────────────",
            "| Track | Device |",
            "| Bass | EQ Eight |",
        ]
    );
    assert!(rows[0].spans[0].style.bold);
    assert_eq!(rows[7].bg, Some(palette::RAISED), "code blocks sit on a band");
    assert_eq!(rows[1].bg, None);
}

#[test]
fn a_long_code_line_splits_between_characters_instead_of_wrapping_words() {
    let rows = render_markdown("```\nabcdefghij\n```", 4, &base());
    assert_eq!(text(&rows), vec!["abcd", "efgh", "ij"]);
}

#[test]
fn an_unfinished_fence_while_streaming_shows_the_code_so_far() {
    assert_eq!(text(&render_markdown("Try this:\n```\nlet x", 20, &base())), vec!["Try this:", "let x"]);
}
