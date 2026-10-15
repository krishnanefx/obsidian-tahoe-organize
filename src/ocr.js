/*
 * Text from images: reads the words in screenshots, photos of slides and
 * scanned pages with macOS Vision (the engine behind Live Text), so search
 * can find them.
 *
 *  • A small Swift helper reads images in one long-running process (~0.1 s
 *    each); AppleScript is the fallback on Macs without developer tools.
 *  • Results live in the plugin folder and sync with the vault, so the
 *    search panel works on iPhone too (reading new images needs the Mac).
 *  • An index note lets Obsidian's own search find the text as well.
 */

import { SuggestModal, Platform, TFile, normalizePath } from "obsidian";
import { isImage, debounce, ignored } from "./util";
import { childProcess, fs, os, path } from "./node";

import SWIFT_SOURCE from "./ocr.swift";
import APPLESCRIPT_SOURCE from "./ocr.applescript";

const INDEX_FILE = "image-text.json";
const MAX_IMAGE_BYTES = 40e6;

class OcrIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.entries = {}; // path → { mtime, size, text }
    this.queue = [];
    this.running = false;
    this.helper = null; // child process
    this.helperPath = null;
    this.pending = new Map(); // path → resolve
    this.statusEl = null;
    this.saveSoon = debounce(() => this.save(), 2000);
    this.writeNoteSoon = debounce(() => this.writeIndexNote(), 4000);
  }

  get canRead() {
    return Platform.isDesktopApp && Platform.isMacOS;
  }

  get indexPath() {
    return normalizePath(`${this.plugin.manifest.dir}/${INDEX_FILE}`);
  }

  async load() {
    try {
      const raw = await this.app.vault.adapter.read(this.indexPath);
      this.entries = JSON.parse(raw).entries || {};
    } catch {
      this.entries = {};
    }
  }

  async save() {
    await this.app.vault.adapter.write(this.indexPath, JSON.stringify({ version: 1, entries: this.entries }));
  }

  start() {
    if (!this.canRead) return;
    this.statusEl = this.plugin.addStatusBarItem();
    this.statusEl.addClass("tahoe-ocr-status");
    this.statusEl.hide();
    const queue = (file) => {
      if (isImage(file)) this.enqueue(file);
    };
    this.plugin.registerEvent(this.app.vault.on("create", queue));
    this.plugin.registerEvent(this.app.vault.on("modify", queue));
    this.plugin.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (this.entries[oldPath]) {
          this.entries[file.path] = this.entries[oldPath];
          delete this.entries[oldPath];
          this.saveSoon();
          this.writeNoteSoon();
        }
      })
    );
    this.plugin.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (this.entries[file.path]) {
          delete this.entries[file.path];
          this.saveSoon();
          this.writeNoteSoon();
        }
      })
    );
    // Give Obsidian a moment to settle before reading the backlog.
    window.setTimeout(() => this.scanAll(), 8000);
  }

  stop() {
    this.queue = [];
    if (this.helper) {
      try {
        this.helper.stdin.end();
        this.helper.kill();
      } catch {
        // already gone
      }
    }
    this.helper = null;
  }

  scanAll(force = false) {
    if (!this.canRead) return 0;
    let n = 0;
    for (const file of this.app.vault.getFiles()) {
      if (!isImage(file) || file.stat.size > MAX_IMAGE_BYTES || ignored(this.app, file.path)) continue;
      const e = this.entries[file.path];
      if (force || !e || e.mtime !== file.stat.mtime || e.size !== file.stat.size) {
        this.enqueue(file);
        n++;
      }
    }
    return n;
  }

  enqueue(file) {
    if (!this.queue.includes(file.path)) this.queue.push(file.path);
    this.total = Math.max(this.total || 0, this.queue.length);
    this.pump();
  }

  updateStatus() {
    if (!this.statusEl) return;
    if (!this.running) {
      this.statusEl.hide();
      this.total = 0;
      return;
    }
    this.statusEl.show();
    const done = (this.total || 0) - this.queue.length;
    this.statusEl.setText(`Reading text in images · ${done}/${this.total}`);
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    this.running = true;
    this.updateStatus();
    try {
      while (this.queue.length) {
        const path = this.queue.shift();
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) continue;
        const text = await this.read(file);
        if (text != null) {
          this.entries[path] = { mtime: file.stat.mtime, size: file.stat.size, text };
          this.saveSoon();
          this.writeNoteSoon();
        }
        this.updateStatus();
        await new Promise((r) => window.setTimeout(r, 15)); // stay out of the way while typing
      }
    } finally {
      this.running = false;
      this.updateStatus();
    }
  }

  absolute(file) {
    const adapter = this.app.vault.adapter;
    return adapter.getFullPath ? adapter.getFullPath(file.path) : path.join(adapter.getBasePath(), file.path);
  }

  async read(file) {
    const full = this.absolute(file);
    const helper = await this.ensureHelper();
    if (helper) return this.readWithHelper(full);
    return this.readWithAppleScript(full);
  }

  async ensureHelper() {
    if (this.helper && this.helper.exitCode === null) return this.helper;
    if (this.helperFailed) return null;
    const dir = path.join(os.homedir(), "Library", "Caches", "tahoe-organize");
    const bin = path.join(dir, "tahoe-ocr-v1");
    if (!fs.existsSync(bin)) {
      // Without Xcode's command line tools, xcrun would ask to install them;
      // xcode-select -p asks nothing. AppleScript reads the images then.
      const tools = await new Promise((resolve) => childProcess.execFile("/usr/bin/xcode-select", ["-p"], (err, out) => resolve(!err && fs.existsSync(String(out).trim()))));
      if (!tools) {
        this.helperFailed = true;
        return null;
      }
      fs.mkdirSync(dir, { recursive: true });
      const src = path.join(dir, "tahoe-ocr.swift");
      fs.writeFileSync(src, SWIFT_SOURCE);
      const ok = await new Promise((resolve) => childProcess.execFile("/usr/bin/xcrun", ["--sdk", "macosx", "swiftc", "-O", src, "-o", bin], { timeout: 180000 }, (err) => resolve(!err)));
      if (!ok) {
        this.helperFailed = true;
        return null;
      }
    }
    const child = childProcess.spawn(bin, [], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    child.stdout.on("data", (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          const resolve = this.pending.get(msg.path);
          if (resolve) {
            this.pending.delete(msg.path);
            resolve(msg.error ? "" : msg.text || "");
          }
        } catch {
          // not a line of ours
        }
      }
    });
    child.on("exit", () => {
      for (const resolve of this.pending.values()) resolve(null);
      this.pending.clear();
      this.helper = null;
    });
    this.helper = child;
    return child;
  }

  readWithHelper(full) {
    return new Promise((resolve) => {
      this.pending.set(full, resolve);
      this.helper.stdin.write(`${full}\n`);
      // The first image after start-up can take a while as macOS loads its models.
      window.setTimeout(() => {
        if (this.pending.delete(full)) resolve(null);
      }, 120000);
    });
  }

  readWithAppleScript(full) {
    const script = path.join(os.tmpdir(), "tahoe-ocr.applescript");
    if (!fs.existsSync(script)) fs.writeFileSync(script, APPLESCRIPT_SOURCE);
    return new Promise((resolve) => {
      childProcess.execFile("/usr/bin/osascript", [script, full], { timeout: 120000, maxBuffer: 8e6 }, (err, stdout) => resolve(err ? null : stdout.trim()));
    });
  }

  // A plain note that Obsidian's search indexes: one heading per image.
  async writeIndexNote() {
    const s = this.plugin.settings;
    if (!s.ocrWriteNote || !s.ocrIndexNote) return;
    const paths = Object.keys(this.entries)
      .filter((p) => (this.entries[p].text || "").trim())
      .sort();
    const parts = [
      "---",
      "tahoe-generated: image-text",
      "---",
      "# Text in images",
      "",
      "_Written by Tahoe Organize so search can find words inside your screenshots and slides. It's rewritten automatically — edit the images' notes instead._",
      "",
    ];
    for (const p of paths) {
      const f = this.app.vault.getAbstractFileByPath(p);
      if (!(f instanceof TFile)) continue;
      parts.push(`## ${this.app.fileManager.generateMarkdownLink(f, s.ocrIndexNote)}`, "", this.entries[p].text.replace(/^#/gm, "\\#").replace(/\n/g, "  \n"), "");
    }
    const content = parts.join("\n");
    const existing = this.app.vault.getAbstractFileByPath(s.ocrIndexNote);
    if (existing instanceof TFile) {
      if ((await this.app.vault.read(existing)) !== content) await this.app.vault.modify(existing, content);
    } else if (paths.length) {
      const dir = s.ocrIndexNote.includes("/") ? s.ocrIndexNote.slice(0, s.ocrIndexNote.lastIndexOf("/")) : "";
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      await this.app.vault.create(s.ocrIndexNote, content);
    }
  }

  search(query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const results = [];
    for (const [path, e] of Object.entries(this.entries)) {
      const text = e.text || "";
      if (!text) continue;
      const lower = text.toLowerCase();
      const name = path.toLowerCase();
      if (words.length && !words.every((w) => lower.includes(w) || name.includes(w))) continue;
      const at = words.length ? lower.indexOf(words[0]) : 0;
      const start = Math.max(0, at - 40);
      results.push({ path, words, snippet: (start ? "…" : "") + text.slice(start, start + 160).replace(/\s+/g, " "), score: words.reduce((s, w) => s + (lower.split(w).length - 1), 0) });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, 50);
  }

  // Note that embeds an image, if any.
  embeddingNote(path) {
    for (const [src, dests] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (src !== this.plugin.settings.ocrIndexNote && dests[path]) return src;
    }
    return null;
  }

  async textFor(file) {
    const e = this.entries[file.path];
    if (e && e.mtime === file.stat.mtime) return e.text;
    if (!this.canRead) return null;
    const text = await this.read(file);
    if (text != null) {
      this.entries[file.path] = { mtime: file.stat.mtime, size: file.stat.size, text };
      this.saveSoon();
    }
    return text;
  }
}

class ImageTextSearchModal extends SuggestModal {
  constructor(app, index) {
    super(app);
    this.index = index;
    this.modalEl.addClass("tahoe-ocr-search");
    this.setPlaceholder("Search text in images…");
    this.emptyStateText = Object.keys(index.entries).length ? "No images contain that text." : "No images have been read yet.";
    this.setInstructions([
      { command: "↵", purpose: "open the note with the image" },
      { command: "⌘ ↵", purpose: "open the image" },
      { command: "esc", purpose: "close" },
    ]);
    this.scope.register(["Mod"], "Enter", () => {
      const chosen = this.chooser && this.chooser.values && this.chooser.values[this.chooser.selectedItem];
      if (chosen) {
        this.close();
        this.openImage(chosen.path);
      }
      return false;
    });
  }

  getSuggestions(query) {
    return this.index.search(query);
  }

  renderSuggestion(r, el) {
    el.addClass("tahoe-ocr-result");
    const file = this.app.vault.getAbstractFileByPath(r.path);
    const thumb = el.createDiv({ cls: "tahoe-ocr-thumb" });
    if (file instanceof TFile) thumb.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), loading: "lazy" } });
    const text = el.createDiv({ cls: "tahoe-ocr-text" });
    text.createDiv({ cls: "tahoe-ocr-name", text: r.path.split("/").pop() });
    const snippet = text.createDiv({ cls: "tahoe-ocr-snippet" });
    // Highlight the words that matched, like Spotlight.
    const escaped = (r.words || []).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const parts = escaped.length ? r.snippet.split(new RegExp(`(${escaped.join("|")})`, "gi")) : [r.snippet];
    parts.forEach((part, i) => (i % 2 ? snippet.createEl("mark", { text: part }) : snippet.appendText(part)));
  }

  onChooseSuggestion(r) {
    const note = this.index.embeddingNote(r.path);
    if (note) this.app.workspace.openLinkText(note, "", false);
    else this.openImage(r.path);
  }

  openImage(path) {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) this.app.workspace.getLeaf(false).openFile(f);
  }
}

export { OcrIndex, ImageTextSearchModal };
