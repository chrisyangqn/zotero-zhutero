/**
 * Note-based storage for Zhutero frameworks.
 *
 * Each parent item gets a single child note that holds its framework.
 * The note contains both:
 *   - human-readable HTML rendering of the tree
 *   - a hidden <div data-zhutero-framework> element holding the JSON
 *     source of truth
 *
 * The note is "zhutero-managed": users should not edit it directly. Any
 * manual edits are overwritten on the next save.
 */

/* globals Zotero */

const FRAMEWORK_MARKER_ATTR = "data-zhutero-framework";
const NOTE_TITLE_PREFIX = "[Zhutero] ";

/**
 * Resolve to the parent regular item for any given input item.
 * - Regular item → itself
 * - PDF/EPUB attachment → its parent
 * - Note → its parent
 */
function getParentItem(item) {
  if (!item) return null;
  if (item.isAttachment() || item.isNote()) {
    if (item.parentItemID) return Zotero.Items.get(item.parentItemID);
    return null;
  }
  return item;
}

/**
 * Find the existing Zhutero-managed note for an item, if any.
 * Returns the Zotero.Item (note) or null.
 */
function findFrameworkNote(item) {
  const parent = getParentItem(item);
  if (!parent) return null;
  const noteIDs = parent.getNotes();
  for (const nid of noteIDs) {
    const note = Zotero.Items.get(nid);
    const html = note.getNote() || "";
    if (html.includes(FRAMEWORK_MARKER_ATTR)) return note;
  }
  return null;
}

/**
 * Extract the framework JSON object from a note's HTML.
 * Returns null if not a Zhutero note or JSON malformed.
 */
function parseFrameworkFromNoteHTML(html) {
  if (!html || !html.includes(FRAMEWORK_MARKER_ATTR)) return null;
  // Match: <div data-zhutero-framework="1" ...>JSON</div>
  // Use a permissive regex that tolerates attribute order and whitespace.
  const re = /<div\b[^>]*data-zhutero-framework[^>]*>([\s\S]*?)<\/div>/i;
  const m = html.match(re);
  if (!m) return null;
  let inner = m[1].trim();
  // Decode common HTML entities back to their chars
  inner = inner
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  try {
    return JSON.parse(inner);
  } catch (e) {
    Zotero.log(`[Zhutero/Note] Failed to parse framework JSON: ${e.message}`, "warning");
    return null;
  }
}

/**
 * Load framework JSON for a given item by reading its child note.
 * Returns null if no framework note exists.
 */
function loadFrameworkFromNote(item) {
  const note = findFrameworkNote(item);
  if (!note) return null;
  return parseFrameworkFromNoteHTML(note.getNote());
}

function escHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the human-readable HTML body for a framework. The hidden JSON
 * block is appended separately by saveFramework.
 */
function renderFrameworkHTML(framework) {
  const parts = [];
  parts.push(`<div data-schema-version="9">`);
  parts.push(
    `<p style="background:#fef3c7;padding:8px 12px;border-left:3px solid #f59e0b;color:#78350f;font-size:12px;border-radius:3px;">` +
    `📚 <strong>Zhutero Framework</strong> — managed automatically. Direct edits will be overwritten.` +
    `</p>`
  );
  // Zotero derives note titles from the first text content. Prefix with
  // "[Zhutero]" so the note is easy to recognize in the items list.
  const titleText = framework.title
    ? `[Zhutero] ${framework.title}`
    : `[Zhutero] Reading Framework`;
  parts.push(`<h1>${escHTML(titleText)}</h1>`);
  if (framework.thesis) parts.push(`<p><em>${escHTML(framework.thesis)}</em></p>`);

  function nodeHTML(node, depth) {
    const tag = depth === 0 ? "h2" : depth === 1 ? "h3" : depth === 2 ? "h4" : "h5";
    const lines = [];
    const pageStr = node.page != null ? ` <span style="color:#6b7280;font-weight:normal;">(p.${escHTML(node.page)})</span>` : "";
    lines.push(`<${tag}>${escHTML(node.label || "")}${pageStr}</${tag}>`);
    if (node.summary) lines.push(`<p>${escHTML(node.summary)}</p>`);
    if (node.quotes?.length) {
      for (const q of node.quotes) {
        if (q?.text) lines.push(`<blockquote>${escHTML(q.text)}</blockquote>`);
      }
    }
    if (node.userHighlights?.length) {
      lines.push(`<ul style="list-style:none;padding-left:0;">`);
      for (const h of node.userHighlights) {
        const color = h.color || "#ffd400";
        const txt = h.text ? escHTML(h.text) : "";
        const com = h.comment ? `<br><strong>${escHTML(h.comment)}</strong>` : "";
        lines.push(
          `<li style="border-left:3px solid ${escHTML(color)};padding:4px 8px;margin:4px 0;background:#f9fafb;">` +
          `<em>${txt}</em>${com}` +
          `</li>`
        );
      }
      lines.push(`</ul>`);
    }
    if (node.userNote) {
      lines.push(`<p style="background:#eff6ff;padding:6px 10px;border-left:3px solid #3b82f6;">📝 ${escHTML(node.userNote)}</p>`);
    }
    if (node.children?.length) {
      for (const child of node.children) lines.push(nodeHTML(child, depth + 1));
    }
    return lines.join("\n");
  }

  if (framework.children?.length) {
    for (const child of framework.children) parts.push(nodeHTML(child, 0));
  }

  parts.push(`</div>`);
  return parts.join("\n");
}

/**
 * Save framework to the parent item's Zhutero note. Creates the note if
 * it doesn't exist; otherwise overwrites its content.
 */
async function saveFrameworkToNote(item, framework) {
  const parent = getParentItem(item);
  if (!parent) throw new Error("Cannot save framework: no parent item");

  const visible = renderFrameworkHTML(framework);
  // Hidden JSON block — escape to avoid breaking the HTML
  const jsonStr = JSON.stringify({ ...framework, updatedAt: new Date().toISOString() });
  const hidden =
    `<div ${FRAMEWORK_MARKER_ATTR}="1" style="display:none;font-family:monospace;font-size:9px;color:#9ca3af;">` +
    escHTML(jsonStr) +
    `</div>`;

  const fullHTML = visible + "\n" + hidden;

  let note = findFrameworkNote(item);
  if (note) {
    note.setNote(fullHTML);
    await note.saveTx();
    Zotero.debug(`[Zhutero/Note] Updated existing note ${note.key}`);
  } else {
    note = new Zotero.Item("note");
    note.parentID = parent.id;
    note.libraryID = parent.libraryID;
    note.setNote(fullHTML);
    // Note: Zotero notes don't have a "title" field — the title is auto-
    // derived from the first heading/line of HTML. We render the framework
    // title as the leading <h1>, so the note will show as "[Zhutero] {title}"-ish.
    await note.saveTx();
    Zotero.debug(`[Zhutero/Note] Created new note ${note.key}`);
  }
  return note;
}

/**
 * Migrate framework data from the old zhutero-data.json store into a note,
 * if the note doesn't yet exist. Returns the loaded framework or null.
 */
async function migrateFromLegacyStorage(item, legacyStorage) {
  const existing = findFrameworkNote(item);
  if (existing) return null; // already migrated

  if (typeof getFramework !== "function") return null;
  const legacy = await legacyStorage.getFramework(item.key);
  if (!legacy) return null;

  Zotero.debug(`[Zhutero/Note] Migrating legacy framework for item ${item.key} into note`);

  // Pull legacy per-node notes into the framework
  let legacyNotes = [];
  try { legacyNotes = await legacyStorage.getNotes(item.key); } catch (e) {}
  if (legacyNotes.length) {
    const byId = new Map(legacyNotes.map(n => [n.node_id, n.content]));
    function applyNotes(node) {
      const c = byId.get(node.id);
      if (c) node.userNote = c;
      if (node.children) for (const ch of node.children) applyNotes(ch);
    }
    if (legacy.children) for (const ch of legacy.children) applyNotes(ch);
  }

  await saveFrameworkToNote(item, legacy);
  // Remove legacy entry to avoid confusion
  try { await legacyStorage.deleteFramework(item.key); } catch (e) {}
  return legacy;
}

/**
 * Add a user highlight to a framework.
 *
 * If `hint` is provided (typical for EPUB), it's the result of mapping
 * the highlight's CFI to a chapter (and possibly subsection) in the
 * framework: { chapterPage, subIndex }. Use that directly.
 *
 * Otherwise (PDF), fall back to position-based matching: walk the tree
 * in document order, attach to the deepest node whose page <= the
 * highlight's page.
 *
 * Mutates and returns the framework.
 */
function attachHighlightToFramework(framework, highlight, hint) {
  if (!framework?.children?.length) return framework;

  let owner = null;

  if (hint?.chapterPage != null) {
    const chapter = framework.children.find(c => c.page === hint.chapterPage);
    if (chapter) {
      owner = chapter;
      if (hint.subIndex && chapter.children?.[hint.subIndex - 1]) {
        owner = chapter.children[hint.subIndex - 1];
      }
    }
  }

  // Fallback: position-based for PDFs (or EPUB highlights we couldn't map)
  if (!owner) {
    function walk(node) {
      if (node.page != null && node.page <= highlight.pageIndex + 1) owner = node;
      if (node.children) for (const c of node.children) walk(c);
    }
    for (const c of framework.children) walk(c);
    if (!owner) owner = framework.children[0];
  }

  if (!owner.userHighlights) owner.userHighlights = [];
  if (highlight.key && owner.userHighlights.some(h => h.key === highlight.key)) {
    return framework;
  }
  owner.userHighlights.push(highlight);
  return framework;
}

/**
 * Remove a user highlight by key from anywhere in the framework.
 * Returns true if removed.
 */
function removeHighlightFromFramework(framework, key) {
  if (!framework?.children?.length || !key) return false;
  let removed = false;
  function walk(node) {
    if (node.userHighlights?.length) {
      const before = node.userHighlights.length;
      node.userHighlights = node.userHighlights.filter(h => h.key !== key);
      if (node.userHighlights.length < before) removed = true;
    }
    if (node.children) for (const c of node.children) walk(c);
  }
  for (const c of framework.children) walk(c);
  return removed;
}

if (typeof module !== "undefined") {
  module.exports = {
    findFrameworkNote, loadFrameworkFromNote, saveFrameworkToNote,
    migrateFromLegacyStorage, attachHighlightToFramework,
    removeHighlightFromFramework, parseFrameworkFromNoteHTML,
  };
}
