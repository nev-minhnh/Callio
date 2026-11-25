//! Obsidian-flavoured Markdown, the parts a vault index needs: frontmatter, links and embeds
//! (`[[Note#Heading|alias]]`, `![[img.png|300]]`, `[x](Note.md)`), headings, `^block` ids and
//! `#tags`; plus the Properties (YAML frontmatter) reader/writer that leaves untouched keys
//! byte-for-byte as they were. Std only, so it is unit-tested on its own.

#[derive(Clone, Debug, PartialEq, Default)]
pub struct Link {
    /// the path part: `Note`, `folder/Note`, `image.png` (empty: the note itself)
    pub target: String,
    /// what follows `#`: a heading, or `^id` for a block
    pub sub: String,
    /// text after `|` (a size like `300` for embeds)
    pub alias: String,
    pub embed: bool,
    /// written as `[x](path)` rather than `[[path]]`
    pub md: bool,
    pub line: usize,
    /// byte range of the whole link in the text
    pub from: usize,
    pub to: usize,
    /// `<…>` wrapper around a Markdown link target
    pub angle: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Heading {
    pub level: u8,
    pub text: String,
    pub line: usize,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Block {
    pub id: String,
    pub line: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Parsed {
    pub aliases: Vec<String>,
    pub fm_tags: Vec<String>,
    /// inline `#tags` with the line they are on (without the `#`)
    pub tags: Vec<(String, usize)>,
    pub headings: Vec<Heading>,
    pub blocks: Vec<Block>,
    pub links: Vec<Link>,
}

/// Lines with the byte offset where each starts; line ends (`\n`, `\r\n`) are cut off.
pub fn lines_of(text: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut pos = 0;
    for l in text.split_inclusive('\n') {
        out.push((pos, l.trim_end_matches('\n').trim_end_matches('\r')));
        pos += l.len();
    }
    out
}

/// Where the frontmatter is: `(inner_from, inner_to, end)` — the YAML between the two `---`
/// lines, and the byte after the closing line.
pub fn fm_range(text: &str) -> Option<(usize, usize, usize)> {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let off = text.len() - t.len();
    let first = t.split_inclusive('\n').next()?;
    if first.trim_end() != "---" {
        return None;
    }
    let inner_from = off + first.len();
    let mut pos = inner_from;
    for l in t[first.len()..].split_inclusive('\n') {
        let tl = l.trim_end();
        if tl == "---" || tl == "..." {
            return Some((inner_from, pos, pos + l.len()));
        }
        pos += l.len();
    }
    None
}

// ---------------------------------------------------------------- parsing

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

fn plain_heading(s: &str) -> String {
    // [[a|b]] → b, [[a]] → a, [x](y) → x, and drop emphasis marks
    let mut out = String::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if s[i..].starts_with("[[") {
            if let Some(e) = s[i + 2..].find("]]") {
                let inner = &s[i + 2..i + 2 + e];
                out.push_str(inner.rsplit('|').next().unwrap_or(inner));
                i += e + 4;
                continue;
            }
        }
        if b[i] == b'[' {
            if let Some(e) = s[i..].find("](") {
                if let Some(c) = s[i + e..].find(')') {
                    out.push_str(&s[i + 1..i + e]);
                    i += e + c + 1;
                    continue;
                }
            }
        }
        let ch = s[i..].chars().next().unwrap();
        if ch != '*' && ch != '_' && ch != '`' && ch != '~' && ch != '=' {
            out.push(ch);
        }
        i += ch.len_utf8();
    }
    out.trim().to_string()
}

fn heading_of(line: &str) -> Option<(u8, String)> {
    let t = line.trim_start_matches(' ');
    if line.len() - t.len() > 3 {
        return None;
    }
    let n = t.bytes().take_while(|&c| c == b'#').count();
    if n == 0 || n > 6 {
        return None;
    }
    let rest = &t[n..];
    if !(rest.is_empty() || rest.starts_with(' ') || rest.starts_with('\t')) {
        return None;
    }
    let mut r = rest.trim();
    // closing hashes: "## Title ##"
    let no_hash = r.trim_end_matches('#');
    if no_hash.len() != r.len() && (no_hash.is_empty() || no_hash.ends_with(' ')) {
        r = no_hash.trim_end();
    }
    Some((n as u8, plain_heading(r)))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = ((b[i + 1] as char).to_digit(16), (b[i + 2] as char).to_digit(16)) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

pub fn percent_encode_path(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        match ch {
            ' ' => out.push_str("%20"),
            '%' => out.push_str("%25"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            '#' => out.push_str("%23"),
            c => out.push(c),
        }
    }
    out
}

fn has_scheme(u: &str) -> bool {
    let mut it = u.chars();
    let mut n = 0;
    for c in it.by_ref() {
        if c == ':' {
            return n >= 2;
        }
        if !(c.is_ascii_alphanumeric() || c == '+' || c == '-' || c == '.') {
            return false;
        }
        n += 1;
    }
    false
}

/// `Note#Head|alias` → (target, sub, alias)
fn split_wiki(inner: &str) -> (String, String, String) {
    let inner = inner.replace("\\|", "|");
    let (left, alias) = match inner.find('|') {
        Some(i) => (&inner[..i], inner[i + 1..].trim()),
        None => (&inner[..], ""),
    };
    let (t, s) = match left.find('#') {
        Some(i) => (&left[..i], &left[i + 1..]),
        None => (left, ""),
    };
    (t.trim().to_string(), s.trim().to_string(), alias.to_string())
}

/// Block id at the end of a line: `text ^abc-1` or a line that is only `^abc`.
fn block_id(line: &str) -> Option<String> {
    let t = line.trim_end();
    let i = t.rfind('^')?;
    let id = &t[i + 1..];
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return None;
    }
    if i == 0 || t.as_bytes()[i - 1] == b' ' || t.as_bytes()[i - 1] == b'\t' {
        Some(id.to_string())
    } else {
        None
    }
}

fn scan_line(line: &str, base: usize, ln: usize, in_comment: &mut bool, p: &mut Parsed) {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if *in_comment {
            match line[i..].find("%%") {
                Some(e) => { i += e + 2; *in_comment = false; continue; }
                None => return,
            }
        }
        let c = b[i];
        if c == b'\\' {
            i += 2;
            continue;
        }
        if c == b'%' && line[i..].starts_with("%%") {
            *in_comment = true;
            i += 2;
            continue;
        }
        if c == b'`' {
            let n = b[i..].iter().take_while(|&&x| x == b'`').count();
            let fence = &line[i..i + n];
            match line[i + n..].find(fence) {
                Some(e) => i += n + e + n,
                None => i += n,
            }
            continue;
        }
        let embed = c == b'!' && b.get(i + 1) == Some(&b'[');
        let at = if embed { i + 1 } else { i };
        if b.get(at) == Some(&b'[') && b.get(at + 1) == Some(&b'[') {
            if let Some(e) = line[at + 2..].find("]]") {
                let inner = &line[at + 2..at + 2 + e];
                if !inner.contains("[[") && !inner.is_empty() {
                    let (target, sub, alias) = split_wiki(inner);
                    let end = at + 2 + e + 2;
                    p.links.push(Link { target, sub, alias, embed, md: false, line: ln, from: base + i, to: base + end, angle: false });
                    i = end;
                    continue;
                }
            }
        }
        if b.get(at) == Some(&b'[') && b.get(at + 1) != Some(&b'[') {
            // [text](url) — the text may hold balanced brackets
            let mut depth = 0i32;
            let mut j = at;
            let mut close = None;
            while j < b.len() {
                match b[j] {
                    b'\\' => j += 1,
                    b'[' => depth += 1,
                    b']' => { depth -= 1; if depth == 0 { close = Some(j); break; } }
                    _ => {}
                }
                j += 1;
            }
            if let Some(cl) = close {
                if b.get(cl + 1) == Some(&b'(') {
                    let rest = &line[cl + 2..];
                    let (url, used, angle) = if rest.starts_with('<') {
                        match rest.find('>') {
                            Some(e) if rest[e + 1..].trim_start().starts_with(')') || rest[e + 1..].trim_start().starts_with('"') => {
                                let after = rest[e + 1..].find(')');
                                match after { Some(a) => (rest[1..e].to_string(), e + 1 + a + 1, true), None => (String::new(), 0, false) }
                            }
                            _ => (String::new(), 0, false),
                        }
                    } else {
                        match rest.find(')') {
                            Some(e) => {
                                let u = rest[..e].split_whitespace().next().unwrap_or("");
                                (u.to_string(), e + 1, false)
                            }
                            None => (String::new(), 0, false),
                        }
                    };
                    if used > 0 && !url.is_empty() {
                        let end = cl + 2 + used;
                        if !has_scheme(&url) && !url.starts_with("//") {
                            let u = if angle { url.clone() } else { percent_decode(&url) };
                            let (t, s) = match u.find('#') { Some(k) => (u[..k].to_string(), u[k + 1..].to_string()), None => (u.clone(), String::new()) };
                            p.links.push(Link { target: t, sub: s, alias: line[at + 1..cl].to_string(), embed: embed, md: true, line: ln, from: base + i, to: base + end, angle });
                        }
                        i = end;
                        continue;
                    }
                }
            }
        }
        if c == b'#' {
            let prev_ok = i == 0 || line[..i].chars().next_back().map(|ch| ch.is_whitespace() || ch == '(' || ch == '>').unwrap_or(true);
            if prev_ok {
                let rest = &line[i + 1..];
                let len: usize = rest.chars().take_while(|&ch| is_tag_char(ch)).map(|ch| ch.len_utf8()).sum();
                let name = &rest[..len];
                if len > 0 && name.chars().any(|ch| !ch.is_ascii_digit()) {
                    let name = name.trim_end_matches('/');
                    if !name.is_empty() {
                        p.tags.push((name.to_string(), ln));
                    }
                    i += 1 + len;
                    continue;
                }
            }
        }
        i += line[i..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
    }
}

pub fn parse(text: &str) -> Parsed {
    let mut p = Parsed::default();
    let fm = fm_range(text);
    if let Some((a, z, _)) = fm {
        for e in fm_entries(&text[a..z], 0) {
            let lk = e.key.to_lowercase();
            if lk == "aliases" || lk == "alias" {
                p.aliases.extend(e.value().list());
            } else if lk == "tags" || lk == "tag" {
                p.fm_tags.extend(e.value().list().into_iter().map(|t| t.trim_start_matches('#').to_string()).filter(|t| !t.is_empty()));
            }
        }
    }
    let skip_until = fm.map(|f| f.2).unwrap_or(0);
    let mut fence: Option<(u8, usize)> = None;
    let mut in_math = false;
    let mut in_comment = false;
    let mut prev_blank = true;
    let mut prev_block_start: Option<usize> = None;
    let _ = &mut prev_block_start;
    for (ln, (off, line)) in lines_of(text).into_iter().enumerate() {
        if off < skip_until {
            continue;
        }
        let tl = line.trim_start();
        if let Some((ch, n)) = fence {
            let c = tl.bytes().take_while(|&x| x == ch).count();
            if c >= n && tl[c..].trim().is_empty() {
                fence = None;
            }
            continue;
        }
        if tl.starts_with("```") || tl.starts_with("~~~") {
            let ch = tl.as_bytes()[0];
            let n = tl.bytes().take_while(|&x| x == ch).count();
            fence = Some((ch, n));
            continue;
        }
        if tl.starts_with("$$") {
            let closes = tl[2..].contains("$$");
            if !closes { in_math = !in_math; }
            continue;
        }
        if in_math {
            if tl.contains("$$") { in_math = false; }
            continue;
        }
        if !in_comment {
            if let Some((level, text)) = heading_of(line) {
                p.headings.push(Heading { level, text, line: ln });
            }
            if let Some(id) = block_id(line) {
                p.blocks.push(Block { id, line: ln });
            }
        }
        let _ = prev_blank;
        prev_blank = line.trim().is_empty();
        scan_line(line, off, ln, &mut in_comment, &mut p);
    }
    p
}

// ---------------------------------------------------------------- Properties (YAML frontmatter)

#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    Null,
    Str(String),
    Num(String),
    Bool(bool),
    List(Vec<String>),
    /// nested maps and multi-line text: shown read-only, never rewritten
    Complex(String),
}
impl Val {
    pub fn list(&self) -> Vec<String> {
        match self {
            Val::List(v) => v.clone(),
            Val::Str(s) if !s.is_empty() => s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
            _ => vec![],
        }
    }
}

#[derive(Clone, Debug)]
pub struct Entry {
    pub key: String,
    /// byte range of the entry's lines (first line start .. end of last line incl. its newline)
    pub from: usize,
    pub to: usize,
    pub raw: String,
    pub items: Vec<String>,
    pub continued: bool,
    pub nested: bool,
    pub inline_list: bool,
}
impl Entry {
    pub fn value(&self) -> Val {
        let raw = self.raw.trim();
        if self.nested || (!raw.is_empty() && self.continued && !self.items_only()) || raw == "|" || raw == ">" || raw.starts_with("|-") || raw.starts_with(">-") || raw.starts_with('{') {
            return Val::Complex(raw.to_string());
        }
        if raw.is_empty() {
            return if self.items.is_empty() { Val::Null } else { Val::List(self.items.iter().map(|s| unquote(s)).collect()) };
        }
        if raw.starts_with('[') && raw.ends_with(']') {
            return Val::List(split_inline(&raw[1..raw.len() - 1]));
        }
        let s = strip_comment(raw);
        if s.starts_with('"') || s.starts_with('\'') {
            return Val::Str(unquote(&s));
        }
        match s.as_str() {
            "true" | "True" | "TRUE" => return Val::Bool(true),
            "false" | "False" | "FALSE" => return Val::Bool(false),
            "null" | "~" => return Val::Null,
            _ => {}
        }
        if is_number(&s) {
            return Val::Num(s);
        }
        Val::Str(s)
    }
    fn items_only(&self) -> bool {
        self.continued && self.raw.trim().is_empty()
    }
}

fn is_number(s: &str) -> bool {
    let t = s.strip_prefix('-').unwrap_or(s);
    !t.is_empty() && t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) && t.chars().all(|c| c.is_ascii_digit() || c == '.') && t.matches('.').count() <= 1 && !t.ends_with('.')
}

fn strip_comment(s: &str) -> String {
    let t = s.trim();
    if t.starts_with('"') || t.starts_with('\'') {
        let q = t.as_bytes()[0];
        let mut i = 1;
        let b = t.as_bytes();
        while i < b.len() {
            if q == b'"' && b[i] == b'\\' { i += 2; continue; }
            if b[i] == q {
                if q == b'\'' && b.get(i + 1) == Some(&b'\'') { i += 2; continue; }
                return t[..i + 1].to_string();
            }
            i += 1;
        }
        return t.to_string();
    }
    match t.find(" #") {
        Some(i) => t[..i].trim_end().to_string(),
        None => t.to_string(),
    }
}

pub fn unquote(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        let mut out = String::new();
        let mut it = t[1..t.len() - 1].chars();
        while let Some(c) = it.next() {
            if c == '\\' {
                match it.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some(o) => out.push(o),
                    None => {}
                }
            } else {
                out.push(c);
            }
        }
        out
    } else if t.len() >= 2 && t.starts_with('\'') && t.ends_with('\'') {
        t[1..t.len() - 1].replace("''", "'")
    } else {
        t.to_string()
    }
}

fn split_inline(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut q: Option<char> = None;
    for c in s.chars() {
        match q {
            Some(qc) => { cur.push(c); if c == qc { q = None; } }
            None => match c {
                '"' | '\'' => { q = Some(c); cur.push(c); }
                ',' => { out.push(unquote(cur.trim())); cur.clear(); }
                _ => cur.push(c),
            },
        }
    }
    if !cur.trim().is_empty() {
        out.push(unquote(cur.trim()));
    }
    out.into_iter().filter(|x| !x.is_empty()).collect()
}

/// The properties in `yaml` (the text between the `---` lines); `base` is added to byte offsets.
pub fn fm_entries(yaml: &str, base: usize) -> Vec<Entry> {
    let mut out: Vec<Entry> = Vec::new();
    for (off, line) in lines_of(yaml) {
        let end = {
            let rest = &yaml[off..];
            off + rest.find('\n').map(|i| i + 1).unwrap_or(rest.len())
        };
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        let first = line.chars().next().unwrap();
        let is_item = line.trim_start().starts_with("- ") || line.trim() == "-";
        if !first.is_whitespace() && !(is_item && first == '-') {
            if let Some(ci) = find_colon(line) {
                let key = unquote(line[..ci].trim());
                out.push(Entry { key, from: base + off, to: base + end, raw: line[ci + 1..].trim().to_string(), items: vec![], continued: false, nested: false, inline_list: false });
                let e = out.last_mut().unwrap();
                e.inline_list = e.raw.starts_with('[');
                continue;
            }
        }
        if let Some(e) = out.last_mut() {
            e.to = base + end;
            e.continued = true;
            if is_item {
                let t = line.trim_start();
                let item = t[1..].trim();
                e.items.push(strip_comment(item));
            } else if e.raw.trim().is_empty() && find_colon(line.trim()).is_some() {
                e.nested = true;
            }
        }
    }
    out
}

fn find_colon(line: &str) -> Option<usize> {
    let b = line.as_bytes();
    let mut q: Option<u8> = None;
    for i in 0..b.len() {
        match q {
            Some(qc) => if b[i] == qc { q = None; },
            None => match b[i] {
                b'"' | b'\'' if i == 0 => q = Some(b[i]),
                b':' if i + 1 == b.len() || b[i + 1] == b' ' || b[i + 1] == b'\t' => return Some(i),
                _ => {}
            },
        }
    }
    None
}

fn looks_special(s: &str) -> bool {
    let l = s.to_lowercase();
    matches!(l.as_str(), "true" | "false" | "null" | "yes" | "no" | "on" | "off" | "~")
}

fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 10 || !b[..10].iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() }) {
        return false;
    }
    s.len() == 10 || (b[10] == b'T' && s[11..].chars().all(|c| c.is_ascii_digit() || c == ':' || c == '.' || c == 'Z' || c == '+' || c == '-'))
}

/// A scalar as YAML text, quoted only when it has to be.
pub fn scalar(s: &str, in_inline_list: bool) -> String {
    let needs = s.is_empty()
        || s != s.trim()
        || s.chars().any(|c| c.is_control())
        || s.starts_with(|c: char| "[]{}&*!|>'\"%@`#?,:".contains(c))
        || (s.starts_with('-') && (s.len() == 1 || s.as_bytes()[1] == b' '))
        || s.contains(": ")
        || s.contains(" #")
        || s.ends_with(':')
        || looks_special(s)
        || (is_number(s) && !is_date(s))
        || (in_inline_list && s.contains(|c| ",[]{}".contains(c)));
    if !needs {
        return s.to_string();
    }
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\t' => o.push_str("\\t"),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn eol_of(text: &str) -> &'static str {
    if text.contains("\r\n") { "\r\n" } else { "\n" }
}

fn render(key: &str, v: &Val, inline_list: bool, eol: &str) -> String {
    let k = if key.is_empty() || key.contains(|c: char| ":#[]{}\"'".contains(c)) || key != key.trim() { scalar(key, false) } else { key.to_string() };
    match v {
        Val::Null => format!("{k}:{eol}"),
        Val::Str(s) => format!("{k}: {}{eol}", scalar(s, false)),
        Val::Num(n) => format!("{k}: {n}{eol}"),
        Val::Bool(b) => format!("{k}: {b}{eol}"),
        Val::Complex(s) => format!("{k}: {s}{eol}"),
        Val::List(items) if items.is_empty() => if inline_list { format!("{k}: []{eol}") } else { format!("{k}:{eol}") },
        Val::List(items) if inline_list => format!("{k}: [{}]{eol}", items.iter().map(|i| scalar(i, true)).collect::<Vec<_>>().join(", ")),
        Val::List(items) => {
            let mut s = format!("{k}:{eol}");
            for i in items {
                s.push_str(&format!("  - {}{eol}", scalar(i, false)));
            }
            s
        }
    }
}

/// All properties of a note: `(key, value)` in file order.
pub fn props_of(text: &str) -> Vec<(String, Val)> {
    match fm_range(text) {
        Some((a, z, _)) => fm_entries(&text[a..z], 0).into_iter().map(|e| (e.key.clone(), e.value())).collect(),
        None => vec![],
    }
}

/// Set (or add) property `key`; every other line stays exactly as it was. A value equal to the
/// current one changes nothing at all.
pub fn set_prop(text: &str, key: &str, v: &Val) -> String {
    let eol = eol_of(text);
    match fm_range(text) {
        None => {
            let body = render(key, v, false, eol);
            format!("---{eol}{body}---{eol}{text}")
        }
        Some((a, z, _)) => {
            let ents = fm_entries(&text[a..z], a);
            if let Some(e) = ents.iter().find(|e| e.key == key) {
                if e.value() == *v {
                    return text.to_string();
                }
                let nl = render(key, v, e.inline_list, eol);
                // keep the original line's own end (a last line without a newline) out of it
                let mut to = e.to;
                let mut ins = nl;
                if !text[e.from..to].ends_with('\n') { ins = ins.trim_end_matches(&['\r', '\n'][..]).to_string(); }
                if to > z { to = z; }
                format!("{}{}{}", &text[..e.from], ins, &text[to..])
            } else {
                let mut head = text[..z].to_string();
                if !head.ends_with('\n') && z > a { head.push_str(eol); }
                format!("{}{}{}", head, render(key, v, false, eol), &text[z..])
            }
        }
    }
}

pub fn remove_prop(text: &str, key: &str) -> String {
    if let Some((a, z, _)) = fm_range(text) {
        if let Some(e) = fm_entries(&text[a..z], a).into_iter().find(|e| e.key == key) {
            return format!("{}{}", &text[..e.from], &text[e.to.min(z)..]);
        }
    }
    text.to_string()
}

pub fn rename_prop(text: &str, key: &str, new_key: &str) -> String {
    if let Some((a, z, _)) = fm_range(text) {
        let ents = fm_entries(&text[a..z], a);
        if ents.iter().any(|e| e.key == new_key) {
            return text.to_string();
        }
        if let Some(e) = ents.into_iter().find(|e| e.key == key) {
            let line_end = text[e.from..].find(':').map(|i| e.from + i).unwrap_or(e.from);
            let nk = if new_key.contains(|c: char| ":#".contains(c)) { scalar(new_key, false) } else { new_key.to_string() };
            return format!("{}{}{}", &text[..e.from], nk, &text[line_end..]);
        }
    }
    text.to_string()
}

/// The note without its frontmatter.
pub fn strip_fm(text: &str) -> &str {
    match fm_range(text) {
        Some((_, _, e)) => &text[e..],
        None => text,
    }
}

// ---------------------------------------------------------------- sections and blocks

fn norm_head(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() { c.to_lowercase().next().unwrap_or(c) } else { ' ' }).collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}
pub fn same_heading(a: &str, b: &str) -> bool {
    norm_head(a) == norm_head(b)
}

/// The text of the section under heading `head` (up to the next heading of the same or a higher
/// level), heading line included.
pub fn section_of(text: &str, head: &str) -> Option<String> {
    let want = head.rsplit('#').next().unwrap_or(head);
    let lines: Vec<&str> = text.lines().collect();
    let p = parse(text);
    let h = p.headings.iter().position(|h| same_heading(&h.text, want))?;
    let start = p.headings[h].line;
    let level = p.headings[h].level;
    let end = p.headings[h + 1..].iter().find(|x| x.level <= level).map(|x| x.line).unwrap_or(lines.len());
    Some(lines[start..end.min(lines.len())].join("\n").trim_end().to_string())
}

/// The block that ends with `^id`: its paragraph (or the one list item line).
pub fn block_of(text: &str, id: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    let p = parse(text);
    let b = p.blocks.iter().find(|b| b.id.eq_ignore_ascii_case(id))?;
    let mut end = b.line;
    let mut s = b.line;
    let only_id = lines[b.line].trim() == format!("^{}", b.id);
    if lines[b.line].trim_start().starts_with("- ") || lines[b.line].trim_start().starts_with("* ") {
        // a list item: just that line
    } else {
        if only_id && s > 0 { end = s - 1; }
        let mut st = end;
        while st > 0 && !lines[st - 1].trim().is_empty() && heading_of(lines[st - 1]).is_none() { st -= 1; }
        s = st;
    }
    let mut out: Vec<String> = lines[s..=end.min(lines.len() - 1)].iter().map(|l| l.to_string()).collect();
    if let Some(l) = out.last_mut() {
        let t = l.trim_end().to_string();
        *l = t.trim_end_matches(&format!("^{}", b.id)[..]).trim_end().to_string();
    }
    Some(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTE: &str = "---\ntitle: Hello\ntags: [a, b/c]\naliases:\n  - Hi\n  - \"Howdy: x\"\ndone: true\ncount: 3\ndate: 2025-01-02\n---\n# Top\nSee [[Other note#Part|shown]] and ![[pic.png|300]] and [md](Folder/My%20Note.md#H).\n`[[not]]` and #tag1 #nest/ed %%[[hidden]] #no%% end ^blk-1\n\n```\n[[code]] #nope\n```\n## Part two ##\nhttp://x.com/#frag [[#Self]] [[a\\|b]]\n";

    #[test]
    fn parses_frontmatter_lists() {
        let p = parse(NOTE);
        assert_eq!(p.aliases, vec!["Hi", "Howdy: x"]);
        assert_eq!(p.fm_tags, vec!["a", "b/c"]);
    }
    #[test]
    fn parses_links_tags_headings_blocks() {
        let p = parse(NOTE);
        let l: Vec<_> = p.links.iter().map(|l| (l.target.as_str(), l.sub.as_str(), l.alias.as_str(), l.embed, l.md)).collect();
        assert_eq!(l, vec![
            ("Other note", "Part", "shown", false, false),
            ("pic.png", "", "300", true, false),
            ("Folder/My Note.md", "H", "md", false, true),
            ("", "Self", "", false, false),
            ("a", "", "b", false, false),
        ]);
        let tags: Vec<_> = p.tags.iter().map(|t| t.0.as_str()).collect();
        assert_eq!(tags, vec!["tag1", "nest/ed"]);
        assert_eq!(p.headings.iter().map(|h| (h.level, h.text.as_str())).collect::<Vec<_>>(), vec![(1, "Top"), (2, "Part two")]);
        assert_eq!(p.blocks.len(), 1);
        assert_eq!(p.blocks[0].id, "blk-1");
    }
    #[test]
    fn link_byte_ranges_cover_the_source() {
        let p = parse(NOTE);
        assert_eq!(&NOTE[p.links[0].from..p.links[0].to], "[[Other note#Part|shown]]");
        assert_eq!(&NOTE[p.links[1].from..p.links[1].to], "![[pic.png|300]]");
        assert_eq!(&NOTE[p.links[2].from..p.links[2].to], "[md](Folder/My%20Note.md#H)");
    }
    #[test]
    fn digits_alone_are_not_tags() {
        let p = parse("issue #123 and #12a and (#x)\n");
        assert_eq!(p.tags.iter().map(|t| t.0.clone()).collect::<Vec<_>>(), vec!["12a", "x"]);
    }
    #[test]
    fn vietnamese_tags_and_headings() {
        let p = parse("# Chào thế giới\n#việc-cần-làm xong\n");
        assert_eq!(p.headings[0].text, "Chào thế giới");
        assert_eq!(p.tags[0].0, "việc-cần-làm");
    }
    #[test]
    fn props_round_trip_keeps_untouched_lines() {
        let t = NOTE;
        for (k, v) in props_of(t) {
            assert_eq!(set_prop(t, &k, &v), t, "setting {k} to its own value must change nothing");
        }
    }
    #[test]
    fn props_types() {
        let v: Vec<_> = props_of(NOTE);
        assert_eq!(v[0], ("title".into(), Val::Str("Hello".into())));
        assert_eq!(v[1].1, Val::List(vec!["a".into(), "b/c".into()]));
        assert_eq!(v[3].1, Val::Bool(true));
        assert_eq!(v[4].1, Val::Num("3".into()));
        assert_eq!(v[5].1, Val::Str("2025-01-02".into()));
    }
    #[test]
    fn set_replaces_only_that_key() {
        let out = set_prop(NOTE, "tags", &Val::List(vec!["x".into(), "y z".into()]));
        assert!(out.contains("tags: [x, y z]\n"), "{out}");
        assert!(out.contains("title: Hello\n") && out.contains("aliases:\n  - Hi\n"));
        let out = set_prop(NOTE, "aliases", &Val::List(vec!["One".into()]));
        assert!(out.contains("aliases:\n  - One\ndone: true"), "{out}");
        let out = set_prop(NOTE, "title", &Val::Str("Needs: quotes".into()));
        assert!(out.contains("title: \"Needs: quotes\"\ntags:"), "{out}");
    }
    #[test]
    fn add_remove_rename() {
        let out = set_prop(NOTE, "status", &Val::Str("draft".into()));
        assert!(out.contains("date: 2025-01-02\nstatus: draft\n---\n# Top"), "{out}");
        assert_eq!(remove_prop(&out, "status"), NOTE);
        let r = rename_prop(NOTE, "count", "total");
        assert!(r.contains("total: 3\n") && !r.contains("count:"));
    }
    #[test]
    fn creates_frontmatter_and_keeps_crlf() {
        assert_eq!(set_prop("# Hi\n", "a", &Val::Num("1".into())), "---\na: 1\n---\n# Hi\n");
        let crlf = "---\r\na: 1\r\n---\r\nBody\r\n";
        let out = set_prop(crlf, "b", &Val::Bool(false));
        assert_eq!(out, "---\r\na: 1\r\nb: false\r\n---\r\nBody\r\n");
    }
    #[test]
    fn strings_that_look_like_other_types_are_quoted() {
        assert_eq!(scalar("true", false), "\"true\"");
        assert_eq!(scalar("12", false), "\"12\"");
        assert_eq!(scalar("2025-01-02", false), "2025-01-02");
        assert_eq!(scalar("plain text", false), "plain text");
        assert_eq!(scalar("#tag", false), "\"#tag\"");
    }
    #[test]
    fn sections_and_blocks() {
        let t = "# A\nintro\n## B\nbody b\n### C\ndeep\n## D\nlast ^id1\n\npara one\nline two ^id2\n";
        assert_eq!(section_of(t, "B").unwrap(), "## B\nbody b\n### C\ndeep");
        assert_eq!(section_of(t, "b").unwrap().lines().count(), 4);
        assert_eq!(block_of(t, "id2").unwrap(), "para one\nline two");
        assert_eq!(block_of(t, "id1").unwrap(), "last");
    }
    #[test]
    fn fm_range_basics() {
        assert!(fm_range("---\na: 1\n---\nx").is_some());
        assert!(fm_range("text\n---\na: 1\n---\n").is_none());
        assert!(fm_range("---\na: 1\n").is_none());
        assert_eq!(strip_fm("---\na: 1\n---\nx"), "x");
    }
}
