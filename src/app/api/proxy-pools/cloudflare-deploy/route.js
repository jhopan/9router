import { NextResponse } from "next/server";
import { createProxyPool } from "@/models";

// Relay worker source code deployed to Cloudflare
const RELAY_WORKER_CODE = `
export default {
  async fetch(request, env, ctx) {
    const target = request.headers.get("x-relay-target");
    const relayPath = request.headers.get("x-relay-path") || "/";
    
    if (!target) {
      return new Response(JSON.stringify({ error: "Missing x-relay-target header" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const targetUrl = target.replace(/\\/$/, "") + relayPath;
    const newRequestInit = {
      method: request.method,
      headers: new Headers(request.headers),
    };

    if (request.method !== "GET" && request.method !== "HEAD") {
      newRequestInit.body = request.body;
      newRequestInit.duplex = "half";
    }

    newRequestInit.headers.delete("x-relay-target");
    newRequestInit.headers.delete("x-relay-path");
    newRequestInit.headers.delete("host");

    try {
      const response = await fetch(targetUrl, newRequestInit);
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  },
};
`;

// Split a pipe-separated string into trimmed, non-empty parts.
function splitBatch(input) {
  if (!input || typeof input !== "string") return [];
  return input
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Deploy a single Cloudflare Worker. Returns { deployUrl } or throws.
async function deploySingleWorker(accountId, apiToken, projectName) {
  // 1. Upload Worker Script
  const workerScriptUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${projectName}`;

  const formData = new FormData();
  formData.append("index.js", new Blob([RELAY_WORKER_CODE], { type: "application/javascript+module" }), "index.js");
  formData.append("metadata", new Blob([JSON.stringify({
    main_module: "index.js",
    compatibility_date: "2024-03-20",
    observability: { enabled: true }
  })], { type: "application/json" }), "metadata.json");

  const uploadRes = await fetch(workerScriptUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    body: formData,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({}));
    const msg = err.errors?.[0]?.message || `Failed to upload Worker (HTTP ${uploadRes.status})`;
    throw new Error(`[${projectName}] ${msg}`);
  }

  // 2. Enable workers.dev subdomain for the script
  const enableSubdomainRes = await fetch(`${workerScriptUrl}/subdomain`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ enabled: true }),
  });

  if (!enableSubdomainRes.ok) {
    // Non-fatal — subdomain may already be enabled
  }

  // 3. Get the workers.dev subdomain for the account to construct the final URL
  const subdomainRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
  });

  let deployUrl = "";
  if (subdomainRes.ok) {
    const subdomainData = await subdomainRes.json();
    if (subdomainData.result && subdomainData.result.subdomain) {
      deployUrl = `https://${projectName}.${subdomainData.result.subdomain}.workers.dev`;
    }
  }

  if (!deployUrl) {
    throw new Error(`[${projectName}] Worker deployed but failed to retrieve workers.dev subdomain. Make sure you have set up a workers.dev subdomain in Cloudflare Dashboard.`);
  }

  return { deployUrl };
}

// POST /api/proxy-pools/cloudflare-deploy
// Supports batch deploy via pipe-separated accountId|accountId2 and apiToken|apiToken2.
export async function POST(request) {
  try {
    const body = await request.json();
    const accountIds = splitBatch(body.accountId);
    const apiTokens = splitBatch(body.apiToken);
    const projectNameRaw = (body.projectName || "").trim();
    const projectNames = projectNameRaw ? splitBatch(projectNameRaw) : [];

    if (accountIds.length === 0 || apiTokens.length === 0) {
      return NextResponse.json(
        { error: "Cloudflare Account ID and API Token are required" },
        { status: 400 }
      );
    }

    if (accountIds.length !== apiTokens.length) {
      return NextResponse.json(
        { error: `Mismatched batch sizes: ${accountIds.length} account IDs vs ${apiTokens.length} API tokens. Use | to separate, same count on both fields.` },
        { status: 400 }
      );
    }

    const results = [];
    const errors = [];

    for (let i = 0; i < accountIds.length; i++) {
      const accountId = accountIds[i];
      const apiToken = apiTokens[i];
      // Use provided name at index i, or fall back to relay-<timestamp>-<i>
      const projectName = projectNames[i] || `relay-${Date.now().toString(36)}-${i + 1}`;

      try {
        const { deployUrl } = await deploySingleWorker(accountId, apiToken, projectName);

        // Create proxy pool entry
        const proxyPool = await createProxyPool({
          name: projectName,
          proxyUrl: deployUrl,
          type: "cloudflare",
          noProxy: "",
          isActive: true,
          strictProxy: false,
        });

        results.push({ projectName, deployUrl, proxyPool });
      } catch (err) {
        errors.push({ projectName, accountId, error: err.message });
      }
    }

    // Return 201 if at least one succeeded, 207 multi-status semantics
    if (results.length > 0) {
      return NextResponse.json(
        {
          deployed: results,
          failed: errors,
          deployUrl: results[0]?.deployUrl,
          proxyPool: results[0]?.proxyPool,
          summary: `${results.length}/${accountIds.length} relay(s) deployed${errors.length ? `, ${errors.length} failed` : ""}`,
        },
        { status: 201 }
      );
    }

    // All failed
    return NextResponse.json(
      {
        error: "All deployments failed",
        failed: errors,
      },
      { status: 500 }
    );
  } catch (error) {
    console.log("Error deploying Cloudflare relay:", error);
    return NextResponse.json({ error: error.message || "Deploy failed" }, { status: 500 });
  }
}
