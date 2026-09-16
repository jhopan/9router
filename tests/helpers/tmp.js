import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create a scratch directory under the OS temp root. */
export function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Best-effort recursive delete for scratch dirs.
 *
 * On Windows the SQLite (node:sqlite / better-sqlite3) file handle stays open
 * for a moment past close, so a bare `fs.rmSync(dir, { recursive: true,
 * force: true })` throws EPERM during afterEach cleanup — failing a test that
 * had already passed. Retry, then give up silently: a leftover temp directory
 * costs nothing, while an error here shows up as a product failure.
 */
export function removeTempDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    /* best effort — see note above */
  }
}
