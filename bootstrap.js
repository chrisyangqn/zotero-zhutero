/**
 * Zhutero - Zotero 7 Bootstrap Plugin
 * Based on Zotero's official Make It Red example and zotero-plugin-template.
 */

var chromeHandle;
var Zhutero;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  // Register chrome content mapping (required for Zotero 7)
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zhutero", rootURI + "content/"],
  ]);

  // Load modules
  Services.scriptloader.loadSubScript(rootURI + "src/llm.js");
  Services.scriptloader.loadSubScript(rootURI + "src/framework.js");
  Services.scriptloader.loadSubScript(rootURI + "src/storage.js");
  Services.scriptloader.loadSubScript(rootURI + "src/noteStorage.js");
  Services.scriptloader.loadSubScript(rootURI + "src/userAnnotations.js");
  Services.scriptloader.loadSubScript(rootURI + "content/zhutero.js");

  Zhutero = new ZhuteroPlugin();
  await Zhutero.init({ id, version, rootURI });
}

async function onMainWindowLoad({ window }, reason) {}

async function onMainWindowUnload({ window }, reason) {}

async function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) {
    return;
  }

  Zhutero?.destroy();
  Zhutero = undefined;

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
