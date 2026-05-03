/**
 * Zhutero - Main plugin class for Zotero 7
 * Registers a sidebar tab with framework tree, mind map, and notes.
 */

/* globals Zotero, Components, Services, IOUtils, PathUtils, ChromeUtils */
/* globals chatCompletion, generateFramework, getItemFullText, parseLLMJson */
/* globals createAnnotationsForFramework, removeZhuteroAnnotations */
/* globals getFramework, saveFramework, getNotes, saveNote */
/* globals loadUserAnnotations, groupAnnotationsByNode */

class ZhuteroPlugin {
  constructor() {
    this.id = null;
    this.version = null;
    this.rootURI = null;
    this._tabId = "zhutero-tab";
    this._currentItemKey = null;
    this._framework = null;
    this._notes = [];
    this._activeView = "tree";
    this._userAnnotations = [];   // raw user annotations from PDF
    this._annotationsByNode = new Map(); // node.id -> annotations[]
    this._showAnnotations = true;
  }

  async init({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;

    await Zotero.initializationPromise;

    Zotero.PreferencePanes.register({
      pluginID: "zhutero@qinuoyang.com",
      src: rootURI + "content/preferences.xhtml",
      scripts: [rootURI + "content/prefs.js"],
      label: "Zhutero",
      defaultXUL: true,
    });

    await this._registerPane();
    Zotero.log("[Zhutero] Plugin initialized v" + version);
  }

  async _registerPane() {
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
      onRender: ({ body, item }) => this._renderPanel(body, item),
      onItemChange: ({ body, item }) => this._renderPanel(body, item),
    });
  }

  async _renderPanel(body, item) {
    try {
      if (!item) {
        body.innerHTML = `<div class="zt-empty">Select a PDF item to generate a reading framework.</div>`;
        return;
      }

      this._currentItemKey = item.key;
      this._panelBody = body;
      this._panelItem = item;

      try {
        const stored = await getFramework(item.key);
        this._framework = stored;
        this._notes = await getNotes(item.key);
      } catch (e) {
        this._framework = null;
        this._notes = [];
        Zotero.log("[Zhutero] Failed to load data: " + e.message, "warning");
      }

      try {
        this._userAnnotations = await loadUserAnnotations(item);
        this._annotationsByNode = groupAnnotationsByNode(this._framework, this._userAnnotations);
      } catch (e) {
        this._userAnnotations = [];
        this._annotationsByNode = new Map();
        Zotero.log("[Zhutero] Failed to load user annotations: " + e.message, "warning");
      }

      this._injectCSS(body);
      body.innerHTML = "";

    const container = body.ownerDocument.createElement("div");
    container.className = "zt-container";

    // ── Action bar (top) ──
    const actionBar = this._createActionBar(body.ownerDocument, item);
    container.appendChild(actionBar);

    // ── View toggle ──
    if (this._framework) {
      const viewBar = this._createViewToggle(body.ownerDocument);
      container.appendChild(viewBar);
    }

    // ── Content ──
    const content = body.ownerDocument.createElement("div");
    content.className = "zt-content";
    content.id = "zt-content";

    if (this._framework) {
      this._renderView(content, body.ownerDocument);
    } else {
      content.innerHTML = `<div class="zt-empty">
        <p>No framework yet.</p>
        <p>Click <strong>Generate</strong> to analyze this document.</p>
      </div>`;
    }

    container.appendChild(content);
    body.appendChild(container);
    } catch (e) {
      Zotero.log("[Zhutero] Render error: " + e.message, "error");
      body.innerHTML = `<div style="padding:16px;color:red;font-size:12px;">Zhutero error: ${e.message}</div>`;
    }
  }

  _injectCSS(body) {
    const doc = body.ownerDocument;
    if (doc.getElementById("zhutero-style")) return;
    const link = doc.createElement("link");
    link.id = "zhutero-style";
    link.rel = "stylesheet";
    link.href = this.rootURI + "content/zhutero.css";
    (doc.head || doc.documentElement).appendChild(link);
  }

  // ── Action Bar ──

  _createActionBar(doc, item) {
    const bar = doc.createElement("div");
    bar.className = "zt-action-bar";

    const genBtn = doc.createElement("button");
    genBtn.className = "zt-btn zt-btn-primary";
    genBtn.textContent = this._framework ? "Regenerate" : "Generate";
    genBtn.addEventListener("click", () => this._handleGenerate(doc, item, genBtn));

    const exportBtn = doc.createElement("button");
    exportBtn.className = "zt-btn";
    exportBtn.textContent = "Export to Note";
    if (!this._framework) exportBtn.disabled = true;
    exportBtn.addEventListener("click", () => this._handleExportToNote(doc, item, exportBtn));

    const createAnnBtn = doc.createElement("button");
    createAnnBtn.className = "zt-btn";
    createAnnBtn.textContent = "Create Annotations";
    createAnnBtn.title = "Create gray PDF highlights for the current framework";
    if (!this._framework) createAnnBtn.disabled = true;
    createAnnBtn.addEventListener("click", async () => {
      const original = createAnnBtn.textContent;
      createAnnBtn.disabled = true;
      try {
        createAnnBtn.textContent = "Cleaning old...";
        await removeZhuteroAnnotations(item);
        await createAnnotationsForFramework(
          this._framework, item,
          (msg) => { createAnnBtn.textContent = msg; }
        );
        createAnnBtn.textContent = "Saving...";
        await saveFramework(this._currentItemKey, this._framework);
        if (this._panelBody) await this._renderPanel(this._panelBody, item);
      } catch (e) {
        Zotero.log(`[Zhutero] Create annotations error: ${e.message}`, "error");
        createAnnBtn.textContent = "Failed";
        setTimeout(() => { createAnnBtn.textContent = original; createAnnBtn.disabled = false; }, 2000);
      }
    });

    const cleanBtn = doc.createElement("button");
    cleanBtn.className = "zt-btn";
    cleanBtn.textContent = "Clean Annotations";
    cleanBtn.title = "Remove all [Zhutero] annotations from PDF";
    cleanBtn.addEventListener("click", async () => {
      cleanBtn.textContent = "Cleaning...";
      await removeZhuteroAnnotations(item);
      cleanBtn.textContent = "Done!";
      setTimeout(() => { cleanBtn.textContent = "Clean Annotations"; }, 1500);
    });

    const exportJsonBtn = doc.createElement("button");
    exportJsonBtn.className = "zt-btn";
    exportJsonBtn.textContent = "Export JSON";
    exportJsonBtn.title = "Save framework + notes as JSON file";
    if (!this._framework) exportJsonBtn.disabled = true;
    exportJsonBtn.addEventListener("click", () => this._handleExportJson(doc, item, exportJsonBtn));

    const importJsonBtn = doc.createElement("button");
    importJsonBtn.className = "zt-btn";
    importJsonBtn.textContent = "Import JSON";
    importJsonBtn.title = "Load framework from JSON file";
    importJsonBtn.addEventListener("click", () => this._handleImportJson(doc, item, importJsonBtn));

    bar.appendChild(genBtn);
    bar.appendChild(createAnnBtn);
    bar.appendChild(exportBtn);
    bar.appendChild(cleanBtn);
    bar.appendChild(exportJsonBtn);
    bar.appendChild(importJsonBtn);
    return bar;
  }

  // ── View Toggle ──

  _createViewToggle(doc) {
    const bar = doc.createElement("div");
    bar.className = "zt-view-bar";

    const views = [
      { id: "tree", label: "Tree" },
      { id: "mindmap", label: "Mind Map" },
    ];

    views.forEach((v) => {
      const btn = doc.createElement("button");
      btn.className = `zt-view-btn ${this._activeView === v.id ? "zt-view-btn-active" : ""}`;
      btn.textContent = v.label;
      btn.addEventListener("click", () => {
        this._activeView = v.id;
        // Update toggle active state
        bar.querySelectorAll(".zt-view-btn").forEach((b) => b.classList.remove("zt-view-btn-active"));
        btn.classList.add("zt-view-btn-active");
        // Re-render content
        const content = doc.getElementById("zt-content");
        if (content) this._renderView(content, doc);
      });
      bar.appendChild(btn);
    });

    // Spacer + Annotations toggle
    if (this._userAnnotations.length > 0) {
      const spacer = doc.createElement("span");
      spacer.style.flex = "1";
      bar.appendChild(spacer);

      const annBtn = doc.createElement("button");
      annBtn.className = "zt-view-btn zt-ann-toggle";
      annBtn.textContent = this._showAnnotations
        ? `Hide Annotations (${this._userAnnotations.length})`
        : `Show Annotations (${this._userAnnotations.length})`;
      annBtn.title = "Show/hide your manual highlights and comments";
      annBtn.addEventListener("click", () => {
        this._showAnnotations = !this._showAnnotations;
        annBtn.textContent = this._showAnnotations
          ? `Hide Annotations (${this._userAnnotations.length})`
          : `Show Annotations (${this._userAnnotations.length})`;
        const content = doc.getElementById("zt-content");
        if (content) this._renderView(content, doc);
      });
      bar.appendChild(annBtn);
    }

    return bar;
  }

  _renderView(container, doc) {
    container.innerHTML = "";
    if (this._activeView === "mindmap") {
      this._renderMindMap(container, doc);
    } else {
      this._renderTree(container, doc);
    }
  }

  // ── Generate ──

  async _itemHasPdfAttachment(item) {
    if (item.isAttachment()) {
      return item.attachmentContentType === "application/pdf";
    }
    const ids = item.getAttachments();
    for (const aid of ids) {
      const att = Zotero.Items.get(aid);
      if (att?.attachmentContentType === "application/pdf") return true;
    }
    return false;
  }

  async _handleGenerate(doc, item, btn) {
    const originalText = btn.textContent;
    btn.textContent = "Generating...";
    btn.disabled = true;
    const tStart = Date.now();
    Zotero.debug(`[Zhutero] === Generate START item=${item.key} title="${item.getDisplayTitle?.()?.slice(0, 60) || ""}" ===`);

    try {
      btn.textContent = "Extracting text...";
      const t1 = Date.now();
      const fullText = await getItemFullText(item.id);
      Zotero.debug(`[Zhutero] Phase 1/4 text extracted in ${Date.now() - t1}ms (${fullText?.length || 0}c)`);
      if (!fullText || fullText.length < 100) {
        throw new Error("No text content found. Please index the document first.");
      }

      const t2 = Date.now();
      const { framework } = await generateFramework(
        fullText, chatCompletion,
        (msg) => { btn.textContent = msg; }
      );
      Zotero.debug(`[Zhutero] Phase 2/4 framework generated in ${Date.now() - t2}ms`);

      this._framework = framework;

      // PDF annotations: skip for non-PDF (EPUB) attachments
      const t3 = Date.now();
      const hasPdf = await this._itemHasPdfAttachment(item);
      if (hasPdf) {
        btn.textContent = "Cleaning old annotations...";
        await removeZhuteroAnnotations(item);
        await createAnnotationsForFramework(
          framework, item,
          (msg) => { btn.textContent = msg; }
        );
        Zotero.debug(`[Zhutero] Phase 3/4 annotations done in ${Date.now() - t3}ms`);
      } else {
        Zotero.debug(`[Zhutero] Phase 3/4 skipped (no PDF, EPUB-only)`);
      }

      const t4 = Date.now();
      btn.textContent = "Saving...";
      await saveFramework(this._currentItemKey, framework);
      Zotero.debug(`[Zhutero] Phase 4/4 saved in ${Date.now() - t4}ms`);

      Zotero.debug(`[Zhutero] === Generate DONE total ${Date.now() - tStart}ms ===`);

      // Full re-render to add view toggle
      if (this._panelBody) {
        await this._renderPanel(this._panelBody, item);
      }
    } catch (e) {
      Zotero.debug(`[Zhutero] === Generate FAILED after ${Date.now() - tStart}ms: ${e.message} ===`);
      Zotero.log(`[Zhutero] Error: ${e.message}\n${e.stack || ""}`, "error");
      const content = doc.getElementById("zt-content");
      if (content) content.innerHTML = `<div class="zt-error">${e.message}</div>`;
      btn.textContent = originalText;
    } finally {
      btn.disabled = false;
    }
  }

  // ── Tree View ──

  _renderTree(container, doc) {
    const fw = this._framework;
    if (!fw) return;

    const header = doc.createElement("div");
    header.className = "zt-fw-header";
    header.innerHTML = `
      <h3 class="zt-fw-title">${this._esc(fw.title || "Untitled")}</h3>
      ${fw.thesis ? `<p class="zt-fw-thesis">${this._esc(fw.thesis)}</p>` : ""}
    `;
    container.appendChild(header);

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

    const header = doc.createElement("div");
    header.className = "zt-tree-header";

    const toggle = doc.createElement("span");
    toggle.className = "zt-tree-toggle";
    toggle.textContent = hasChildren ? (collapsed ? "▶" : "▼") : " ";
    toggle.style.cursor = hasChildren ? "pointer" : "default";
    toggle.style.width = "16px";
    toggle.style.display = "inline-block";

    const label = doc.createElement("span");
    label.className = "zt-tree-label";
    label.textContent = node.label || "";
    if (node.annotationKey || node.page) {
      label.style.cursor = "pointer";
      label.addEventListener("click", () => this._navigateToNode(node));
    }

    const pageRef = doc.createElement("span");
    pageRef.className = "zt-tree-page";
    if (node.page) {
      pageRef.textContent = `p.${node.page}`;
      pageRef.addEventListener("click", () => this._navigateToNode(node));
    }

    const badge = doc.createElement("span");
    badge.className = `zt-badge zt-badge-${node.type || "other"}`;
    badge.textContent = node.type || "";

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

    const existingNote = this._notes.find((n) => n.node_id === node.id);
    if (existingNote) {
      const ind = doc.createElement("span");
      ind.className = "zt-note-indicator";
      ind.title = existingNote.content.slice(0, 100);
      ind.textContent = "💬";
      header.appendChild(ind);
    }

    el.appendChild(header);

    if (node.summary) {
      const summary = doc.createElement("p");
      summary.className = "zt-tree-summary";
      summary.textContent = node.summary;
      summary.style.marginLeft = `${depth * 16 + 20}px`;
      if (collapsed) summary.style.display = "none";
      el.appendChild(summary);
    }

    // User annotations attached to this node
    const userAnns = this._showAnnotations ? this._annotationsByNode.get(node.id) : null;
    if (userAnns?.length) {
      const annsEl = doc.createElement("div");
      annsEl.className = "zt-user-anns";
      annsEl.style.marginLeft = `${depth * 16 + 20}px`;
      if (collapsed) annsEl.style.display = "none";
      userAnns.forEach((ann) => {
        annsEl.appendChild(this._createAnnotationEl(ann, doc));
      });
      el.appendChild(annsEl);
    }

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
        const anns = el.querySelector(":scope > .zt-user-anns");
        if (anns) anns.style.display = collapsed ? "none" : "";
      });
    }

    return el;
  }

  _toggleNoteEditor(parentEl, node, doc) {
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

  // ── Mind Map View (zoomable + pannable) ──

  _renderMindMap(container, doc) {
    const fw = this._framework;
    if (!fw) return;

    // Zoom controls
    const controls = doc.createElement("div");
    controls.className = "zt-mm-controls";

    let scale = 0.8;
    let panX = 0, panY = 0;
    let isPanning = false;
    let startX, startY;

    const zoomIn = doc.createElement("button");
    zoomIn.className = "zt-btn zt-btn-sm";
    zoomIn.textContent = "+";
    zoomIn.title = "Zoom in";

    const zoomOut = doc.createElement("button");
    zoomOut.className = "zt-btn zt-btn-sm";
    zoomOut.textContent = "−";
    zoomOut.title = "Zoom out";

    const zoomReset = doc.createElement("button");
    zoomReset.className = "zt-btn zt-btn-sm";
    zoomReset.textContent = "Fit";
    zoomReset.title = "Reset zoom";

    const zoomLabel = doc.createElement("span");
    zoomLabel.className = "zt-mm-zoom-label";
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;

    controls.appendChild(zoomOut);
    controls.appendChild(zoomLabel);
    controls.appendChild(zoomIn);
    controls.appendChild(zoomReset);
    container.appendChild(controls);

    // Viewport (clips overflow, handles pan)
    const viewport = doc.createElement("div");
    viewport.className = "zt-mm-viewport";

    // Canvas (transforms with scale/translate)
    const canvas = doc.createElement("div");
    canvas.className = "zt-mm-canvas";

    function applyTransform() {
      canvas.style.transform = `translate(${panX}px, ${panY}px) scale(${scale})`;
      zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    }

    zoomIn.addEventListener("click", () => { scale = Math.min(scale + 0.15, 3); applyTransform(); });
    zoomOut.addEventListener("click", () => { scale = Math.max(scale - 0.15, 0.2); applyTransform(); });
    zoomReset.addEventListener("click", () => { scale = 0.8; panX = 0; panY = 0; applyTransform(); });

    // Mouse wheel zoom
    viewport.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -0.08 : 0.08;
      scale = Math.min(Math.max(scale + delta, 0.2), 3);
      applyTransform();
    });

    // Pan with mouse drag
    viewport.addEventListener("mousedown", (e) => {
      if (e.target.closest(".zt-mm-node")) return; // don't pan when clicking nodes
      isPanning = true;
      startX = e.clientX - panX;
      startY = e.clientY - panY;
      viewport.style.cursor = "grabbing";
    });

    viewport.addEventListener("mousemove", (e) => {
      if (!isPanning) return;
      panX = e.clientX - startX;
      panY = e.clientY - startY;
      applyTransform();
    });

    viewport.addEventListener("mouseup", () => { isPanning = false; viewport.style.cursor = "grab"; });
    viewport.addEventListener("mouseleave", () => { isPanning = false; viewport.style.cursor = "grab"; });

    // Build the mind map tree
    const root = doc.createElement("div");
    root.className = "zt-mm-root";

    const rootNode = doc.createElement("div");
    rootNode.className = "zt-mm-node zt-mm-depth-root";
    rootNode.textContent = fw.title || "Untitled";
    root.appendChild(rootNode);

    if (fw.children?.length) {
      const childrenEl = doc.createElement("div");
      childrenEl.className = "zt-mm-children";
      fw.children.forEach((child) => {
        childrenEl.appendChild(this._createMindMapNode(child, doc, 1));
      });
      root.appendChild(childrenEl);
    }

    canvas.appendChild(root);
    viewport.appendChild(canvas);
    container.appendChild(viewport);

    // Initial transform
    applyTransform();
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
    }

    if (node.annotationKey || node.page) {
      nodeEl.style.cursor = "pointer";
      nodeEl.addEventListener("click", (e) => {
        e.stopPropagation();
        this._navigateToNode(node);
      });
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

  // ── Import / Export Framework JSON ──

  async _handleExportJson(doc, item, btn) {
    if (!this._framework) return;
    const originalText = btn.textContent;
    btn.disabled = true;

    try {
      Zotero.debug("[Zhutero/Export] Opening file picker...");
      const titleSafe = (this._framework.title || item.getDisplayTitle?.() || "framework")
        .replace(/[^\w\s-]/g, "").replace(/\s+/g, "_").slice(0, 60);
      const filePath = await this._showFilePicker({
        title: "Export Zhutero Framework",
        mode: "save",
        defaultName: `zhutero_${titleSafe}.json`,
      });
      if (!filePath) {
        btn.disabled = false;
        return;
      }

      Zotero.debug(`[Zhutero/Export] Writing to ${filePath}`);
      const payload = {
        zhuteroVersion: this.version,
        exportedAt: new Date().toISOString(),
        sourceItemKey: this._currentItemKey,
        sourceItemTitle: item.getDisplayTitle?.() || null,
        framework: this._framework,
        notes: this._notes || [],
      };
      await IOUtils.writeUTF8(filePath, JSON.stringify(payload, null, 2));

      btn.textContent = "Exported!";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
    } catch (e) {
      Zotero.log(`[Zhutero] Export JSON error: ${e.message}\n${e.stack || ""}`, "error");
      btn.textContent = "Export failed";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    }
  }

  /**
   * Cross-version file picker. Returns the selected file path string, or
   * null if the user cancelled. Tries multiple init signatures to handle
   * Zotero on Firefox 115+ (BrowsingContext) and earlier.
   */
  async _showFilePicker({ title, mode, defaultName }) {
    const win = Zotero.getMainWindow();
    const FP = Components.interfaces.nsIFilePicker;
    const fp = Components.classes["@mozilla.org/filepicker;1"].createInstance(FP);
    const modeConst = mode === "save" ? FP.modeSave : FP.modeOpen;

    // Modern (Firefox 115+) requires BrowsingContext; older accepts Window.
    let initOk = false;
    const initTargets = [win.browsingContext, win].filter(Boolean);
    let lastErr = null;
    for (const target of initTargets) {
      try {
        fp.init(target, title, modeConst);
        initOk = true;
        break;
      } catch (e) {
        lastErr = e;
        Zotero.debug(`[Zhutero/Export] fp.init failed with target type ${typeof target}: ${e.message}`);
      }
    }
    if (!initOk) throw new Error(`File picker init failed: ${lastErr?.message || "unknown"}`);

    fp.appendFilter("JSON files", "*.json");
    if (defaultName) fp.defaultString = defaultName;

    // open() may take a callback (older) or return a Promise (newer).
    const rv = await new Promise((resolve, reject) => {
      try {
        const maybePromise = fp.open(resolve);
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.then(resolve, reject);
        }
      } catch (e) {
        reject(e);
      }
    });

    if (rv !== FP.returnOK && rv !== FP.returnReplace) return null;
    return fp.file?.path || null;
  }

  async _handleImportJson(doc, item, btn) {
    const originalText = btn.textContent;
    btn.disabled = true;

    try {
      Zotero.debug("[Zhutero/Import] Opening file picker...");
      const filePath = await this._showFilePicker({
        title: "Import Zhutero Framework",
        mode: "open",
      });
      if (!filePath) {
        btn.disabled = false;
        return;
      }

      const raw = await IOUtils.readUTF8(filePath);
      const payload = JSON.parse(raw);
      const framework = payload.framework || payload;
      if (!framework || typeof framework !== "object" || !framework.children) {
        throw new Error("Invalid framework JSON: missing 'children' array");
      }

      // Confirm if existing framework will be overwritten
      if (this._framework) {
        const win = Zotero.getMainWindow();
        const ok = Services.prompt.confirm(
          win, "Replace existing framework?",
          "This item already has a framework. Importing will replace it and rebuild PDF annotations. Continue?"
        );
        if (!ok) { btn.disabled = false; btn.textContent = originalText; return; }
      }

      this._framework = framework;

      btn.textContent = "Saving...";
      await saveFramework(this._currentItemKey, framework);

      const hasPdf = await this._itemHasPdfAttachment(item);
      if (hasPdf) {
        btn.textContent = "Annotating...";
        await removeZhuteroAnnotations(item);
        await createAnnotationsForFramework(framework, item);
      }

      if (this._panelBody) {
        await this._renderPanel(this._panelBody, item);
      }

      btn.textContent = "Imported!";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
    } catch (e) {
      Zotero.log(`[Zhutero] Import JSON error: ${e.message}\n${e.stack || ""}`, "error");
      btn.textContent = "Import failed";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    }
  }

  // ── Export to Zotero Note (Better Notes compatible) ──

  async _handleExportToNote(doc, item, btn) {
    if (!this._framework) return;

    const originalText = btn.textContent;
    btn.textContent = "Exporting...";
    btn.disabled = true;

    try {
      let parentItem = item;
      if (item.isAttachment() && item.parentItemID) {
        parentItem = Zotero.Items.get(item.parentItemID);
      }

      let pdfAttachment = null;
      if (item.isAttachment() && item.attachmentContentType === "application/pdf") {
        pdfAttachment = item;
      } else {
        const attachmentIDs = parentItem.getAttachments();
        for (const aid of attachmentIDs) {
          const att = Zotero.Items.get(aid);
          if (att.attachmentContentType === "application/pdf") {
            pdfAttachment = att; break;
          }
        }
      }

      const html = this._frameworkToHTML(this._framework, pdfAttachment, parentItem);
      const noteItem = new Zotero.Item("note");
      noteItem.parentID = parentItem.id;
      noteItem.libraryID = parentItem.libraryID;
      noteItem.setNote(html);
      await noteItem.saveTx();

      btn.textContent = "Exported!";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
    } catch (e) {
      Zotero.log(`[Zhutero] Export error: ${e.message}`, "error");
      btn.textContent = "Export failed";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 2000);
    }
  }

  _frameworkToHTML(fw, pdfAttachment, parentItem) {
    const pdfKey = pdfAttachment?.key;
    let html = `<div data-schema-version="9">`;
    html += `<h1>${this._esc(fw.title || "Reading Framework")}</h1>\n`;
    if (fw.thesis) html += `<blockquote><p>${this._esc(fw.thesis)}</p></blockquote>\n`;
    html += `<p><em>Generated by Zhutero on ${new Date().toLocaleDateString()}</em></p>\n<hr/>\n`;
    if (fw.children) fw.children.forEach((c) => { html += this._nodeToHTML(c, 2, pdfKey); });
    if (this._notes?.length) {
      html += `<hr/>\n<h2>Notes</h2>\n`;
      this._notes.forEach((n) => {
        const l = this._findNodeLabel(fw, n.node_id);
        html += `<h3>${this._esc(l || n.node_id)}</h3>\n<p>${this._esc(n.content)}</p>\n`;
      });
    }
    html += `</div>`;
    return html;
  }

  _nodeToHTML(node, hl, pdfKey) {
    hl = Math.min(hl, 6);
    let pageLink = "";
    if (node.page && pdfKey) {
      pageLink = ` <a href="zotero://open-pdf/library/items/${pdfKey}?page=${node.page}">(p.${node.page})</a>`;
    } else if (node.page) {
      pageLink = ` (p.${node.page})`;
    }
    let html = `<h${hl}>${this._esc(node.label || "")}${pageLink}</h${hl}>\n`;
    if (node.summary) html += `<p>${this._esc(node.summary)}</p>\n`;
    if (node.quotes?.length) {
      node.quotes.forEach((q) => {
        let ql = q.page && pdfKey ? ` <a href="zotero://open-pdf/library/items/${pdfKey}?page=${q.page}">(p.${q.page})</a>` : "";
        html += `<blockquote><p>${this._esc(q.text)}${ql}</p></blockquote>\n`;
      });
    }
    if (node.children?.length) {
      if (hl >= 6) {
        html += `<ul>\n`;
        node.children.forEach((c) => { html += this._nodeToListHTML(c, pdfKey); });
        html += `</ul>\n`;
      } else {
        node.children.forEach((c) => { html += this._nodeToHTML(c, hl + 1, pdfKey); });
      }
    }
    return html;
  }

  _nodeToListHTML(node, pdfKey) {
    let pl = node.page && pdfKey ? ` <a href="zotero://open-pdf/library/items/${pdfKey}?page=${node.page}">(p.${node.page})</a>` : "";
    let html = `<li><strong>${this._esc(node.label || "")}</strong>${pl}`;
    if (node.summary) html += ` — ${this._esc(node.summary)}`;
    if (node.children?.length) {
      html += `\n<ul>\n`;
      node.children.forEach((c) => { html += this._nodeToListHTML(c, pdfKey); });
      html += `</ul>\n`;
    }
    return html + `</li>\n`;
  }

  _findNodeLabel(fw, nodeId) {
    function s(n) { if (n.id === nodeId) return n.label; if (n.children) for (const c of n.children) { const r = s(c); if (r) return r; } return null; }
    if (fw.children) for (const c of fw.children) { const r = s(c); if (r) return r; }
    return null;
  }

  // ── Navigation ──

  _createAnnotationEl(ann, doc) {
    const wrap = doc.createElement("div");
    wrap.className = "zt-user-ann";
    wrap.style.borderLeftColor = ann.color;
    wrap.title = `Page ${ann.pageIndex + 1} — click to open`;

    if (ann.text) {
      const text = doc.createElement("div");
      text.className = "zt-user-ann-text";
      text.textContent = ann.text;
      wrap.appendChild(text);
    }
    if (ann.comment) {
      const comm = doc.createElement("div");
      comm.className = "zt-user-ann-comment";
      comm.textContent = ann.comment;
      wrap.appendChild(comm);
    }

    wrap.addEventListener("click", () => this._navigateToAnnotation(ann));
    return wrap;
  }

  async _navigateToAnnotation(ann) {
    try {
      let reader;
      try { reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID); } catch (e) {}
      if (!reader && Zotero.Reader._readers?.length) {
        reader = Zotero.Reader._readers[0];
      }
      if (!reader) return;

      const annItem = Zotero.Items.get(ann.itemId);
      if (annItem) {
        const pos = JSON.parse(annItem.annotationPosition || "{}");
        if (pos.pageIndex != null && pos.rects?.length) {
          reader.navigate({ position: pos });
          return;
        }
      }
      reader.navigate({ pageIndex: ann.pageIndex });
    } catch (e) {
      Zotero.log(`[Zhutero] Navigate annotation error: ${e.message}`, "warning");
    }
  }

  async _navigateToNode(node) {
    if (!node.page) return;

    try {
      let reader;
      try { reader = Zotero.Reader.getByTabID(Zotero_Tabs.selectedID); } catch (e) {}
      if (!reader && Zotero.Reader._readers?.length) {
        reader = Zotero.Reader._readers[0];
      }

      if (!reader) return;

      const pageIndex = node.page - 1;

      // Try to find precise text position using reader's internal pdf.js
      const searchText = node.quotes?.[0]?.text || node.label || "";
      if (searchText) {
        try {
          const position = await this._findTextPosition(reader, pageIndex, searchText);
          if (position) {
            // navigate({ position }) scrolls to the rects AND flashes a 2-sec highlight
            reader.navigate({ position });
            return;
          }
        } catch (e) {
          Zotero.log("[Zhutero] Text position search failed: " + e.message, "warning");
        }
      }

      // Fallback: just jump to the page
      reader.navigate({ pageIndex });
    } catch (e) {
      Zotero.log(`[Zhutero] Navigate error: ${e.message}`, "warning");
    }
  }

  /**
   * Find the precise position (rects) of text on a PDF page using
   * the reader's internal pdf.js character data.
   */
  async _findTextPosition(reader, pageIndex, searchText) {
    // Access the reader's internal pdf.js via iframe
    const iframeWin = reader._iframeWindow;
    if (!iframeWin) return null;

    const internalReader = iframeWin.wrappedJSObject?._reader
      || iframeWin._reader;
    if (!internalReader) return null;

    const pdfView = internalReader._primaryView || internalReader._lastView;
    if (!pdfView) return null;

    // Get page character data from pdf.js
    let pageData;
    try {
      const pdfApp = pdfView._iframeWindow?.PDFViewerApplication
        || pdfView._iframeWindow?.wrappedJSObject?.PDFViewerApplication;
      if (!pdfApp?.pdfDocument) return null;
      pageData = await pdfApp.pdfDocument.getPageData({ pageIndex });
    } catch (e) {
      return null;
    }

    if (!pageData?.chars?.length) return null;
    const chars = pageData.chars;

    // Build page text from chars
    let text = "";
    const charOffsets = []; // maps text offset -> char index
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const ch = c.u || c.c || "";
      charOffsets.push(i);
      text += ch;
      if (c.spaceAfter || c.lineBreakAfter || c.paragraphBreakAfter) {
        text += " ";
        // space doesn't map to a char, but we track it
        charOffsets.push(i);
      }
    }

    // Search for the text (use first 100 chars for matching)
    const needle = searchText.slice(0, 100);
    let idx = text.indexOf(needle);
    if (idx < 0) idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) return null;

    // Map text offsets back to char indices
    const startCharIdx = charOffsets[idx] || 0;
    const endCharIdx = charOffsets[Math.min(idx + needle.length - 1, charOffsets.length - 1)] || startCharIdx;

    // Build rects grouped by line
    const rects = [];
    let lineRect = null;
    const Y_TOL = 3;

    for (let i = startCharIdx; i <= endCharIdx && i < chars.length; i++) {
      const r = chars[i].rect || chars[i].inlineRect;
      if (!r) continue;

      if (!lineRect) {
        lineRect = [r[0], r[1], r[2], r[3]];
      } else if (Math.abs(r[1] - lineRect[1]) < Y_TOL) {
        // Same line
        lineRect[0] = Math.min(lineRect[0], r[0]);
        lineRect[1] = Math.min(lineRect[1], r[1]);
        lineRect[2] = Math.max(lineRect[2], r[2]);
        lineRect[3] = Math.max(lineRect[3], r[3]);
      } else {
        rects.push([...lineRect]);
        lineRect = [r[0], r[1], r[2], r[3]];
      }
    }
    if (lineRect) rects.push(lineRect);

    if (rects.length === 0) return null;

    return { pageIndex, rects };
  }

  // ── Utilities ──

  _esc(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  destroy() {
    try { Zotero.ItemPaneManager.unregisterSection(this._tabId); } catch (e) {}
    Zotero.log("[Zhutero] Plugin destroyed");
  }
}
