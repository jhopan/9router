#!/usr/bin/env node
/**
 * kiro-token-grab.mjs — ambil refresh token Kiro (login resmi) sekali jalan.
 *
 * Sumber (urut, pertama yang ketemu dipakai):
 *   1. Kiro CLI : %LOCALAPPDATA%\Kiro-Cli\data.sqlite3 -> auth_kv["kirocli:social:token"]
 *                 (butuh better-sqlite3 — otomatis dicari di node_modules sekitar)
 *   2. Kiro IDE : %USERPROFILE%\.aws\sso\cache\kiro-auth-token.json (zero deps)
 *
 * Output:
 *   - Default: file "kiro-token-<cli|ide>-<tanggal>.txt" di Downloads
 *   - --print  : hanya print refreshToken ke stdout (buat paste ke Import Token)
 *   - --json   : print JSON penuh
 *
 * Jalankan: node kiro-token-grab.mjs [--print|--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const req = createRequire(import.meta.url);

function fromIde() {
  const p = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!j.refreshToken) return null;
    return {
      source: "ide",
      refreshToken: j.refreshToken,
      accessToken: j.accessToken || null,
      profileArn: j.profileArn || null,
      expiresAt: j.expiresAt || null,
      provider: j.provider || null,
      authMethod: j.authMethod || "social",
    };
  } catch {
    return null;
  }
}

// SQLite reader layer for the Kiro CLI source — zero install preferred:
//   1. node:sqlite   — Node >= 22.5 builtin (no install, works everywhere modern)
//   2. better-sqlite3 — optional dep of 9router/OmniRoute; resolved from nearby
//                      node_modules / global npm install if present
function openSqlite(dbPath) {
  // 1. builtin node:sqlite (Node >= 22.5)
  try {
    const { DatabaseSync } = req("node:sqlite");
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {}
  // 2. better-sqlite3 from any ancestor/global location
  const candidates = [
    "better-sqlite3",
    path.join(process.cwd(), "node_modules", "better-sqlite3"),
    path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "9router", "app", "node_modules", "better-sqlite3"),
  ];
  for (const c of candidates) {
    try {
      const Database = req(c);
      return new Database(dbPath, { readonly: true });
    } catch {}
  }
  return null;
}

function fromCli() {
  const p = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Kiro-Cli", "data.sqlite3");
  if (!fs.existsSync(p)) return null;
  const db = openSqlite(p);
  if (!db) return null; // caller falls back to IDE
  try {
    const row = db.prepare("SELECT value FROM auth_kv WHERE key = ?").get("kirocli:social:token");
    db.close();
    if (!row) return null;
    const j = JSON.parse(row.value);
    if (!j.refresh_token) return null;
    return {
      source: "cli",
      refreshToken: j.refresh_token,
      accessToken: j.access_token || null,
      profileArn: j.profile_arn || null,
      expiresAt: j.expires_at || null,
      provider: j.provider || null,
      authMethod: "social",
    };
  } catch {
    try { db.close(); } catch {}
    return null;
  }
}

function main() {
  // CLI first (ringan, token paling segar kalau CLI dipakai harian); IDE fallback (zero deps).
  const token = fromCli() || fromIde();

  if (!token) {
    console.error("Token Kiro tidak ditemukan. Dicari di:");
    console.error("  CLI: %LOCALAPPDATA%/Kiro-Cli/data.sqlite3 (auth_kv)");
    console.error("  IDE: ~/.aws/sso/cache/kiro-auth-token.json");
    console.error("");
    console.error("Login dulu di Kiro CLI atau Kiro IDE, lalu coba lagi.");
    console.error("(Sumber CLI butuh better-sqlite3 ter-install di sekitar; tanpa itu otomatis pakai sumber IDE.)");
    process.exit(1);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(token, null, 2));
    return;
  }

  if (process.argv.includes("--print")) {
    console.log(token.refreshToken);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(os.homedir(), "Downloads", `kiro-token-${token.source}-${stamp}.txt`);
  const expired = token.expiresAt ? new Date(token.expiresAt) < new Date() : null;
  const out = [
    `Kiro token (sumber: Kiro ${token.source.toUpperCase()}, login ${token.provider || "?"} / ${token.authMethod || "social"})`,
    `Diambil: ${new Date().toISOString()}`,
    `Access token expired: ${expired === null ? "?" : expired ? "YA (normal, short-lived)" : "belum"}`,
    `Profile ARN: ${token.profileArn || "-"}`,
    "",
    "=== REFRESH TOKEN (untuk Import Token di 9router) ===",
    token.refreshToken,
    "",
    "=== ACCESS TOKEN (info saja) ===",
    token.accessToken || "-",
    "",
    "Cara pakai: 9router dashboard → Kiro → Import Token → paste refresh token di atas.",
    "Jangan share file ini — refresh token = kunci penuh ke akun Kiro kamu.",
    "",
  ].join("\r\n");

  fs.writeFileSync(outPath, out);
  console.log(`Sumber: Kiro ${token.source.toUpperCase()}`);
  console.log("Token tersimpan: " + outPath);
  console.log("Refresh token (" + token.refreshToken.length + " chars) siap dipakai untuk Import Token.");
}

main();
