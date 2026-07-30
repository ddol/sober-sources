# Claim-grounding eval

Measures whether an LLM verifies factual claims from a paper more accurately
from raw PDFs, from extracted markdown, or through this service's MCP retrieval
layer. Design and pre-registered decision rules:
[docs/plans/claim-grounding-eval.md](../docs/plans/claim-grounding-eval.md).

This tree is deliberately outside `src/` (no coverage ratchet) and `test/` (not
run by Jest; `/eval/` is in `testPathIgnorePatterns`). It hits the Anthropic API
with a real key. `npm test` and CI never touch it.

## Layout

```
eval/
  corpus/mine-references.ts  seed papers -> OpenAlex references, ranked (no key)
  corpus/select.ts           curate the ranking into the expansion set
  corpus/build.ts            fetch PDFs + extract markdown -> cache/ + manifest
  corpus/manifest.json       the corpus, pinned by sha256 (PDFs not checked in)
  lib/tokens.ts              deterministic token estimator (+ optional count_tokens)
  phase0/economics.ts        per-claim cost model per mode x corpus size
  phase0/run.ts              Phase 0 runner -> report.md + report.json
  phase0/report.md           generated Phase 0 findings
  pilot/claims.jsonl         pilot claim subset (3 papers, 61 items)
  pilot/grade.ts             mechanical grader (verdict primary, evidence secondary)
  pilot/run.ts               runner: pdf-direct vs markdown-context (--claims to pick a suite)
  claims/suite.jsonl         full claim suite: 167 items over the 60-paper corpus
```

## Building the corpus

The corpus is 19 perception papers we already hold (from the sibling
`velocity.report` repo) plus references mined from them by cross-citation, for
60 total. Nothing but `manifest.json` is checked in; PDFs and markdown are
materialised on demand into a gitignored `corpus/cache/`.

```
npx ts-node --transpile-only eval/corpus/mine-references.ts   # -> candidates.json
npx ts-node --transpile-only eval/corpus/select.ts            # -> selection.json
npx ts-node --transpile-only eval/corpus/build.ts             # -> cache/ + manifest.json
```

`mine-references` pulls each seed's reference list from OpenAlex (free, no key)
and ranks referenced works by how many seeds cite them (foundational to this
corpus) and their global citation count (seminal). `select` dedupes and drops
non-papers, scanned pre-arXiv classics (no OCR path), and metadata artifacts.
`build` fetches each PDF, runs it through the production markdown extractor, and
pins it by sha256 so a pinned PDF yields pinned markdown yields stable input.
`build` is resumable and records misses in `build-log.json`.

## Phase 0: token economics (free, offline)

```
npx ts-node --transpile-only eval/phase0/run.ts
```

No key needed. Writes `eval/phase0/report.md`. With `ANTHROPIC_API_KEY` set it
also calls `count_tokens` (billed at zero) to replace estimated markdown counts
with exact ones; the curves and conclusions do not change.

## Pilot: pdf-direct vs markdown-context

Offline smoke test (canned perfect answers; verifies the grader and that the
claim formats are gradable, zero spend):

```
npx ts-node --transpile-only eval/pilot/run.ts --dry
```

Real run needs **both** of these, which are not present by default:

1. `npm i -D @anthropic-ai/sdk`
2. `export ANTHROPIC_API_KEY=...`

```
npx ts-node eval/pilot/run.ts --model claude-haiku-4-5-20251001 --max-usd 2
```

`--max-usd` (default 2) aborts the run before it overspends; a replay cache
under `eval/pilot/.cache/` makes reruns free.

## Status

- **Phase 0:** complete, offline. See `phase0/report.md`.
- **Pilot:** ran (`eval/pilot/`, 61 claims × 2 modes, Haiku 4.5, ~$0.50).
  pdf-direct 90% vs markdown-context 85%, the gap almost entirely
  figure-dependent claims (100% vs 33%); zero false-supported. See the plan doc.
- **Full suite:** `claims/suite.jsonl`, **167 items** over the 60-paper corpus:
  deep single-paper claims for 9 failure-class papers plus corpus-wide
  attribution and not-addressed probes served to decoys. All nine categories,
  81 supported / 31 refuted / 55 not-found, every evidence span quoted from the
  original PDF. Drafted and self-checked but **not yet independently
  human-verified**; freeze and verify before the first scored Phase 1 run.
  Dry-grade it with `run.ts --dry --claims eval/claims/suite.jsonl`; a real run
  needs the runner pointed at `eval/corpus/cache/` (Phase 1 wiring), since the
  suite serves mined papers that live there, not in `velocity.report`.
