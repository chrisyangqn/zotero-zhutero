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
- "page" must correspond to the marker number in the source text. Markers look like
  "=== PAGE N ===" (PDFs) or "=== CHAPTER N: <title> ===" (EPUBs). Use N either way.
- "quotes" text MUST be copied VERBATIM from the source — exact characters, exact spacing, exact punctuation
- For chapter/section headings, include the full heading line as a quote with type "heading"
- For arguments, include 1-2 key sentences as quotes with type "content"
- Hierarchy: chapters → arguments → sub-points
- Each node needs: id, label, type, page, summary, quotes, children
- Be thorough — capture all chapters/sections and key arguments
- Keep summaries concise (1-2 sentences)
- For academic papers: abstract → introduction → methodology → results → discussion → conclusion
- For books (EPUB): each top-level node is typically a chapter; arguments/subpoints map to sections inside chapters
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
// Conservative char threshold for a single LLM call. CJK content is denser
// (≈1 char/token), so we can't go close to the 200K-token API limit.
// 140K chars ≈ 140K tokens for Chinese, ≈ 35-50K tokens for English — both safe.
const SINGLE_CALL_CHAR_LIMIT = 140000;

const CHAPTER_PROMPT = `You are analyzing ONE chapter of a book or document. Generate a JSON node representing this single chapter and its sub-structure.

Return ONLY valid JSON in this shape (no array, no wrapper):
{
  "id": "c<N>",
  "label": "<chapter title>",
  "type": "chapter",
  "page": <chapter number>,
  "summary": "1-2 sentence summary of this chapter",
  "quotes": [
    { "page": <N>, "text": "EXACT heading from source", "type": "heading" }
  ],
  "children": [
    {
      "id": "c<N>s1",
      "label": "Subsection",
      "type": "argument",
      "page": <N>,
      "summary": "...",
      "quotes": [{ "page": <N>, "text": "EXACT verbatim sentence", "type": "content" }],
      "children": []
    }
  ]
}

Rules:
- "page" should be the CHAPTER NUMBER (the N in "=== CHAPTER N ===") for every node in this chapter
- quotes MUST be VERBATIM substrings of the input
- Capture the chapter's main arguments as children; nest sub-points if helpful
- Output MUST be valid JSON; escape inner quotes; no trailing commas
- Be concise — summaries 1-2 sentences each`;

async function generateFramework(fullText, chatCompletion, onProgress, onPartial) {
  Zotero.debug(`[Zhutero/FW] generateFramework: input=${fullText.length}c (limit ${SINGLE_CALL_CHAR_LIMIT})`);

  // If input is small enough, single call.
  if (fullText.length <= SINGLE_CALL_CHAR_LIMIT) {
    if (onProgress) onProgress("Sending to LLM...");
    const tLLM = Date.now();
    const { text, usage } = await chatCompletion(
      FRAMEWORK_PROMPT,
      `Generate a reading framework for this document. The text below has page numbers marked as "=== PAGE N ===".\n\n${fullText}`,
      { maxTokens: 16000 }
    );
    Zotero.debug(`[Zhutero/FW] LLM finished in ${Date.now() - tLLM}ms`);

    if (onProgress) onProgress("Parsing response...");
    const tParse = Date.now();
    const framework = parseLLMJson(text);
    Zotero.debug(`[Zhutero/FW] Parsed in ${Date.now() - tParse}ms nodes=${countNodes(framework)}`);
    return { framework, usage };
  }

  // Too big — must chunk. Try splitting by chapter markers (EPUB).
  const chunks = splitByChapter(fullText);
  if (!chunks.length) {
    throw new Error(
      `Document is too large (${fullText.length} chars) and has no chapter markers to split on. ` +
      `Reduce input or use a model with larger context.`
    );
  }
  Zotero.debug(`[Zhutero/FW] Chunked into ${chunks.length} chapters`);

  // Reject any individual chapter that itself exceeds the per-call budget.
  const tooBig = chunks.find(c => c.text.length > SINGLE_CALL_CHAR_LIMIT);
  if (tooBig) {
    throw new Error(
      `Chapter "${tooBig.title}" is too large (${tooBig.text.length} chars) for a single LLM call.`
    );
  }

  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  // Build framework incrementally so onPartial sees a snapshot after each chapter
  const framework = { title: "", thesis: "", children: [] };
  await processChapters(
    chunks, chatCompletion, onProgress, totalUsage,
    /* allChunks */ chunks,
    /* onChapterComplete */ async (node) => {
      // Insert in chapter-number order — chapters can complete out of
      // order with concurrency, but the framework should always be
      // ordered for the partial save / final result.
      framework.children.push(node);
      framework.children.sort((a, b) => (a.page || 0) - (b.page || 0));
      if (onPartial) {
        try { await onPartial(framework); }
        catch (e) { Zotero.log(`[Zhutero/FW] onPartial error (ignored): ${e.message}`, "warning"); }
      }
    }
  );

  Zotero.debug(`[Zhutero/FW] Merged framework nodes=${countNodes(framework)}`);
  return { framework, usage: totalUsage };
}

/**
 * Re-run only the failed chapters of an existing chunked framework.
 * Returns a new framework with succeeded chapters preserved verbatim and
 * failed ones replaced by a fresh LLM call (or kept if it fails again).
 */
async function regenerateFailedChapters(existingFramework, fullText, chatCompletion, onProgress, onPartial) {
  if (!existingFramework?.children?.length) {
    throw new Error("No existing framework to retry");
  }
  const allChunks = splitByChapter(fullText);
  if (!allChunks.length) {
    throw new Error("Cannot retry: source has no chapter markers");
  }

  const failedNums = new Set(
    existingFramework.children.filter(isFailedNode).map(n => n.page)
  );
  if (!failedNums.size) {
    Zotero.debug("[Zhutero/FW] regenerateFailed: no failed chapters");
    return { framework: existingFramework, usage: { input_tokens: 0, output_tokens: 0 } };
  }
  Zotero.debug(`[Zhutero/FW] regenerateFailed: ${failedNums.size} chapters to retry`);

  const failedChunks = allChunks.filter(c => failedNums.has(c.chapterNum));
  const totalUsage = { input_tokens: 0, output_tokens: 0 };
  const newByPage = new Map();
  // Live framework that gets re-snapshotted after each retried chapter
  const liveChildren = [...existingFramework.children];

  await processChapters(
    failedChunks, chatCompletion, onProgress, totalUsage, allChunks,
    async (node) => {
      newByPage.set(node.page, node);
      const idx = liveChildren.findIndex(n => n.page === node.page);
      if (idx >= 0) liveChildren[idx] = node;
      if (onPartial) {
        try {
          await onPartial({ ...existingFramework, children: [...liveChildren] });
        } catch (e) {
          Zotero.log(`[Zhutero/FW] onPartial error (ignored): ${e.message}`, "warning");
        }
      }
    }
  );

  return {
    framework: { ...existingFramework, children: liveChildren },
    usage: totalUsage,
  };
}

/**
 * Detect a failed-LLM placeholder node (created when chapter call errored).
 */
function isFailedNode(node) {
  return typeof node?.summary === "string" && node.summary.startsWith("(LLM failed");
}

function countFailedChapters(framework) {
  if (!framework?.children) return 0;
  return framework.children.filter(isFailedNode).length;
}

/**
 * Process a list of chapter chunks: pacing, LLM call per chunk, placeholder
 * for failures. Returns array of resulting nodes (one per input chunk, in
 * source order).
 *
 * `onProgress` receives a string like "Chapter 3/13...".
 * `progressContext` (the 5th arg) is the FULL chapter list so progress
 * counts can be relative to total chapters even when only retrying some.
 */
async function processChapters(chunks, chatCompletion, onProgress, totalUsage, allChunks, onChapterComplete) {
  // Pacing: keep request volume under the org's per-minute token budget.
  // Default Anthropic tier is 30K input tokens / minute. With CONCURRENCY > 1,
  // pacing is serialized via a mutex so concurrent workers can't both think
  // they have budget when they don't.
  const TOKENS_PER_MINUTE_BUDGET = 25000;
  // Run 2 chapters in parallel — most of each call's time is API latency
  // (~30s/chapter), so 2-way concurrency cuts wall-clock ~40% without
  // exceeding rate limits (pacing still serialized).
  const CONCURRENCY = 2;
  let tokensInWindow = 0;
  let windowStart = Date.now();
  let pacingMutex = Promise.resolve();

  function paceBeforeCall(estTokens) {
    // Chain through the mutex so only one worker checks/updates budget at a time
    pacingMutex = pacingMutex.then(async () => {
      const now = Date.now();
      if (now - windowStart > 60000) {
        tokensInWindow = 0;
        windowStart = now;
      }
      if (tokensInWindow + estTokens > TOKENS_PER_MINUTE_BUDGET) {
        const waitMs = 60000 - (now - windowStart) + 1000;
        if (waitMs > 0) {
          Zotero.debug(`[Zhutero/FW] Pacing: would exceed ${TOKENS_PER_MINUTE_BUDGET} tok/min, sleeping ${(waitMs / 1000).toFixed(1)}s`);
          await new Promise(r => setTimeout(r, waitMs));
          tokensInWindow = 0;
          windowStart = Date.now();
        }
      }
      tokensInWindow += estTokens;
    });
    return pacingMutex;
  }

  const total = allChunks.length;
  const indexInAll = new Map(allChunks.map((c, i) => [c.chapterNum, i + 1]));

  // Worker pool: each worker pulls the next un-claimed chunk index.
  let nextIdx = 0;
  const out = new Array(chunks.length);

  async function processOne(i) {
    const c = chunks[i];
    const display = indexInAll.get(c.chapterNum) ?? (i + 1);
    if (onProgress) onProgress(`Chapter ${display}/${total}...`);
    Zotero.debug(`[Zhutero/FW] Chapter ${display}/${total} "${c.title}" ${c.text.length}c`);

    await paceBeforeCall(c.text.length);

    const tCh = Date.now();
    try {
      const node = await callChapterWithRetry(c, chatCompletion, totalUsage);
      // Skeleton enforcement: TOC-derived title/page/id are authoritative
      node.label = c.title || node.label;
      node.page = c.chapterNum;
      node.id = `c${c.chapterNum}`;
      node.type = node.type || "chapter";
      out[i] = node;
      Zotero.debug(`[Zhutero/FW] Chapter ${display} done in ${Date.now() - tCh}ms`);
      if (onChapterComplete) await onChapterComplete(node);
    } catch (e) {
      Zotero.log(`[Zhutero/FW] Chapter ${display} "${c.title}" failed: ${e.message}`, "warning");
      const placeholder = {
        id: `c${c.chapterNum}`,
        label: c.title,
        type: "chapter",
        page: c.chapterNum,
        summary: `(LLM failed: ${e.message})`,
        quotes: [],
        children: [],
      };
      out[i] = placeholder;
      if (onChapterComplete) await onChapterComplete(placeholder);
    }
  }

  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= chunks.length) return;
      await processOne(i);
    }
  }

  const workers = Array(Math.min(CONCURRENCY, chunks.length))
    .fill(null)
    .map(() => worker());
  await Promise.all(workers);

  return out;
}

/**
 * Snapshot user-added data (userNote, userHighlights) from a framework
 * tree. Returns Map keyed by lowercased label so we can reapply after
 * regenerating, even if node IDs change.
 */
function snapshotUserData(framework) {
  const map = new Map();
  function walk(node) {
    const key = (node.label || "").trim().toLowerCase();
    if (key && (node.userNote || node.userHighlights?.length)) {
      map.set(key, {
        userNote: node.userNote || null,
        userHighlights: node.userHighlights ? [...node.userHighlights] : [],
      });
    }
    if (node.children) for (const c of node.children) walk(c);
  }
  if (framework?.children) for (const c of framework.children) walk(c);
  return map;
}

function applyUserData(framework, snapshot) {
  if (!snapshot || !snapshot.size) return framework;
  let applied = 0;
  function walk(node) {
    const key = (node.label || "").trim().toLowerCase();
    const data = snapshot.get(key);
    if (data) {
      if (data.userNote) node.userNote = data.userNote;
      if (data.userHighlights?.length) node.userHighlights = data.userHighlights;
      applied++;
    }
    if (node.children) for (const c of node.children) walk(c);
  }
  if (framework?.children) for (const c of framework.children) walk(c);
  Zotero.debug(`[Zhutero/FW] Reapplied user data to ${applied} nodes (snapshot had ${snapshot.size})`);
  return framework;
}

/**
 * Call the LLM for a single chapter, retrying once if the response is not
 * valid JSON. On retry we feed the parse error back so the model can fix it.
 */
async function callChapterWithRetry(chunk, chatCompletion, totalUsage) {
  let lastErr = null;
  let lastResponse = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let userMsg = chunk.text;
    if (attempt === 1 && lastErr && lastResponse) {
      userMsg =
        `Your previous response could not be parsed as JSON. Error: ${lastErr.message}\n\n` +
        `Your previous response started with:\n${lastResponse.slice(0, 300)}\n\n` +
        `Please reply with ONLY valid JSON for this chapter. No markdown fences, no commentary.\n\n` +
        chunk.text;
      Zotero.debug(`[Zhutero/FW] Chapter "${chunk.title}" retry with parse-error feedback`);
    }

    const { text, usage } = await chatCompletion(
      CHAPTER_PROMPT,
      userMsg,
      { maxTokens: 4000 }
    );
    totalUsage.input_tokens += usage?.input_tokens || 0;
    totalUsage.output_tokens += usage?.output_tokens || 0;
    lastResponse = text;

    try {
      const node = parseLLMJson(text);
      node.id = node.id || `c${chunk.chapterNum}`;
      node.page = chunk.chapterNum;
      return node;
    } catch (e) {
      lastErr = e;
      Zotero.debug(`[Zhutero/FW] Chapter "${chunk.title}" parse failed (attempt ${attempt + 1}): ${e.message}`);
    }
  }
  throw lastErr || new Error("Failed to parse chapter response");
}

/**
 * Split text on "=== CHAPTER N: title ===" markers. Returns
 * [{chapterNum, title, text}], where text includes the marker.
 */
function splitByChapter(fullText) {
  const re = /^=== CHAPTER (\d+): (.+?) ===$/gm;
  const matches = [...fullText.matchAll(re)];
  if (!matches.length) return [];
  const out = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
    out.push({
      chapterNum: parseInt(m[1], 10),
      title: m[2],
      text: fullText.slice(start, end).trim(),
    });
  }
  return out;
}

function countNodes(fw) {
  let n = 0;
  function walk(node) { n++; if (node.children) for (const c of node.children) walk(c); }
  if (fw?.children) for (const c of fw.children) walk(c);
  return n;
}

/**
 * Extract full text from a Zotero item with page markers.
 * Uses Zotero's built-in full-text index.
 * @param {number} itemID
 * @returns {Promise<string>}
 */
/**
 * Extract per-chapter text from an EPUB attachment with chapter markers.
 * Uses Zotero's internal EPUB.mjs module to walk spine items in reading order.
 * @param {Zotero.Item} attachment
 * @returns {Promise<string>}
 */
async function getEpubFullText(attachment) {
  const tStart = Date.now();
  const tPath = Date.now();
  const path = await attachment.getFilePathAsync();
  Zotero.debug(`[Zhutero/Text] EPUB getFilePath ${Date.now() - tPath}ms path=${path ? "ok" : "null"}`);
  if (!path) throw new Error("EPUB file not available locally");

  const { EPUB } = ChromeUtils.importESModule("chrome://zotero/content/EPUB.mjs");
  const epub = new EPUB(path);

  // Try to build href -> TOC label map for nicer chapter labels
  const tocLabels = new Map();
  try {
    const tocResult = await epub.getDocumentByReferenceType("toc");
    const tocDoc = tocResult?.doc;
    if (tocDoc) {
      // EPUB3 nav: <nav epub:type="toc"><ol><li><a href="..."> ... </a>
      const links = tocDoc.querySelectorAll("a[href]");
      for (const a of links) {
        const href = (a.getAttribute("href") || "").split("#")[0];
        const label = (a.textContent || "").trim();
        if (href && label && !tocLabels.has(href)) tocLabels.set(href, label);
      }
    }
  } catch (e) {
    Zotero.debug(`[Zhutero/Text] EPUB TOC parse failed: ${e.message}`);
  }

  let chapterCount = 0;
  let totalChars = 0;
  const chunks = [];
  try {
    for await (const { href, doc } of epub.getSectionDocuments()) {
      if (!doc?.body) continue;
      const text = (doc.body.innerText || doc.body.textContent || "").trim();
      if (!text) continue;
      chapterCount++;
      const baseHref = (href || "").split("#")[0].split("/").pop() || `chapter-${chapterCount}`;
      const label = tocLabels.get(baseHref)
        || tocLabels.get(href)
        || baseHref.replace(/\.x?html?$/i, "");
      chunks.push(`=== CHAPTER ${chapterCount}: ${label} ===\n${text}`);
      totalChars += text.length;
    }
  } finally {
    try { epub.close(); } catch (e) {}
  }

  Zotero.debug(`[Zhutero/Text] EPUB extracted ${chapterCount} chapters, ${totalChars}c in ${Date.now() - tStart}ms`);
  if (chapterCount === 0) throw new Error("No readable chapters found in EPUB");
  return chunks.join("\n\n");
}

async function getItemFullText(itemID) {
  Zotero.debug(`[Zhutero/Text] getItemFullText itemID=${itemID}`);
  const item = Zotero.Items.get(itemID);
  if (!item) throw new Error("Item not found");

  // If this is an attachment, use it directly; otherwise find PDF or EPUB
  let attachment = item;
  if (!item.isAttachment()) {
    const attachmentIDs = item.getAttachments();
    let pdfAtt = null, epubAtt = null;
    for (const aid of attachmentIDs) {
      const att = Zotero.Items.get(aid);
      const ct = att.attachmentContentType;
      if (ct === "application/pdf" && !pdfAtt) pdfAtt = att;
      else if (ct === "application/epub+zip" && !epubAtt) epubAtt = att;
    }
    attachment = pdfAtt || epubAtt;
  }

  if (!attachment?.isAttachment()) {
    throw new Error("No PDF or EPUB attachment found");
  }

  const ct = attachment.attachmentContentType;
  Zotero.debug(`[Zhutero/Text] Using attachment id=${attachment.id} key=${attachment.key} type=${ct}`);

  if (ct === "application/epub+zip") {
    return getEpubFullText(attachment);
  }

  // Per-page text extraction using Zotero.PDFWorker
  try {
    const tPath = Date.now();
    const pdfPath = await attachment.getFilePathAsync();
    Zotero.debug(`[Zhutero/Text] getFilePath ${Date.now() - tPath}ms path=${pdfPath ? "ok" : "null"}`);
    if (pdfPath) {
      const tRead = Date.now();
      const data = await IOUtils.read(pdfPath);
      Zotero.debug(`[Zhutero/Text] Read PDF ${Date.now() - tRead}ms size=${(data.byteLength / 1024).toFixed(0)}KB`);

      const tQuery = Date.now();
      const result = await Zotero.PDFWorker._query("getFullText", { buf: data.buffer }, [data.buffer]);
      Zotero.debug(`[Zhutero/Text] PDFWorker.getFullText ${Date.now() - tQuery}ms ` +
        `pages=${result?.pageTexts?.length ?? 0}`);

      if (result?.pageTexts && result.pageTexts.length > 0) {
        const pages = result.pageTexts.map((text, i) => `=== PAGE ${i + 1} ===\n${text}`);
        const joined = pages.join("\n\n");
        Zotero.debug(`[Zhutero/Text] Joined text length=${joined.length}c`);
        return joined;
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
async function createAnnotationsForFramework(framework, item, onProgress) {
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
    Zotero.debug("[Zhutero/Ann] Skipping annotation creation (no PDF attachment — EPUB or other type)");
    return framework;
  }

  // Determine max page actually referenced in framework — avoid scanning whole PDF
  let maxPage = 1;
  function findMaxPage(node) {
    if (node.page && node.page > maxPage) maxPage = node.page;
    if (node.quotes) {
      for (const q of node.quotes) if (q.page && q.page > maxPage) maxPage = q.page;
    }
    if (node.children) for (const c of node.children) findMaxPage(c);
  }
  if (framework.children) for (const c of framework.children) findMaxPage(c);

  Zotero.debug(`[Zhutero/Ann] createAnnotations: maxPage=${maxPage} attachment=${attachment.key}`);
  if (onProgress) onProgress("Reading PDF...");

  // Extract per-page character positions from PDF for precise highlighting
  let pageChars = [];
  try {
    const tRead = Date.now();
    const pdfPath = await attachment.getFilePathAsync();
    if (pdfPath) {
      const data = await IOUtils.read(pdfPath);
      Zotero.debug(`[Zhutero/Ann] PDF read ${Date.now() - tRead}ms size=${(data.byteLength / 1024).toFixed(0)}KB`);
      const tQuery = Date.now();
      const result = await Zotero.PDFWorker._query(
        "getFullText",
        { buf: data.buffer, maxPages: maxPage },
        [data.buffer]
      );
      Zotero.debug(`[Zhutero/Ann] PDFWorker chars ${Date.now() - tQuery}ms pages=${result?.pageChars?.length ?? 0}`);
      if (result?.pageChars) pageChars = result.pageChars;
    }
  } catch (e) {
    Zotero.log("[Zhutero] Could not extract page chars: " + e.message, "warning");
  }

  /**
   * Normalize text for fuzzy matching: collapse whitespace, lowercase,
   * keep only ascii letters/digits.
   */
  function normalize(s) {
    return (s || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9 ]/g, "");
  }

  /**
   * Build a flattened "normalized" page text plus an index map back to
   * the original char positions in pageChars[pageIndex]. Cached per page.
   */
  const pageIndexCache = new Map();
  function getNormalizedPage(pageIndex) {
    if (pageIndexCache.has(pageIndex)) return pageIndexCache.get(pageIndex);
    const chars = pageChars[pageIndex];
    if (!chars) { pageIndexCache.set(pageIndex, null); return null; }

    let normText = "";
    const map = []; // normText[i] -> chars index
    let lastWasSpace = true; // collapse leading space
    for (let i = 0; i < chars.length; i++) {
      const raw = chars[i].c || chars[i].char || chars[i].str || "";
      for (const ch of raw) {
        const lower = ch.toLowerCase();
        if (/\s/.test(lower)) {
          if (!lastWasSpace) { normText += " "; map.push(i); lastWasSpace = true; }
        } else if (/[a-z0-9]/.test(lower)) {
          normText += lower; map.push(i); lastWasSpace = false;
        }
        // skip punctuation/symbols — they often differ between LLM quote and PDF
      }
    }
    const result = { normText, map };
    pageIndexCache.set(pageIndex, result);
    return result;
  }

  /**
   * Find bounding rects for a text string on a given page using
   * fuzzy normalized matching. Tries progressively shorter prefixes.
   */
  function findTextRects(pageIndex, searchText) {
    if (!pageChars[pageIndex] || !searchText) return null;
    const page = getNormalizedPage(pageIndex);
    if (!page) return null;

    const needleFull = normalize(searchText);
    if (!needleFull) return null;

    // Try progressively shorter prefixes — LLM quotes often have minor
    // character drift partway through, but the start usually matches.
    const lengths = [needleFull.length, 60, 40, 25, 15];
    for (const len of lengths) {
      const needle = needleFull.slice(0, Math.min(len, needleFull.length));
      if (needle.length < 8) continue; // too short, false positives
      const idx = page.normText.indexOf(needle);
      if (idx >= 0) {
        const startCharIdx = page.map[idx];
        const endCharIdx = page.map[Math.min(idx + needle.length - 1, page.map.length - 1)];
        return buildRects(pageChars[pageIndex], startCharIdx, endCharIdx + 1);
      }
    }
    return null;
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

  // First pass: collect all (node, sortIdx, rects, highlightText) tuples
  const tasks = [];
  function collect(node, sortIdx) {
    if (node.page) {
      const pageIdx = node.page - 1;
      let highlightText = node.label || "";
      let rects = null;

      if (node.quotes?.length) {
        for (const q of node.quotes) {
          const qPage = (q.page || node.page) - 1;
          rects = findTextRects(qPage, q.text);
          if (rects) { highlightText = q.text; break; }
        }
      }
      if (!rects) rects = findTextRects(pageIdx, node.label);
      if (!rects) {
        const yPos = 700 - (sortIdx % 8) * 30;
        rects = [[72, yPos, 400, yPos + 12]];
      }
      tasks.push({ node, sortIdx, pageIdx, rects, highlightText });
    }
    if (node.children) {
      for (let i = 0; i < node.children.length; i++) {
        collect(node.children[i], sortIdx * 10 + i);
      }
    }
  }
  if (framework.children) {
    for (let i = 0; i < framework.children.length; i++) {
      collect(framework.children[i], i);
    }
  }

  const matched = tasks.filter(t => t.rects && t.rects[0][0] !== 72).length;
  Zotero.debug(`[Zhutero/Ann] Tasks=${tasks.length} matched=${matched} fallback=${tasks.length - matched}`);
  if (onProgress) onProgress(`Creating ${tasks.length} annotations...`);

  // Single batched transaction — much faster than per-node saveTx
  const tTx = Date.now();
  let saved = 0;
  try {
    await Zotero.DB.executeTransaction(async () => {
      for (const t of tasks) {
        try {
          const annotation = new Zotero.Item("annotation");
          annotation.parentID = attachment.id;
          annotation.libraryID = attachment.libraryID;
          annotation.annotationType = "highlight";
          annotation.annotationColor = "#aaaaaa";
          annotation.annotationText = t.highlightText;
          annotation.annotationComment =
            `[Zhutero] ${t.node.label || ""}\n\n${t.node.summary || ""}`;
          annotation.annotationPosition = JSON.stringify({
            pageIndex: t.pageIdx,
            rects: t.rects,
          });
          annotation.annotationSortIndex =
            String(t.node.page).padStart(5, "0") + "|" +
            String(t.sortIdx).padStart(6, "0") + "|00000";
          await annotation.save();
          t.node.annotationKey = annotation.key;
          saved++;
        } catch (e) {
          Zotero.log(`[Zhutero] Failed annotation "${t.node.label}": ${e.message}`, "warning");
        }
      }
    });
    Zotero.debug(`[Zhutero/Ann] Transaction ${Date.now() - tTx}ms saved=${saved}/${tasks.length}`);
  } catch (e) {
    Zotero.log(`[Zhutero] Transaction failed after ${Date.now() - tTx}ms: ${e.message}`, "error");
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
  module.exports = {
    generateFramework, regenerateFailedChapters,
    isFailedNode, countFailedChapters,
    snapshotUserData, applyUserData,
    getItemFullText, parseLLMJson,
    createAnnotationsForFramework, removeZhuteroAnnotations,
  };
}
