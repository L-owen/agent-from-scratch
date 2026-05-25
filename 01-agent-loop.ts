/**
 * s01_agent_loop - The Agent Loop (TypeScript + 阿里百炼 API)
 *
 * The entire secret of an AI coding agent in one pattern:
 *   while finish_reason == "tool_calls":
 *     response = LLM(messages, tools)
 *     execute tools
 *     append results
 *
 * Usage:
 *   cp .env.example .env  # fill in DASHSCOPE_API_KEY and MODEL_ID
 *   npx tsx code.ts
 */
import "dotenv/config";
import OpenAI from "openai";
import { execSync } from "node:child_process";
import { createInterface } from "node:readline";

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

const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// ── Tool definition: just bash ────────────────────────────
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
];

// ── Tool execution ────────────────────────────────────────
function runBash(command: string): string {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }
  try {
    const output = execSync(command, {
      cwd: process.cwd(),
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

// ── The core pattern: loop until the model stops calling tools ──
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
      // Print final text response
      if (assistantMsg.content) {
        console.log(assistantMsg.content);
      }
      return;
    }

    // Execute each tool call, append results
    for (const toolCall of assistantMsg.tool_calls!) {
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`\x1b[33m$ ${args.command}\x1b[0m`);
      const output = runBash(args.command);
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
  console.log("s01: Agent Loop (TypeScript + 阿里百炼)");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (): Promise<string> =>
    new Promise((resolve) => rl.question("\x1b[36ms01 >> \x1b[0m", resolve));

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
