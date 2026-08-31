/** The only implemented backend today: the `claude` CLI in headless mode. */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type { Attachment, JudgeBackend, JudgeResponse } from "./types.ts";
import { renderPrompt } from "./types.ts";

/**
 * The CLI loads project settings, MCP servers and its full tool surface by
 * default. A judge needs none of that, and it costs ~34k prompt tokens per
 * call, so every extra is switched off explicitly.
 */
const LEAN_FLAGS = [
  "-p",
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--allowed-tools",
  "",
  "--setting-sources",
  "",
];

export class ClaudeBackend implements JudgeBackend {
  readonly name = "claude-cli";
  /** Set per call by the pipeline; see renderPrompt. */
  delimiterToken = "UNKEYED";
  constructor(
    private readonly model: string | undefined = process.env.GONOGO_CLAUDE_MODEL,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  async invoke(promptFile: string, attachments: Attachment[]): Promise<JudgeResponse> {
    const prompt = renderPrompt(readFileSync(promptFile, "utf8"), attachments, this.delimiterToken);
    const args = [...LEAN_FLAGS];
    if (this.model) args.push("--model", this.model);
    const started = Date.now();
    const raw = await run("claude", args, prompt, this.timeoutMs);
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`claude CLI did not return JSON. First 500 chars:\n${raw.slice(0, 500)}`);
    }
    if (parsed.is_error) {
      throw new Error(`claude CLI reported an error: ${parsed.result ?? parsed.subtype}`);
    }
    const usage: Record<string, { outputTokens?: number }> = parsed.modelUsage ?? {};
    const models = Object.keys(usage);
    // The CLI reports helper models (titles, summaries) alongside the one that
    // did the reasoning. Attribute the call to whichever produced the most output.
    const primary =
      models.sort((a, b) => (usage[b]?.outputTokens ?? 0) - (usage[a]?.outputTokens ?? 0))[0] ??
      this.model ??
      "unknown";
    // The CLI splits prompt tokens across input_tokens and the two cache
    // counters. Sum them: what matters downstream is how much text the judge
    // was shown, not how it was billed.
    const u = parsed.usage ?? {};
    const tokensIn = num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
    const tokensOut = num(u.output_tokens);
    return {
      text: String(parsed.result ?? ""),
      model: primary,
      models: Object.keys(usage),
      costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
      durationMs: Date.now() - started,
      tokensIn: tokensIn > 0 ? tokensIn : null,
      tokensOut: tokensOut > 0 ? tokensOut : null,
    };
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function run(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`could not run ${cmd}: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 800)}`));
      else resolvePromise(out);
    });
    child.stdin.end(stdin);
  });
}
