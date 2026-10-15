/* Shared helpers for Tahoe Organize. */

import { FuzzySuggestModal, Modal, Notice, TFile, TFolder, normalizePath, setIcon } from "obsidian";

/**
 * Moves a file or folder to the macOS Trash (recoverable), falling back to the
 * vault's .trash folder. Nothing in Tahoe Organize deletes permanently.
 */
async function moveToTrash(app, target) {
  const path = typeof target === "string" ? target : target.path;
  const adapter = app.vault.adapter;
  const file = typeof target === "string" ? app.vault.getAbstractFileByPath(path) : target;
  if (file) {
    await app.vault.trash(file, true);
    return true;
  }
  // Hidden folders such as ".obsidian 2" aren't in the vault index.
  if (typeof adapter.trashSystem === "function" && (await adapter.trashSystem(path))) return true;
  if (typeof adapter.trashLocal === "function") {
    await adapter.trashLocal(path);
    return true;
  }
  throw new Error(`Couldn't move ${path} to the Trash`);
}

function formatBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} bytes`;
}

function debounce(fn, ms) {
  let t = 0;
  const wrapped = (...args) => {
    window.clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => window.clearTimeout(t);
  return wrapped;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Line diff (LCS). Returns [{ type: "same" | "add" | "del", text }]. */
function diffLines(a, b) {
  const A = a.split("\n");
  const B = b.split("\n");
  if (A.length * B.length > 6e6) return null; // too large to diff interactively
  const n = A.length;
  const m = B.length;
  const dp = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: A[i++] });
    } else {
      out.push({ type: "add", text: B[j++] });
    }
  }
  while (i < n) out.push({ type: "del", text: A[i++] });
  while (j < m) out.push({ type: "add", text: B[j++] });
  return out;
}

// Keeps every line from both versions, in order — nothing is lost.
function mergeKeepingBoth(original, copy) {
  const diff = diffLines(original, copy);
  if (!diff) return `${original}\n\n${copy}`;
  return diff.map((d) => d.text).join("\n");
}

/* Similarity for "did you mean" suggestions (Dice coefficient on bigrams). */
function similarity(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) || 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const c = grams.get(g) || 0;
    if (c > 0) {
      grams.set(g, c - 1);
      hits++;
    }
  }
  return (2 * hits) / (a.length + b.length - 2);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

class FolderSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose, placeholder = "Move to folder…") {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder(placeholder);
  }

  getItems() {
    return this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder);
  }

  getItemText(folder) {
    return folder.isRoot() ? "/" : folder.path;
  }

  onChooseItem(folder) {
    this.onChoose(folder);
  }
}

class NoteSuggestModal extends FuzzySuggestModal {
  constructor(app, onChoose, placeholder = "Link to note…", exclude = null) {
    super(app);
    this.onChoose = onChoose;
    this.exclude = exclude;
    this.setPlaceholder(placeholder);
  }

  getItems() {
    return this.app.vault.getMarkdownFiles().filter((f) => f !== this.exclude);
  }

  getItemText(file) {
    return file.path.replace(/\.md$/, "");
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

// A macOS-style alert: icon, bold title, message, and equal-width buttons.
class ConfirmModal extends Modal {
  constructor(app, { title, message, confirm = "Move to Trash", warning = true, icon }) {
    super(app);
    this.options = { title, message, confirm, warning, icon: icon || (warning ? "trash-2" : "circle-help") };
    this.promise = new Promise((resolve) => (this.resolve = resolve));
  }

  onOpen() {
    const { modalEl, contentEl, options } = this;
    modalEl.addClass("tahoe-organize-alert");
    modalEl.toggleClass("is-warning", options.warning);
    const icon = contentEl.createDiv({ cls: "tahoe-organize-alert-icon" });
    setIcon(icon, options.icon);
    contentEl.createDiv({ cls: "tahoe-organize-alert-title", text: options.title });
    if (options.message) contentEl.createDiv({ cls: "tahoe-organize-alert-message", text: options.message });
    const row = contentEl.createDiv({ cls: "modal-button-container tahoe-organize-alert-buttons" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const ok = row.createEl("button", { cls: options.warning ? "mod-warning" : "mod-cta", text: options.confirm });
    ok.addEventListener("click", () => {
      this.confirmed = true;
      this.close();
    });
    // Return confirms a harmless action; a destructive one needs a click.
    if (!options.warning) window.setTimeout(() => ok.focus(), 0);
  }

  onClose() {
    this.resolve(!!this.confirmed);
  }
}

function confirm(app, options) {
  const modal = new ConfirmModal(app, options);
  modal.open();
  return modal.promise;
}

async function ensureFolder(app, path) {
  const p = normalizePath(path);
  if (!p || p === "/") return app.vault.getRoot();
  const existing = app.vault.getAbstractFileByPath(p);
  if (existing instanceof TFolder) return existing;
  await app.vault.createFolder(p);
  return app.vault.getAbstractFileByPath(p);
}

async function moveFile(app, file, folderPath) {
  const folder = await ensureFolder(app, folderPath);
  const base = folder.isRoot() ? "" : `${folder.path}/`;
  let dest = normalizePath(`${base}${file.name}`);
  let k = 2;
  while (app.vault.getAbstractFileByPath(dest)) dest = normalizePath(`${base}${file.basename} ${k++}.${file.extension}`);
  const from = file.path;
  await app.fileManager.renameFile(file, dest);
  return { from, to: dest };
}

function isImage(file) {
  return file instanceof TFile && /^(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i.test(file.extension);
}

function notice(text, ms = 3500) {
  return new Notice(text, ms);
}

// In Settings › Files and links › Excluded files. Those notes stay in the file
// list but are left out of search; the vault-wide features leave them out too.
function ignored(app, path) {
  return !!(app.metadataCache.isUserIgnored && app.metadataCache.isUserIgnored(path));
}

// A row with one button keeps it beside the text on narrow panes (styles.css).
function markSingle(row) {
  const one = row.actionsEl.childElementCount === 1;
  row.actionsEl.toggleClass("is-single", one);
  row.actionsEl.parentElement.toggleClass("has-single-action", one);
}

export {
  markSingle,
  ignored,
  moveToTrash,
  formatBytes,
  debounce,
  today,
  diffLines,
  mergeKeepingBoth,
  similarity,
  escapeRegExp,
  FolderSuggestModal,
  NoteSuggestModal,
  confirm,
  ensureFolder,
  moveFile,
  isImage,
  notice,
};
