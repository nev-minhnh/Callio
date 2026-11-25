//! The curated memory notes (MEMORY.md / an Obsidian project note) — the pure part (std only,
//! unit-tested on its own): fixed sections, appending to "Remember", capping the text that goes
//! into the AI's prompt, and naming notes and folders.

/// Fixed headings (the file always holds the English keys; the UI shows translated labels).
pub const SECTIONS: [&str; 6] = ["Goals", "Decisions", "Conventions", "In progress", "Open questions", "Remember"];
/// How much of the note goes into every new session's system prompt.
pub const PROMPT_CAP: usize = 4000;

pub fn template(name: &str, project_path: &str, vault: bool) -> String {
    let mut s = String::new();
    if vault {
        s.push_str(&format!("---\nprojects:\n  - \"{}\"\ntags: [callio, project]\n---\n", project_path.replace('\\', "\\\\").replace('"', "\\\"")));
    }
    s.push_str(&format!("# {}\n", if vault { name.to_string() } else { format!("Memory — {name}") }));
    for h in SECTIONS {
        s.push_str(&format!("\n## {h}\n"));
    }
    s
}

/// Add a project path to the `projects:` list of the frontmatter (once). No frontmatter → unchanged.
pub fn add_project_path(text: &str, path: &str) -> String {
    let quoted = format!("  - \"{}\"", path.replace('\\', "\\\\").replace('"', "\\\""));
    if text.lines().any(|l| l.trim() == quoted.trim()) || !text.starts_with("---\n") {
        return text.to_string();
    }
    let mut out = String::new();
    let mut done = false;
    for l in text.split_inclusive('\n') {
        out.push_str(l);
        if !done && l.trim_end() == "projects:" {
            out.push_str(&quoted);
            out.push('\n');
            done = true;
        }
    }
    out
}

/// Append a line to a section (created at the end if missing). The same line is never added twice.
pub fn append_to_section(text: &str, section: &str, line: &str) -> String {
    let line = line.trim().replace('\n', " ");
    if line.is_empty() {
        return text.to_string();
    }
    let item = format!("- {line}");
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let head = format!("## {section}");
    let Some(at) = lines.iter().position(|l| l.trim_end().eq_ignore_ascii_case(&head)) else {
        let mut out = text.trim_end().to_string();
        out.push_str(&format!("\n\n{head}\n{item}\n"));
        return out;
    };
    let end = lines.iter().skip(at + 1).position(|l| l.starts_with("## ") || l.starts_with("# ")).map(|i| at + 1 + i).unwrap_or(lines.len());
    if lines[at + 1..end].iter().any(|l| l.trim() == item) {
        return text.to_string();
    }
    // after the last non-blank line of the section
    let mut ins = end;
    while ins > at + 1 && lines[ins - 1].trim().is_empty() {
        ins -= 1;
    }
    lines.insert(ins, item);
    if ins + 1 < lines.len() && !lines[ins + 1].trim().is_empty() && lines[ins + 1].starts_with("## ") {
        lines.insert(ins + 1, String::new());
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn chars(s: &str) -> usize {
    s.chars().count()
}
fn take_tail(lines: &[&str], budget: usize) -> (Vec<String>, bool) {
    let mut keep: Vec<String> = Vec::new();
    let mut used = 0;
    for l in lines.iter().rev() {
        let n = chars(l) + 1;
        if used + n > budget {
            return (keep.into_iter().rev().collect(), true);
        }
        used += n;
        keep.push(l.to_string());
    }
    (keep.into_iter().rev().collect(), false)
}

/// The note, cut to `max` characters for the prompt: each section keeps its newest lines (they sit
/// at the end), and says that older lines were left out. No model call.
pub fn cap(text: &str, max: usize) -> String {
    let text = strip_frontmatter(text).trim().to_string();
    if chars(&text) <= max {
        return text;
    }
    let mut pre: Vec<&str> = Vec::new();
    let mut secs: Vec<(&str, Vec<&str>)> = Vec::new();
    for l in text.lines() {
        if l.starts_with("## ") {
            secs.push((l, Vec::new()));
        } else if let Some(s) = secs.last_mut() {
            if !l.trim().is_empty() {
                s.1.push(l);
            }
        } else if !l.trim().is_empty() {
            pre.push(l);
        }
    }
    let fixed: usize = pre.iter().map(|l| chars(l) + 1).sum::<usize>() + secs.iter().map(|(h, _)| chars(h) + 2).sum::<usize>() + 40;
    let mut budget = max.saturating_sub(fixed);
    // short sections keep everything; the rest share what is left
    let mut order: Vec<usize> = (0..secs.len()).collect();
    order.sort_by_key(|&i| secs[i].1.iter().map(|l| chars(l) + 1).sum::<usize>());
    let mut alloc = vec![0usize; secs.len()];
    for (k, &i) in order.iter().enumerate() {
        let need: usize = secs[i].1.iter().map(|l| chars(l) + 1).sum();
        let share = budget / (secs.len() - k).max(1);
        alloc[i] = need.min(share);
        budget = budget.saturating_sub(alloc[i]);
    }
    let mut out = pre.join("\n");
    for (i, (h, ls)) in secs.iter().enumerate() {
        out.push_str(&format!("\n\n{h}\n"));
        let (keep, cut) = take_tail(ls, alloc[i]);
        if cut {
            out.push_str("- … (older lines left out)\n");
        }
        out.push_str(&keep.join("\n"));
    }
    let out = out.trim().to_string();
    if chars(&out) > max {
        let cut: String = out.chars().take(max.saturating_sub(1)).collect();
        return format!("{cut}…");
    }
    out
}

pub fn strip_frontmatter(t: &str) -> &str {
    if let Some(rest) = t.strip_prefix("---\n").or_else(|| t.strip_prefix("---\r\n")) {
        if let Some(i) = rest.find("\n---") {
            let after = &rest[i + 4..];
            return after.trim_start_matches(['\r', '\n']);
        }
    }
    t
}

/// A file or note name that Windows and Obsidian both accept.
pub fn sanitize_title(s: &str) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if c.is_control() || "\\/:*?\"<>|#^[]".contains(c) {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let t: String = collapsed.chars().take(80).collect();
    t.trim().trim_matches('.').trim().to_string()
}

pub fn project_note_name(project_name: &str) -> String {
    let n = sanitize_title(project_name);
    format!("{}.md", if n.is_empty() { "Project".to_string() } else { n })
}

/// `YYYY-MM-DD <title>.md`
pub fn session_note_name(date: &str, title: &str) -> String {
    let n = sanitize_title(title);
    let n = if n.is_empty() { "Session".to_string() } else { n };
    format!("{date} {n}.md")
}

/// The folder names inside the Callio folder: English, or Vietnamese when the UI was Vietnamese
/// when the vault was set up.
pub fn folder_names(vi: bool) -> (&'static str, &'static str) {
    if vi {
        ("Dự án", "Phiên")
    } else {
        ("Projects", "Sessions")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn template_and_append() {
        let t = template("Thesis", "C:\\Users\\m\\thesis", true);
        assert!(t.starts_with("---\nprojects:") && t.contains("## Remember"));
        let t2 = append_to_section(&t, "Remember", "British spelling");
        assert!(t2.contains("## Remember\n- British spelling"), "{t2}");
        assert_eq!(append_to_section(&t2, "Remember", "British spelling"), t2);
        let t3 = append_to_section(&t2, "Goals", "Submit by March");
        assert!(t3.contains("## Goals\n- Submit by March\n\n## Decisions"), "{t3}");
        let t4 = append_to_section("# X\n", "Remember", "a");
        assert!(t4.ends_with("## Remember\n- a\n"));
        let t5 = add_project_path(&t, "D:\\other");
        assert!(t5.contains("  - \"D:\\\\other\"") && add_project_path(&t5, "D:\\other") == t5);
    }
    #[test]
    fn caps_to_the_budget_keeping_newest() {
        let mut t = template("P", "x", false);
        for i in 0..400 {
            t = append_to_section(&t, "Decisions", &format!("decision number {i} about something"));
        }
        t = append_to_section(&t, "Remember", "keep me");
        let c = cap(&t, PROMPT_CAP);
        assert!(c.chars().count() <= PROMPT_CAP, "{}", c.chars().count());
        assert!(c.contains("decision number 399") && !c.contains("decision number 0 ") && c.contains("older lines left out") && c.contains("keep me"));
        let short = "# a\n\n## Goals\n- x\n";
        assert_eq!(cap(short, 4000), short.trim());
        assert_eq!(cap("---\na: b\n---\nhello", 100), "hello");
    }
    #[test]
    fn names() {
        assert_eq!(session_note_name("2026-11-25", "Fix: the [intro]? #1"), "2026-11-25 Fix the intro 1.md");
        assert_eq!(session_note_name("2026-11-25", "///"), "2026-11-25 Session.md");
        assert_eq!(project_note_name("My/Thesis"), "My Thesis.md");
        assert_eq!(folder_names(true), ("Dự án", "Phiên"));
        assert_eq!(folder_names(false).0, "Projects");
    }
}
