// Zhutero preferences pane script
// Loaded by Zotero when the prefs pane opens

var Zhutero_Preferences = {
  init() {
    const prefs = Components.classes["@mozilla.org/preferences-service;1"]
      .getService(Components.interfaces.nsIPrefBranch);
    const PREFIX = "extensions.zhutero.";

    const providerEl = document.getElementById("zhutero-provider");
    const baseurlEl = document.getElementById("zhutero-baseurl");
    const apikeyEl = document.getElementById("zhutero-apikey");
    const modelEl = document.getElementById("zhutero-model");
    const baseurlRow = document.getElementById("zhutero-baseurl-row");
    const statusEl = document.getElementById("zhutero-status");

    function getPref(key) {
      try { return prefs.getStringPref(PREFIX + key, ""); }
      catch (e) { return ""; }
    }

    function setPref(key, val) {
      prefs.setStringPref(PREFIX + key, val);
      statusEl.hidden = false;
      setTimeout(() => { statusEl.hidden = true; }, 1500);
    }

    // Load current values
    providerEl.value = getPref("provider") || "anthropic";
    baseurlEl.value = getPref("baseUrl");
    apikeyEl.value = getPref("apiKey");
    modelEl.value = getPref("model");

    function updateVisibility() {
      baseurlRow.hidden = providerEl.value !== "custom";
    }
    updateVisibility();

    providerEl.addEventListener("command", () => {
      setPref("provider", providerEl.value);
      updateVisibility();
    });
    baseurlEl.addEventListener("change", () => setPref("baseUrl", baseurlEl.value));
    apikeyEl.addEventListener("change", () => setPref("apiKey", apikeyEl.value));
    modelEl.addEventListener("change", () => setPref("model", modelEl.value));
  }
};
