#!/usr/bin/env bun
/** Live adapter check. Resolves inputs, but never invokes a judge. Intentionally not run in CI. */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertKnownFlags, parseArgs, str } from "../src/args.ts";
import { resolveWorkspace } from "../src/adapters.ts";

const args = parseArgs(process.argv.slice(2), { booleanFlags: new Set() });
assertKnownFlags(args, new Set(["workspace", "spec", "repo", "base", "task"]));

const workspaceId = str(args, "workspace") ?? process.env.SUPERSET_WORKSPACE_ID;
if (!workspaceId) throw new Error("pass --workspace or set SUPERSET_WORKSPACE_ID");

const specArg = str(args, "spec");
const pathLikeSpec = specArg !== undefined && !/\s/.test(specArg) && (
  specArg.startsWith("/") || specArg.startsWith("./") || specArg.startsWith("../") ||
  /\.(md|txt)$/i.test(specArg)
);
if (specArg !== undefined && pathLikeSpec && !existsSync(specArg)) {
  throw new Error(`spec file "${specArg}" does not exist`);
}
const spec = specArg === undefined
  ? undefined
  : existsSync(specArg)
    ? readFileSync(resolve(specArg), "utf8")
    : specArg;

const resolved = resolveWorkspace(workspaceId, {
  spec,
  repo: str(args, "repo"),
  base: str(args, "base"),
  taskId: str(args, "task"),
});
if (!resolved.transcriptText?.trim()) {
  throw new Error(`workspace ${workspaceId} did not expose any terminal transcript`);
}

console.log(JSON.stringify({
  workspace_id: resolved.workspaceId,
  task_id: resolved.taskId,
  repo: resolved.repo,
  base: resolved.base,
  spec_source: resolved.specSource,
  spec_chars: resolved.spec.length,
  transcript_source: resolved.transcriptSource,
  transcript_chars: resolved.transcriptText.length,
  superset_version: resolved.adapterVersion,
}, null, 2));
