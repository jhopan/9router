import { describe, expect, it } from "vitest";
import { KiroExecutor } from "../../open-sse/executors/kiro.js";

const CODEWHISPERER = "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse";
const Q = "https://q.us-east-1.amazonaws.com/generateAssistantResponse";
const TARGET = "AmazonCodeWhispererStreamingService.GenerateAssistantResponse";

function credentials(authMethod, region = "us-east-1") {
  return { providerSpecificData: { authMethod, region } };
}

describe("Kiro auth-aware endpoint routing", () => {
  const executor = new KiroExecutor();

  it("routes API-key inference through Amazon Q before other surfaces", () => {
    expect(executor.getOrderedBaseUrls(credentials("api_key"))).toEqual([
      Q,
      CODEWHISPERER,
    ]);
  });

  it("keeps OAuth on the CodeWhisperer surface (Kiro CLI gateway removed)", () => {
    expect(executor.getOrderedBaseUrls(credentials("builder-id"))).toEqual([
      CODEWHISPERER,
      Q,
    ]);
  });

  it("keeps external IdP on CodeWhisperer before Amazon Q", () => {
    expect(executor.getOrderedBaseUrls(credentials("external_idp"))).toEqual([
      CODEWHISPERER,
      Q,
    ]);
  });

  it("regionalizes AWS endpoints for a profile region (eu-central-1), keeps us-east-1 for others", () => {
    // eu-west-1 is a valid IdC region but NOT a Q Developer profile region, so
    // runtime stays us-east-1 (only us-east-1 / eu-central-1 host profiles).
    expect(executor.getOrderedBaseUrls(credentials("idc", "eu-west-1"))).toEqual([
      CODEWHISPERER,
      Q,
    ]);
    expect(executor.getOrderedBaseUrls(credentials("idc", "eu-central-1"))).toEqual([
      "https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse",
      "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
    ]);
  });

  it("derives the runtime region from a profileArn, ignoring the stored IdC region", () => {
    expect(
      executor.getOrderedBaseUrls({
        providerSpecificData: {
          authMethod: "idc",
          region: "ap-southeast-2",
          profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/abc",
        },
      })
    ).toEqual([
      "https://codewhisperer.eu-central-1.amazonaws.com/generateAssistantResponse",
      "https://q.eu-central-1.amazonaws.com/generateAssistantResponse",
    ]);
  });

  it("retries only endpoint/auth-surface failures, not payload-invalid 400s", () => {
    expect(executor.shouldRetry(400, 0)).toBe(false); // payload-invalid → terminal
    expect(executor.shouldRetry(401, 0)).toBe(true); // host0 has host1 fallback
    expect(executor.shouldRetry(401, 1)).toBe(false); // last host, no fallback
    expect(executor.shouldRetry(403, 0)).toBe(true); // 403 in endpoint-fallback set
    expect(executor.shouldRetry(422, 0)).toBe(false); // not in set, not 429
  });

  it("builds endpoint-specific headers", () => {
    const auth = { accessToken: "test-key", providerSpecificData: { authMethod: "api_key" } };
    const qHeaders = executor.buildHeaders(auth, true, Q);
    const codeWhispererHeaders = executor.buildHeaders(auth, true, CODEWHISPERER);

    expect(qHeaders.TokenType).toBe("API_KEY");
    // Both Amazon Q and CodeWhisperer serve the same generateAssistantResponse
    // target — OmniRoute sends X-Amz-Target for every Kiro host.
    expect(qHeaders["X-Amz-Target"]).toBe(TARGET);
    expect(codeWhispererHeaders["X-Amz-Target"]).toBe(TARGET);
    // Prompt-caching headers are always present on the Amazon surface.
    expect(qHeaders["x-amzn-bedrock-cache-control"]).toBe("enable");
    expect(qHeaders["anthropic-beta"]).toBe("prompt-caching-2024-07-31");
  });
});
