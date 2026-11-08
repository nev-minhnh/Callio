//! Markdown from a WordCraft document, keeping as much of its form as Markdown can hold:
//! headings, paragraphs, bold/italic/underline/strike, super- and subscript, highlight, code,
//! links (and the anchors they point to), bullet and numbered lists with nesting, block quotes,
//! code blocks, rules, tables (GitHub pipe tables; HTML when cells merge or hold blocks),
//! pictures (saved next to the Markdown), equations (as LaTeX), footnotes and text boxes.

use std::collections::HashSet;
use std::fmt::Write as _;

use wordcraft_doc::Document;
use wordcraft_formats::latex::linear_to_latex;
use wordcraft_formats::model::{self, FBlock, FTable, Fmt, FlowOpts, Inline, Kind, Para};

pub struct MdOut {
    pub markdown: String,
    /// (relative path used in the Markdown, bytes)
    pub images: Vec<(String, Vec<u8>)>,
}

/// `stem`: the base name for the pictures folder ("report" → "report_files/image1.png").
pub fn to_markdown(doc: &Document, stem: &str) -> MdOut {
    let flow = model::from_doc_with(doc, FlowOpts { notes: true, boxes: true, ..Default::default() });
    let mut w = W { stem: stem.to_string(), ..Default::default() };
    collect_links(&flow.blocks, &mut w.linked);
    if !flow.meta.title.is_empty() && !starts_with_heading(&flow.blocks) {
        // the document's title, when the text doesn't open with it
        let _ = writeln!(w.out, "<!-- title: {} -->\n", flow.meta.title.replace("--", "—"));
    }
    w.blocks(&flow.blocks, "");
    if !w.notes.is_empty() {
        w.out.push('\n');
        let notes = std::mem::take(&mut w.notes);
        for (i, n) in notes.iter().enumerate() {
            let _ = writeln!(w.out, "[^{}]: {}", i + 1, n.replace('\n', "\n    "));
        }
    }
    let mut md = w.out.trim_end().to_string();
    md.push('\n');
    MdOut { markdown: md, images: w.images }
}

fn starts_with_heading(blocks: &[FBlock]) -> bool {
    blocks.iter().find_map(|b| match b {
        FBlock::Para(p) if !plain(&p.inlines).trim().is_empty() => Some(matches!(p.kind, Kind::Heading(1) | Kind::Title)),
        FBlock::Table(_) => Some(false),
        _ => None,
    }) == Some(true)
}

fn collect_links(blocks: &[FBlock], out: &mut HashSet<String>) {
    for b in blocks {
        match b {
            FBlock::Para(p) => {
                for i in &p.inlines {
                    match i {
                        Inline::Text(_, f) => {
                            if let Some(l) = &f.link
                                && let Some(a) = l.strip_prefix('#')
                            {
                                out.insert(a.to_string());
                            }
                        }
                        Inline::Note { blocks, .. } | Inline::Shape { blocks, .. } => collect_links(blocks, out),
                        _ => {}
                    }
                }
            }
            FBlock::Table(t) => {
                for row in &t.rows {
                    for c in row {
                        collect_links(&c.blocks, out);
                    }
                }
            }
        }
    }
}

#[derive(Default)]
struct W {
    out: String,
    stem: String,
    images: Vec<(String, Vec<u8>)>,
    notes: Vec<String>,
    linked: HashSet<String>,
    /// numbering per list level (reset when a list ends)
    counters: Vec<u32>,
}

/// Plain text of inlines (for checks).
fn plain(inl: &[Inline]) -> String {
    let mut s = String::new();
    for i in inl {
        if let Inline::Text(t, _) = i {
            s.push_str(t);
        }
    }
    s
}

impl W {
    fn blocks(&mut self, blocks: &[FBlock], prefix: &str) {
        let mut i = 0;
        let mut in_list = false;
        while i < blocks.len() {
            match &blocks[i] {
                FBlock::Table(t) => {
                    in_list = false;
                    self.counters.clear();
                    let s = self.table(t);
                    self.emit_block(&s, prefix);
                    i += 1;
                }
                FBlock::Para(p) if p.kind == Kind::Code && p.list.is_none() => {
                    // consecutive code lines → one fenced block
                    let mut lines = vec![];
                    while let Some(FBlock::Para(q)) = blocks.get(i) {
                        if q.kind != Kind::Code || q.list.is_some() {
                            break;
                        }
                        lines.push(plain(&q.inlines));
                        i += 1;
                    }
                    let body = lines.join("\n");
                    let fence = if body.contains("```") { "~~~~" } else { "```" };
                    self.emit_block(&format!("{fence}\n{body}\n{fence}"), prefix);
                    in_list = false;
                }
                FBlock::Para(p) => {
                    if let Some(l) = p.list {
                        let lvl = l.level as usize;
                        if !in_list {
                            self.counters.clear();
                        }
                        self.counters.truncate(lvl + 1);
                        while self.counters.len() <= lvl {
                            self.counters.push(0);
                        }
                        if self.counters[lvl] == 0 {
                            self.counters[lvl] = l.start.max(1).saturating_sub(1);
                        }
                        self.counters[lvl] += 1;
                        let marker = if l.ordered { format!("{}.", self.counters[lvl]) } else { "-".to_string() };
                        let indent = "    ".repeat(lvl);
                        let text = self.para_text(p);
                        let hang = format!("{indent}{}", " ".repeat(marker.len() + 1));
                        let body = text.replace('\n', &format!("\n{hang}"));
                        // list items sit together (no blank line between them)
                        let line = format!("{indent}{marker} {body}");
                        if in_list {
                            for l in line.lines() {
                                let _ = writeln!(self.out, "{prefix}{l}");
                            }
                        } else {
                            self.sep(prefix);
                            for l in line.lines() {
                                let _ = writeln!(self.out, "{prefix}{l}");
                            }
                        }
                        in_list = true;
                        i += 1;
                        continue;
                    }
                    if in_list {
                        self.counters.clear();
                    }
                    in_list = false;
                    let s = self.para(p);
                    if !s.is_empty() {
                        self.emit_block(&s, prefix);
                    }
                    i += 1;
                }
            }
        }
    }

    /// A blank line between blocks.
    fn sep(&mut self, prefix: &str) {
        if !self.out.is_empty() && !self.out.ends_with("\n\n") {
            if !self.out.ends_with('\n') {
                self.out.push('\n');
            }
            let _ = writeln!(self.out, "{}", prefix.trim_end());
        }
    }
    fn emit_block(&mut self, s: &str, prefix: &str) {
        self.sep(prefix);
        for l in s.lines() {
            if l.is_empty() {
                let _ = writeln!(self.out, "{}", prefix.trim_end());
            } else {
                let _ = writeln!(self.out, "{prefix}{l}");
            }
        }
    }

    fn para(&mut self, p: &Para) -> String {
        let text = self.para_text(p);
        match p.kind {
            Kind::Rule => "---".into(),
            Kind::Heading(n) => {
                if text.trim().is_empty() {
                    return String::new();
                }
                format!("{} {}", "#".repeat(n.clamp(1, 6) as usize), text.replace('\n', " "))
            }
            Kind::Title => {
                if text.trim().is_empty() {
                    return String::new();
                }
                format!("# {}", text.replace('\n', " "))
            }
            Kind::Quote => text.lines().map(|l| format!("> {l}")).collect::<Vec<_>>().join("\n"),
            _ => {
                if text.trim().is_empty() && !p.inlines.iter().any(|i| matches!(i, Inline::Image(_))) {
                    return String::new();
                }
                // a display equation alone in its paragraph
                text
            }
        }
    }

    /// The paragraph's inline content as Markdown (line breaks as `\` + newline).
    fn para_text(&mut self, p: &Para) -> String {
        self.inlines(&p.inlines, false)
    }

    fn inlines(&mut self, inl: &[Inline], html: bool) -> String {
        let mut out = String::new();
        // runs of text with the same look are joined first, so `**a****b**` never happens
        let mut run: Option<(String, Fmt)> = None;
        let flush = |out: &mut String, run: &mut Option<(String, Fmt)>, html: bool| {
            if let Some((t, f)) = run.take() {
                out.push_str(&styled(&t, &f, html));
            }
        };
        for i in inl {
            match i {
                Inline::Text(t, f) => {
                    let f = look(f);
                    match &mut run {
                        Some((rt, rf)) if *rf == f => rt.push_str(t),
                        _ => {
                            flush(&mut out, &mut run, html);
                            run = Some((t.clone(), f));
                        }
                    }
                }
                other => {
                    flush(&mut out, &mut run, html);
                    match other {
                        Inline::Image(img) => {
                            let ext = match img.ext.to_ascii_lowercase().as_str() {
                                "jpeg" => "jpg".to_string(),
                                e if !e.is_empty() => e.to_string(),
                                _ => "png".into(),
                            };
                            let name = format!("{}_files/image{}.{ext}", self.stem, self.images.len() + 1);
                            self.images.push((name.clone(), img.data.to_vec()));
                            let alt = img.alt.replace(['[', ']', '\n'], " ");
                            let url = name.replace(' ', "%20");
                            if html {
                                let _ = write!(out, "<img src=\"{}\" alt=\"{}\">", url, esc_html(&alt));
                            } else {
                                let _ = write!(out, "![{alt}]({url})");
                            }
                        }
                        Inline::Anchor(a) if self.linked.contains(a) => {
                            let _ = write!(out, "<a id=\"{}\"></a>", esc_html(a));
                        }
                        Inline::Equation { linear, display } => {
                            let tex = linear_to_latex(linear);
                            if *display && !html {
                                let _ = write!(out, "\n$$\n{}\n$$\n", tex.trim());
                            } else {
                                let _ = write!(out, "${}$", tex.trim());
                            }
                        }
                        Inline::Note { blocks, .. } => {
                            let mut sub = W { stem: self.stem.clone(), linked: self.linked.clone(), ..Default::default() };
                            sub.images = std::mem::take(&mut self.images);
                            sub.blocks(blocks, "");
                            self.images = std::mem::take(&mut sub.images);
                            let text = sub.out.trim().to_string();
                            self.notes.push(text);
                            let _ = write!(out, "[^{}]", self.notes.len());
                        }
                        Inline::Field { result, fmt, .. } => out.push_str(&styled(result, &look(fmt), html)),
                        Inline::Control { text, fmt, .. } => out.push_str(&styled(text, &look(fmt), html)),
                        Inline::Ruby { base, ruby, .. } => {
                            let _ = write!(out, "<ruby>{}<rt>{}</rt></ruby>", esc_html(base), esc_html(ruby));
                        }
                        Inline::Shape { blocks, .. } if !blocks.is_empty() => {
                            // a text box: its text, kept apart from the paragraph's
                            let mut sub = W { stem: self.stem.clone(), linked: self.linked.clone(), ..Default::default() };
                            sub.images = std::mem::take(&mut self.images);
                            sub.blocks(blocks, "");
                            self.images = std::mem::take(&mut sub.images);
                            let t = sub.out.trim().to_string();
                            if !t.is_empty() {
                                if html {
                                    let _ = write!(out, " {} ", t.replace('\n', "<br>"));
                                } else {
                                    let _ = write!(out, "\n\n{t}\n\n");
                                }
                            }
                        }
                        Inline::Group { members, .. } => {
                            let inner: Vec<Inline> = members.iter().map(|m| m.inline.clone()).collect();
                            out.push_str(&self.inlines(&inner, html));
                        }
                        Inline::Chart(_) => out.push_str(if html { "[chart]" } else { "*[chart]*" }),
                        _ => {}
                    }
                }
            }
        }
        flush(&mut out, &mut run, html);
        if html {
            out
        } else {
            // a line break inside a paragraph: Markdown's hard break
            out.trim_matches(|c| c == ' ').replace("\n\n\n", "\n\n")
        }
    }

    fn table(&mut self, t: &FTable) -> String {
        let simple = t.rows.iter().flatten().all(|c| {
            c.colspan <= 1
                && c.rowspan <= 1
                && !c.covered
                && c.blocks.len() <= 1
                && c.blocks.iter().all(|b| matches!(b, FBlock::Para(p) if p.list.is_none() && matches!(p.kind, Kind::Normal | Kind::Heading(_) | Kind::Title)))
        }) && t.rows.len() > 0;
        if simple {
            let ncol = t.rows.iter().map(|r| r.len()).max().unwrap_or(0).max(1);
            let mut s = String::new();
            for (ri, row) in t.rows.iter().enumerate() {
                s.push('|');
                for ci in 0..ncol {
                    let cell = row.get(ci);
                    let text = cell.map(|c| self.cell_md(&c.blocks)).unwrap_or_default();
                    let _ = write!(s, " {} |", text);
                }
                s.push('\n');
                if ri == 0 {
                    s.push('|');
                    for ci in 0..ncol {
                        let al = row.get(ci).and_then(|c| c.blocks.first()).and_then(|b| match b {
                            FBlock::Para(p) => p.align,
                            _ => None,
                        });
                        s.push_str(match al {
                            Some(wordcraft_doc::Align::Center) => " :---: |",
                            Some(wordcraft_doc::Align::Right) => " ---: |",
                            _ => " --- |",
                        });
                    }
                    s.push('\n');
                }
            }
            return s.trim_end().to_string();
        }
        // merged cells or cells holding several blocks: an HTML table
        let mut s = String::from("<table>\n");
        for (ri, row) in t.rows.iter().enumerate() {
            s.push_str("  <tr>");
            for c in row {
                if c.covered {
                    continue;
                }
                let tag = if c.header || ri == 0 && t.rows.len() > 1 && row.iter().all(|x| x.header) { "th" } else { "td" };
                let mut attrs = String::new();
                if c.colspan > 1 {
                    let _ = write!(attrs, " colspan=\"{}\"", c.colspan);
                }
                if c.rowspan > 1 {
                    let _ = write!(attrs, " rowspan=\"{}\"", c.rowspan);
                }
                let inner = self.cell_html(&c.blocks);
                let _ = write!(s, "<{tag}{attrs}>{inner}</{tag}>");
            }
            s.push_str("</tr>\n");
        }
        s.push_str("</table>");
        s
    }

    fn cell_md(&mut self, blocks: &[FBlock]) -> String {
        let mut parts = vec![];
        for b in blocks {
            if let FBlock::Para(p) = b {
                let t = self.inlines(&p.inlines, false);
                parts.push(t.replace('\n', "<br>").replace('|', "\\|"));
            }
        }
        parts.join("<br>")
    }

    fn cell_html(&mut self, blocks: &[FBlock]) -> String {
        let mut s = String::new();
        let mut in_list: Option<bool> = None;
        for b in blocks {
            match b {
                FBlock::Para(p) => {
                    let t = self.inlines(&p.inlines, true).replace('\n', "<br>");
                    if let Some(l) = p.list {
                        if in_list != Some(l.ordered) {
                            if let Some(o) = in_list {
                                s.push_str(if o { "</ol>" } else { "</ul>" });
                            }
                            s.push_str(if l.ordered { "<ol>" } else { "<ul>" });
                            in_list = Some(l.ordered);
                        }
                        let _ = write!(s, "<li>{t}</li>");
                        continue;
                    }
                    if let Some(o) = in_list.take() {
                        s.push_str(if o { "</ol>" } else { "</ul>" });
                    }
                    if !s.is_empty() {
                        s.push_str("<br>");
                    }
                    s.push_str(&t);
                }
                FBlock::Table(t) => {
                    let inner = self.table(t);
                    s.push_str(&inner);
                }
            }
        }
        if let Some(o) = in_list {
            s.push_str(if o { "</ol>" } else { "</ul>" });
        }
        s
    }
}

/// The parts of a run's formatting Markdown can show.
fn look(f: &Fmt) -> Fmt {
    Fmt {
        bold: f.bold,
        italic: f.italic,
        underline: f.underline,
        strike: f.strike,
        code: f.code,
        sup: f.sup,
        sub: f.sub,
        link: f.link.clone(),
        background: f.background,
        ..Default::default()
    }
}

fn esc_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn esc_md(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for (i, line) in s.split('\n').enumerate() {
        if i > 0 {
            o.push_str("\\\n");
        }
        let mut first = true;
        for ch in line.chars() {
            match ch {
                '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '$' => {
                    o.push('\\');
                    o.push(ch);
                }
                '#' | '+' | '-' | '=' if first => {
                    o.push('\\');
                    o.push(ch);
                }
                '\t' => o.push(' '),
                '\u{a0}' => o.push('\u{a0}'),
                c => o.push(c),
            }
            if !ch.is_whitespace() {
                first = false;
            }
        }
    }
    o
}

/// Text with its look, spaces kept outside the markers (`** bold**` wouldn't be bold).
fn styled(t: &str, f: &Fmt, html: bool) -> String {
    if t.is_empty() {
        return String::new();
    }
    let lead = &t[..t.len() - t.trim_start().len()];
    let trail = &t[t.trim_end().len()..];
    let core = t.trim();
    if core.is_empty() {
        return t.replace('\t', " ");
    }
    let mut s = if f.code {
        let ticks = if core.contains('`') { "``" } else { "`" };
        if html { format!("<code>{}</code>", esc_html(core)) } else { format!("{ticks}{core}{ticks}") }
    } else if html {
        esc_html(core).replace('\n', "<br>")
    } else {
        esc_md(core)
    };
    if !f.code {
        if f.sup {
            s = format!("<sup>{s}</sup>");
        }
        if f.sub {
            s = format!("<sub>{s}</sub>");
        }
        if f.underline && f.link.is_none() {
            s = format!("<u>{s}</u>");
        }
        if f.background.is_some() {
            s = format!("<mark>{s}</mark>");
        }
        if f.strike {
            s = if html { format!("<s>{s}</s>") } else { format!("~~{s}~~") };
        }
        if f.italic {
            s = if html { format!("<em>{s}</em>") } else { format!("*{s}*") };
        }
        if f.bold {
            s = if html { format!("<strong>{s}</strong>") } else { format!("**{s}**") };
        }
    }
    if let Some(l) = &f.link {
        let url = l.replace(' ', "%20").replace(')', "%29");
        s = if html { format!("<a href=\"{}\">{s}</a>", esc_html(&url)) } else { format!("[{s}]({url})") };
    }
    format!("{lead}{s}{trail}").replace('\t', " ")
}
