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
  category: "apikey",
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
};
