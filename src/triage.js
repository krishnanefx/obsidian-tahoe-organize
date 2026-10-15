/*
 * Inbox triage: one note at a time, Mail-style keys.
 *
 *   A  Archive      P  Promote (to permanent notes)   M  Move to folder…
 *   L  Link to…     ⌫  Delete (to Trash)               O  Open the note
 *   J / →  Next     K / ←  Previous                    U  Undo
 *   ⇥  Accept the suggestion (with Tahoe Intelligence: folder, tags, title)
 */

import { Modal, MarkdownRenderer, Component, TFile, TFolder, setIcon, normalizePath } from "obsidian";
import { FolderSuggestModal, NoteSuggestModal, moveFile, today, notice } from "./util";

function findFolder(app, pattern, within = null) {
  const folders = app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder && !f.isRoot() && pattern.test(f.name));
  const scoped = within ? folders.filter((f) => f.path.startsWith(within)) : folders;
  const list = scoped.length ? scoped : folders;
  return list.sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0] || null;
}

// Works out the inbox / archive / promote folders, guessing from folder names.
function triageFolders(app, settings) {
  const inbox = settings.inboxFolder || (findFolder(app, /inbox/i) || {}).path || "";
  const parent = inbox.includes("/") ? inbox.slice(0, inbox.lastIndexOf("/")) : "";
  const promote = settings.promoteFolder || (findFolder(app, /permanent|evergreen|^3\d\d\b/i, parent) || {}).path || parent;
  const archive = settings.archiveFolder || (findFolder(app, /archive/i, parent) || {}).path || (parent ? `${parent}/Archive` : "Archive");
  return { inbox, promote, archive };
}

class TriageModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.folders = triageFolders(this.app, plugin.settings);
    this.files = this.app.vault
      .getMarkdownFiles()
      .filter((f) => this.folders.inbox && (f.parent ? f.parent.path : "") === this.folders.inbox)
      .sort((a, b) => a.stat.ctime - b.stat.ctime);
    this.index = 0;
    this.done = 0;
    this.history = [];
    this.component = null;
  }

  onOpen() {
    this.modalEl.addClass("tahoe-triage");
    this.titleEl.setText("Inbox");
    this.bindKeys();
    this.render();
  }

  onClose() {
    if (this.component) this.component.unload();
    this.contentEl.empty();
  }

  get current() {
    return this.files[this.index] || null;
  }

  bindKeys() {
    const key = (k, fn) =>
      this.scope.register([], k, (e) => {
        if (document.activeElement && /input|textarea/i.test(document.activeElement.tagName)) return true;
        e.preventDefault();
        fn();
        return false;
      });
    key("a", () => this.archive());
    key("p", () => this.promote());
    key("m", () => this.move());
    key("l", () => this.link());
    key("Backspace", () => this.remove());
    key("Delete", () => this.remove());
    key("o", () => this.openNote());
    key("Enter", () => this.openNote());
    key("j", () => this.step(1));
    key("ArrowRight", () => this.step(1));
    key("ArrowDown", () => this.step(1));
    key("k", () => this.step(-1));
    key("ArrowLeft", () => this.step(-1));
    key("ArrowUp", () => this.step(-1));
    key("u", () => this.undo());
    key("Tab", () => this.acceptSuggestion());
  }

  async render() {
    const el = this.contentEl;
    el.empty();
    if (this.component) this.component.unload();
    this.component = new Component();
    this.component.load();

    if (!this.folders.inbox) {
      el.createDiv({ cls: "tahoe-triage-empty", text: "Choose your inbox folder in Settings → Tahoe Organize." });
      return;
    }
    const file = this.current;
    const remaining = this.files.length;
    this.titleEl.setText(remaining ? `Inbox · ${Math.min(this.index + 1, remaining)} of ${remaining}` : "Inbox");

    if (!file) {
      const empty = el.createDiv({ cls: "tahoe-triage-empty" });
      setIcon(empty.createDiv({ cls: "tahoe-triage-empty-icon" }), "inbox");
      empty.createDiv({ cls: "tahoe-triage-empty-title", text: this.done ? "Inbox zero" : "Your inbox is empty" });
      empty.createDiv({ cls: "tahoe-triage-empty-desc", text: this.done ? `You processed ${this.done} ${this.done === 1 ? "note" : "notes"}.` : `Nothing in ${this.folders.inbox}.` });
      if (this.history.length) this.footer(el, true);
      return;
    }

    const text = await this.app.vault.cachedRead(file);
    const card = el.createDiv({ cls: "tahoe-triage-card" });
    const head = card.createDiv({ cls: "tahoe-triage-head" });
    const info = head.createDiv({ cls: "tahoe-triage-info" });
    info.createDiv({ cls: "tahoe-triage-title", text: file.basename });
    const age = Math.max(0, Math.round((Date.now() - file.stat.ctime) / 86400000));
    const words = (text.replace(/^---\n[\s\S]*?\n---\n?/, "").match(/[\p{L}\p{N}]+/gu) || []).length;
    info.createDiv({ cls: "tahoe-triage-meta", text: `${age === 0 ? "Added today" : age === 1 ? "Added yesterday" : `Added ${age} days ago`} · ${words.toLocaleString()} ${words === 1 ? "word" : "words"}` });
    // Previous / next — the only way to skip a note on iPhone.
    const nav = head.createDiv({ cls: "tahoe-triage-step" });
    const stepBtn = (icon, label, dir) => {
      const b = nav.createDiv({ cls: "clickable-icon", attr: { "aria-label": label } });
      setIcon(b, icon);
      if ((dir < 0 && this.index === 0) || (dir > 0 && this.index >= this.files.length - 1)) b.addClass("is-disabled");
      b.addEventListener("click", () => this.step(dir));
    };
    stepBtn("chevron-left", "Previous (K)", -1);
    stepBtn("chevron-right", "Next (J)", 1);
    this.renderSuggestion(card.createDiv({ cls: "tahoe-triage-suggest" }), file);
    const body = card.createDiv({ cls: "tahoe-triage-body markdown-rendered" });
    if (text.trim()) await MarkdownRenderer.render(this.app, text, body, file.path, this.component);
    else body.createDiv({ cls: "tahoe-triage-blank", text: "This note is empty." });

    this.footer(el, false);
  }

  footer(el, onlyUndo) {
    const bar = el.createDiv({ cls: "tahoe-triage-actions" });
    const btn = (label, keyHint, icon, fn, cls = "") => {
      const b = bar.createEl("button", { cls: `tahoe-triage-action ${cls}` });
      setIcon(b.createSpan({ cls: "tahoe-triage-action-icon" }), icon);
      b.createSpan({ cls: "tahoe-triage-action-label", text: label });
      b.createEl("kbd", { text: keyHint });
      b.addEventListener("click", fn);
    };
    if (!onlyUndo) {
      btn("Archive", "A", "archive", () => this.archive());
      btn("Promote", "P", "arrow-up-circle", () => this.promote(), "mod-accent");
      btn("Move", "M", "folder-input", () => this.move());
      btn("Link", "L", "link", () => this.link());
      btn("Delete", "⌫", "trash-2", () => this.remove(), "mod-danger");
      btn("Open", "O", "external-link", () => this.openNote());
    }
    if (this.history.length) btn("Undo", "U", "undo-2", () => this.undo(), "mod-undo");
    if (!onlyUndo) {
      const nav = el.createDiv({ cls: "tahoe-triage-nav" });
      nav.createSpan({ text: `Archive → ${this.folders.archive}   ·   Promote → ${this.folders.promote}` });
    }
  }

  /* ---------- suggestions from Tahoe Intelligence ---------- */

  // On a Mac with Tahoe Intelligence, ask it; on iPhone, read what the Mac worked out.
  async suggestionFor(file) {
    const ai = this.app.plugins.getPlugin("tahoe-intelligence");
    if (ai && ai.api) return ai.api.cachedTriage(file) || ai.api.triageSuggestion(file);
    try {
      const raw = await this.app.vault.adapter.read(normalizePath(`${this.app.vault.configDir}/plugins/tahoe-intelligence/triage-suggestions.json`));
      const s = (JSON.parse(raw).suggestions || {})[file.path];
      return s && s.mtime === file.stat.mtime ? s : null;
    } catch {
      return null;
    }
  }

  async renderSuggestion(el, file) {
    this.suggestion = null;
    const ai = this.app.plugins.getPlugin("tahoe-intelligence");
    el.hide();
    const sparkle = (parent) => {
      const icon = parent.createSpan({ cls: "tahoe-triage-ai-icon" });
      setIcon(icon, "sparkles");
      const svg = icon.querySelector("svg");
      if (svg) icon.style.setProperty("--tahoe-ai-glyph", `url("data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(svg).replace(/currentColor/g, "black"))}")`);
    };
    let timer = 0;
    if (ai && ai.api && !ai.api.cachedTriage(file)) {
      // Only show "thinking" if it takes a moment.
      timer = window.setTimeout(() => {
        if (this.current !== file) return;
        el.empty();
        el.addClass("is-thinking");
        el.show();
        sparkle(el);
        el.createSpan({ cls: "tahoe-triage-suggest-label", text: "Thinking about where this goes…" });
      }, 250);
    }
    let s = null;
    try {
      s = await this.suggestionFor(file);
    } catch {
      // no suggestion: the note is shown without one
    }
    window.clearTimeout(timer);
    if (this.current !== file || !el.isConnected) return;
    el.removeClass("is-thinking");
    const parent = file.parent ? file.parent.path : "";
    const folderOk = s && s.folder && s.folder !== parent && this.app.vault.getAbstractFileByPath(s.folder) instanceof TFolder;
    const titleOk = s && s.title && s.title !== file.basename;
    const tags = (s && s.tags) || [];
    if (!s || (!folderOk && !titleOk && !tags.length)) return el.hide();

    this.suggestion = { file, folder: folderOk ? s.folder : null, title: titleOk ? s.title : null, tags: [...tags], off: new Set() };
    el.empty();
    el.show();
    sparkle(el);
    const chips = el.createDiv({ cls: "tahoe-triage-chips" });
    const chip = (key, icon, label) => {
      const c = chips.createEl("button", { cls: "tahoe-triage-chip is-on" });
      setIcon(c.createSpan({ cls: "tahoe-triage-chip-icon" }), icon);
      c.createSpan({ text: label });
      c.addEventListener("click", () => {
        const off = this.suggestion.off;
        if (off.has(key)) off.delete(key);
        else off.add(key);
        c.toggleClass("is-on", !off.has(key));
      });
    };
    if (folderOk) chip("folder", "folder", s.folder.split("/").pop());
    for (const t of tags) chip(`#${t}`, "tag", t);
    if (titleOk) chip("title", "pencil", `“${s.title}”`);
    const accept = el.createEl("button", { cls: "tahoe-triage-accept mod-cta" });
    accept.createSpan({ text: "Accept" });
    accept.createEl("kbd", { text: "⇥" });
    accept.addEventListener("click", () => this.acceptSuggestion());
  }

  async acceptSuggestion() {
    const s = this.suggestion;
    const file = this.current;
    if (!s || s.file !== file) return;
    const before = file.path;
    const tags = s.tags.filter((t) => !s.off.has(`#${t}`));
    if (tags.length) {
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const existing = fm.tags == null ? [] : Array.isArray(fm.tags) ? fm.tags : String(fm.tags).split(/[,\s]+/).filter(Boolean);
        fm.tags = [...new Set([...existing, ...tags])];
      });
    }
    const folder = s.folder && !s.off.has("folder") ? s.folder : file.parent ? file.parent.path : "";
    const name = s.title && !s.off.has("title") ? s.title : file.basename;
    if (folder !== (file.parent ? file.parent.path : "") || name !== file.basename) {
      const dir = folder ? `${folder}/` : "";
      let dest = normalizePath(`${dir}${name}.${file.extension}`);
      let k = 2;
      while (this.app.vault.getAbstractFileByPath(dest) && dest !== file.path) dest = normalizePath(`${dir}${name} ${k++}.${file.extension}`);
      await this.app.fileManager.renameFile(file, dest);
      notice(`Filed → ${dest.replace(/\.md$/, "")}`, 2000);
      this.consume({ type: "move", from: before, to: dest, index: this.index });
    } else {
      notice(`Tagged ${tags.map((t) => `#${t}`).join(" ")}`, 1600);
      this.consume(null);
    }
  }

  step(d) {
    if (!this.files.length) return;
    this.index = Math.max(0, Math.min(this.files.length - 1, this.index + d));
    this.render();
  }

  // Remove the current note from the queue after an action.
  consume(entry) {
    if (entry) this.history.push(entry);
    this.files.splice(this.index, 1);
    if (this.index >= this.files.length) this.index = Math.max(0, this.files.length - 1);
    this.done++;
    this.render();
  }

  async moveTo(folder, label, extra) {
    const file = this.current;
    if (!file) return;
    const before = file.path;
    if (extra) await extra(file);
    const r = await moveFile(this.app, file, folder);
    notice(`${label} → ${r.to.replace(/\.md$/, "")}`, 1800);
    this.consume({ type: "move", from: before, to: r.to, index: this.index });
  }

  archive() {
    return this.moveTo(this.folders.archive, "Archived");
  }

  promote() {
    return this.moveTo(this.folders.promote, "Promoted", (file) =>
      this.app.fileManager.processFrontMatter(file, (fm) => {
        fm.promoted = today();
      })
    );
  }

  move() {
    const file = this.current;
    if (!file) return;
    new FolderSuggestModal(this.app, (folder) => this.moveTo(folder.isRoot() ? "" : folder.path, "Moved")).open();
  }

  link() {
    const file = this.current;
    if (!file) return;
    new NoteSuggestModal(
      this.app,
      async (target) => {
        const link = this.app.fileManager.generateMarkdownLink(target, file.path);
        await this.app.vault.process(file, (data) => {
          const heading = /\n## Related\s*\n/.test(data) ? "" : `${data.endsWith("\n") ? "" : "\n"}\n## Related\n`;
          return `${data}${heading}- ${link}\n`;
        });
        notice(`Linked to ${target.basename}`, 1800);
        this.render();
      },
      "Link this note to…",
      file
    ).open();
  }

  async remove() {
    const file = this.current;
    if (!file) return;
    const before = file.path;
    // The vault's own .trash, so Undo can bring it straight back.
    await this.app.vault.trash(file, false);
    notice(`Moved ${file.basename} to the Trash · U to undo`, 2200);
    this.consume({ type: "trash", from: before, name: file.name, index: this.index });
  }

  openNote() {
    const file = this.current;
    if (!file) return;
    this.close();
    this.app.workspace.getLeaf(false).openFile(file);
  }

  async undo() {
    const last = this.history.pop();
    if (!last) return;
    try {
      if (last.type === "move") {
        const f = this.app.vault.getAbstractFileByPath(last.to);
        if (f instanceof TFile) {
          await this.app.fileManager.renameFile(f, last.from);
          if (f.path === last.from) this.files.splice(Math.min(last.index, this.files.length), 0, f);
        }
      } else if (last.type === "trash") {
        const trashed = `.trash/${last.name}`;
        if (await this.app.vault.adapter.exists(trashed)) {
          await this.app.vault.adapter.rename(trashed, last.from);
          await new Promise((r) => window.setTimeout(r, 150));
          const f = this.app.vault.getAbstractFileByPath(last.from);
          if (f instanceof TFile) this.files.splice(Math.min(last.index, this.files.length), 0, f);
        }
      }
      this.index = Math.min(last.index, Math.max(0, this.files.length - 1));
      this.done = Math.max(0, this.done - 1);
      notice("Undone", 1200);
    } catch (e) {
      notice(`Couldn’t undo: ${e.message}`);
    }
    this.render();
  }
}

export { TriageModal, triageFolders, findFolder };
