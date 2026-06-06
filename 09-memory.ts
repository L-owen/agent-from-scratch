/**
 * s09_memory — 在 s08 基础上新增持久化记忆系统
 *
 * s08 的四层压缩管线保留，s09 新增：
 *   + .memory/ 目录 — 每个记忆一个 .md 文件（YAML frontmatter）
 *   + MEMORY.md — 索引（一行一个记忆，注入 SYSTEM）
 *   + write_memory_file — 写入记忆文件 + 自动重建索引
 *   + select_relevant_memories — LLM side-query 选相关记忆（关键词降级）
 *   + load_memories — 按需加载记忆内容注入当前 user turn
 *   + extract_memories — 每轮结束后从对话中提取新记忆
 *   + consolidate_memories — 记忆文件超过阈值时合并去重（Dream）
 *
 * 四类记忆：user / feedback / project / reference
 *
 * Usage:
 *   cp .env.example .env  # fill in DASHSCOPE_API_KEY and MODEL_ID
 *   npx tsx 09-memory.ts
 */
import "dotenv/config";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync,
  unlinkSync,
} from "node:fs";
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

// s09: 记忆目录和索引
const MEMORY_DIR = resolve(WORKDIR, ".memory");
const MEMORY_INDEX = resolve(MEMORY_DIR, "MEMORY.md");
mkdirSync(MEMORY_DIR, { recursive: true });

const SKILLS_DIR = resolve(WORKDIR, "skills");
const TRANSCRIPT_DIR = resolve(WORKDIR, ".transcripts");
const TOOL_RESULTS_DIR = resolve(WORKDIR, ".task_outputs", "tool-results");

// s08: 压缩阈值常量
const CONTEXT_LIMIT = 50_000;
const KEEP_RECENT = 3;
const PERSIST_THRESHOLD = 30_000;

// s09: 记忆整理阈值
const CONSOLIDATE_THRESHOLD = 10;

// ═══════════════════════════════════════════════════════════
// NEW in s09: Memory System
// ═══════════════════════════════════════════════════════════

const MEMORY_TYPES = ["user", "feedback", "project", "reference"];

function parseMemoryFrontmatter(text: string): { meta: Record<string, string>; body: string } {
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

// 写入单个记忆文件，自动重建索引
function writeMemoryFile(name: string, memType: string, description: string, body: string): string {
  const slug = name.toLowerCase().replace(/\s+/g, "-").replace(/\/+/g, "-");
  const filename = `${slug}.md`;
  const filepath = resolve(MEMORY_DIR, filename);
  writeFileSync(filepath,
    `---\nname: ${name}\ndescription: ${description}\ntype: ${memType}\n---\n\n${body}\n`,
    "utf-8",
  );
  rebuildIndex();
  return filepath;
}

// 重建 MEMORY.md 索引
function rebuildIndex(): void {
  const lines: string[] = [];
  const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md").sort();
  for (const f of files) {
    const raw = readFileSync(resolve(MEMORY_DIR, f), "utf-8");
    const { meta, body } = parseMemoryFrontmatter(raw);
    const name = meta.name || f.replace(/\.md$/, "");
    const desc = meta.description || body.split("\n")[0].slice(0, 80);
    lines.push(`- [${name}](${f}) — ${desc}`);
  }
  writeFileSync(MEMORY_INDEX, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
}

// 读取 MEMORY.md 索引（注入 SYSTEM）
function readMemoryIndex(): string {
  if (!existsSync(MEMORY_INDEX)) return "";
  const text = readFileSync(MEMORY_INDEX, "utf-8").trim();
  return text || "";
}

// 读取单个记忆文件的完整内容
function readMemoryFile(filename: string): string | null {
  const path = resolve(MEMORY_DIR, filename);
  if (!path.startsWith(MEMORY_DIR) || !existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

// 列出所有记忆文件的元数据
function listMemoryFiles(): { filename: string; name: string; description: string; type: string; body: string }[] {
  const result: { filename: string; name: string; description: string; type: string; body: string }[] = [];
  const files = readdirSync(MEMORY_DIR).filter(f => f.endsWith(".md") && f !== "MEMORY.md").sort();
  for (const f of files) {
    const raw = readFileSync(resolve(MEMORY_DIR, f), "utf-8");
    const { meta, body } = parseMemoryFrontmatter(raw);
    result.push({
      filename: f,
      name: meta.name || f.replace(/\.md$/, ""),
      description: meta.description || "",
      type: meta.type || "user",
      body,
    });
  }
  return result;
}

// LLM side-query 选相关记忆（关键词降级）
async function selectRelevantMemories(
  messages: OpenAI.ChatCompletionMessageParam[],
  maxItems = 5,
): Promise<string[]> {
  const files = listMemoryFiles();
  if (files.length === 0) return [];

  // 收集最近的 user 消息文本
  const recentTexts: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.trim()) recentTexts.push(content);
    }
    // 收集最近三条role: user信息
    if (recentTexts.length >= 3) break;
  }
  const recent = recentTexts.reverse().join(" ").slice(0, 2000);
  if (!recent.trim()) return [];

  // 构建目录供 LLM 选择
  const catalog = files.map((f, i) => `${i}: ${f.name} — ${f.description}`).join("\n");

  const prompt =
    "Given the recent conversation and the memory catalog below, " +
    "select the indices of memories that are clearly relevant. " +
    "Return ONLY a JSON array of integers, e.g. [0, 3]. " +
    "If none are relevant, return [].\n\n" +
    `Recent conversation:\n${recent}\n\n` +
    `Memory catalog:\n${catalog}`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const text = (response.choices[0]?.message?.content || "").trim();
    const match = text.match(/\[[\s\S]*?\]/);
    if (match) {
      const indices: number[] = JSON.parse(match[0]);
      const selected: string[] = [];
      for (const idx of indices) {
        if (Number.isInteger(idx) && idx >= 0 && idx < files.length) {
          selected.push(files[idx].filename);
        }
        if (selected.length >= maxItems) break;
      }
      return selected;
    }
  } catch {
    // 降级到关键词匹配
  }

  // Fallback: 关键词匹配 name + description
  const keywords = recent.split(/\s+/).filter(w => w.length > 3).map(w => w.toLowerCase());
  const selected: string[] = [];
  for (const f of files) {
    const text = (f.name + " " + f.description).toLowerCase();
    if (keywords.some(kw => text.includes(kw))) {
      selected.push(f.filename);
      if (selected.length >= maxItems) break;
    }
  }
  return selected;
}

// 加载相关记忆内容，注入当前 user turn
async function loadMemories(messages: OpenAI.ChatCompletionMessageParam[]): Promise<string> {
  const selectedFiles = await selectRelevantMemories(messages);
  if (selectedFiles.length === 0) return "";
  const parts: string[] = [];
  for (const filename of selectedFiles) {
    const content = readMemoryFile(filename);
    if (content) parts.push(content);
  }
  return parts.join("\n\n");
}

// 从对话中提取新记忆（每轮结束后运行）
async function extractMemories(messages: OpenAI.ChatCompletionMessageParam[]): Promise<void> {
  // 收集最近对话文本
  const dialogueParts: string[] = [];
  const recent = messages.slice(-10);
  for (const msg of recent) {
    const role = msg.role;
    const content = typeof msg.content === "string" ? msg.content : "";
    if (content.trim()) {
      dialogueParts.push(`${role}: ${content}`);
    }
  }
  const dialogue = dialogueParts.join("\n");
  if (!dialogue.trim()) return;

  // 检查已有记忆避免重复
  const existing = listMemoryFiles();
  const existingDesc = existing.length
    ? existing.map(m => `- ${m.name}: ${m.description}`).join("\n")
    : "(none)";

  const prompt =
    "Extract user preferences, constraints, or project facts from this dialogue.\n" +
    "Return a JSON array. Each item: {name, type, description, body}.\n" +
    "- name: short kebab-case identifier (e.g. 'user-preference-tabs')\n" +
    "- type: one of 'user' (user preference), 'feedback' (guidance), " +
    "'project' (project fact), 'reference' (external pointer)\n" +
    "- description: one-line summary for index lookup\n" +
    "- body: full detail in markdown\n" +
    "If nothing new or already covered by existing memories, return [].\n\n" +
    `Existing memories:\n${existingDesc}\n\n` +
    `Dialogue:\n${dialogue.slice(0, 4000)}`;

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
    });
    const text = (response.choices[0]?.message?.content || "").trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items: { name?: string; type?: string; description?: string; body?: string }[] = JSON.parse(match[0]);
    if (!items || items.length === 0) return;

    let count = 0;
    for (const mem of items) {
      const name = mem.name || `memory_${Date.now()}`;
      const memType = mem.type || "user";
      const desc = mem.description || "";
      const body = mem.body || "";
      if (desc && body) {
        writeMemoryFile(name, memType, desc, body);
        count++;
      }
    }
    if (count) {
      console.log(`\n\x1b[33m[Memory: extracted ${count} new memories]\x1b[0m`);
    }
  } catch {
    // 提取失败不影响主流程
  }
}

// 合并去重记忆（文件数 >= 阈值时触发）
async function consolidateMemories(): Promise<void> {
  const files = listMemoryFiles();
  if (files.length < CONSOLIDATE_THRESHOLD) return;

  const catalog = files.map(
    f => `## ${f.filename}\nname: ${f.name}\ndescription: ${f.description}\n${f.body}`,
  ).join("\n\n");

  const prompt =
    "Consolidate the following memory files. Rules:\n" +
    "1. Merge duplicates into one\n" +
    "2. Remove outdated/contradicted memories\n" +
    "3. Keep the total under 30 memories\n" +
    "4. Preserve important user preferences above all\n" +
    "Return a JSON array. Each item: {name, type, description, body}.\n\n" +
    catalog.slice(0, 16000);

  try {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 3000,
    });
    const text = (response.choices[0]?.message?.content || "").trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return;
    const items: { name?: string; type?: string; description?: string; body?: string }[] = JSON.parse(match[0]);

    // 删除旧记忆文件（保留 MEMORY.md）
    for (const f of readdirSync(MEMORY_DIR)) {
      if (f.endsWith(".md") && f !== "MEMORY.md") {
        unlinkSync(resolve(MEMORY_DIR, f));
      }
    }

    for (const mem of items) {
      const name = mem.name || `memory_${Date.now()}`;
      const memType = mem.type || "user";
      const desc = mem.description || "";
      const body = mem.body || "";
      if (desc && body) {
        writeMemoryFile(name, memType, desc, body);
      }
    }
    console.log(`\n\x1b[33m[Memory: consolidated ${files.length} → ${items.length} memories]\x1b[0m`);
  } catch {
    // 整理失败不影响主流程
  }
}

// ═══════════════════════════════════════════════════════════
// FROM s07: Skill Loading — two-level on-demand knowledge injection
// ═══════════════════════════════════════════════════════════

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

// s09: buildSystem 每轮重建，包含记忆索引
function buildSystem(): string {
  const catalog = listSkills();
  const index = readMemoryIndex();
  const memoriesSection = index ? `\n\nMemories available:\n${index}` : "";
  return (
    `You are a coding agent at ${WORKDIR}. ` +
    `Skills available:\n${catalog}\n` +
    `${memoriesSection}\n` +
    `Relevant memories are injected below. Respect user preferences from memory.\n` +
    `When the user says 'remember' or expresses a clear preference, extract it as a memory.`
  );
}

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
// FROM s06: extractText
// ═══════════════════════════════════════════════════════════

function extractText(content: string | null | undefined): string {
  return content?.trim() || "";
}

// ═══════════════════════════════════════════════════════════
// FROM s07: loadSkill
// ═══════════════════════════════════════════════════════════

function loadSkill(name: string): string {
  const skill = SKILL_REGISTRY[name];
  if (!skill) return `Skill not found: ${name}`;
  return skill.content;
}

// ═══════════════════════════════════════════════════════════
// FROM s08: Four-Layer Compaction Pipeline
// ═══════════════════════════════════════════════════════════

function estimateSize(msgs: OpenAI.ChatCompletionMessageParam[]): number {
  return JSON.stringify(msgs).length;
}

// L1: snip_compact
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

// L2: micro_compact
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

// L3: persist_large_output
function persistLargeOutput(toolUseId: string, output: string): string {
  if (output.length <= PERSIST_THRESHOLD) return output;
  mkdirSync(TOOL_RESULTS_DIR, { recursive: true });
  const filePath = resolve(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  if (!existsSync(filePath)) writeFileSync(filePath, output, "utf-8");
  return `\nFull output: ${filePath}\nPreview:\n${output.slice(0, 2000)}\n`;
}

// L3: tool_result_budget
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

// L4: write_transcript
function writeTranscript(messages: OpenAI.ChatCompletionMessageParam[]): string {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const filePath = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const lines = messages.map((m) => JSON.stringify(m)).join("\n");
  writeFileSync(filePath, lines, "utf-8");
  return filePath;
}

// L4: summarize_history
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

// L4: compact_history
async function compactHistory(messages: OpenAI.ChatCompletionMessageParam[]): Promise<OpenAI.ChatCompletionMessageParam[]> {
  const transcriptPath = writeTranscript(messages);
  console.log(`[transcript saved: ${transcriptPath}]`);
  const summary = await summarizeHistory(messages);
  return [{ role: "user", content: `[Compacted]\n\n${summary}` }];
}

// Emergency: reactive_compact
async function reactiveCompact(messages: OpenAI.ChatCompletionMessageParam[]): Promise<OpenAI.ChatCompletionMessageParam[]> {
  writeTranscript(messages);
  const summary = await summarizeHistory(messages);
  return [
    { role: "user", content: `[Reactive compact]\n\n${summary}` },
    ...messages.slice(-5),
  ];
}

// ═══════════════════════════════════════════════════════════
// FROM s05: todo_write tool
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
// FROM s02-s08: 工具定义 + 分发映射
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
  todo_write: (args) => runTodoWrite(args.todos),
  load_skill: (args) => loadSkill(args.name),
};

// ═══════════════════════════════════════════════════════════
// FROM s06: Subagent
// ═══════════════════════════════════════════════════════════

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

const SUB_HANDLERS: Record<string, (args: Record<string, any>) => string> = {
  bash: (args) => runBash(args.command),
  read_file: (args) => runRead(args.path, args.limit),
  write_file: (args) => runWrite(args.path, args.content),
  edit_file: (args) => runEdit(args.path, args.old_text, args.new_text),
  glob: (args) => runGlob(args.pattern),
};

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

    for (const toolCall of assistantMsg.tool_calls!) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

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

  let result = extractText(
    (messages[messages.length - 1] as { content?: string }).content,
  );

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
// FROM s04: Hook System
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

const DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"];
const DESTRUCTIVE = ["rm ", "> /etc/", "chmod 777"];

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

function logHook(toolName: string, args: Record<string, any>): string | null {
  const values = Object.values(args).slice(0, 2);
  const preview = JSON.stringify(values).slice(0, 60);
  console.log(`\x1b[90m[HOOK] ${toolName}(${preview})\x1b[0m`);
  return null;
}

function largeOutputHook(toolName: string, _args: Record<string, any>, output: string): string | null {
  if (output.length > 100_000) {
    console.log(`\x1b[33m[HOOK] ⚠ Large output from ${toolName}: ${output.length} chars\x1b[0m`);
  }
  return null;
}

function contextInjectHook(_query: string): string | null {
  console.log(`\x1b[90m[HOOK] UserPromptSubmit: working in ${WORKDIR}\x1b[0m`);
  return null;
}

function summaryHook(messages: OpenAI.ChatCompletionMessageParam[]): string | null {
  const toolCount = messages.filter((m) => m.role === "tool").length;
  console.log(`\x1b[90m[HOOK] Stop: session used ${toolCount} tool calls\x1b[0m`);
  return null;
}

registerHook("UserPromptSubmit", contextInjectHook);
registerHook("PreToolUse", permissionHook);
registerHook("PreToolUse", logHook);
registerHook("PostToolUse", largeOutputHook);
registerHook("Stop", summaryHook);

// ═══════════════════════════════════════════════════════════
// agent_loop — s09: 每轮注入记忆 + 压缩 + 每轮结束后提取
// ═══════════════════════════════════════════════════════════

const MAX_REACTIVE_RETRIES = 1;
let roundsSinceTodo = 0;

async function agentLoop(messages: OpenAI.ChatCompletionMessageParam[]) {
  let reactiveRetries = 0;

  // s09: 在进入循环前，先加载相关记忆注入当前 user turn
  const memoriesContent = await loadMemories(messages);
  // 记录当前 user turn 索引，用于注入记忆内容
  const memoryTurnIdx = messages.length > 0 ? messages.length - 1 : -1;

  while (true) {
    // s05: nag reminder
    if (roundsSinceTodo >= 3 && messages.length > 0) {
      messages.push({ role: "user", content: "<reminder>Update your todos.</reminder>" });
      roundsSinceTodo = 0;
    }

    // s09: 每轮重建 SYSTEM（记忆索引可能已变化）
    const system = buildSystem();

    // s09: 保存压缩前快照，用于提取记忆（压缩后细节会丢失）
    const preCompress = messages.map((m): OpenAI.ChatCompletionMessageParam => {
      const copy = { ...m };
      return copy;
    });

    // s08: 三层预处理器
    toolResultBudget(messages);
    const snipped = snipCompact(messages);
    messages.length = 0;
    messages.push(...snipped);
    microCompact(messages);

    // s08: 仍然超阈值 → LLM 全量摘要
    if (estimateSize(messages) > CONTEXT_LIMIT) {
      console.log("[auto compact]");
      const compacted = await compactHistory(messages);
      messages.length = 0;
      messages.push(...compacted);
    }

    // s09: 构建请求消息，注入记忆内容到 user turn
    let requestMessages = messages;
    if (memoriesContent && memoryTurnIdx >= 0 && memoryTurnIdx < messages.length) {
      requestMessages = [...messages];
      const originalMsg = messages[memoryTurnIdx];
      const originalContent = typeof originalMsg.content === "string" ? originalMsg.content : "";
      requestMessages[memoryTurnIdx] = {
        ...originalMsg,
        content: `[Relevant memories]\n${memoriesContent}\n\n${originalContent}`,
      };
    }

    // s08: LLM 调用
    let response: OpenAI.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: system }, ...requestMessages],
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
      // s09: 从压缩前快照提取记忆（保留完整细节）
      await extractMemories(preCompress);
      await consolidateMemories();

      // s04: Stop hook
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

    // s08: compact 工具延迟处理
    let compactTriggered = false;

    for (const toolCall of assistantMsg.tool_calls!) {
      const toolName = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      if (toolName === "compact") {
        compactTriggered = true;
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "[Compacting...]",
        });
        continue;
      }

      roundsSinceTodo++;

      const blocked = await triggerHooks("PreToolUse", toolName, args);
      if (blocked) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: blocked,
        });
        continue;
      }

      let output: string;
      if (toolName === "task") {
        output = await spawnSubagent(args.description);
      } else {
        const handler = TOOL_HANDLERS[toolName];
        output = handler ? handler(args) : `Unknown tool: ${toolName}`;
      }
      console.log(output.slice(0, 200));

      if (toolName === "todo_write") {
        roundsSinceTodo = 0;
      }

      await triggerHooks("PostToolUse", toolName, args, output);

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: output,
      });
    }

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
  console.log("s09: Memory — persistent cross-session knowledge");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("\x1b[36ms09 >> \x1b[0m", resolve));

  const history: OpenAI.ChatCompletionMessageParam[] = [];

  while (true) {
    const query = (await ask()).trim();
    if (!query || query.toLowerCase() === "q" || query.toLowerCase() === "exit") break;

    await triggerHooks("UserPromptSubmit", query);

    history.push({ role: "user", content: query });
    await agentLoop(history);
    console.log();
  }

  rl.close();
}

main();
