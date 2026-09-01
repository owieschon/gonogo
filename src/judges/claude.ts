/** The only implemented backend today: the `claude` CLI in headless mode. */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import type {
  Attachment,
  JudgeBackend,
  JudgeInvokeOptions,
  JudgeResponse,
  StructuredOutputSchema,
} from "./types.ts";
import { renderPrompt } from "./types.ts";

/**
 * The CLI loads project settings, MCP servers and its full tool surface by
 * default. A judge needs none of that, and it costs ~34k prompt tokens per
 * call, so bare mode and an empty tool surface make the scripting boundary
 * explicit.
 */
const LEAN_FLAGS = [
  "--bare",
  "-p",
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--tools",
  "",
  "--setting-sources",
  "",
];

export class ClaudeBackend implements JudgeBackend {
  readonly name = "claude-cli";
  /** Set per call by the pipeline; see renderPrompt. */
  delimiterToken = "UNKEYED";
  constructor(
    readonly requestedModel: string | undefined = process.env.GONOGO_CLAUDE_MODEL,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  async invoke(
    promptFile: string,
    attachments: Attachment[],
    options: JudgeInvokeOptions = {},
  ): Promise<JudgeResponse> {
    const prompt = renderPrompt(readFileSync(promptFile, "utf8"), attachments, this.delimiterToken);
    const args = claudeArgs(this.requestedModel, options.structuredSchema);
    const started = Date.now();
    const raw = await run("claude", args, prompt, this.timeoutMs);
    return parseClaudeResponse(
      raw,
      options.structuredSchema !== undefined,
      Date.now() - started,
      this.requestedModel,
    );
  }
}

/** Build the exact non-interactive CLI contract used by the backend. */
export function claudeArgs(
  requestedModel?: string,
  structuredSchema?: StructuredOutputSchema,
): string[] {
  const args = [...LEAN_FLAGS];
  if (requestedModel) args.push("--model", requestedModel);
  if (structuredSchema) args.push("--json-schema", JSON.stringify(structuredSchema));
  return args;
}

/** Decode Claude's JSON envelope without confusing it with rubric JSON. */
export function parseClaudeResponse(
  raw: string,
  structured: boolean,
  durationMs = 0,
  requestedModel?: string,
): JudgeResponse {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`claude CLI did not return JSON. First 500 chars:\n${raw.slice(0, 500)}`);
  }
  if (parsed.is_error) {
    throw new Error(`claude CLI reported an error: ${parsed.result ?? parsed.subtype}`);
  }
  let text: string;
  if (structured) {
    if (
      parsed.structured_output === null ||
      typeof parsed.structured_output !== "object" ||
      Array.isArray(parsed.structured_output)
    ) {
      throw new Error("claude CLI omitted structured_output for a schema-constrained call");
    }
    text = JSON.stringify(parsed.structured_output);
  } else {
    text = String(parsed.result ?? "");
  }
  const usage: Record<string, { outputTokens?: number }> = parsed.modelUsage ?? {};
  const models = Object.keys(usage);
  // The CLI reports helper models (titles, summaries) alongside the one that
  // did the reasoning. Attribute the call to whichever produced the most output.
  const primary =
    models.sort((a, b) => (usage[b]?.outputTokens ?? 0) - (usage[a]?.outputTokens ?? 0))[0] ??
    requestedModel ??
    "unknown";
  // The CLI splits prompt tokens across input_tokens and the two cache
  // counters. Sum them: what matters downstream is how much text the judge
  // was shown, not how it was billed.
  const u = parsed.usage ?? {};
  const tokensIn =
    num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  const tokensOut = num(u.output_tokens);
  return {
    text,
    model: primary,
    models: Object.keys(usage),
    costUsd: typeof parsed.total_cost_usd === "number" ? parsed.total_cost_usd : null,
    durationMs,
    tokensIn: tokensIn > 0 ? tokensIn : null,
    tokensOut: tokensOut > 0 ? tokensOut : null,
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Claude reports some process failures as JSON on stdout, with empty stderr. */
export function claudeFailureDetail(stdout: string, stderr: string): string {
  const diagnostic = stderr.trim();
  if (diagnostic) return diagnostic;

  const raw = stdout.trim();
  if (!raw) return "no stdout or stderr";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.result === "string" && parsed.result.trim()) return parsed.result.trim();
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
  } catch {
    // A non-JSON failure is still useful verbatim evidence.
  }
  return raw;
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
      if (code !== 0) {
        reject(new Error(`${cmd} exited ${code}: ${claudeFailureDetail(out, err).slice(0, 800)}`));
      }
      else resolvePromise(out);
    });
    child.stdin.end(stdin);
  });
}
