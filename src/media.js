// A light audio and video player. What WebView2 plays natively (MP4/H.264, WebM, MKV with
// common codecs, MP3, AAC/M4A, FLAC, WAV, Ogg/Opus…) streams straight from the disk. Anything
// else (AVI, WMV, FLV, old codecs…) is converted once with FFmpeg when it's installed, with a
// progress bar; without FFmpeg the file can be opened in the system player.
import { call, listen, fileSrc } from "./api.js";
import { ic } from "./icons.js";
import { status, basename, dirname } from "./main.js";
import { loading } from "./loading.js";
import { isAudio } from "./filetypes.js";

let host = null, M = null;
const $ = (s) => host.querySelector(s);
const fmt = (s) => { if (!isFinite(s)) return "0:00"; s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, "0")}` : `${m}`) + `:${String(x).padStart(2, "0")}`; };
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

export function mediaHost() {
  if (host) return host;
  host = document.createElement("div");
  host.id = "media-view";
  host.hidden = true;
  host.innerHTML = `
    <div class="mv-stage" tabindex="0">
      <video class="mv-video" playsinline preload="metadata"></video>
      <div class="mv-audio" hidden><div class="mv-art">${ic("volume")}</div><div class="mv-title"></div><div class="mv-viz" aria-hidden="true">${"<i></i>".repeat(32)}</div></div>
      <div class="mv-msg" hidden></div>
      <button class="mv-big" title="Play (Space)">${ic("play")}</button>
    </div>
    <div class="mv-controls">
      <div class="mv-seek"><div class="mv-buf"></div><div class="mv-fill"></div><input type="range" min="0" max="1000" value="0" step="1" aria-label="Position"><div class="mv-tip" hidden></div></div>
      <div class="mv-row">
        <button class="icon mv-back" title="Back 10 s (←)">${ic("skip-back")}</button>
        <button class="icon mv-play" title="Play / pause (Space)">${ic("play")}</button>
        <button class="icon mv-fwd" title="Forward 10 s (→)">${ic("skip-fwd")}</button>
        <span class="mv-time">0:00 / 0:00</span>
        <span class="tb-spacer"></span>
        <button class="small mv-speed" title="Speed">1×</button>
        <button class="icon mv-loop" title="Repeat (L)">${ic("repeat")}</button>
        <button class="icon mv-mute" title="Mute (M)">${ic("volume")}</button>
        <input type="range" class="mv-vol" min="0" max="1" step="0.02" value="1" aria-label="Volume">
        <button class="icon mv-pip" title="Picture in picture">${ic("external")}</button>
        <button class="icon mv-full" title="Full screen (F)">${ic("maximize")}</button>
      </div>
    </div>`;
  wire();
  return host;
}

function el() { return $(".mv-video"); }
function wire() {
  const v = el();
  const play = () => (v.paused ? v.play().catch(() => {}) : v.pause());
  $(".mv-play").onclick = play;
  $(".mv-big").onclick = play;
  $(".mv-stage").onclick = (e) => { if (e.target === v || e.target.closest(".mv-audio")) play(); };
  $(".mv-stage").ondblclick = () => full();
  $(".mv-back").onclick = () => { v.currentTime = Math.max(0, v.currentTime - 10); };
  $(".mv-fwd").onclick = () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 10); };
  $(".mv-loop").onclick = () => { v.loop = !v.loop; $(".mv-loop").classList.toggle("on", v.loop); };
  $(".mv-mute").onclick = () => { v.muted = !v.muted; };
  $(".mv-vol").oninput = (e) => { v.volume = +e.target.value; v.muted = v.volume === 0; };
  $(".mv-speed").onclick = () => { const i = SPEEDS.indexOf(v.playbackRate); v.playbackRate = SPEEDS[(i + 1) % SPEEDS.length]; };
  $(".mv-pip").onclick = () => (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture?.()).catch?.(() => {});
  $(".mv-full").onclick = () => full();
  const seek = $(".mv-seek input");
  let seeking = false;
  seek.oninput = () => { seeking = true; if (v.duration) { v.currentTime = (seek.value / 1000) * v.duration; paint(); } };
  seek.onchange = () => { seeking = false; };
  $(".mv-seek").onpointermove = (e) => {
    const r = $(".mv-seek").getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const tip = $(".mv-tip");
    tip.hidden = !v.duration;
    tip.textContent = fmt(f * v.duration);
    tip.style.left = `${f * 100}%`;
  };
  $(".mv-seek").onpointerleave = () => { $(".mv-tip").hidden = true; };
  const paint = () => {
    const d = v.duration || 0;
    const f = d ? v.currentTime / d : 0;
    $(".mv-fill").style.width = `${f * 100}%`;
    if (!seeking) seek.value = Math.round(f * 1000);
    $(".mv-time").textContent = `${fmt(v.currentTime)} / ${fmt(d)}`;
    if (v.buffered.length && d) $(".mv-buf").style.width = `${(v.buffered.end(v.buffered.length - 1) / d) * 100}%`;
  };
  v.addEventListener("timeupdate", paint);
  v.addEventListener("progress", paint);
  v.addEventListener("loadedmetadata", () => { paint(); if (M) M.t.mediaDur = v.duration; });
  v.addEventListener("ratechange", () => { $(".mv-speed").textContent = `${v.playbackRate}×`; });
  v.addEventListener("volumechange", () => { $(".mv-mute").innerHTML = ic(v.muted || v.volume === 0 ? "volume-x" : "volume"); $(".mv-vol").value = v.muted ? 0 : v.volume; });
  const playing = () => { const p = !v.paused; $(".mv-play").innerHTML = ic(p ? "pause" : "play"); $(".mv-big").classList.toggle("gone", p); host.classList.toggle("playing", p); if (p) startViz(); };
  v.addEventListener("play", playing);
  v.addEventListener("pause", playing);
  v.addEventListener("ended", playing);
  v.addEventListener("waiting", () => host.classList.add("buffering"));
  v.addEventListener("canplay", () => host.classList.remove("buffering"));
  v.addEventListener("error", () => { if (M && !M.converting) cantPlay(M.t); });
  // controls fade while a video plays and the mouse rests
  let idle;
  host.addEventListener("pointermove", () => { host.classList.remove("idle"); clearTimeout(idle); idle = setTimeout(() => host.classList.add("idle"), 2200); });
  $(".mv-stage").onkeydown = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === " " || k === "k") { e.preventDefault(); play(); }
    else if (k === "arrowleft" || k === "j") { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime - (k === "j" ? 10 : 5)); }
    else if (k === "arrowright") { e.preventDefault(); v.currentTime += 5; }
    else if (k === "arrowup") { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.05); }
    else if (k === "arrowdown") { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.05); }
    else if (k === "m") v.muted = !v.muted;
    else if (k === "f") full();
    else if (k === "l") $(".mv-loop").click();
    else if (k === "home") v.currentTime = 0;
    else if (/^[0-9]$/.test(k) && v.duration) v.currentTime = (+k / 10) * v.duration;
  };
}
function full() { if (document.fullscreenElement) document.exitFullscreen(); else host.requestFullscreen?.().catch(() => {}); }

// (no Web Audio: the file comes from another origin, and a MediaElementSource would mute it)
function startViz() {}

export async function openMedia(t) {
  mediaHost();
  host.hidden = false;
  if (M?.t === t) return;
  const v = el();
  if (M) { M.t.mediaTime = v.currentTime; v.pause(); }
  M = { t, audio: isAudio(t.path), converting: false };
  host.classList.toggle("is-audio", M.audio);
  $(".mv-audio").hidden = !M.audio;
  $(".mv-title").textContent = t.name;
  $(".mv-msg").hidden = true;
  $(".mv-big").classList.remove("gone");
  for (const tr of [...v.querySelectorAll("track")]) tr.remove();
  const src = t.mediaSrc || fileSrc(t.path.replace(/\\/g, "/"));
  v.src = src;
  v.currentTime = t.mediaTime || 0;
  if (!M.audio) addSubtitles(t);
  // a type the engine says it can't decode: straight to conversion, no failed attempt first
  if (!t.mediaSrc && v.canPlayType(mimeOf(t.path)) === "" && /\.(avi|wmv|flv|asf|rm|rmvb|vob|divx|wma|ape|ac3|dts|amr|aiff?|mpe?g|m2ts|mts|3gp|3g2|f4v|dsf|wv|mka|tta)$/i.test(t.path)) return cantPlay(t);
  requestAnimationFrame(() => $(".mv-stage").focus({ preventScroll: true }));
  status(`${t.name}`, "");
}
export function hideMedia() { if (!host) return; if (M) { M.t.mediaTime = el().currentTime; el().pause(); } host.hidden = true; M = null; }
export function closeMedia(t) { if (M?.t === t) { el().removeAttribute("src"); el().load(); hideMedia(); } }

function mimeOf(p) {
  const e = p.split(".").pop().toLowerCase();
  return { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", ogv: "video/ogg", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv", mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg; codecs=opus", weba: "audio/webm", wma: "audio/x-ms-wma", aiff: "audio/aiff", aif: "audio/aiff" }[e] || "";
}

// same-name .vtt / .srt subtitles next to the video
async function addSubtitles(t) {
  const stem = t.path.replace(/\.[^.\\/]+$/, "");
  for (const ext of ["vtt", "srt"]) {
    try {
      const r = await call("read_text", { path: `${stem}.${ext}`, encoding: null });
      if (!r?.text || M?.t !== t) continue;
      const vtt = ext === "vtt" ? r.text : "WEBVTT\n\n" + r.text.replace(/\r/g, "").replace(/(\d\d:\d\d:\d\d),(\d\d\d)/g, "$1.$2");
      const tr = document.createElement("track");
      tr.kind = "subtitles"; tr.label = basename(`${stem}.${ext}`); tr.default = true;
      tr.src = URL.createObjectURL(new Blob([vtt], { type: "text/vtt" }));
      el().appendChild(tr);
      return;
    } catch {}
  }
}

async function cantPlay(t) {
  if (M?.t !== t) return;
  const msg = $(".mv-msg");
  msg.hidden = false;
  const ff = await call("media_ffmpeg").catch(() => null);
  msg.innerHTML = `<b>This format can't be played inside Callio directly.</b><p class="note">${ff ? "FFmpeg is installed: Callio can convert it once for playback (the original file isn't changed)." : "Install FFmpeg (winget install ffmpeg) to play it here, or open it in your system player."}</p><div class="mv-msg-btns">${ff ? `<button class="primary mv-conv">${ic("refresh")}<span>Convert and play</span></button>` : ""}<button class="mv-ext">${ic("external")}<span>Open in the system player</span></button></div>`;
  msg.querySelector(".mv-ext").onclick = () => call("open_path", { path: t.path }).catch((e) => status(e.message, "err"));
  msg.querySelector(".mv-conv")?.addEventListener("click", () => convert(t));
}

async function convert(t) {
  if (!M || M.t !== t) return;
  M.converting = true;
  $(".mv-msg").hidden = true;
  const ld = loading(`Converting ${t.name} for playback…`, { delay: 0, cancel: () => call("media_cancel", { path: t.path }).catch(() => {}) });
  const un = await listen("media-progress", (p) => { if (p.path === t.path) ld.set(p.frac, null, p.frac != null ? `${Math.round(p.frac * 100)}%` : ""); });
  try {
    const out = await call("media_transcode", { path: t.path, audio: M.audio });
    t.mediaSrc = fileSrc(out.replace(/\\/g, "/"));
    status(`Ready to play ${t.name}`, "ok");
    if (M?.t === t) { M.converting = false; el().src = t.mediaSrc; el().play().catch(() => {}); }
  } catch (e) {
    if (M?.t === t) { M.converting = false; cantPlay(t); }
    if (!/cancel/i.test(String(e.message || e))) status(`Couldn't convert ${t.name}: ${e.message || e}`, "err");
  } finally { ld.done(); un?.(); }
}
