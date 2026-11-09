// English / Vietnamese interface. Callio's interface is written in English; in Vietnamese every
// text, tooltip and placeholder on screen is swapped for its Vietnamese form as it appears (a
// MutationObserver), so menus, dialogs, panels and messages built later are translated too.
// What you write — documents, file names, previews, AI answers — is never touched. Switching
// back to English restores the original text without restarting.
let VI = null;
let lang = "en";
let observer = null;
const orig = new WeakMap(); // text node → its English text
const ATTRS = ["title", "placeholder", "aria-label", "data-tip"];
// never translated: the user's own content and anything typed or shown from files
const SKIP = "#tree, .fb, .csl-item, #ls-csl-cur, .rc-name, .rc small, #about-version, .about-slogan, .welcome-slogan, .tv-body, .cm-editor, #md-preview, .md-body, .mdp, #tabs .name, .tree-item .name, .tree-root, #st-path, #folder-name, .msg-body, .msg .md, .ai-msg .content, .as-out, .as-what, .tr-out, .wr-result, .wr-orig, .wr-fix, .wr-line1, .wr-title, .wr-expl, #word-view .wd-pages, #deck-view .dk-stage, .sh-grid, .sh-cells, iframe, .lib-item, .ld-meta, .ld-abstract, input, textarea, [contenteditable=true], [data-noi18n], .pdf-page, .textLayer, .dv-cell, .gv-table, pre, code, kbd, .cm-tooltip, .hv-frame, #nb-view .cell, #csv-view, #struct-view, .pg-list, .lb-card .note, #pdf-wrap .page, .ctx-menu .fn, .outline-item, .hist-item .name";

// messages with a value inside
const PATTERNS = [
  [/^Saved (.+)$/, "Đã lưu $1"],
  [/^Saving (.+)…$/, "Đang lưu $1…"],
  [/^Opening (.+)…$/, "Đang mở $1…"],
  [/^Converting (.+)…$/, "Đang chuyển đổi $1…"],
  [/^Couldn't open (.+): (.+)$/, "Không mở được $1: $2"],
  [/^Couldn't save (.+): (.+)$/, "Không lưu được $1: $2"],
  [/^(\d[\d,.]*) words?$/, "$1 từ"],
  [/^(.+): (\d[\d,.]*) words?$/, "$1: $2 từ"],
  [/^Page (\d+) of (\d+)$/, "Trang $1/$2"],
  [/^(\d+) pages$/, "$1 trang"],
  [/^Ln (\d+), Col (\d+)(.*)$/, (m, a, b, c) => `Dòng ${a}, Cột ${b}${c.replace(/(\d+) sel/, "$1 đã chọn")}`],
  [/^(\d+) suggestions? · (\d+) of (\d+) checked$/, "$1 gợi ý · đã kiểm tra $2/$3"],
  [/^(\d+) in this file$/, "$1 trong tệp này"],
  [/^Checking the whole document… (\d+) of (\d+)$/, "Đang kiểm tra toàn bộ tài liệu… $1/$2"],
  [/^Paused — whole document, (\d+) of (\d+)$/, "Đã tạm dừng — toàn bộ tài liệu, $1/$2"],
  [/^Tone: (.+) — fits your goals$/, "Giọng văn: $1 — phù hợp mục tiêu"],
  [/^Tone: (.+) — doesn't quite fit your goals$/, "Giọng văn: $1 — chưa thật phù hợp mục tiêu"],
  [/^(\d+) changed blocks?$/, "$1 khối thay đổi"],
  [/^(\d+) sheets? changed$/, "$1 trang tính thay đổi"],
  [/^change (\d+) of (\d+)$/, "thay đổi $1/$2"],
  [/^(\d+) unchanged blocks?$/, "$1 khối không đổi"],
  [/^(\d+) unchanged rows?$/, "$1 hàng không đổi"],
  [/^(\d+) unchanged lines?$/, "$1 dòng không đổi"],
  [/^(\d+) results?$/, "$1 kết quả"],
  [/^(\d+) results? from (.+)$/, "$1 kết quả từ $2"],
  [/^The AI will search with (.+)$/, "AI sẽ tìm kiếm bằng $1"],
  [/^Web search with (.+)$/, "Tìm kiếm web bằng $1"],
  [/^Translating… (\d+) s$/, "Đang dịch… $1 giây"],
  [/^Writing… (\d+) s$/, "Đang viết… $1 giây"],
  [/^Looking up… (\d+) s$/, "Đang tra… $1 giây"],
  [/^Selection: (.+)$/, "Vùng chọn: $1"],
  [/^Paragraph: (.+)$/, "Đoạn văn: $1"],
  [/^Detected language: (.+)$/, "Ngôn ngữ phát hiện: $1"],
  [/^Found the details of (.+)$/, "Đã tìm thấy thông tin của $1"],
  [/^Details found for (\d+) of (\d+) papers?$/, "Đã tìm thấy thông tin cho $1/$2 bài báo"],
  [/^Finding the details of (.+) with AI…$/, "Đang tìm thông tin của $1 bằng AI…"],
  [/^(\d+) of (\d+)$/, "$1/$2"],
  [/^“(.+)” added to your dictionary$/, "Đã thêm “$1” vào từ điển"],
  [/^Couldn't apply the suggestion: (.+)$/, "Không áp dụng được gợi ý: $1"],
  [/^Writing check: (.+)$/, "Kiểm tra văn bản: $1"],
  [/^(.+) — Callio$/, "$1 — Callio"],
  [/^Indexing the text of (.+)… \((\d+) left\)$/, "Đang lập chỉ mục văn bản của $1… (còn $2)"],
  [/^(.*) · added (.+)$/, (m, a, b) => `${VI[a] || a} · thêm ngày ${b}`],
  [/^Save changes to (.+)\?$/, "Lưu thay đổi của $1?"],
  [/^Save your changes to (.+) first\?$/, "Lưu thay đổi của $1 trước?"],
  [/^New name for (.+)$/, "Tên mới cho $1"],
  [/^Couldn't create (.+): (.+)$/, "Không tạo được $1: $2"],
  [/^Couldn't rename (.+): (.+)$/, "Không đổi tên được $1: $2"],
  [/^Creating (.+)…$/, "Đang tạo $1…"],
  [/^Pinned (.+)$/, "Đã ghim $1"],
  [/^Unpinned (.+)$/, "Đã bỏ ghim $1"],
  [/^Sent (.+) to the printer$/, "Đã gửi $1 tới máy in"],
  [/^Exporting (.+)…$/, "Đang xuất $1…"],
  [/^Open (.+)\?$/, "Mở $1?"],
  [/^(\d+) skill\(s\) found$/, "Tìm thấy $1 kỹ năng"],
  [/^On · (\d+) models$/, "Bật · $1 mô hình"],
  [/^(\d+) models$/, "$1 mô hình"],
  [/^Models \((\d+)\)$/, "Mô hình ($1)"],
  [/^Use (.+)$/, "Dùng $1"],
  [/^Remove (.+)\?$/, "Gỡ $1?"],
  [/^(.+) is large$/, "$1 có dung lượng lớn"],
  [/^Line endings: (.+) — click to change$/, "Kết thúc dòng: $1 — bấm để đổi"],
  [/^Conversations are saved with this folder: (.+)$/, "Cuộc trò chuyện được lưu cùng thư mục này: $1"],
  [/^Show only (.+)$/, (m, a) => "Chỉ hiện " + (VI[a] || a)],
  [/^(\d+) suggestions? accepted this week, (\d+) in all$/, "Đã nhận $1 gợi ý tuần này, tổng $2"],
  [/^Correctness: (\d+) · Clarity: (\d+) · Engagement: (\d+) · Delivery: (\d+) · (\d+) dismissed$/, "Chính xác: $1 · Rõ ràng: $2 · Thu hút: $3 · Truyền tải: $4 · $5 đã bỏ qua"],
  [/^(\d+) min$/, "$1 phút"],
  [/^(\d+) sec$/, "$1 giây"],
  [/^Spaces: (\d+)$/, "Dấu cách: $1"],
  [/^Tabs: (\d+)$/, "Tab: $1"],
  [/^Built into Windows\. Languages: (.+)\.$/, "Có sẵn trong Windows. Ngôn ngữ: $1."],
  [/^Nothing to (undo|redo)$/, (m, a) => a === "undo" ? "Không có gì để hoàn tác" : "Không có gì để làm lại"],
];

function lookup(s) {
  const t = s.trim();
  if (!t) return null;
  const v = VI[t];
  if (v) return s.replace(t, v);
  // a label followed by a shortcut or ellipsis: "Save (Ctrl+S)", "Rename…"
  const m = /^(.*?)(\s*\((?:Ctrl|Shift|Alt|F\d|Esc)[^)]*\))$/.exec(t);
  if (m && VI[m[1]]) return s.replace(t, VI[m[1]] + m[2]);
  const pre = /^([^\p{L}\p{N}(“"]+)(.+)$/u.exec(t);
  if (pre && VI[pre[2]]) return s.replace(t, pre[1] + VI[pre[2]]);
  for (const [re, to] of PATTERNS) {
    if (!re.test(t)) continue;
    const out = t.replace(re, to);
    if (out && out !== "null") return s.replace(t, out);
  }
  return null;
}

function skip(el) { return !el || !!el.closest?.(SKIP); }

function translateNode(n) {
  if (n.nodeType === 3) {
    const p = n.parentElement;
    if (!p || p.closest("script, style") || skip(p)) return;
    const cur = n.nodeValue;
    const v = lookup(cur);
    if (v && v !== cur) { orig.set(n, [cur, v]); n.nodeValue = v; }
    return;
  }
  if (n.nodeType !== 1 || skip(n)) return;
  attrs(n);
  for (const c of n.childNodes) translateNode(c);
}
function attrs(n) {
  for (const a of ATTRS) {
    const val = n.getAttribute(a);
    if (!val) continue;
    const v = lookup(val);
    if (v && v !== val) { n.setAttribute("data-en-" + a, val); n.setAttribute("data-vi-" + a, v); n.setAttribute(a, v); }
  }
}

function restoreAll() {
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const back = [];
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { const o = orig.get(n); if (o && n.nodeValue === o[1]) back.push([n, o[0]]); }
  for (const [n, en] of back) { n.nodeValue = en; orig.delete(n); }
  for (const a of ATTRS) for (const el of document.querySelectorAll(`[data-en-${a}]`)) {
    if (el.getAttribute(a) === el.getAttribute(`data-vi-${a}`)) el.setAttribute(a, el.getAttribute(`data-en-${a}`));
    el.removeAttribute(`data-en-${a}`); el.removeAttribute(`data-vi-${a}`);
  }
}

/** The interface language now ("en" or "vi"). */
export const uiLang = () => lang;

/** Switch the interface to `l` ("en" | "vi"). */
export async function setLanguage(l) {
  l = l === "vi" ? "vi" : "en";
  document.documentElement.lang = l;
  if (l === lang && (l === "en" || observer)) return;
  lang = l;
  if (l === "en") { observer?.disconnect(); observer = null; restoreAll(); return; }
  if (!VI) VI = (await import("./i18n-vi.js")).default;
  translateNode(document.body);
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === "characterData") translateNode(m.target);
      else if (m.type === "attributes") { if (!skip(m.target)) attrs(m.target); }
      else for (const n of m.addedNodes) translateNode(n);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

/** Translate one string (for text Callio builds itself, e.g. the window title). */
export function t(s) { return lang === "vi" && VI ? lookup(s) || s : s; }
