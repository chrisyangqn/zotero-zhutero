/**
 * Storage layer - persists framework data per Zotero item.
 * Uses a JSON file in Zotero's data directory.
 */

const STORAGE_FILE = "kreader-data.json";

let _cache = null;

function getStoragePath() {
  return PathUtils.join(Zotero.DataDirectory.dir, STORAGE_FILE);
}

async function loadAll() {
  if (_cache) return _cache;
  const path = getStoragePath();
  try {
    const exists = await IOUtils.exists(path);
    if (!exists) {
      _cache = { frameworks: {}, notes: {} };
      return _cache;
    }
    const raw = await IOUtils.readUTF8(path);
    _cache = JSON.parse(raw);
    return _cache;
  } catch (e) {
    Zotero.log(`[KReader] Failed to load storage: ${e.message}`, "warning");
    _cache = { frameworks: {}, notes: {} };
    return _cache;
  }
}

async function saveAll() {
  if (!_cache) return;
  const path = getStoragePath();
  await IOUtils.writeUTF8(path, JSON.stringify(_cache, null, 2));
}

/**
 * Get framework for a Zotero item.
 * @param {string} itemKey - Zotero item key
 * @returns {Promise<object|null>}
 */
async function getFramework(itemKey) {
  const data = await loadAll();
  return data.frameworks[itemKey] || null;
}

/**
 * Save framework for a Zotero item.
 * @param {string} itemKey - Zotero item key
 * @param {object} framework - Framework tree JSON
 */
async function saveFramework(itemKey, framework) {
  const data = await loadAll();
  data.frameworks[itemKey] = {
    ...framework,
    updatedAt: new Date().toISOString(),
  };
  await saveAll();
}

/**
 * Delete framework for a Zotero item.
 */
async function deleteFramework(itemKey) {
  const data = await loadAll();
  delete data.frameworks[itemKey];
  await saveAll();
}

/**
 * Get notes for a framework node.
 * @param {string} itemKey
 * @returns {Promise<object[]>}
 */
async function getNotes(itemKey) {
  const data = await loadAll();
  return data.notes[itemKey] || [];
}

/**
 * Save a note for a framework node.
 * @param {string} itemKey
 * @param {string} nodeId
 * @param {string} content
 */
async function saveNote(itemKey, nodeId, content) {
  const data = await loadAll();
  if (!data.notes[itemKey]) data.notes[itemKey] = [];
  const existing = data.notes[itemKey].find((n) => n.node_id === nodeId);
  if (existing) {
    existing.content = content;
    existing.updatedAt = new Date().toISOString();
  } else {
    data.notes[itemKey].push({
      node_id: nodeId,
      content,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
  await saveAll();
}

if (typeof module !== "undefined") {
  module.exports = {
    getFramework, saveFramework, deleteFramework,
    getNotes, saveNote, loadAll,
  };
}
