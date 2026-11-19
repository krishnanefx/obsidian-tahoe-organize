/* Small pure helpers for Tahoe Organize (no Obsidian calls, so they can be tested). */

// Is this path inside one of the folders? Trailing slashes and empty entries are ignored.
function inFolders(path, folders) {
  return (folders || []).some((f) => {
    const dir = String(f || "").trim().replace(/\/+$/, "");
    return dir && (path === dir || path.startsWith(`${dir}/`));
  });
}

// Does the note have a tag, in its text or in its properties?
function hasTags(cache) {
  if (!cache) return false;
  if (cache.tags && cache.tags.length) return true;
  const t = cache.frontmatter && cache.frontmatter.tags;
  if (Array.isArray(t)) return t.some((x) => String(x).trim());
  return !!(t && String(t).trim());
}

export { inFolders, hasTags };
