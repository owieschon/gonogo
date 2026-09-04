# Recorded verdict demo audit

This records the two self-judge runs and the independent prerequisite correction for the recorded verdict demo.

The [task specification](recorded-demo-spec.md) adds a replay-only demo command. The first [public verdict](recorded-demo-initial-verdict.json) judges `d5ea191732e8ef8db53760e6dc9185e49d03bad4` against `59b0742`: `go`, overall 4/4. Independent code review then found that the README omitted Node.js, which the fixture's test command requires. Commit `1fb7e5ac813ef318ad32cdc57972e32978202bec` corrects that prerequisite. Its [public verdict](recorded-demo-prerequisite-verdict.json) is also `go`, overall 4/4. Both results are retained; the second run evaluates changed documentation.

The self-judge ran typecheck and the replay gate. A separate full suite passed 199 tests, including three new demo tests. Those tests fail on the unchanged base because the demo module does not exist. The runs left the committed event log and replay receipts unchanged.

The tool-free Claude calls used the configured CLI authentication. A local launcher omitted `--bare`, which disables keychain discovery, while retaining empty tool, settings-source, and MCP arguments. These are audits of the named implementation commits, not a calibration study or a claim that the judge catches every defect. The first run's missed Node.js prerequisite is one observed limit.

Public copies omit private accounting metadata. Original unedited receipts are retained privately. Scores, findings, citations, evaluated source identities, and failed or missed checks are unchanged.
