/**
 * Judge-vs-human agreement. Load-bearing once Run 01 data exists; today it runs
 * on the synthetic pairs under calibration/synthetic/ and says so loudly.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS } from "./types.ts";
import type { Dimension, HumanFile, VerdictFile } from "./types.ts";

interface Pair {
  runId: string;
  synthetic: boolean;
  reviewer: string;
  judge: Record<Dimension, number | "abstain">;
  human: Record<Dimension, number | "abstain">;
}

function readPairsFrom(dir: string): Pair[] {
  if (!existsSync(dir)) return [];
  const pairs: Pair[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(dir, entry.name);
    const vp = join(runDir, "verdict.json");
    const hp = join(runDir, "human.json");
    if (!existsSync(vp) || !existsSync(hp)) continue;
    const v = JSON.parse(readFileSync(vp, "utf8")) as VerdictFile;
    const h = JSON.parse(readFileSync(hp, "utf8")) as HumanFile;
    const judge = {} as Record<Dimension, number | "abstain">;
    for (const d of DIMENSIONS) {
      const r = v.dimensions[d];
      judge[d] = r.score === "abstain" ? "abstain" : (r.score as number);
    }
    pairs.push({
      runId: entry.name,
      synthetic: h.synthetic === true,
      reviewer: h.reviewer,
      judge,
      human: h.dimensions,
    });
  }
  return pairs.sort((a, b) => a.runId.localeCompare(b.runId));
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export function runCalibrate(dirs: string[]): string {
  const pairs = dirs.flatMap(readPairsFrom);
  const out: string[] = [];

  if (pairs.length === 0) {
    return [
      "No judge/human pairs found.",
      "",
      "A pair is a directory holding both verdict.json and human.json.",
      "Record your own verdict after a judged run as runs/<ts>/human.json;",
      "see calibration/synthetic/ for the schema and calibration/README.md for the protocol.",
    ].join("\n");
  }

  const real = pairs.filter((p) => !p.synthetic);
  const synth = pairs.filter((p) => p.synthetic);

  if (real.length === 0) {
    out.push("=".repeat(72));
    out.push("SYNTHETIC DATA ONLY — these numbers measure nothing.");
    out.push(
      "Every pair below was hand-written to exercise the aggregation. No human has",
    );
    out.push("reviewed a real gonogo run yet. Do not quote these figures anywhere.");
    out.push("=".repeat(72));
    out.push("");
  } else if (synth.length > 0) {
    out.push(
      `NOTE: ${synth.length} synthetic pair(s) present and EXCLUDED from the statistics below.`,
    );
    out.push("");
  }

  const scored = real.length > 0 ? real : synth;

  out.push(
    pad("dimension", 20) +
      padL("exact", 8) +
      padL("within 1", 10) +
      padL("mean |Δ|", 10) +
      padL("judge harsher", 15) +
      padL("human harsher", 15),
  );
  out.push("-".repeat(78));
  for (const d of DIMENSIONS) {
    const usable = scored.filter((p) => p.judge[d] !== "abstain" && p.human[d] !== "abstain");
    if (usable.length === 0) {
      out.push(pad(d, 20) + padL("no comparable pairs (abstentions only)", 58));
      continue;
    }
    const deltas = usable.map((p) => (p.judge[d] as number) - (p.human[d] as number));
    const exact = deltas.filter((x) => x === 0).length;
    const within1 = deltas.filter((x) => Math.abs(x) <= 1).length;
    const mean = deltas.reduce((a, b) => a + Math.abs(b), 0) / deltas.length;
    out.push(
      pad(d, 20) +
        padL(`${exact}/${usable.length}`, 8) +
        padL(`${within1}/${usable.length}`, 10) +
        padL(mean.toFixed(2), 10) +
        padL(String(deltas.filter((x) => x < 0).length), 15) +
        padL(String(deltas.filter((x) => x > 0).length), 15),
    );
  }

  out.push("");
  out.push("per-run disagreements (published as-is)");
  for (const p of scored) {
    const diffs = DIMENSIONS.filter(
      (d) => p.judge[d] !== "abstain" && p.human[d] !== "abstain" && p.judge[d] !== p.human[d],
    ).map((d) => `${d} judge ${p.judge[d]} / human ${p.human[d]}`);
    const abst = DIMENSIONS.filter((d) => p.judge[d] === "abstain" || p.human[d] === "abstain");
    out.push(
      `  ${pad(p.runId, 30)}${p.synthetic ? "[synthetic] " : ""}` +
        (diffs.length ? diffs.join("; ") : "full agreement") +
        (abst.length ? `; abstentions: ${abst.join(", ")}` : ""),
    );
  }

  out.push("");
  out.push(
    `${scored.length} pair(s)${real.length === 0 ? ", all synthetic" : `, ${real.length} real`}. ` +
      `"judge harsher" counts runs where the judge scored below the human.`,
  );
  return out.join("\n");
}
