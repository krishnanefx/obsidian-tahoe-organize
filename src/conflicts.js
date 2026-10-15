/*
 * iCloud conflict fixer.
 *
 * When two devices change the same file before iCloud syncs, iCloud keeps
 * both and names the newer one "Note 2.md" — or, for whole folders,
 * ".obsidian 2". This view finds those copies, shows what differs, and lets
 * you keep one side, keep both sets of lines, or move the copy to the Trash.
 */

import { ItemView, TFile, TFolder, setIcon, normalizePath } from "obsidian";
import { moveToTrash, diffLines, mergeKeepingBoth, confirm, notice, formatBytes, markSingle } from "./util";

const VIEW_CONFLICTS = "tahoe-icloud-conflicts";
const COPY_NAME = /^(.*) (\d{1,2})$/;

async function listRecursive(adapter, dir, limit = 4000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let listing;
    try {
      listing = await adapter.list(d);
    } catch {
      continue;
    }
    out.push(...listing.files);
    stack.push(...listing.folders);
  }
  return out;
}

async function readText(app, path) {
  const f = app.vault.getAbstractFileByPath(path);
  if (f instanceof TFile) return app.vault.read(f);
  return app.vault.adapter.read(path);
}

async function scanConflicts(app) {
  const adapter = app.vault.adapter;
  const config = app.vault.configDir; // ".obsidian"
  const result = { identical: [], different: [], configFolders: [], folders: [] };

  // 1. Copies of notes and attachments: "Name 2.ext" next to "Name.ext"
  const filePairs = [];
  for (const f of app.vault.getFiles()) {
    const m = COPY_NAME.exec(f.basename);
    if (!m) continue;
    const parent = f.parent && !f.parent.isRoot() ? `${f.parent.path}/` : "";
    const original = `${parent}${m[1]}.${f.extension}`;
    if (app.vault.getAbstractFileByPath(original)) filePairs.push({ copy: f.path, original, hidden: false });
  }

  // 2. Copies inside the settings folder: "workspace 2.json"
  const configFiles = await listRecursive(adapter, config);
  const configSet = new Set(configFiles);
  for (const p of configFiles) {
    const m = /^(.*\/)?([^/]+) (\d{1,2})(\.[^./]+)$/.exec(p);
    if (!m) continue;
    const original = `${m[1] || ""}${m[2]}${m[4]}`;
    if (configSet.has(original)) filePairs.push({ copy: p, original, hidden: true });
  }

  for (const pair of filePairs) {
    const textual = /\.(md|txt|json|css|js|canvas|base|csv|ya?ml)$/i.test(pair.copy);
    let a = null;
    let b = null;
    let same = false;
    try {
      if (textual) {
        [a, b] = await Promise.all([readText(app, pair.original), readText(app, pair.copy)]);
        same = a === b;
      } else {
        const [x, y] = await Promise.all([adapter.readBinary(pair.original), adapter.readBinary(pair.copy)]);
        same = x.byteLength === y.byteLength && Buffer.from(x).equals(Buffer.from(y));
      }
    } catch {
      continue;
    }
    const entry = { ...pair, textual, a, b };
    if (same) result.identical.push(entry);
    else result.different.push(entry);
  }

  // 3. Duplicate settings folders: ".obsidian 2" … next to ".obsidian"
  const root = await adapter.list("/");
  for (const folder of root.folders) {
    const name = folder.replace(/^\//, "");
    const m = /^(.+) (\d{1,2})$/.exec(name);
    if (!m || m[1] !== config) continue;
    const files = await listRecursive(adapter, name);
    const rel = (p) => p.slice(name.length + 1);
    let differ = 0;
    let onlyHere = 0;
    const extras = new Map(); // "plugins/calendar" → kind
    for (const p of files) {
      const r = rel(p);
      const main = `${config}/${r}`;
      if (!(await adapter.exists(main))) {
        onlyHere++;
        const top = /^(plugins|themes|snippets)\/([^/]+)/.exec(r);
        if (top) extras.set(`${top[1]}/${top[2]}`, top[1]);
      } else if (/\.(json|css|js|md)$/.test(r)) {
        try {
          if ((await adapter.read(p)) !== (await adapter.read(main))) differ++;
        } catch {
          // unreadable: counted as the same
        }
      }
    }
    result.configFolders.push({ path: name, files: files.length, differ, onlyHere, extras: [...extras.entries()].map(([p, kind]) => ({ path: p, kind })) });
  }

  // 4. Duplicate folders in the vault: "Projects 2" next to "Projects"
  for (const f of app.vault.getAllLoadedFiles()) {
    if (!(f instanceof TFolder) || f.isRoot()) continue;
    const m = COPY_NAME.exec(f.name);
    if (!m) continue;
    const parent = f.parent && !f.parent.isRoot() ? `${f.parent.path}/` : "";
    const original = app.vault.getAbstractFileByPath(`${parent}${m[1]}`);
    if (original instanceof TFolder) {
      let count = 0;
      const walk = (folder) => folder.children.forEach((c) => (c instanceof TFolder ? walk(c) : count++));
      walk(f);
      result.folders.push({ path: f.path, original: original.path, files: count });
    }
  }

  return result;
}

class ConflictsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.result = null;
    this.expanded = new Set();
  }

  getViewType() {
    return VIEW_CONFLICTS;
  }

  getDisplayText() {
    return "iCloud conflicts";
  }

  getIcon() {
    return "cloud-alert";
  }

  async onOpen() {
    this.contentEl.addClass("tahoe-organize-view", "tahoe-conflicts");
    await this.rescan();
  }

  async rescan() {
    this.render(true);
    this.result = await scanConflicts(this.app);
    this.render(false);
  }

  render(loading) {
    const el = this.contentEl;
    el.empty();
    const head = el.createDiv({ cls: "tahoe-organize-hero" });
    const icon = head.createDiv({ cls: "tahoe-organize-hero-icon is-blue" });
    setIcon(icon, "cloud");
    head.createDiv({ cls: "tahoe-organize-hero-title", text: "iCloud conflicts" });
    head.createDiv({
      cls: "tahoe-organize-hero-desc",
      text: "When two devices change the same file before iCloud syncs, iCloud keeps both and names one “… 2”. Review the copies here — anything removed goes to the Trash.",
    });
    const actions = head.createDiv({ cls: "tahoe-organize-hero-actions" });
    const rescan = actions.createEl("button", { text: loading ? "Scanning…" : "Scan again" });
    rescan.disabled = loading;
    rescan.addEventListener("click", () => this.rescan());
    if (loading || !this.result) return;

    const r = this.result;
    const total = r.identical.length + r.different.length + r.configFolders.length + r.folders.length;
    if (!total) {
      const ok = el.createDiv({ cls: "tahoe-organize-empty" });
      setIcon(ok.createDiv({ cls: "tahoe-organize-empty-icon" }), "check-circle-2");
      ok.createDiv({ text: "No iCloud conflicts — your vault is tidy." });
      return;
    }

    if (r.identical.length) {
      const sec = this.section(el, "Identical copies", `${r.identical.length} ${r.identical.length === 1 ? "copy is" : "copies are"} exactly the same as the original — safe to remove.`);
      sec.header.addClass("has-button");
      const bulk = sec.header.createEl("button", { cls: "mod-cta", text: "Move all to trash" });
      bulk.addEventListener("click", async () => {
        const ok = await confirm(this.app, { title: "Remove identical copies?", message: `${r.identical.length === 1 ? "1 duplicate file" : `${r.identical.length} duplicate files`} will move to the Trash. The originals stay where they are.` });
        if (!ok) return;
        for (const item of r.identical) await moveToTrash(this.app, item.copy);
        notice(`Moved ${r.identical.length} identical copies to the Trash`);
        this.rescan();
      });
      for (const item of r.identical) {
        const row = this.row(sec.list, item.copy, `Same as ${item.original}`, item.hidden ? "settings" : "file");
        this.action(row, "Move to Trash", async () => {
          await moveToTrash(this.app, item.copy);
          this.rescan();
        });
      }
    }

    if (r.different.length) {
      const sec = this.section(el, "Copies that differ", "Compare each copy with its original, then choose what to keep.");
      for (const item of r.different) this.differentRow(sec.list, item);
    }

    if (r.configFolders.length) {
      const sec = this.section(el, "Duplicate settings folders", "Old copies of Obsidian’s settings folder. Bring back anything you still want, then move the copy to the Trash.");
      for (const cf of r.configFolders) {
        const meta = [`${cf.files} ${cf.files === 1 ? "file" : "files"}`, cf.differ ? `${cf.differ} differ` : "", cf.onlyHere ? `${cf.onlyHere} only here` : "nothing new"].filter(Boolean).join(" · ");
        const row = this.row(sec.list, cf.path, meta, "settings");
        this.action(row, "Move to Trash", async () => {
          const ok = await confirm(this.app, { title: `Move “${cf.path}” to the Trash?`, message: cf.extras.length ? `It still has ${cf.extras.length === 1 ? "a plugin or theme" : `${cf.extras.length} plugins or themes`} that aren’t in your current settings. You can bring ${cf.extras.length === 1 ? "it" : "them"} back first.` : `Your current settings in ${this.app.vault.configDir} aren’t affected.` });
          if (!ok) return;
          await moveToTrash(this.app, cf.path);
          notice(`Moved ${cf.path} to the Trash`);
          this.rescan();
        });
        if (cf.extras.length) {
          const extras = row.createDiv({ cls: "tahoe-organize-sublist" });
          extras.createDiv({ cls: "tahoe-organize-sublist-title", text: "Only in this copy" });
          for (const x of cf.extras) {
            const sub = extras.createDiv({ cls: "tahoe-organize-subrow" });
            setIcon(sub.createSpan({ cls: "tahoe-organize-subrow-icon" }), x.kind === "themes" ? "palette" : x.kind === "snippets" ? "file-code" : "puzzle");
            sub.createSpan({ text: x.path.split("/")[1] });
            sub.createSpan({ cls: "tahoe-organize-subrow-kind", text: x.kind === "themes" ? "Theme" : x.kind === "snippets" ? "CSS snippet" : "Plugin" });
            const b = sub.createEl("button", { cls: "tahoe-organize-chip", text: "Bring back" });
            b.addEventListener("click", async () => {
              await this.copyFolder(`${cf.path}/${x.path}`, `${this.app.vault.configDir}/${x.path}`);
              notice(x.kind === "plugins" ? `${x.path.split("/")[1]} copied back — turn it on in Settings → Community plugins` : `${x.path.split("/")[1]} copied back`);
              this.rescan();
            });
          }
        }
      }
    }

    if (r.folders.length) {
      const sec = this.section(el, "Duplicate folders", "Folders iCloud copied. Open them to check, then move the copy to the Trash.");
      for (const f of r.folders) {
        const row = this.row(sec.list, f.path, `${f.files} ${f.files === 1 ? "file" : "files"} · original: ${f.original}`, "folder");
        this.action(row, "Show", () => {
          const folder = this.app.vault.getAbstractFileByPath(f.path);
          const explorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
          if (explorer && folder) {
            this.app.workspace.revealLeaf(explorer);
            explorer.view.revealInFolder && explorer.view.revealInFolder(folder);
          }
        });
        this.action(row, "Move to Trash", async () => {
          const ok = await confirm(this.app, { title: `Move “${f.path}” to the Trash?`, message: `${f.files} files inside will go to the Trash with it. Check that “${f.original}” has what you need first.` });
          if (!ok) return;
          await moveToTrash(this.app, f.path);
          this.rescan();
        });
      }
    }
  }

  section(parent, title, desc) {
    const sec = parent.createDiv({ cls: "tahoe-organize-section" });
    const header = sec.createDiv({ cls: "tahoe-organize-section-header" });
    const text = header.createDiv({ cls: "tahoe-organize-section-text" });
    text.createDiv({ cls: "tahoe-organize-section-title", text: title });
    if (desc) text.createDiv({ cls: "tahoe-organize-section-desc", text: desc });
    const list = sec.createDiv({ cls: "tahoe-organize-card" });
    return { sec, header, list };
  }

  row(list, title, meta, kind) {
    const row = list.createDiv({ cls: "tahoe-organize-row" });
    const line = row.createDiv({ cls: "tahoe-organize-row-line" });
    const icon = line.createDiv({ cls: `tahoe-organize-row-icon is-${kind}` });
    setIcon(icon, kind === "settings" ? "settings" : kind === "folder" ? "folder" : "file");
    const text = line.createDiv({ cls: "tahoe-organize-row-text" });
    text.createDiv({ cls: "tahoe-organize-row-title", text: title });
    if (meta) text.createDiv({ cls: "tahoe-organize-row-meta", text: meta });
    row.actionsEl = line.createDiv({ cls: "tahoe-organize-row-actions" });
    return row;
  }

  action(row, label, onClick, cls = "") {
    const b = row.actionsEl.createEl("button", { cls: `tahoe-organize-chip ${cls}`, text: label });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    markSingle(row);
    return b;
  }

  differentRow(list, item) {
    const stats = item.textual ? diffLines(item.a, item.b) : null;
    const added = stats ? stats.filter((d) => d.type === "add").length : 0;
    const removed = stats ? stats.filter((d) => d.type === "del").length : 0;
    const meta = item.textual ? (stats ? `Original: ${item.original} · copy has +${added} −${removed} lines` : `Original: ${item.original} · too large to compare`) : `Original: ${item.original} · binary file`;
    const row = this.row(list, item.copy, meta, item.hidden ? "settings" : "file");
    this.action(row, this.expanded.has(item.copy) ? "Hide changes" : "Compare", () => {
      if (this.expanded.has(item.copy)) this.expanded.delete(item.copy);
      else this.expanded.add(item.copy);
      this.render(false);
    });
    this.action(row, "Keep original", async () => {
      await moveToTrash(this.app, item.copy);
      notice("Kept the original; the copy is in the Trash");
      this.rescan();
    });
    this.action(row, "Keep copy", async () => {
      const ok = await confirm(this.app, { title: "Replace the original with the copy?", message: `“${item.original}” gets the copy’s contents. The old version goes to the Trash as “${item.copy}”.`, confirm: "Replace", warning: false });
      if (!ok) return;
      await this.replaceOriginal(item, item.b);
      this.rescan();
    });
    if (item.textual && !item.hidden && /\.md$/i.test(item.copy)) {
      this.action(row, "Keep both", async () => {
        await this.replaceOriginal(item, mergeKeepingBoth(item.a, item.b));
        notice("Merged — every line from both versions is in the original");
        this.rescan();
      });
    }

    if (this.expanded.has(item.copy) && stats) {
      const diff = row.createDiv({ cls: "tahoe-organize-diff" });
      let shownSame = 0;
      stats.forEach((d, i) => {
        // Collapse long unchanged stretches, keeping two lines of context.
        if (d.type === "same") {
          const near = stats.slice(Math.max(0, i - 2), i + 3).some((x) => x.type !== "same");
          if (!near) {
            if (shownSame++ === 0) diff.createDiv({ cls: "tahoe-organize-diff-gap", text: "⋯" });
            return;
          }
        }
        shownSame = 0;
        const line = diff.createDiv({ cls: `tahoe-organize-diff-line is-${d.type}` });
        line.createSpan({ cls: "tahoe-organize-diff-sign", text: d.type === "add" ? "+" : d.type === "del" ? "−" : " " });
        line.createSpan({ text: d.text || " " });
      });
      diff.createDiv({ cls: "tahoe-organize-diff-legend", text: "− only in the original   + only in the copy" });
    }
  }

  async replaceOriginal(item, text) {
    const original = this.app.vault.getAbstractFileByPath(item.original);
    if (original instanceof TFile) await this.app.vault.modify(original, text);
    else await this.app.vault.adapter.write(item.original, text);
    await moveToTrash(this.app, item.copy);
  }

  async copyFolder(from, to) {
    const adapter = this.app.vault.adapter;
    const files = await listRecursive(adapter, from);
    for (const f of files) {
      const dest = normalizePath(`${to}/${f.slice(from.length + 1)}`);
      const dir = dest.slice(0, dest.lastIndexOf("/"));
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      if (!(await adapter.exists(dest))) await adapter.writeBinary(dest, await adapter.readBinary(f));
    }
  }
}

export { ConflictsView, VIEW_CONFLICTS, scanConflicts, formatBytes };
