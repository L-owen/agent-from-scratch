/**
 * s02_tool_use — 在 s01 基础上新增 4 个工具 + 分发映射
 *
 * 循环本身（agent_loop）与 s01 完全一致，只改了工具执行部分：
 *   s01: output = runBash(args.command)          // 硬编码
 *   s02: output = TOOL_HANDLERS[name](args)      // 查表分发
 *
 * Usage:
 *   cp .env.example .env  # fill in DASHSCOPE_API_KEY and MODEL_ID
 *   npx tsx 02-tool-use.ts
 */
import "dotenv/config";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { globSync } from "glob";

// ── Client setup (阿里百炼兼容 OpenAI 接口) ───────────────
const apiKey = process.env.DASHSCOPE_API_KEY;
const MODEL = process.env.MODEL_ID || "qwen-plus";

if (!apiKey) {
  console.error("Error: DASHSCOPE_API_KEY is not set. Copy .env.example to .env and fill it in.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// ═══════════════════════════════════════════════════════════
// FROM s01 (unchanged)
// ═══════════════════════════════════════════════════════════

function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: WORKDIR,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim().slice(0, 50_000) || "(no output)";
  } catch (e: any) {
    const combined = ((e.stdout || "") + (e.stderr || "")).trim();
    return combined.slice(0, 50_000) || `Error: ${e.message}`;
  }
}

// ═══════════════════════════════════════════════════════════
// NEW in s02: safe_path + 4 个新工具
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runRead(path: string, limit?: number): string {
  try {
    const lines = readFileSync(safePath(path), "utf-8").split("\n");
    if (limit && limit < lines.length) {
      lines.splice(limit, lines.length - limit, `... (${lines.length - limit} more lines)`);
    }
    return lines.join("\n");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runWrite(path: string, content: string): string {
  try {
    const filePath = safePath(path);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runEdit(path: string, old_text: string, new_text: string): string {
  try {
    const filePath = safePath(path);
    const text = readFileSync(filePath, "utf-8");
    if (!text.includes(old_text)) {
      return `Error: text not found in ${path}`;
    }
    writeFileSync(filePath, text.replace(old_text, new_text));
    return `Edited ${path}`;
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

function runGlob(pattern: string): string {
  try {
    const matches = globSync(pattern, { cwd: WORKDIR, ignore: "node_modules/**" });
    return matches.length ? matches.join("\n") : "(no matches)";
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

// ═══════════════════════════════════════════════════════════
// NEW in s02: 工具定义（s01 只有一个 bash，现在扩展到 5 个）
// ═══════════════════════════════════════════════════════════

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read file contents.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, limit: { type: "integer" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace exact text in a file once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" } },
        required: ["pattern"],
      },
    },
  },
];

// ═══════════════════════════════════════════════════════════
// NEW in s02: 工具分发映射
// s01 是硬编码 runBash，现在改为查表
// ═══════════════════════════════════════════════════════════

const TOOL_HANDLERS: Record<string, (args: Record<string, any>) => string> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  glob: (args) => runGlob(args.pattern),
};

// ── The core pattern: loop until the model stops calling tools ──
// 与 s01 结构完全一致，只改了工具执行部分
async function agentLoop(messages: OpenAI.ChatCompletionMessageParam[]) {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    // Append assistant turn
    messages.push(assistantMsg);

    // If the model didn't call a tool, we're done
    if (choice.finish_reason !== "tool_calls") {
      if (assistantMsg.content) {
        console.log(assistantMsg.content);
      }
      return;
    }

    // Execute each tool call via dispatch map
    for (const toolCall of assistantMsg.tool_calls!) {
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`\x1b[33m> ${toolCall.function.name}\x1b[0m`);

      const handler = TOOL_HANDLERS[toolCall.function.name];
      const output = handler ? handler(args) : `Unknown tool: ${toolCall.function.name}`;
      console.log(output.slice(0, 200));

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output,
      });
    }
  }
}

// ── Entry point ──────────────────────────────────────────
async function main() {
  console.log("s02: Tool Use — 5 tools with dispatch map");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("\x1b[36ms02 >> \x1b[0m", resolve));

  const history: OpenAI.ChatCompletionMessageParam[] = [];

  while (true) {
    const query = (await ask()).trim();
    if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") break;

    history.push({ role: "user", content: query });
    await agentLoop(history);
    console.log();
  }

  rl.close();
}

main();
