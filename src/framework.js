/**
 * Framework generation - ported from KReader, adapted for Zotero.
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
- For academic papers: abstract → introduction → methodology → results → discussion → conclusion`;

/**
 * Parse potentially malformed JSON from LLM output.
 */
function parseLLMJson(text) {
  // Extract from code fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  let jsonStr = fenceMatch ? fenceMatch[1].trim() : text.trim();

  // Fix common LLM JSON errors
  jsonStr = jsonStr
    .replace(/,\s*}/g, "}")
    .replace(/,\s*]/g, "]");

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Try to extract the largest valid JSON object
    const start = jsonStr.indexOf("{");
    if (start >= 0) {
      let depth = 0;
      let end = start;
      for (let i = start; i < jsonStr.length; i++) {
        if (jsonStr[i] === "{") depth++;
        if (jsonStr[i] === "}") depth--;
        if (depth === 0) { end = i + 1; break; }
      }
      return JSON.parse(jsonStr.slice(start, end));
    }
    throw new Error(`Failed to parse framework JSON: ${e.message}`);
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

  // Try Zotero's full-text index
  const content = await Zotero.Fulltext.getItemContent(attachment.id);
  if (content?.content) {
    // Full-text index doesn't have page markers, so we return as-is
    // For better results, we could use pdf.js to extract per-page
    return content.content;
  }

  // Fallback: try reading via pdf.js if available
  const path = await attachment.getFilePathAsync();
  if (!path) throw new Error("Cannot access PDF file");

  return await extractTextFromPDF(path);
}

/**
 * Extract text from PDF file with page markers using pdf.js.
 * Zotero 7 bundles pdf.js.
 */
async function extractTextFromPDF(pdfPath) {
  // Read the file
  const data = await IOUtils.read(pdfPath);

  // Use Zotero's bundled pdf.js
  const pdf = await Zotero.PDFWorker.getFullText(null, data);

  if (pdf?.text) {
    return pdf.text;
  }

  // Manual extraction with page markers
  const { getDocument } = ChromeUtils.importESModule(
    "chrome://zotero/content/xpcom/pdfjs/pdf.mjs"
  );

  const doc = await getDocument({ data }).promise;
  const pages = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => item.str).join(" ");
    pages.push(`=== PAGE ${i} ===\n${pageText}`);
  }

  return pages.join("\n\n");
}

if (typeof module !== "undefined") {
  module.exports = { generateFramework, getItemFullText, parseLLMJson };
}
