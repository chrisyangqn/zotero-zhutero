/* KReader - Zotero 7 Bootstrap Plugin Entry */

var KReader;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }) {
  // Load the main module
  Services.scriptloader.loadSubScript(rootURI + "content/kreader.js");
  KReader = new KReaderPlugin();
  await KReader.init({ id, version, rootURI });
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  KReader?.destroy();
  KReader = undefined;
}

function uninstall(data, reason) {}
