import crypto from "node:crypto";
import { FREEBUFF_OAUTH } from "../constants/oauth.js";

// FreeBuff/Codebuff — Browser Login Polling Flow (mirrors the official CLI):
// 1. Generate fingerprintId ("enhanced-<43 char base64url>" — CLI fingerprint format)
// 2. POST /api/auth/cli/code {fingerprintId} → { loginUrl, fingerprintHash }
// 3. User opens loginUrl on ANY device and signs in (Google/GitHub)
// 4. Poll GET /api/auth/cli/status?fingerprintId&fingerprintHash until it
//    returns user.authToken (36-char UUID). No callback URL needed — the
//    fingerprint binds the poll to this login session, so the login can happen
//    on a completely different device.

function generateFingerprintId() {
  const bytes = crypto.randomBytes(32);
  const b64 = bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `enhanced-${b64}`;
}

const freebuff = {
  config: FREEBUFF_OAUTH,
  flowType: "device_code",
  requestDeviceCode: async (config) => {
    const fingerprintId = generateFingerprintId();
    const response = await fetch(config.codeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": config.userAgent,
      },
      body: JSON.stringify({ fingerprintId }),
    });
    if (!response.ok) throw new Error(`FreeBuff code request failed: ${await response.text()}`);
    const data = await response.json();
    const loginUrl = data.loginUrl || data.login_url || "";
    const fingerprintHash = data.fingerprintHash || data.fingerprint_hash || "";
    const expiresAt = data.expiresAt || data.expires_at || "";
    if (!loginUrl) throw new Error("FreeBuff: no loginUrl in /api/auth/cli/code response");
    return {
      device_code: fingerprintId,
      verification_uri: loginUrl,
      verification_uri_complete: loginUrl,
      user_code: "",
      interval: config.pollInterval / 1000,
      expires_in: Math.floor(config.timeoutMs / 1000),
      _fingerprintHash: fingerprintHash,
      _expiresAt: String(expiresAt),
    };
  },
  pollToken: async (config, fingerprintId, _codeVerifier, extraData) => {
    const fingerprintHash = extraData?._fingerprintHash || "";
    const expiresAt = extraData?._expiresAt || "";
    const query = new URLSearchParams({ fingerprintId, fingerprintHash, expiresAt });
    const response = await fetch(`${config.statusUrl}?${query.toString()}`, {
      headers: { Accept: "application/json", "User-Agent": config.userAgent },
    });
    // 401 = not yet authorized (keep polling); 200 = token available
    if (response.status === 401) return { ok: true, data: { error: "authorization_pending" } };
    if (!response.ok) return { ok: false, data: { error: `status_${response.status}` } };

    const data = await response.json().catch(() => null);
    const user = data?.user || data;
    const authToken = user?.authToken || user?.token || data?.authToken || "";
    if (!authToken) return { ok: true, data: { error: "authorization_pending" } };
    return {
      ok: true,
      data: {
        access_token: authToken,
        refresh_token: "",
        token_type: "Bearer",
        _email: user.email || "",
        _name: user.name || "",
      },
    };
  },
  mapTokens: (tokens) => ({
    accessToken: tokens.access_token,
    refreshToken: "",
    expiresIn: 3600,
    email: tokens._email || undefined,
    providerSpecificData: {
      email: tokens._email || undefined,
      authMethod: "social",
      provider: "FreeBuff Login",
    },
  }),
};

export default freebuff;
