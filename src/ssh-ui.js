// Remote servers: everything you see and click — Settings › Remote servers, the server and folder-link
// dialogs, the sync panel, the host-key / password questions. Loaded when one of them is opened.
import { call, listen, api } from "./api.js";
import { addVi } from "./i18n.js";
import { settings, updateSettings, toast, ask, basename, folder } from "./main.js";
import { hosts, hostById, hostLabel, hostState, links, linkStatus, saveHosts, saveLinks, startLink, stopLink, pushHosts, notes, onChange, initSsh, L, msgText } from "./ssh.js";

addVi({
  "Servers": "Máy chủ",
  "Linked folders": "Thư mục được liên kết",
  "Add server…": "Thêm máy chủ…",
  "Link a folder…": "Liên kết thư mục…",
  "Test": "Thử kết nối",
  "Edit": "Sửa",
  "Remove": "Xoá",
  "Connect": "Kết nối",
  "Disconnect": "Ngắt kết nối",
  "Forget saved passwords": "Quên mật khẩu đã lưu",
  "From your ssh config": "Từ tệp ssh config",
  "Added in Callio": "Thêm trong Callio",
  "Name": "Tên",
  "Address (host name or IP)": "Địa chỉ (tên máy chủ hoặc IP)",
  "Port": "Cổng",
  "User name": "Tên đăng nhập",
  "Sign-in": "Cách đăng nhập",
  "Automatic (agent, key files, password)": "Tự động (agent, tệp khoá, mật khẩu)",
  "SSH agent only": "Chỉ SSH agent",
  "Key file": "Tệp khoá",
  "Password": "Mật khẩu",
  "Keyboard-interactive (code, 2-step)": "Bàn phím tương tác (mã, 2 bước)",
  "Key files (private keys, one per line)": "Tệp khoá (khoá riêng, mỗi dòng một tệp)",
  "Jump host (saved, used in a later version)": "Máy chủ trung gian (lưu lại, dùng ở bản sau)",
  "This server needs a VPN": "Máy chủ này cần VPN",
  "Remember the password / key passphrase in Windows Credential Manager": "Nhớ mật khẩu / cụm mật khẩu của khoá trong Windows Credential Manager",
  "Save": "Lưu",
  "Cancel": "Huỷ",
  "Server": "Máy chủ",
  "Folder on this computer": "Thư mục trên máy này",
  "Folder on the server": "Thư mục trên máy chủ",
  "Browse…": "Chọn…",
  "Two-way (changes go both ways)": "Hai chiều (thay đổi đi cả hai hướng)",
  "Upload only (this computer → server)": "Chỉ tải lên (máy này → máy chủ)",
  "Download only (server → this computer)": "Chỉ tải về (máy chủ → máy này)",
  "Direction": "Hướng đồng bộ",
  "Also leave out (one pattern per line, like .gitignore)": "Bỏ qua thêm (mỗi dòng một mẫu, như .gitignore)",
  "Files larger than (MB) are not synced unless you allow them": "Tệp lớn hơn (MB) không được đồng bộ trừ khi bạn cho phép",
  "When a notebook was run on both sides, keep the outputs from": "Khi sổ tay chạy ở cả hai phía, giữ kết quả từ",
  "the most recent run": "lần chạy mới nhất",
  "this computer": "máy này",
  "the server": "máy chủ",
  "Link": "Liên kết",
  "Unlink": "Bỏ liên kết",
  "Sync now": "Đồng bộ ngay",
  "Pause": "Tạm dừng",
  "Resume": "Tiếp tục",
  "Keep mine": "Giữ bản của tôi",
  "Take the server's": "Lấy bản máy chủ",
  "Keep both": "Giữ cả hai",
  "Compare": "So sánh",
  "Changed on both sides": "Đã đổi ở cả hai phía",
  "Large files — not synced": "Tệp lớn — chưa đồng bộ",
  "Sync this file": "Đồng bộ tệp này",
  "Waiting": "Đang chờ",
  "Recent": "Gần đây",
  "Nothing to sync.": "Không có gì để đồng bộ.",
  "New folder": "Thư mục mới",
  "Up": "Lên",
  "Choose": "Chọn",
  "Trust and save": "Tin cậy và lưu",
  "Do not connect": "Không kết nối",
  "Is this the right server?": "Đây có đúng là máy chủ không?",
  "Callio has not seen this server before. Check that the fingerprint below is the one your server administrator gave you, then trust it.": "Callio chưa từng kết nối máy chủ này. Hãy kiểm tra dấu vân tay bên dưới khớp với dấu vân tay quản trị viên cung cấp, rồi tin cậy.",
  "Key fingerprint (SHA256)": "Dấu vân tay khoá (SHA256)",
  "The server's key has changed": "Khoá của máy chủ đã thay đổi",
  "Callio did not connect.": "Callio không kết nối.",
  "Close": "Đóng",
  "Remember in Windows Credential Manager": "Nhớ trong Windows Credential Manager",
  "Sign in": "Đăng nhập",
  "Sign-in code": "Mã đăng nhập",
  "Tested": "Đã thử",
  "No servers yet. Callio also reads the Host entries of your ~/.ssh/config.": "Chưa có máy chủ. Callio cũng đọc các mục Host trong ~/.ssh/config của bạn.",
  "No folders are linked yet.": "Chưa có thư mục nào được liên kết.",
  "Never saved in files: passwords and passphrases go to Windows Credential Manager only.": "Mật khẩu và cụm mật khẩu không bao giờ nằm trong tệp: chỉ lưu trong Windows Credential Manager.",
  "Install": "Cài đặt",
});

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const $ = (s, r = document) => r.querySelector(s);
const rid = () => Math.random().toString(36).slice(2, 10);
const errText = msgText;

/** A small modal built here (form method=dialog). Resolves with the pressed button's value. */
function modal({ title, body, buttons = [{ label: "Close", value: "close", primary: true }], cls = "", onOpen }) {
  const d = document.createElement("dialog");
  d.className = `ssh-dlg ${cls}`;
  d.innerHTML = `<form method="dialog"><header class="dlg-head"><h2></h2></header><div class="dlg-body col">${body}</div><footer class="dlg-foot"></footer></form>`;
  $("h2", d).textContent = title;
  const foot = $(".dlg-foot", d);
  for (const b of buttons) {
    const el = document.createElement("button");
    el.textContent = b.label; el.value = b.value; el.type = b.value === "cancel" ? "submit" : "button";
    if (b.primary) el.className = "primary";
    el.dataset.v = b.value;
    foot.appendChild(el);
  }
  document.body.appendChild(d);
  return new Promise((resolve) => {
    let out = "cancel";
    foot.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; out = b.dataset.v; if (b.dataset.v !== "cancel") { if (d.dispatchEvent(new CustomEvent("ssh-submit", { cancelable: true, detail: out }))) d.close(); } };
    d.addEventListener("cancel", () => { out = "cancel"; });
    d.addEventListener("close", () => { resolve({ value: out, el: d }); setTimeout(() => d.remove(), 300); });
    d.showModal();
    onOpen?.(d);
  });
}

// ---------------- questions from the backend ----------------
const answer = (id, value) => call("ssh_answer", { id, value }).catch(() => {});

export async function answerAsk(p) {
  if (p.kind === "hostkey") {
    const r = await modal({
      title: L("Is this the right server?", "Đây có đúng là máy chủ không?"), cls: "ssh-ask",
      body: `<p>${esc(p.name)} (${esc(p.host)}${p.port !== 22 ? ":" + p.port : ""})</p><p class="note">${L("Callio has not seen this server before. Check that the fingerprint below is the one your server administrator gave you, then trust it.", "Callio chưa từng kết nối máy chủ này. Hãy kiểm tra dấu vân tay bên dưới khớp với dấu vân tay quản trị viên cung cấp, rồi tin cậy.")}</p><p class="note">${L("Key fingerprint (SHA256)", "Dấu vân tay khoá (SHA256)")} · ${esc(p.algorithm || "")}</p><code class="ssh-fp">${esc(p.fingerprint)}</code>`,
      buttons: [{ label: L("Do not connect", "Không kết nối"), value: "cancel" }, { label: L("Trust and save", "Tin cậy và lưu"), value: "trust", primary: true }],
    });
    return answer(p.id, r.value === "trust" ? { trust: true } : { trust: false });
  }
  if (p.kind === "password" || p.kind === "passphrase") {
    const what = p.kind === "password" ? `${esc(p.user || "")}@${esc(p.host)}` : esc(p.keyName || p.keyPath || "");
    const r = await modal({
      title: p.kind === "password" ? `${L("Sign in", "Đăng nhập")} · ${p.host}` : `${L("Key passphrase", "Cụm mật khẩu của khoá")} · ${p.host}`, cls: "ssh-ask",
      body: `<p>${what}${p.retry ? ` <b class="ssh-bad">${L("That did not work — try again.", "Không đúng — thử lại.")}</b>` : ""}</p><input type="password" class="ssh-pw" autocomplete="off" spellcheck="false"><label class="check"><input type="checkbox" class="ssh-save"> ${L("Remember in Windows Credential Manager", "Nhớ trong Windows Credential Manager")}</label>`,
      buttons: [{ label: L("Cancel", "Huỷ"), value: "cancel" }, { label: L("Sign in", "Đăng nhập"), value: "ok", primary: true }],
      onOpen: (d) => { const i = $(".ssh-pw", d); i.focus(); i.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $(".primary", d).click(); } }; },
    });
    if (r.value !== "ok") return answer(p.id, null);
    return answer(p.id, { value: $(".ssh-pw", r.el).value, save: $(".ssh-save", r.el).checked });
  }
  if (p.kind === "kbd") {
    const r = await modal({
      title: `${L("Sign in", "Đăng nhập")} · ${p.host}`, cls: "ssh-ask",
      body: `${p.instructions ? `<p class="note">${esc(p.instructions)}</p>` : ""}${(p.prompts || []).map((q, i) => `<label>${esc(q.prompt)}<input type="${q.echo ? "text" : "password"}" data-i="${i}" autocomplete="off" spellcheck="false"></label>`).join("")}`,
      buttons: [{ label: L("Cancel", "Huỷ"), value: "cancel" }, { label: L("Sign in", "Đăng nhập"), value: "ok", primary: true }],
      onOpen: (d) => $("input", d)?.focus(),
    });
    if (r.value !== "ok") return answer(p.id, null);
    return answer(p.id, { answers: [...r.el.querySelectorAll("input[data-i]")].map((x) => x.value) });
  }
  return answer(p.id, null);
}

/** The key of a server changed: a hard stop. There is no "continue anyway" here. */
export async function showAlert(p) {
  if (p.kind !== "hostkey-changed") return;
  await modal({
    title: L("The server's key has changed", "Khoá của máy chủ đã thay đổi"), cls: "ssh-ask ssh-danger",
    body: `<p><b>${esc(p.name)}</b> (${esc(p.host)})</p><p>${esc(p.message)}</p><p class="note">${L("Key fingerprint (SHA256)", "Dấu vân tay khoá (SHA256)")}</p><code class="ssh-fp">${esc(p.fingerprint)}</code><p><b>${L("Callio did not connect.", "Callio không kết nối.")}</b></p>`,
    buttons: [{ label: L("Close", "Đóng"), value: "close", primary: true }],
  });
}

// ---------------- Settings › Remote servers ----------------
let testOut = {};
export async function renderSettings() {
  await initSsh();
  const box = $("#ssh-settings");
  if (!box) return;
  const hs = hosts(), ls = links(), { notes: nn, sshDir } = notes();
  box.innerHTML = `
    <div class="sg-body">
      <h4 class="ssh-sub">${L("Servers", "Máy chủ")}</h4>
      <div class="ssh-list" id="ssh-hosts">${hs.length ? hs.map((h) => {
        const st = hostState(h.id), t = testOut[h.id];
        return `<div class="ssh-row" data-id="${esc(h.id)}"><i class="ssh-dot s-${st.state}"></i>
          <div class="ssh-main"><b>${esc(h.name)}</b><small>${esc(h.user ? h.user + "@" : "")}${esc(h.host)}${h.port && h.port !== 22 ? ":" + h.port : ""} · ${h.source === "config" ? L("From your ssh config", "Từ tệp ssh config") : L("Added in Callio", "Thêm trong Callio")}${h.needsVpn ? " · VPN" : ""}</small>
          ${t ? `<small class="ssh-test ${t.ok === null ? "" : t.ok ? "ok" : "bad"}">${esc(t.text)}</small>` : ""}</div>
          <div class="ssh-btns"><button type="button" class="small" data-a="test">${L("Test", "Thử kết nối")}</button><button type="button" class="small" data-a="edit">${L("Edit", "Sửa")}</button>${h.source !== "config" ? `<button type="button" class="small" data-a="remove">${L("Remove", "Xoá")}</button>` : ""}</div></div>`;
      }).join("") : `<p class="note">${L("No servers yet. Callio also reads the Host entries of your ~/.ssh/config.", "Chưa có máy chủ. Callio cũng đọc các mục Host trong ~/.ssh/config của bạn.")}</p>`}</div>
      <div class="ssh-actions"><button type="button" class="small primary" id="ssh-add">${L("Add server…", "Thêm máy chủ…")}</button></div>
      ${sshDir ? `<p class="note">${esc(sshDir)}</p>` : ""}
      ${(nn || []).map((n) => `<p class="note">${esc(msgText(n))}</p>`).join("")}
      <h4 class="ssh-sub">${L("Linked folders", "Thư mục được liên kết")}</h4>
      <div class="ssh-list" id="ssh-links">${ls.length ? ls.map((l) => {
        const st = linkStatus(l.id);
        return `<div class="ssh-row" data-id="${esc(l.id)}"><i class="ssh-dot s-${st?.state || "off"}"></i><div class="ssh-main"><b>${esc(l.name || basename(l.local))}</b><small>${esc(l.local)} ⇄ ${esc(hostLabel(l.host))}:${esc(l.remote)}</small></div>
          <div class="ssh-btns"><button type="button" class="small" data-a="edit">${L("Edit", "Sửa")}</button><button type="button" class="small" data-a="unlink">${L("Unlink", "Bỏ liên kết")}</button></div></div>`;
      }).join("") : `<p class="note">${L("No folders are linked yet.", "Chưa có thư mục nào được liên kết.")}</p>`}</div>
      <div class="ssh-actions"><button type="button" class="small primary" id="ssh-link" ${hs.length ? "" : "disabled"}>${L("Link a folder…", "Liên kết thư mục…")}</button></div>
      <p class="note">${L("Never saved in files: passwords and passphrases go to Windows Credential Manager only.", "Mật khẩu và cụm mật khẩu không bao giờ nằm trong tệp: chỉ lưu trong Windows Credential Manager.")}</p>
    </div>`;
  $("#ssh-add", box).onclick = () => hostDialog(null);
  $("#ssh-link", box).onclick = () => linkDialog(null);
  $("#ssh-hosts", box).onclick = async (e) => {
    const b = e.target.closest("button[data-a]"); if (!b) return;
    const id = b.closest(".ssh-row").dataset.id, h = hostById(id);
    if (b.dataset.a === "edit") hostDialog(h);
    if (b.dataset.a === "remove") { await saveHosts((settings.sshHosts || []).filter((x) => x.id !== id)); call("ssh_forget", { host: id }).catch(() => {}); renderSettings(); }
    if (b.dataset.a === "test") {
      b.disabled = true; testOut[id] = { ok: null, text: L("Connecting…", "Đang kết nối…") }; renderSettings();
      try {
        const r = await call("ssh_test", { host: id });
        const bits = [r.os || r.kernel, r.python3 ? "Python" : "no Python", r.jupyterServer ? "Jupyter" : null, r.rsync ? "rsync" : null, r.claude ? "Claude Code" : null, r.sftp ? "SFTP" : "no SFTP"].filter(Boolean);
        testOut[id] = { ok: true, text: `${L("Connected", "Đã kết nối")} · ${bits.join(" · ")}` };
      } catch (err) { testOut[id] = { ok: false, text: errText(err) }; }
      renderSettings();
    }
  };
  $("#ssh-links", box).onclick = async (e) => {
    const b = e.target.closest("button[data-a]"); if (!b) return;
    const id = b.closest(".ssh-row").dataset.id, l = links().find((x) => x.id === id);
    if (b.dataset.a === "edit") linkDialog(l);
    if (b.dataset.a === "unlink") { await stopLink(id, true); await saveLinks(links().filter((x) => x.id !== id)); renderSettings(); }
  };
}
onChange(() => { const s = $("#ssh-settings"); if (s && s.offsetParent && !$("dialog[open]")) renderSettings(); });

// ---------------- server dialog ----------------
async function hostDialog(h) {
  const cfg = h?.source === "config", isNew = !h;
  const d = h || { id: "h" + rid(), name: "", host: "", port: 22, user: "", auth: "auto", identityFiles: [], proxyJump: "", needsVpn: false, remember: false, source: "callio" };
  const dis = cfg ? "disabled" : "";
  const r = await modal({
    title: isNew ? L("Add server…", "Thêm máy chủ…").replace("…", "") : d.name, cls: "ssh-form",
    body: `<label>${L("Name", "Tên")}<input data-f="name" value="${esc(d.name)}" ${dis}></label>
      <label>${L("Address (host name or IP)", "Địa chỉ (tên máy chủ hoặc IP)")}<input data-f="host" value="${esc(d.host)}" ${dis}></label>
      <div class="ssh-two"><label>${L("User name", "Tên đăng nhập")}<input data-f="user" value="${esc(d.user)}" ${dis}></label><label>${L("Port", "Cổng")}<input data-f="port" type="number" min="1" max="65535" value="${d.port || 22}" ${dis}></label></div>
      <label>${L("Sign-in", "Cách đăng nhập")}<select data-f="auth" ${dis}>${[["auto", "Automatic (agent, key files, password)"], ["agent", "SSH agent only"], ["key", "Key file"], ["password", "Password"], ["interactive", "Keyboard-interactive (code, 2-step)"]].map(([v, t]) => `<option value="${v}" ${d.auth === v ? "selected" : ""}>${L(t, { "Automatic (agent, key files, password)": "Tự động (agent, tệp khoá, mật khẩu)", "SSH agent only": "Chỉ SSH agent", "Key file": "Tệp khoá", "Password": "Mật khẩu", "Keyboard-interactive (code, 2-step)": "Bàn phím tương tác (mã, 2 bước)" }[t])}</option>`).join("")}</select></label>
      <label>${L("Key files (private keys, one per line)", "Tệp khoá (khoá riêng, mỗi dòng một tệp)")}<textarea data-f="identityFiles" rows="2" spellcheck="false" ${dis}>${esc((d.identityFiles || []).join("\n"))}</textarea></label>
      <label>${L("Jump host (saved, used in a later version)", "Máy chủ trung gian (lưu lại, dùng ở bản sau)")}<input data-f="proxyJump" value="${esc(d.proxyJump || "")}" ${dis}></label>
      <label class="check"><input type="checkbox" data-f="needsVpn" ${d.needsVpn ? "checked" : ""}> ${L("This server needs a VPN", "Máy chủ này cần VPN")}</label>
      <label class="check"><input type="checkbox" data-f="remember" ${d.remember ? "checked" : ""}> ${L("Remember the password / key passphrase in Windows Credential Manager", "Nhớ mật khẩu / cụm mật khẩu của khoá trong Windows Credential Manager")}</label>
      ${cfg ? `<p class="note">${L("From your ssh config", "Từ tệp ssh config")}</p>` : ""}
      <div class="ssh-actions">${!isNew ? `<button type="button" class="small" id="ssh-forget">${L("Forget saved passwords", "Quên mật khẩu đã lưu")}</button>` : ""}</div>`,
    buttons: [{ label: L("Cancel", "Huỷ"), value: "cancel" }, { label: L("Save", "Lưu"), value: "save", primary: true }],
    onOpen: (el) => { const f = $("#ssh-forget", el); if (f) f.onclick = async () => { await call("ssh_forget", { host: d.id }).catch(() => {}); toast(L("Forgotten.", "Đã quên."), "ok", 1800); }; },
  });
  if (r.value !== "save") return;
  const g = (k) => $(`[data-f="${k}"]`, r.el);
  const out = { ...d, needsVpn: g("needsVpn").checked, remember: g("remember").checked };
  if (!cfg) {
    Object.assign(out, { name: g("name").value.trim(), host: g("host").value.trim(), user: g("user").value.trim(), port: +g("port").value || 22, auth: g("auth").value, identityFiles: g("identityFiles").value.split(/\n/).map((s) => s.trim()).filter(Boolean), proxyJump: g("proxyJump").value.trim() });
    if (!out.host) return toast(L("Enter the server's address.", "Hãy nhập địa chỉ máy chủ."), "err");
    if (!out.name) out.name = out.host;
  }
  const stored = (settings.sshHosts || []).filter((x) => x.id !== out.id);
  stored.push(out);
  await saveHosts(stored);
  renderSettings();
}

// ---------------- folder-link dialog ----------------
async function remoteBrowser(host, start) {
  let path = start || "";
  const r = await modal({
    title: `${hostLabel(host)}`, cls: "ssh-browse",
    body: `<div class="ssh-bpath"><button type="button" class="small" data-b="up">${L("Up", "Lên")}</button><input data-b="path" spellcheck="false"><button type="button" class="small" data-b="mk">${L("New folder", "Thư mục mới")}</button></div><div class="ssh-blist" data-b="list"></div><p class="note ssh-err" data-b="err" hidden></p>`,
    buttons: [{ label: L("Cancel", "Huỷ"), value: "cancel" }, { label: L("Choose", "Chọn"), value: "ok", primary: true }],
    onOpen: (d) => {
      const inp = $('[data-b="path"]', d), list = $('[data-b="list"]', d), err = $('[data-b="err"]', d);
      const go = async (p) => {
        try {
          const res = await call("ssh_list_dir", { host, path: p || null });
          path = res.path; inp.value = path; err.hidden = true;
          list.innerHTML = res.items.filter((i) => i.dir).map((i) => `<div class="ssh-bi" data-n="${esc(i.name)}">📁 ${esc(i.name)}</div>`).join("") || `<p class="note">—</p>`;
        } catch (e) { err.hidden = false; err.textContent = errText(e); }
      };
      go(path);
      list.ondblclick = (e) => { const i = e.target.closest(".ssh-bi"); if (i) go(path.replace(/\/+$/, "") + "/" + i.dataset.n); };
      list.onclick = (e) => { const i = e.target.closest(".ssh-bi"); if (!i) return; list.querySelectorAll(".sel").forEach((x) => x.classList.remove("sel")); i.classList.add("sel"); };
      inp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); go(inp.value); } };
      d.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-b]")?.dataset.b;
        if (b === "up") go(path.replace(/\/[^/]+\/?$/, "") || "/");
        if (b === "mk") {
          const name = await ask({ title: L("New folder", "Thư mục mới"), input: "" });
          if (name) { try { await call("ssh_mkdir", { host, path: path.replace(/\/+$/, "") + "/" + name }); go(path.replace(/\/+$/, "") + "/" + name); } catch (er) { err.hidden = false; err.textContent = errText(er); } }
        }
      });
      d.addEventListener("ssh-submit", () => { const sel = $(".ssh-bi.sel", d); if (sel) path = path.replace(/\/+$/, "") + "/" + sel.dataset.n; });
    },
  });
  return r.value === "ok" ? path : null;
}

async function linkDialog(l) {
  const hs = hosts();
  const d = l || { id: "l" + rid(), name: "", host: hs[0]?.id, local: folder || "", remote: "", direction: "two-way", exclude: [], sizeLimitMb: 10, include: [], paused: false, preferOutputs: "newest" };
  const r = await modal({
    title: L("Server link", "Liên kết máy chủ"), cls: "ssh-form",
    body: `<label>${L("Server", "Máy chủ")}<select data-f="host">${hs.map((h) => `<option value="${esc(h.id)}" ${h.id === d.host ? "selected" : ""}>${esc(h.name)}</option>`).join("")}</select></label>
      <label>${L("Folder on this computer", "Thư mục trên máy này")}<span class="ssh-pick"><input data-f="local" value="${esc(d.local)}" spellcheck="false"><button type="button" class="small" data-p="local">${L("Browse…", "Chọn…")}</button></span></label>
      <label>${L("Folder on the server", "Thư mục trên máy chủ")}<span class="ssh-pick"><input data-f="remote" value="${esc(d.remote)}" spellcheck="false" placeholder="/home/…"><button type="button" class="small" data-p="remote">${L("Browse…", "Chọn…")}</button></span></label>
      <label>${L("Direction", "Hướng đồng bộ")}<select data-f="direction">${[["two-way", "Two-way (changes go both ways)"], ["upload", "Upload only (this computer → server)"], ["download", "Download only (server → this computer)"]].map(([v, t]) => `<option value="${v}" ${d.direction === v ? "selected" : ""}>${L(t, { "Two-way (changes go both ways)": "Hai chiều (thay đổi đi cả hai hướng)", "Upload only (this computer → server)": "Chỉ tải lên (máy này → máy chủ)", "Download only (server → this computer)": "Chỉ tải về (máy chủ → máy này)" }[t])}</option>`).join("")}</select></label>
      <label>${L("Also leave out (one pattern per line, like .gitignore)", "Bỏ qua thêm (mỗi dòng một mẫu, như .gitignore)")}<textarea data-f="exclude" rows="3" spellcheck="false" placeholder="checkpoints/\n*.pt">${esc((d.exclude || []).join("\n"))}</textarea></label>
      <div class="ssh-two"><label>${L("Files larger than (MB) are not synced unless you allow them", "Tệp lớn hơn (MB) không được đồng bộ trừ khi bạn cho phép")}<input data-f="sizeLimitMb" type="number" min="1" max="100000" value="${d.sizeLimitMb || 10}"></label>
      <label>${L("When a notebook was run on both sides, keep the outputs from", "Khi sổ tay chạy ở cả hai phía, giữ kết quả từ")}<select data-f="preferOutputs">${[["newest", "the most recent run"], ["local", "this computer"], ["server", "the server"]].map(([v, t]) => `<option value="${v}" ${d.preferOutputs === v ? "selected" : ""}>${L(t, { "the most recent run": "lần chạy mới nhất", "this computer": "máy này", "the server": "máy chủ" }[t])}</option>`).join("")}</select></label></div>
      <p class="note ssh-err" data-f="err" hidden></p>`,
    buttons: [{ label: L("Cancel", "Huỷ"), value: "cancel" }, { label: L("Link", "Liên kết"), value: "save", primary: true }],
    onOpen: (el) => {
      el.addEventListener("click", async (e) => {
        const b = e.target.closest("[data-p]"); if (!b) return;
        const host = $('[data-f="host"]', el).value;
        if (b.dataset.p === "local") { const p = await api.pickFolder(L("Folder on this computer", "Thư mục trên máy này")).catch(() => null); if (p) $('[data-f="local"]', el).value = p; }
        else { const p = await remoteBrowser(host, $('[data-f="remote"]', el).value.trim()); if (p) $('[data-f="remote"]', el).value = p; }
      });
      el.addEventListener("ssh-submit", (ev) => {
        const loc = $('[data-f="local"]', el).value.trim(), rem = $('[data-f="remote"]', el).value.trim(), err = $('[data-f="err"]', el);
        if (!loc || !rem) { ev.preventDefault(); err.hidden = false; err.textContent = L("Choose both folders.", "Hãy chọn cả hai thư mục."); }
      });
    },
  });
  if (r.value !== "save") return;
  const g = (k) => $(`[data-f="${k}"]`, r.el);
  const out = { ...d, host: g("host").value, local: g("local").value.trim(), remote: g("remote").value.trim().replace(/(?<=.)\/+$/, ""), direction: g("direction").value, exclude: g("exclude").value.split(/\n/).map((s) => s.trim()).filter(Boolean), sizeLimitMb: +g("sizeLimitMb").value || 10, preferOutputs: g("preferOutputs").value };
  out.name = out.name || basename(out.local);
  const rest = links().filter((x) => x.id !== out.id);
  await saveLinks([...rest, out]);
  await startLink(out);
  renderSettings();
}
export const openLinkDialog = linkDialog;

// ---------------- sync panel ----------------
let panel = null, panelFor = null;
export function togglePanel(anchor) {
  if (panel) { closePanel(); return; }
  panelFor = anchor;
  panel = document.createElement("div");
  panel.id = "ssh-panel"; panel.className = "ssh-panel";
  document.body.appendChild(panel);
  paintPanel();
  const r = anchor.getBoundingClientRect();
  panel.style.right = Math.max(8, window.innerWidth - r.right) + "px";
  panel.style.bottom = (window.innerHeight - r.top + 6) + "px";
  setTimeout(() => document.addEventListener("pointerdown", outside, true), 0);
  document.addEventListener("keydown", esck, true);
}
const outside = (e) => { if (panel && !panel.contains(e.target) && !panelFor.contains(e.target) && !e.target.closest("dialog")) closePanel(); };
const esck = (e) => { if (e.key === "Escape" && !$("dialog[open]")) closePanel(); };
function closePanel() { panel?.remove(); panel = null; document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", esck, true); }
const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
const ago = (s) => { if (!s) return ""; const d = Math.max(0, Date.now() / 1000 - s); return d < 90 ? L("just now", "vừa xong") : d < 5400 ? L(`${Math.round(d / 60)} min ago`, `${Math.round(d / 60)} phút trước`) : L(`${Math.round(d / 3600)} h ago`, `${Math.round(d / 3600)} giờ trước`); };

function paintPanel() {
  if (!panel) return;
  const ls = links();
  panel.innerHTML = ls.map((l) => {
    const st = linkStatus(l.id) || { state: "off", conflicts: [], skipped: [], pending: [], transfers: [], log: [], up: 0, down: 0 }, hs = hostState(l.host), h = hostById(l.host);
    const off = hs.state === "off" || st.state === "offline" || st.state === "error";
    const stateTxt = off ? (h?.needsVpn ? L("Offline — turn the VPN on", "Mất kết nối — hãy bật VPN") : L("Offline", "Mất kết nối")) : st.state === "paused" || l.paused ? L("Paused", "Tạm dừng") : st.state === "syncing" ? L("Syncing", "Đang đồng bộ") : L("Synced", "Đã đồng bộ");
    return `<section class="ssh-card" data-id="${esc(l.id)}">
      <header><i class="ssh-dot s-${hs.state}"></i><b>${esc(hostLabel(l.host))}</b><span class="ssh-where">${esc(l.remote)}</span><span class="ssh-state">${esc(stateTxt)}${st.lastOk && !off ? " · " + esc(ago(st.lastOk)) : ""}</span></header>
      ${st.error ? `<p class="ssh-errl">${esc(st.error)}</p>` : ""}
      ${st.transfers?.length ? `<div class="ssh-tr">${st.transfers.map((t) => `<div>${t.dir === "up" ? "↑" : "↓"} ${esc(t.rel)} <progress max="${t.total || 1}" value="${t.done || 0}"></progress></div>`).join("")}</div>` : ""}
      ${st.conflicts.length ? `<h5>⚠ ${L("Changed on both sides", "Đã đổi ở cả hai phía")}</h5>${st.conflicts.map((c) => `<div class="ssh-conf" data-rel="${esc(c.rel)}"><span class="ssh-file">${esc(c.rel)}</span><span class="ssh-cb"><button type="button" class="small" data-a="local">${L("Keep mine", "Giữ bản của tôi")}</button><button type="button" class="small" data-a="server">${L("Take the server's", "Lấy bản máy chủ")}</button><button type="button" class="small" data-a="both">${L("Keep both", "Giữ cả hai")}</button>${c.copy ? `<button type="button" class="small" data-a="compare" data-copy="${esc(c.copy)}">${L("Compare", "So sánh")}</button>` : ""}</span></div>`).join("")}` : ""}
      ${st.pending.length ? `<h5>${L("Waiting", "Đang chờ")} (${st.pending.length})</h5><div class="ssh-pend">${st.pending.slice(0, 6).map((p) => `<div>${{ up: "↑", down: "↓", conflict: "⚠" }[p.dir] || "•"} ${esc(p.rel)}</div>`).join("")}${st.pending.length > 6 ? `<div class="note">+${st.pending.length - 6}</div>` : ""}</div>` : ""}
      ${st.skipped.length ? `<h5>⊘ ${L("Large files — not synced", "Tệp lớn — chưa đồng bộ")}</h5>${st.skipped.map((s) => `<div class="ssh-conf" data-rel="${esc(s.rel)}"><span class="ssh-file">${esc(s.rel)} <small>${fmtSize(s.size)}</small></span><span class="ssh-cb"><button type="button" class="small" data-a="allow">${L("Sync this file", "Đồng bộ tệp này")}</button></span></div>`).join("")}` : ""}
      ${!st.conflicts.length && !st.pending.length && !st.skipped.length && !st.transfers?.length ? `<p class="note">${L("Nothing to sync.", "Không có gì để đồng bộ.")}</p>` : ""}
      ${st.log?.length ? `<details><summary>${L("Recent", "Gần đây")}</summary>${st.log.slice(-6).reverse().map((x) => `<div class="note">${esc(x)}</div>`).join("")}</details>` : ""}
      <footer><button type="button" class="small" data-a="now">${L("Sync now", "Đồng bộ ngay")}</button><button type="button" class="small" data-a="pause">${st.state === "paused" || l.paused ? L("Resume", "Tiếp tục") : L("Pause", "Tạm dừng")}</button>${off ? `<button type="button" class="small" data-a="connect">${L("Connect", "Kết nối")}</button>` : ""}<span class="tb-spacer"></span><button type="button" class="small" data-a="settings">${L("Edit", "Sửa")}</button></footer>
    </section>`;
  }).join("");
}
onChange(() => paintPanel());
document.addEventListener("click", async (e) => {
  const b = e.target.closest("#ssh-panel button[data-a]"); if (!b) return;
  const card = b.closest(".ssh-card"), id = card.dataset.id, l = links().find((x) => x.id === id), a = b.dataset.a;
  const rel = b.closest(".ssh-conf")?.dataset.rel;
  try {
    if (a === "now") await call("ssh_sync_now", { id });
    else if (a === "pause") { const p = !(linkStatus(id)?.state === "paused" || l.paused); await call("ssh_sync_pause", { id, paused: p }); await saveLinks(links().map((x) => (x.id === id ? { ...x, paused: p } : x))); }
    else if (a === "connect") { await call("ssh_connect", { host: l.host }); await call("ssh_sync_now", { id }); }
    else if (a === "local" || a === "server" || a === "both") await call("ssh_sync_resolve", { id, rel, choice: a });
    else if (a === "compare") {
      const sep = l.local.includes("\\") ? "\\" : "/";
      const abs = (r) => l.local.replace(/[\\/]+$/, "") + sep + r.replace(/\//g, sep);
      const { openCompare, onDrop } = await import("./compare.js");
      closePanel(); await openCompare(abs(rel)); await onDrop([abs(rel), abs(b.dataset.copy)], null);
    }
    else if (a === "allow") { const nl = { ...l, include: [...(l.include || []), rel] }; await saveLinks(links().map((x) => (x.id === id ? nl : x))); await startLink(nl); }
    else if (a === "settings") { closePanel(); const { openSettings } = await import("./settings.js"); await openSettings("ssh"); }
  } catch (err) { toast(errText(err), "err"); }
});

// ---------------- install Claude Code on a server (only when clicked) ----------------
export async function installClaude(host, cmd) {
  const id = "i" + rid();
  const un = [];
  const r = await modal({
    title: L("Install Claude Code on the server", "Cài Claude Code trên máy chủ"), cls: "ssh-form",
    body: `<p class="note">${esc(hostLabel(host))}: <code>${esc(cmd)}</code></p><pre class="ssh-log" data-f="log" hidden></pre>`,
    buttons: [{ label: L("Cancel", "Huỷ"), value: "cancel" }, { label: L("Install", "Cài đặt"), value: "go", primary: true }],
    onOpen: (d) => {
      d.addEventListener("ssh-submit", (ev) => {
        ev.preventDefault();
        const log = $('[data-f="log"]', d); log.hidden = false; log.textContent = L("Running…", "Đang chạy…") + "\n";
        const go = $('.dlg-foot [data-v="go"]', d); go.disabled = true;
        listen("ssh-log", (e) => {
          const p = e.payload || e; if (p.id !== id) return;
          if (p.done) { log.textContent += p.code === 0 ? L("Installed.", "Đã cài.") : L("Install failed — see the log.", "Cài không thành công — xem nhật ký."); const c = $('.dlg-foot [data-v="cancel"]', d); if (c) c.textContent = L("Close", "Đóng"); }
          else log.textContent += p.line + "\n";
        }).then((u) => un.push(u));
        call("ssh_claude_install", { host, id }).catch((e) => { log.textContent += errText(e); });
      });
    },
  });
  un.forEach((u) => u?.());
  return r.value;
}

/** Tell the author why the server could not be reached (VPN flag gives its own sentence). */
export function connectFailed(host, err) { toast(errText(err), "err", 8000); }
