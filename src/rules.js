/* Small pure helpers for Tahoe Organize (no Obsidian calls, so they can be tested). */

// Is this path inside one of the folders? Trailing slashes and empty entries are ignored.
function inFolders(path, folders) {
  return (folders || []).some((f) => {
    const dir = String(f || "").trim().replace(/\/+$/, "");
    return dir && (path === dir || path.startsWith(`${dir}/`));
  });
}

// Which side of an iCloud conflict is newer. A tie keeps the original.
function newerSide(originalMtime, copyMtime) {
  return copyMtime > originalMtime ? "copy" : "original";
}

// Does the note have a tag, in its text or in its properties?
function hasTags(cache) {
  if (!cache) return false;
  if (cache.tags && cache.tags.length) return true;
  const t = cache.frontmatter && cache.frontmatter.tags;
  if (Array.isArray(t)) return t.some((x) => String(x).trim());
  return !!(t && String(t).trim());
}

// A health report as plain Markdown, for the clipboard.
function healthSummary(r, hugeMB) {
  const lines = [
    "# Vault health",
    "",
    `- ${r.notes} notes, ${r.attachments} attachments`,
    `- ${r.broken.length} broken links`,
    `- ${r.empty.length} empty notes`,
    `- ${r.unused.length} unused attachments`,
    `- ${r.huge.length} files over ${hugeMB} MB`,
    `- ${r.orphans.length} orphan notes`,
  ];
  if (r.untagged) lines.push(`- ${r.untagged.length} notes without tags`);
  if (r.conflicts) lines.push(`- ${r.conflicts} iCloud conflict copies`);
  return lines.join("\n");
}

export { inFolders, newerSide, hasTags, healthSummary };
