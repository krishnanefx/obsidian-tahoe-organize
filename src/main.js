/*
 * Tahoe Organize — keep a growing vault tidy.
 *
 *   iCloud conflict fixer · Inbox triage · Smart folders · Finder-style colored
 *   tags · Live link suggestions · Vault health check · Text from images
 *
 * Everything that removes something moves it to the Trash.
 */

import { Plugin, PluginSettingTab, Setting, Notice, Platform } from "obsidian";
import { ConflictsView, VIEW_CONFLICTS } from "./conflicts";
import { HealthView, VIEW_HEALTH } from "./health";
import { TriageModal, triageFolders } from "./triage";
import { SmartFoldersView, VIEW_SMART, DEFAULT_SMART_FOLDERS } from "./smartfolders";
import { TagColors, DEFAULT_TAG_COLORS } from "./tagcolors";
import { TitleIndex, suggestionsPlugin, linkAll } from "./linksuggest";
import { OcrIndex, ImageTextSearchModal } from "./ocr";
import { isImage } from "./util";
import { LiteratureModal, isBareRef } from "./literature";
import { findFolder } from "./triage";
import { loadNode } from "./node";

const DEFAULT_SETTINGS = {
  features: { conflicts: true, triage: true, smartFolders: true, tagColors: true, linkSuggestions: true, health: true, ocr: true, literature: true },
  inboxFolder: "",
  archiveFolder: "",
  promoteFolder: "",
  smartFolders: DEFAULT_SMART_FOLDERS,
  tagColors: DEFAULT_TAG_COLORS,
  colorProperty: "color",
  linkMinLength: 4,
  linkIgnore: [],
  hugeAttachmentMB: 10,
  healthExclude: [],
  ocrWriteNote: false,
  ocrIndexNote: "Image Text Index.md",
  topicCache: {},
  literatureFolder: "",
  literaturePdf: true,
  literatureTags: "literature",
};

export default class TahoeOrganizePlugin extends Plugin {
  async onload() {
    await loadNode();
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), saved);
    this.settings.features = Object.assign({}, DEFAULT_SETTINGS.features, saved.features);
    const f = this.settings.features;

    this.registerView(VIEW_CONFLICTS, (leaf) => new ConflictsView(leaf, this));
    this.registerView(VIEW_HEALTH, (leaf) => new HealthView(leaf, this));
    this.registerView(VIEW_SMART, (leaf) => new SmartFoldersView(leaf, this));
    this.addSettingTab(new TahoeOrganizeSettingTab(this.app, this));

    // Inbox triage
    if (f.triage) {
      this.addRibbonIcon("inbox", "Triage inbox", () => new TriageModal(this).open());
      this.addCommand({ id: "triage-inbox", name: "Triage inbox", callback: () => new TriageModal(this).open() });
    }

    // Smart folders
    if (f.smartFolders) {
      this.addCommand({ id: "show-smart-folders", name: "Show smart folders", callback: () => this.activate(VIEW_SMART, "left") });
      this.app.workspace.onLayoutReady(() => {
        // Wait a tick: when the plugin is re-enabled, Obsidian restores the
        // existing sidebar tab after onload, and we mustn't add a second one.
        window.setTimeout(() => {
          const leaves = this.app.workspace.getLeavesOfType(VIEW_SMART);
          leaves.slice(1).forEach((l) => l.detach());
          if (!leaves.length) {
            const leaf = this.app.workspace.getLeftLeaf(false);
            if (leaf) leaf.setViewState({ type: VIEW_SMART, active: false });
          }
        }, 300);
      });
    }

    // Literature notes from arXiv / DOI links
    if (f.literature) {
      this.addCommand({ id: "new-literature-note", name: "New literature note from link…", callback: () => new LiteratureModal(this).open() });
      // Pasting just a paper link: offer a note for it (the paste goes in as usual).
      this.registerEvent(
        this.app.workspace.on("editor-paste", (evt) => {
          if (evt.defaultPrevented) return;
          const text = evt.clipboardData && evt.clipboardData.getData("text/plain");
          if (!text || !isBareRef(text)) return;
          const frag = document.createDocumentFragment();
          frag.createSpan({ text: "A paper link. " });
          const a = frag.createEl("a", { text: "Make a literature note", href: "#" });
          const n = new Notice(frag, 8000);
          a.addEventListener("click", (e) => {
            e.preventDefault();
            n.hide();
            new LiteratureModal(this, text.trim()).open();
          });
        })
      );
    }

    // Vault health & iCloud conflicts
    if (f.health) this.addCommand({ id: "vault-health", name: "Check vault health", callback: () => this.activate(VIEW_HEALTH, "tab") });
    if (f.conflicts) this.addCommand({ id: "icloud-conflicts", name: "Find iCloud conflicts", callback: () => this.openConflicts() });

    // Colored tags
    this.tagColors = new TagColors(this);
    if (f.tagColors) this.app.workspace.onLayoutReady(() => this.tagColors.enable());

    // Live link suggestions
    this.titles = new TitleIndex(this);
    if (f.linkSuggestions) {
      this.registerEditorExtension(suggestionsPlugin(this, this.titles));
      this.app.workspace.onLayoutReady(() => this.titles.build());
      for (const evt of ["create", "delete", "rename"]) this.registerEvent(this.app.vault.on(evt, () => this.titles.rebuild()));
      this.addCommand({
        id: "link-all-suggestions",
        name: "Link all suggestions in this note",
        editorCallback: (editor, view) => view.file && linkAll(this, this.titles, editor, view.file),
      });
    }

    // Text from images
    this.ocr = new OcrIndex(this);
    if (f.ocr) {
      this.app.workspace.onLayoutReady(async () => {
        await this.ocr.load();
        this.ocr.start();
      });
      this.addCommand({ id: "search-image-text", name: "Search text in images", callback: () => new ImageTextSearchModal(this.app, this.ocr).open() });
      if (Platform.isMacOS && Platform.isDesktopApp) {
        this.addCommand({
          id: "reread-images",
          name: "Read text in all images again",
          callback: () => {
            const n = this.ocr.scanAll(true);
            new Notice(n ? `Reading text in ${n} images…` : "No images to read");
          },
        });
      }
      this.registerEvent(
        this.app.workspace.on("file-menu", (menu, file) => {
          if (!isImage(file)) return;
          menu.addItem((i) =>
            i
              .setTitle("Copy text from image")
              .setIcon("scan-text")
              .onClick(async () => {
                const text = await this.ocr.textFor(file);
                if (!text) return new Notice(this.ocr.canRead ? "No text found in this image" : "Open this vault on your Mac to read new images");
                await navigator.clipboard.writeText(text);
                new Notice("Text copied");
              })
          );
        })
      );
    }
  }

  onunload() {
    if (this.tagColors) this.tagColors.disable();
    if (this.ocr) this.ocr.stop();
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.tagColors && this.settings.features.tagColors) this.tagColors.render();
    if (this.titles && this.settings.features.linkSuggestions) this.titles.rebuild();
  }

  async activate(type, where) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      leaf = where === "left" ? this.app.workspace.getLeftLeaf(false) : this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  openConflicts() {
    return this.activate(VIEW_CONFLICTS, "tab");
  }
};

class TahoeOrganizeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.icon = "folder-check";
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const f = s.features;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();

    const restartNote = "Turning a tool on or off takes effect after Obsidian restarts.";
    new Setting(containerEl).setName("Tools").setHeading();
    const toggle = (key, name, desc) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(f[key]).onChange(async (v) => ((f[key] = v), await save(), new Notice(restartNote))));
    toggle("triage", "Inbox triage", "Go through your inbox one note at a time with single-key actions.");
    toggle("smartFolders", "Smart folders", "Saved searches in the sidebar that update as you write.");
    toggle("tagColors", "Colored tags", "Color dots in the file list for notes tagged #red, #blue … or with a color property.");
    toggle("linkSuggestions", "Link suggestions", "Underline note titles you mention so you can link them with a click.");
    toggle("health", "Vault health", "Find broken links, empty notes, unused attachments and large files.");
    toggle("conflicts", "iCloud conflicts", "Find and resolve the “… 2” copies iCloud makes.");
    toggle("ocr", "Text from images", "Read the words in images so search can find them (reading needs a Mac).");
    toggle("literature", "Literature notes", "Paste an arXiv or DOI link to get a note with the title, authors, abstract, BibTeX and the PDF.");

    new Setting(containerEl).setName("Inbox").setHeading();
    const guess = triageFolders(this.app, s);
    const folderSetting = (key, name, desc) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) => t.setPlaceholder(guess[key.replace("Folder", "")] || "").setValue(s[key]).onChange(async (v) => ((s[key] = v.trim().replace(/\/$/, "")), await save())));
    folderSetting("inboxFolder", "Inbox folder", `Detected: ${guess.inbox || "none"}`);
    folderSetting("archiveFolder", "Archive to", "Where A sends a note. Created if it doesn’t exist.");
    folderSetting("promoteFolder", "Promote to", "Where P sends a note — your permanent notes.");

    new Setting(containerEl).setName("Literature notes").setHeading();
    const litGuess = (findFolder(this.app, /literature|papers|references/i) || {}).path || "the vault's top level";
    new Setting(containerEl)
      .setName("Folder")
      .setDesc(`Where new literature notes and their PDFs go. Detected: ${litGuess}`)
      .addText((t) => t.setPlaceholder(litGuess).setValue(s.literatureFolder).onChange(async (v) => ((s.literatureFolder = v.trim().replace(/\/$/, "")), await save())));
    new Setting(containerEl)
      .setName("Save the PDF")
      .setDesc("From arXiv, or an open-access copy when there is one. Paywalled copies aren't downloaded.")
      .addToggle((t) => t.setValue(s.literaturePdf !== false).onChange(async (v) => ((s.literaturePdf = v), await save())));
    new Setting(containerEl)
      .setName("Tags")
      .setDesc("Added to each literature note.")
      .addText((t) => t.setPlaceholder("literature").setValue(s.literatureTags).onChange(async (v) => ((s.literatureTags = v), await save())));

    new Setting(containerEl).setName("Colored tags").setHeading();
    for (const color of Object.keys(DEFAULT_TAG_COLORS)) {
      new Setting(containerEl)
        .setName(color[0].toUpperCase() + color.slice(1))
        .setDesc("Tags that show this color, separated by commas.")
        .addText((t) =>
          t.setValue((s.tagColors[color] || []).join(", ")).onChange(async (v) => {
            s.tagColors[color] = v.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
            await save();
          })
        );
    }
    new Setting(containerEl)
      .setName("Color property")
      .setDesc("A note property that sets colors directly, like color: red.")
      .addText((t) => t.setValue(s.colorProperty).onChange(async (v) => ((s.colorProperty = v.trim() || "color"), await save())));

    new Setting(containerEl).setName("Link suggestions").setHeading();
    new Setting(containerEl)
      .setName("Shortest title to suggest")
      .addDropdown((d) => {
        for (const v of ["3", "4", "5", "6", "8"]) d.addOption(v, `${v} characters`);
        d.setValue(String(s.linkMinLength)).onChange(async (v) => ((s.linkMinLength = Number(v)), await save()));
      });
    new Setting(containerEl)
      .setName("Never suggest")
      .setDesc("Note titles to ignore, separated by commas.")
      .addTextArea((t) => t.setValue((s.linkIgnore || []).join(", ")).onChange(async (v) => ((s.linkIgnore = v.split(",").map((x) => x.trim()).filter(Boolean)), await save())));

    new Setting(containerEl).setName("Vault health").setHeading();
    new Setting(containerEl)
      .setName("Large file size")
      .addDropdown((d) => {
        for (const v of ["5", "10", "25", "50"]) d.addOption(v, `${v} MB`);
        d.setValue(String(s.hugeAttachmentMB)).onChange(async (v) => ((s.hugeAttachmentMB = Number(v)), await save()));
      });
    new Setting(containerEl)
      .setName("Skip folders")
      .setDesc("Folders to leave out of the health check, separated by commas — for example a clippings folder.")
      .addTextArea((t) => t.setValue((s.healthExclude || []).join(", ")).onChange(async (v) => ((s.healthExclude = v.split(",").map((x) => x.trim()).filter(Boolean)), await save())));

    new Setting(containerEl).setName("Text from images").setHeading();
    new Setting(containerEl)
      .setName("Searchable index note")
      .setDesc("Keep a note listing the text found in each image, so Obsidian’s search finds it.")
      .addToggle((t) => t.setValue(s.ocrWriteNote).onChange(async (v) => ((s.ocrWriteNote = v), await save())));
    new Setting(containerEl)
      .setName("Index note")
      .addText((t) => t.setPlaceholder("Image Text Index.md").setValue(s.ocrIndexNote).onChange(async (v) => ((s.ocrIndexNote = v.trim() || "Image Text Index.md"), await save())));
    const count = Object.keys(this.plugin.ocr.entries).length;
    new Setting(containerEl).setName("Images read").setDesc(`${count.toLocaleString()} images so far.`);
  }
}
