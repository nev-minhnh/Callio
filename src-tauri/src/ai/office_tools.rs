//! Tools that let the AI (Claude Code and the API models) read and edit every kind of file
//! Callio opens: Word documents, spreadsheets and PDFs. The window does the work (rpc), so an
//! edit to a file open in a tab shows at once and is one step in that tab's Undo list; a file
//! that isn't open is edited by the office engine and saved with a backup of the old one.
use serde_json::{json, Value};

pub const NAMES: &[&str] = &["office_read", "office_commands", "word_edit", "sheet_edit", "deck_edit", "image_edit", "pdf_tool"];

fn defs() -> Vec<(&'static str, &'static str, Value)> {
    let cmds = json!({"type": "array", "items": {"type": "object", "properties": {"command": {"type": "string"}, "params": {"type": "object"}}, "required": ["command"]}});
    vec![
        (
            "office_read",
            "Read a Word document (.docx .doc .odt .rtf) as Markdown, a presentation (.pptx .odp) as its slides (titles, shapes with ids and boxes, text, notes), a spreadsheet (.xlsx .xlsm .xls .xlsb .ods .csv .tsv) as its cells (shown value, and the formula where there is one), a picture or photo (.jpg .png .tif .webp .heic, camera raw…) as its size, metadata and current edits (slider values, masks, crop), or a PDF's text. If the file is open in Callio, you get what is on screen now, unsaved changes included. For spreadsheets give `sheet` (0-based index or name) and `range` (\"A1:F40\"); the used range by default.",
            json!({"type": "object", "properties": {"path": {"type": "string"}, "sheet": {"description": "spreadsheets: sheet index (0-based) or name"}, "range": {"type": "string"}, "from_page": {"type": "integer"}, "to_page": {"type": "integer"}}, "required": ["path"]}),
        ),
        (
            "office_commands",
            "List the editing commands for Word documents (kind \"word\": text.insert, edit.replaceAll, para.style, format.bold, insert.table, layout.margins… ) spreadsheets (kind \"sheet\": cell.set, home.bold, home.numberFormat, home.insertRows, data.sortAscending, insert.chart…) presentations (kind \"deck\": slide.new, slide.go, insert.textBox, shape.insert, text.replace, slide.notes, design.theme, transition.set…) or pictures (kind \"image\": develop.set with slider ids, develop.auto, develop.wb, develop.treatment, develop.profile, preset.apply, crop.aspect, crop.straighten, photo.rotateLeft, mask.add, mask.adjust, spot.findDust…), with their parameters. Filter with `query`.",
            json!({"type": "object", "properties": {"kind": {"type": "string", "enum": ["word", "sheet", "deck", "image"]}, "query": {"type": "string"}}, "required": ["kind"]}),
        ),
        (
            "word_edit",
            "Edit a Word document (.docx .doc .odt .rtf) with editing commands, run in order as ONE step the author can undo. Common: {command:\"edit.replaceAll\", params:{text, with}}; select text then replace it: {command:\"edit.find\", params:{text}} followed by {command:\"text.insert\", params:{text}}; {command:\"caret.docEnd\"}, {command:\"text.newParagraph\"}, {command:\"para.style\", params:{style:\"Heading 1\"}}, {command:\"format.bold\"}, {command:\"insert.table\", params:{rows, cols}}, {command:\"references.footnote\", params:{text}}. Use office_commands kind word for the rest. If the document is open in Callio the change shows there unsaved (the author saves); otherwise the file is saved after a backup.",
            json!({"type": "object", "properties": {"path": {"type": "string"}, "commands": cmds.clone(), "label": {"type": "string", "description": "short name for the Undo list, e.g. \"Rewrite the introduction\""}}, "required": ["path", "commands"]}),
        ),
        (
            "sheet_edit",
            "Edit a spreadsheet (.xlsx .xlsm .csv .tsv; .xls .xlsb .ods are saved as .xlsx) as ONE step the author can undo. Give `cells` to set values or formulas ({\"B2\": \"42\", \"C2\": \"=SUM(A1:A9)\"}), and/or spreadsheet `commands` (e.g. {command:\"home.bold\", params:{range:\"A1:F1\", on:true}}, {command:\"home.numberFormat\", params:{range, format:\"Currency\"}}, {command:\"home.insertRows\", params:{rows:\"3:4\"}}, {command:\"data.sortAscending\", params:{range}}). `sheet`: index (0-based) or name. If the workbook is open in Callio the change shows there unsaved; otherwise the file is saved after a backup.",
            json!({"type": "object", "properties": {"path": {"type": "string"}, "sheet": {"description": "sheet index (0-based) or name"}, "cells": {"type": "object", "additionalProperties": {"type": "string"}}, "commands": cmds, "label": {"type": "string"}}, "required": ["path"]}),
        ),
        (
            "deck_edit",
            "Edit a PowerPoint presentation (.pptx .ppsx .potx .odp) with editing commands, run in order as ONE step the author can undo. Common: {command:\"slide.new\", params:{layout:\"titleAndContent\"}}, {command:\"slide.go\", params:{index}}, {command:\"insert.textBox\", params:{rect:[x,y,w,h], text}}, {command:\"shape.insert\", params:{preset:\"roundRect\", rect:[x,y,w,h], text}}, {command:\"text.replace\", params:{text, with}}, {command:\"slide.notes\", params:{text}}, {command:\"slide.layout\", params:{layout}}, {command:\"design.theme\", params:{name}}. Read shape ids and boxes with office_read first; slide units are points. Use office_commands kind deck for the rest. If the presentation is open in Callio the change shows there unsaved; otherwise the file is saved after a backup.",
            json!({"type": "object", "properties": {"path": {"type": "string"}, "commands": cmds.clone(), "label": {"type": "string"}}, "required": ["path", "commands"]}),
        ),
        (
            "image_edit",
            "Edit a picture or photo (.jpg .jpeg .png .tif .tiff .webp .avif .heic .jxl, camera raw .cr2 .nef .arw .dng…) with editing commands, run in order as ONE step the author can undo. The edits are non-destructive until saved. Common: {command:\"develop.set\", params:{values:{\"light.exposure\":0.4, \"light.shadows\":30, \"color.vibrance\":15}}}, {command:\"develop.auto\"}, {command:\"develop.wb\", params:{mode:\"daylight\"}}, {command:\"develop.treatment\", params:{bw:true}}, {command:\"crop.aspect\", params:{aspect:\"16x9\"}}, {command:\"crop.straighten\", params:{angle:1.5}}, {command:\"photo.rotateRight\"}, {command:\"mask.add\", params:{kind:\"radial\", center:[0.5,0.5], rx:0.3, ry:0.2}} then {command:\"mask.adjust\", params:{values:{exposure:0.5}}}, {command:\"spot.findDust\"}. Read the current edits with office_read and every command and slider id with office_commands kind image. If the picture is open in Callio the change shows there unsaved; otherwise the file is saved after a backup (raw files are never overwritten).",
            json!({"type": "object", "properties": {"path": {"type": "string"}, "commands": cmds.clone(), "label": {"type": "string"}}, "required": ["path", "commands"]}),
        ),
        (
            "pdf_tool",
            "Change a PDF with Callio's PDF tools. op: organize {order:[{page (0-based), rotate}]}, select {pages:\"1-3,7\"}, delete {pages}, rotate {pages, degrees}, insert {at, file|blank}, merge {inputs:[paths]}, split {mode:\"every\"|\"before\", n|at, outDir}, nup {per}, crop {margins:[t,r,b,l] pt}, pageNumbers {format:\"Page <<1>> of <<n>>\", position:\"bc\"}, headerFooter {text:[6 strings]}, watermark {text, size, color, opacity, rotation}, removeMarks, flatten, compress {level:lossless|standard|screen|smallest}, repair, protect {userPassword, ownerPassword}, unlock {password}, redact {areas:[{page, rect:[x0,y0,x1,y1] pt}]}, metadata {info:{Title, Author…}}, attach {files}. If the PDF is open in Callio, page changes (organize, select, delete, rotate, insert, nup, crop, pageNumbers, headerFooter, watermark, removeMarks, flatten) apply to that tab as one undoable step; otherwise the result is written to `output` (default: a new file next to it — the original is never overwritten).",
            json!({"type": "object", "properties": {"path": {"type": "string"}, "op": {"type": "string"}, "output": {"type": "string"}, "args": {"type": "object"}}, "required": ["path", "op"]}),
        ),
    ]
}

/// For Callio's MCP server (Claude Code).
pub fn mcp_defs() -> Vec<Value> {
    defs().into_iter().map(|(n, d, s)| json!({"name": n, "description": d, "inputSchema": s})).collect()
}

/// For the API models' tool list.
pub fn chat_defs() -> Vec<Value> {
    defs().into_iter().map(|(n, d, s)| json!({"name": n, "description": d, "parameters": s})).collect()
}
