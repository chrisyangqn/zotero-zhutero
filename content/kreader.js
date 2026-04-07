/**
 * KReader - Main plugin class for Zotero 7
 * Registers a sidebar tab with framework tree, mind map, and notes.
 */

/* globals Zotero, Components, Services, IOUtils, PathUtils, ChromeUtils */

class KReaderPlugin {
  constructor() {
    this.id = null;
    this.version = null;
    this.rootURI = null;
    this._tabId = "kreader-tab";
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
      label: "KReader",
      image: rootURI + "content/icons/icon16.png",
    });

    Zotero.log("[KReader] Plugin initialized v" + version);
  }

  async _registerPane() {
    // Zotero 7 item pane section API
    Zotero.ItemPaneManager.registerSection({
      paneID: this._tabId,
      pluginID: this.id,
      header: {
        l10nID: "kreader-tab-label",
        icon: this.rootURI + "content/icons/icon16.png",
      },
      sidenav: {
        l10nID: "kreader-tab-label",
        icon: this.rootURI + "content/icons/icon16.png",
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
      body.innerHTML = `<div class="kr-empty">Select a PDF item to generate a reading framework.</div>`;
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
    container.className = "kr-container";

    // Toolbar
    const toolbar = this._createToolbar(body.ownerDocument, item);
    container.appendChild(toolbar);

    // Content area
    const content = body.ownerDocument.createElement("div");
    content.className = "kr-content";
    content.id = "kr-content";

    if (this._framework) {
      this._renderFramework(content, body.ownerDocument);
    } else {
      content.innerHTML = `<div class="kr-empty">
        <p>No framework yet.</p>
        <p>Click <strong>Generate Framework</strong> to analyze this document.</p>
      </div>`;
    }

    container.appendChild(content);
    body.appendChild(container);
  }

  _injectCSS(body) {
    const doc = body.ownerDocument;
    const existingStyle = doc.getElementById("kreader-style");
    if (existingStyle) return;

    const link = doc.createElement("link");
    link.id = "kreader-style";
    link.rel = "stylesheet";
    link.href = this.rootURI + "content/kreader.css";
    (doc.head || doc.documentElement).appendChild(link);
  }

  _createToolbar(doc, item) {
    const toolbar = doc.createElement("div");
    toolbar.className = "kr-toolbar";

    // View toggle
    const viewToggle = doc.createElement("div");
    viewToggle.className = "kr-view-toggle";

    const treeBtn = doc.createElement("button");
    treeBtn.className = `kr-btn kr-btn-sm ${this._activeView === "tree" ? "kr-btn-active" : ""}`;
    treeBtn.textContent = "Tree";
    treeBtn.addEventListener("click", () => {
      this._activeView = "tree";
      const content = doc.getElementById("kr-content");
      if (content && this._framework) this._renderFramework(content, doc);
      viewToggle.querySelectorAll("button").forEach((b, i) => {
        b.className = `kr-btn kr-btn-sm ${i === 0 ? "kr-btn-active" : ""}`;
      });
    });

    const mmBtn = doc.createElement("button");
    mmBtn.className = `kr-btn kr-btn-sm ${this._activeView === "mindmap" ? "kr-btn-active" : ""}`;
    mmBtn.textContent = "Mind Map";
    mmBtn.addEventListener("click", () => {
      this._activeView = "mindmap";
      const content = doc.getElementById("kr-content");
      if (content && this._framework) this._renderFramework(content, doc);
      viewToggle.querySelectorAll("button").forEach((b, i) => {
        b.className = `kr-btn kr-btn-sm ${i === 1 ? "kr-btn-active" : ""}`;
      });
    });

    viewToggle.appendChild(treeBtn);
    viewToggle.appendChild(mmBtn);

    // Generate button
    const genBtn = doc.createElement("button");
    genBtn.className = "kr-btn kr-btn-primary";
    genBtn.textContent = this._framework ? "Regenerate" : "Generate Framework";
    genBtn.addEventListener("click", () => this._handleGenerate(doc, item, genBtn));

    toolbar.appendChild(viewToggle);
    toolbar.appendChild(genBtn);

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

      const content = doc.getElementById("kr-content");
      if (content) this._renderFramework(content, doc);

      btn.textContent = "Regenerate";
    } catch (e) {
      Zotero.log(`[KReader] Error: ${e.message}`, "error");
      const content = doc.getElementById("kr-content");
      if (content) {
        content.innerHTML = `<div class="kr-error">${e.message}</div>`;
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
    header.className = "kr-fw-header";
    header.innerHTML = `
      <h3 class="kr-fw-title">${this._esc(fw.title || "Untitled")}</h3>
      ${fw.thesis ? `<p class="kr-fw-thesis">${this._esc(fw.thesis)}</p>` : ""}
    `;
    container.appendChild(header);

    // Tree nodes
    const tree = doc.createElement("div");
    tree.className = "kr-tree";
    if (fw.children) {
      fw.children.forEach((child) => {
        tree.appendChild(this._createTreeNode(child, doc, 0));
      });
    }
    container.appendChild(tree);
  }

  _createTreeNode(node, doc, depth) {
    const el = doc.createElement("div");
    el.className = "kr-tree-node";
    el.style.marginLeft = `${depth * 16}px`;

    const hasChildren = node.children?.length > 0;
    let collapsed = depth > 1;

    // Header row
    const header = doc.createElement("div");
    header.className = "kr-tree-header";

    // Toggle
    const toggle = doc.createElement("span");
    toggle.className = "kr-tree-toggle";
    toggle.textContent = hasChildren ? (collapsed ? "▶" : "▼") : " ";
    toggle.style.cursor = hasChildren ? "pointer" : "default";
    toggle.style.width = "16px";
    toggle.style.display = "inline-block";

    // Label
    const label = doc.createElement("span");
    label.className = "kr-tree-label";
    label.textContent = node.label || "";
    if (node.page) {
      label.style.cursor = "pointer";
      label.addEventListener("click", () => this._navigateToPage(node.page));
    }

    // Page ref
    const pageRef = doc.createElement("span");
    pageRef.className = "kr-tree-page";
    if (node.page) {
      pageRef.textContent = `p.${node.page}`;
      pageRef.addEventListener("click", () => this._navigateToPage(node.page));
    }

    // Type badge
    const badge = doc.createElement("span");
    badge.className = `kr-badge kr-badge-${node.type || "other"}`;
    badge.textContent = node.type || "";

    // Note button
    const noteBtn = doc.createElement("span");
    noteBtn.className = "kr-tree-action";
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
      noteIndicator.className = "kr-note-indicator";
      noteIndicator.title = existingNote.content.slice(0, 100);
      noteIndicator.textContent = "💬";
      header.appendChild(noteIndicator);
    }

    el.appendChild(header);

    // Summary
    if (node.summary) {
      const summary = doc.createElement("p");
      summary.className = "kr-tree-summary";
      summary.textContent = node.summary;
      summary.style.marginLeft = `${depth * 16 + 20}px`;
      if (collapsed) summary.style.display = "none";
      el.appendChild(summary);
    }

    // Children container
    if (hasChildren) {
      const childrenEl = doc.createElement("div");
      childrenEl.className = "kr-tree-children";
      if (collapsed) childrenEl.style.display = "none";
      node.children.forEach((child) => {
        childrenEl.appendChild(this._createTreeNode(child, doc, depth + 1));
      });
      el.appendChild(childrenEl);

      toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        toggle.textContent = collapsed ? "▶" : "▼";
        childrenEl.style.display = collapsed ? "none" : "";
        const sum = el.querySelector(":scope > .kr-tree-summary");
        if (sum) sum.style.display = collapsed ? "none" : "";
      });
    }

    return el;
  }

  _toggleNoteEditor(parentEl, node, doc) {
    // Remove existing editor if any
    const existing = parentEl.querySelector(".kr-note-editor");
    if (existing) { existing.remove(); return; }

    const noteData = this._notes.find((n) => n.node_id === node.id);

    const editor = doc.createElement("div");
    editor.className = "kr-note-editor";

    const textarea = doc.createElement("textarea");
    textarea.className = "kr-note-textarea";
    textarea.value = noteData?.content || "";
    textarea.placeholder = "Write your notes here...";
    textarea.rows = 4;

    const actions = doc.createElement("div");
    actions.className = "kr-note-actions";

    const saveBtn = doc.createElement("button");
    saveBtn.className = "kr-btn kr-btn-sm kr-btn-primary";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", async () => {
      await saveNote(this._currentItemKey, node.id, textarea.value);
      this._notes = await getNotes(this._currentItemKey);
      editor.remove();
    });

    const cancelBtn = doc.createElement("button");
    cancelBtn.className = "kr-btn kr-btn-sm";
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
    mmContainer.className = "kr-mm-container";

    const root = doc.createElement("div");
    root.className = "kr-mm-root";

    // Root node
    const rootNode = doc.createElement("div");
    rootNode.className = "kr-mm-node kr-mm-depth-root";
    rootNode.textContent = fw.title || "Untitled";
    root.appendChild(rootNode);

    // Children
    if (fw.children?.length) {
      const childrenEl = doc.createElement("div");
      childrenEl.className = "kr-mm-children";
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
    branch.className = "kr-mm-branch";

    const nodeEl = doc.createElement("div");
    nodeEl.className = `kr-mm-node kr-mm-depth-${Math.min(depth, 3)}`;
    nodeEl.title = node.summary || "";

    const label = doc.createElement("span");
    label.className = "kr-mm-label";
    label.textContent = node.label || "";

    nodeEl.appendChild(label);

    if (node.page) {
      const page = doc.createElement("span");
      page.className = "kr-mm-page";
      page.textContent = `p.${node.page}`;
      nodeEl.appendChild(page);
      nodeEl.style.cursor = "pointer";
      nodeEl.addEventListener("click", () => this._navigateToPage(node.page));
    }

    branch.appendChild(nodeEl);

    if (node.children?.length) {
      const childrenEl = doc.createElement("div");
      childrenEl.className = "kr-mm-children";
      node.children.forEach((child) => {
        childrenEl.appendChild(this._createMindMapNode(child, doc, depth + 1));
      });
      branch.appendChild(childrenEl);
    }

    return branch;
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
      Zotero.log(`[KReader] Navigate error: ${e.message}`, "warning");
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
    Zotero.log("[KReader] Plugin destroyed");
  }
}
