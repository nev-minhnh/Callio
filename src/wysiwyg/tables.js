// Word-like tables: ⊕ handles between rows/columns, a right-click menu, and the row/column
// operations (which also keep LaTeX rules (\midrule ...) and the column spec in step).
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { TableMap, CellSelection, addRow, addColumn, removeRow, removeColumn, cellAround } from "prosemirror-tables";
import { schema } from "./schema.js";

const S = schema.nodes;
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

/** Table/cell info for the selection. */
export function cellPosition(state) {
  const sel = state.selection;
  const $cell = sel instanceof CellSelection ? sel.$headCell : cellAround(sel.$head);
  if (!$cell) return null;
  const table = $cell.node(-1);
  const tableStart = $cell.start(-1);
  const map = TableMap.get(table);
  const rect = map.findCell($cell.pos - tableStart);
  return { tablePos: tableStart - 1, tableStart, table, map, row: rect.top, col: rect.left, cellPos: $cell.pos };
}
function tableAt(state, tablePos) {
  const table = state.doc.nodeAt(tablePos);
  if (!table || table.type !== S.table) return null;
  return { table, tableStart: tablePos + 1, map: TableMap.get(table) };
}
const isTex = (table) => table.attrs.spec != null || table.attrs.open != null;
function focusCell(tr, tablePos, row, col) {
  const table = tr.doc.nodeAt(tablePos);
  if (!table) return;
  const map = TableMap.get(table);
  row = Math.max(0, Math.min(row, map.height - 1));
  col = Math.max(0, Math.min(col, map.width - 1));
  const pos = tablePos + 1 + map.positionAt(row, col, table);
  const cell = tr.doc.nodeAt(pos);
  tr.setSelection(TextSelection.create(tr.doc, pos + 1 + (cell ? cell.content.size : 0)));
}
function rowPos(table, tablePos, r) {
  let p = tablePos + 1;
  for (let i = 0; i < r; i++) p += table.child(i).nodeSize;
  return p;
}

export function addRowAt(view, tablePos, index, focusCol = 0) {
  const t = tableAt(view.state, tablePos);
  if (!t) return;
  const tr = view.state.tr;
  addRow(tr, { map: t.map, tableStart: t.tableStart, table: t.table }, index);
  const table = tr.doc.nodeAt(tablePos);
  if (isTex(t.table) && index < table.childCount - 1) {
    // a rule above the old row now sits above the new one (it marks the same boundary)
    const next = table.child(index + 1);
    if (next.attrs.pre) {
      const np = rowPos(table, tablePos, index), op = np + table.child(index).nodeSize;
      tr.setNodeMarkup(op, null, { ...next.attrs, pre: "" });
      tr.setNodeMarkup(np, null, { ...table.child(index).attrs, pre: next.attrs.pre });
    }
  }
  focusCell(tr, tablePos, index, focusCol);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

function specItems(table) { return table.attrs.spec ? table.attrs.spec.items.map((x) => ({ ...x })) : null; }
function setSpec(tr, tablePos, items) {
  const table = tr.doc.nodeAt(tablePos);
  if (!table.attrs.spec) return;
  tr.setNodeMarkup(tablePos, null, { ...table.attrs, spec: { ...table.attrs.spec, items } });
}

export function addColAt(view, tablePos, index) {
  const t = tableAt(view.state, tablePos);
  if (!t) return;
  const tr = view.state.tr;
  addColumn(tr, { map: t.map, tableStart: t.tableStart, table: t.table }, index);
  const items = specItems(t.table);
  if (items) {
    const bar = items.length > 1 && items.slice(1).every((x) => /\|/.test(x.s));
    items.splice(index, 0, { s: bar && index > 0 ? "|" : index === 0 && items[0] ? items[0].s : "", c: "l" });
    if (index === 0 && items[1]) items[1].s = bar ? "|" : "";
    setSpec(tr, tablePos, items);
  }
  focusCell(tr, tablePos, 0, index);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function deleteRowAt(view, tablePos, index) {
  const t = tableAt(view.state, tablePos);
  if (!t) return;
  if (t.map.height <= 1) return deleteTableAt(view, tablePos);
  const tr = view.state.tr;
  const row = t.table.child(index);
  const next = index + 1 < t.table.childCount ? t.table.child(index + 1) : null;
  removeRow(tr, { map: t.map, tableStart: t.tableStart, table: t.table }, index);
  if (isTex(t.table) && next && row.attrs.pre && (/\\toprule|^\\hline/.test(row.attrs.pre) || !next.attrs.pre)) {
    const table = tr.doc.nodeAt(tablePos);
    const p = rowPos(table, tablePos, index);
    tr.setNodeMarkup(p, null, { ...table.child(index).attrs, pre: row.attrs.pre });
  }
  focusCell(tr, tablePos, index, 0);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function deleteColAt(view, tablePos, index) {
  const t = tableAt(view.state, tablePos);
  if (!t) return;
  if (t.map.width <= 1) return deleteTableAt(view, tablePos);
  const tr = view.state.tr;
  removeColumn(tr, { map: t.map, tableStart: t.tableStart, table: t.table }, index);
  const items = specItems(t.table);
  if (items) { const [gone] = items.splice(index, 1); if (index === 0 && items[0]) items[0].s = gone.s; setSpec(tr, tablePos, items); }
  focusCell(tr, tablePos, 0, Math.max(0, index - 1));
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function deleteTableAt(view, tablePos) {
  const { state } = view;
  const $p = state.doc.resolve(tablePos);
  // a table that is the only real content of a figure/table float: remove the float
  let from = tablePos, to = tablePos + state.doc.nodeAt(tablePos).nodeSize;
  if ($p.parent.type === S.float) { from = $p.before(); to = $p.after(); }
  const tr = state.tr.delete(from, to);
  if (!tr.doc.childCount) tr.insert(0, S.paragraph.create());
  const sel = TextSelection.findFrom(tr.doc.resolve(Math.min(from, tr.doc.content.size)), -1, true) || TextSelection.findFrom(tr.doc.resolve(0), 1, true);
  if (sel) tr.setSelection(sel);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

export function alignColumn(view, tablePos, col, align) {
  const t = tableAt(view.state, tablePos);
  if (!t) return;
  const tr = view.state.tr;
  for (let r = 0; r < t.map.height; r++) {
    const pos = t.tableStart + t.map.map[r * t.map.width + col];
    const cell = tr.doc.nodeAt(pos);
    tr.setNodeMarkup(pos, null, { ...cell.attrs, align });
  }
  view.dispatch(tr);
  view.focus();
}

export function toggleHeaderRow(view, tablePos) {
  const t = tableAt(view.state, tablePos);
  if (!t) return;
  const tr = view.state.tr;
  const first = t.table.firstChild;
  const isHeader = first.firstChild && first.firstChild.type === S.table_header;
  let p = tablePos + 2;
  first.forEach((cell) => { tr.setNodeMarkup(p, isHeader ? S.table_cell : S.table_header, cell.attrs); p += cell.nodeSize; });
  if (isTex(t.table) && t.table.childCount > 1) {
    const second = t.table.child(1);
    const rp = rowPos(t.table, tablePos, 1);
    const rule = t.table.attrs.booktabs ? "\\midrule" : "\\hline";
    let pre = second.attrs.pre || "";
    if (isHeader) pre = pre.replace(/\\(midrule|hline)\s*/, "").trim();
    else if (!/\\(midrule|hline)/.test(pre)) pre = (pre ? pre + "\n" : "") + rule;
    tr.setNodeMarkup(rp, null, { ...second.attrs, pre });
  }
  view.dispatch(tr);
  view.focus();
}

// ---------------- UI: handles + menu ----------------
export const tableUIKey = new PluginKey("wyTableUI");

export function tableUI(ctx) {
  return new Plugin({
    key: tableUIKey,
    view(view) { return new TableUI(view, ctx); },
    props: {
      handleDOMEvents: {
        contextmenu(view, e) {
          const cell = e.target.closest && e.target.closest("td, th");
          if (!cell || !view.dom.contains(cell)) return false;
          e.preventDefault();
          ctx.tableMenu && ctx.tableMenu(e, cell);
          return true;
        },
      },
    },
  });
}

class TableUI {
  constructor(view, ctx) {
    this.view = view; this.ctx = ctx;
    const host = ctx.scroller;
    this.host = host;
    this.rowBtn = this.mkBtn("Insert row here", "wy-tbl-add row");
    this.colBtn = this.mkBtn("Insert column here", "wy-tbl-add col");
    this.line = h("div", "wy-tbl-line");
    this.more = h("button", "wy-tbl-more", "⋯");
    this.more.title = "Table options";
    this.more.type = "button";
    for (const el of [this.rowBtn, this.colBtn, this.line, this.more]) { el.hidden = true; host.appendChild(el); }
    this.onMove = this.onMove.bind(this);
    this.onLeave = this.onLeave.bind(this);
    host.addEventListener("mousemove", this.onMove, { passive: true });
    host.addEventListener("mouseleave", this.onLeave);
    host.addEventListener("scroll", () => this.hide(), { passive: true });
    this.rowBtn.addEventListener("mousedown", (e) => { e.preventDefault(); if (this.rowTarget) addRowAt(this.view, this.rowTarget.tablePos, this.rowTarget.index); this.hide(); });
    this.colBtn.addEventListener("mousedown", (e) => { e.preventDefault(); if (this.colTarget) addColAt(this.view, this.colTarget.tablePos, this.colTarget.index); this.hide(); });
    for (const [btn, which] of [[this.rowBtn, "row"], [this.colBtn, "col"]]) {
      btn.addEventListener("mouseenter", () => this.showLine(which));
      btn.addEventListener("mouseleave", () => { this.line.hidden = true; });
    }
    this.more.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (!this.table) return;
      const cell = this.table.querySelector("td, th");
      const r = this.more.getBoundingClientRect();
      this.menu({ clientX: r.left, clientY: r.bottom + 4 }, this.currentCell || cell);
    });
    ctx.tableMenu = (e, cell) => this.menu(e, cell);
  }
  mkBtn(title, cls) {
    const b = h("button", cls);
    b.type = "button";
    b.title = title;
    b.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M8 4.5v7M4.5 8h7" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>';
    return b;
  }
  hostRect(el) {
    const r = el.getBoundingClientRect(), hr = this.host.getBoundingClientRect();
    return { left: r.left - hr.left + this.host.scrollLeft, top: r.top - hr.top + this.host.scrollTop, width: r.width, height: r.height, right: r.right - hr.left + this.host.scrollLeft, bottom: r.bottom - hr.top + this.host.scrollTop };
  }
  onLeave() { this.hide(); }
  hide() { for (const el of [this.rowBtn, this.colBtn, this.line, this.more]) el.hidden = true; this.table = null; }
  onMove(e) {
    if (e.buttons) return;
    const t = e.target;
    if (t === this.rowBtn || t === this.colBtn || this.rowBtn.contains(t) || this.colBtn.contains(t) || t === this.more) return;
    let table = t.closest && t.closest(".wy-page table");
    // near a table's left/top edge, outside it
    if (!table && this.table && this.table.isConnected) {
      const r = this.table.getBoundingClientRect();
      if (e.clientX > r.left - 34 && e.clientX < r.right + 4 && e.clientY > r.top - 34 && e.clientY < r.bottom + 4) table = this.table;
    }
    if (!table || !this.view.dom.contains(table)) return this.hide();
    this.table = table;
    this.currentCell = t.closest && t.closest("td, th");
    const tr = table.getBoundingClientRect();
    const tablePos = this.tablePosOf(table);
    if (tablePos == null) return this.hide();
    const hr = this.hostRect(table);
    // ⋯ options at the top-right corner
    this.more.hidden = false;
    this.more.style.left = hr.right - 22 + "px";
    this.more.style.top = hr.top - 24 + "px";
    // rows: when the pointer is near the left edge
    const rows = [...table.rows];
    if (e.clientX < tr.left + 28 && e.clientX > tr.left - 34 && rows.length) {
      const bounds = [rows[0].getBoundingClientRect().top, ...rows.map((r) => r.getBoundingClientRect().bottom)];
      let k = 0, best = Infinity;
      bounds.forEach((y, i) => { const d = Math.abs(y - e.clientY); if (d < best) { best = d; k = i; } });
      this.rowTarget = { tablePos, index: k, y: bounds[k] };
      this.rowBtn.hidden = false;
      this.rowBtn.style.left = hr.left - 24 + "px";
      this.rowBtn.style.top = bounds[k] - tr.top + hr.top - 8 + "px";
    } else this.rowBtn.hidden = true;
    // columns: near the top edge
    if (e.clientY < tr.top + 22 && e.clientY > tr.top - 34 && rows.length) {
      const cells = [...rows[0].cells];
      const bounds = [cells[0].getBoundingClientRect().left, ...cells.map((c) => c.getBoundingClientRect().right)];
      let k = 0, best = Infinity;
      bounds.forEach((x, i) => { const d = Math.abs(x - e.clientX); if (d < best) { best = d; k = i; } });
      this.colTarget = { tablePos, index: k, x: bounds[k] };
      this.colBtn.hidden = false;
      this.colBtn.style.left = bounds[k] - tr.left + hr.left - 8 + "px";
      this.colBtn.style.top = hr.top - 24 + "px";
    } else this.colBtn.hidden = true;
  }
  showLine(which) {
    if (!this.table) return;
    const tr = this.table.getBoundingClientRect(), hr = this.hostRect(this.table);
    const l = this.line;
    l.hidden = false;
    if (which === "row" && this.rowTarget) {
      l.className = "wy-tbl-line row";
      l.style.left = hr.left + "px"; l.style.width = hr.width + "px"; l.style.height = "2px";
      l.style.top = this.rowTarget.y - tr.top + hr.top - 1 + "px";
    } else if (this.colTarget) {
      l.className = "wy-tbl-line col";
      l.style.top = hr.top + "px"; l.style.height = hr.height + "px"; l.style.width = "2px";
      l.style.left = this.colTarget.x - tr.left + hr.left - 1 + "px";
    }
  }
  tablePosOf(tableEl) {
    try {
      const cell = tableEl.querySelector("td, th");
      const pos = this.view.posAtDOM(cell, 0);
      const $p = this.view.state.doc.resolve(pos);
      for (let d = $p.depth; d > 0; d--) if ($p.node(d).type === S.table) return $p.before(d);
    } catch { /* not in the document */ }
    return null;
  }
  menu(e, cellEl) {
    const view = this.view;
    let pos;
    try { pos = view.posAtDOM(cellEl, 0); } catch { return; }
    const $p = view.state.doc.resolve(pos);
    let d = $p.depth;
    while (d > 0 && $p.node(d).type !== S.table_cell && $p.node(d).type !== S.table_header) d--;
    if (d <= 0) return;
    const tablePos = $p.before(d - 2);
    const t = tableAt(view.state, tablePos);
    const rect = t.map.findCell($p.before(d) - t.tableStart);
    const row = rect.top, col = rect.left;
    // put the cursor in the clicked cell, unless it's part of a cell selection
    if (!(view.state.selection instanceof CellSelection)) {
      const cp = $p.before(d);
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, cp + 1 + view.state.doc.nodeAt(cp).content.size)));
    }
    const tex = isTex(t.table);
    const headerOn = t.table.firstChild.firstChild && t.table.firstChild.firstChild.type === S.table_header;
    const align = view.state.doc.nodeAt(t.tableStart + t.map.map[col]).attrs.align;
    const items = [
      ["Insert row above", () => addRowAt(view, tablePos, row, col)],
      ["Insert row below", () => addRowAt(view, tablePos, row + 1, col)],
      ["Insert column left", () => addColAt(view, tablePos, col)],
      ["Insert column right", () => addColAt(view, tablePos, col + 1)],
      null,
      ["Delete row", () => deleteRowAt(view, tablePos, row), "danger"],
      ["Delete column", () => deleteColAt(view, tablePos, col), "danger"],
      ["Delete table", () => deleteTableAt(view, tablePos), "danger"],
      null,
      ["Align column left", () => alignColumn(view, tablePos, col, "left"), align === "left" ? "on" : ""],
      ["Align column center", () => alignColumn(view, tablePos, col, "center"), align === "center" ? "on" : ""],
      ["Align column right", () => alignColumn(view, tablePos, col, "right"), align === "right" ? "on" : ""],
    ];
    if (tex || !headerOn) items.push(null, ["Header row", () => toggleHeaderRow(view, tablePos), headerOn ? "on" : ""]);
    this.ctx.showMenu(e.clientX, e.clientY, items);
  }
  update() {}
  destroy() {
    this.host.removeEventListener("mousemove", this.onMove);
    this.host.removeEventListener("mouseleave", this.onLeave);
    for (const el of [this.rowBtn, this.colBtn, this.line, this.more]) el.remove();
  }
}
