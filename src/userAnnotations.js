/**
 * Load user-created PDF annotations (highlights, notes) and attach them
 * to the corresponding framework nodes by document position.
 *
 * Excludes annotations created by Zhutero itself (those whose comment
 * starts with "[Zhutero]").
 */

/**
 * Read all user annotations from a PDF attachment.
 * @param {Zotero.Item} item - Parent item or PDF attachment
 * @returns {Promise<Array>} Array of {key, color, text, comment, pageIndex, y}
 */
async function loadUserAnnotations(item) {
  let attachment;
  if (item.isAttachment() && item.attachmentContentType === "application/pdf") {
    attachment = item;
  } else {
    const attachmentIDs = item.getAttachments();
    for (const aid of attachmentIDs) {
      const att = Zotero.Items.get(aid);
      if (att.attachmentContentType === "application/pdf") {
        attachment = att;
        break;
      }
    }
  }
  if (!attachment) return [];

  const annotations = attachment.getAnnotations();
  const result = [];
  for (const ann of annotations) {
    const comment = ann.annotationComment || "";
    if (comment.startsWith("[Zhutero]")) continue;

    let pageIndex = 0;
    let y = 0;
    try {
      const pos = JSON.parse(ann.annotationPosition || "{}");
      pageIndex = pos.pageIndex ?? 0;
      // Use top of first rect for sorting (PDF y goes up, so larger y = higher on page)
      if (pos.rects?.length) {
        y = pos.rects[0][1] ?? 0;
      }
    } catch (e) {
      // ignore parse errors
    }

    result.push({
      key: ann.key,
      itemId: ann.id,
      color: ann.annotationColor || "#ffd400",
      text: ann.annotationText || "",
      comment: comment,
      type: ann.annotationType || "highlight",
      pageIndex,
      y,
    });
  }
  return result;
}

/**
 * Walk the framework in document order (DFS) and produce a flat list of
 * { node, pageIndex } entries. Used to determine which node owns an
 * annotation by position.
 */
function flattenFramework(framework) {
  const list = [];
  function walk(node) {
    if (node.page) {
      list.push({ node, pageIndex: node.page - 1 });
    }
    if (node.children) {
      for (const child of node.children) walk(child);
    }
  }
  if (framework?.children) {
    for (const child of framework.children) walk(child);
  }
  return list;
}

/**
 * Group annotations by framework node. For each annotation, assign it to
 * the LAST node (in document order) whose page <= annotation page.
 *
 * Returns a Map from node.id -> array of annotations.
 *
 * @param {object} framework
 * @param {Array} annotations - From loadUserAnnotations()
 * @returns {Map<string, Array>}
 */
function groupAnnotationsByNode(framework, annotations) {
  const grouped = new Map();
  if (!framework || !annotations.length) return grouped;

  const flat = flattenFramework(framework);
  if (!flat.length) return grouped;

  // Sort annotations: by page asc, then by y desc (top of page first since PDF y is bottom-up)
  const sorted = [...annotations].sort((a, b) => {
    if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
    return b.y - a.y;
  });

  for (const ann of sorted) {
    // Find the last flat entry with pageIndex <= ann.pageIndex
    let owner = null;
    for (const entry of flat) {
      if (entry.pageIndex <= ann.pageIndex) {
        owner = entry.node;
      } else {
        break;
      }
    }
    // If annotation is before the first node, attach to the first node
    if (!owner) owner = flat[0].node;

    if (!grouped.has(owner.id)) grouped.set(owner.id, []);
    grouped.get(owner.id).push(ann);
  }

  return grouped;
}

if (typeof module !== "undefined") {
  module.exports = { loadUserAnnotations, groupAnnotationsByNode };
}
