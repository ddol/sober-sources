# citation-needed backlog

Anti-hallucination academic citation assistant: BibTeX → local PDFs + Markdown, with SQLite tracking and MCP server.

**Sizes:** XS < 1 h · S 1–4 h · M half–full day · L 2–3 d · XL week+
**Tags:** [fetch] [flow] [parse] [db] [cli] [mcp] [tui] [verify] [test] [auth] [deploy] [docs] [devx] [util] [cfg] [search] [valid] [api] [storage]

**Scope:** work is either **Core** (the one workflow below, scheduled) or **Exploratory** (designed and parked in [docs/plans/](docs/plans/README.md), unscheduled until the core loop proves valuable in daily use). The Exploratory section is ordered by user-flow priority:

- **Flow A, own-library authoring**: a researcher uses their own paper library in their own work.
- **Flow B, claims from papers already held**: a researcher checks other authors' claims when the relevant papers are already present.
- **Flow C, claims from papers not yet held**: a researcher checks other authors' claims when relevant papers may be missing.
- **Infrastructure**: foundations, secondary surfaces, scale, packaging, and deployment.

---

## Core: grounded answers from your own library

The workflow the product must nail before anything else: import a `.bib` → PDFs download and extract (**already works**) → index → an agent over MCP can **find** (`search-citations`), **read** (`read-content`), and **check** (`verify-quote`): grounded, checkable answers from the researcher's own corpus. Interim discovery: mount a community Semantic Scholar/OpenAlex MCP server alongside; the agent composes.

### Slice 4: is the pipeline worth its own code?

The core loop now runs end to end, which makes its central bet testable for the
first time: extraction to Markdown is a large investment that provably loses
information. Slice 4 measures whether an agent answers claim-verification
questions better from raw PDFs, from extracted Markdown, or through this
service, and the answer decides whether the parser expands, shrinks, or stays.
Nothing here ships product surface; the deliverable is a decision backed by
pre-registered rules (see docs/plans/claim-grounding-eval.md).

- [x] Claim-grounding eval Phase 0: token-economics across the 60-paper corpus (eval/phase0/); PDF ~3x Markdown tokens, retrieval flat, modes 1-2 break in the low tens of papers
- [x] Claim-grounding eval pilot: 61 claims x 2 modes on the 3 pilot papers (eval/pilot/, Haiku 4.5, ~$0.50); deltas visible (pdf 90% vs markdown 85%, gap is figures), formats gradable, labeling policy settled
- [x] Claim-grounding corpus: 60 papers (19 perception seed + 41 cross-citation-mined references) built via the production extractor, sha256-pinned in eval/corpus/manifest.json
- [x] Claim-grounding claim suite: 167 items drafted from the original PDFs in eval/claims/suite.jsonl (9 deep failure-class papers + 32 not-addressed + 14 contradicted + 23 attribution). Verified: every evidence-bearing claim checked against extracted PDF text (0 real mismatches after accounting for pdftotext hyphenation artifacts), every contradicted/numeric-table/equation claim's verdict logic reviewed by hand, 3 weak-evidence claims strengthened, 1 bad claim fixed (ho-9). Self-verification, not an independent second reviewer; frozen for Phase 1 (see docs/plans/claim-grounding-eval.md)
- [x] Claim-grounding second model: Sonnet 5 run on the 167-item suite (87%/87%, ~$3.30); mode delta from the Haiku pilot is gone, 0 false-supported in 333 calls, 5 genuine errors after removing not-found/refuted boundary noise, markdown-vs-PDF cascade lands in the pre-registered dead zone (see docs/plans/claim-grounding-eval.md)
- [x] Claim-grounding gold-relabel question: decided against relabeling attribution/not-addressed claims to `refuted` to match the model. Transcripts show the model asserting `refuted` from documents that are simply silent (overreach, not a corrected reading); relabeling would reward it. Added an over-refutation-rate metric instead of moving gold (see docs/plans/claim-grounding-eval.md)
- [verify] L - Claim-grounding eval Phase 1: generalise the pilot script into the full harness under eval/, outside Jest and the coverage ratchet; one runner, one ModeAdapter per consumption mode, replay cache, cost guard (see docs/plans/claim-grounding-eval.md)
- [verify] M - Claim-grounding eval Phase 2: mcp-agent mode over InMemoryTransport against createMcpServer(db), the retrieval-oracle control arm, plus corpus-wide and absent-claim categories (see docs/plans/claim-grounding-eval.md)
- [verify] M - Claim-grounding decision memo: apply the pre-registered rules to the results, record the parser-scope decision, and wire the Markdown mode in as the extractor regression gate (see docs/plans/claim-grounding-eval.md)

---

## Exploratory

Deliberately unscheduled until the core loop is proven in use. Nothing is deleted. Designs stay parked in their plan docs (statuses: Exploratory). Items keep their `(see docs/plans/…)` refs and are ordered by the flow rubric above.

### Flow A: own-library authoring

- [docs] S - Document Better BibTeX auto-export (pinned keys, file field) as the zero-code Zotero → citation-needed path (see docs/plans/zotero-integration.md)
- [flow] M - Link Zotero storage and linked-file attachment PDFs as manifestations instead of re-downloading (see docs/plans/zotero-integration.md)
- [search] S - SearchService filters: year range, verification status, access type, has-pdf (see docs/plans/service-layer.md)
- [verify] M - Markdown post-processing: remove artefact lines, normalise headings (improves chunk quality; see docs/plans/fts5-full-text-search.md; serves B)
- [verify] S - Quality metrics for extracted Markdown (word count, section count, table detection; doubles as chunker input validation; see docs/plans/fts5-full-text-search.md)
- [test] S - FTS benchmark script: index size and query latency at 1k/10k docs, with a size-per-document budget (see docs/plans/fts5-full-text-search.md; serves A)
- [cli] M - `search` CLI command as second-surface adapter over SearchService + MCP/CLI parity test (see docs/plans/service-layer.md)
- [parse] M - Zotero JSON export import: metadata + capture item key, library id, tags, collections, attachment paths (see docs/plans/zotero-integration.md)
- [parse] S - Opt-in --update import mode: gap-fill null fields, overwrite only non-protected fields, report changes (see docs/plans/zotero-integration.md)
- [fetch] M - Metadata enrichment from Crossref: abstract, keywords, licence, ISSN (abstract unlocks abstract search; serves A; see docs/plans/retrieval-pipeline.md)
- [db] M - tags + collections join tables populated from Zotero import; SearchService and API filters (see docs/plans/zotero-integration.md)
- [search] S - Emit zotero://select links in search/MCP/API results when item key known (verify supported URL forms first; see docs/plans/zotero-integration.md)
- [mcp] S - Generate MCP tool inputSchema from the shared zod contracts for all tools, removing hand-maintained JSON Schema blocks (see docs/plans/service-layer.md)
- [verify] M - Evaluate external extractor filter contract: configurable stdin-PDF→stdout-Markdown command (marker/nougat/OCR user-wired; pdf2md default) (see docs/plans/fts5-full-text-search.md)
- [verify] XL - OCR fallback for scanned PDFs (tesseract.js or external API), a future extract-stage variant that may become a user-wired extractor filter (see docs/plans/indexing-jobs.md)
- [db] M - identifiers table (scheme+value UNIQUE: arxiv, pmid, zotero-key, zotero-library, bibtex-key); DOI stays on citations (see docs/plans/domain-model.md; serves D)
- [parse] M - RIS reference format import (.ris files; needs format-interop plan before scheduling)
- [cli] M - `export` CLI command: write BibTeX/RIS/JSON from database (needs format-interop plan before scheduling)
- [parse] S - CSV metadata import (title + DOI columns; needs format-interop plan before scheduling)

_Deferred (Flow A future): semantic + hybrid search modes, parked in docs/plans/vector-hybrid-search.md until FTS5 quality is observed on a real corpus._

### Flow B: claims from papers already held

- [cli] M - `verify` CLI command: re-check all citations and update verification status (doubles as manifestation location health check; see docs/plans/storage-adapters.md)
- [mcp] S - MCP tool: get-retrieval-log (download attempt history for a DOI; needs RetrievalService detail pass before scheduling; see docs/plans/service-layer.md)
- [cli] XS - `stats` CLI command: citation status summary and database size (needs CitationService detail pass before scheduling; see docs/plans/service-layer.md)
- [storage] S - Availability checks: last_seen_at refresh, unavailable status surfaced in search results and `verify` CLI (see docs/plans/storage-adapters.md)
- [verify] L - Reference list extraction from extracted Markdown (cited-papers discovery; owned by docs/plans/local-bibliography-spider.md; cross-checked against graph edges; see docs/plans/citation-graph.md)
- [verify] S - Cross-check extracted reference lists against graph edges; flag extraction/graph gaps (see docs/plans/local-bibliography-spider.md and docs/plans/citation-graph.md)
- [cli] S - `update` CLI command: re-download or refresh metadata for a single citation (needs CitationService/RetrievalService detail pass before scheduling; see docs/plans/service-layer.md)
- [mcp] S - MCP tool: update-citation metadata (needs CitationService detail pass before scheduling; see docs/plans/service-layer.md)

### Flow C: claims from papers not yet held

- [mcp] S - MCP tool check-corpus: batch DOI membership join (member|frontier|absent) (see docs/plans/citation-graph.md)
- [verify] M - Local bibliography parser: detect reference sections in extracted Markdown and parse raw reference entries into structured metadata (see docs/plans/local-bibliography-spider.md)
- [db] M - reference_mentions + reference_match_candidates tables for extracted bibliography evidence and local alignment review (see docs/plans/local-bibliography-spider.md)
- [fetch] M - Crossref enrichment for parsed references missing DOI or enough metadata, fixture-tested and disabled with --no-crossref (see docs/plans/local-bibliography-spider.md)
- [flow] M - spider-references metadata-only workflow: scan member papers, create frontier citations, and store alignment issues without downloading PDFs (see docs/plans/local-bibliography-spider.md)
- [cli] M - reference-issues and reference-review commands for accepting/rejecting fuzzy local match candidates (see docs/plans/local-bibliography-spider.md)
- [mcp] M - MCP tools: spider-references, get-reference-issues, verify-reference-match; check-corpus reports ambiguous matches (see docs/plans/local-bibliography-spider.md)
- [test] M - Bibliography spider fixtures: reference splitting, Crossref enrichment, exact DOI linking, fuzzy candidate review, frontier creation (see docs/plans/local-bibliography-spider.md)
- [fetch] M - GraphSource interface + Semantic Scholar client (references/citations with isInfluential, recommendations; rate-limited, cached) (see docs/plans/citation-graph.md)
- [db] M - citation_edges table + corpus_status (member|frontier) on citations via migration runner (see docs/plans/citation-graph.md)
- [test] S - GraphSource fixture tests: recorded API responses, edge idempotency, rate-limit respect (see docs/plans/citation-graph.md)
- [fetch] S - Graph-source open-access PDF URLs as an additional retrieval-cascade source (see docs/plans/citation-graph.md)
- [flow] M - expand-corpus: bounded snowball job kind (depth/budget/filters, frontier stubs, identifiers dedupe) + MCP/CLI trigger (see docs/plans/citation-graph.md)
- [fetch] M - OpenAlex GraphSource client (bulk edges via cites: filter, related_works, topics; API key required) (see docs/plans/citation-graph.md)
- [mcp] M - MCP tools: get-references + get-citing-papers (sort by influence|recency); edges cached on lookup (see docs/plans/citation-graph.md)
- [mcp] S - MCP tool related-papers: recommendations from seed paper(s) (see docs/plans/citation-graph.md)
- [cli] M - `trends` command: new works citing corpus members since last run → digest file; cron-scheduled, no in-core scheduler (see docs/plans/citation-graph.md)
- [fetch] S - DoiResolver: populate isOpenAccess field, currently always undefined (see docs/plans/retrieval-pipeline.md)
- [fetch] M - Extend the shared http-retry backoff to the PDF GET itself; today it covers lookups only (see docs/plans/retrieval-pipeline.md)
- [fetch] M - Publisher-hosted PDFs 403 on our User-Agent (MDPI confirmed): send a browser-like UA, fall through to the next source, or record the URL for manual fetch (see docs/plans/retrieval-pipeline.md)
- [fetch] S - Semantic Scholar API key support: the unauthenticated pool is shared and throttles unpredictably; a key buys a guaranteed quota (see docs/plans/retrieval-pipeline.md)
- [auth] M - Proxy rotation across multiple configured institutional proxies, currently only proxies[0] used (see docs/plans/retrieval-pipeline.md)
- [fetch] L - Implement Springer Link PDF resolution via publisher adapter (see docs/plans/retrieval-pipeline.md)
- [fetch] L - Implement Elsevier ScienceDirect PDF resolution via publisher adapter (see docs/plans/retrieval-pipeline.md)
- [fetch] L - Implement ACM Digital Library PDF resolution via publisher adapter (see docs/plans/retrieval-pipeline.md)
- [fetch] M - Wire publisher adapters into RetrievalOrchestrator fallback chain, the cascade re-entry gate (see docs/plans/retrieval-pipeline.md)
- [auth] M - API key management for publisher APIs (Elsevier, Springer) (see docs/plans/retrieval-pipeline.md)
- [fetch] L - PubMed/NCBI E-utilities resolver for life-sciences papers (see docs/plans/retrieval-pipeline.md)
- [auth] XL - SAML/Shibboleth SSO authentication for institutional access (needs institutional-access plan before scheduling; see docs/plans/retrieval-pipeline.md)
- [db] M - Admit DOI-less citations: relax import guards; identity via identifiers + generated internal id (see docs/plans/domain-model.md; serves C, D)
- [db] M - Citation deduplication via fuzzy title matching before insert; consult identifiers table once available (see docs/plans/domain-model.md)
- [db] S - identifiers schemes += semantic-scholar-id, openalex-id (extend CHECK) (see docs/plans/domain-model.md)

### Infrastructure: foundations, secondary surfaces, scale

- [flow] S - CitationService consolidation: MCP get/list and CLI list delegate to one service; CLI list gains pagination (see docs/plans/service-layer.md; serves A, D)
- [db] S - Store Zotero item key + library id in identifiers table on import (see docs/plans/zotero-integration.md and docs/plans/domain-model.md)
- [db] S - Database backup and restore commands (needs backup/restore plan before scheduling)
- [storage] M - StorageAdapter interface + LocalFileAdapter; route all PDF/markdown reads through it (see docs/plans/storage-adapters.md)
- [db] S - Normalize manifestation paths to file:// URIs (migration + write-path change; see docs/plans/storage-adapters.md)
- [cfg] M - Persistent config file (~/.citation-needed/config.json) for default flags (consumed by HTTP API port/token; see docs/plans/http-api.md)
- [flow] M - jobs table (kind, payload, status, attempts, last_error) + in-process worker loop; per-entry jobs with batch_id; 3 auto-retries with backoff then manual (see docs/plans/indexing-jobs.md)
- [mcp] M - Job-backed import over MCP: import-bibtex returns a job id immediately and the agent polls, instead of blocking the tool call for the length of the import. A corpus-sized .bib now runs the full pipeline inside one MCP request and will hit client timeouts (see docs/plans/indexing-jobs.md)
- [flow] M - Stage-based pipeline (resolve → download → extract → chunk → fts-index) with per-stage provenance on manifestations/chunks (see docs/plans/indexing-jobs.md)
- [flow] S - Incremental re-index rules: skip unchanged content_hash; extractor/chunker version bump invalidates downstream stages only (see docs/plans/indexing-jobs.md)
- [flow] L - Concurrent PDF downloads via job worker pool with configurable concurrency limit (see docs/plans/indexing-jobs.md; serves C)
- [flow] M - Resume interrupted imports via persisted job state (see docs/plans/indexing-jobs.md)
- [cli] S - `jobs` CLI command: list, status, retry failed (see docs/plans/indexing-jobs.md)
- [test] M - Crash-resume and idempotency tests: kill worker mid-batch → restart completes without re-downloading; rerun produces zero new work (see docs/plans/indexing-jobs.md)
- [api] M - Add hono + @hono/node-server + @hono/zod-openapi; `serve` CLI command (--port default 4871, loopback default) (see docs/plans/http-api.md)
- [api] M - GET /api/v1/health, /capabilities, /citations (cursor pagination), /citations/{doi} (see docs/plans/http-api.md)
- [api] M - POST /api/v1/search bound to SearchService via the shared zod contract (see docs/plans/http-api.md)
- [api] M - OpenAPI: serve /api/v1/openapi.json generated from route schemas; emit openapi/citation-needed-v1.yaml as build artifact (see docs/plans/http-api.md)
- [api] S - RFC 7807 problem+json error responses; static bearer-token auth (required for non-loopback binds) + request logging (see docs/plans/http-api.md)
- [test] M - HTTP integration tests: routes, problem+json shapes, MCP/HTTP search parity (see docs/plans/http-api.md)
- [docs] S - docs/http-api.md usage reference (see docs/plans/http-api.md)
- [docs] S - docs/composition.md: satellite pipe contract (BibTeX/JSONL in via import, digest files out; SQLite is not a public API, read-only at most) + cron recipes for trends (see docs/plans/citation-graph.md)
- [flow] L - `watch` mode as filesystem-watcher job producer: monitor a directory for new .bib files and auto-import (see docs/plans/indexing-jobs.md)
- [mcp] S - MCP tool: delete-citation (needs CitationService detail pass before scheduling; see docs/plans/service-layer.md)
- [flow] L - Zotero 7 local HTTP API import (localhost:23119) with incremental pull (see docs/plans/zotero-integration.md)
- [flow] M - Webhook notification on batch import completion (configurable URL; needs notification plan before scheduling; see docs/plans/indexing-jobs.md)
- [tui] S - ImportProgress reads the jobs table for progress; survives restarts and shows watch-mode work (see docs/plans/indexing-jobs.md)
- [tui] L - Interactive TUI: multi-select bulk operations (delete, re-download; Ink-eligible as live redraw; see DESIGN.md § Terminal output)
- [tui] M - Interactive TUI: paginated, sortable, filterable citations table (Ink-eligible as live redraw; the static table stays plain; see DESIGN.md § Terminal output)
- [tui] M - Interactive TUI: live per-citation download progress bars (Ink-eligible as live redraw; see DESIGN.md § Terminal output)
- [deploy] M - npm publish pipeline and versioned GitHub Releases (needs release plan before scheduling)
- [deploy] L - Docker container image and Compose file for server mode (also serves the HTTP API; see docs/plans/http-api.md)
- [deploy] S - Systemd service unit file for persistent MCP server daemon (and the `serve` HTTP daemon; see docs/plans/http-api.md)

---

## Completed

Slice 3, one pipeline and one locator:

- [storage] S - Manifestation-first content resolution: markdown-locator reads manifestations(kind='markdown-extracted') via Database, existence-checked; legacy stem fallback self-heals a manifestation row on hit (see docs/plans/domain-model.md)
- [test] S - Locator coverage: custom --markdown-path import readable via MCP, markdown-only manifestation, manifestation row with missing file (see docs/plans/domain-model.md)
- [flow] M - ImportService consolidation: CLI and MCP import-bibtex delegate to one service; MCP runs the full pipeline by default with a metadata-only option (see docs/plans/service-layer.md)
- [test] S - Import parity: the same fixture .bib through CLI and MCP yields identical citations, manifestations, retrieval-log rows, and summary counts (see docs/plans/service-layer.md)
- [test] S - Test harness guardrails: Jest ignores .claude/ worktrees, watchman off, DB test dirs via mkdtemp under os.tmpdir()
- [fetch] S - Drop tryPublisher from the active retrieval cascade; adapters and their tests stay as parked scaffolding (see docs/plans/retrieval-pipeline.md)
- [fetch] XS - Unexport DoiResolver from the retrieval barrels until Crossref enrichment schedules it (see docs/plans/retrieval-pipeline.md)

- [tui] S - Plain output for static commands; Ink isolated to ImportProgress; list/download/auth/index/reset print plain stdout/stderr via src/cli/output.ts (see DESIGN.md § Terminal output)
- [cli] S - `reset` maintenance command: wipe citations + dependents, optional --files to delete tracked PDFs/Markdown, dry run unless --yes
- [fetch] S - arXiv identity check: quoted phrase queries + title-similarity threshold on candidates, best match not first (see TENETS.md § Relevance is not identity)
- [fetch] M - Semantic Scholar resolver in the cascade after Unpaywall; reaches repository-hosted PDFs no other source has (see docs/plans/retrieval-pipeline.md)
- [fetch] S - Honour each host's published rate limit and back off on 429/5xx via shared http-retry; a throttled lookup no longer reports as a missing paper (see DESIGN.md § Retrieval and access)
- [fetch] S - Shared title-match with two thresholds: strict for title search, loose for DOI lookups where the DOI already proves identity (see DESIGN.md § Retrieval and access)
- [fetch] S - Contact email enables Unpaywall/Semantic Scholar: honour CITATION_NEEDED_EMAIL, treat placeholder domains as unset, and name the fix in attempts (see docs/auth-setup.md)
- [tui] S - Import progress: finished rows move to Ink's <Static> so the live tree stays short; a live tree taller than the terminal made Ink clear and repaint the whole screen every frame (see DESIGN.md § Terminal output)
- [fetch] M - Recover throttled DOIs: RetrievalResult.throttled marks a DOI refused before lookup; the import queues those, waits THROTTLE_COOLDOWN_MS, clears the breaker and retries once (see docs/plans/retrieval-pipeline.md)
- [db] M - Versioned migration runner (PRAGMA user_version + ordered steps in src/db/migrations.ts); existing ad-hoc migrators become bootstrap (see docs/plans/domain-model.md)
- [db] M - manifestations table as single source of truth for files; Database class derives Citation.pdfPath; pdf_path dormant after one transition release (see docs/plans/domain-model.md)
- [db] S - Backfill manifestations from existing pdf_path values and papers/markdown/ stems
- [util] S - Streaming sha256 content-hash helper; hash PDFs and Markdown at write time (see docs/plans/domain-model.md)
- [db] S - Spike: assert FTS5 available in bundled better-sqlite3 (CREATE VIRTUAL TABLE smoke test in CI, macOS ARM64 + Linux)
- [verify] S - Heading-based Markdown chunker: sectionPath from heading trail, ~2000-char max split (see docs/plans/fts5-full-text-search.md)
- [db] M - chunks table (citation_id, manifestation_id, ordinal, section_path, text, content_hash) via migration runner
- [search] M - External-content FTS5 tables (chunks_fts, citations_fts; porter unicode61) with sync triggers (see docs/plans/fts5-full-text-search.md)
- [search] M - SearchService lexical mode on FTS5: bm25 ranking, snippet() highlights, section provenance; LIKE fallback pre-index
- [cli] S - `index` CLI command: one-shot (re)index into chunks + FTS; idempotent by content_hash; eager re-chunk on chunker version bump
- [mcp] S - verify-quote v2: FTS fuzzy fallback + section provenance + closest-miss via chunks (see docs/plans/fts5-full-text-search.md)
- [test] S - Search fixture corpus + golden-query tests (phrase, stemming, unicode, section scope)

- [search] M - Extract SearchService (src/services/search.ts) with shared zod contract; lexical mode over extended Database.searchCitations (see docs/plans/service-layer.md)
- [db] S - Extend Database.searchCitations: LIKE over journal/bibtex_key/doi + limit/cursor pagination reusing encodeCursor
- [mcp] M - MCP tool: search-citations over SearchService; trimmed result summaries (see docs/plans/service-layer.md)
- [mcp] M - MCP tool read-content: serve extracted Markdown by DOI, paginated; pdf_path-sibling stem fallback now, manifestations lookup later (see docs/plans/service-layer.md)
- [mcp] M - MCP tool verify-quote v1: normalize a quoted passage, exact-match against extracted Markdown; verdict exact|not-found (see docs/plans/fts5-full-text-search.md)
- [test] S - Core-tool tests: SearchService + search-citations, read-content, verify-quote v1

- [test] L - Add tests for all CLI commands (import, list, download, auth, server)
- [test] M - Add tests for OpenAccessDownloader
- [test] M - Add tests for AuthenticatedDownloader
- [test] M - Add tests for RetrievalOrchestrator integration paths
- [test] S - Add tests for auth config load/save
- [test] S - Add tests for DoiResolver
- [test] S - Add tests for publisher adapter URL helpers (Springer, Elsevier, ACM)
- [test] S - Add tests for PDF Markdown extraction (extractPdfMarkdown)
- [test] S - Add tests for CitationsTable TUI component
- [test] S - Expand MCP server tests beyond basic tool registration
- [test] XS - Add tests for getCitationFileStem / getCitationDisplayName
- [test] XS - Set jest coverageThreshold so CI fails below acceptable coverage
- [devx] S - Add ESLint with TypeScript rules
- [devx] S - Add Prettier with pre-commit hook
- [devx] S - Enable TypeScript strict mode (noImplicitAny, noUnusedLocals, noImplicitReturns)
- [devx] XS - Read version from package.json at runtime, removing 4 hardcoded "0.1.0" strings
- [devx] XS - Remove ignoreDeprecations: "5.0" from tsconfig and fix root cause
- [devx] XS - Add pretest type-check step to package.json scripts
- [devx] XS - Add test:coverage script with threshold enforcement
- [fetch] S - ArxivResolver, UnpaywallResolver, DoiResolver silently swallow errors; log and propagate message
- [fetch] S - Surface RetrievalOrchestrator warning logs into RetrievalResult.message
- [fetch] XS - Remove deprecated ArxivRetriever and UnpaywallRetriever re-exports
- [fetch] XS - Remove dead publisher getAdapter() import in orchestrator or wire it up
- [fetch] XS - Move hardcoded resolver timeouts (15 000 ms) and rate limit (1 000 ms) to config constants
- [fetch] XS - Fix User-Agent in doi.ts and open-access.ts: read version from package.json, email from auth config
- [db] S - Add indexes on doi and created_at columns
- [db] S - Wrap processBibtexFile in a DB transaction; partial failure currently leaves DB inconsistent
- [db] XS - Add CASCADE DELETE on retrieval_log foreign key to prevent orphaned rows
- [db] XS - Add CHECK constraints on verification_status and access_type enum columns
- [mcp] S - Add schema validation for MCP tool arguments, removing unsafe type casts
- [mcp] S - Stream progress events from import-bibtex MCP tool during processing
- [mcp] S - Add cursor-based pagination to list-citations MCP tool
- [flow] S - Persist batch import failures to DB so they form an audit log
- [flow] S - Report skipped entries (no DOI) in processBibtexFile output
- [tui] XS - Colour-code citation status in CitationsTable
- [tui] XS - Make CitationsTable column widths adaptive rather than hardcoded
- [valid] XS - Validate email format before storing in auth config
- [valid] XS - Validate DOI format before database insert
- [docs] XS - Add .env.example file
- [docs] XS - Fix README output directory examples to match actual defaults (papers/pdf/, papers/markdown/)

- [fetch] L - (5) AuthenticatedDownloader: Playwright browser automation for proxy-gated content
- [fetch] M - RetrievalOrchestrator: coordinated cascade (cache → Unpaywall → arXiv → authenticated)
- [fetch] M - OpenAccessDownloader: HTTP PDF download with rate limiting and local cache check
- [fetch] M - ArxivResolver: title-based Atom XML search with retry for rate limits
- [fetch] M - UnpaywallResolver: open-access PDF URL discovery via Unpaywall API
- [fetch] M - DoiResolver: Crossref metadata lookup (title, authors, year, journal, publisher)
- [fetch] S - Stubbed publisher URL adapters: Springer, Elsevier, ACM (landing page URL only)
- [flow] M - (5) processBibtexFile workflow with per-entry onProgress callbacks and failure tracking
- [parse] S - BibTeX file parsing via bibtex-parse library
- [parse] S - DOI parsing, normalization, and extraction from URLs
- [parse] S - URL classification (arxiv/doi/pubmed/pdf/html/unknown)
- [db] M - SQLite database via better-sqlite3 with migration support
- [db] S - Citation CRUD with UPSERT-on-DOI semantics
- [db] S - Retrieval attempt logging table (source, url, success, duration_ms)
- [db] S - Full-text search on title/authors in DB layer
- [cli] M - CLI command: import-bibtex with --paper-path, --markdown-path, --email flags
- [cli] S - CLI command: download single PDF by DOI with optional --url and --email
- [cli] S - CLI command list: Ink/React table view of all stored citations
- [cli] S - CLI command: auth add-proxy with --login-url, --username, --password-env
- [cli] XS - CLI command auth set-email: stores email in ~/.citation-needed/auth.json
- [cli] XS - CLI command auth show: masked display of current auth config
- [cli] XS - CLI command server: start MCP server on stdio transport
- [mcp] S - MCP tool get-citation: fetch citation metadata by DOI
- [mcp] S - MCP tool list-citations: return all stored citations
- [mcp] S - MCP tool import-bibtex: import citations from BibTeX string
- [mcp] S - MCP tool search-arxiv: search arXiv by paper title
- [mcp] S - MCP tool download-pdf: trigger PDF download by DOI
- [tui] M - (5) ImportProgress Ink/React component: real-time per-citation import progress
- [tui] S - CitationsTable Ink/React component: static 4-column table (DOI, title, year, status)
- [verify] M - PDF-to-Markdown extraction via @opendocsg/pdf2md
- [auth] S - Auth config file management (~/.citation-needed/auth.json, never stores passwords)
- [util] S - Logger utility with debug/info/warn/error/silent levels
- [util] S - RateLimiter utility with configurable interval for request throttling
- [util] XS - (5) getCitationFileStem / getCitationDisplayName file-naming helpers
- [cfg] S - Environment variable configuration for DB path, PDF dir, email
