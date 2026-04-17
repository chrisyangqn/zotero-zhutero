/**
 * Framework generation - ported from Zhutero, adapted for Zotero.
 * Generates a hierarchical reading framework from document text using LLM.
 */

const FRAMEWORK_PROMPT = `You are a reading analysis assistant. Given the extracted text of a document (book, paper, or article), generate a reading framework as structured JSON.

IMPORTANT: For every node, you MUST include a "quotes" array with exact verbatim text copied from the input. These quotes are used for highlighting in the reader.

Return ONLY valid JSON with this exact structure:
{
  "title": "Document title",
  "thesis": "Main thesis or central argument",
  "children": [
    {
      "id": "c1",
      "label": "Chapter/Section Title",
      "type": "chapter",
      "page": 1,
      "summary": "Brief summary",
      "quotes": [
        { "page": 1, "text": "EXACT heading text from source", "type": "heading" }
      ],
      "children": [
        {
          "id": "c1s1",
          "label": "Subsection Title",
          "type": "argument",
          "page": 2,
          "summary": "What this section argues",
          "quotes": [
            { "page": 2, "text": "EXACT key quote from source text, verbatim", "type": "content" }
          ],
          "children": []
        }
      ]
    }
  ]
}

Rules:
- "page" must correspond to page numbers in the source text (shown as "=== PAGE N ===")
- "quotes" text MUST be copied VERBATIM from the source — exact characters, exact spacing, exact punctuation
- For chapter/section headings, include the full heading line as a quote with type "heading"
- For arguments, include 1-2 key sentences as quotes with type "content"
- Hierarchy: chapters → arguments → sub-points
- Each node needs: id, label, type, page, summary, quotes, children
- Be thorough — capture all chapters/sections and key arguments
- Keep summaries concise (1-2 sentences)
- For academic papers: abstract → introduction → methodology → results → discussion → conclusion
- CRITICAL: Output must be valid JSON. Escape all double quotes inside strings with backslash. Do not use unescaped newlines inside string values.`;

/**
 * Parse potentially malformed JSON from LLM output.
 */
function parseLLMJson(text) {
  // Extract from code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();

  // Find the JSON object boundaries
  const start = jsonStr.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    let end = start;
    let inString = false;
    let escape = false;
    for (let i = start; i < jsonStr.length; i++) {
      const ch = jsonStr[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth === 0) { end = i + 1; break; }
    }
    jsonStr = jsonStr.slice(start, end);
  }

  // Fix common LLM JSON errors
  jsonStr = jsonStr
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]");

  // Try direct parse
  try {
    return JSON.parse(jsonStr);
  } catch (e1) {
    // Fix unescaped control characters inside strings
    jsonStr = jsonStr.replace(/[\x00-\x1f]/g, (ch) => {
      if (ch === "\n") return "\\n";
      if (ch === "\r") return "\\r";
      if (ch === "\t") return "\\t";
      return "";
    });

    try {
      return JSON.parse(jsonStr);
    } catch (e2) {
      // Try even more aggressive cleanup: fix unescaped quotes in string values
      // Match "key": "value with "quotes" inside" patterns
      jsonStr = jsonStr.replace(
        /: "([^"]*?)"/g,
        (match, content) => ': "' + content.replace(/(?<!\\)"/g, '\\"') + '"'
      );

      try {
        return JSON.parse(jsonStr);
      } catch (e3) {
        throw new Error(
          `Failed to parse framework JSON at ${e1.message}. ` +
          `Response preview: ${text.slice(0, 200)}...`
        );
      }
    }
  }
}

/**
 * Generate a reading framework for the given document text.
 * @param {string} fullText - Document text with page markers
 * @param {function} chatCompletion - LLM chat function from llm.js
 * @param {function} [onProgress] - Optional progress callback
 * @returns {Promise<{ framework: object, usage: object }>}
 */
async function generateFramework(fullText, chatCompletion, onProgress) {
  if (onProgress) onProgress("Sending to LLM...");

  const { text, usage } = await chatCompletion(
    FRAMEWORK_PROMPT,
    `Generate a reading framework for this document. The text below has page numbers marked as "=== PAGE N ===".\n\n${fullText}`,
    { maxTokens: 16000 }
  );

  if (onProgress) onProgress("Parsing response...");

  const framework = parseLLMJson(text);
  return { framework, usage };
}

/**
 * Extract full text from a Zotero item with page markers.
 * Uses Zotero's built-in full-text index.
 * @param {number} itemID
 * @returns {Promise<string>}
 */
async function getItemFullText(itemID) {
  const item = Zotero.Items.get(itemID);
  if (!item) throw new Error("Item not found");

  // If this is an attachment, use it directly; if parent item, find PDF attachment
  let attachment = item;
  if (!item.isAttachment()) {
    const attachmentIDs = item.getAttachments();
    for (const aid of attachmentIDs) {
      const att = Zotero.Items.get(aid);
      if (att.attachmentContentType === "application/pdf") {
        attachment = att;
        break;
      }
    }
  }

  if (!attachment?.isAttachment()) {
    throw new Error("No PDF attachment found");
  }

  // Per-page text extraction using Zotero.PDFWorker
  // getFullText can accept maxPages=1 per call, but that's slow.
  // Instead, use Zotero's internal PDF processor which returns per-page chars.
  try {
    const pdfPath = await attachment.getFilePathAsync();
    if (pdfPath) {
      const data = await IOUtils.read(pdfPath);
      // Use Zotero's internal PDF processor to get per-page text
      const result = await Zotero.PDFWorker._query("getFullText", { buf: data.buffer }, [data.buffer]);
      if (result?.pageTexts && result.pageTexts.length > 0) {
        // pageTexts is an array of strings, one per page
        const pages = result.pageTexts.map((text, i) => `=== PAGE ${i + 1} ===\n${text}`);
        return pages.join("\n\n");
      }
      if (result?.text) {
        return result.text;
      }
    }
  } catch (e) {
    Zotero.log("[Zhutero] PDFWorker per-page failed: " + e.message, "warning");
  }

  // Fallback: get full text (no page markers, but still usable)
  try {
    const result = await Zotero.PDFWorker.getFullText(attachment.id);
    if (result?.text) {
      Zotero.log("[Zhutero] Using full text without page markers", "warning");
      return result.text;
    }
  } catch (e) {
    Zotero.log("[Zhutero] PDFWorker.getFullText failed: " + e.message, "warning");
  }

  try {
    const text = await attachment.attachmentText;
    if (text) return text;
  } catch (e) {
    Zotero.log("[Zhutero] attachmentText failed: " + e.message, "warning");
  }

  throw new Error("Could not extract text from PDF. Make sure the file is downloaded.");
}

/**
 * Create PDF annotations for each framework node and store annotation keys.
 * Each node with a page number gets a "note" annotation on that page.
 * Returns the framework with annotationKey added to each node.
 *
 * @param {object} framework - The framework tree
 * @param {Zotero.Item} item - The parent or attachment item
 * @returns {Promise<object>} framework with annotationKey fields
 */
async function createAnnotationsForFramework(framework, item) {
  // Find the PDF attachment
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
  if (!attachment) {
    Zotero.log("[Zhutero] No PDF attachment found for annotations", "warning");
    return framework;
  }

  // Extract per-page character positions from PDF for precise highlighting
  let pageChars = []; // pageChars[pageIndex] = [{str, x, y, w, h}, ...]
  try {
    const pdfPath = await attachment.getFilePathAsync();
    if (pdfPath) {
      const data = await IOUtils.read(pdfPath);
      // Use Zotero's PDFWorker to get character-level data
      const result = await Zotero.PDFWorker._query(
        "getFullText",
        { buf: data.buffer, maxPages: 999 },
        [data.buffer]
      );
      if (result?.pageChars) {
        pageChars = result.pageChars;
      }
    }
  } catch (e) {
    Zotero.log("[Zhutero] Could not extract page chars: " + e.message, "warning");
  }

  /**
   * Find bounding rects for a text string on a given page.
   * Returns array of [x1, y1, x2, y2] rects, or null if not found.
   */
  function findTextRects(pageIndex, searchText) {
    if (!pageChars[pageIndex] || !searchText) return null;

    const chars = pageChars[pageIndex];
    // Build page text from chars
    const pageText = chars.map(c => c.c || c.char || c.str || "").join("");
    const needle = searchText.slice(0, 80); // use first 80 chars for matching
    const idx = pageText.indexOf(needle);
    if (idx < 0) {
      // Try case-insensitive
      const idxCI = pageText.toLowerCase().indexOf(needle.toLowerCase());
      if (idxCI < 0) return null;
      return buildRects(chars, idxCI, idxCI + needle.length);
    }
    return buildRects(chars, idx, idx + needle.length);
  }

  function buildRects(chars, startIdx, endIdx) {
    const rects = [];
    let lineRect = null;
    const TOLERANCE = 3; // y-tolerance for same line

    for (let i = startIdx; i < Math.min(endIdx, chars.length); i++) {
      const c = chars[i];
      if (!c || !c.rect) continue;
      const [x1, y1, x2, y2] = c.rect;

      if (!lineRect) {
        lineRect = [x1, y1, x2, y2];
      } else if (Math.abs(y1 - lineRect[1]) < TOLERANCE) {
        // Same line - extend
        lineRect[2] = Math.max(lineRect[2], x2);
        lineRect[3] = Math.max(lineRect[3], y2);
        lineRect[0] = Math.min(lineRect[0], x1);
        lineRect[1] = Math.min(lineRect[1], y1);
      } else {
        // New line
        rects.push([...lineRect]);
        lineRect = [x1, y1, x2, y2];
      }
    }
    if (lineRect) rects.push(lineRect);
    return rects.length > 0 ? rects : null;
  }

  // Recursively create highlight annotations for each node
  async function processNode(node, sortIdx) {
    if (node.page) {
      try {
        const pageIdx = node.page - 1;

        // Try to find precise text rects from quotes
        let highlightText = node.label || "";
        let rects = null;

        if (node.quotes?.length) {
          for (const q of node.quotes) {
            const qPage = (q.page || node.page) - 1;
            rects = findTextRects(qPage, q.text);
            if (rects) {
              highlightText = q.text;
              break;
            }
          }
        }

        // Fallback: try finding the node label on the page
        if (!rects) {
          rects = findTextRects(pageIdx, node.label);
        }

        // Last fallback: place at a default position
        if (!rects) {
          const yPos = 700 - (sortIdx % 8) * 30;
          rects = [[72, yPos, 400, yPos + 12]];
        }

        const typeColors = {
          chapter: "#5fb7d4",   // blue
          argument: "#5bc68a",  // green
          subpoint: "#f5c542",  // yellow
        };

        const annotation = new Zotero.Item("annotation");
        annotation.parentID = attachment.id;
        annotation.libraryID = attachment.libraryID;
        annotation.annotationType = "highlight";
        annotation.annotationColor = typeColors[node.type] || "#aaaaaa";
        annotation.annotationText = highlightText;
        annotation.annotationComment =
          `[Zhutero] ${node.label || ""}\n\n${node.summary || ""}`;
        annotation.annotationPosition = JSON.stringify({
          pageIndex: pageIdx,
          rects: rects,
        });
        annotation.annotationSortIndex =
          String(node.page).padStart(5, "0") + "|" +
          String(sortIdx).padStart(6, "0") + "|00000";

        await annotation.saveTx();
        node.annotationKey = annotation.key;
      } catch (e) {
        Zotero.log(`[Zhutero] Failed to create annotation for "${node.label}": ${e.message}`, "warning");
      }
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        await processNode(node.children[i], sortIdx * 10 + i);
      }
    }
  }

  if (framework.children) {
    for (let i = 0; i < framework.children.length; i++) {
      await processNode(framework.children[i], i);
    }
  }

  return framework;
}

/**
 * Remove all Zhutero-created annotations from a PDF attachment.
 * @param {Zotero.Item} item
 */
async function removeZhuteroAnnotations(item) {
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
  if (!attachment) return;

  const annotations = attachment.getAnnotations();
  const toDelete = [];
  for (const ann of annotations) {
    if (ann.annotationComment?.includes("[Zhutero]")) {
      toDelete.push(ann.id);
    }
  }
  if (toDelete.length > 0) {
    await Zotero.Items.trashTx(toDelete);
    Zotero.log(`[Zhutero] Removed ${toDelete.length} old annotations`);
  }
}

if (typeof module !== "undefined") {
  module.exports = { generateFramework, getItemFullText, parseLLMJson, createAnnotationsForFramework, removeZhuteroAnnotations };
}
