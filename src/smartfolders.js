/*
 * Smart folders: saved searches in the sidebar, like Finder's and Notes'.
 * Each folder matches all (or any) of its rules — tag, folder, property,
 * dates, title, open tasks, or (with Tahoe Intelligence) what a note is about
 * — and updates live as notes change.
 */

import { ItemView, Modal, Setting, Menu, Keymap, getAllTags, setIcon } from "obsidian";
import { debounce, ignored } from "./util";

const VIEW_SMART = "tahoe-smart-folders";

const FIELDS = [
  ["tag", "Tag"],
  ["folder", "Folder"],
  ["property", "Property"],
  ["modified", "Modified"],
  ["created", "Created"],
  ["title", "Title"],
  ["tasks", "Tasks"],
  ["about", "About"],
];

/*
 * "About" rules: Tahoe Intelligence finds the notes on a topic by meaning.
 * Results are saved with Organize's settings, so they sync to iPhone, and
 * refresh quietly in the background on the Mac.
 */
const topicStore = {
  plugin: null,
  pending: new Set(),
  lastRun: new Map(),
  key: (t) => String(t || "").trim().toLowerCase(),
  get(topic) {
    const c = this.plugin && this.plugin.settings.topicCache && this.plugin.settings.topicCache[this.key(topic)];
    return c ? new Set(c.paths) : null;
  },
  isPending(topic) {
    return this.pending.has(this.key(topic));
  },
  async refresh(topic, onChange) {
    const k = this.key(topic);
    if (!k || !this.plugin) return;
    const ai = this.plugin.app.plugins.getPlugin("tahoe-intelligence");
    if (!ai || !ai.api || !ai.api.indexReady) return;
    if (this.pending.has(k) || Date.now() - (this.lastRun.get(k) || 0) < 60000) return;
    this.pending.add(k);
    this.lastRun.set(k, Date.now());
    if (!this.get(topic)) onChange();
    try {
      const res = await ai.api.notesAbout(topic);
      if (!res) {
        this.lastRun.delete(k); // index not ready yet — try again later
        return;
      }
      const paths = res.map((r) => r.path).sort();
      const cache = (this.plugin.settings.topicCache = this.plugin.settings.topicCache || {});
      const before = cache[k] ? cache[k].paths.join("|") : null;
      cache[k] = { paths, at: Date.now() };
      if (before !== paths.join("|")) await this.plugin.saveData(this.plugin.settings);
    } catch {
      this.lastRun.delete(k);
    } finally {
      this.pending.delete(k);
      onChange();
    }
  },
};

const DEFAULT_SMART_FOLDERS = [
  { id: "today", name: "Today", icon: "sun", match: "all", rules: [{ field: "modified", op: "within", value: "1" }] },
  { id: "week", name: "This week", icon: "calendar-days", match: "all", rules: [{ field: "modified", op: "within", value: "7" }] },
  { id: "tasks", name: "Open tasks", icon: "list-todo", match: "all", rules: [{ field: "tasks", op: "open", value: "" }] },
];

function opsFor(field) {
  switch (field) {
    case "tag":
      return [["has", "has"], ["not", "doesn’t have"]];
    case "folder":
      return [["in", "is inside"], ["not", "isn’t inside"]];
    case "property":
      return [["is", "is"], ["contains", "contains"], ["exists", "exists"], ["missing", "is missing"]];
    case "modified":
    case "created":
      return [["within", "in the last (days)"], ["before", "more than (days) ago"]];
    case "title":
      return [["contains", "contains"], ["starts", "starts with"]];
    case "tasks":
      return [["open", "has open tasks"], ["done", "has only finished tasks"]];
    case "about":
      return [["is", "is about"]];
    default:
      return [["is", "is"]];
  }
}

function matchesRule(app, file, cache, rule) {
  const v = String(rule.value || "").trim();
  const day = 86400000;
  switch (rule.field) {
    case "tag": {
      const want = v.replace(/^#/, "").toLowerCase();
      const tags = (cache ? getAllTags(cache) || [] : []).map((t) => t.replace(/^#/, "").toLowerCase());
      const has = tags.some((t) => t === want || t.startsWith(`${want}/`));
      return rule.op === "not" ? !has : has;
    }
    case "folder": {
      const folder = v.replace(/^\/|\/$/g, "");
      const inside = !folder || file.path.startsWith(`${folder}/`);
      return rule.op === "not" ? !inside : inside;
    }
    case "property": {
      const [key, ...rest] = v.split("=");
      const want = rest.join("=").trim().toLowerCase();
      const fm = (cache && cache.frontmatter) || {};
      const k = Object.keys(fm).find((x) => x.toLowerCase() === key.trim().toLowerCase());
      const value = k ? fm[k] : undefined;
      const text = Array.isArray(value) ? value.map(String).join(", ").toLowerCase() : value == null ? "" : String(value).toLowerCase();
      if (rule.op === "exists") return value !== undefined;
      if (rule.op === "missing") return value === undefined;
      if (rule.op === "contains") return text.includes(want);
      return Array.isArray(value) ? value.map((x) => String(x).toLowerCase()).includes(want) : text === want;
    }
    case "modified":
    case "created": {
      const t = rule.field === "modified" ? file.stat.mtime : file.stat.ctime;
      const days = Number(v) || 1;
      const age = (Date.now() - t) / day;
      return rule.op === "before" ? age > days : age <= days;
    }
    case "title": {
      const name = file.basename.toLowerCase();
      return rule.op === "starts" ? name.startsWith(v.toLowerCase()) : name.includes(v.toLowerCase());
    }
    case "about": {
      const set = topicStore.get(v);
      return set ? set.has(file.path) : false;
    }
    case "tasks": {
      const items = (cache && cache.listItems) || [];
      const tasks = items.filter((i) => i.task !== undefined);
      if (rule.op === "open") return tasks.some((i) => i.task === " ");
      return tasks.length > 0 && tasks.every((i) => i.task !== " ");
    }
    default:
      return false;
  }
}

function evaluateFolder(app, folder, exclude) {
  const out = [];
  for (const file of app.vault.getMarkdownFiles()) {
    if ((exclude && exclude(file)) || ignored(app, file.path)) continue;
    const cache = app.metadataCache.getFileCache(file);
    const results = folder.rules.map((r) => matchesRule(app, file, cache, r));
    const ok = folder.rules.length === 0 ? false : folder.match === "any" ? results.some(Boolean) : results.every(Boolean);
    if (ok) out.push(file);
  }
  return out.sort((a, b) => b.stat.mtime - a.stat.mtime);
}

function relativeDate(t) {
  const d = new Date(t);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diff === 0) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString();
}

class SmartFoldersView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.expanded = new Set(["today"]);
    this.refresh = debounce(() => this.render(), 400);
  }

  getViewType() {
    return VIEW_SMART;
  }

  getDisplayText() {
    return "Smart folders";
  }

  getIcon() {
    return "folder-search";
  }

  async onOpen() {
    this.contentEl.addClass("tahoe-smart-folders");
    this.registerEvent(this.app.metadataCache.on("changed", () => this.refresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.refresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.refresh()));
    this.registerEvent(this.app.vault.on("create", () => this.refresh()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.markActive()));
    this.registerInterval(window.setInterval(() => this.render(), 5 * 60000)); // "Today" rolls over
    this.render();
  }

  onClose() {
    this.refresh.cancel();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const header = el.createDiv({ cls: "tahoe-smart-header" });
    header.createDiv({ cls: "tahoe-smart-header-title", text: "Smart folders" });
    const add = header.createDiv({ cls: "clickable-icon", attr: { "aria-label": "New smart folder" } });
    setIcon(add, "plus");
    add.addEventListener("click", () => this.edit(null));

    // Built from the file explorer's own tree markup, so themes style it the
    // same way: file icons, selection, tag colors and the inactive-window look.
    const tree = el.createDiv({ cls: "nav-files-container tahoe-smart-tree" });
    const exclude = (f) => f.path === this.plugin.settings.ocrIndexNote;
    const active = this.app.workspace.getActiveFile();
    topicStore.plugin = this.plugin;
    for (const folder of this.plugin.settings.smartFolders) {
      const topics = folder.rules.filter((r) => r.field === "about" && String(r.value || "").trim()).map((r) => r.value);
      for (const t of topics) topicStore.refresh(t, () => this.refresh());
      const finding = topics.find((t) => topicStore.isPending(t) && !topicStore.get(t));
      const files = evaluateFolder(this.app, folder, exclude);
      const open = this.expanded.has(folder.id);
      const item = tree.createDiv({ cls: `tree-item nav-folder tahoe-smart-folder${open ? "" : " is-collapsed"}` });
      const row = item.createDiv({ cls: "tree-item-self nav-folder-title is-clickable mod-collapsible tahoe-smart-row" });
      const chevron = row.createDiv({ cls: `tree-item-icon collapse-icon${open ? "" : " is-collapsed"}` });
      setIcon(chevron, "right-triangle");
      const inner = row.createDiv({ cls: "tree-item-inner tahoe-smart-title" });
      setIcon(inner.createSpan({ cls: "tahoe-smart-icon" }), folder.icon || "folder-cog");
      inner.createSpan({ cls: "tahoe-smart-name", text: folder.name });
      row.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: String(files.length) });
      row.addEventListener("click", () => {
        if (open) this.expanded.delete(folder.id);
        else this.expanded.add(folder.id);
        this.render();
      });
      row.addEventListener("contextmenu", (e) => {
        const menu = new Menu();
        menu.addItem((i) => i.setTitle("Edit smart folder…").setIcon("pencil").onClick(() => this.edit(folder)));
        menu.addItem((i) => i.setTitle("Delete smart folder").setIcon("trash-2").setWarning(true).onClick(() => this.remove(folder)));
        menu.showAtMouseEvent(e);
      });
      if (!open) continue;

      const children = item.createDiv({ cls: "tree-item-children nav-folder-children" });
      const shown = files.slice(0, 60);
      for (const f of shown) {
        const fileItem = children.createDiv({ cls: "tree-item nav-file" });
        const self = fileItem.createDiv({
          cls: `tree-item-self nav-file-title is-clickable tappable${active && active.path === f.path ? " is-active" : ""}`,
          attr: { "data-path": f.path, draggable: "true" },
        });
        self.createDiv({ cls: "tree-item-inner nav-file-title-content", text: f.basename });
        self.createDiv({ cls: "tree-item-flair-outer" }).createSpan({ cls: "tree-item-flair", text: relativeDate(f.stat.mtime) });
        self.addEventListener("click", (e) => this.app.workspace.getLeaf(Keymap.isModEvent(e)).openFile(f));
        self.addEventListener("contextmenu", (e) => {
          const menu = new Menu();
          this.app.workspace.trigger("file-menu", menu, f, "file-explorer-context-menu", null);
          menu.showAtMouseEvent(e);
        });
        self.addEventListener("dragstart", (e) => {
          const dm = this.app.dragManager;
          if (dm && dm.dragFile) dm.onDragStart(e, dm.dragFile(e, f));
        });
      }
      if (finding) children.createDiv({ cls: "tahoe-smart-none is-finding", text: `Finding notes about “${finding}”…` });
      else if (!files.length && topics.length && !topics.some((t) => topicStore.get(t)))
        children.createDiv({ cls: "tahoe-smart-none", text: this.app.plugins.getPlugin("tahoe-intelligence") ? "Reading your notes — this fills in shortly" : "“About” needs Tahoe Intelligence on your Mac" });
      else if (!files.length) children.createDiv({ cls: "tahoe-smart-none", text: "No matching notes" });
      if (files.length > shown.length) children.createDiv({ cls: "tahoe-smart-none", text: `and ${files.length - shown.length} more` });
    }
  }

  // Follow the open note, like the file explorer does.
  markActive() {
    const active = this.app.workspace.getActiveFile();
    this.contentEl.querySelectorAll(".nav-file-title").forEach((el) => el.toggleClass("is-active", !!active && el.getAttribute("data-path") === active.path));
  }

  edit(folder) {
    new SmartFolderModal(this.app, folder, async (result) => {
      const list = this.plugin.settings.smartFolders;
      const i = folder ? list.findIndex((x) => x.id === folder.id) : -1;
      if (i >= 0) list[i] = result;
      else list.push(result);
      this.expanded.add(result.id);
      await this.plugin.saveSettings();
      this.render();
    }).open();
  }

  async remove(folder) {
    this.plugin.settings.smartFolders = this.plugin.settings.smartFolders.filter((x) => x.id !== folder.id);
    await this.plugin.saveSettings();
    this.render();
  }
}

class SmartFolderModal extends Modal {
  constructor(app, folder, onSave) {
    super(app);
    this.onSave = onSave;
    this.draft = folder ? JSON.parse(JSON.stringify(folder)) : { id: `sf-${Date.now().toString(36)}`, name: "", icon: "folder-cog", match: "all", rules: [{ field: "tag", op: "has", value: "" }] };
  }

  onOpen() {
    this.modalEl.addClass("tahoe-smart-modal");
    this.titleEl.setText(this.draft.name ? "Edit smart folder" : "New smart folder");
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const d = this.draft;
    const form = el.createDiv({ cls: "tahoe-organize-form" });
    new Setting(form).setName("Name").addText((t) => {
      t.setPlaceholder("Smart folder").setValue(d.name).onChange((v) => (d.name = v));
      window.setTimeout(() => t.inputEl.focus(), 30);
    });

    const matchRow = el.createDiv({ cls: "tahoe-smart-match" });
    matchRow.createSpan({ text: "Include notes that match " });
    const sel = matchRow.createEl("select", { cls: "dropdown" });
    for (const [v, label] of [["all", "all"], ["any", "any"]]) sel.createEl("option", { value: v, text: label });
    sel.value = d.match;
    sel.addEventListener("change", () => (d.match = sel.value));
    matchRow.createSpan({ text: " of the following:" });

    const rules = el.createDiv({ cls: "tahoe-smart-rules" });
    d.rules.forEach((rule, i) => {
      const row = rules.createDiv({ cls: "tahoe-smart-rule" });
      const field = row.createEl("select", { cls: "dropdown" });
      for (const [v, label] of FIELDS) field.createEl("option", { value: v, text: label });
      field.value = rule.field;
      field.addEventListener("change", () => {
        rule.field = field.value;
        rule.op = opsFor(rule.field)[0][0];
        rule.value = "";
        this.render();
      });
      const op = row.createEl("select", { cls: "dropdown" });
      for (const [v, label] of opsFor(rule.field)) op.createEl("option", { value: v, text: label });
      op.value = rule.op;
      op.addEventListener("change", () => {
        rule.op = op.value;
        this.render();
      });
      const needsValue = rule.field !== "tasks";
      if (needsValue) {
        const placeholder = { tag: "#school", folder: "SecondBrain/400 Projects", property: rule.op === "exists" || rule.op === "missing" ? "status" : "status = done", modified: "7", created: "30", title: "lecture", about: "dynamic programming" }[rule.field] || "";
        const input = row.createEl("input", { type: "text", cls: "tahoe-smart-value", attr: { placeholder } });
        input.value = rule.value || "";
        input.addEventListener("input", () => (rule.value = input.value));
      }
      const minus = row.createDiv({ cls: "clickable-icon", attr: { "aria-label": "Remove rule" } });
      setIcon(minus, "minus-circle");
      minus.addEventListener("click", () => {
        d.rules.splice(i, 1);
        this.render();
      });
    });
    const addRule = rules.createDiv({ cls: "tahoe-smart-add-rule" });
    setIcon(addRule.createSpan(), "plus-circle");
    addRule.createSpan({ text: "Add a rule" });
    addRule.addEventListener("click", () => {
      d.rules.push({ field: "tag", op: "has", value: "" });
      this.render();
    });

    // Footer: live match count on the left, buttons on the right
    const footer = el.createDiv({ cls: "tahoe-smart-footer" });
    const n = evaluateFolder(this.app, d).length;
    const about = d.rules.some((r) => r.field === "about");
    footer.createDiv({ cls: "tahoe-smart-preview", text: about ? "Notes on the topic are found by meaning after you save" : `${n.toLocaleString()} matching ${n === 1 ? "note" : "notes"} right now` });
    const buttons = footer.createDiv({ cls: "modal-button-container" });
    buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const save = buttons.createEl("button", { cls: "mod-cta", text: "Save" });
    save.addEventListener("click", () => {
      if (!d.name.trim()) d.name = "Smart folder";
      d.rules = d.rules.filter((r) => r.field === "tasks" || String(r.value || "").trim());
      this.close();
      this.onSave(d);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { SmartFoldersView, VIEW_SMART, DEFAULT_SMART_FOLDERS, evaluateFolder };
