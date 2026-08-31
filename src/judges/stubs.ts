/**
 * Placeholders for the cross-family panel. Not implemented today, on purpose:
 * the interface exists so adding them is a file, not a refactor. See NEXT.md.
 */
import type { Attachment, JudgeBackend, JudgeResponse } from "./types.ts";

class NotImplementedBackend implements JudgeBackend {
  constructor(
    readonly name: string,
    private readonly cli: string,
  ) {}
  async invoke(_promptFile: string, _attachments: Attachment[]): Promise<JudgeResponse> {
    throw new Error(
      `backend "${this.name}" is a stub. It will shell out to the \`${this.cli}\` CLI ` +
        `once panel mode lands; today only --judge claude works.`,
    );
  }
}

export class CodexBackend extends NotImplementedBackend {
  constructor() {
    super("codex-cli", "codex");
  }
}

export class QwenBackend extends NotImplementedBackend {
  constructor() {
    super("qwen-cli", "qwen");
  }
}
