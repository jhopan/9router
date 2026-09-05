export default {
  id: "freebuff",
  priority: 60,
  alias: "freebuff",
  aliases: ["fb", "FB"],
  uiAlias: "fb",
  display: {
    name: "FreeBuff",
    icon: "bolt",
    color: "#F59E0B",
    textIcon: "FB",
    website: "https://codebuff.com",
    notice: {
      apiKeyUrl: "https://codebuff.com",
    },
  },
  category: "oauth",
  authModes: ["oauth", "apikey"],
  transport: {
    baseUrl: "https://www.codebuff.com/api/v1/chat/completions",
    validateUrl: "https://www.codebuff.com/api/v1/models",
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
  },
  // FreeBuff/Codebuff free-tier coding models (upstream agent mapping lives in
  // executors/freebuff.js). Quota is per-account daily sessions; multi-account
  // is handled by 9router connections (fallback drain — NEVER round-robin).
  models: [
    { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
    { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "mimo/mimo-v2.5", name: "MiMo 2.5" },
    { id: "openai/gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { id: "minimax/minimax-m3", name: "MiniMax M3" },
  ],
  passthroughModels: true,
  serviceKinds: ["llm"],
  // Browser login flow (mirrors the official CLI: POST /api/auth/cli/code with a
  // fresh fingerprintId → open loginUrl on ANY device → poll /api/auth/cli/status
  // until user.authToken arrives). Consumed by src/lib/oauth/providers/freebuff.js.
  oauth: {
    baseUrl: "https://www.codebuff.com",
    codeUrl: "https://www.codebuff.com/api/auth/cli/code",
    statusUrl: "https://www.codebuff.com/api/auth/cli/status",
    userAgent: "Bun/1.3.14",
    pollInterval: 5000,
    timeoutMs: 300000,
  },
};
