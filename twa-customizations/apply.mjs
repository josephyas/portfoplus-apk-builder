#!/usr/bin/env node
/**
 * Re-applies this project's native customizations on top of a freshly
 * generated Bubblewrap project.
 *
 * Bubblewrap regenerates app/ wholesale from twa-manifest.json, so anything
 * hand-edited in there is one `bubblewrap update` (or one "regenerate the
 * project? Y") away from vanishing — silently, producing an APK that looks
 * normal but has no advertising-id handoff, no AD_ID permission and no R8 keep
 * rules. Everything we add lives here instead, and this script puts it back.
 *
 *   node twa-customizations/apply.mjs
 *
 * Idempotent: re-running on an already-patched tree changes nothing and exits
 * 0. It exits 1 if an anchor is missing, so a Bubblewrap template change shows
 * up as a failed build rather than a quietly broken release.
 *
 * See README.md in this directory for the full build sequence.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")
const FILES = join(HERE, "files")

/** Must match twa-manifest.json — Bubblewrap propagates these into app/build.gradle. */
const EXPECTED_VERSION_NAME = "1.1.0"
const EXPECTED_VERSION_CODE = "4"

const ADTRACE_SDK = "io.adtrace:android-sdk:2.6.1"
const ADS_IDENTIFIER = "com.google.android.gms:play-services-ads-identifier:18.2.0"

const results = []
let changed = 0

function fail(message) {
  console.error(`\n  FAILED  ${message}\n`)
  process.exit(1)
}

function read(rel) {
  const path = join(ROOT, rel)
  if (!existsSync(path)) {
    fail(`${rel} does not exist.\n  Generate the Android project first: bubblewrap update`)
  }
  return readFileSync(path, "utf8")
}

function write(rel, contents) {
  writeFileSync(join(ROOT, rel), contents)
}

function record(rel, what, didChange) {
  if (didChange) changed++
  results.push(`  ${didChange ? "patched" : "already"}  ${rel} — ${what}`)
}

/** Start-of-line index for the line containing `idx`. */
function lineStart(src, idx) {
  const nl = src.lastIndexOf("\n", idx)
  return nl < 0 ? 0 : nl + 1
}

/** Leading whitespace of the line containing `idx`. */
function indentAt(src, idx) {
  const start = lineStart(src, idx)
  return /^[ \t]*/.exec(src.slice(start))[0]
}

function findAnchor(rel, src, anchor) {
  const idx = src.indexOf(anchor)
  if (idx < 0) {
    fail(
      `${rel}: could not find the anchor ${JSON.stringify(anchor)}.\n` +
        `  The Bubblewrap template has changed — update twa-customizations/apply.mjs\n` +
        `  before shipping, or the release will be missing this customization.`
    )
  }
  return idx
}

/** Insert `lines` on their own lines directly above the anchor's line. */
function insertAboveLine(rel, { anchor, lines, guard, what }) {
  const src = read(rel)
  if (src.includes(guard)) return record(rel, what, false)

  const idx = findAnchor(rel, src, anchor)
  const at = lineStart(src, idx)
  const indent = indentAt(src, idx)
  const block = lines.map((l) => (l ? indent + l : "")).join("\n") + "\n"
  write(rel, src.slice(0, at) + block + src.slice(at))
  record(rel, what, true)
}

/** Insert `lines` on their own lines directly below the anchor's line. */
function insertBelowLine(rel, { anchor, lines, guard, what }) {
  const src = read(rel)
  if (src.includes(guard)) return record(rel, what, false)

  const idx = findAnchor(rel, src, anchor)
  const eol = src.indexOf("\n", idx)
  const at = eol < 0 ? src.length : eol + 1
  const indent = indentAt(src, idx)
  const block = lines.map((l) => (l ? indent + l : "")).join("\n") + "\n"
  write(rel, src.slice(0, at) + block + src.slice(at))
  record(rel, what, true)
}

/** Copy a tracked file from files/ into the generated project. */
function install(rel) {
  const src = join(FILES, rel)
  const dst = join(ROOT, rel)
  if (!existsSync(src)) fail(`twa-customizations/files/${rel} is missing.`)

  const isSame =
    existsSync(dst) && readFileSync(dst, "utf8") === readFileSync(src, "utf8")
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  record(rel, "installed from twa-customizations/files", !isSame)
}

/* ── 1. The generated project must exist, at the version we expect ────────── */

function assertVersions() {
  const rel = "app/build.gradle"
  const src = read(rel)
  const name = /versionName\s+"([^"]+)"/.exec(src)?.[1]
  const code = /versionCode\s+(\d+)/.exec(src)?.[1]

  if (name !== EXPECTED_VERSION_NAME || code !== EXPECTED_VERSION_CODE) {
    fail(
      `${rel} is at versionName ${name} / versionCode ${code}, expected ` +
        `${EXPECTED_VERSION_NAME} / ${EXPECTED_VERSION_CODE}.\n` +
        `  Bump appVersionName / appVersion / appVersionCode in twa-manifest.json,\n` +
        `  re-run \`bubblewrap update\`, then run this script again.\n` +
        `  (If you meant to ship a new version, update the constants at the top of this file.)`
    )
  }
  record(rel, `version ${name} (${code})`, false)
}

/* ── 2. Repositories: io.adtrace lives on Maven Central ───────────────────── */

function patchRepositories() {
  const settings = read("settings.gradle")
  if (settings.includes("dependencyResolutionManagement")) {
    fail(
      "settings.gradle now declares dependencyResolutionManagement, which makes the\n" +
        "  root build.gradle repositories inert. Move the mavenCentral() patch into\n" +
        "  settings.gradle and update this script."
    )
  }

  const rel = "build.gradle"
  const src = read(rel)
  if (!src.includes("jcenter()") && src.includes("mavenCentral()")) {
    return record(rel, "mavenCentral() present", false)
  }

  let out
  if (src.includes("jcenter()")) {
    // jcenter has been fully sunset; every resolution against it is a wasted
    // round-trip, and io.adtrace was never there anyway.
    out = src.split("jcenter()").join("mavenCentral()")
  } else if (src.includes("google()")) {
    out = src.split("google()").join("google()\n        mavenCentral()")
  } else {
    fail(`${rel}: found neither jcenter() nor google() to anchor mavenCentral() on.`)
  }

  // Guard against a block that already had mavenCentral() next to jcenter().
  out = out.replace(/^([ \t]*mavenCentral\(\)\n)(?:[ \t]*mavenCentral\(\)\n)+/gm, "$1")

  write(rel, out)
  record(rel, "jcenter() → mavenCentral()", true)
}

/* ── 3–5. Anchored patches into the generated Gradle + manifest ───────────── */

function patchAppGradle() {
  // R8 currently runs with no rules file at all. Without keeps it strips the
  // advertising-id lookup, and gps_adid stops being appended in release only.
  insertBelowLine("app/build.gradle", {
    anchor: "minifyEnabled true",
    guard: "proguard-rules.pro",
    what: "proguardFiles",
    lines: [
      "proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'",
    ],
  })

  insertBelowLine("app/build.gradle", {
    anchor: "implementation 'com.google.androidbrowserhelper:androidbrowserhelper",
    guard: "io.adtrace",
    what: "AdTrace + ads-identifier dependencies",
    lines: [
      "",
      "// --- twa-customizations: AdTrace GAID handoff ---",
      `implementation '${ADTRACE_SDK}'`,
      `implementation '${ADS_IDENTIFIER}'`,
      "// --- /twa-customizations ---",
    ],
  })
}

function patchManifest() {
  // The generated manifest declares no permissions at all. AD_ID is mandatory
  // at targetSdk >= 31.
  insertAboveLine("app/src/main/AndroidManifest.xml", {
    anchor: "<application",
    guard: "AD_ID",
    what: "INTERNET / ACCESS_NETWORK_STATE / AD_ID permissions",
    lines: [
      "<!-- twa-customizations: required by the AdTrace advertising-id lookup -->",
      '<uses-permission android:name="android.permission.INTERNET" />',
      '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />',
      '<uses-permission android:name="com.google.android.gms.permission.AD_ID" />',
      "",
    ],
  })
}

/* ── main ─────────────────────────────────────────────────────────────────── */

assertVersions()
patchRepositories()
patchAppGradle()
patchManifest()
install("app/proguard-rules.pro")
install("app/src/main/java/plus/portfo/twa/LauncherActivity.java")

console.log("\ntwa-customizations\n")
for (const line of results) console.log(line)
console.log(
  `\n  ${changed} applied, ${results.length - changed} already in place.\n` +
    (changed === 0 ? "  Nothing to do — the project was already patched.\n" : "")
)
