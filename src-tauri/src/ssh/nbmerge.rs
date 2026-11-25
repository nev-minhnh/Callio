//! Merging a notebook edited on both sides, cell by cell (nbformat 4.5 gives every cell an `id`).
//! Edits to different cells merge by themselves. The same cell edited on both sides, a cell
//! deleted on one side and edited on the other, a clash in the order, or cells without ids make
//! `merge` fail with the reason — the caller then keeps both versions. When only the OUTPUTS of a
//! cell differ (the cell was run on both sides), the one that ran last wins (setting).
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prefer {
    /// the side whose cell has the newest execution timestamp (file time when there is none)
    Newest,
    Local,
    Server,
}

fn src_text(c: &Value) -> String {
    match &c["source"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|x| x.as_str()).collect(),
        _ => String::new(),
    }
}

/// Everything about a cell except what running it changes.
fn core(c: &Value) -> Value {
    let mut meta = c["metadata"].as_object().cloned().unwrap_or_default();
    meta.remove("execution");
    meta.remove("collapsed");
    meta.remove("scrolled");
    json!({"t": c["cell_type"], "s": src_text(c), "m": meta, "a": c["attachments"]})
}

/// What running the cell produced.
fn outs(c: &Value) -> Value {
    json!({"o": c["outputs"], "n": c["execution_count"]})
}

fn stamp(c: &Value) -> Option<String> {
    let e = &c["metadata"]["execution"];
    e["shell.execute_reply"].as_str().or_else(|| e["iopub.execute_input"].as_str()).map(String::from)
}

fn cells_of(nb: &Value) -> Result<Vec<Value>, String> {
    nb["cells"].as_array().cloned().ok_or_else(|| "not a notebook".to_string())
}

fn ids(cells: &[Value]) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for c in cells {
        let id = c["id"].as_str().ok_or("a cell has no id")?.to_string();
        if !seen.insert(id.clone()) {
            return Err("two cells share an id".into());
        }
        out.push(id);
    }
    Ok(out)
}

pub fn merge(base: &Value, local: &Value, remote: &Value, prefer: Prefer, local_newer: bool) -> Result<Value, String> {
    let (cb, cl, cr) = (cells_of(base)?, cells_of(local)?, cells_of(remote)?);
    let (ib, il, ir) = (ids(&cb)?, ids(&cl)?, ids(&cr)?);
    let map = |cs: &[Value], is: &[String]| -> HashMap<String, Value> { is.iter().cloned().zip(cs.iter().cloned()).collect() };
    let (mb, ml, mr) = (map(&cb, &ib), map(&cl, &il), map(&cr, &ir));
    let pick_out = |l: &Value, r: &Value| -> Value {
        match prefer {
            Prefer::Local => l.clone(),
            Prefer::Server => r.clone(),
            Prefer::Newest => match (stamp(l), stamp(r)) {
                (Some(a), Some(b)) if a != b => if a > b { l.clone() } else { r.clone() },
                (Some(_), None) => l.clone(),
                (None, Some(_)) => r.clone(),
                _ => if local_newer { l.clone() } else { r.clone() },
            },
        }
    };
    let mut result: HashMap<String, Value> = HashMap::new();
    let all: Vec<&String> = il.iter().chain(ir.iter()).chain(ib.iter()).collect();
    for id in all {
        if result.contains_key(id) {
            continue;
        }
        let (b, l, r) = (mb.get(id), ml.get(id), mr.get(id));
        let cell = match (b, l, r) {
            (Some(_), None, None) => continue,
            (None, Some(l), None) => l.clone(),
            (None, None, Some(r)) => r.clone(),
            (None, Some(l), Some(r)) => {
                if core(l) != core(r) {
                    return Err(format!("cell {id} was added differently on both sides"));
                }
                if outs(l) == outs(r) { l.clone() } else { pick_out(l, r) }
            }
            (Some(b), None, Some(r)) => {
                if core(r) != core(b) {
                    return Err(format!("cell {id} was deleted here and edited on the server"));
                }
                continue;
            }
            (Some(b), Some(l), None) => {
                if core(l) != core(b) {
                    return Err(format!("cell {id} was edited here and deleted on the server"));
                }
                continue;
            }
            (Some(b), Some(l), Some(r)) => {
                let (xl, xr) = (core(l) != core(b), core(r) != core(b));
                match (xl, xr) {
                    (true, true) => {
                        if core(l) != core(r) {
                            return Err(format!("cell {id} was edited on both sides"));
                        }
                        if outs(l) == outs(r) { l.clone() } else { pick_out(l, r) }
                    }
                    (true, false) => l.clone(),
                    (false, true) => r.clone(),
                    (false, false) => {
                        let (ol, or_, ob) = (outs(l), outs(r), outs(b));
                        if ol == or_ || or_ == ob { l.clone() } else if ol == ob { r.clone() } else { pick_out(l, r) }
                    }
                }
            }
            (None, None, None) => continue,
        };
        result.insert(id.clone(), cell);
    }
    // order
    let keep = |v: &[String]| -> Vec<String> { v.iter().filter(|i| result.contains_key(*i)).cloned().collect() };
    let (kb, kl, kr) = (keep(&ib), keep(&il), keep(&ir));
    let in_all = |i: &&String| mb.contains_key(*i) && ml.contains_key(*i) && mr.contains_key(*i);
    let common = |v: &[String]| -> Vec<String> { v.iter().filter(in_all).cloned().collect() };
    let (sb, sl, sr) = (common(&kb), common(&kl), common(&kr));
    let (skeleton, other): (Vec<String>, Vec<String>) = if sl == sb {
        (kr.clone(), kl.clone())
    } else if sr == sb || sl == sr {
        (kl.clone(), kr.clone())
    } else {
        return Err("the cells were reordered differently on both sides".into());
    };
    let mut order = skeleton;
    let mut present: HashSet<String> = order.iter().cloned().collect();
    for (i, id) in other.iter().enumerate() {
        if present.contains(id) {
            continue;
        }
        let at = other[..i].iter().rev().find_map(|p| order.iter().position(|x| x == p)).map(|p| p + 1).unwrap_or(0);
        order.insert(at, id.clone());
        present.insert(id.clone());
    }
    // notebook-level metadata, key by key
    let mut meta = Map::new();
    let (mbm, mlm, mrm) = (base["metadata"].as_object().cloned().unwrap_or_default(), local["metadata"].as_object().cloned().unwrap_or_default(), remote["metadata"].as_object().cloned().unwrap_or_default());
    let keys: HashSet<&String> = mbm.keys().chain(mlm.keys()).chain(mrm.keys()).collect();
    for k in keys {
        let (b, l, r) = (mbm.get(k), mlm.get(k), mrm.get(k));
        let v = if l == r { l } else if l == b { r } else { l };
        if let Some(v) = v {
            meta.insert(k.clone(), v.clone());
        }
    }
    let mut out = local.clone();
    out["cells"] = Value::Array(order.iter().filter_map(|i| result.get(i).cloned()).collect());
    out["metadata"] = Value::Object(meta);
    let minor = local["nbformat_minor"].as_u64().max(remote["nbformat_minor"].as_u64()).unwrap_or(5);
    out["nbformat_minor"] = json!(minor);
    Ok(out)
}

/// Serialise like Jupyter does: 1-space indent, sorted keys, UTF-8, trailing newline.
pub fn to_string(nb: &Value) -> String {
    use serde::Serialize;
    let mut buf = Vec::new();
    let f = serde_json::ser::PrettyFormatter::with_indent(b" ");
    let mut s = serde_json::Serializer::with_formatter(&mut buf, f);
    if nb.serialize(&mut s).is_err() {
        return nb.to_string();
    }
    let mut t = String::from_utf8(buf).unwrap_or_default();
    t.push('\n');
    t
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cell(id: &str, src: &str) -> Value {
        json!({"cell_type": "code", "id": id, "metadata": {}, "source": src, "outputs": [], "execution_count": null})
    }
    fn nb(cells: Vec<Value>) -> Value {
        json!({"cells": cells, "metadata": {"kernelspec": {"name": "python3"}}, "nbformat": 4, "nbformat_minor": 5})
    }
    #[test]
    fn disjoint_edits_merge() {
        let b = nb(vec![cell("a", "1"), cell("b", "2"), cell("c", "3")]);
        let l = nb(vec![cell("a", "1!"), cell("b", "2"), cell("c", "3")]);
        let r = nb(vec![cell("a", "1"), cell("b", "2"), cell("c", "3!"), cell("d", "new")]);
        let m = merge(&b, &l, &r, Prefer::Newest, true).unwrap();
        let s: Vec<_> = m["cells"].as_array().unwrap().iter().map(|c| c["source"].as_str().unwrap().to_string()).collect();
        assert_eq!(s, vec!["1!", "2", "3!", "new"]);
    }
    #[test]
    fn same_cell_conflicts() {
        let b = nb(vec![cell("a", "1")]);
        assert!(merge(&b, &nb(vec![cell("a", "x")]), &nb(vec![cell("a", "y")]), Prefer::Newest, true).is_err());
        assert!(merge(&b, &nb(vec![cell("a", "x")]), &nb(vec![cell("a", "x")]), Prefer::Newest, true).is_ok());
    }
    #[test]
    fn delete_vs_edit() {
        let b = nb(vec![cell("a", "1"), cell("b", "2")]);
        let l = nb(vec![cell("a", "1")]);
        let r = nb(vec![cell("a", "1"), cell("b", "2!")]);
        assert!(merge(&b, &l, &r, Prefer::Newest, true).is_err());
        let r2 = nb(vec![cell("a", "1!"), cell("b", "2")]);
        let m = merge(&b, &l, &r2, Prefer::Newest, true).unwrap();
        assert_eq!(m["cells"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn outputs_newest_wins() {
        let mut cl = cell("a", "1");
        cl["outputs"] = json!([{"output_type": "stream", "name": "stdout", "text": "L"}]);
        cl["metadata"] = json!({"execution": {"shell.execute_reply": "2026-01-01T10:00:00Z"}});
        let mut cr = cell("a", "1");
        cr["outputs"] = json!([{"output_type": "stream", "name": "stdout", "text": "R"}]);
        cr["metadata"] = json!({"execution": {"shell.execute_reply": "2026-01-02T10:00:00Z"}});
        let b = nb(vec![cell("a", "1")]);
        let m = merge(&b, &nb(vec![cl.clone()]), &nb(vec![cr.clone()]), Prefer::Newest, true).unwrap();
        assert_eq!(m["cells"][0]["outputs"][0]["text"], "R");
        let m = merge(&b, &nb(vec![cl]), &nb(vec![cr]), Prefer::Local, false).unwrap();
        assert_eq!(m["cells"][0]["outputs"][0]["text"], "L");
    }
    #[test]
    fn order_clash() {
        let b = nb(vec![cell("a", "1"), cell("b", "2"), cell("c", "3")]);
        let l = nb(vec![cell("b", "2"), cell("a", "1"), cell("c", "3")]);
        let r = nb(vec![cell("a", "1"), cell("c", "3"), cell("b", "2")]);
        assert!(merge(&b, &l, &r, Prefer::Newest, true).is_err());
        let m = merge(&b, &l, &nb(vec![cell("a", "1"), cell("b", "2"), cell("c", "3"), cell("z", "9")]), Prefer::Newest, true).unwrap();
        let o: Vec<_> = m["cells"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(o, vec!["b", "a", "c", "z"]);
    }
    #[test]
    fn missing_ids() {
        let mut c = cell("a", "1");
        c.as_object_mut().unwrap().remove("id");
        assert!(merge(&nb(vec![c.clone()]), &nb(vec![c.clone()]), &nb(vec![c]), Prefer::Newest, true).is_err());
    }
    #[test]
    fn serialises_like_jupyter() {
        let s = to_string(&nb(vec![cell("a", "é")]));
        assert!(s.starts_with("{\n \"cells\": ["));
        assert!(s.contains("é") && s.ends_with("}\n"));
        assert!(s.find("\"cells\"").unwrap() < s.find("\"metadata\"").unwrap());
    }
}
