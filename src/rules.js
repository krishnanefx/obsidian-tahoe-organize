/* Small pure helpers for Tahoe Organize (no Obsidian calls, so they can be tested). */

// Is this path inside one of the folders? Trailing slashes and empty entries are ignored.
function inFolders(path, folders) {
  return (folders || []).some((f) => {
    const dir = String(f || "").trim().replace(/\/+$/, "");
    return dir && (path === dir || path.startsWith(`${dir}/`));
  });
}

export { inFolders };
