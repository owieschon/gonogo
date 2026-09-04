/** Self-contained HTML verdict. No framework, no fetch, inline CSS only. */
import { DIMENSIONS } from "./types.ts";
import type { DimensionResult, VerdictFile } from "./types.ts";
import { isAbstain } from "./rubric.ts";

const VERDICT_COLOR: Record<string, string> = {
  go: "#1a7f37",
  "go-with-notes": "#7a6300",
  hold: "#9a4b00",
  "no-go": "#a30d1f",
  inconclusive: "#4b5563",
};

const DIMENSION_BLURB: Record<string, string> = {
  task_satisfaction: "does the work satisfy the spec as written",
  scope_discipline: "changes beyond or beside the ask",
  claim_verification: "completion claims vs. actual evidence",
  goal_alignment: "spec vs. the blind-pass inferred goal",
};

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function scoreLabel(d: DimensionResult): string {
  return isAbstain(d) ? "abstain" : String(d.score);
}

function scoreColor(d: DimensionResult): string {
  if (isAbstain(d)) return "#4b5563";
  const n = d.score as number;
  if (n >= 4) return "#1a7f37";
  if (n === 3) return "#7a6300";
  if (n === 2) return "#9a4b00";
  return "#a30d1f";
}

function sourceLabel(p: VerdictFile["provenance"]): string {
  const sources = p.pass_sources;
  if (!sources) {
    if (p.replayed && p.citation_repair?.source === "live") {
      return "partial cache — legacy blind/rubric source unavailable; citation repair: live judge";
    }
    if (p.replayed) {
      return p.citation_repair
        ? "replayed from the record/replay cache; citation repair: cache — no judge was invoked"
        : "replayed from the record/replay cache; no judge was invoked";
    }
    return "blind pass: live judge; rubric pass: live judge" +
      (p.citation_repair ? "; citation repair: live judge" : "");
  }
  const callSources = [
    sources.blind,
    sources.rubric,
    ...(p.citation_repair ? [p.citation_repair.source] : []),
  ];
  const details = `blind pass: ${sources.blind === "cache" ? "cache" : "live judge"}; ` +
    `rubric pass: ${sources.rubric === "cache" ? "cache" : "live judge"}` +
    (p.citation_repair
      ? `; citation repair: ${p.citation_repair.source === "cache" ? "cache" : "live judge"}`
      : "");
  if (callSources.every((source) => source === "cache")) {
    return `${details} — no judge was invoked`;
  }
  if (callSources.every((source) => source === "live")) return details;
  return `partial cache — ${details}`;
}

function citationRepairRow(p: VerdictFile["provenance"]): string {
  const repair = p.citation_repair;
  if (!repair) return "";
  const requested = repair.requested_dimensions.join(", ");
  const repaired = repair.repaired_dimensions.join(", ") || "none";
  const abstained = repair.abstained_dimensions.join(", ") || "none";
  return `\n  <tr><th>citation repair</th><td><span class="mono">${esc(repair.source)}</span> citation-only pass; ` +
    `the original scores were frozen. Requested: <span class="mono">${esc(requested)}</span>; ` +
    `repaired: <span class="mono">${esc(repaired)}</span>; safe abstentions: ` +
    `<span class="mono">${esc(abstained)}</span>.<br>` +
    `<span class="mono">prompt ${esc(repair.prompt_sha256.slice(0, 16))} · evidence ${esc(
      repair.evidence_sha256.slice(0, 16),
    )} · receipt ${esc(repair.receipt_sha256.slice(0, 16))}</span></td></tr>`;
}

function dimensionBlock(name: string, d: DimensionResult, blurb: string): string {
  const cites = isAbstain(d)
    ? (d.citations ?? [])
    : d.citations;
  const body = isAbstain(d)
    ? `<p class="reason"><strong>Abstained.</strong> ${esc(d.reason)}</p>`
    : `<p class="reason">${esc(d.reasoning)}</p>`;
  const citeHtml = cites.length
    ? `<ul class="cites">${cites
        .map((c) => `<li><code>${esc(c)}</code></li>`)
        .join("")}</ul>`
    : `<p class="nocite">no citations returned</p>`;
  return `<section class="dim">
  <h3><span class="score" style="background:${scoreColor(d)}">${esc(scoreLabel(d))}</span>
  <span class="dname">${esc(name)}</span></h3>
  <p class="blurb">${esc(blurb)}</p>
  ${body}
  ${citeHtml}
</section>`;
}

export function renderHtml(v: VerdictFile, opts: { title?: string } = {}): string {
  const p = v.provenance;
  const color = VERDICT_COLOR[v.verdict] ?? "#4b5563";
  const title = opts.title ?? `gonogo verdict — ${v.verdict}`;
  const dims = DIMENSIONS.map((d) =>
    dimensionBlock(d, v.dimensions[d], DIMENSION_BLURB[d] ?? ""),
  ).join("\n");
  const files = v.evidence_summary.changed_files;
  const testLine = v.evidence_summary.test
    ? `<code>${esc(v.evidence_summary.test.command)}</code> → exit ${v.evidence_summary.test.exit_code}`
    : "not run";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --fg:#14171a; --bg:#fbfbf9; --mut:#5b6169; --line:#dcdcd6; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e4; --bg:#16181a; --mut:#9aa1a9; --line:#2e3236; --card:#1d2022; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width: 46rem; margin:0 auto; padding: 1.25rem 1rem 4rem; }
  header { border-bottom:2px solid var(--line); padding-bottom:.85rem; margin-bottom:1.25rem; }
  .verdict { display:inline-block; background:${color}; color:#fff; font-weight:700;
             letter-spacing:.06em; text-transform:uppercase; font-size:1rem;
             padding:.3rem .7rem; border-radius:4px; }
  .overall { color:var(--mut); font-size:.85rem; margin-left:.5rem; }
  h1 { font-size:1.05rem; margin:.7rem 0 .2rem; font-weight:600; }
  h2 { font-size:.75rem; text-transform:uppercase; letter-spacing:.09em; color:var(--mut);
       margin:1.9rem 0 .6rem; font-weight:700; }
  h3 { margin:0 0 .2rem; font-size:.95rem; display:flex; align-items:center; gap:.5rem; }
  .score { display:inline-flex; align-items:center; justify-content:center; min-width:1.7rem;
           height:1.7rem; padding:0 .4rem; border-radius:4px; color:#fff; font-weight:700;
           font-size:.85rem; font-variant-numeric:tabular-nums; }
  .dname { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.88rem; }
  .dim { background:var(--card); border:1px solid var(--line); border-radius:6px;
         padding:.8rem .9rem; margin-bottom:.7rem; }
  .blurb { color:var(--mut); font-size:.8rem; margin:.1rem 0 .5rem; }
  .reason { margin:.35rem 0 .55rem; }
  .cites { margin:.4rem 0 0; padding-left:1.05rem; }
  .cites li { margin:.28rem 0; }
  .cites code, .nocite code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        font-size:.78rem; white-space:pre-wrap; overflow-wrap:anywhere; color:var(--fg); }
  .nocite { color:var(--mut); font-size:.8rem; font-style:italic; }
  .summary { background:var(--card); border:1px solid var(--line); border-left:4px solid ${color};
             border-radius:6px; padding:.9rem; }
  .inferred { background:var(--card); border:1px solid var(--line); border-radius:6px;
              padding:.9rem; font-style:italic; }
  table { border-collapse:collapse; width:100%; font-size:.82rem; }
  td, th { text-align:left; padding:.32rem .5rem .32rem 0; vertical-align:top;
           border-bottom:1px solid var(--line); overflow-wrap:anywhere; }
  th { color:var(--mut); font-weight:600; white-space:nowrap; width:11rem; }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem; }
  ul.files { margin:.2rem 0; padding-left:1.05rem; }
  ul.files li { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8rem;
                overflow-wrap:anywhere; }
  footer { margin-top:2.5rem; color:var(--mut); font-size:.75rem; border-top:1px solid var(--line);
           padding-top:.7rem; }
  .gaming { background:#a30d1f18; border:1px solid #a30d1f66; border-left:4px solid #a30d1f;
            border-radius:6px; padding:.85rem; margin:1.2rem 0 0; font-size:.86rem; }
  .gaming ul { margin:.5rem 0 0; padding-left:1.05rem; }
  .gaming code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.78rem;
                 white-space:pre-wrap; overflow-wrap:anywhere; }
  .warn { background:#9a4b0022; border:1px solid #9a4b0066; border-radius:4px;
          padding:.5rem .7rem; font-size:.8rem; margin-top:.7rem; }
</style>
</head><body><div class="wrap">

<header>
  <span class="verdict">${esc(v.verdict)}</span><span class="overall">overall ${
    v.overall_score === null ? "—" : esc(String(v.overall_score))
  } / 4 · min across four dimensions · judge confidence (model-reported, uncalibrated) ${esc(
    v.judge_confidence.toFixed(2),
  )}</span>
  <h1>${esc(title)}</h1>
  <div class="mono" style="color:var(--mut)">${esc(p.repo)} · base <code>${esc(
    p.base.slice(0, 12),
  )}</code> · ${
    p.head === p.base
      ? `head is the same commit &mdash; the work being judged is an uncommitted worktree diff`
      : `head <code>${esc(p.head.slice(0, 12))}</code>`
  }</div>
</header>

${
  v.attempted_gaming
    ? `<div class="gaming"><strong>Attempted gaming.</strong> The evidence contained text
  addressed to the judge. It was not followed. The instruction is reported here because an
  agent that tries to influence its own evaluation has said something about the rest of its
  work.<ul>${v.gaming_evidence
    .map((g) => `<li><code>${esc(g)}</code></li>`)
    .join("")}</ul></div>`
    : ""
}

<h2>Summary</h2>
<div class="summary">${esc(v.summary)}</div>
<p class="blurb">drift type: <code>${esc(v.drift_type)}</code></p>

<h2>Dimensions</h2>
${dims}

<h2>Blind pass — inferred goal</h2>
<div class="inferred">${esc(v.inferred_goal)}</div>
<p class="blurb">Written by a judge call given only the diff and transcript as attachments — no
separate spec attachment was sent. The transcript is opaque text, not a scrubbed one: if it
repeats the spec or the original request, the judge sees that too. Blind means no spec
attachment, not spec-free content.
<code>goal_alignment</code> scores the gap between this inference and the actual spec.</p>

<h2>Reported, not scored</h2>
<div class="dim">
  <h3><span class="score" style="background:${scoreColor(v.spec_clarity)}">${esc(
    scoreLabel(v.spec_clarity),
  )}</span><span class="dname">spec_clarity</span></h3>
  <p class="blurb">how judgeable the spec itself was — this scores the spec's author, not the agent</p>
  ${
    isAbstain(v.spec_clarity)
      ? `<p class="reason"><strong>Abstained.</strong> ${esc(v.spec_clarity.reason)}</p>`
      : `<p class="reason">${esc(v.spec_clarity.reasoning)}</p>`
  }
</div>

<h2>Evidence</h2>
<table>
  <tr><th>changed files</th><td>${
    files.length
      ? `<ul class="files">${files.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
      : "none"
  }</td></tr>
  <tr><th>diffstat</th><td><code>${esc(v.evidence_summary.diff_stat || "—")}</code></td></tr>
  <tr><th>test command</th><td>${testLine}</td></tr>
  <tr><th>transcript</th><td>${v.evidence_summary.transcript_present ? "provided" : "not provided"}</td></tr>
  <tr><th>commit messages</th><td>${
    v.evidence_summary.commits ? esc(String(v.evidence_summary.commits)) + " commit(s)" : "none"
  }</td></tr>
</table>
${
  v.evidence_summary.truncated.diff || v.evidence_summary.truncated.transcript
    ? `<div class="warn">Evidence was truncated before it reached the judge (${[
        v.evidence_summary.truncated.diff ? "diff" : null,
        v.evidence_summary.truncated.transcript ? "transcript" : null,
      ]
        .filter(Boolean)
        .join(", ")}). Treat this verdict as partial.</div>`
    : ""
}

<h2>Provenance</h2>
<table>
  <tr><th>gonogo version</th><td class="mono">${esc(p.gonogo_version)}</td></tr>
  <tr><th>source</th><td class="mono">${esc(sourceLabel(p))}</td></tr>
  <tr><th>run id</th><td class="mono">${esc(v.run_id ?? "—")}</td></tr>
  <tr><th>task id</th><td class="mono">${esc(v.task_id ?? "—")}</td></tr>
  <tr><th>workspace id</th><td class="mono">${esc(v.workspace_id ?? "—")}</td></tr>
  <tr><th>judge backend</th><td class="mono">${esc(p.judge_backend)}</td></tr>
  <tr><th>model version</th><td class="mono">${esc(p.model_version)}</td></tr>
  <tr><th>models reported</th><td class="mono">${esc(p.models_reported.join(", "))}</td></tr>
  <tr><th>prompt files</th><td class="mono">${p.prompt_files
    .map((f) => `${esc(f.path)} <span style="color:var(--mut)">${esc(f.sha256.slice(0, 16))}</span>`)
    .join("<br>")}</td></tr>
  <tr><th>subject sha256</th><td class="mono">${esc(v.subject_hash ?? "unavailable (legacy verdict)")}</td></tr>
  <tr><th>spec sha256</th><td class="mono">${esc(p.spec_sha256)}</td></tr>
  <tr><th>diff sha256</th><td class="mono">${esc(p.diff_sha256)}</td></tr>
  <tr><th>started</th><td class="mono">${esc(p.started_at)}</td></tr>
  <tr><th>duration</th><td class="mono">${esc((p.duration_ms / 1000).toFixed(1))}s</td></tr>
  <tr><th>cost</th><td class="mono">${p.cost_usd === null ? "—" : "$" + p.cost_usd.toFixed(4)}</td></tr>${
    p.rubric_parse_retries
      ? `\n  <tr><th>parse retries</th><td class="mono">${esc(
          String(p.rubric_parse_retries),
        )} rubric-pass repl${p.rubric_parse_retries === 1 ? "y" : "ies"} discarded as unparseable and re-asked</td></tr>`
      : ""
  }${citationRepairRow(p)}${
    !p.citation_repair && p.rubric_citation_retries
      ? `\n  <tr><th>historical citation rerates</th><td>${esc(
          String(p.rubric_citation_retries),
        )} whole-rubric response${p.rubric_citation_retries === 1 ? " was" : "s were"} discarded and re-asked by a pre-repair run; scores were not frozen</td></tr>`
      : ""
  }
</table>

<footer>
  Generated by gonogo ${esc(p.gonogo_version)}. The overall verdict is the minimum of the four
  scored dimensions, not their average — a failure on one axis is not paid for by strength on
  another. Scoring rules: RUBRIC.md.
</footer>

</div></body></html>
`;
}
