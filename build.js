#!/usr/bin/env node

/**
 * Build script for Zhutero Zotero plugin.
 * Packages everything into an .xpi file using adm-zip (pure Node, so
 * the build works on macOS, Linux, AND Windows without depending on a
 * system `zip` binary).
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const isDev = process.argv.includes("--dev");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const version = manifest.version;
const outputName = `zhutero-${version}.xpi`;

// Files to include
const include = [
  "manifest.json",
  "bootstrap.js",
  "prefs.js",
  "content/zhutero.js",
  "content/zhutero.css",
  "content/icon.svg",
  "content/icon-64.png",
  "content/icon-128.png",
  "content/preferences.xhtml",
  "content/prefs.js",
  "src/llm.js",
  "src/framework.js",
  "src/storage.js",
  "src/noteStorage.js",
  "src/userAnnotations.js",
  "src/httpEndpoint.js",
  "locale/en-US/zhutero.ftl",
  "locale/zh-CN/zhutero.ftl",
];

// Filter to existing files
const files = include.filter((f) => {
  if (fs.existsSync(f)) {
    console.log(`  + ${f}`);
    return true;
  }
  console.warn(`  ! Missing: ${f}`);
  return false;
});

// Ensure build dir
const buildDir = "build";
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir);
const outputPath = path.resolve(buildDir, outputName);

// Remove old xpi
if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

// Pack with adm-zip — preserves the project-relative directory structure
// inside the archive, which is what Zotero expects from an .xpi.
const zip = new AdmZip();
for (const f of files) {
  // entryName uses forward slashes so the archive is portable
  // (Windows file paths get normalized).
  const entryName = f.split(path.sep).join("/");
  zip.addLocalFile(f, path.posix.dirname(entryName) === "." ? "" : path.posix.dirname(entryName));
}
zip.writeZip(outputPath);

console.log(`\nBuilt: ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

if (isDev) {
  const zoteroProfile = getZoteroProfileDir();
  if (zoteroProfile) {
    const extDir = path.join(zoteroProfile, "extensions");
    if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
    const proxyPath = path.join(extDir, "zhutero@qinuoyang.com");
    fs.writeFileSync(proxyPath, path.resolve("."));
    console.log(`Dev proxy installed: ${proxyPath}`);
    console.log("Restart Zotero to load the plugin.");
  }
}

function getZoteroProfileDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    path.join(home, "Library", "Application Support", "Zotero", "Profiles"),
    path.join(home, ".zotero", "zotero"),
    path.join(home, "AppData", "Roaming", "Zotero", "Zotero", "Profiles"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const profiles = fs.readdirSync(dir).filter((d) => d.endsWith(".default") || d.includes(".default-"));
      if (profiles.length > 0) return path.join(dir, profiles[0]);
    }
  }
  return null;
}
