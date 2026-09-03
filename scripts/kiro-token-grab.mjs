#!/usr/bin/env node
/**
 * kiro-token-grab.mjs — ambil refresh token Kiro IDE (login resmi) sekali jalan.
 *
 * Sumber: %USERPROFILE%\.aws\sso\cache\kiro-auth-token.json
 * (Kiro IDE menulis token di sini setiap login/refresh — file hidup selama
 *  kamu sesekali membuka Kiro IDE.)
 *
 * Output:
 *   - Default: file "kiro-token-<tanggal>.txt" di Downloads
 *   - --print  : hanya print refreshToken ke stdout (buat pipe/copy)
 *   - --json   : print full JSON (accessToken + refreshToken + profileArn)
 *
 * Jalankan: node kiro-token-grab.mjs [--print|--json]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TOKEN_FILE = path.join(os.homedir(), ".aws", "sso", "cache", "kiro-auth-token.json");

function main() {
  if (!fs.existsSync(TOKEN_FILE)) {
    console.error("Token Kiro IDE tidak ditemukan di:");
    console.error("  " + TOKEN_FILE);
    console.error("");
    console.error("Pastikan kamu sudah login di Kiro IDE (login Google/Builder ID), lalu coba lagi.");
    process.exit(1);
  }

  let j;
  try {
    j = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch (e) {
    console.error("File token ada tapi rusak/tidak terbaca: " + e.message);
    process.exit(1);
  }

  if (!j.refreshToken) {
    console.error("File token tidak berisi refreshToken — login ulang di Kiro IDE.");
    process.exit(1);
  }

  // Cek kedaluwarsa access token (info saja; refreshToken biasanya jauh lebih panjang umurnya)
  const expired = j.expiresAt ? new Date(j.expiresAt) < new Date() : null;

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(j, null, 2));
    return;
  }

  if (process.argv.includes("--print")) {
    console.log(j.refreshToken);
    return;
  }

  // Default: simpan ke Downloads
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = path.join(os.homedir(), "Downloads", `kiro-token-${stamp}.txt`);
  const out = [
    `Kiro IDE token (login resmi via ${j.provider || "?"} / ${j.authMethod || "?"})`,
    `Diambil: ${new Date().toISOString()}`,
    `Access token expired: ${expired === null ? "?" : expired ? "YA (normal, short-lived)" : "belum"}`,
    `Profile ARN: ${j.profileArn || "-"}`,
    "",
    "=== REFRESH TOKEN (untuk Import Token di 9router) ===",
    j.refreshToken,
    "",
    "=== ACCESS TOKEN (info saja) ===",
    j.accessToken || "-",
    "",
    "Cara pakai: 9router dashboard → Kiro → Import Token → paste refresh token di atas.",
    "Jangan share file ini — refresh token = kunci penuh ke akun Kiro kamu.",
    "",
  ].join("\r\n");

  fs.writeFileSync(outPath, out);
  console.log("Token tersimpan: " + outPath);
  console.log("Refresh token (" + j.refreshToken.length + " chars) siap dipakai untuk Import Token.");
}

main();
