import { describe, it, expect } from "vitest";
import { renameRequestTools, restoreResponseToolNames, restoreStreamToolNames } from "../../open-sse/executors/freebuffToolMap.js";

const fn = (name) => ({ type: "function", function: { name, parameters: { type: "object", properties: {} } } });

describe("renameRequestTools", () => {
  it("renames harness tool names to signature equivalents and records mapping", () => {
    const tools = [fn("bash"), fn("read_file"), fn("write_to_file")];
    const { renamed, mapping } = renameRequestTools(tools);
    expect(renamed.map((t) => t.function.name)).toEqual(["run_terminal_command", "read_files", "write_file"]);
    expect(mapping).toEqual({ run_terminal_command: "bash", read_files: "read_file", write_file: "write_to_file" });
  });

  it("leaves tools untouched when one is already signature", () => {
    const tools = [fn("bash"), fn("think_deeply")];
    const { renamed, mapping } = renameRequestTools(tools);
    expect(renamed.map((t) => t.function.name)).toEqual(["bash", "think_deeply"]);
    expect(mapping).toEqual({});
  });

  it("ignores unknown custom tools (mcp_*, project tools)", () => {
    const tools = [fn("mcp_vps_exec"), fn("calc")];
    const { renamed, mapping } = renameRequestTools(tools);
    expect(renamed.map((t) => t.function.name)).toEqual(["mcp_vps_exec", "calc"]);
    expect(mapping).toEqual({});
  });

  it("handles OpenAI-shaped and flat tools", () => {
    const flat = [{ name: "shell", parameters: {} }];
    const { renamed, mapping } = renameRequestTools(flat);
    expect(renamed[0].name).toBe("run_terminal_command");
    expect(mapping.run_terminal_command).toBe("shell");
  });

  it("no tools → no-op", () => {
    const { renamed, mapping } = renameRequestTools([]);
    expect(renamed).toEqual([]);
    expect(mapping).toEqual({});
  });
});

describe("restoreResponseToolNames", () => {
  it("restores names in JSON choices[].message.tool_calls", () => {
    const mapping = { run_terminal_command: "bash" };
    const data = { choices: [{ message: { role: "assistant", tool_calls: [{ id: "1", function: { name: "run_terminal_command", arguments: "{}" } }] } }] };
    restoreResponseToolNames(data, mapping);
    expect(data.choices[0].message.tool_calls[0].function.name).toBe("bash");
  });

  it("no mapping → untouched", () => {
    const data = { choices: [{ message: { tool_calls: [{ function: { name: "bash" } }] } }] };
    restoreResponseToolNames(data, {});
    expect(data.choices[0].message.tool_calls[0].function.name).toBe("bash");
  });
});

describe("restoreStreamToolNames", () => {
  it("rewrites SSE data lines containing renamed tool calls", () => {
    const mapping = { run_terminal_command: "bash" };
    const line = 'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"run_terminal_command","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}';
    const out = restoreStreamToolNames(line, mapping);
    expect(out).toContain('"name":"bash"');
    expect(out).not.toContain('"name":"run_terminal_command"');
  });

  it("passes through lines without tool_calls or non-data lines", () => {
    const mapping = { run_terminal_command: "bash" };
    expect(restoreStreamToolNames("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}", mapping)).not.toContain("bash");
    expect(restoreStreamToolNames(": connected", mapping)).toBe(": connected");
  });
});
