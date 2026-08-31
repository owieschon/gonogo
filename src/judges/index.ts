import type { JudgeBackend } from "./types.ts";
import { ClaudeBackend } from "./claude.ts";
import { CodexBackend, QwenBackend } from "./stubs.ts";

export type { JudgeBackend, Attachment, JudgeResponse } from "./types.ts";
export { renderPrompt } from "./types.ts";

export const BACKENDS = ["claude", "codex", "qwen"] as const;
export type BackendName = (typeof BACKENDS)[number];

export function makeBackend(name: string): JudgeBackend {
  switch (name) {
    case "claude":
      return new ClaudeBackend();
    case "codex":
      return new CodexBackend();
    case "qwen":
      return new QwenBackend();
    default:
      throw new Error(`unknown judge backend "${name}". Known: ${BACKENDS.join(", ")}`);
  }
}
