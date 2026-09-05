import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKET_SCHEMA } from "./packet.ts";
import { subjectHashOf } from "./subject.ts";

// Focused tests of `gonogo validate-packet` as a real subprocess: the CLI's
// own flag wiring (exposure-log presence/absence, expected-protocol) is what
// an earlier version of this file got wrong, so it is exercised here
// end-to-end rather than only through the library function.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A_BASE = "a".repeat(40);
const A_HEAD = "b".repeat(40);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function buildValidPacket(dir: string): { protocolLocalCopy: string } {
  const protocolContent = "synthetic frozen protocol text";
  writeFileSync(join(dir, "PROTOCOL.md"), protocolContent);
  writeFileSync(join(dir, "prompts-rubric.md"), "synthetic frozen instrument text");

  const payload = { spec: "s", diff: "d", commitMessages: "c", transcript: null, test: null };
  const payloadText = JSON.stringify(payload);
  writeFileSync(join(dir, "payload.json"), payloadText);
  const payloadFile = { path: "payload.json", sha256: sha256(payloadText), role: "review" as const };

  function arm(name: string) {
    return {
      name,
      review_files: [payloadFile],
      evidence_hash: sha256(JSON.stringify([`payload.json:${payloadFile.sha256}`])),
    };
  }

  const manifest = {
    schema: PACKET_SCHEMA,
    packet_version: "1",
    case_id: "cli-synthetic-001",
    provenance: "known",
    exposure: "untouched",
    data_cutoff: "2026-01-01",
    evidence: {
      payload_file: payloadFile,
      subject_hash: subjectHashOf(payload),
      source: { repo: "https://example.invalid/synthetic.git", base: A_BASE, head: A_HEAD },
      artifact_provenance: {
        spec: "original", diff: "original", commit_messages: "original", transcript: "missing", test: "missing",
      },
    },
    protocol_files: [{ path: "PROTOCOL.md", sha256: sha256(protocolContent), role: "protocol" }],
    instrument_files: [{ path: "prompts-rubric.md", sha256: sha256("synthetic frozen instrument text"), role: "instrument" }],
    arms: [arm("gonogo"), arm("one_pass")],
    forbidden_markers: ["ANSWER_KEY"],
  };
  writeFileSync(join(dir, "packet.json"), JSON.stringify(manifest, null, 2));

  const protocolLocalCopy = join(dir, "..", "trusted-protocol-copy.md");
  writeFileSync(protocolLocalCopy, protocolContent);
  return { protocolLocalCopy };
}

function runCli(args: string[]) {
  const result = spawnSync("bun", ["run", join(ROOT, "src", "cli.ts"), ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function withPacketDir(fn: (dir: string, protocolLocalCopy: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "gonogo-cli-packet-"));
  try {
    const { protocolLocalCopy } = buildValidPacket(dir);
    fn(dir, protocolLocalCopy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(dir, "..", "trusted-protocol-copy.md"), { force: true });
  }
}

test("a valid packet passes via the real CLI given an exposure log and an expected protocol", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, "[]");
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
    expect(result.stdout).toContain("holdout_eligible: true");
  });
});

test("omitting --exposure-log on an untouched packet fails closed via the CLI", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("exposure_record_not_supplied");
  });
});

test("omitting --expected-protocol fails closed via the CLI", () => {
  withPacketDir((dir) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, "[]");
    const result = runCli(["validate-packet", "--packet", dir, "--exposure-log", logPath]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("missing_identity");
  });
});

test("--expected-protocol pointing at a different local file fails closed via the CLI", () => {
  withPacketDir((dir) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, "[]");
    const wrongLocalFile = join(dir, "..", "wrong-protocol.md");
    writeFileSync(wrongLocalFile, "not the real protocol text");
    try {
      const result = runCli([
        "validate-packet",
        "--packet", dir,
        "--exposure-log", logPath,
        "--expected-protocol", `PROTOCOL.md=${wrongLocalFile}`,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("protocol_digest_mismatch");
    } finally {
      rmSync(wrongLocalFile, { force: true });
    }
  });
});

test("a case present in the exposure log fails closed via the CLI", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, JSON.stringify(["cli-synthetic-001"]));
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("exposed_case_claims_untouched");
  });
});

test("a malformed exposure log (not a JSON array of strings) is refused rather than silently used", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, JSON.stringify({ not: "an array" }));
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must be a JSON array of case_id strings");
  });
});
