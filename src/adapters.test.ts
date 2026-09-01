import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolvePullRequest,
  resolveWorkspace,
  type CommandOptions,
  type CommandRunner,
} from "./adapters.ts";

const temporary: string[] = [];

function repo(): { path: string; base: string; head: string } {
  const path = mkdtempSync(join(tmpdir(), "gonogo-adapter-"));
  temporary.push(path);
  execFileSync("git", ["-C", path, "init", "--quiet"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Adapter Test"]);
  execFileSync("git", ["-C", path, "config", "user.email", "adapter@example.invalid"]);
  writeFileSync(join(path, "base.txt"), "base\n");
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "base"]);
  const base = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(path, "feature.txt"), "feature\n");
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "--quiet", "-m", "feature"]);
  const head = execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { path, base, head };
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runner(responses: Record<string, unknown>): CommandRunner {
  return (command: string, args: string[], _options?: CommandOptions): string => {
    const key = `${command} ${args.join(" ")}`;
    if (!(key in responses)) throw new Error(`unexpected command: ${key}`);
    const value = responses[key];
    return typeof value === "string" ? value : JSON.stringify(value);
  };
}

describe("Superset workspace adapter", () => {
  test("resolves a linked task and all live terminal scrollback", () => {
    const worktree = repo();
    const run = runner({
      "superset --version": "1.25.1\n",
      "superset workspaces get ws-1 --json": {
        id: "ws-1",
        worktreePath: worktree.path,
        taskId: "task-1",
      },
      "superset tasks get task-1 --json": {
        id: "task-1",
        title: "Fix the parser",
        description: "Preserve CRLF input.",
      },
      "superset terminals list --workspace ws-1 --json": {
        sessions: [
          { terminalId: "term-2", createdAt: 2, exited: false },
          { terminalId: "term-old", createdAt: 0, exited: true },
          { terminalId: "term-1", createdAt: 1, exited: false },
        ],
      },
      "superset terminals read --workspace ws-1 --terminal term-1 --max-lines 5000 --json": {
        text: "first session",
      },
      "superset terminals read --workspace ws-1 --terminal term-2 --max-lines 5000 --json": {
        text: "second session",
      },
      "superset terminals read --workspace ws-1 --terminal term-old --max-lines 5000 --json": {
        text: "completed session",
      },
    });

    const resolved = resolveWorkspace("ws-1", { base: worktree.base }, run);

    expect(resolved.spec).toBe("Fix the parser\n\nPreserve CRLF input.");
    expect(resolved.specSource).toBe("superset task task-1");
    expect(resolved.repo).toBe(worktree.path);
    expect(resolved.base).toBe(worktree.base);
    expect(resolved.taskId).toBe("task-1");
    expect(resolved.workspaceId).toBe("ws-1");
    expect(resolved.transcriptText).toContain("TERMINAL term-1");
    expect(resolved.transcriptText).toContain("first session");
    expect(resolved.transcriptText).toContain("completed session");
    expect(resolved.transcriptText!.indexOf("term-1"))
      .toBeLessThan(resolved.transcriptText!.indexOf("term-2"));
  });

  test("fails closed when Superset does not expose a creating prompt", () => {
    const worktree = repo();
    const run = runner({
      "superset --version": "1.25.1\n",
      "superset workspaces get ws-1 --json": {
        id: "ws-1",
        worktreePath: worktree.path,
        taskId: null,
      },
    });

    expect(() => resolveWorkspace("ws-1", { base: worktree.base }, run))
      .toThrow("does not expose the creating prompt");
  });

  test("explicit flags override unavailable task and transcript surfaces", () => {
    const worktree = repo();
    const run = runner({
      "superset --version": "1.25.1\n",
      "superset workspaces get ws-1 --json": {
        id: "ws-1",
        worktreePath: "/not/the/repo",
        taskId: null,
      },
    });

    const resolved = resolveWorkspace("ws-1", {
      spec: "operator spec",
      repo: worktree.path,
      base: worktree.base,
      transcriptProvided: true,
      taskId: "operator-task",
    }, run);

    expect(resolved.spec).toBe("operator spec");
    expect(resolved.repo).toBe(worktree.path);
    expect(resolved.transcriptText).toBeUndefined();
    expect(resolved.transcriptSource).toBe("--transcript");
    expect(resolved.taskId).toBe("operator-task");
  });
});

function prResponses(
  repository: ReturnType<typeof repo>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    "gh --version": "gh version 2.78.0 (test)\n",
    "gh pr view https://github.com/acme/widget/pull/7 --json number,url,title,body,headRefOid,baseRefOid,baseRefName,closingIssuesReferences": {
      number: 7,
      url: "https://github.com/acme/widget/pull/7",
      title: "Fix the parser",
      body: "Tests pass now.",
      headRefOid: repository.head,
      baseRefOid: repository.base,
      baseRefName: "main",
      closingIssuesReferences: [{
        number: 4,
        title: "Parser loses CRLF",
        body: "Keep exact line endings.",
      }],
    },
    "gh repo view acme/widget --json defaultBranchRef": { defaultBranchRef: { name: "main" } },
    ...overrides,
  };
}

describe("GitHub PR adapter", () => {
  test("maps a closing issue to spec and PR body to testimony", () => {
    const checkout = repo();
    const resolved = resolvePullRequest(
      "https://github.com/acme/widget/pull/7",
      { repo: checkout.path },
      runner(prResponses(checkout)),
    );

    expect(resolved.spec).toBe("# Issue #4: Parser loses CRLF\n\nKeep exact line endings.");
    expect(resolved.specSource).toBe("closing issue #4");
    expect(resolved.transcriptText).toBe("Tests pass now.");
    expect(resolved.transcriptSource).toBe("pull request body");
    expect(resolved.base).toBe(checkout.base);
    expect(resolved.taskId).toBe("github:acme/widget#7");
  });

  test("fails closed when no linked issue defines the task", () => {
    const checkout = repo();
    const responses = prResponses(checkout);
    const view = responses[
      "gh pr view https://github.com/acme/widget/pull/7 --json number,url,title,body,headRefOid,baseRefOid,baseRefName,closingIssuesReferences"
    ] as Record<string, unknown>;
    view.closingIssuesReferences = [];

    expect(() => resolvePullRequest(
      "https://github.com/acme/widget/pull/7",
      { repo: checkout.path },
      runner(responses),
    )).toThrow("pass --spec");
  });

  test("an explicit spec overrides a missing linked issue", () => {
    const checkout = repo();
    const responses = prResponses(checkout);
    const view = responses[
      "gh pr view https://github.com/acme/widget/pull/7 --json number,url,title,body,headRefOid,baseRefOid,baseRefName,closingIssuesReferences"
    ] as Record<string, unknown>;
    view.closingIssuesReferences = [];

    const resolved = resolvePullRequest(
      "https://github.com/acme/widget/pull/7",
      { repo: checkout.path, spec: "assigned task" },
      runner(responses),
    );

    expect(resolved.spec).toBe("assigned task");
    expect(resolved.specSource).toBe("--spec");
  });

  test("rejects a checkout that is not the exact committed PR head", () => {
    const checkout = repo();
    const responses = prResponses(checkout);
    const view = responses[
      "gh pr view https://github.com/acme/widget/pull/7 --json number,url,title,body,headRefOid,baseRefOid,baseRefName,closingIssuesReferences"
    ] as Record<string, unknown>;
    view.headRefOid = "f".repeat(40);

    expect(() => resolvePullRequest(
      "https://github.com/acme/widget/pull/7",
      { repo: checkout.path },
      runner(responses),
    )).toThrow("check out the exact PR head");
  });

  test("stops at the first stacked PR dependency", () => {
    const checkout = repo();
    const responses = prResponses(checkout, {
      "gh repo view acme/widget --json defaultBranchRef": { defaultBranchRef: { name: "main" } },
      "gh pr list --repo acme/widget --head feature/base --state all --json number,url,headRefOid,baseRefOid,baseRefName,headRefName,state": [{
        number: 6,
        url: "https://github.com/acme/widget/pull/6",
        headRefOid: checkout.base,
        baseRefOid: "a".repeat(40),
        baseRefName: "main",
        headRefName: "feature/base",
        state: "OPEN",
      }],
    });
    const view = responses[
      "gh pr view https://github.com/acme/widget/pull/7 --json number,url,title,body,headRefOid,baseRefOid,baseRefName,closingIssuesReferences"
    ] as Record<string, unknown>;
    view.baseRefName = "feature/base";

    expect(() => resolvePullRequest(
      "https://github.com/acme/widget/pull/7",
      { repo: checkout.path },
      runner(responses),
    )).toThrow("stops at the first dependency");
  });
});
