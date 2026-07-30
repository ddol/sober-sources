/**
 * Phase 0 cost model: per-claim input tokens for each consumption mode as the
 * corpus grows, plus the structural ceilings that take a mode off the table
 * entirely. Token counts are the robust output here; USD is illustrative at the
 * assumed list prices below and should be re-checked against current pricing
 * before any spend decision leans on the dollar figures.
 *
 * The claim-verification workload is the thing the model encodes: many small
 * queries against a corpus where the containing paper is usually unknown. That
 * "unknown paper" is why the no-oracle column exists and why it is the honest
 * default for a real agent; the oracle column is the optimistic bound.
 */

export type Mode = 'pdf-direct' | 'markdown-context' | 'mcp-agent';

export interface ModelPrice {
  /** USD per million input tokens, fresh (uncached). */
  inputPerMTok: number;
  /** Multiplier on a cache read vs a fresh input token. */
  cacheReadMult: number;
  /** Multiplier on a cache write vs a fresh input token. */
  cacheWriteMult: number;
}

/**
 * ASSUMPTION, not fact: representative list prices for a cheap and a mid-tier
 * model. These are placeholders for the shape of the analysis; verify against
 * the live pricing page before quoting a dollar cost. Cache multipliers follow
 * Anthropic's published 0.1x read / 1.25x write structure.
 */
export const ASSUMED_PRICES: Record<'cheap' | 'mid', ModelPrice> = {
  cheap: { inputPerMTok: 1.0, cacheReadMult: 0.1, cacheWriteMult: 1.25 },
  mid: { inputPerMTok: 3.0, cacheReadMult: 0.1, cacheWriteMult: 1.25 },
};

export interface CorpusStats {
  /** Mean PDF-direct tokens per paper (text + page images). */
  avgPdfTokens: number;
  /** Mean markdown tokens per paper. */
  avgMdTokens: number;
  /** Mean pages per paper, for the PDF page-cap ceiling. */
  avgPages: number;
}

export interface ModelLimits {
  /** Usable context window in tokens (leave headroom for the answer). */
  usableContextTokens: number;
  /** Anthropic's hard per-request PDF page cap. */
  pdfPageCap: number;
}

export const DEFAULT_LIMITS: ModelLimits = {
  usableContextTokens: 180_000,
  pdfPageCap: 100,
};

/** Mode-3 retrieval cost, modelled as flat in corpus size. */
export interface McpCostModel {
  chunksPerClaim: number;
  chunkTokens: number;
  /** Tool schemas + system prompt, paid once per model call. */
  toolOverheadTokens: number;
  /** search -> read -> verify is roughly three round trips. */
  toolRoundTrips: number;
}

export const DEFAULT_MCP: McpCostModel = {
  chunksPerClaim: 4,
  chunkTokens: 450,
  toolOverheadTokens: 1500,
  toolRoundTrips: 3,
};

export interface PerClaim {
  tokens: number;
  feasible: boolean;
  /** Set when a structural ceiling makes the mode infeasible at this N. */
  brokenBy?: 'context' | 'pdf-page-cap';
}

/**
 * Per-claim input tokens for a mode at corpus size N.
 *
 * - oracle: the caller already knows which paper holds the claim, so modes 1-2
 *   load one paper instead of the whole corpus. Real agents rarely have this.
 * - caching: the corpus is static and queried across many claims, so the
 *   corpus portion is served from cache at cacheReadMult price. Modelled in
 *   usdPerClaim, not here (this function returns raw tokens).
 */
export function perClaimTokens(
  mode: Mode,
  n: number,
  corpus: CorpusStats,
  opts: { oracle: boolean },
  mcp: McpCostModel = DEFAULT_MCP,
  limits: ModelLimits = DEFAULT_LIMITS
): PerClaim {
  if (mode === 'mcp-agent') {
    const perCall = mcp.toolOverheadTokens + mcp.chunksPerClaim * mcp.chunkTokens;
    return { tokens: perCall * mcp.toolRoundTrips, feasible: true };
  }

  const papersLoaded = opts.oracle ? 1 : n;
  const perPaper = mode === 'pdf-direct' ? corpus.avgPdfTokens : corpus.avgMdTokens;
  const tokens = papersLoaded * perPaper;

  if (tokens > limits.usableContextTokens) {
    return { tokens, feasible: false, brokenBy: 'context' };
  }
  if (mode === 'pdf-direct' && papersLoaded * corpus.avgPages > limits.pdfPageCap) {
    return { tokens, feasible: false, brokenBy: 'pdf-page-cap' };
  }
  return { tokens, feasible: true };
}

/**
 * USD per claim, optionally amortising a static corpus over the cache. When
 * caching is on and there is no oracle, the corpus portion (everything but the
 * per-claim question) is a cache read; the one-time write is negligible across
 * many claims and is omitted, which is the steady-state cost an agent actually
 * pays on the tenth claim onward.
 */
export function usdPerClaim(
  mode: Mode,
  perClaim: PerClaim,
  price: ModelPrice,
  opts: { caching: boolean; questionTokens?: number }
): number {
  const question = opts.questionTokens ?? 200;
  const million = 1_000_000;
  if (!opts.caching || mode === 'mcp-agent') {
    return (perClaim.tokens / million) * price.inputPerMTok;
  }
  // Corpus is cached; only the fresh question is billed at full rate.
  const cachedPortion = Math.max(perClaim.tokens - question, 0);
  const cachedCost = (cachedPortion / million) * price.inputPerMTok * price.cacheReadMult;
  const freshCost = (question / million) * price.inputPerMTok;
  return cachedCost + freshCost;
}

export const CORPUS_SIZES = [1, 3, 8, 50, 200] as const;
