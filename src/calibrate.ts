/**
 * Judge-versus-human agreement, computed over rater events.
 *
 * Everything that scores a run — the judge, a human reviewer, and later a second
 * or third judge in a panel — is a rater with an id. Agreement is computed for
 * every pair of raters that scored the same run, so panel mode is data rather
 * than code. Load-bearing once Run 01 data exists; today it runs on the
 * synthetic pairs and says so.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DIMENSIONS } from "./types.ts";
import type { HumanFile, VerdictFile } from "./types.ts";
import { EVENT_SCHEMA_VERSION, isJudgeEvent, isRaterEvent, readEvents } from "./events.ts";
import type { GonogoEvent } from "./events.ts";
import { GONOGO_VERSION } from "./version.ts";

type Scores = Record<string, number | "abstain">;

interface Rating {
  runId: string;
  raterId: string;
  scores: Scores;
  synthetic: boolean;
}

/**
 * The operator's flow is unchanged: write runs/<ts>/human.json next to
 * verdict.json. Those directories are read as rater events without being
 * rewritten, so the log can be the computation substrate without the directory
 * layout having to move first.
 */
function ratingsFromDirs(dir: string): Rating[] {
  if (!existsSync(dir)) return [];
  const out: Rating[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDir = join(dir, entry.name);
    const vp = join(runDir, "verdict.json");
    const hp = join(runDir, "human.json");
    if (!existsSync(vp) || !existsSync(hp)) continue;
    const v = JSON.parse(readFileSync(vp, "utf8")) as VerdictFile;
    const h = JSON.parse(readFileSync(hp, "utf8")) as HumanFile;
    const judgeScores: Scores = {};
    for (const d of DIMENSIONS) {
      const r = v.dimensions[d];
      judgeScores[d] = r.score === "abstain" ? "abstain" : (r.score as number);
    }
    const synthetic = h.synthetic === true;
    out.push({
      runId: entry.name,
      raterId: `judge:${v.provenance.judge_backend}`,
      scores: judgeScores,
      synthetic,
    });
    out.push({
      runId: entry.name,
      raterId: h.reviewer,
      scores: h.dimensions as Scores,
      synthetic,
    });
  }
  return out;
}

function ratingsFromEvents(events: GonogoEvent[]): Rating[] {
  const out: Rating[] = [];
  for (const e of events) {
    if (isJudgeEvent(e)) {
      // Replayed runs are the same judgement served twice; counting them would
      // inflate agreement without adding an observation.
      if (e.replay) continue;
      out.push({ runId: e.run_id, raterId: e.rater_id, scores: e.scores, synthetic: false });
    } else if (isRaterEvent(e)) {
      out.push({
        runId: e.run_id,
        raterId: e.rater_id,
        scores: e.scores,
        synthetic: e.synthetic === true,
      });
    }
  }
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function padL(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

export interface CalibrateOptions {
  eventsPath: string;
  dirs: string[];
}

export function runCalibrate(o: CalibrateOptions): string {
  const { events, malformed } = readEvents(o.eventsPath);
  const ratings = [...ratingsFromEvents(events), ...o.dirs.flatMap(ratingsFromDirs)];

  // The same (run, rater) may appear both in the log and in a run directory.
  // First writer wins; the log is read first because it carries more fields.
  const seen = new Map<string, Rating>();
  for (const r of ratings) {
    const key = `${r.runId} ${r.raterId}`;
    if (!seen.has(key)) seen.set(key, r);
  }

  const byRun = new Map<string, Rating[]>();
  for (const r of seen.values()) {
    if (!byRun.has(r.runId)) byRun.set(r.runId, []);
    byRun.get(r.runId)!.push(r);
  }

  // A comparison needs two raters on the same run. Anything else is a run
  // nobody double-scored, which is what Phase 1 of the trust ratchet exists
  // to eliminate.
  const pairs: { runId: string; a: Rating; b: Rating; synthetic: boolean }[] = [];
  for (const [runId, rs] of byRun) {
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const first = rs[i]!;
        const second = rs[j]!;
        // Order the pair so a judge is always side A; the direction of
        // disagreement only means something if the sides are stable.
        const [a, b] = first.raterId.startsWith("judge:") ? [first, second] : [second, first];
        pairs.push({ runId, a, b, synthetic: first.synthetic || second.synthetic });
      }
    }
  }

  const out: string[] = [];
  const unscored = [...byRun.values()].filter((rs) => rs.length < 2).length;

  if (pairs.length === 0) {
    return [
      "No double-scored runs found.",
      "",
      `${byRun.size} run(s) carry exactly one rating, so there is nothing to compare.`,
      "Agreement needs two raters on the same run: the judge, and you.",
      "",
      "Record your own verdict after a judged run as runs/<ts>/human.json — same four",
      "dimensions, same 0-4 anchors as RUBRIC.md, written before you read the judge's.",
      "calibration/README.md has the protocol; calibration/synthetic/ has the shape.",
      malformed > 0 ? `\n${malformed} malformed line(s) skipped in ${o.eventsPath}.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const real = pairs.filter((p) => !p.synthetic);
  const synth = pairs.filter((p) => p.synthetic);

  if (real.length === 0) {
    out.push("=".repeat(72));
    out.push("SYNTHETIC DATA ONLY — these numbers measure nothing.");
    out.push("Every pair below was hand-written to exercise the aggregation. No human has");
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
  const pairKeys = [...new Set(scored.map((p) => `${p.a.raterId} vs ${p.b.raterId}`))].sort();

  for (const key of pairKeys) {
    const group = scored.filter((p) => `${p.a.raterId} vs ${p.b.raterId}` === key);
    out.push(`rater pair: ${key}   (${group.length} run${group.length === 1 ? "" : "s"})`);
    out.push(
      pad("  dimension", 20) +
        padL("exact", 8) +
        padL("within 1", 10) +
        padL("mean gap", 10) +
        padL("A harsher", 12) +
        padL("B harsher", 12),
    );
    out.push("  " + "-".repeat(70));
    for (const d of DIMENSIONS) {
      const usable = group.filter(
        (p) =>
          typeof p.a.scores[d] === "number" && typeof p.b.scores[d] === "number",
      );
      if (usable.length === 0) {
        out.push(pad(`  ${d}`, 20) + padL("no comparable pairs (abstentions only)", 52));
        continue;
      }
      const deltas = usable.map((p) => (p.a.scores[d] as number) - (p.b.scores[d] as number));
      const exact = deltas.filter((x) => x === 0).length;
      const within1 = deltas.filter((x) => Math.abs(x) <= 1).length;
      const mean = deltas.reduce((a, b) => a + Math.abs(b), 0) / deltas.length;
      out.push(
        pad(`  ${d}`, 20) +
          padL(`${exact}/${usable.length}`, 8) +
          padL(`${within1}/${usable.length}`, 10) +
          padL(mean.toFixed(2), 10) +
          padL(String(deltas.filter((x) => x < 0).length), 12) +
          padL(String(deltas.filter((x) => x > 0).length), 12),
      );
    }
    out.push("");
  }

  out.push("per-run disagreements (published as-is)");
  for (const p of scored) {
    const diffs = DIMENSIONS.filter(
      (d) =>
        p.a.scores[d] !== "abstain" &&
        p.b.scores[d] !== "abstain" &&
        p.a.scores[d] !== p.b.scores[d],
    ).map((d) => `${d} ${p.a.raterId} ${p.a.scores[d]} / ${p.b.raterId} ${p.b.scores[d]}`);
    const abst = DIMENSIONS.filter(
      (d) => p.a.scores[d] === "abstain" || p.b.scores[d] === "abstain",
    );
    out.push(
      `  ${pad(p.runId, 30)}${p.synthetic ? "[synthetic] " : ""}` +
        (diffs.length ? diffs.join("; ") : "full agreement") +
        (abst.length ? `; abstentions: ${abst.join(", ")}` : ""),
    );
  }

  out.push("");
  out.push(
    `${scored.length} comparison(s)${
      real.length === 0 ? ", all synthetic" : `, ${real.length} real`
    }; ${unscored} run(s) have only one rating and were not compared.`,
  );
  out.push(
    `events schema v${EVENT_SCHEMA_VERSION}, gonogo ${GONOGO_VERSION}. ` +
      `"A harsher" counts runs where side A scored below side B.`,
  );
  if (malformed > 0) out.push(`${malformed} malformed line(s) skipped in ${o.eventsPath}.`);
  return out.join("\n");
}
