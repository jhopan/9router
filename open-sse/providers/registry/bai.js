export default {
  id: "bai",
  priority: 60,
  alias: "bai",
  aliases: ["BAI"],
  uiAlias: "BAI",
  display: {
    name: "B.AI",
    icon: "zap",
    color: "#7C3AED",
    textIcon: "BAI",
    website: "https://b.ai",
    notice: {
      apiKeyUrl: "https://b.ai",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.b.ai/v1/chat/completions",
    validateUrl: "https://api.b.ai/v1/models",
    auth: { combined: true, header: "Authorization", scheme: "bearer" },
  },
  // B.AI is an OpenAI-compatible credit-based relay; model catalog is dynamic —
  // list only known-good ids here and let passthroughModels cover the rest.
  models: [
    { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (Exp)" },
    { id: "minimax-m3", name: "MiniMax M3" },
  ],
  passthroughModels: true,
  serviceKinds: ["llm"],
};
