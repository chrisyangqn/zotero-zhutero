/**
 * Zhutero - Main plugin class for Zotero 7
 * Registers a sidebar tab with framework tree, mind map, and notes.
 */

/* globals Zotero, Components, Services, IOUtils, PathUtils, ChromeUtils */

class ZhuteroPlugin {
  constructor() {
    this.id = null;
    this.version = null;
    this.rootURI = null;
    this._tabId = "zhutero-tab";
    this._notifierID = null;
    this._currentItemKey = null;
    this._framework = null;
    this._notes = [];
    this._activeView = "tree"; // "tree" | "mindmap"
  }

  async init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    // Load sub-modules
    Services.scriptloader.loadSubScript(rootURI + "src/llm.js");
    Services.scriptloader.loadSubScript(rootURI + "src/framework.js");
    Services.scriptloader.loadSubScript(rootURI + "src/storage.js");

    // Register the item pane section (Zotero 7 API)
    await this._registerPane();

    // Register preferences pane
    Zotero.PreferencePanes.register({
      pluginID: id,
      src: rootURI + "content/preferences.xhtml",
      label: "Zhutero",
    });

    Zotero.log("[Zhutero] Plugin initialized v" + version);
  }

  async _registerPane() {
    // Zotero 7 item pane section API
    Zotero.ItemPaneManager.registerSection({
      paneID: this._tabId,
      pluginID: this.id,
      header: {
        l10nID: "zhutero-tab-label",
        icon: "chrome://zotero/skin/16/universal/book.svg",
      },
      sidenav: {
        l10nID: "zhutero-tab-label",
        icon: "chrome://zotero/skin/16/universal/book.svg",
      },
      // Called when the section needs to render
      onRender: ({ body, item }) => {
        this._renderPanel(body, item);
      },
      onItemChange: ({ body, item }) => {
        this._renderPanel(body, item);
      },
    });
  }

  async _renderPanel(body, item) {
    if (!item) {
      body.innerHTML = `<div class="zt-empty">Select a PDF item to generate a reading framework.</div>`;
      return;
    }

    const itemKey = item.key;
    this._currentItemKey = itemKey;

    // Load existing framework
    const stored = await getFramework(itemKey);
    this._framework = stored;
    this._notes = await getNotes(itemKey);

    // Load CSS
    this._injectCSS(body);

    // Build UI
    body.innerHTML = "";
    const container = body.ownerDocument.createXULElement("div") || body.ownerDocument.createElement("div");
    container.className = "zt-container";

    // Toolbar
    const toolbar = this._createToolbar(body.ownerDocument, item);
    container.appendChild(toolbar);

    // Content area
    const content = body.ownerDocument.createElement("div");
    content.className = "zt-content";
    content.id = "zt-content";

    if (this._framework) {
      this._renderFramework(content, body.ownerDocument);
    } else {
      content.innerHTML = `<div class="zt-empty">
        <p>No framework yet.</p>
        <p>Click <strong>Generate Framework</strong> to analyze this document.</p>
      </div>`;
    }

    container.appendChild(content);
    body.appendChild(container);
  }

  _injectCSS(body) {
    const doc = body.ownerDocument;
    const existingStyle = doc.getElementById("zhutero-style");
    if (existingStyle) return;

    const link = doc.createElement("link");
    link.id = "zhutero-style";
    link.rel = "stylesheet";
    link.href = this.rootURI + "content/zhutero.css";
    (doc.head || doc.documentElement).appendChild(link);
  }

  _createToolbar(doc, item) {
    const toolbar = doc.createElement("div");
    toolbar.className = "zt-toolbar";

    // View toggle
    const viewToggle = doc.createElement("div");
    viewToggle.className = "zt-view-toggle";

    const treeBtn = doc.createElement("button");
    treeBtn.className = `zt-btn zt-btn-sm ${this._activeView === "tree" ? "zt-btn-active" : ""}`;
    treeBtn.textContent = "Tree";
    treeBtn.addEventListener("click", () => {
      this._activeView = "tree";
      const content = doc.getElementById("zt-content");
      if (content && this._framework) this._renderFramework(content, doc);
      viewToggle.querySelectorAll("button").forEach((b, i) => {
        b.className = `zt-btn zt-btn-sm ${i === 0 ? "zt-btn-active" : ""}`;
      });
    });

    const mmBtn = doc.createElement("button");
    mmBtn.className = `zt-btn zt-btn-sm ${this._activeView === "mindmap" ? "zt-btn-active" : ""}`;
    mmBtn.textContent = "Mind Map";
    mmBtn.addEventListener("click", () => {
      this._activeView = "mindmap";
      const content = doc.getElementById("zt-content");
      if (content && this._framework) this._renderFramework(content, doc);
      viewToggle.querySelectorAll("button").forEach((b, i) => {
        b.className = `zt-btn zt-btn-sm ${i === 1 ? "zt-btn-active" : ""}`;
      });
    });

    viewToggle.appendChild(treeBtn);
    viewToggle.appendChild(mmBtn);

    // Generate button
    const genBtn = doc.createElement("button");
    genBtn.className = "zt-btn zt-btn-primary";
    genBtn.textContent = this._framework ? "Regenerate" : "Generate Framework";
    genBtn.addEventListener("click", () => this._handleGenerate(doc, item, genBtn));

    // Export to Zotero Note button (compatible with Better Notes)
    const exportBtn = doc.createElement("button");
    exportBtn.className = "zt-btn zt-btn-sm";
    exportBtn.textContent = "Export to Note";
    exportBtn.title = "Export framework as a Zotero note (works with Better Notes)";
    if (!this._framework) exportBtn.disabled = true;
    exportBtn.addEventListener("click", () => this._handleExportToNote(doc, item, exportBtn));

    toolbar.appendChild(viewToggle);

    const rightActions = doc.createElement("div");
    rightActions.className = "zt-toolbar-actions";
    rightActions.appendChild(exportBtn);
    rightActions.appendChild(genBtn);
    toolbar.appendChild(rightActions);

    return toolbar;
  }

  async _handleGenerate(doc, item, btn) {
    const originalText = btn.textContent;
    btn.textContent = "Generating...";
    btn.disabled = true;

    try {
      const fullText = await getItemFullText(item.id);
      if (!fullText || fullText.length < 100) {
        throw new Error("No text content found. Please index the PDF first (right-click → Reindex Item).");
      }

      const { framework } = await generateFramework(
        fullText,
        chatCompletion,
        (msg) => { btn.textContent = msg; }
      );

      this._framework = framework;
      await saveFramework(this._currentItemKey, framework);

      const content = doc.getElementById("zt-content");
      if (content) this._renderFramework(content, doc);

      btn.textContent = "Regenerate";
    } catch (e) {
      Zotero.log(`[Zhutero] Error: ${e.message}`, "error");
      const content = doc.getElementById("zt-content");
      if (content) {
        content.innerHTML = `<div class="zt-error">${e.message}</div>`;
      }
      btn.textContent = originalText;
    } finally {
      btn.disabled = false;
    }
  }

  _renderFramework(container, doc) {
    container.innerHTML = "";
    if (this._activeView === "tree") {
      this._renderTree(container, doc);
    } else {
      this._renderMindMap(container, doc);
    }
  }

  // ── Tree View ──

  _renderTree(container, doc) {
    const fw = this._framework;
    if (!fw) return;

    // Title & thesis
    const header = doc.createElement("div");
    header.className = "zt-fw-header";
    header.innerHTML = `
      <h3 class="zt-fw-title">${this._esc(fw.title || "Untitled")}</h3>
      ${fw.thesis ? `<p class="zt-fw-thesis">${this._esc(fw.thesis)}</p>` : ""}
    `;
    container.appendChild(header);

    // Tree nodes
    const tree = doc.createElement("div");
    tree.className = "zt-tree";
    if (fw.children) {
      fw.children.forEach((child) => {
        tree.appendChild(this._createTreeNode(child, doc, 0));
      });
    }
    container.appendChild(tree);
  }

  _createTreeNode(node, doc, depth) {
    const el = doc.createElement("div");
    el.className = "zt-tree-node";
    el.style.marginLeft = `${depth * 16}px`;

    const hasChildren = node.children?.length > 0;
    let collapsed = depth > 1;

    // Header row
    const header = doc.createElement("div");
    header.className = "zt-tree-header";

    // Toggle
    const toggle = doc.createElement("span");
    toggle.className = "zt-tree-toggle";
    toggle.textContent = hasChildren ? (collapsed ? "▶" : "▼") : " ";
    toggle.style.cursor = hasChildren ? "pointer" : "default";
    toggle.style.width = "16px";
    toggle.style.display = "inline-block";

    // Label
    const label = doc.createElement("span");
    label.className = "zt-tree-label";
    label.textContent = node.label || "";
    if (node.page) {
      label.style.cursor = "pointer";
      label.addEventListener("click", () => this._navigateToPage(node.page));
    }

    // Page ref
    const pageRef = doc.createElement("span");
    pageRef.className = "zt-tree-page";
    if (node.page) {
      pageRef.textContent = `p.${node.page}`;
      pageRef.addEventListener("click", () => this._navigateToPage(node.page));
    }

    // Type badge
    const badge = doc.createElement("span");
    badge.className = `zt-badge zt-badge-${node.type || "other"}`;
    badge.textContent = node.type || "";

    // Note button
    const noteBtn = doc.createElement("span");
    noteBtn.className = "zt-tree-action";
    noteBtn.textContent = "📝";
    noteBtn.title = "Add/edit note";
    noteBtn.addEventListener("click", () => this._toggleNoteEditor(el, node, doc));

    header.appendChild(toggle);
    header.appendChild(label);
    header.appendChild(pageRef);
    header.appendChild(badge);
    header.appendChild(noteBtn);

    // Check if note exists
    const existingNote = this._notes.find((n) => n.node_id === node.id);
    if (existingNote) {
      const noteIndicator = doc.createElement("span");
      noteIndicator.className = "zt-note-indicator";
      noteIndicator.title = existingNote.content.slice(0, 100);
      noteIndicator.textContent = "💬";
      header.appendChild(noteIndicator);
    }

    el.appendChild(header);

    // Summary
    if (node.summary) {
      const summary = doc.createElement("p");
      summary.className = "zt-tree-summary";
      summary.textContent = node.summary;
      summary.style.marginLeft = `${depth * 16 + 20}px`;
      if (collapsed) summary.style.display = "none";
      el.appendChild(summary);
    }

    // Children container
    if (hasChildren) {
      const childrenEl = doc.createElement("div");
      childrenEl.className = "zt-tree-children";
      if (collapsed) childrenEl.style.display = "none";
      node.children.forEach((child) => {
        childrenEl.appendChild(this._createTreeNode(child, doc, depth + 1));
      });
      el.appendChild(childrenEl);

      toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        toggle.textContent = collapsed ? "▶" : "▼";
        childrenEl.style.display = collapsed ? "none" : "";
        const sum = el.querySelector(":scope > .zt-tree-summary");
        if (sum) sum.style.display = collapsed ? "none" : "";
      });
    }

    return el;
  }

  _toggleNoteEditor(parentEl, node, doc) {
    // Remove existing editor if any
    const existing = parentEl.querySelector(".zt-note-editor");
    if (existing) { existing.remove(); return; }

    const noteData = this._notes.find((n) => n.node_id === node.id);

    const editor = doc.createElement("div");
    editor.className = "zt-note-editor";

    const textarea = doc.createElement("textarea");
    textarea.className = "zt-note-textarea";
    textarea.value = noteData?.content || "";
    textarea.placeholder = "Write your notes here...";
    textarea.rows = 4;

    const actions = doc.createElement("div");
    actions.className = "zt-note-actions";

    const saveBtn = doc.createElement("button");
    saveBtn.className = "zt-btn zt-btn-sm zt-btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      await saveNote(this._currentItemKey, node.id, textarea.value);
      this._notes = await getNotes(this._currentItemKey);
      editor.remove();
    });

    const cancelBtn = doc.createElement("button");
    cancelBtn.className = "zt-btn zt-btn-sm";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => editor.remove());

    actions.appendChild(saveBtn);
    actions.appendChild(cancelBtn);
    editor.appendChild(textarea);
    editor.appendChild(actions);
    parentEl.appendChild(editor);

    textarea.focus();
  }

  // ── Mind Map View ──

  _renderMindMap(container, doc) {
    const fw = this._framework;
    if (!fw) return;

    const mmContainer = doc.createElement("div");
    mmContainer.className = "zt-mm-container";

    const root = doc.createElement("div");
    root.className = "zt-mm-root";

    // Root node
    const rootNode = doc.createElement("div");
    rootNode.className = "zt-mm-node zt-mm-depth-root";
    rootNode.textContent = fw.title || "Untitled";
    root.appendChild(rootNode);

    // Children
    if (fw.children?.length) {
      const childrenEl = doc.createElement("div");
      childrenEl.className = "zt-mm-children";
      fw.children.forEach((child) => {
        childrenEl.appendChild(this._createMindMapNode(child, doc, 1));
      });
      root.appendChild(childrenEl);
    }

    mmContainer.appendChild(root);
    container.appendChild(mmContainer);

    // Center scroll
    requestAnimationFrame(() => {
      mmContainer.scrollLeft = (mmContainer.scrollWidth - mmContainer.clientWidth) / 2;
    });
  }

  _createMindMapNode(node, doc, depth) {
    const branch = doc.createElement("div");
    branch.className = "zt-mm-branch";

    const nodeEl = doc.createElement("div");
    nodeEl.className = `zt-mm-node zt-mm-depth-${Math.min(depth, 3)}`;
    nodeEl.title = node.summary || "";

    const label = doc.createElement("span");
    label.className = "zt-mm-label";
    label.textContent = node.label || "";

    nodeEl.appendChild(label);

    if (node.page) {
      const page = doc.createElement("span");
      page.className = "zt-mm-page";
      page.textContent = `p.${node.page}`;
      nodeEl.appendChild(page);
      nodeEl.style.cursor = "pointer";
      nodeEl.addEventListener("click", () => this._navigateToPage(node.page));
    }

    branch.appendChild(nodeEl);

    if (node.children?.length) {
      const childrenEl = doc.createElement("div");
      childrenEl.className = "zt-mm-children";
      node.children.forEach((child) => {
        childrenEl.appendChild(this._createMindMapNode(child, doc, depth + 1));
      });
      branch.appendChild(childrenEl);
    }

    return branch;
  }

  // ── Export to Zotero Note (Better Notes compatible) ──

  async _handleExportToNote(doc, item, btn) {
    if (!this._framework) return;

    const originalText = btn.textContent;
    btn.textContent = "Exporting...";
    btn.disabled = true;

    try {
      // Find the parent item (if item is an attachment, get its parent)
      let parentItem = item;
      if (item.isAttachment() && item.parentItemID) {
        parentItem = Zotero.Items.get(item.parentItemID);
      }

      // Find the PDF attachment for building zotero://open-pdf links
      let pdfAttachment = null;
      if (item.isAttachment() && item.attachmentContentType === "application/pdf") {
        pdfAttachment = item;
      } else {
        const attachmentIDs = parentItem.getAttachments();
        for (const aid of attachmentIDs) {
          const att = Zotero.Items.get(aid);
          if (att.attachmentContentType === "application/pdf") {
            pdfAttachment = att;
            break;
          }
        }
      }

      // Build HTML note content
      const html = this._frameworkToHTML(this._framework, pdfAttachment, parentItem);

      // Create a new Zotero note item
      const noteItem = new Zotero.Item("note");
      noteItem.parentID = parentItem.id;
      noteItem.libraryID = parentItem.libraryID;
      noteItem.setNote(html);
      await noteItem.saveTx();

      btn.textContent = "Exported!";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);

      Zotero.log(`[Zhutero] Framework exported as note for item ${parentItem.key}`);
    } catch (e) {
      Zotero.log(`[Zhutero] Export error: ${e.message}`, "error");
      btn.textContent = "Export failed";
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 2000);
    }
  }

  /**
   * Convert framework tree to structured HTML for Zotero notes.
   * Uses zotero://open-pdf links for page navigation.
   * Output format works natively with Better Notes' outline & template system.
   */
  _frameworkToHTML(fw, pdfAttachment, parentItem) {
    const libraryID = parentItem.libraryID;
    const pdfKey = pdfAttachment?.key;

    let html = `<div data-schema-version="9">`;

    // Title
    html += `<h1>${this._esc(fw.title || "Reading Framework")}</h1>\n`;

    // Thesis
    if (fw.thesis) {
      html += `<blockquote><p>${this._esc(fw.thesis)}</p></blockquote>\n`;
    }

    // Metadata line
    html += `<p><em>Generated by Zhutero on ${new Date().toLocaleDateString()}</em></p>\n`;
    html += `<hr/>\n`;

    // Render tree nodes as nested headings + lists
    if (fw.children) {
      fw.children.forEach((child) => {
        html += this._nodeToHTML(child, 2, pdfKey, libraryID);
      });
    }

    // Append Zhutero notes if any
    if (this._notes?.length > 0) {
      html += `<hr/>\n<h2>Notes</h2>\n`;
      this._notes.forEach((note) => {
        const nodeLabel = this._findNodeLabel(fw, note.node_id);
        html += `<h3>${this._esc(nodeLabel || note.node_id)}</h3>\n`;
        html += `<p>${this._esc(note.content)}</p>\n`;
      });
    }

    html += `</div>`;
    return html;
  }

  _nodeToHTML(node, headingLevel, pdfKey, libraryID) {
    let html = "";
    const hl = Math.min(headingLevel, 6);

    // Page link
    let pageLink = "";
    if (node.page && pdfKey) {
      const uri = `zotero://open-pdf/library/items/${pdfKey}?page=${node.page}`;
      pageLink = ` <a href="${uri}">(p.${node.page})</a>`;
    } else if (node.page) {
      pageLink = ` (p.${node.page})`;
    }

    // Node as heading
    html += `<h${hl}>${this._esc(node.label || "")}${pageLink}</h${hl}>\n`;

    // Summary as paragraph
    if (node.summary) {
      html += `<p>${this._esc(node.summary)}</p>\n`;
    }

    // Quotes as blockquotes
    if (node.quotes?.length) {
      node.quotes.forEach((q) => {
        let qLink = "";
        if (q.page && pdfKey) {
          const uri = `zotero://open-pdf/library/items/${pdfKey}?page=${q.page}`;
          qLink = ` <a href="${uri}">(p.${q.page})</a>`;
        }
        html += `<blockquote><p>${this._esc(q.text)}${qLink}</p></blockquote>\n`;
      });
    }

    // Children: if next level would exceed h6, use a list instead
    if (node.children?.length) {
      if (headingLevel >= 6) {
        html += `<ul>\n`;
        node.children.forEach((child) => {
          html += this._nodeToListHTML(child, pdfKey, libraryID);
        });
        html += `</ul>\n`;
      } else {
        node.children.forEach((child) => {
          html += this._nodeToHTML(child, headingLevel + 1, pdfKey, libraryID);
        });
      }
    }

    return html;
  }

  _nodeToListHTML(node, pdfKey, libraryID) {
    let pageLink = "";
    if (node.page && pdfKey) {
      const uri = `zotero://open-pdf/library/items/${pdfKey}?page=${node.page}`;
      pageLink = ` <a href="${uri}">(p.${node.page})</a>`;
    }

    let html = `<li><strong>${this._esc(node.label || "")}</strong>${pageLink}`;
    if (node.summary) {
      html += ` — ${this._esc(node.summary)}`;
    }

    if (node.children?.length) {
      html += `\n<ul>\n`;
      node.children.forEach((child) => {
        html += this._nodeToListHTML(child, pdfKey, libraryID);
      });
      html += `</ul>\n`;
    }

    html += `</li>\n`;
    return html;
  }

  _findNodeLabel(fw, nodeId) {
    function search(node) {
      if (node.id === nodeId) return node.label;
      if (node.children) {
        for (const child of node.children) {
          const result = search(child);
          if (result) return result;
        }
      }
      return null;
    }
    if (fw.children) {
      for (const child of fw.children) {
        const result = search(child);
        if (result) return result;
      }
    }
    return null;
  }

  // ── Navigation ──

  _navigateToPage(pageNum) {
    // Navigate Zotero's PDF reader to the specified page
    try {
      const reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID);
      if (reader) {
        reader.navigate({ pageIndex: pageNum - 1 });
      }
    } catch (e) {
      Zotero.log(`[Zhutero] Navigate error: ${e.message}`, "warning");
    }
  }

  // ── Utilities ──

  _esc(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  destroy() {
    try {
      Zotero.ItemPaneManager.unregisterSection(this._tabId);
    } catch (e) {}
    Zotero.log("[Zhutero] Plugin destroyed");
  }
}
