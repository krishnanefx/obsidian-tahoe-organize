/*
 * Finder-style colored tags: notes tagged with a color tag (#red, or any tag
 * mapped to a color in settings), or with `color: red` in their properties,
 * get Finder's overlapping color dots in the file list. Tag pills in notes
 * take the same color. It's all CSS (a stylesheet of the plugin's own, made
 * with CSSStyleSheet), so it works on iPhone too.
 */

import { getAllTags } from "obsidian";
import { debounce, ignored } from "./util";

const FINDER_COLORS = {
  red: "var(--color-red, #ff3b30)",
  orange: "var(--color-orange, #ff9500)",
  yellow: "var(--color-yellow, #ffcc00)",
  green: "var(--color-green, #34c759)",
  blue: "var(--color-blue, #007aff)",
  purple: "var(--color-purple, #af52de)",
  gray: "var(--color-base-60, #8e8e93)",
};

const DEFAULT_TAG_COLORS = {
  red: ["red", "urgent"],
  orange: ["orange"],
  yellow: ["yellow", "important"],
  green: ["green", "done"],
  blue: ["blue"],
  purple: ["purple"],
  gray: ["gray", "grey", "archive"],
};

function cssString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\a ")}"`;
}

class TagColors {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.sheet = null;
    this.update = debounce(() => this.render(), 300);
  }

  enable() {
    try {
      this.sheet = new CSSStyleSheet();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, this.sheet];
    } catch {
      // no constructable stylesheets here: no colors
      this.sheet = null;
    }
    this.plugin.registerEvent(this.app.metadataCache.on("resolved", () => this.update()));
    this.plugin.registerEvent(this.app.metadataCache.on("changed", () => this.update()));
    this.plugin.registerEvent(this.app.vault.on("rename", () => this.update()));
    this.render();
  }

  disable() {
    this.update.cancel();
    if (this.sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== this.sheet);
    this.sheet = null;
  }

  tagMap() {
    const map = new Map(); // tag (lowercase, no #) → color name
    const conf = this.plugin.settings.tagColors || DEFAULT_TAG_COLORS;
    for (const [color, tags] of Object.entries(conf)) for (const t of tags || []) if (t) map.set(String(t).replace(/^#/, "").toLowerCase(), color);
    return map;
  }

  colorsFor(file, tagMap) {
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return [];
    const colors = [];
    const add = (c) => {
      c = String(c).toLowerCase().trim();
      if (c === "grey") c = "gray";
      if (FINDER_COLORS[c] && !colors.includes(c)) colors.push(c);
    };
    for (const t of getAllTags(cache) || []) {
      const c = tagMap.get(t.replace(/^#/, "").toLowerCase());
      if (c) add(c);
    }
    const prop = this.plugin.settings.colorProperty || "color";
    const fm = cache.frontmatter || {};
    const value = fm[prop];
    if (Array.isArray(value)) value.forEach(add);
    else if (value) String(value).split(/[,\s]+/).forEach(add);
    return colors;
  }

  render() {
    if (!this.sheet) return;
    const tagMap = this.tagMap();
    const rules = [];

    // Dots in the file list, overlapping like Finder's, ringed in the row's color (see styles.css).
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (ignored(this.app, file.path)) continue;
      const colors = this.colorsFor(file, tagMap).slice(0, 4);
      if (!colors.length) continue;
      const layers = colors
        .map((c, i) => `radial-gradient(circle at ${4.5 + i * 5}px 50%, ${FINDER_COLORS[c]} 3.4px, var(--tahoe-tag-ring) 3.6px 4.5px, transparent 4.7px)`)
        .reverse()
        .join(", ");
      rules.push(
        `.nav-file-title[data-path=${cssString(file.path)}] .tree-item-inner::after { content: ""; display: inline-block; width: ${9 + (colors.length - 1) * 5}px; height: 9px; margin-inline-start: 6px; vertical-align: -0.5px; background: ${layers}; }`
      );
    }

    // Tag pills in notes and Live Preview take their color.
    for (const [tag, color] of tagMap) {
      const c = FINDER_COLORS[color];
      if (!c) continue;
      const cls = tag.replace(/[^\w-]/g, (ch) => `\\${ch}`);
      rules.push(
        `a.tag[href=${cssString(`#${tag}`)} i], .cm-hashtag.cm-tag-${cls} { color: ${c}; background-color: color-mix(in srgb, ${c} 15%, transparent); }`
      );
    }
    this.sheet.replaceSync(rules.join("\n"));
  }
}

export { TagColors, DEFAULT_TAG_COLORS, FINDER_COLORS };
