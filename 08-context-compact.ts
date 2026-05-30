/**
 * s08_context_compact — 在 s07 基础上新增四层上下文压缩管线
 *
 * s07 的技能加载和子 Agent 不变，s08 新增：
 *   + CONTEXT_LIMIT / KEEP_RECENT / PERSIST_THRESHOLD — 压缩阈值常量
 *   + snip_compact (L1) — 消息数 > 50 时裁掉中间消息
 *   + micro_compact (L2) — 旧 tool_result 替换为占位符
 *   + tool_result_budget (L3) — 大结果持久化到磁盘，上下文只留预览
 *   + compact_history (L4) — LLM 全量摘要（1 API 调用）
 *   + reactive_compact — API 返回 prompt_too_long 时应急裁剪
 *   + compact 工具 — Agent 可主动触发压缩
 *
 * 执行顺序：budget → snip → micro（与 CC 源码一致）
 * 设计原则：便宜的先跑，贵的后跑
 *
 * Usage:
 *   cp .env.example .env  # fill in DASHSCOPE_API_KEY and MODEL_ID
 *   npx tsx 08-context-compact.ts
 */
import "dotenv/config";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
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
const SKILLS_DIR = resolve(WORKDIR, "skills");

// s08: 压缩相关目录和阈值常量
const TRANSCRIPT_DIR = resolve(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = resolve(WORKDIR, ".task_outputs", "tool-results");
const CONTEXT_LIMIT = 50_000;  // 字符估算阈值，超过触发 auto compact
const KEEP_RECENT = 3;         // 保留最近 N 条 tool result 完整内容
const PERSIST_THRESHOLD = 30_000; // 单条结果超过此字节数才落盘

// ═══════════════════════════════════════════════════════════
// NEW in s07: Skill Loading — two-level on-demand knowledge injection
// ═══════════════════════════════════════════════════════════

// 解析 SKILL.md 的 YAML frontmatter
function _parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { meta: {}, body: text };
  const parts = text.split("---", 3);
  if (parts.length < 3) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of parts[1].trim().split("\n")) {
    if (line.includes(":")) {
      const [k, v] = line.split(":", 2);
      meta[k.trim()] = v.trim().replace(/^["']|["']$/g, "");
    }
  }
  return { meta, body: parts[2].trim() };
}

// 技能注册表：启动时填充，防路径遍历
const SKILL_REGISTRY: Record<string, { name: string; description: string; content: string }> = {};

function _scanSkills(): void {
  try {
    if (!statSync(SKILLS_DIR).isDirectory()) return;
  } catch {
    return;
  }
  for (const entry of readdirSync(SKILLS_DIR).sort()) {
    const dirPath = resolve(SKILLS_DIR, entry);
    try {
      if (!statSync(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const manifest = resolve(dirPath, "SKILL.md");
    try {
      const raw = readFileSync(manifest, "utf-8");
      const { meta } = _parseFrontmatter(raw);
      const name = meta.name || entry;
      const desc = meta.description || raw.split("\n")[0].replace(/^#\s*/, "").trim();
      SKILL_REGISTRY[name] = { name, description: desc, content: raw };
    } catch {
      continue;
    }
  }
}

_scanSkills();

function listSkills(): string {
  if (Object.keys(SKILL_REGISTRY).length === 0) return "(no skills found)";
  return Object.values(SKILL_REGISTRY)
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");
}

function buildSystem(): string {
  const catalog = listSkills();
  return (
    `You are a coding agent at ${WORKDIR}. ` +
    `Skills available:\n${catalog}\n` +
    `Use load_skill to get full details when needed. Before starting any multi-step task, use todo_write to plan your steps.`
  );
}

// s07: SYSTEM 现在由 buildSystem() 动态生成，包含技能目录
const SYSTEM = buildSystem();

// s06: 子 Agent 的独立 system prompt — 不委派，直接完成
const SUB_SYSTEM = `You are a coding agent at ${WORKDIR}. Complete the task you were given, then return a concise summary. Do not delegate further.`;

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
// NEW in s06: extractText — 从消息中提取文本结论
// ═══════════════════════════════════════════════════════════

function extractText(content: string | null | undefined): string {
  return content?.trim() || "";
}

// ═══════════════════════════════════════════════════════════
// NEW in s07: loadSkill — 运行时加载完整技能内容
// ═══════════════════════════════════════════════════════════

function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY[name];
  if (!skill) return `Skill not found: ${name}`;
  return skill.content;
}

// ═══════════════════════════════════════════════════════════
// NEW in s08: Four-Layer Compaction Pipeline
// ═══════════════════════════════════════════════════════════
//
// 核心原则：便宜的先跑，贵的后跑
// 执行顺序：L3(budget) → L1(snip) → L2(micro) — 与 CC 源码一致
//
// OpenAI 格式适配：tool result 是独立的 role:"tool" 消息，
// 不是 Anthropic 格式里嵌在 user 消息中的 content block。

function estimateSize(msgs: OpenAI.ChatCompletionMessageParam[]): number {
  return JSON.stringify(msgs).length;
}

// L1: snip_compact — 消息数 > 50 时裁掉中间，保留头 3 + 尾部
function snipCompact(messages: OpenAI.ChatCompletionMessageParam[], maxMessages = 50): OpenAI.ChatCompletionMessageParam[] {
  if (messages.length <= maxMessages) return [...messages];
  const keepHead = 3;
  const keepTail = maxMessages - keepHead;
  const snipped = messages.length - keepHead - keepTail;
  return [
    ...messages.slice(0, keepHead),
    { role: "user", content: `[snipped ${snipped} messages from conversation middle]` },
    ...messages.slice(-keepTail),
  ];
}

// L2: micro_compact — 旧 tool result 替换为占位符（OpenAI: role:"tool" 消息）
function microCompact(messages: OpenAI.ChatCompletionMessageParam[]): void {
  const toolIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolIndices.push(i);
  }
  if (toolIndices.length <= KEEP_RECENT) return;
  for (const i of toolIndices.slice(0, -KEEP_RECENT)) {
    const msg = messages[i] as any;
    if (typeof msg.content === "string" && msg.content.length > 120) {
      msg.content = "[Earlier tool result compacted. Re-run if needed.]";
    }
  }
}

// L3: persist_large_output — 单条大结果落盘，上下文只留预览
function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = resolve(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!existsSync(filePath)) writeFileSync(filePath, output, "utf-8");
  return `\nFull output: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n`;
}

// L3: tool_result_budget — 统计 tool 消息总大小，超限则从最大的开始落盘
function toolResultBudget(messages: OpenAI.ChatCompletionMessageParam[], maxBytes = 200_000): void {
  const toolEntries: { idx: number; msg: any }[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") {
      toolEntries.push({ idx: i, msg: messages[i] as any });
    }
  }
  if (toolEntries.length === 0) return;

  let total = toolEntries.reduce((sum, e) => sum + (e.msg.content || "").length, 0);
  if (total <= maxBytes) return;

  // 按内容大小降序排列，从最大的开始落盘
  const ranked = [...toolEntries].sort((a, b) => (b.msg.content || "").length - (a.msg.content || "").length);
  for (const entry of ranked) {
    if (total <= maxBytes) break;
    const content = entry.msg.content || "";
    if (content.length <= PERSIST_THRESHOLD) continue;
    const tid = entry.msg.tool_call_id || "unknown";
    const persisted = persistLargeOutput(tid, content);
    total -= content.length - persisted.length;
    entry.msg.content = persisted;
  }
}

// L4: write_transcript — 保存完整对话到 .transcripts/
function writeTranscript(messages: OpenAI.ChatCompletionMessageParam[]): string {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(filePath, lines, "utf-8");
  return filePath;
}

// L4: summarize_history — 用 LLM 生成对话摘要（1 API 调用）
async function summarizeHistory(messages: OpenAI.ChatCompletionMessageParam[]): Promise<string> {
  const conversation = JSON.stringify(messages).slice(0, 80_000);
  const prompt =
    "Summarize this coding-agent conversation so work can continue.\n" +
    "Preserve: 1. current goal, 2. key findings/decisions, 3. files read/changed, " +
    "4. remaining work, 5. user constraints.\nBe compact but concrete.\n\n" + conversation;

  const response = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
  });
  return response.choices[0]?.message?.content?.trim() || "(empty summary)";
}

// L4: compact_history — 保存 transcript + LLM 摘要，替换全部消息
async function compactHistory(messages: OpenAI.ChatCompletionMessageParam[]): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = await summarizeHistory(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

// Emergency: reactive_compact — API 报 prompt_too_long 时应急裁剪
async function reactiveCompact(messages: OpenAI.ChatCompletionMessageParam[]): Promise<OpenAI.ChatCompletionMessageParam[]> {
  writeTranscript(messages);
  const summary = await summarizeHistory(messages);
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(-5),
  ];
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
  // s06: task tool — spawn subagent
  {
    type: "function",
    function: {
      name: "task",
      description: "Launch a subagent to handle a complex subtask. Returns only the final conclusion.",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Description of the task for the subagent." },
        },
        required: ["description"],
      },
    },
  },
  // s07: skill tool — catalog is already in SYSTEM prompt, this loads full content
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "Load the full content of a skill by name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill name to load." },
        },
        required: ["name"],
      },
    },
  },
  // s08: compact tool — Agent 可主动触发压缩
  {
    type: "function",
    function: {
      name: "compact",
      description: "Summarize earlier conversation to free context space.",
      parameters: {
        type: "object",
        properties: {
          focus: { type: "string", description: "Optional focus area for the summary." },
        },
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
  // s07: skill loading handler
  load_skill: (args) => loadSkill(args.name),
};

// ═══════════════════════════════════════════════════════════
// NEW in s06: Subagent — 子 Agent 工具定义 + 分发 + spawn
// ═══════════════════════════════════════════════════════════

// 子 Agent 工具：基础工具，没有 task（禁止递归 spawn）
const SUB_TOOLS: OpenAI.ChatCompletionTool[] = [
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
        properties: { path: { type: "string" } },
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

// 子 Agent 分发映射：没有 task，没有 todo_write
const SUB_HANDLERS: Record<string, (args: Record<string, any>) => string> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  glob: (args) => runGlob(args.pattern),
};

// spawnSubagent — 创建独立 messages[]，跑自己的循环，只回传结论
async function spawnSubagent(description: string): Promise<string> {
  console.log(`\n\x1b[35m[Subagent spawned]\x1b[0m`);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "user", content: description },
  ];

  for (let turn = 0; turn < 30; turn++) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "system", content: SUB_SYSTEM }, ...messages],
      tools: SUB_TOOLS,
      max_tokens: 8000,
    });

    const choice = response.choices[0];
    const assistantMsg = choice.message;
    messages.push(assistantMsg);

    if (choice.finish_reason !== "tool_calls") {
      break;
    }

    // 执行子 Agent 的工具调用
    for (const toolCall of assistantMsg.tool_calls!) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      // 子 Agent 也经过权限 hook
      const blocked = await triggerHooks("PreToolUse", toolName, args);
      if (blocked) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: blocked,
        });
        continue;
      }

      const handler = SUB_HANDLERS[toolName];
      const output = handler ? handler(args) : `Unknown: ${toolName}`;
      console.log(` \x1b[90m[sub] ${toolName}: ${output.slice(0, 100)}\x1b[0m`);

      await triggerHooks("PostToolUse", toolName, args, output);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output,
      });
    }
  }

  // 提取最后的文本结论
  let result = extractText(
    (messages[messages.length - 1] as { content?: string }).content
  );

  // fallback：如果最后一条是 tool 消息，往前找 assistant 的文本
  if (!result) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        result = extractText((msg as { content?: string }).content);
        if (result) break;
      }
    }
  }
  if (!result) {
    result = "Subagent stopped after 30 turns without final answer.";
  }

  console.log(`\x1b[35m[Subagent done]\x1b[0m`);
  return result;
}

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
// agent_loop — s08 core: 压缩管线在每轮 LLM 调用前执行
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1;
let roundsSinceTodo = 0;

async function agentLoop(messages: OpenAI.ChatCompletionMessageParam[]) {
  let reactiveRetries = 0;

  while (true) {
    // s05: nag reminder — 连续 3 轮没更新 todo 就注入提醒
    if (roundsSinceTodo >= 3 && messages.length > 0) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    // s08: 三层预处理器（0 API 调用，便宜的先跑）
    // 顺序与 CC 源码一致：budget → snip → micro
    toolResultBudget(messages);  // L3: 大结果落盘（必须先于 micro，否则内容被占位后就无法落盘了）
    const snipped = snipCompact(messages);  // L1: 裁中间
    messages.length = 0;
    messages.push(...snipped);
    microCompact(messages);  // L2: 旧结果占位

    // s08: 前三层跑完仍然超阈值 → LLM 全量摘要（1 API 调用）
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      const compacted = await compactHistory(messages);
      messages.length = 0;
      messages.push(...compacted);
    }

    // s08: LLM 调用，带 reactive compact 错误处理
    let response: OpenAI.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
        tools: TOOLS,
        max_tokens: 8000,
      });
      reactiveRetries = 0;
    } catch (e: any) {
      const errMsg = (e?.message || "").toLowerCase();
      if (
        (errMsg.includes("too many tokens") || errMsg.includes("context length") || errMsg.includes("prompt_too_long")) &&
        reactiveRetries < MAX_REACTIVE_RETRIES
      ) {
        console.log("[reactive compact]");
        const compacted = await reactiveCompact(messages);
        messages.length = 0;
        messages.push(...compacted);
        reactiveRetries++;
        continue;
      }
      throw e;
    }

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

    // s08: compact 工具需要延迟处理——先收集所有 tool result，再统一压缩
    // 这样保证 OpenAI 格式的消息完整性（每个 tool_call 都有对应的 tool result）
    let compactTriggered = false;

    for (const toolCall of assistantMsg.tool_calls!) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      // s08: compact 工具 — 标记延迟压缩，先返回占位结果
      if (toolName === "compact") {
        compactTriggered = true;
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "[Compacting...]",
        });
        continue;
      }

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

      // s06: task 工具走 spawnSubagent（异步），不走 TOOL_HANDLERS
      let output: string;
      if (toolName === "task") {
        output = await spawnSubagent(args.description);
      } else {
        const handler = TOOL_HANDLERS[toolName];
        output = handler ? handler(args) : `Unknown tool: ${toolName}`;
      }
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

    // s08: 所有 tool result 收集完毕后，执行延迟的压缩
    if (compactTriggered) {
      const compacted = await compactHistory(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
  }
}

// ── Entry point ──────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function main() {
  console.log("s08: Context Compact — four-layer compaction pipeline");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("\x1b[36ms08 >> \x1b[0m", resolve));

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
