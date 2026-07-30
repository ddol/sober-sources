# Claim-grounding consumption eval: PDF vs Markdown vs MCP

**Status:** Core (slice 4) · **Flow:** B · **Depends on:**
[service-layer.md](service-layer.md), [fts5-full-text-search.md](fts5-full-text-search.md)
(shipped slices, the tools under test). Decision input for
[visual-extraction.md](visual-extraction.md) and
[vector-hybrid-search.md](vector-hybrid-search.md).

citation-needed exists to ground an LLM agent in **factual claims from papers a
researcher already holds**: Flow B, hallucination mitigation. The architecture
bet under question: the pipeline invests heavily in PDF→Markdown extraction
(~15 deterministic repair passes, the 2000-line quality scorer), but conversion
demonstrably loses information: display-equation structure, grouped table
headers, figure semantics ([visual-extraction.md](visual-extraction.md)).

Nothing today measures whether that loss matters downstream.
`score-markdown-quality` measures extraction fidelity against `pdftotext
-layout` pseudo-ground-truth; it does not measure whether an **LLM answers
claim-verification questions correctly** from each consumption surface. This
plan designs that eval.

## The fork this eval resolves

- If an LLM verifies claims just as accurately (and cheaply) from **raw PDFs**,
  the extraction code is over-investment and the service should serve PDFs or
  page regions instead.
- If **markdown** holds accuracy at a fraction of the tokens, extraction is
  validated and the parser scope should _expand_ (per
  [visual-extraction.md](visual-extraction.md)).
- If the **MCP retrieval layer** preserves accuracy at near-constant token cost
  regardless of corpus size, the service architecture is validated as the
  consumption surface and becomes the documented recommendation.

## Consumption modes under test

| Mode                     | Delivery                                                                      | Token economics per claim                      | Structural limit                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 `pdf-direct`           | Anthropic native PDF (text + page images) in context                          | whole PDF ≈ 2–4× markdown tokens (page images) | doesn't scale past a few papers; 100-page cap; **per-request size cap** (measured: 14 of 25 served corpus papers exceed 4MB, one at 30MB is unservable at all); must know _which_ paper to load |
| 2 `markdown-context`     | extracted markdown in context                                                 | whole paper ≈ 15–25K tokens                    | same "which paper?" problem; corpus-in-context breaks at tens of papers                                                                                                                         |
| 3 `mcp-agent`            | tool loop: `search-citations` → `read-content` → `verify-quote`               | a few chunks per claim, ~O(1) in corpus size   | accuracy bounded by lexical FTS retrieval + markdown fidelity                                                                                                                                   |
| 3.5 hybrid _(candidate)_ | MCP locates via markdown index, serves original **PDF page images** on demand | retrieval-priced locating + PDF-priced reading | new tool (`read-page-image` via `pdftoppm`); built only if the results demand it                                                                                                                |

The structural insight the modes table encodes: claim verification is **many
small queries against a corpus where the containing paper is unknown**. Modes
1–2 pay the whole corpus per claim (or need an oracle for which paper to load);
mode 3's cost is flat in corpus size. So the questions are (a) does markdown
lose _accuracy_ vs PDF per paper, (b) does retrieval preserve that accuracy
corpus-wide, and (c) where markdown loses, is the fix parser expansion or
hybrid page-image serving.

## Tenet check

The charter says the search core stays deterministic and LLM features live
outside it. The eval is entirely outside: a top-level `eval/` directory,
excluded from the Jest suite and the coverage ratchet, hitting the Anthropic
API with real keys. `npm test` never touches it. The eval _consumes_ the
production pipeline (`reextractMarkdownFromPdfFolder`, `createMcpServer`)
without modifying it.

## Phase 0: token economics (free, run first)

Before any accuracy eval: analytic cost curves per mode. Token-count each
corpus paper as PDF (via the `count_tokens` endpoint with a document block) and
as markdown; compute cost-per-claim vs corpus size (1 → 8 → extrapolated
50/200 papers) per mode, with and without prompt caching. Zero eval spend, and
it answers the "least tokens" half of the question on its own, including
whether modes 1–2 are even candidates at field-scale corpora.

## Corpus

**60 papers** (`eval/corpus/manifest.json`), built by `eval/corpus/build.ts`:

- **19 seed** perception papers from the existing velocity.report set, spanning
  the known failure classes. **Liang2020 / LaneGCN** is the documented worst
  case (mangled Eq. 10, dropped end-of-paper figures, grouped-header tables);
  Caesar2020 is table-dense; Bewley2016 is the short clean-prose control.
- **41 mined** references, selected by pulling every seed paper's reference list
  from OpenAlex (`eval/corpus/mine-references.ts`) and ranking by how many seed
  papers cite a work (foundational to this corpus) and its global citation count
  (seminal). `eval/corpus/select.ts` then drops duplicate records, non-papers,
  metadata artifacts, and pre-arXiv scanned classics, since the pipeline has no
  OCR path and their result is known a priori.

The corpus serves two roles: a **deep subset of ~9 failure-class papers** carries
the single-paper claims that measure extraction damage, and all 60 act as the
retrieval substrate and decoy pool for the corpus-wide categories.

Nothing is checked in except the manifest: `{ id, origin, title, arxivId, doi,
pages, sha256, tags, source }`. PDFs are fetched by arXiv id or OA URL and
sha256-pinned (extraction is deterministic, so pinned PDF ⇒ pinned markdown ⇒
stable eval input), then materialised into a gitignored `eval/corpus/cache/`.
Markdown is rebuilt via the production extractor (`extractPdfMarkdown`,
`src/verification/markdown.ts`), so the eval consumes exactly what the tool
produces. Per-paper `score-markdown-quality --json` output is persisted for the
fidelity correlation below.

## Task suite: claim verification, not generic QA

Each item is a **claim + gold verdict (`supported` / `refuted` / `not-found`) +
gold evidence location** (page + verbatim span). Categories map to the failure
classes and to the hallucination-mitigation mission. The first six are
single-paper (served the containing paper); the last three are the
not-supported family and corpus-wide probes (served a decoy).

| Category          | Probes                                                              | Gold      | Expected signature                                             |
| ----------------- | ------------------------------------------------------------------- | --------- | -------------------------------------------------------------- |
| Verbatim          | exact sentences from papers                                         | supported | all modes should find; mode 3 has `verify-quote`               |
| Paraphrased       | semantically supported, different wording                           | supported | stresses lexical FTS (no embeddings) vs full-context reading   |
| Numeric/table     | "minADE 0.87 at K=6" + a perturbed-number refuted twin              | either    | markdown hurt by flattened grouped headers                     |
| Equation          | a property of a displayed equation (which symbol is the margin)     | either    | markdown hurt by lost sub/superscripts                         |
| Figure-dependent  | content only visible in a figure                                    | supported | markdown/MCP near floor; measures the ceiling vision would buy |
| **Not-addressed** | plausible, in-domain, additive, the paper silent                    | not-found | **the core hallucination probe**: headline false-supported     |
| Contradicted      | the paper fills a single-valued slot differently than the claim     | refuted   | tests catching an _implied_ contradiction, not a stated one    |
| Attribution       | "X was shown in paper P" (actually paper Q); both P and Q in corpus | not-found | corpus-wide; where modes 1–2 structurally break                |

**Full 60-paper corpus budget (~170 items).** The corpus is 60 papers, but not
all need deep claims: single-paper claims measure per-paper extraction damage,
so they are authored for a **deep subset of ~10 papers** spanning the failure
classes (the 3 pilot papers plus, e.g., PointNet and Faster R-CNN for
equation/table density, VoxelNet for architecture figures, HOTA for metric
definitions). The corpus-wide categories exploit the full 60 as retrieval
substrate and distractor set.

| Group         | Categories                                                               | Count                  |
| ------------- | ------------------------------------------------------------------------ | ---------------------- |
| Deep subset   | verbatim, paraphrase, numeric, numeric-table, equation, figure-dependent | ~10 papers × ~11 ≈ 110 |
| Not-addressed | additive-and-silent, decoys spread across the 60                         | ~30                    |
| Contradicted  | single-valued slot differs, decoy-served                                 | ~15                    |
| Attribution   | wrong-paper attribution, both papers in the corpus                       | ~15                    |

~170 items, enough for paired per-claim comparisons (McNemar / bootstrap) to
detect the ~15 pp differences that would change the roadmap. Not-addressed and
contradicted together (~45) carry the headline hallucination number, which a
false-supported rate on 10 items (±25 pp CI) cannot; both are cheap to author.

Per-category counts are pre-registered alongside the claims before any run.
Category and paper are otherwise confounded (equation claims cluster in
equation-dense papers, making the "equation delta" really that paper's delta),
so each single-paper category draws from at least 3 deep-subset papers where the
corpus allows; where it cannot, the delta is reported as paper-specific rather
than category-general.

**Authoring:** LLM-drafted with page number and verbatim evidence span,
**from the original PDF only, never from the extracted markdown**. A claim
authored from mangled markdown inherits the mangling and cannot detect what
conversion lost; the contamination silently deflates the mode 1 − mode 2 gap
in extraction's favor. Every item is human-verified against the PDF before
entering the suite (verification depth decided at scheduling, alongside
spend). A wrong gold verdict silently corrupts every downstream number, so no
unverified item counts. Perturbed-number refuted twins are checked for
collisions: the perturbed value must not coincidentally appear elsewhere in
the same paper, or a "refuted" claim is accidentally supported.

**Grading is mechanical everywhere.** Models answer through a fixed structured
output schema `{ verdict, evidence?, confidence }`. The **verdict is the
primary grade**; the evidence check (reusing `normalizeForMatch` /
`VerifyQuoteService`, `src/services/verify-quote.ts`) is secondary and never
flips a verdict grade: gold spans are PDF-sourced while the matcher was built
for markdown, so an evidence mismatch can be a surface artifact (ligatures,
hyphenation) rather than a wrong answer. `confidence` is collected for exactly
one pre-registered analysis, the calibration curve on absent claims (metric
5); it feeds no decision rule. No LLM judge in v1.

### Labeling policy

The pilot surfaced that "absent" conflated two situations a model rightly
answers differently, so the verdict is defined by what the **served paper**
licenses, and the not-supported family is split into two categories:

- **`refuted` / `contradicted`:** the paper fills a **single-valued slot** (its
  architecture, evaluation benchmark, training objective, association method, or
  a reported number) with a value the claim contradicts. A careful reader
  concludes the claim is false from this paper alone. "Uses a transformer"
  against a paper whose stated architecture is a GCN.
- **`not-found` / `not-addressed`:** the claim is **additive** to what the
  paper describes (an extra sensor, annotation type, pretraining step, tool)
  and the paper is silent. Nothing in it bears on the claim. This is the pure
  hallucination probe.
- The `not-found` / `refuted` boundary is inherently fuzzy for borderline
  claims, so the **headline metric for the whole not-supported family is the
  false-`supported` rate** ("did the model wrongly assert support?"), with
  exact three-way accuracy a secondary number. Authors write only clear-cut
  cases into each category; a claim that cannot be placed cleanly is not
  authored. The model prompt carries these same definitions.

### Mode × category applicability

Modes 1–2 need a paper in context, so every claim pre-registers which paper
each mode receives; the assignment ships with the claim, never decided at run
time.

- **Single-paper claims:** modes 1–2 get the containing paper. That is an
  oracle mode 3 does not get, and the asymmetry is the point: it measures each
  consumption surface at its best.
- **Absent claims:** modes 1–2 get a pre-registered decoy, the corpus paper an
  over-eager model would most plausibly attribute the claim to. The headline
  false-`supported` rate depends entirely on this protocol, so it is fixed
  here, not chosen per run.
- **Attribution / corpus-level claims:** mode 2 gets the full corpus (~160K
  markdown tokens, fits one context window). Mode 1 cannot: 8 PDFs at 2–4×
  markdown tokens exceed the window, so those cells are recorded as
  **structurally unsupported** rather than scored as failures. That boundary
  is itself a result, not missing data.

## Harness

Top-level `eval/`, outside `src/` (coverage ratchet) and `test/` (Jest; add
`/eval/` to `testPathIgnorePatterns` as belt-and-braces). One runner, one
`ModeAdapter` interface, three mode adapters plus one control arm: mode is the
only variable; claim, schema, and grading are identical, so any delta is
attributable to the consumption surface.

- **pdf-direct / markdown-context**: single Anthropic SDK call with the
  document or markdown block plus the claim.
- **mcp-agent**: an MCP `Client` connected to `createMcpServer(db)`
  (`src/mcp/server.ts`) over `InMemoryTransport` (in-process, exercising the
  exact production tool handlers), driven by a manual tool loop (~60 lines,
  fully observable token accounting; deliberately not the Agent SDK, which
  brings its own tools and blurs accounting).
- **retrieval-oracle** (control, not a mode): the mode-2 adapter fed only the
  gold evidence chunk instead of the whole paper, run on every mode-3 item.
  The evidence-reached metric separates retrieval failure from reading failure
  observationally; this arm does it causally, and it bounds what fixing
  retrieval could ever buy before anyone touches `src/services/chunker.ts`.
  Also the cheapest arm to run: smallest context of the four.
- **Models:** two: a cheap model (amplifies input-quality differences) and a
  mid-tier model (shows whether strength papers over conversion damage). Model
  ids are config strings. **The cheap model's full-corpus run binds the
  decision rules;** the mid-tier run is a robustness check. If the two
  disagree on a rule, the outcome is the dead zone: any action that adds
  investment needs both models to agree.
- **Decode settings:** temperature 0, single run per (claim × mode × model),
  fixed here so variance cannot be shopped after the fact. The replay cache
  freezes whatever stochasticity remains.
- **Cost controls:** replay cache keyed on request hash (mode, model, claim,
  **and the system prompt**, so a prompt change misses instead of silently
  reusing answers from the old instructions), plus prompt caching on the paper
  block per (paper, mode) group, and a `maxCostUsd` abort guard. In the pilot,
  caching cut the 61-claim × 2-mode run to ~$0.50 (2.9M cache-read vs 3K fresh
  input tokens). Spend approval is decided at scheduling.
- **Output:** JSONL per (claim × mode × model) containing verdict, grade,
  usage, latency, and tool transcript, plus a report mirroring
  `score-markdown-quality`'s summary/`--json` style, with a
  `--fail-below-baseline` gate.

## Metrics

1. Verdict accuracy per (category × mode × model); paired per-claim deltas
   with bootstrap CIs, not point estimates.
2. **False-`supported` rate on the not-supported family** (not-addressed +
   contradicted + attribution): the headline hallucination number, the failure
   this tool exists to prevent. Reported across the family rather than by exact
   not-found/refuted match, since that boundary is fuzzy. The ~60-item
   allocation exists so this rate carries a usable CI.
3. Tokens and USD **per correct verdict** (the "most accurate, least tokens"
   axis), and latency. Reported per category; a category near the accuracy
   floor is flagged, not divided by.
4. Evidence-reached rate (mode 3): the gold span, after `normalizeForMatch`,
   appears in at least one chunk a tool call returned in the transcript. A
   wrong verdict _with_ evidence reached is a reasoning failure; _without_, a
   retrieval/chunking failure. The retrieval-oracle arm confirms the split
   causally: oracle ≈ mode 2 means retrieval is the whole gap.
5. Calibration on absent claims, from the `confidence` field: a
   high-confidence false-`supported` is the worst possible output of this
   tool. Exploratory; feeds no decision rule.
6. Fidelity correlation, **exploratory only**: `score-markdown-quality`
   sub-scores vs per-claim mode 1 − mode 2 correctness. Per claim (~170
   points), not per paper: 60 papers with ~2 deep-claim papers each cannot
   estimate a per-paper correlation reliably. Suggestive evidence about the
   scorer as a proxy, never a gate decision.
7. Evidence-verdict consistency (surfaced by the pilot): the fraction of
   wrong-verdict answers whose quoted evidence in fact supports the gold
   verdict: the model retrieved the right sentence and still labeled it wrong.
   A cheap model showed this on ~2 claims in both modes; it is a reasoning
   weakness independent of the consumption surface, and it separates
   "input-quality" failures (which the mode comparison is about) from
   "model-quality" failures (which it is not). Reported per model.

## Pre-registered decision rules

Written here _before_ any run so results cannot be rationalized afterward. All
thresholds bind on the cheap model's full-corpus run (the mid-tier run is the
robustness check; see Harness). Δ is the paired per-claim accuracy delta with
its 95% bootstrap CI.

**Equivalence is asserted, never defaulted to.** With ~20 items per category a
CI that merely includes zero spans ±20 pp and proves nothing; low power would
read as "markdown validated", which is the outcome that flatters the existing
code. "No difference" is only concluded when the CI rules substantial
difference _out_ (an equivalence margin, TOST-style), never when the data is
too thin to detect one.

**Markdown vs PDF** (Δ = mode 1 − mode 2; evaluated in order, first match
wins):

| #   | Observation                                                    | Roadmap action                                                                                                               |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Δ ≥ 10 pp on prose/verbatim claims, CI excluding 0             | Conversion loses more than layout features: audit repair passes; hybrid page-image serving becomes the default candidate     |
| 2   | Δ ≥ 15 pp on equation or table claims, CI excluding 0          | Expand the parser per [visual-extraction.md](visual-extraction.md) (Nougat pass), or build hybrid 3.5 if Phase-0 favors it   |
| 3   | CI for Δ entirely below +5 pp in every category except figures | **Markdown validated**; extraction investment justified; deprioritize visual extraction except figure enrichment             |
| 4   | Anything else (the dead zone)                                  | No roadmap change: extend the claim set in the undecided categories and re-run. Deciding on this data would be rationalizing |

**MCP layer** (Δ = mode 2 − mode 3; same semantics):

| #   | Observation                                                                                                      | Roadmap action                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CI for Δ entirely below +5 pp, at ≤ 25% of mode 2's tokens per correct verdict, mode 3 wins absent + attribution | **MCP service architecture validated**; document as the recommended surface                                                                   |
| 2   | Δ > 0 with CI excluding 0, evidence-reached < 70%, oracle arm ≈ mode 2                                           | Fix retrieval first: chunking (`src/services/chunker.ts`), FTS query construction, revisit [vector-hybrid-search.md](vector-hybrid-search.md) |
| 3   | Δ > 0 with CI excluding 0, evidence-reached ≥ 70% (or oracle arm also trails mode 2)                             | The gap is reading, not retrieval: markdown fidelity or claim difficulty; defer to the markdown-vs-PDF cascade's outcome                      |
| 4   | Anything else (the dead zone)                                                                                    | No roadmap change, as above                                                                                                                   |

The fidelity correlation (metric 6) drives no rule: at this corpus size it is
directional evidence only. Both of its former actions (keeping
`score-markdown-quality` as the per-commit gate, or recalibrating its weights)
wait for replication at per-claim granularity.

The mode-2 eval additionally becomes the **regression gate** for extractor
changes: rebuild markdown for the corpus, skip papers whose bytes are
unchanged, re-run mode 2 on changed papers only (replay cache makes unchanged
answers free), compare per-category accuracy against a checked-in baseline via
`--fail-below-baseline`, the same shape as `--fail-below` today.

## Results to date

Three runs so far, all modes 1-2 only. Mode 3 is unbuilt, so no MCP-layer rule
can fire yet.

| Run                      | Items | pdf-direct                       | markdown-context  | Spend  |
| ------------------------ | ----- | -------------------------------- | ----------------- | ------ |
| Pilot, Haiku 4.5         | 61    | 90%                              | 85%               | ~$0.50 |
| Pilot, Sonnet 5          | 61    | 93%                              | 93%               | ~$0.61 |
| **Full suite, Sonnet 5** | 167   | **87%** (145/166, 1 unsupported) | **87%** (146/167) | ~$3.30 |

**The markdown-vs-PDF cascade lands in the dead zone (rule 4), so no roadmap
change.** The cheap model put pdf-direct ahead by 5 pp, concentrated entirely in
figure-dependent claims; the mid-tier model erased the gap (0 pp) and scored
figure claims 100% from markdown as well as from PDF. The pre-registered
precedent is explicit: when the two models disagree, any action that adds
investment needs both to agree. So the parser neither expands nor shrinks on
this evidence. What the disagreement itself says is that Haiku's figure deficit
was a model-capability limit, not purely extraction loss: the captions markdown
preserves are enough for a stronger reader.

**The headline hallucination number is clean: 0 false-`supported` in 333 graded
calls**, across 54-55 not-supported items per mode.

**The mirror-image number is not clean, and is the real finding of this run:
over-refutation runs 19/54 (35%) pdf-direct, 18/55 (33%) markdown-context.**
Sonnet frequently answers `refuted` rather than `not-found` for
not-addressed/attribution claims, concentrated in attribution (50-61% verdict
accuracy, all misses `refuted`) and not-addressed (72-75%). This is symmetric
risk to false-`supported`: a system this willing to assert a negative beyond
what the served document grounds will misfire the same way on a real corpus
whenever retrieval hands it the wrong paper. It is now tracked as its own
metric rather than folded into gold (see below).

**Exact three-way accuracy understates this, and the gap is diagnostic.** Of 42
wrong verdicts, 37 (88%) are the not-found/refuted boundary, running one way:
the model answers `refuted` where the gold says `not-found`, concentrated in
attribution and not-addressed claims (the same 19/54 and 18/55 counted as
over-refutation above).

**Decision: the gold does not move.** The tempting reading is that a careful
reader, told "X was introduced in paper P" by a paper that plainly introduces
something else, calls the claim false rather than unverifiable, so the gold
should follow the model. Rejected, on inspection of the actual transcripts:
several of these `refuted` calls reach past what the served document grounds.
`at-3` refutes "the nuScenes paper introduces HOTA" by quoting a sentence about
a _different_ prior metric (Weng and Kitani's), not anything that rules out
nuScenes introducing HOTA; `at-21` refutes an unrelated attribution by quoting
SemanticKITTI's own abstract, which never mentions Faster R-CNN at all. A
model confidently asserting `refuted` from a document that is simply silent is
the same overreach the false-`supported` metric exists to catch, just signed
the other way. Relabeling gold to match it would reward the overreach instead
of measuring it. The pre-registered design already routes around this:
false-`supported` (the headline) is unaffected either way, and the whole
not-found/refuted boundary was named fuzzy by design in the labeling policy
above, which is why exact three-way accuracy was demoted to secondary before
any run. **Metric added: over-refutation rate** (confident `refuted` on a
`not-addressed`/`attribution` item), reported per model alongside
false-`supported`, since a system this confidently wrong in the negative
direction is a finding, not noise to be relabeled away.

**The remaining 5 errors are not a boundary artifact, and are worth naming
individually** (a 6th, `ho-9`, was a bad claim rather than a model error; fixed,
and no longer appears in this count):

- `bew-2` and `wa-3` (markdown-context only): the model quoted the _exact_
  correct supporting sentence as its evidence field, verbatim, and still
  answered wrong. The markdown was independently checked byte-for-byte against
  the claim and is clean. This is metric 7 (evidence-verdict inconsistency),
  first seen on Haiku in the pilot, reproducing on Sonnet: a reasoning failure
  orthogonal to the consumption surface.
- `lia-14` (both modes): the deliberately hard equation case (the loss weight
  `α` vs the margin `ε` in a different equation). Both modes answer
  `not-found` rather than the gold `refuted`, i.e. the model would not commit
  to the distinction rather than getting it wrong; a defensible hedge on a
  genuinely subtle read, not a mistake to fix.
- `abs-3` (pdf-direct only): `not-found` against a gold of `refuted` for the
  implied "2D bounding-box tracker doesn't fuse lidar for 3D detection"
  contradiction. The paper never states the negative outright, so `not-found`
  is arguably as defensible as `refuted` here; recorded as a marginal call, not
  a defect.
- `ho-9`: was a bad claim. It said HOTA combines "localization and
  association"; the model correctly pointed out, quoting the paper's own
  formula, that HOTA is the geometric mean of _detection_ and association,
  with localization averaged in separately. Fixed in the claim, not the model.

**New structural limit for mode 1:** a base64 PDF must fit in one request, and
real papers often do not (see the modes table). This is separate from the
100-page cap and tightens the Phase 0 conclusion that pdf-direct does not reach
corpus scale.

## Phasing

1. **Phase 0, token economics.** _Done._ Free; answered the cost axis
   analytically across the 60-paper corpus (PDF ≈ 3× markdown tokens, retrieval
   flat, modes 1–2 break in the low tens of papers). See `eval/phase0/report.md`.
2. **Pilot.** _Done_ (`eval/pilot/`, 61 claims × 2 modes, Haiku 4.5, ~$0.50).
   Both exit questions answered yes: formats are mechanically gradable and the
   deltas are visible (pdf-direct 90% vs markdown-context 85%, the gap almost
   entirely figure-dependent claims at 100% vs 33%). The run earned its keep by
   catching what a scored run must not inherit: one mis-authored gold (a loss
   weight read as a margin), the not-found/refuted labeling ambiguity now
   settled above, a cheap-model reasoning weakness (evidence-verdict
   inconsistency, metric 7), and a harness bug (a greedy JSON parse, and a
   cache key that ignored the prompt). All fixed before Phase 1.
3. **Phase 1.** Full modes 1–2 harness: corpus builder, adapters, structured
   output, mechanical grading, replay cache, report. The claim suite is
   authored, human-verified, and **frozen before the first scored run**:
   per-category counts, the mode × category assignment, and each absent
   claim's decoy paper are committed under `eval/claims/` as the
   pre-registration artifact. Changing them after seeing results is allowed
   only as an explicitly labelled second suite, never as an edit.
4. **Phase 2.** Mode 3 adapter, the retrieval-oracle control arm, corpus-wide
   claims, tool-transcript capture, evidence-reached metric.
5. **Phase 3.** Decision memo against the rules above, fidelity correlation as
   exploratory context, regression-gate baseline.

Deferred: scanned/OCR paper, LLM-judge grading, Batches API runs, more than two
models, stdio-subprocess transport, hybrid 3.5 implementation (only if the
rules trigger it).

## Non-goals

- No LLM calls inside the deterministic core, the Jest suite, or CI's default
  path: the eval is invoked deliberately.
- Not a general model benchmark: models are held constant to compare
  consumption surfaces, not vendors.
- No unverified ground truth: an item that hasn't been human-checked does not
  count toward any number.
- Not powered for small effects. The suite is sized to detect the ~15 pp
  differences that change the roadmap; anything below the equivalence margin
  is reported as undecided, not as absence of an effect.
