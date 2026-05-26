/**
 * s05_todo_write — 在 s04 基础上新增 todo_write 规划工具
 *
 * s04 的工具集不变，s05 新增：
 *   + todo_write 工具 — Agent 动手前先列步骤，更新状态
 *   + rounds_since_todo 计数器 — 连续 3 轮没更新 todo 就注入提醒
 *   + SYSTEM 提示加入 "先计划再执行" 引导
 *
 * 工具执行部分：
 *   s04: TOOL_HANDLERS 里只有 5 个工具
 *   s05: 新增 todo_write → runTodoWrite，保存到 CURRENT_TODOS
 *
 * Usage:
 *   cp .env.example .env  # fill in DASHSCOPE_API_KEY and MODEL_ID
 *   npx tsx 05-todo-write.ts
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Before starting any multi-step task, use todo_write to plan your steps. Update status as you go.`;

// s05: in-memory TODO state
let CURRENT_TODOS: { content: string; status: "pending" | "in_progress" | "completed" }[] = [];

// ═══════════════════════════════════════════════════════════
// FROM s01-s04 (unchanged): Tool Implementations
// ═══════════════════════════════════════════════════════════

function safePath(p: string): string {
  const resolved = resolve(WORKDIR, p);
  if (!resolved.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

function runBash(command: string): string {
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
// NEW in s05: todo_write tool — plan only, no execution
// ═══════════════════════════════════════════════════════════

function runTodoWrite(todos: { content: string; status: string }[]): string {
  for (let i = 0; i < todos.length; i++) {
    if (!todos[i].content || !todos[i].status) {
      return `Error: todos[${i}] missing 'content' or 'status'`;
    }
    if (!["pending", "in_progress", "completed"].includes(todos[i].status)) {
      return `Error: todos[${i}] has invalid status '${todos[i].status}'`;
    }
  }

  CURRENT_TODOS = todos as typeof CURRENT_TODOS;

  const lines = [`\n\x1b[33m## Current Tasks\x1b[0m`];
  for (const t of CURRENT_TODOS) {
    const icon: Record<string, string> = {
      pending: " ",
      in_progress: "\x1b[36m▸\x1b[0m",
      completed: "\x1b[32m✓\x1b[0m",
    };
    lines.push(`  [${icon[t.status]}] ${t.content}`);
  }
  console.log(lines.join("\n"));
  return `Updated ${CURRENT_TODOS.length} tasks`;
}

// ═══════════════════════════════════════════════════════════
// FROM s02-s04 (unchanged): 工具定义 + 分发映射
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
  // s05: new tool
  {
    type: "function",
    function: {
      name: "todo_write",
      description: "Create and manage a task list for your current coding session.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
];

const TOOL_HANDLERS: Record<string, (args: Record<string, any>) => string> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  glob: (args) => runGlob(args.pattern),
  // s05: new handler
  todo_write: (args) => runTodoWrite(args.todos),
};

// ═══════════════════════════════════════════════════════════
// NEW in s04: Hook System
// s03 的权限逻辑从循环体移到 hook，循环只调用 trigger_hooks()
// ═══════════════════════════════════════════════════════════

type HookCallback = (...args: any[]) => Promise<string | null> | string | null;

const HOOKS: Record<string, HookCallback[]> = {
  UserPromptSubmit: [],
  PreToolUse: [],
  PostToolUse: [],
  Stop: [],
};

function registerHook(event: string, callback: HookCallback): void {
  HOOKS[event].push(callback);
}

async function triggerHooks(event: string, ...args: any[]): Promise<string | null> {
  for (const callback of HOOKS[event]) {
    const result = await callback(...args);
    if (result !== null) {
      return result;
    }
  }
  return null;
}

// ── Hook implementations ──────────────────────────────────

// s03 的权限常量，现在在 hook 里使用
const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

// PreToolUse: 权限检查（s03 的 checkPermission 逻辑移到这里）
async function permissionHook(toolName: string, args: Record<string, any>): Promise<string | null> {
  if (toolName === "bash") {
    const cmd = (args.command as string) || "";
    for (const pattern of DENY_LIST) {
      if (cmd.includes(pattern)) {
        console.log(`\n\x1b[31m⛔ Blocked: '${pattern}'\x1b[0m`);
        return "Permission denied by deny list";
      }
    }
    for (const kw of DESTRUCTIVE) {
      if (cmd.includes(kw)) {
        console.log(`\n\x1b[33m⚠  Potentially destructive command\x1b[0m`);
        console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
        const choice = await new Promise<string>((res) => rl.question("   Allow? [Y/N] ", res));
        if (!["y", "yes"].includes(choice.trim().toLowerCase())) {
          return "Permission denied by user";
        }
      }
    }
  }
  if (toolName === "write_file" || toolName === "edit_file") {
    const p = (args.path as string) || "";
    const resolved = resolve(WORKDIR, p);
    if (!resolved.startsWith(WORKDIR)) {
      console.log(`\n\x1b[33m⚠  Writing outside workspace\x1b[0m`);
      console.log(`   Tool: ${toolName}(${JSON.stringify(args)})`);
      const choice = await new Promise<string>((res) => rl.question("   Allow? [Y/N] ", res));
      if (!["y", "yes"].includes(choice.trim().toLowerCase())) {
        return "Permission denied by user";
      }
    }
  }
  return null;
}

// PreToolUse: 日志记录
function logHook(toolName: string, args: Record<string, any>): string | null {
  const values = Object.values(args).slice(0, 2);
  const preview = JSON.stringify(values).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${toolName}(${preview})\x1b[0m`);
  return null;
}

// PostToolUse: 大输出警告
function largeOutputHook(toolName: string, _args: Record<string, any>, output: string): string | null {
  if (output.length > 100_000) {
    console.log(`\x1b[33m[HOOK] ⚠ Large output from ${toolName}: ${output.length} chars\x1b[0m`);
  }
  return null;
}

// UserPromptSubmit: 注入上下文信息
function contextInjectHook(_query: string): string | null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

// Stop: 打印会话统计
function summaryHook(messages: OpenAI.ChatCompletionMessageParam[]): string | null {
  const toolCount = messages.filter((m) => m.role === "tool").length;
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
  return null;
}

// 注册所有 hook
registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);

// ═══════════════════════════════════════════════════════════
// agent_loop — 与 s04 结构一致 + nag reminder 计数器
// ═══════════════════════════════════════════════════════════

let roundsSinceTodo = 0;

async function agentLoop(messages: OpenAI.ChatCompletionMessageParam[]) {
  while (true) {
    // s05: nag reminder — 连续 3 轮没更新 todo 就注入提醒
    if (roundsSinceTodo >= 3 && messages.length > 0) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SYSTEM }, ...messages],
      tools: TOOLS,
      max_tokens: 8000,
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;

    messages.push(assistantMsg);

    if (choice.finish_reason !== "tool_calls") {
      // s05: Stop hook — 退出前触发，可强制续跑
      const force = await triggerHooks("Stop", messages);
      if (force) {
        messages.push({ role: "user", content: force });
        continue;
      }
      if (assistantMsg.content) {
        console.log(assistantMsg.content);
      }
      return;
    }

    for (const toolCall of assistantMsg.tool_calls!) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      // s05: 每轮工具调用递增计数器
      roundsSinceTodo++;

      // s04: hook 替代硬编码的 checkPermission()
      const blocked = await triggerHooks("PreToolUse", toolName, args);
      if (blocked) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: blocked,
        });
        continue;
      }

      const handler = TOOL_HANDLERS[toolName];
      const output = handler ? handler(args) : `Unknown tool: ${toolName}`;
      console.log(output.slice(0, 200));

      // s05: 重置计数器当 todo_write 被调用
      if (toolName === "todo_write") {
        roundsSinceTodo = 0;
      }

      // s04: PostToolUse hook
      await triggerHooks("PostToolUse", toolName, args, output);

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
  console.log("s05: TodoWrite — plan before execute, nag if you forget");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("\x1b[36ms05 >> \x1b[0m", resolve));

  const history: OpenAI.ChatCompletionMessageParam[] = [];

  while (true) {
    const query = (await ask()).trim();
    if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") break;

    // s04: UserPromptSubmit hook — 进入 LLM 之前触发
    await triggerHooks("UserPromptSubmit", query);

    history.push({ role: "user", content: query });
    await agentLoop(history);
    console.log();
  }

  rl.close();
}

main();
