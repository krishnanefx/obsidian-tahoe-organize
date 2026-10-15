/*
 * Literature notes from a link. Paste an arXiv or DOI link and get a note
 * with the title, authors, year, venue, abstract and BibTeX, plus the PDF
 * saved next to it when one is free to download (arXiv, or an open-access
 * copy). Works on iPhone too.
 *
 *   arXiv   export.arxiv.org (metadata), arxiv.org (BibTeX, PDF)
 *   DOI     api.crossref.org (metadata), doi.org (BibTeX),
 *           api.semanticscholar.org (abstract and open-access PDF when Crossref has none)
 */

import { Modal, Notice, Setting, TFile, normalizePath, requestUrl } from "obsidian";
import { ensureFolder, today } from "./util";
import { findFolder } from "./triage";

const MAX_PDF = 60e6;

// "2401.12345v2", "arXiv:2401.12345", arxiv.org/abs|pdf/…, old ids (hep-th/9901001), doi.org/10.…, bare DOIs
function parseRef(text) {
  const s = String(text || "").trim();
  const arxivDoi = /10\.48550\/arxiv\.([\w./-]+?)(v\d+)?$/i.exec(s);
  if (arxivDoi) return { kind: "arxiv", id: arxivDoi[1], version: arxivDoi[2] || "" };
  const a = /(?:arxiv\.org\/(?:abs|pdf|html)\/|arxiv:\s*|^)(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?(?:\.pdf)?\b/i.exec(s);
  if (a && (/arxiv/i.test(s) || /^\d{4}\.\d{4,5}(v\d+)?$/.test(s))) return { kind: "arxiv", id: a[1], version: a[2] || "" };
  const d = /\b(10\.\d{4,9}\/[^\s"<>]+)/i.exec(decodeURIComponent(s));
  if (d) return { kind: "doi", id: d[1].replace(/[.,;)\]]+$/, "") };
  return null;
}

// Just a link and nothing else (for offering a note on paste).
function isBareRef(text) {
  const s = String(text || "").trim();
  return !/\s/.test(s) && s.length < 200 && !!parseRef(s) && (/^https?:\/\/(?:www\.)?(arxiv\.org|doi\.org|dx\.doi\.org)\//i.test(s) || /^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(s) || /^10\.\d{4,9}\//.test(s));
}

async function get(url, headers = {}) {
  const r = await requestUrl({ url, headers, throw: false });
  if (r.status >= 400) throw new Error(`${new URL(url).host} answered ${r.status}`);
  return r;
}

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

async function fromArxiv(ref, progress) {
  progress("Looking it up on arXiv…");
  const r = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(ref.id + ref.version)}`);
  const xml = new DOMParser().parseFromString(r.text, "application/xml");
  const entry = xml.querySelector("entry");
  const title = entry && clean(entry.querySelector("title") && entry.querySelector("title").textContent);
  if (!entry || !title || /^error$/i.test(title)) throw new Error(`arXiv has no paper ${ref.id}`);
  const pick = (name) => {
    const el = [...entry.children].find((c) => c.localName === name);
    return el ? clean(el.textContent) : "";
  };
  const published = pick("published");
  const meta = {
    title,
    authors: [...entry.querySelectorAll("author > name")].map((n) => clean(n.textContent)),
    year: published.slice(0, 4),
    abstract: pick("summary"),
    venue: pick("journal_ref"),
    doi: pick("doi"),
    arxiv: ref.id,
    url: `https://arxiv.org/abs/${ref.id}`,
    category: ([...entry.children].find((c) => c.localName === "primary_category") || { getAttribute: () => "" }).getAttribute("term"),
    pdfUrl: `https://arxiv.org/pdf/${ref.id}${ref.version}`,
  };
  try {
    progress("Getting the BibTeX…");
    const b = await get(`https://arxiv.org/bibtex/${encodeURIComponent(ref.id)}`);
    meta.bibtex = b.text.trim();
  } catch {
    // no BibTeX: the note goes without it
  }
  return meta;
}

function stripJats(s) {
  return clean(String(s || "").replace(/<jats:title>[^<]*<\/jats:title>/gi, "").replace(/<[^>]+>/g, " "));
}

async function fromDoi(ref, progress) {
  progress("Looking it up on Crossref…");
  const r = await get(`https://api.crossref.org/works/${encodeURIComponent(ref.id)}`);
  const m = (r.json && r.json.message) || {};
  const date = (m.issued && m.issued["date-parts"] && m.issued["date-parts"][0]) || [];
  const meta = {
    title: clean((m.title || [])[0]),
    authors: (m.author || []).map((a) => clean([a.given, a.family].filter(Boolean).join(" ") || a.name)).filter(Boolean),
    year: date[0] ? String(date[0]) : "",
    abstract: stripJats(m.abstract),
    venue: clean((m["container-title"] || [])[0]),
    doi: ref.id,
    url: m.URL || `https://doi.org/${ref.id}`,
  };
  if (!meta.title) throw new Error(`No record for DOI ${ref.id}`);
  try {
    progress("Getting the BibTeX…");
    const b = await get(`https://doi.org/${ref.id}`, { Accept: "application/x-bibtex; charset=utf-8" });
    if (/^\s*@/.test(b.text)) meta.bibtex = b.text.trim();
  } catch {
    // no BibTeX: the note goes without it
  }
  // An abstract, and a PDF that's free to download.
  try {
    progress("Looking for an open-access PDF…");
    const s = await get(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(ref.id)}?fields=abstract,openAccessPdf,externalIds,venue`);
    const p = s.json || {};
    if (!meta.abstract && p.abstract) meta.abstract = clean(p.abstract);
    if (!meta.venue && p.venue) meta.venue = clean(p.venue);
    const arxiv = p.externalIds && p.externalIds.ArXiv;
    if (arxiv) {
      meta.arxiv = arxiv;
      meta.pdfUrl = `https://arxiv.org/pdf/${arxiv}`;
    } else if (p.openAccessPdf && p.openAccessPdf.url) meta.pdfUrl = p.openAccessPdf.url;
  } catch {
    // no abstract or free PDF
  }
  return meta;
}

function lastName(author) {
  const parts = String(author || "").split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "Unknown";
}

function noteName(meta) {
  const safe = (s) => s.replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim();
  let title = safe(meta.title);
  if (title.length > 70) title = `${title.slice(0, 70).replace(/\s+\S*$/, "")}…`;
  const who = meta.authors.length ? safe(lastName(meta.authors[0])) : "Unknown";
  return [who, meta.year].filter(Boolean).join(" ") + ` - ${title}`;
}

function body(meta, pdfName) {
  const authors = meta.authors.length > 4 ? `${meta.authors.slice(0, 3).join(", ")} et al.` : meta.authors.join(", ");
  const links = [meta.arxiv ? `[arXiv:${meta.arxiv}](https://arxiv.org/abs/${meta.arxiv})` : "", meta.doi ? `[doi:${meta.doi}](https://doi.org/${meta.doi})` : ""].filter(Boolean).join(" · ");
  // The note's own title is the paper's (with author and year), so no heading repeats it.
  const lines = [`${authors}${meta.year ? ` · ${meta.year}` : ""}${meta.venue ? ` · *${meta.venue}*` : ""}`, ""];
  if (links) lines.push(links, "");
  if (meta.abstract) lines.push("> [!abstract]", `> ${meta.abstract}`, "");
  lines.push("## Notes", "", "", "## Key ideas", "", "- ", "");
  if (pdfName) lines.push("## PDF", "", `![[${pdfName}#height=520]]`, "");
  if (meta.bibtex) lines.push("## BibTeX", "", "```bibtex", meta.bibtex, "```", "");
  return lines.join("\n");
}

// Look it up, save the PDF if there's one to have, write the note, open it.
async function createLiteratureNote(plugin, text, { pdf = true, progress = () => {} } = {}) {
  const app = plugin.app;
  const ref = parseRef(text);
  if (!ref) throw new Error("That isn't an arXiv or DOI link");
  const meta = ref.kind === "arxiv" ? await fromArxiv(ref, progress) : await fromDoi(ref, progress);

  const folderPath = plugin.settings.literatureFolder || (findFolder(app, /literature|papers|references/i) || {}).path || "";
  if (folderPath) await ensureFolder(app, folderPath);
  const base = noteName(meta);
  const notePath = normalizePath(folderPath ? `${folderPath}/${base}.md` : `${base}.md`);
  const existing = app.vault.getAbstractFileByPath(notePath);
  if (existing instanceof TFile) {
    await app.workspace.getLeaf(false).openFile(existing);
    return { file: existing, existed: true, meta };
  }

  let pdfName = "";
  if (pdf && meta.pdfUrl) {
    try {
      progress("Downloading the PDF…");
      const r = await requestUrl({ url: meta.pdfUrl, throw: false });
      const type = (r.headers && (r.headers["content-type"] || r.headers["Content-Type"])) || "";
      const bytes = r.arrayBuffer;
      const isPdf = /pdf/i.test(type) || (bytes && new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5))) === "%PDF-");
      if (r.status < 400 && isPdf && bytes.byteLength < MAX_PDF) {
        pdfName = `${base}.pdf`;
        const pdfPath = normalizePath(folderPath ? `${folderPath}/${pdfName}` : pdfName);
        if (!app.vault.getAbstractFileByPath(pdfPath)) await app.vault.createBinary(pdfPath, bytes);
      }
    } catch (e) {
      console.warn("Tahoe Organize: couldn't download the PDF", e);
    }
  }

  progress("Writing the note…");
  const file = await app.vault.create(notePath, body(meta, pdfName));
  await app.fileManager.processFrontMatter(file, (fm) => {
    fm.title = meta.title;
    fm.authors = meta.authors;
    if (meta.year) fm.year = Number(meta.year) || meta.year;
    if (meta.venue) fm.venue = meta.venue;
    if (meta.arxiv) fm.arxiv = meta.arxiv;
    if (meta.doi) fm.doi = meta.doi;
    fm.url = meta.url;
    if (pdfName) fm.pdf = `[[${pdfName}]]`;
    fm.tags = (plugin.settings.literatureTags || "literature").split(/[,\s]+/).filter(Boolean);
    fm.added = today();
  });
  await app.workspace.getLeaf(false).openFile(file);
  return { file, existed: false, meta, pdf: !!pdfName };
}

class LiteratureModal extends Modal {
  constructor(plugin, initial = "") {
    super(plugin.app);
    this.plugin = plugin;
    this.initial = initial;
  }

  onOpen() {
    this.titleEl.setText("New literature note");
    const { contentEl } = this;
    contentEl.createEl("p", { cls: "setting-item-description", text: "Paste an arXiv or DOI link. The title, authors, abstract and BibTeX are filled in, and the PDF is saved next to the note when it's free to download." });
    const input = contentEl.createEl("input", { type: "text", cls: "tahoe-literature-input", attr: { placeholder: "https://arxiv.org/abs/1706.03762  or  10.1038/nature14539", spellcheck: "false" } });
    input.value = this.initial;
    let pdf = this.plugin.settings.literaturePdf !== false;
    new Setting(contentEl).setName("Save the PDF").addToggle((t) => t.setValue(pdf).onChange((v) => (pdf = v)));
    const status = contentEl.createDiv({ cls: "setting-item-description" });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    const go = row.createEl("button", { text: "Create", cls: "mod-cta" });
    const run = async () => {
      if (!parseRef(input.value)) {
        status.setText("That doesn't look like an arXiv or DOI link.");
        return;
      }
      go.disabled = true;
      try {
        const r = await createLiteratureNote(this.plugin, input.value, { pdf, progress: (s) => status.setText(s) });
        this.close();
        new Notice(r.existed ? "You already have a note for this paper" : `Added “${r.meta.title}”${pdf && !r.pdf ? " (no free PDF found)" : ""}`);
      } catch (e) {
        status.setText(`Couldn't make the note: ${e.message}`);
        go.disabled = false;
      }
    };
    go.addEventListener("click", run);
    input.addEventListener("keydown", (e) => e.key === "Enter" && run());
    window.setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
  }
}

export { parseRef, isBareRef, createLiteratureNote, LiteratureModal, noteName };
