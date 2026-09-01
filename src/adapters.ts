/** Resolve GitHub PRs and Superset workspaces into gonogo's existing inputs. */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { git } from "./evidence.ts";

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
}

export type CommandRunner = (
  command: string,
  args: string[],
  options?: CommandOptions,
) => string;

export const runCommand: CommandRunner = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeoutMs ?? 30_000,
  });
  if (result.error) {
    throw new Error(`${command} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function json(output: string, label: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${label} did not return valid JSON`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function defaultBase(repo: string): string {
  let remoteHead: string;
  try {
    remoteHead = git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]).trim();
  } catch {
    const candidates = ["origin/main", "main", "origin/master", "master"];
    remoteHead = candidates.find((candidate) => {
      try {
        git(repo, ["rev-parse", "--verify", candidate]);
        return true;
      } catch {
        return false;
      }
    }) ?? "";
  }
  if (!remoteHead) {
    throw new Error(`cannot determine the default base branch in ${repo}; pass --base`);
  }
  return git(repo, ["merge-base", "HEAD", remoteHead]).trim();
}

export interface ResolvedInputs {
  mode: "workspace" | "pr";
  spec: string;
  repo: string;
  base: string;
  transcriptText?: string;
  taskId: string;
  workspaceId: string | null;
  specSource: string;
  transcriptSource: string;
  adapterVersion: string;
}

export interface AdapterOverrides {
  spec?: string;
  repo?: string;
  base?: string;
  transcriptProvided?: boolean;
  taskId?: string;
}

interface WorkspaceRecord {
  id: string;
  worktreePath: string;
  taskId: string | null;
}

function workspaceRecord(value: unknown): WorkspaceRecord {
  const record = object(value, "superset workspaces get");
  return {
    id: text(record.id, "workspace.id"),
    worktreePath: text(record.worktreePath, "workspace.worktreePath"),
    taskId: optionalText(record.taskId),
  };
}

function taskSpec(taskId: string, runner: CommandRunner): string {
  let task: Record<string, unknown>;
  try {
    task = object(
      json(runner("superset", ["tasks", "get", taskId, "--json"]), "superset tasks get"),
      "superset tasks get",
    );
  } catch (error) {
    throw new Error(
      `workspace task ${taskId} could not supply its spec; pass --spec. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const title = text(task.title, "task.title");
  const description = optionalText(task.description);
  return description ? `${title}\n\n${description}` : title;
}

function workspaceTranscript(workspaceId: string, runner: CommandRunner): string | undefined {
  const listing = object(
    json(
      runner("superset", ["terminals", "list", "--workspace", workspaceId, "--json"]),
      "superset terminals list",
    ),
    "superset terminals list",
  );
  if (!Array.isArray(listing.sessions)) {
    throw new Error("superset terminals list.sessions must be an array");
  }
  const sessions = listing.sessions
    .map((item) => object(item, "terminal session"))
    .sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  if (sessions.length === 0) return undefined;
  return sessions.map((session) => {
    const terminalId = text(session.terminalId, "terminal.terminalId");
    const snapshot = object(
      json(
        runner("superset", [
          "terminals", "read", "--workspace", workspaceId,
          "--terminal", terminalId, "--max-lines", "5000", "--json",
        ]),
        "superset terminals read",
      ),
      "superset terminals read",
    );
    const contents = typeof snapshot.text === "string" ? snapshot.text : "";
    return `===== SUPERSET TERMINAL ${terminalId} =====\n${contents}`;
  }).join("\n\n");
}

export function resolveWorkspace(
  workspaceId: string,
  overrides: AdapterOverrides,
  runner: CommandRunner = runCommand,
): ResolvedInputs {
  const version = runner("superset", ["--version"]).trim();
  const workspace = workspaceRecord(
    json(
      runner("superset", ["workspaces", "get", workspaceId, "--json"]),
      "superset workspaces get",
    ),
  );
  if (workspace.id !== workspaceId) {
    throw new Error(`Superset returned workspace ${workspace.id}, expected ${workspaceId}`);
  }
  const repo = resolve(overrides.repo ?? workspace.worktreePath);
  if (!existsSync(repo)) throw new Error(`workspace worktree does not exist locally: ${repo}`);

  let spec: string;
  let specSource: string;
  if (overrides.spec !== undefined) {
    spec = overrides.spec;
    specSource = "--spec";
  } else if (workspace.taskId) {
    spec = taskSpec(workspace.taskId, runner);
    specSource = `superset task ${workspace.taskId}`;
  } else {
    throw new Error(
      `workspace ${workspaceId} has no linked task, and Superset ${version} does not expose ` +
      "the creating prompt through `workspaces get`; pass --spec",
    );
  }

  const transcriptText = overrides.transcriptProvided
    ? undefined
    : workspaceTranscript(workspaceId, runner);
  return {
    mode: "workspace",
    spec,
    repo,
    base: overrides.base ?? defaultBase(repo),
    transcriptText,
    taskId: overrides.taskId ?? workspace.taskId ?? workspaceId,
    workspaceId,
    specSource,
    transcriptSource: overrides.transcriptProvided
      ? "--transcript"
      : transcriptText === undefined
        ? "none (no live Superset terminals)"
        : "superset terminals read --max-lines 5000",
    adapterVersion: version,
  };
}

interface PullRequestRecord {
  number: number;
  url: string;
  title: string;
  body: string;
  headRefOid: string;
  baseRefOid: string;
  baseRefName: string;
  closingIssuesReferences: { number: number; title: string; body: string }[];
}

function pullRequestRecord(value: unknown): PullRequestRecord {
  const record = object(value, "gh pr view");
  if (!Number.isInteger(record.number)) throw new Error("pull request number must be an integer");
  const issues = Array.isArray(record.closingIssuesReferences)
    ? record.closingIssuesReferences.map((entry) => {
        const issue = object(entry, "closing issue");
        if (!Number.isInteger(issue.number)) throw new Error("closing issue number must be an integer");
        return {
          number: issue.number as number,
          title: text(issue.title, "closing issue.title"),
          body: typeof issue.body === "string" ? issue.body : "",
        };
      })
    : [];
  return {
    number: record.number as number,
    url: text(record.url, "pull request.url"),
    title: text(record.title, "pull request.title"),
    body: typeof record.body === "string" ? record.body : "",
    headRefOid: text(record.headRefOid, "pull request.headRefOid"),
    baseRefOid: text(record.baseRefOid, "pull request.baseRefOid"),
    baseRefName: text(record.baseRefName, "pull request.baseRefName"),
    closingIssuesReferences: issues,
  };
}

function repoSlug(prUrl: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+(?:[/?#].*)?$/.exec(prUrl);
  if (!match) throw new Error(`--pr must resolve to a GitHub pull request URL, got ${prUrl}`);
  return match[1]!;
}

function issueSpec(pr: PullRequestRecord): { spec: string; source: string } {
  if (pr.closingIssuesReferences.length === 0) {
    throw new Error(
      `PR #${pr.number} has no linked closing issue defining the assigned task; pass --spec`,
    );
  }
  const ordered = [...pr.closingIssuesReferences].sort((a, b) => a.number - b.number);
  return {
    spec: ordered.map((issue) =>
      `# Issue #${issue.number}: ${issue.title}${issue.body ? `\n\n${issue.body}` : ""}`,
    ).join("\n\n---\n\n"),
    source: `closing issue${ordered.length === 1 ? "" : "s"} ${ordered.map((i) => `#${i.number}`).join(", ")}`,
  };
}

function assertExactPullRequestCheckout(repo: string, pr: PullRequestRecord): void {
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  if (head !== pr.headRefOid) {
    throw new Error(
      `PR #${pr.number} head is ${pr.headRefOid}, but ${repo} is at ${head}; ` +
      "check out the exact PR head before judging",
    );
  }
  const status = git(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim() !== "") {
    throw new Error(`PR #${pr.number} checkout is dirty; --pr judges the committed PR snapshot only`);
  }
}

function assertNoStackedDependency(
  repository: string,
  pr: PullRequestRecord,
  runner: CommandRunner,
): void {
  const repoInfo = object(
    json(
      runner("gh", ["repo", "view", repository, "--json", "defaultBranchRef"]),
      "gh repo view",
    ),
    "gh repo view",
  );
  const defaultBranch = object(repoInfo.defaultBranchRef, "repository.defaultBranchRef");
  if (optionalText(defaultBranch.name) === pr.baseRefName) return;

  const candidates = json(
    runner("gh", [
      "pr", "list", "--repo", repository, "--head", pr.baseRefName, "--state", "all",
      "--json", "number,url,headRefOid,baseRefOid,baseRefName,headRefName,state",
    ]),
    "gh pr list",
  );
  if (!Array.isArray(candidates)) throw new Error("gh pr list must return an array");
  const dependency = candidates.map((item) => object(item, "base pull request"))
    .find((item) => item.headRefOid === pr.baseRefOid && item.number !== pr.number);
  if (!dependency) return;
  throw new Error(
    `PR #${pr.number} is stacked on ${text(dependency.url, "base pull request.url")}. ` +
    "gonogo stops at the first dependency because this adapter cannot prove a current dependency " +
    "verdict from GitHub/Superset's public surfaces; judge and land or restack that dependency first",
  );
}

export function resolvePullRequest(
  prRef: string,
  overrides: AdapterOverrides,
  runner: CommandRunner = runCommand,
): ResolvedInputs {
  const repo = resolve(overrides.repo ?? ".");
  const version = runner("gh", ["--version"]).split("\n", 1)[0]!.trim();
  const pr = pullRequestRecord(json(runner("gh", [
    "pr", "view", prRef,
    "--json", "number,url,title,body,headRefOid,baseRefOid,baseRefName,closingIssuesReferences",
  ], { cwd: repo }), "gh pr view"));
  const repository = repoSlug(pr.url);
  assertExactPullRequestCheckout(repo, pr);
  assertNoStackedDependency(repository, pr, runner);
  const inferred = overrides.spec === undefined ? issueSpec(pr) : null;
  return {
    mode: "pr",
    spec: overrides.spec ?? inferred!.spec,
    repo,
    base: overrides.base ?? pr.baseRefOid,
    transcriptText: overrides.transcriptProvided ? undefined : pr.body,
    taskId: overrides.taskId ?? `github:${repository}#${pr.number}`,
    workspaceId: null,
    specSource: inferred?.source ?? "--spec",
    transcriptSource: overrides.transcriptProvided ? "--transcript" : "pull request body",
    adapterVersion: version,
  };
}
