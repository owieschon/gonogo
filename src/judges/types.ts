/** A judge backend is anything that can be handed a prompt and return text. */

export interface Attachment {
  /** Section heading the judge will see, e.g. "SPEC" or "DIFF". */
  name: string;
  /** Raw text. Never parsed or reformatted by gonogo. */
  content: string;
  /** Fence language hint for readability, e.g. "diff". */
  lang?: string;
}

export interface JudgeResponse {
  /** The model's reply, verbatim. */
  text: string;
  /** Model version string exactly as the backend reported it. */
  model: string;
  /** Every model the backend reported touching this call. */
  models: string[];
  costUsd: number | null;
  durationMs: number;
}

export interface JudgeBackend {
  readonly name: string;
  /** Render promptFile + attachments into one prompt and return the reply. */
  invoke(promptFile: string, attachments: Attachment[]): Promise<JudgeResponse>;
}

export function renderPrompt(promptBody: string, attachments: Attachment[]): string {
  const parts = [promptBody.trim(), ""];
  for (const a of attachments) {
    parts.push(`## ${a.name}`, "");
    if (a.content.trim() === "") {
      parts.push("(not provided)", "");
      continue;
    }
    const fence = "`".repeat(Math.max(3, longestBacktickRun(a.content) + 1));
    parts.push(`${fence}${a.lang ?? "text"}`, a.content, fence, "");
  }
  return parts.join("\n");
}

function longestBacktickRun(s: string): number {
  let best = 0;
  let run = 0;
  for (const ch of s) {
    if (ch === "`") best = Math.max(best, ++run);
    else run = 0;
  }
  return best;
}
