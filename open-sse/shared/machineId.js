import crypto from "node:crypto";
import { createRequire } from "node:module";

// node-machine-id is CJS — destructuring its named export at import time breaks
// differently per bundler (Turbopack dev OK, webpack build undefined). Resolve
// lazily via createRequire and fall back to a UUID if anything goes wrong.
const req = createRequire(import.meta.url);

let cachedRawId = null;

function loadRawMachineId() {
  if (cachedRawId) return cachedRawId;
  try {
    const { machineIdSync } = req("node-machine-id");
    cachedRawId = machineIdSync();
  } catch {
    cachedRawId = crypto.randomUUID();
  }
  return cachedRawId;
}

export async function getConsistentMachineId(salt = "endpoint-proxy-salt") {
  const rawId = loadRawMachineId();
  return crypto.createHash("sha256").update(rawId + salt).digest("hex").substring(0, 16);
}
