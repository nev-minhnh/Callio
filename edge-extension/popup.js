const $ = (s) => document.querySelector(s);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));
let meta = null;

async function start() {
  const ping = await send({ type: "ping" });
  if (!ping?.ok) { $("#state").innerHTML = `<span class="err">${escapeHtml(ping?.error || "Callio isn't running.")}</span>`; return; }
  if (!ping.paired) { $("#state").textContent = "Callio is running."; $("#pair").hidden = false; return; }
  $("#state").textContent = "Reading this page…";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const ex = await send({ type: "extract", tabId: tab.id, url: tab.url });
  meta = ex.meta || { url: tab.url };
  if (!meta.title) meta.title = tab.title || "";
  $("#title").value = meta.title;
  $("#authors").value = (meta.authors || []).join("\n");
  $("#year").value = meta.year || "";
  $("#doi").value = meta.doi || "";
  $("#pdfinfo").textContent = meta.isPdf ? "This tab is a PDF — it will be saved with the paper." : meta.pdfUrl ? "The paper's PDF will be downloaded with your browser session." : "No PDF link found — only the details will be saved (add the PDF later in Callio).";
  const cols = await send({ type: "collections" });
  for (const c of cols.collections || []) { const o = document.createElement("option"); o.value = c.id; o.textContent = c.name; $("#collection").appendChild(o); }
  chrome.storage.local.get("lastCollection", ({ lastCollection }) => { if (lastCollection) $("#collection").value = lastCollection; });
  const dup = await send({ type: "lookup", doi: meta.doi, title: meta.title });
  if (dup?.found) { $("#dup").hidden = false; $("#dup").textContent = "Already in your library — saving again adds anything missing (e.g. the PDF)."; }
  $("#state").hidden = true;
  $("#form").hidden = false;
  $("#title").focus();
}

$("#pair-btn").onclick = async () => {
  $("#pair-btn").disabled = true;
  $("#pair-btn").textContent = "Confirm in Callio…";
  const r = await send({ type: "pair" });
  if (r?.ok) { $("#pair").hidden = true; start(); }
  else { $("#pair-btn").disabled = false; $("#pair-btn").textContent = "Connect to Callio"; $("#state").innerHTML = `<span class="err">${escapeHtml(r?.error || "Not connected")}</span>`; }
};

$("#form").onsubmit = async (e) => {
  e.preventDefault();
  $("#save").disabled = true;
  $("#save").textContent = "Saving…";
  meta.title = $("#title").value.trim();
  meta.authors = $("#authors").value.split("\n").map((s) => s.trim()).filter(Boolean);
  meta.year = $("#year").value.trim();
  meta.doi = $("#doi").value.trim();
  const collection = $("#collection").value;
  chrome.storage.local.set({ lastCollection: collection });
  const tags = $("#tags").value.split(",").map((s) => s.trim()).filter(Boolean);
  const r = await send({ type: "save", meta, opts: { collection, tags } });
  $("#form").hidden = true;
  $("#result").hidden = false;
  if (r?.ok) $("#result").innerHTML = `<p class="ok">${r.duplicate ? "Updated in your library" : "Saved to your library"}</p><p>${escapeHtml(r.title)}</p><p class="note">${r.pdf ? "PDF stored — its text is being indexed in Callio." : "No PDF was stored (it may need a sign-in, or the page had none)."}</p>`;
  else $("#result").innerHTML = `<p class="err">${escapeHtml(r?.error || "Couldn't save")}</p>`;
};

function escapeHtml(s) { return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]); }
start();
