import { CLAUDE_CLI_SPOOF_HEADERS } from "../shared.js";

export default {
  id: "agentrouter",
  priority: 40,
  alias: "agentrouter",
  aliases: ["AR", "ar"],
  uiAlias: "AR",
  display: {
    name: "AgentRouter",
    icon: "hub",
    color: "#7C3AED",
    textIcon: "AR",
    website: "https://agentrouter.org",
    notice: {
      apiKeyUrl: "https://agentrouter.org",
    },
  },
  category: "apikey",
  // AgentRouter is an Anthropic-compatible relay that only accepts traffic that
  // looks like the official Claude Code client (WAF gate). It requires the full
  // Claude CLI fingerprint + Stainless SDK headers, which CLAUDE_CLI_SPOOF_HEADERS
  // provides. A bare Anthropic-Version alone is rejected upstream.
  transport: {
    baseUrl: "https://agentrouter.org/v1/messages",
    format: "claude",
    urlSuffix: "?beta=true",
    headers: { ...CLAUDE_CLI_SPOOF_HEADERS },
    auth: {
      combined: true,
      header: "x-api-key",
      scheme: "raw",
    },
  },
  models: [
    { id: "claude-opus-4-6", name: "Claude 4.6 Opus" },
    { id: "claude-haiku-4-5-20251001", name: "Claude 4.5 Haiku" },
    { id: "glm-5.1", name: "GLM 5.1" },
    { id: "deepseek-v3.2", name: "DeepSeek V3.2" },
  ],
  passthroughModels: true,
  serviceKinds: ["llm"],
  features: {
    usage: true,
    usageApikey: true,
  },
};
