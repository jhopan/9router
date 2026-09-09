/**
 * Tool-name tolerance mapping (freebuff-proxy parity, issue #140).
 *
 * Upstream's free-mode gate classifies a request whose tools include NO
 * signature Codebuff tool as third-party (foreign_toolset → downgraded
 * routing / "No endpoints found", plus a sticky third_party_client trust cap
 * on the account). Agentic harnesses (Hermes, Cline, Claude Code, Codex...)
 * send their own tool names, so every one of those requests is foreign.
 *
 * Fix mirrors freebuff-proxy exactly: rename known third-party tool NAMES to
 * the official signature equivalents on the wire (schemas forwarded
 * untouched — the model fills arguments per the schema it was shown, so only
 * the NAME needs restoring), and rename back on every response path so the
 * client still sees its own names.
 *
 * Signature set: common/src/tools/constants.ts toolNames minus GENERIC
 * (apply_patch, glob, skill, web_search, write_file) plus customTool 'decide'.
 */

const CLIENT_TO_OFFICIAL = {
  // Claude Code / generic agentic CLIs
  read: "read_files",
  view: "read_files",
  edit: "str_replace",
  write: "write_file",
  bash: "run_terminal_command",
  execute: "run_terminal_command",
  ls: "list_directory",
  grep: "code_search",
  todo: "write_todos",
  todowrite: "write_todos",

  // Cline / Roo Code
  read_file: "read_files",
  write_to_file: "write_file",
  replace_in_file: "str_replace",
  execute_command: "run_terminal_command",
  list_files: "list_directory",
  search_files: "code_search",
  apply_diff: "apply_patch",
  edit_file: "str_replace",
  search_replace: "str_replace",
  search_and_replace: "str_replace",
  codebase_search: "code_search",
  update_todo_list: "write_todos",
  read_command_output: "run_terminal_command",
  editor: "str_replace",
  fetch_web: "read_url",
  search: "code_search",

  // Codex / OpenAI harnesses
  shell: "run_terminal_command",
  local_shell: "run_terminal_command",
  container_exec: "run_terminal_command",
  exec_command: "run_terminal_command",
  exec: "run_terminal_command",

  // Aider / Qwen-Code / Goose / Continue
  command: "run_terminal_command",
  replace_lines: "str_replace",
  run_shell_command: "run_terminal_command",
  grep_search: "code_search",
  todo_write: "write_todos",
  web_fetch: "read_url",
  save_memory: "write_todos",

  // Hermes / generic agent harnesses
  read_files: "read_files",
  write_file: "write_file",
  edit_file_content: "str_replace",
  run_command: "run_terminal_command",
  terminal: "run_terminal_command",
  list_dir: "list_directory",
  glob_search: "glob",
  websearch: "web_search",
  fetch_url: "read_url",
  fetch: "read_url",
  ask: "ask_user",
  ask_followup_question: "ask_user",
  attempt_completion: "task_completed",
  task_complete: "task_completed",
  think: "think_deeply",
  plan: "create_plan",
  memory_write: "add_message",
  send_message: "add_message",
};

// Upstream signature tool names (post-generic-exclusion + custom 'decide').
// A request offering AT LEAST ONE of these escapes the foreign_toolset gate.
const SIGNATURE_TOOL_NAMES = new Set([
  "add_subgoal", "add_message", "ask_user", "browser_logs", "code_search",
  "cloud_plan_ready", "create_plan", "end_turn", "find_files",
  "gravity_index", "list_directory", "lookup_agent_info",
  "propose_str_replace", "propose_write_file", "read_docs", "read_files",
  "read_subtree", "read_url", "render_ui", "run_file_change_hooks",
  "run_terminal_command", "set_messages", "set_output", "spawn_agents",
  "spawn_agent_inline", "str_replace", "suggest_followups",
  "task_completed", "think_deeply", "update_subgoal", "write_todos", "decide",
]);

function toolFunctionName(tool) {
  if (!tool || typeof tool !== "object") return "";
  if (tool.function && typeof tool.function === "object") return String(tool.function.name || "");
  return String(tool.name || "");
}

function setToolFunctionName(tool, name) {
  if (tool.function && typeof tool.function === "object") tool.function.name = name;
  else tool.name = name;
}

/**
 * Rename request tool names to signature equivalents where known.
 * Returns { renamed, mapping } — mapping: upstreamName -> clientName.
 * Tools whose names are already signature pass through untouched; unknown
 * custom tools (e.g. mcp_*, project-specific) pass through untouched too —
 * one signature tool in the set is enough to clear the gate, and renaming an
 * unknown name would break the client's dispatcher if the model calls it.
 */
export function renameRequestTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return { renamed: tools, mapping: {} };
  const mapping = {};
  const hasSignature = tools.some((t) => SIGNATURE_TOOL_NAMES.has(toolFunctionName(t).toLowerCase()));
  if (hasSignature) return { renamed: tools, mapping };
  for (const tool of tools) {
    const name = toolFunctionName(tool);
    const lower = name.toLowerCase();
    const official = CLIENT_TO_OFFICIAL[lower];
    if (official && official !== name) {
      setToolFunctionName(tool, official);
      mapping[official] = name;
    }
  }
  return { renamed: tools, mapping };
}

/** Restore client tool names on a response body (non-stream JSON). */
export function restoreResponseToolNames(data, mapping) {
  if (!mapping || Object.keys(mapping).length === 0) return data;
  const choices = data?.choices || [];
  for (const choice of choices) {
    const tcs = choice?.message?.tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const name = tc?.function?.name;
        if (name && mapping[name]) tc.function.name = mapping[name];
      }
    }
  }
  return data;
}

/** Restore client tool names on an SSE chunk line (string -> string). */
export function restoreStreamToolNames(chunkText, mapping) {
  if (!mapping || Object.keys(mapping).length === 0) return chunkText;
  if (!chunkText.includes('"tool_calls"') || !chunkText.startsWith("data:")) return chunkText;
  let out = chunkText;
  for (const [official, client] of Object.entries(mapping)) {
    if (out.includes(`"name":"${official}"`)) {
      out = out.split(`"name":"${official}"`).join(`"name":"${client}"`);
    }
  }
  return out;
}
