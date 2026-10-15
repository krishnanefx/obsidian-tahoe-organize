/*
 * Live link suggestions: words that match one of your note titles get a
 * subtle dotted underline as you type. Click one to turn it into a [[link]].
 * Only the visible part of the note is scanned, so it stays fast in large
 * vaults.
 */

import { editorInfoField, Notice } from "obsidian";
import { ViewPlugin, Decoration } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { debounce, ignored } from "./util";

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;
const SKIP_NODE = /code|link|url|frontmatter|hashtag|math|comment|escape|html|hmd-internal|footref|formatting-header/i;

class TitleIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.byFirstWord = new Map();
    this.version = 0;
    this.rebuild = debounce(() => this.build(), 800);
  }

  build() {
    const s = this.plugin.settings;
    const min = Number(s.linkMinLength) || 4;
    const ignore = new Set((s.linkIgnore || []).map((x) => String(x).toLowerCase().trim()).filter(Boolean));
    const map = new Map();
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const title = file.basename;
      if (title.length < min || ignore.has(title.toLowerCase()) || file.path === s.ocrIndexNote || ignored(this.plugin.app, file.path)) continue;
      if (/^untitled( \d+)?$/i.test(title)) continue;
      const words = title.match(WORD);
      if (!words) continue;
      const first = words[0].toLowerCase();
      // A one-word, all-lowercase title ("ideas") must match exactly; others ignore case.
      const exact = words.length === 1 && title === title.toLowerCase();
      if (!map.has(first)) map.set(first, []);
      map.get(first).push({ title, lower: title.toLowerCase(), exact, path: file.path });
    }
    for (const list of map.values()) list.sort((a, b) => b.title.length - a.title.length);
    this.byFirstWord = map;
    this.version++;
    this.plugin.app.workspace.updateOptions();
  }
}

function suggestionsPlugin(plugin, index) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.version = index.version;
        this.decorations = this.build(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged || this.version !== index.version) {
          this.version = index.version;
          this.decorations = this.build(update.view);
        }
      }

      build(view) {
        const builder = new RangeSetBuilder();
        if (!plugin.settings.features.linkSuggestions) return builder.finish();
        const info = view.state.field(editorInfoField, false);
        const self = info && info.file ? info.file.path : null;
        const state = view.state;
        const tree = syntaxTree(state);
        const marks = [];

        for (const { from, to } of view.visibleRanges) {
          // Ranges to leave alone: code, existing links, URLs, tags, maths, front matter.
          const skip = [];
          tree.iterate({
            from,
            to,
            enter: (node) => {
              if (SKIP_NODE.test(node.type.name)) skip.push([node.from, node.to]);
            },
          });
          let line = state.doc.lineAt(from);
          for (;;) {
            this.scanLine(line, skip, self, marks);
            if (line.to >= to || line.number >= state.doc.lines) break;
            line = state.doc.line(line.number + 1);
          }
        }
        marks.sort((a, b) => a.from - b.from);
        let last = -1;
        for (const m of marks) {
          if (m.from < last) continue;
          builder.add(m.from, m.to, Decoration.mark({ class: "tahoe-link-suggestion", attributes: { "data-tahoe-link": m.path, "aria-label": `Link to ${m.title}` } }));
          last = m.to;
        }
        return builder.finish();
      }

      scanLine(line, skip, self, marks) {
        const text = line.text;
        if (!text.trim() || /^\s*(```|~~~|---\s*$)/.test(text)) return;
        const inSkip = (a, b) => skip.some(([s, e]) => a < e && b > s);
        WORD.lastIndex = 0;
        let m;
        while ((m = WORD.exec(text))) {
          const start = m.index;
          const candidates = index.byFirstWord.get(m[0].toLowerCase());
          if (!candidates) continue;
          for (const c of candidates) {
            if (c.path === self) continue;
            const slice = text.substr(start, c.title.length);
            if (slice.length !== c.title.length) continue;
            if (c.exact ? slice !== c.title : slice.toLowerCase() !== c.lower) continue;
            const after = text.charAt(start + c.title.length);
            if (after && /[\p{L}\p{N}]/u.test(after)) continue;
            const before = text.charAt(start - 1);
            if (before === "[" || before === "#" || before === "/") continue;
            const from = line.from + start;
            const to = from + c.title.length;
            if (inSkip(from, to)) continue;
            marks.push({ from, to, path: c.path, title: c.title });
            WORD.lastIndex = start + c.title.length;
            break;
          }
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        mousedown(e, view) {
          const target = e.target instanceof HTMLElement ? e.target.closest(".tahoe-link-suggestion") : null;
          if (!target || e.button !== 0 || e.shiftKey || e.altKey) return false;
          const path = target.getAttribute("data-tahoe-link");
          const file = plugin.app.vault.getAbstractFileByPath(path);
          if (!file) return false;
          const pos = view.posAtDOM(target);
          let found = null;
          this.decorations.between(pos, pos + 1, (from, to) => {
            found = { from, to };
            return false;
          });
          if (!found) return false;
          e.preventDefault();
          const info = view.state.field(editorInfoField, false);
          const source = info && info.file ? info.file.path : "";
          const shown = view.state.doc.sliceString(found.from, found.to);
          const linktext = plugin.app.metadataCache.fileToLinktext(file, source, true);
          const insert = shown === linktext ? `[[${linktext}]]` : `[[${linktext}|${shown}]]`;
          view.dispatch({ changes: { from: found.from, to: found.to, insert }, selection: { anchor: found.from + insert.length }, userEvent: "input.link" });
          new Notice(`Linked to ${file.basename} — ⌘Z to undo`, 1600);
          return true;
        },
      },
    }
  );
}

// "Link all suggestions in this note"
function linkAll(plugin, index, editor, file) {
  const lines = editor.getValue().split("\n");
  let count = 0;
  let inFence = false;
  const out = lines.map((text) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return text;
    }
    if (inFence || !text.trim()) return text;
    let result = "";
    let pos = 0;
    WORD.lastIndex = 0;
    let m;
    while ((m = WORD.exec(text))) {
      const start = m.index;
      if (/\[\[[^\]]*$/.test(text.slice(0, start)) || /`[^`]*$/.test(text.slice(0, start))) continue;
      const candidates = index.byFirstWord.get(m[0].toLowerCase()) || [];
      for (const c of candidates) {
        if (c.path === file.path) continue;
        const slice = text.substr(start, c.title.length);
        if (c.exact ? slice !== c.title : slice.toLowerCase() !== c.lower) continue;
        const after = text.charAt(start + c.title.length);
        if (after && /[\p{L}\p{N}]/u.test(after)) continue;
        const target = plugin.app.vault.getAbstractFileByPath(c.path);
        const linktext = plugin.app.metadataCache.fileToLinktext(target, file.path, true);
        result += text.slice(pos, start) + (slice === linktext ? `[[${linktext}]]` : `[[${linktext}|${slice}]]`);
        pos = start + c.title.length;
        WORD.lastIndex = pos;
        count++;
        break;
      }
    }
    return result + text.slice(pos);
  });
  if (count) editor.setValue(out.join("\n"));
  new Notice(count ? `Added ${count} ${count === 1 ? "link" : "links"}` : "No unlinked mentions in this note");
}

export { TitleIndex, suggestionsPlugin, linkAll };
