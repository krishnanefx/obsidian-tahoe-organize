/*
 * Vault health check: broken links, orphan notes, empty notes, unused
 * attachments and very large files — each with a one-click fix. Anything
 * removed goes to the Trash.
 */

import { ItemView, Menu, TFile, setIcon, normalizePath, Platform } from "obsidian";
import { moveToTrash, confirm, notice, formatBytes, similarity, escapeRegExp, ignored, markSingle } from "./util";
import { scanConflicts } from "./conflicts";

const VIEW_HEALTH = "tahoe-vault-health";
const SHOW = 40;

async function analyseVault(app, settings) {
  const files = app.vault.getFiles();
  const notes = app.vault.getMarkdownFiles();
  const resolved = app.metadataCache.resolvedLinks;
  const unresolved = app.metadataCache.unresolvedLinks;
  const excluded = (settings.healthExclude || []).filter(Boolean).map((p) => p.replace(/\/$/, "") + "/");
  const isExcluded = (path) => excluded.some((p) => path.startsWith(p)) || path === settings.ocrIndexNote || ignored(app, path);

  const incoming = new Map();
  for (const [src, dests] of Object.entries(resolved)) {
    for (const dest of Object.keys(dests)) if (dest !== src) incoming.set(dest, (incoming.get(dest) || 0) + 1);
  }
  // Canvas files reference attachments too.
  for (const f of files.filter((x) => x.extension === "canvas")) {
    try {
      const data = JSON.parse(await app.vault.cachedRead(f));
      for (const node of data.nodes || []) if (node.file) incoming.set(node.file, (incoming.get(node.file) || 0) + 1);
    } catch {
      // not a canvas we can read
    }
  }

  // Broken links, grouped by target
  const broken = new Map();
  for (const [src, links] of Object.entries(unresolved)) {
    if (isExcluded(src)) continue;
    for (const [link, count] of Object.entries(links)) {
      if (!broken.has(link)) broken.set(link, { link, sources: [], count: 0 });
      const b = broken.get(link);
      b.sources.push(src);
      b.count += count;
    }
  }
  const names = notes.map((f) => f.basename);
  for (const b of broken.values()) {
    const target = b.link.split("#")[0].split("/").pop();
    let best = null;
    let score = 0;
    for (const n of names) {
      const s = similarity(target, n);
      if (s > score) {
        score = s;
        best = n;
      }
    }
    if (best && score >= 0.6) b.suggestion = best;
  }

  const empty = [];
  for (const f of notes) {
    if (isExcluded(f.path) || f.stat.size > 400) continue;
    const text = await app.vault.cachedRead(f);
    if (!text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim()) empty.push(f);
  }

  // Orphans: nothing links in and nothing links out (even to a note that doesn't exist yet).
  const linksOut = (path) => Object.keys(resolved[path] || {}).length + Object.keys(unresolved[path] || {}).length;
  const orphans = notes
    .filter((f) => !isExcluded(f.path) && !empty.includes(f) && !incoming.has(f.path) && linksOut(f.path) === 0)
    .sort((a, b) => b.stat.mtime - a.stat.mtime);

  const attachments = files.filter((f) => f.extension !== "md" && f.extension !== "canvas" && f.extension !== "base");
  const unused = attachments.filter((f) => !isExcluded(f.path) && !incoming.has(f.path)).sort((a, b) => b.stat.size - a.stat.size);
  const limit = (Number(settings.hugeAttachmentMB) || 10) * 1e6;
  const huge = files.filter((f) => f.stat.size >= limit).sort((a, b) => b.stat.size - a.stat.size);

  let conflicts = 0;
  try {
    const c = await scanConflicts(app);
    conflicts = c.identical.length + c.different.length + c.configFolders.length + c.folders.length;
  } catch {
    // conflicts aren't counted then
  }

  const totalSize = files.reduce((s, f) => s + f.stat.size, 0);
  return { notes: notes.length, attachments: attachments.length, totalSize, broken: [...broken.values()].sort((a, b) => b.count - a.count), orphans, empty, unused, huge, conflicts };
}

class HealthView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.report = null;
    this.expanded = new Set();
  }

  getViewType() {
    return VIEW_HEALTH;
  }

  getDisplayText() {
    return "Vault health";
  }

  getIcon() {
    return "heart-pulse";
  }

  async onOpen() {
    this.contentEl.addClass("tahoe-organize-view", "tahoe-health");
    await this.rescan();
  }

  // After an edit, wait for Obsidian to re-index the notes before scanning again.
  rescanSoon() {
    const cache = this.app.metadataCache;
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      cache.offref(ref);
      this.rescan();
    };
    const ref = cache.on("resolved", go);
    window.setTimeout(go, 1500);
  }

  async rescan() {
    this.render(true);
    this.report = await analyseVault(this.app, this.plugin.settings);
    this.render(false);
    this.checkDuplicates();
  }

  // Duplicate ideas come from Tahoe Intelligence, which needs a moment.
  async checkDuplicates() {
    const ai = this.app.plugins.getPlugin("tahoe-intelligence");
    if (!ai || !ai.api || !ai.settings.features.similar) {
      this.dupes = undefined;
      return;
    }
    if (this.dupeJob) this.dupeJob.abort();
    const job = (this.dupeJob = new AbortController());
    this.dupes = null; // checking
    this.renderKeepingScroll();
    try {
      const out = await ai.api.duplicates({ signal: job.signal });
      if (job.signal.aborted) return;
      this.dupes = out;
    } catch {
      this.dupes = [];
    }
    this.renderKeepingScroll();
  }

  renderKeepingScroll() {
    const top = this.contentEl.scrollTop;
    this.render(false);
    this.contentEl.scrollTop = top;
  }

  onClose() {
    if (this.dupeJob) this.dupeJob.abort();
  }

  render(loading) {
    const el = this.contentEl;
    el.empty();
    const head = el.createDiv({ cls: "tahoe-organize-hero" });
    setIcon(head.createDiv({ cls: "tahoe-organize-hero-icon is-pink" }), "heart-pulse");
    head.createDiv({ cls: "tahoe-organize-hero-title", text: "Vault health" });
    head.createDiv({ cls: "tahoe-organize-hero-desc", text: "Broken links, forgotten notes and files taking up space. Fixes are one click, and anything removed goes to the Trash." });
    const actions = head.createDiv({ cls: "tahoe-organize-hero-actions" });
    const again = actions.createEl("button", { text: loading ? "Checking…" : "Check again" });
    again.disabled = loading;
    again.addEventListener("click", () => this.rescan());
    if (loading || !this.report) return;
    const r = this.report;

    const stats = el.createDiv({ cls: "tahoe-organize-stats" });
    const stat = (value, label, tone) => {
      const s = stats.createDiv({ cls: `tahoe-organize-stat ${tone ? `is-${tone}` : ""}` });
      s.createDiv({ cls: "tahoe-organize-stat-value", text: value });
      s.createDiv({ cls: "tahoe-organize-stat-label", text: label });
    };
    stat(r.notes.toLocaleString(), "notes");
    stat(r.attachments.toLocaleString(), "attachments");
    stat(formatBytes(r.totalSize), "in total");
    stat(String(r.broken.length), "broken links", r.broken.length ? "orange" : "green");

    if (r.conflicts) {
      const banner = el.createDiv({ cls: "tahoe-organize-banner" });
      setIcon(banner.createSpan({ cls: "tahoe-organize-banner-icon" }), "cloud-alert");
      banner.createSpan({ text: `${r.conflicts} iCloud conflict ${r.conflicts === 1 ? "copy needs" : "copies need"} a look.` });
      const b = banner.createEl("button", { cls: "tahoe-organize-chip mod-accent", text: "Review" });
      b.addEventListener("click", () => this.plugin.openConflicts());
    }

    // Broken links
    this.group(el, "Broken links", "Links to notes that don’t exist.", r.broken, (list, b) => {
      const row = this.row(list, `[[${b.link}]]`, `in ${b.sources.length} ${b.sources.length === 1 ? "note" : "notes"}: ${b.sources.slice(0, 2).map((s) => s.replace(/\.md$/, "")).join(", ")}${b.sources.length > 2 ? "…" : ""}`, "unlink");
      if (b.suggestion) this.action(row, `Link to “${b.suggestion}”`, () => this.retarget(b, b.suggestion), "mod-accent");
      this.action(row, "Create note", async () => {
        const parent = this.app.fileManager.getNewFileParent(b.sources[0]);
        const path = normalizePath(`${parent.isRoot() ? "" : parent.path + "/"}${b.link.split("#")[0]}.md`);
        if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.create(path, "");
        notice(`Created ${path}`);
        this.rescanSoon();
      });
      this.action(row, "Unlink", () => this.unlink(b));
    });

    // Notes that say the same thing (Tahoe Intelligence)
    if (this.dupes !== undefined) this.duplicatesSection(el);

    // Empty notes
    this.group(
      el,
      "Empty notes",
      "Notes with nothing in them.",
      r.empty,
      (list, f) => this.fileRow(list, f, "file-x"),
      r.empty.length > 1 ? { label: "Move all to trash", run: () => this.trashAll(r.empty, "empty notes") } : null
    );

    // Unused attachments
    this.group(
      el,
      "Unused attachments",
      "Images and files no note links to.",
      r.unused,
      (list, f) => this.fileRow(list, f, "paperclip", formatBytes(f.stat.size)),
      r.unused.length > 1 ? { label: `Move all to trash (${formatBytes(r.unused.reduce((s, f) => s + f.stat.size, 0))})`, run: () => this.trashAll(r.unused, "unused attachments") } : null
    );

    // Large files
    this.group(el, `Files over ${this.plugin.settings.hugeAttachmentMB} MB`, "The biggest files in your vault.", r.huge, (list, f) => this.fileRow(list, f, "hard-drive", formatBytes(f.stat.size)));

    // Orphans
    this.group(el, "Orphan notes", "Notes with no links in or out — easy to lose track of.", r.orphans, (list, f) => {
      this.fileRow(list, f, "file-symlink", `Edited ${new Date(f.stat.mtime).toLocaleDateString()}`, { trash: false });
    });
  }

  duplicatesSection(el) {
    const title = "Notes that may say the same thing";
    const desc = "Found by meaning on this Mac. Compare them, merge one into the other, or keep both.";
    if (this.dupes === null) {
      const sec = el.createDiv({ cls: "tahoe-organize-section" });
      const header = sec.createDiv({ cls: "tahoe-organize-section-header" });
      const text = header.createDiv({ cls: "tahoe-organize-section-text" });
      text.createDiv({ cls: "tahoe-organize-section-title" }).createSpan({ text: title });
      text.createDiv({ cls: "tahoe-organize-section-desc", text: desc });
      const card = sec.createDiv({ cls: "tahoe-organize-card is-thinking" });
      const row = card.createDiv({ cls: "tahoe-organize-row is-ok tahoe-organize-thinking" });
      const icon = row.createSpan({ cls: "tahoe-triage-ai-icon" });
      setIcon(icon, "sparkles");
      const svg = icon.querySelector("svg");
      if (svg) icon.style.setProperty("--tahoe-ai-glyph", `url("data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg).replace(/currentColor/g, "black"))}")`);
      row.createSpan({ text: "Comparing notes by meaning…" });
      return;
    }
    this.group(el, title, desc, this.dupes, (list, d) => {
      const a = this.app.vault.getAbstractFileByPath(d.a);
      const b = this.app.vault.getAbstractFileByPath(d.b);
      if (!(a instanceof TFile) || !(b instanceof TFile)) return;
      const row = this.row(list, `${a.basename}  ↔  ${b.basename}`, d.pointA || "", "copy");
      const key = `dup:${d.a}|${d.b}`;
      this.action(row, this.expanded.has(key) ? "Hide" : "Compare", () => {
        if (this.expanded.has(key)) this.expanded.delete(key);
        else this.expanded.add(key);
        this.renderKeepingScroll();
      });
      this.action(row, "Merge…", (e) => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle(`Keep “${a.basename}”, merge the other into it`).setIcon("merge").onClick(() => this.merge(a, b)));
        menu.addItem((i) => i.setTitle(`Keep “${b.basename}”, merge the other into it`).setIcon("merge").onClick(() => this.merge(b, a)));
        menu.showAtMouseEvent(e);
      });
      this.action(row, "Keep both", () => {
        const ai = this.app.plugins.getPlugin("tahoe-intelligence");
        if (ai && ai.api) ai.api.keepBoth(d.a, d.b);
        this.dupes = this.dupes.filter((x) => x !== d);
        this.renderKeepingScroll();
      });
      if (this.expanded.has(key)) {
        const cmp = row.createDiv({ cls: "tahoe-organize-compare" });
        for (const [f, point] of [
          [a, d.pointA],
          [b, d.pointB],
        ]) {
          const col = cmp.createDiv({ cls: "tahoe-organize-compare-col" });
          col.createDiv({ cls: "tahoe-organize-compare-title", text: f.basename });
          if (point) col.createDiv({ cls: "tahoe-organize-compare-point", text: point });
          const body = col.createDiv({ cls: "tahoe-organize-compare-body" });
          this.app.vault.cachedRead(f).then((t) => body.setText(t.replace(/^---\n[\s\S]*?\n---\n?/, "").trim()));
        }
      }
    });
  }

  // Keep one note: append the other's text, point its links here, trash it.
  async merge(keep, drop) {
    const ok = await confirm(this.app, {
      title: `Merge “${drop.basename}” into “${keep.basename}”?`,
      message: `Its text is added to the end of “${keep.basename}”, links to it are pointed there, and it moves to the Trash.`,
      confirm: "Merge",
      warning: false,
      icon: "merge",
    });
    if (!ok) return;
    const app = this.app;
    const dropText = (await app.vault.read(drop)).replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    const dropTags = (app.metadataCache.getFileCache(drop)?.frontmatter?.tags) || [];
    await app.vault.process(keep, (data) => `${data.replace(/\s*$/, "")}\n\n---\n*Merged from “${drop.basename}”*\n\n${dropText}\n`);
    if ((Array.isArray(dropTags) ? dropTags : [dropTags]).length) {
      await app.fileManager.processFrontMatter(keep, (fm) => {
        const have = fm.tags == null ? [] : Array.isArray(fm.tags) ? fm.tags : [fm.tags];
        fm.tags = [...new Set([...have, ...(Array.isArray(dropTags) ? dropTags : [dropTags])])];
      });
    }
    // Re-point links to the dropped note, keeping the words readers saw.
    let relinked = 0;
    for (const [src, dests] of Object.entries(app.metadataCache.resolvedLinks)) {
      if (!dests[drop.path] || src === drop.path) continue;
      const file = app.vault.getAbstractFileByPath(src);
      if (!(file instanceof TFile)) continue;
      const cache = app.metadataCache.getFileCache(file);
      const refs = [...(cache?.links || []), ...(cache?.embeds || [])].filter((l) => app.metadataCache.getFirstLinkpathDest(l.link.split("#")[0], src) === drop);
      if (!refs.length) continue;
      const linktext = app.metadataCache.fileToLinktext(keep, src, true);
      await app.vault.process(file, (data) => {
        for (const l of refs) {
          const sub = l.link.includes("#") ? l.link.slice(l.link.indexOf("#")) : "";
          const shown = l.displayText && l.displayText !== l.link ? l.displayText : drop.basename;
          const bang = l.original.startsWith("!") ? "!" : "";
          data = data.split(l.original).join(`${bang}[[${linktext}${sub}|${shown}]]`);
        }
        return data;
      });
      relinked++;
    }
    await moveToTrash(app, drop);
    notice(`Merged into “${keep.basename}”${relinked ? ` · ${relinked} ${relinked === 1 ? "note" : "notes"} relinked` : ""}`);
    this.rescanSoon();
  }

  group(parent, title, desc, items, renderItem, bulk = null) {
    const sec = parent.createDiv({ cls: "tahoe-organize-section" });
    const header = sec.createDiv({ cls: "tahoe-organize-section-header" });
    const text = header.createDiv({ cls: "tahoe-organize-section-text" });
    const t = text.createDiv({ cls: "tahoe-organize-section-title" });
    t.createSpan({ text: title });
    t.createSpan({ cls: `tahoe-organize-count ${items.length ? "" : "is-zero"}`, text: String(items.length) });
    text.createDiv({ cls: "tahoe-organize-section-desc", text: desc });
    if (bulk) {
      header.addClass("has-button");
      const b = header.createEl("button", { cls: "mod-warning", text: bulk.label });
      b.addEventListener("click", bulk.run);
    }
    const card = sec.createDiv({ cls: "tahoe-organize-card" });
    if (!items.length) {
      const ok = card.createDiv({ cls: "tahoe-organize-row is-ok" });
      setIcon(ok.createSpan({ cls: "tahoe-organize-ok-icon" }), "check");
      ok.createSpan({ text: "Nothing to fix" });
      return;
    }
    const all = this.expanded.has(title);
    for (const item of all ? items : items.slice(0, SHOW)) renderItem(card, item);
    if (items.length > SHOW) {
      const more = card.createDiv({ cls: "tahoe-organize-row is-more" });
      more.setText(all ? "Show fewer" : `Show all ${items.length}`);
      more.addEventListener("click", () => {
        if (all) this.expanded.delete(title);
        else this.expanded.add(title);
        this.render(false);
      });
    }
  }

  row(list, title, meta, icon) {
    const row = list.createDiv({ cls: "tahoe-organize-row" });
    const line = row.createDiv({ cls: "tahoe-organize-row-line" });
    setIcon(line.createDiv({ cls: `tahoe-organize-row-icon is-${icon}` }), icon);
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
      onClick(e);
    });
    markSingle(row);
  }

  fileRow(list, file, icon, meta, { trash = true } = {}) {
    const row = this.row(list, file.path, meta || "", icon);
    this.action(row, "Open", () => this.app.workspace.getLeaf(false).openFile(file));
    if (trash) this.action(row, "Move to Trash", async () => {
      await moveToTrash(this.app, file);
      row.remove();
    });
    return row;
  }

  async trashAll(files, what) {
    const ok = await confirm(this.app, { title: `Move ${files.length} ${what} to the Trash?`, message: Platform.isMobile ? "You can get them back from the .trash folder in your vault." : "You can get them back from the Trash in Finder." });
    if (!ok) return;
    for (const f of files) await moveToTrash(this.app, f);
    notice(`Moved ${files.length} ${what} to the Trash`);
    this.rescanSoon();
  }

  linkPattern(link) {
    const target = escapeRegExp(link);
    return new RegExp(`(!?)\\[\\[${target}(#[^\\]|]*)?(\\|[^\\]]*)?\\]\\]`, "g");
  }

  async retarget(b, newName) {
    const re = this.linkPattern(b.link);
    let changed = 0;
    for (const src of b.sources) {
      const f = this.app.vault.getAbstractFileByPath(src);
      if (!(f instanceof TFile)) continue;
      await this.app.vault.process(f, (data) =>
        data.replace(re, (m, bang, heading, alias) => {
          changed++;
          return `${bang}[[${newName}${heading || ""}${alias || ""}]]`;
        })
      );
    }
    notice(`Updated ${changed} ${changed === 1 ? "link" : "links"} to “${newName}”`);
    this.rescanSoon();
  }

  async unlink(b) {
    const ok = await confirm(this.app, { title: `Remove links to “${b.link}”?`, message: "The link text stays in your notes as plain text; embeds of the missing file are removed.", confirm: "Unlink", warning: false });
    if (!ok) return;
    const re = this.linkPattern(b.link);
    for (const src of b.sources) {
      const f = this.app.vault.getAbstractFileByPath(src);
      if (!(f instanceof TFile)) continue;
      await this.app.vault.process(f, (data) => data.replace(re, (m, bang, heading, alias) => (bang ? "" : alias ? alias.slice(1) : b.link)));
    }
    this.rescanSoon();
  }
}

export { HealthView, VIEW_HEALTH, analyseVault };
