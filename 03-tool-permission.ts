/**
 * s03_permission — 在 s02 基础上新增三道权限闸门
 *
 * 工具执行前插入 check_permission()：
 *   Gate 1: 硬拒绝列表 (rm -rf /, sudo, ...)
 *   Gate 2: 规则匹配 (写工作区外? 危险命令?)
 *   Gate 3: 用户审批 (暂停等待确认)
 *
 * s02 的循环完全保留，只改了工具执行部分：
 *   s02: output = TOOL_HANDLERS[name](args)              // 直接执行
 *   s03: if (!checkPermission(...)) continue;             // 先过闸门
 *        output = TOOL_HANDLERS[name](args)
 *
 * Usage:
 *   cp .env.example .env  # fill in DASHSCOPE_API_KEY and MODEL_ID
 *   npx tsx 03-tool-permission.ts
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. All destructive operations require user approval. Use tools to solve tasks. Act, don't explain.`;

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

// ═══════════════════════════════════════════════════════════
// NEW in s03: Three-Gate Permission Pipeline
// ═══════════════════════════════════════════════════════════

// Gate 1: Hard deny list — always forbidden
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];

function checkDenyList(command: string): string | null {
  for (const pattern of DENY_LIST) {
    if (command.includes(pattern)) {
      return `Blocked: '${pattern}' is on the deny list`;
    }
  }
  return null;
}

// Gate 2: Rule matching — context-dependent checks
interface PermissionRule {
  tools: string[];
  check: (args: Record<string, any>) => boolean;
  message: string;
}

const PERMISSION_RULES: PermissionRule[] = [
  {
    tools: ["write_file", "edit_file"],
    check: (args) => {
      const resolved = resolve(WORKDIR, args.path || "");
      return !resolved.startsWith(WORKDIR);
    },
    message: "Writing outside workspace",
  },
  {
    tools: ["bash"],
    check: (args) => {
      const cmd: string = args.command || "";
      return ["rm ", "> /etc/", "chmod 777"].some((kw) => cmd.includes(kw));
    },
    message: "Potentially destructive command",
  },
];

function checkRules(toolName: string, args: Record<string, any>): string | null {
  for (const rule of PERMISSION_RULES) {
    if (rule.tools.includes(toolName) && rule.check(args)) {
      return rule.message;
    }
  }
  return null;
}

// Gate 3: User approval — wait for confirmation after rule match
async function askUser(toolName: string, args: Record<string, any>, reason: string): Promise<"allow" | "deny"> {
  console.log(`\n\x1b[33m⚠  ${reason}\x1b[0m`);
  console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
  const choice = await new Promise<string>((res) => rl.question("   Allow? [Y/N] ", res));
  return choice.trim().toLowerCase() === "y" || choice.trim().toLowerCase() === "yes" ? "allow" : "deny";
}

// Pipeline: all three gates chained
async function checkPermission(toolName: string, args: Record<string, any>): Promise<boolean> {
  // Gate 1: Hard deny
  if (toolName === "bash") {
    const reason = checkDenyList(args.command || "");
    if (reason) {
      console.log(`\n\x1b[31m⛔ ${reason}\x1b[0m`);
      return false;
    }
  }

  // Gate 2 + 3: Rule matching → User approval
  const reason = checkRules(toolName, args);
  if (reason) {
    const decision = await askUser(toolName, args, reason);
    if (decision === "deny") {
      return false;
    }
  }

  return true;
}

// ── The core pattern: loop until the model stops calling tools ──
// s02 的循环结构保留，新增 checkPermission() 在工具执行前
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

    // Execute each tool call via dispatch map (with permission check)
    for (const toolCall of assistantMsg.tool_calls!) {
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`\x1b[33m> ${toolCall.function.name}\x1b[0m`);

      // s03 change: run through permission pipeline before executing
      if (!(await checkPermission(toolCall.function.name, args))) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Permission denied.",
        });
        continue;
      }

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
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  console.log("s03: Permission — three-gate permission pipeline");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("\x1b[36ms03 >> \x1b[0m", resolve));

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
