//! Editing photos and pictures (JPEG, PNG, TIFF, WebP, AVIF, HEIC, raw camera files…) with
//! LightCraft: one LightCraft session per open picture, holding just that photo. Edits are
//! LightCraft's develop settings (non-destructive until saved); the window shows renders this
//! module makes (a fitted view, or a window of a zoomed one) and runs LightCraft commands for the
//! ribbon, the sliders and the tools drawn on the picture.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use lightcraft_engine::Session;
use lightcraft_engine::catalog::PhotoId;
use serde_json::{Value as Json, json};

pub struct Img {
    pub s: Session,
    pub id: PhotoId,
    pub path: String,
    /// Undo steps that came with opening (the import): never offered.
    base: usize,
    /// Undo depth when last saved.
    saved: usize,
    stages: Arc<lightcraft_engine::pipeline::StageCache>,
    /// A private copy LightCraft reads instead of `path` (formats Callio saves over): saving the
    /// edited picture over the original must never become the source the edits apply to again.
    copy_dir: Option<std::path::PathBuf>,
}

impl Drop for Img {
    fn drop(&mut self) {
        if let Some(d) = &self.copy_dir {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

/// Formats Callio saves over (the rest — camera raw, HEIC, GIF… — keep their edits in an .xmp).
pub const WRITES: &[&str] = &["jpg", "jpeg", "jpe", "jfif", "png", "tif", "tiff", "webp", "avif", "jxl", "psd"];

/// Picture files LightCraft opens.
pub const READS: &[&str] = &[
    "jpg", "jpeg", "jpe", "jfif", "png", "tif", "tiff", "webp", "avif", "heic", "heif", "jxl", "bmp", "gif", "psd", "dng", "cr2", "cr3", "crw", "nef",
    "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl", "pef", "srw", "x3f", "3fr", "fff", "iiq", "erf", "mef", "mos", "kdc", "dcr",
];

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn open(path: &str) -> Result<Img, String> {
    let ext = std::path::Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut copy_dir = None;
    let mut src = path.to_string();
    if WRITES.contains(&ext.as_str()) {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!("callio-img-{}-{}", std::process::id(), N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir_all(&d).map_err(|e| format!("{path}: {e}"))?;
        let name = std::path::Path::new(path).file_name().map(|n| n.to_owned()).unwrap_or_else(|| "picture".into());
        let c = d.join(name);
        std::fs::copy(path, &c).map_err(|e| format!("{path}: {e}"))?;
        src = c.to_string_lossy().into_owned();
        copy_dir = Some(d);
    }
    let mut s = Session::new().with_fs();
    let r = s.execute("library.import", &json!({ "paths": [src] })).map_err(err)?;
    let id = r["imported"][0].as_u64().or_else(|| r["existing"][0].as_u64()).ok_or_else(|| format!("{path}: not a picture LightCraft can read"))?;
    s.execute("library.select", &json!({ "ids": [id], "active": id })).map_err(err)?;
    let base = s.undo.len();
    s.redo.clear();
    Ok(Img { s, id: PhotoId(id), path: path.to_string(), base, saved: base, stages: Arc::new(Default::default()), copy_dir })
}

/// What the window needs after a change: every slider's value, the full settings (crop, masks,
/// spots, curves, profile…), the Undo / Redo lists.
pub fn state(m: &mut Img) -> Json {
    let settings = m.s.execute("develop.get", &json!({})).unwrap_or(Json::Null);
    let controls = m.s.execute("develop.controls", &json!({})).unwrap_or(Json::Null);
    let mut values = serde_json::Map::new();
    if let Some(list) = controls.as_array().or_else(|| controls["controls"].as_array()) {
        for c in list {
            if let (Some(id), Some(v)) = (c["id"].as_str(), c["value"].as_f64()) {
                values.insert(id.to_string(), json!(v));
            }
        }
    }
    let undo: Vec<String> = m.s.undo.iter().skip(m.base).rev().take(100).map(|e| e.label.clone()).collect();
    let redo: Vec<String> = m.s.redo.iter().rev().take(100).map(|e| e.label.clone()).collect();
    json!({
        "values": values,
        "settings": settings,
        "undo": undo,
        "redo": redo,
        "dirty": m.s.undo.len() != m.saved,
        "activeMask": m.s.active_mask,
        "activeSpot": m.s.active_spot,
    })
}

/// The slider catalogue (id, label, section, range, default, step, track) and section names.
pub fn controls(m: &mut Img) -> Json {
    m.s.execute("develop.controls", &json!({})).unwrap_or(Json::Null)
}

pub fn info(m: &mut Img) -> Json {
    let inspect = m.s.execute("photo.inspect", &json!({})).unwrap_or(Json::Null);
    let meta = m.s.execute("photo.allMetadata", &json!({})).unwrap_or(Json::Null);
    json!({ "photo": inspect, "metadata": meta })
}

pub fn run(m: &mut Img, cmd: &str, params: &Json) -> Result<Json, String> {
    if cmd == "edit.undo" || cmd == "edit.redo" {
        undo_n(m, 1, cmd == "edit.redo")?;
        return Ok(Json::Null);
    }
    m.s.execute(cmd, params).map_err(err)
}

/// Undo or redo the newest `n` steps (never past opening the picture).
pub fn undo_n(m: &mut Img, n: usize, redo: bool) -> Result<(), String> {
    for _ in 0..n.max(1) {
        if redo {
            if m.s.redo.is_empty() {
                break;
            }
            m.s.redo_step().map_err(err)?;
        } else {
            if m.s.undo.len() <= m.base {
                break;
            }
            m.s.undo_step().map_err(err)?;
        }
    }
    Ok(())
}

/// Several commands as one undo step named `label` (the AI's edits).
pub fn batch(m: &mut Img, label: &str, cmds: &[Json]) -> Vec<Json> {
    let n0 = m.s.undo.len();
    let mut out = vec![];
    for c in cmds {
        let id = c["command"].as_str().unwrap_or_default();
        out.push(match run(m, id, &c.get("params").cloned().unwrap_or(json!({}))) {
            Ok(r) => json!({ "ok": true, "result": r }),
            Err(e) => json!({ "ok": false, "error": e }),
        });
    }
    let n = m.s.undo.len().saturating_sub(n0);
    if n >= 2 {
        m.s.merge_undo(n, label);
    } else if n == 1
        && let Some(e) = m.s.undo.last_mut()
    {
        e.label = label.to_string();
    }
    out
}

/// Render the picture fitted in `w × h` (or, with `window`, that part of a `w × h` frame: a
/// zoomed view). `draft`: a quick one while a slider moves. `before`: without the edits.
/// The render runs outside the lock, so commands aren't held up by it.
pub fn render(img: &Arc<Mutex<Img>>, a: &Json) -> Result<Json, String> {
    let w = a["w"].as_u64().unwrap_or(1600).clamp(16, 16384) as usize;
    let h = a["h"].as_u64().unwrap_or(1000).clamp(16, 16384) as usize;
    let draft = a["draft"].as_bool().unwrap_or(false);
    let before = a["before"].as_bool().unwrap_or(false);
    let crop = a["crop"].as_bool().unwrap_or(true);
    let quality = a["quality"].as_u64().unwrap_or(if draft { 80 } else { 90 }).clamp(30, 100) as u8;
    let job = {
        let mut m = img.lock().unwrap();
        let id = m.id;
        let job = match a.get("window").filter(|v| v.is_object()) {
            Some(win) => {
                let pw = lightcraft_engine::pipeline::PixelWindow {
                    x: win["x"].as_u64().unwrap_or(0) as usize,
                    y: win["y"].as_u64().unwrap_or(0) as usize,
                    w: win["w"].as_u64().unwrap_or(256).max(1) as usize,
                    h: win["h"].as_u64().unwrap_or(256).max(1) as usize,
                };
                if before { m.s.region_job_before(id, w, h, pw, crop) } else { m.s.region_job(id, w, h, pw, crop) }
            }
            None if before => m.s.render_job(id, w, h, true, crop),
            None => m.s.loupe_job(id, w, h, crop),
        }
        .ok_or("The picture can't be shown")?;
        let job = job.with_stages(m.stages.clone());
        if draft { job.draft() } else { job }
    };
    let result = job.run();
    let out = match &result.rendered {
        Ok(r) => {
            let img8 = &r.image;
            let jpeg = encode_jpeg(img8.width, img8.height, &img8.data, quality)?;
            let hist = &r.histogram;
            let bins = |v: &Vec<u32>| v.chunks((v.len() / 128).max(1)).map(|c| c.iter().sum::<u32>()).collect::<Vec<u32>>();
            json!({
                "jpeg": base64::engine::general_purpose::STANDARD.encode(jpeg),
                "width": img8.width,
                "height": img8.height,
                "hist": { "r": bins(&hist.r), "g": bins(&hist.g), "b": bins(&hist.b), "l": bins(&hist.luma) },
            })
        }
        Err(e) => return Err(e.clone()),
    };
    img.lock().unwrap().s.accept(&result);
    Ok(out)
}

/// The size of the whole picture as it would be saved (crop and rotation applied).
pub fn size(m: &mut Img) -> Json {
    m.s.execute("photo.inspect", &json!({})).map(|p| json!({ "width": p["width"], "height": p["height"] })).unwrap_or(Json::Null)
}

fn encode_jpeg(width: usize, height: usize, data: &[[u8; 4]], quality: u8) -> Result<Vec<u8>, String> {
    let mut rgb = Vec::with_capacity(width * height * 3);
    for p in data {
        rgb.extend_from_slice(&p[..3]);
    }
    let mut out = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut out, quality);
    enc.encode(&rgb, width as u16, height as u16, jpeg_encoder::ColorType::Rgb).map_err(err)?;
    Ok(out)
}

/// Map points between the view (normalized 0..1 in the render, cropped or not) and the picture
/// (normalized oriented-image coordinates, which white balance, masks, spots and red eye use).
pub fn map(m: &mut Img, a: &Json) -> Result<Json, String> {
    use lightcraft_geom::Point;
    let p = m.s.catalog.photo(m.id).ok_or("The picture is closed")?.clone();
    let d = m.s.develop_of(m.id).map(|d| (*d).clone()).unwrap_or_default();
    let crop = a["crop"].as_bool().unwrap_or(true);
    let frame = lightcraft_engine::pipeline::geometry::Frame::with_lens(p.width.max(1) as usize, p.height.max(1) as usize, &d, crop, p.embedded_lens.as_ref());
    let (w, h) = frame.fit(4096, 4096);
    let to_image = a["to"].as_str() != Some("view");
    let aff = if to_image { frame.out_to_norm(w, h) } else { frame.norm_to_out(w, h) };
    let pts: Vec<Json> = a["points"]
        .as_array()
        .map(|v| v.as_slice())
        .unwrap_or(&[])
        .iter()
        .map(|q| {
            let (x, y) = (q[0].as_f64().unwrap_or(0.0), q[1].as_f64().unwrap_or(0.0));
            if to_image {
                let r = aff.apply(Point::new(x * w as f64, y * h as f64));
                json!([r.x, r.y])
            } else {
                let r = aff.apply(Point::new(x, y));
                json!([r.x / w as f64, r.y / h as f64])
            }
        })
        .collect();
    // long-edge units: masks' and spots' sizes are fractions of the picture's long edge
    let (ow, oh) = (p.width.max(1) as f64, p.height.max(1) as f64);
    let quad: Vec<Json> = frame.crop_quad_norm().iter().map(|q| json!([q.x, q.y])).collect();
    Ok(json!({ "points": pts, "imageW": ow, "imageH": oh, "viewW": w, "viewH": h, "crop": quad }))
}

/// Save (or export) the edited picture to `out`. The format follows `params.format` or the
/// extension; `params` are LightCraft's export options (quality, longEdge, …). `mark_saved`: the
/// file is now the picture's.
pub fn save(m: &mut Img, out: &str, params: &Json, mark_saved: bool) -> Result<Json, String> {
    let ext = std::path::Path::new(out).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut p = if params.is_object() { params.clone() } else { json!({}) };
    if p["format"] == "original" {
        // keep the original as it is; the edits go into its XMP sidecar (existing XMP kept)
        if m.copy_dir.is_some() {
            return Err("this picture is saved as a picture, not as an .xmp".into());
        }
        let r = m.s.save_sidecar(m.id).map_err(err)?;
        if mark_saved {
            m.saved = m.s.undo.len();
        }
        return Ok(json!({ "sidecar": r.path.to_string_lossy(), "merged": r.merged }));
    }
    if p.get("format").is_none() {
        let f = match ext.as_str() {
            "jpg" | "jpeg" | "jpe" | "jfif" => "jpeg",
            "tif" | "tiff" => "tiff",
            "png" | "webp" | "avif" | "jxl" | "psd" | "dng" => ext.as_str(),
            _ => return Err(format!("LightCraft can't write .{ext} files: save as JPEG, PNG, TIFF, WebP, AVIF or JPEG XL")),
        };
        p["format"] = json!(f);
    }
    if p.get("quality").is_none() {
        p["quality"] = json!(95);
    }
    let o = lightcraft_engine::export::ExportOptions::from_params(&p).map_err(err)?;
    let e = lightcraft_engine::export::export_photo(&mut m.s, m.id, &o, 1)?;
    crate::write_safely(out, &e.bytes)?;
    for (sext, bytes) in &e.sidecars {
        let sc = std::path::Path::new(out).with_extension(sext);
        crate::write_safely(&sc.to_string_lossy(), bytes)?;
    }
    if mark_saved {
        m.saved = m.s.undo.len();
    }
    Ok(json!({ "width": e.width, "height": e.height, "bytes": e.bytes.len() }))
}

/// Every LightCraft command an editor of one picture can use (no library, slideshow, print…).
pub fn commands(m: &Img) -> Json {
    const KEEP: &[&str] = &[
        "develop.", "crop.", "mask.", "spot.", "redeye.", "preset.", "presets.", "profile.", "profiles.", "curve.", "pointColor.", "geometry.",
        "history.", "beforeAfter.", "edit.", "photo.rotate", "photo.flip", "denoise.", "export.presets",
    ];
    let list: Vec<Json> = m
        .s
        .commands()
        .into_iter()
        .filter(|c| KEEP.iter().any(|k| c.id.starts_with(k)))
        .filter_map(|c| serde_json::to_value(&c).ok())
        .collect();
    json!(list)
}
