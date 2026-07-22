/**
 * Zhutero local HTTP write endpoint — create highlight annotations from POSTed JSON.
 *
 *   POST http://127.0.0.1:23119/zhutero/annotate
 *   Content-Type: application/json
 *   {
 *     "attachmentKey": "XS87W2HS",
 *     "libraryID": <optional, defaults to user library>,
 *     "annotations": [
 *       { "text": "...", "comment": "...", "color": "#5fb236",
 *         "sortIndex": "00002|00001233",
 *         "position": { ...PDF rects OR EPUB FragmentSelector CFI... } }
 *     ]
 *   }
 *   → 200 { "ok": true, "created": ["KEY1", ...], "errors": [] }
 *
 * Localhost-only (Zotero's own server). Mirrors the annotation-creation used by
 * createAnnotationsForFramework in src/framework.js.
 */
/* globals Zotero, module */

function registerZhuteroHttp() {
  if (!Zotero.Server || !Zotero.Server.Endpoints) {
    Zotero.debug("[Zhutero] Zotero.Server unavailable; HTTP endpoint not registered");
    return;
  }
  const EP = "/zhutero/annotate";
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    init: function (requestData) {
      return (async () => {
        try {
          const rd = requestData || {};
          const data = (rd.data !== undefined ? rd.data : rd) || {};
          const libraryID = data.libraryID || Zotero.Libraries.userLibraryID;
          const att = Zotero.Items.getByLibraryAndKey(libraryID, data.attachmentKey);
          if (!att) {
            return [400, "application/json", JSON.stringify({ ok: false, error: "attachment not found: " + data.attachmentKey })];
          }
          const list = Array.isArray(data.annotations) ? data.annotations : [];
          const created = [];
          const errors = [];
          await Zotero.DB.executeTransaction(async () => {
            for (const a of list) {
              try {
                const ann = new Zotero.Item("annotation");
                ann.parentID = att.id;
                ann.libraryID = att.libraryID;
                ann.annotationType = "highlight";
                ann.annotationColor = a.color || "#5fb236";
                if (a.text) ann.annotationText = a.text;
                if (a.comment) ann.annotationComment = a.comment;
                if (a.sortIndex) ann.annotationSortIndex = a.sortIndex;
                ann.annotationPosition = typeof a.position === "string"
                  ? a.position
                  : JSON.stringify(a.position || {});
                await ann.save();
                created.push(ann.key);
              } catch (e) {
                errors.push(String((e && e.message) || e));
              }
            }
          });
          return [200, "application/json", JSON.stringify({ ok: true, created, errors })];
        } catch (e) {
          return [500, "application/json", JSON.stringify({ ok: false, error: String((e && e.message) || e) })];
        }
      })();
    },
  };
  Zotero.Server.Endpoints[EP] = Endpoint;
  Zotero.debug("[Zhutero] HTTP endpoint registered: POST " + EP);

  registerZhuteroNav();
  registerZhuteroProtocol();
  registerZhuteroCollect();
  registerZhuteroAttach();
}

/**
 * Zhutero reader navigation endpoint — jump the EPUB/PDF reader to any location.
 *
 *   GET http://127.0.0.1:23119/zhutero/navigate?key=<attachmentKey>&href=<spineHref%23frag>
 *   (or &cfi=<epubcfi(...)>; POST JSON {key, href|cfi} also works)  → 200 "ok"
 *
 * Why a custom endpoint: Zotero's `zotero://open-pdf?location=` URI is ignored for arbitrary
 * positions (only ?annotation= works). Per zotero/reader's EPUBView.navigate(), the reliable
 * location form is `{ href: "<spine-relative href>#<fragment>" }` → _getHrefTarget → scrollIntoView
 * (a bare CFI element-path is "accepted but doesn't scroll"). So the journal's chapter links hit
 * THIS, firing it from a file:// page with `new Image().src = url` (a GET — no page nav, no CORS).
 */
function registerZhuteroNav() {
  if (!Zotero.Server || !Zotero.Server.Endpoints) return;
  const EP = "/zhutero/navigate";
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: ["GET", "POST"],
    supportedDataTypes: ["application/json", "application/x-www-form-urlencoded"],
    init: function (requestData) {
      return (async () => {
        try {
          const rd = requestData || {};
          // GET params live in requestData.searchParams (URLSearchParams); POST in rd.data.
          const sp = rd.searchParams;
          const data = (rd.data && typeof rd.data === "object") ? rd.data : {};
          const get = (k) => { let v = null; try { v = sp && sp.get(k); } catch (e) {} return (v != null && v !== "") ? v : data[k]; };
          const key = get("key") || get("attachmentKey");
          const href = get("href");
          const cfi = get("cfi");
          const libraryID = Number(get("libraryID")) || Zotero.Libraries.userLibraryID;
          if (!key) return [400, "text/plain", "missing key"];
          const att = Zotero.Items.getByLibraryAndKey(libraryID, key);
          if (!att) return [400, "text/plain", "attachment not found: " + key];
          await Zotero.Reader.open(att.id);
          const win = Zotero.getMainWindow();
          let reader = null;
          for (let i = 0; i < 40 && !reader; i++) {
            reader = (Zotero.Reader._readers || []).find((r) => r && r._item && r._item.key === att.key);
            if (!reader) await Zotero.Promise.delay(100);
          }
          if (!reader) return [200, "text/plain", "opened (no reader handle)"];
          try { if (win && win.Zotero_Tabs && reader.tabID) win.Zotero_Tabs.select(reader.tabID); } catch (e) {}
          try { if (reader._initPromise) await reader._initPromise; } catch (e) {}
          await Zotero.Promise.delay(200);
          if (href || cfi) {
            try { await reader.navigate(href ? { href } : { pageNumber: cfi }); }
            catch (e) { return [200, "text/plain", "naverr: " + String(e && e.message || e)]; }
          }
          return [200, "text/plain", "ok"];
        } catch (e) {
          return [500, "text/plain", String((e && e.message) || e)];
        }
      })();
    },
  };
  Zotero.Server.Endpoints[EP] = Endpoint;
  Zotero.debug("[Zhutero] HTTP endpoint registered: GET/POST " + EP);
}

/**
 * Custom zotero:// route so the file:// journal can drive the reader.  A file:// page can't reach
 * the localhost HTTP endpoint (Chrome/Firefox block file://→localhost), but it CAN follow a
 * zotero:// link via the OS protocol handler (same as a working annotation ↗). So chapter links use
 *   zotero://zhutero/navigate?key=<attachmentKey>&href=<spineHref%23frag>   (or &cfi=...)
 * and this extension navigates the open reader to that href. Registered into the protocol handler's
 * _extensions table (the same table that defines zotero://open-pdf, zotero://select, …).
 */
function registerZhuteroProtocol() {
  try {
    const svc = (typeof Services !== "undefined") ? Services : ChromeUtils.import("resource://gre/modules/Services.jsm").Services;
    const handler = svc.io.getProtocolHandler("zotero").wrappedJSObject;
    if (!handler || !handler._extensions) { Zotero.debug("[Zhutero] zotero protocol _extensions unavailable"); return; }
    handler._extensions["zotero://zhutero"] = {
      noContent: true,
      doAction: async function (uri) {
        try {
          const pqr = uri.pathQueryRef || "";                 // "/navigate?key=...&href=..."
          const q = pqr.indexOf("?") >= 0 ? pqr.slice(pqr.indexOf("?") + 1) : "";
          const p = {};
          q.split("&").forEach(function (pair) { const i = pair.indexOf("="); if (i < 0) return; try { p[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1)); } catch (e) {} });
          const att = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, p.key);
          if (!att) return;
          await Zotero.Reader.open(att.id);
          const win = Zotero.getMainWindow();
          let reader = null;
          for (let i = 0; i < 40 && !reader; i++) { reader = (Zotero.Reader._readers || []).find((r) => r && r._item && r._item.key === att.key); if (!reader) await Zotero.Promise.delay(100); }
          if (!reader) return;
          try { if (win && win.Zotero_Tabs && reader.tabID) win.Zotero_Tabs.select(reader.tabID); } catch (e) {}
          try { if (reader._initPromise) await reader._initPromise; } catch (e) {}
          await Zotero.Promise.delay(200);
          if (p.href || p.cfi) { try { await reader.navigate(p.href ? { href: p.href } : { pageNumber: p.cfi }); } catch (e) {} }
        } catch (e) { Zotero.debug("[Zhutero] nav doAction error: " + e); }
      },
      newChannel: function (uri) { this.doAction(uri); },
    };
    Zotero.debug("[Zhutero] registered zotero://zhutero protocol extension");
  } catch (e) { Zotero.debug("[Zhutero] protocol register failed: " + e); }
}

function unregisterZhuteroHttp() {
  try { delete Zotero.Server.Endpoints["/zhutero/annotate"]; } catch (e) {}
  try { delete Zotero.Server.Endpoints["/zhutero/navigate"]; } catch (e) {}
  try {
    const svc = (typeof Services !== "undefined") ? Services : null;
    const handler = svc && svc.io.getProtocolHandler("zotero").wrappedJSObject;
    if (handler && handler._extensions) delete handler._extensions["zotero://zhutero"];
  } catch (e) {}
}

/**
 * Zhutero collection endpoint — ensure a collection exists by name and file item(s) into it.
 * The local API is read-only, so the journal's paper ingest hits this to keep the rule
 * "HTML paper category == Zotero collection" true.
 *
 *   POST http://127.0.0.1:23119/zhutero/collect
 *   { "name": "Paper - Machine Learning", "keys": ["ABCD1234", ...], "libraryID": <optional> }
 *   → 200 { ok, collectionKey, added:[keys], missing:[keys] }
 */
function registerZhuteroCollect() {
  if (!Zotero.Server || !Zotero.Server.Endpoints) return;
  const EP = "/zhutero/collect";
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    init: function (requestData) {
      return (async () => {
        try {
          const data = (requestData && requestData.data && typeof requestData.data === "object") ? requestData.data : {};
          const name = (data.name || "").trim();
          const keys = Array.isArray(data.keys) ? data.keys : [];
          const libraryID = Number(data.libraryID) || Zotero.Libraries.userLibraryID;
          if (!name) return [400, "application/json", JSON.stringify({ ok: false, error: "missing name" })];
          // find-or-create the collection by name (top-level)
          let coll = (Zotero.Collections.getByLibrary(libraryID) || []).find((c) => c.name === name);
          if (!coll) {
            coll = new Zotero.Collection();
            coll.libraryID = libraryID;
            coll.name = name;
            await coll.saveTx();
          }
          const added = [], missing = [];
          await Zotero.DB.executeTransaction(async () => {
            for (const k of keys) {
              const it = Zotero.Items.getByLibraryAndKey(libraryID, k);
              if (!it) { missing.push(k); continue; }
              it.addToCollection(coll.id);
              await it.save();
              added.push(k);
            }
          });
          return [200, "application/json", JSON.stringify({ ok: true, collectionKey: coll.key, added, missing })];
        } catch (e) {
          return [500, "application/json", JSON.stringify({ ok: false, error: String((e && e.message) || e) })];
        }
      })();
    },
  };
  Zotero.Server.Endpoints[EP] = Endpoint;
  Zotero.debug("[Zhutero] HTTP endpoint registered: POST " + EP);
}

/**
 * Zhutero attach endpoint — download a URL and import it as a stored PDF attachment on a parent
 * item. The connector's /saveItems creates the item but relies on the *browser* to fetch the PDF;
 * a headless POST leaves it attachment-less, so the paper opens as a bare arXiv webpage. This does
 * the server-side download that's missing.
 *
 *   POST http://127.0.0.1:23119/zhutero/attach
 *   { "parentKey": "LNIHXPWT", "url": "https://arxiv.org/pdf/2607.02502", "title": "PDF" }
 *   → 200 { ok, key }
 */
function registerZhuteroAttach() {
  if (!Zotero.Server || !Zotero.Server.Endpoints) return;
  const EP = "/zhutero/attach";
  const Endpoint = function () {};
  Endpoint.prototype = {
    supportedMethods: ["POST"],
    supportedDataTypes: ["application/json"],
    init: function (requestData) {
      return (async () => {
        try {
          const data = (requestData && requestData.data && typeof requestData.data === "object") ? requestData.data : {};
          const libraryID = Number(data.libraryID) || Zotero.Libraries.userLibraryID;
          const parent = Zotero.Items.getByLibraryAndKey(libraryID, data.parentKey);
          if (!parent) return [400, "application/json", JSON.stringify({ ok: false, error: "parent not found" })];
          // skip if it already has a PDF child
          const kids = parent.getAttachments ? parent.getAttachments().map((id) => Zotero.Items.get(id)) : [];
          if (kids.some((a) => a && a.attachmentContentType === "application/pdf")) {
            return [200, "application/json", JSON.stringify({ ok: true, key: null, note: "already has pdf" })];
          }
          const att = await Zotero.Attachments.importFromURL({
            url: data.url,
            parentItemID: parent.id,
            title: data.title || "PDF",
            contentType: "application/pdf",
          });
          return [200, "application/json", JSON.stringify({ ok: true, key: att && att.key })];
        } catch (e) {
          return [500, "application/json", JSON.stringify({ ok: false, error: String((e && e.message) || e) })];
        }
      })();
    },
  };
  Zotero.Server.Endpoints[EP] = Endpoint;
  Zotero.debug("[Zhutero] HTTP endpoint registered: POST " + EP);
}

if (typeof module !== "undefined") {
  module.exports = { registerZhuteroHttp, unregisterZhuteroHttp };
}
