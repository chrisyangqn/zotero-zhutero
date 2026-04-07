#!/usr/bin/env node

/**
 * Build script for KReader Zotero plugin.
 * Packages everything into an .xpi file (which is just a zip).
 */

const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const isDev = process.argv.includes("--dev");
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const version = manifest.version;
const outputName = `kreader-${version}.xpi`;

const zip = new AdmZip();

// Files to include
const include = [
  "manifest.json",
  "bootstrap.js",
  "content/kreader.js",
  "content/kreader.css",
  "content/preferences.xhtml",
  "src/llm.js",
  "src/framework.js",
  "src/storage.js",
];

// Locale files
const localeDir = "locale";
if (fs.existsSync(localeDir)) {
  for (const lang of fs.readdirSync(localeDir)) {
    const langDir = path.join(localeDir, lang);
    if (fs.statSync(langDir).isDirectory()) {
      for (const file of fs.readdirSync(langDir)) {
        include.push(path.join(localeDir, lang, file));
      }
    }
  }
}

// Icon placeholder
const iconDir = "content/icons";
if (fs.existsSync(iconDir)) {
  for (const file of fs.readdirSync(iconDir)) {
    include.push(path.join(iconDir, file));
  }
}

for (const file of include) {
  if (fs.existsSync(file)) {
    zip.addLocalFile(file, path.dirname(file) === "." ? "" : path.dirname(file));
    console.log(`  + ${file}`);
  } else {
    console.warn(`  ! Missing: ${file}`);
  }
}

// Write .xpi
const buildDir = "build";
if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir);
const outputPath = path.join(buildDir, outputName);
zip.writeZip(outputPath);

console.log(`\nBuilt: ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB)`);

if (isDev) {
  // In dev mode, also copy to Zotero extensions directory for quick testing
  const zoteroProfile = getZoteroProfileDir();
  if (zoteroProfile) {
    const extDir = path.join(zoteroProfile, "extensions");
    if (!fs.existsSync(extDir)) fs.mkdirSync(extDir, { recursive: true });
    // Write a proxy file pointing to source for live dev
    const proxyPath = path.join(extDir, "kreader@qinuoyang.com");
    fs.writeFileSync(proxyPath, path.resolve("."));
    console.log(`Dev proxy installed: ${proxyPath}`);
    console.log("Restart Zotero to load the plugin.");
  }
}

function getZoteroProfileDir() {
  const home = process.env.HOME || process.env.USERPROFILE;
  const candidates = [
    // macOS
    path.join(home, "Library", "Application Support", "Zotero", "Profiles"),
    // Linux
    path.join(home, ".zotero", "zotero"),
    // Windows
    path.join(home, "AppData", "Roaming", "Zotero", "Zotero", "Profiles"),
  ];

  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const profiles = fs.readdirSync(dir).filter((d) => d.endsWith(".default") || d.includes(".default-"));
      if (profiles.length > 0) {
        return path.join(dir, profiles[0]);
      }
    }
  }
  console.log("  Could not find Zotero profile directory.");
  return null;
}
