//! Small full-text index (BM25) shared by the paper library and project memory. Pure Rust,
//! in memory, built on demand — no database, no embeddings, nothing to install.
use std::collections::HashMap;

const STOP: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "do", "for", "from", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "of", "on", "or", "our", "so", "such", "than", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "we", "were", "what", "when", "where", "which", "while", "who", "will", "with", "you", "your", "not", "no", "also", "may", "more", "most", "other", "some", "all", "any", "each", "both", "about", "over", "only", "very", "via", "using", "use", "used", "between", "within", "et", "al",
];

fn stem(w: &str) -> String {
    // light, predictable stemming: plurals and common suffixes
    let n = w.chars().count();
    if n > 5 {
        for suf in ["ations", "ation", "ings", "ing", "edly", "ies", "ed", "es"] {
            if let Some(b) = w.strip_suffix(suf) {
                if b.chars().count() >= 4 {
                    return if suf == "ies" { format!("{b}y") } else { b.to_string() };
                }
            }
        }
    }
    if n > 3 && w.ends_with('s') && !w.ends_with("ss") && !w.ends_with("us") && !w.ends_with("is") {
        return w[..w.len() - 1].to_string();
    }
    w.to_string()
}

/// Lowercase words (letters/digits in any script), stop-words removed, lightly stemmed.
pub fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        if cur.chars().count() >= 2 && !STOP.contains(&cur.as_str()) {
            out.push(stem(cur));
        }
        cur.clear();
    };
    for c in s.chars() {
        if c.is_alphanumeric() {
            for l in c.to_lowercase() {
                cur.push(l);
            }
        } else {
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

#[derive(Default)]
pub struct Index {
    lens: Vec<f32>,
    postings: HashMap<String, Vec<(u32, f32)>>,
    avgdl: f32,
}

impl Index {
    /// Add document `doc` (ids must be 0..n in order) from weighted fields.
    pub fn add(&mut self, doc: u32, fields: &[(&str, f32)]) {
        let mut tf: HashMap<String, f32> = HashMap::new();
        let mut len = 0f32;
        for (text, w) in fields {
            for t in tokenize(text) {
                *tf.entry(t).or_default() += w;
                len += w;
            }
        }
        while self.lens.len() <= doc as usize {
            self.lens.push(0.0);
        }
        self.lens[doc as usize] = len;
        for (t, f) in tf {
            self.postings.entry(t).or_default().push((doc, f));
        }
    }

    pub fn finish(&mut self) {
        let n = self.lens.len().max(1) as f32;
        self.avgdl = self.lens.iter().sum::<f32>() / n;
        if self.avgdl <= 0.0 {
            self.avgdl = 1.0;
        }
    }

    /// BM25 scores for a query; `filter(doc)` limits the candidates.
    pub fn search(&self, query: &str, limit: usize, filter: impl Fn(u32) -> bool) -> Vec<(u32, f32)> {
        let (k1, b) = (1.2f32, 0.75f32);
        let n = self.lens.len() as f32;
        let mut scores: HashMap<u32, f32> = HashMap::new();
        let mut terms = tokenize(query);
        terms.sort();
        terms.dedup();
        for t in &terms {
            let Some(p) = self.postings.get(t) else { continue };
            let idf = ((n - p.len() as f32 + 0.5) / (p.len() as f32 + 0.5) + 1.0).ln();
            for &(d, f) in p {
                if !filter(d) {
                    continue;
                }
                let dl = self.lens[d as usize];
                let s = idf * f * (k1 + 1.0) / (f + k1 * (1.0 - b + b * dl / self.avgdl));
                *scores.entry(d).or_default() += s;
            }
        }
        // documents matching more of the query words rank first
        let mut v: Vec<(u32, f32)> = scores.into_iter().collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.truncate(limit);
        v
    }

    /// How many distinct query terms a document contains (for "all words" ranking).
    pub fn coverage(&self, query: &str, doc: u32) -> usize {
        let mut terms = tokenize(query);
        terms.sort();
        terms.dedup();
        terms.iter().filter(|t| self.postings.get(*t).map(|p| p.iter().any(|(d, _)| *d == doc)).unwrap_or(false)).count()
    }
}

/// A short excerpt around the first place the query words occur (and its 1-based page, when
/// pages are separated by form feeds).
pub fn snippet(text: &str, query: &str, width: usize) -> Option<(String, usize)> {
    // one lowercase char per original char, so positions line up in every script
    let chars: Vec<char> = text.chars().collect();
    let lower: Vec<char> = chars.iter().map(|c| c.to_lowercase().next().unwrap_or(*c)).collect();
    let find = |needle: &str| -> Option<usize> {
        let n: Vec<char> = needle.chars().map(|c| c.to_lowercase().next().unwrap_or(c)).collect();
        if n.is_empty() || n.len() > lower.len() {
            return None;
        }
        (0..=lower.len() - n.len()).find(|&i| lower[i..i + n.len()] == n[..])
    };
    // whole phrase first, then the longest word
    let q = query.trim().trim_matches('"');
    let mut pos = if q.chars().count() > 3 { find(q) } else { None };
    if pos.is_none() {
        let mut words: Vec<&str> = q.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).collect();
        words.sort_by_key(|w| std::cmp::Reverse(w.len()));
        pos = words.iter().find_map(|w| find(w));
    }
    let ci = pos?;
    let start = ci.saturating_sub(width / 2);
    let end = (ci + width).min(chars.len()).max(start);
    let page = chars[..ci].iter().filter(|c| **c == '\x0c').count() + 1;
    let s: String = chars[start..end].iter().map(|c| if c.is_whitespace() { ' ' } else { *c }).collect();
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    Some((format!("{}{s}{}", if start > 0 { "…" } else { "" }, if end < chars.len() { "…" } else { "" }), page))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranks() {
        let mut ix = Index::default();
        ix.add(0, &[("Named entity recognition for extremist rhetoric", 3.0), ("we detect hate speech with transformers", 1.0)]);
        ix.add(1, &[("Graph neural networks", 3.0), ("message passing over graphs", 1.0)]);
        ix.add(2, &[("Hate speech detection survey", 3.0), ("entity recognition appears once", 1.0)]);
        ix.finish();
        let r = ix.search("entity recognition rhetoric", 10, |_| true);
        assert_eq!(r[0].0, 0);
        assert!(ix.search("graphs", 10, |_| true)[0].0 == 1);
        assert!(ix.search("graph", 10, |d| d != 1).is_empty());
        assert_eq!(tokenize("Detections of the Entities, running"), vec!["detection", "entity", "runn"]);
        let (s, page) = snippet("page one text\x0cthe second page talks about rhetoric here", "rhetoric", 20).unwrap();
        assert_eq!(page, 2);
        assert!(s.contains("rhetoric"));
        let turkish = "İ".repeat(200) + " match here";
        assert!(snippet(&turkish, "match", 40).unwrap().0.contains("match"));
    }
}
