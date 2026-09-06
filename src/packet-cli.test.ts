import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKET_SCHEMA } from "./packet.ts";
import { subjectHashOf } from "./subject.ts";

// Focused tests of `gonogo validate-packet` as a real subprocess: the CLI's
// own flag wiring (exposure-log presence/completeness, expected-protocol
// self-reference/alias rejection) is where several reported gaps actually
// lived, so it is exercised here end-to-end rather than only through the
// library function.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const A_BASE = "a".repeat(40);
const A_HEAD = "b".repeat(40);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function exposureLog(overrides: Partial<{ complete: boolean; covered_through: string; exposed_case_ids: string[] }> = {}): string {
  return JSON.stringify({
    schema: "gonogo/exposure-log@1",
    complete: true,
    exposed_case_ids: [],
    ...overrides,
  });
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

test("a valid packet passes via the real CLI given a complete exposure log and an expected protocol", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog());
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

test("an exposure log that does not assert completeness fails closed via the CLI", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog({ complete: false }));
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("exposure_record_incomplete");
  });
});

test("an exposure log whose covered_through predates the packet's data_cutoff fails closed via the CLI", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    // Packet's data_cutoff is 2026-01-01; this record only covers up to 2025-01-01.
    writeFileSync(logPath, exposureLog({ covered_through: "2025-01-01" }));
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("exposure_record_incomplete");
  });
});

test("an exposure log with a calendar-invalid covered_through is refused by the CLI, not lexically compared", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog({ covered_through: "9999-99-99" }));
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("real YYYY-MM-DD calendar date");
  });
});

test("a bare array exposure log (the old format) is refused, not silently accepted", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, "[]");
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("gonogo/exposure-log@1");
  });
});

test("omitting --expected-protocol fails closed via the CLI", () => {
  withPacketDir((dir) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog());
    const result = runCli(["validate-packet", "--packet", dir, "--exposure-log", logPath]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("missing_identity");
  });
});

test("--expected-protocol pointing at a different local file fails closed via the CLI", () => {
  withPacketDir((dir) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog());
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

test("--expected-protocol pointing directly at the packet's own file is refused by the CLI", () => {
  withPacketDir((dir) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog());
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${join(dir, "PROTOCOL.md")}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("must not be the packet's own file");
  });
});

test("--expected-protocol pointing at a symlink alias of the packet's own file is refused by the CLI", () => {
  withPacketDir((dir) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog());
    const aliasPath = join(dir, "..", "protocol-symlink-alias.md");
    symlinkSync(join(dir, "PROTOCOL.md"), aliasPath);
    try {
      const result = runCli([
        "validate-packet",
        "--packet", dir,
        "--exposure-log", logPath,
        "--expected-protocol", `PROTOCOL.md=${aliasPath}`,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must not be the packet's own file");
    } finally {
      rmSync(aliasPath, { force: true });
    }
  });
});

test("--expected-protocol pointing at a hard link to the packet's own file is refused by the CLI", () => {
  withPacketDir((dir) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog());
    const hardLinkPath = join(dir, "..", "protocol-hardlink-alias.md");
    linkSync(join(dir, "PROTOCOL.md"), hardLinkPath);
    try {
      const result = runCli([
        "validate-packet",
        "--packet", dir,
        "--exposure-log", logPath,
        "--expected-protocol", `PROTOCOL.md=${hardLinkPath}`,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("must not be the packet's own file");
    } finally {
      rmSync(hardLinkPath, { force: true });
    }
  });
});

test("an external pin for a path the packet does not declare fails closed via the CLI", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog());
    const extraLocalFile = join(dir, "..", "required-second-protocol.md");
    writeFileSync(extraLocalFile, "an externally required second protocol document");
    try {
      const result = runCli([
        "validate-packet",
        "--packet", dir,
        "--exposure-log", logPath,
        "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
        "--expected-protocol", `REQUIRED-SECOND.md=${extraLocalFile}`,
      ]);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain("protocol_digest_mismatch");
      expect(result.stdout).toContain("REQUIRED-SECOND.md");
    } finally {
      rmSync(extraLocalFile, { force: true });
    }
  });
});

test("a case present in the exposure log fails closed via the CLI", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, exposureLog({ exposed_case_ids: ["cli-synthetic-001"] }));
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

test("a malformed exposure log (missing exposed_case_ids) is refused rather than silently used", () => {
  withPacketDir((dir, protocolLocalCopy) => {
    const logPath = join(dir, "exposure-log.json");
    writeFileSync(logPath, JSON.stringify({ schema: "gonogo/exposure-log@1", complete: true }));
    const result = runCli([
      "validate-packet",
      "--packet", dir,
      "--exposure-log", logPath,
      "--expected-protocol", `PROTOCOL.md=${protocolLocalCopy}`,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("exposed_case_ids");
  });
});
