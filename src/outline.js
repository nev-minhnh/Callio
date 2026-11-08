// Lightweight outline extraction (kept separate so it loads without the Markdown renderer).
export function markdownOutline(text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, title: m[2], line: i + 1 });
  });
  return out;
}

export function texOutline(text) {
  const levels = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
  const out = [];
  const re = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
  text.split("\n").forEach((l, i) => {
    const c = l.indexOf("%");
    const s = c >= 0 && l[c - 1] !== "\\" ? l.slice(0, c) : l;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) out.push({ level: levels[m[1]], title: m[2], line: i + 1 });
  });
  return out;
}
