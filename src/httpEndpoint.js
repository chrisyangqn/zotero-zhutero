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
}

function unregisterZhuteroHttp() {
  try { delete Zotero.Server.Endpoints["/zhutero/annotate"]; } catch (e) {}
}

if (typeof module !== "undefined") {
  module.exports = { registerZhuteroHttp, unregisterZhuteroHttp };
}
