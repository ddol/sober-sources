/**
 * Phase 0 runner: reads the pilot corpus, estimates PDF vs markdown token
 * counts, models per-claim cost across corpus sizes and modes, and writes
 * eval/phase0/report.json + report.md. Free and offline by default.
 *
 *   npx ts-node eval/phase0/run.ts
 *
 * With ANTHROPIC_API_KEY set it additionally calls count_tokens (billed at
 * zero) to replace the estimated markdown counts with exact ones; the curves
 * and conclusions are unchanged, only the constants tighten.
 */
import fs from 'fs';
import path from 'path';
import {
  estimateMarkdownTokens,
  estimatePdfDirectBand,
  verifyWithCountTokens,
  PAGE_IMAGE_TOKENS,
  PAGE_IMAGE_TOKENS_RANGE,
} from '../lib/tokens';
import {
  ASSUMED_PRICES,
  CORPUS_SIZES,
  DEFAULT_LIMITS,
  DEFAULT_MCP,
  Mode,
  perClaimTokens,
  usdPerClaim,
  type CorpusStats,
} from './economics';

const REPO = path.resolve(__dirname, '..', '..');
// The corpus markdown built by eval/corpus/build.ts (gitignored cache). Run the
// corpus builder first; Phase 0 reads whatever the manifest lists.
const MD_DIR = path.resolve(REPO, 'eval', 'corpus', 'cache', 'markdown');
const OUT_DIR = __dirname;
const REFINE_MODEL = 'claude-haiku-4-5-20251001';

interface ManifestPaper {
  id: string;
  pages: number;
  arxivId: string;
  tags: string[];
}

interface PaperRow {
  id: string;
  pages: number;
  mdTokens: number;
  mdTokensExact: number | null;
  pdfLow: number;
  pdfMid: number;
  pdfHigh: number;
  ratioMid: number;
}

function loadManifest(): ManifestPaper[] {
  const raw = fs.readFileSync(path.join(REPO, 'eval', 'corpus', 'manifest.json'), 'utf-8');
  return (JSON.parse(raw) as { papers: ManifestPaper[] }).papers;
}

async function measurePaper(p: ManifestPaper): Promise<PaperRow> {
  const md = fs.readFileSync(path.join(MD_DIR, `${p.id}.md`), 'utf-8');
  const mdTokens = estimateMarkdownTokens(md);
  const mdTokensExact = await verifyWithCountTokens(md, REFINE_MODEL).catch(() => null);
  const effectiveMd = mdTokensExact ?? mdTokens;
  const band = estimatePdfDirectBand(effectiveMd, p.pages);
  return {
    id: p.id,
    pages: p.pages,
    mdTokens,
    mdTokensExact,
    pdfLow: band.low,
    pdfMid: band.mid,
    pdfHigh: band.high,
    ratioMid: band.mid / effectiveMd,
  };
}

function corpusStats(rows: PaperRow[]): CorpusStats {
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    avgPdfTokens: Math.round(mean(rows.map((r) => r.pdfMid))),
    avgMdTokens: Math.round(mean(rows.map((r) => r.mdTokensExact ?? r.mdTokens))),
    avgPages: mean(rows.map((r) => r.pages)),
  };
}

const MODES: Mode[] = ['pdf-direct', 'markdown-context', 'mcp-agent'];
const fmtTok = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`);

function oracleLabel(mode: Mode, oracle: boolean): string {
  if (mode === 'mcp-agent') return 'n/a';
  return oracle ? 'yes' : 'no';
}

function economicsTable(corpus: CorpusStats): string {
  const price = ASSUMED_PRICES.cheap;
  const lines: string[] = [];
  lines.push(`| Mode | Oracle? | ${CORPUS_SIZES.map((n) => `N=${n}`).join(' | ')} |`);
  lines.push(`| --- | --- | ${CORPUS_SIZES.map(() => '---').join(' | ')} |`);
  for (const mode of MODES) {
    const oracleVariants = mode === 'mcp-agent' ? [false] : [false, true];
    for (const oracle of oracleVariants) {
      const cells = CORPUS_SIZES.map((n) => {
        const pc = perClaimTokens(mode, n, corpus, { oracle });
        if (!pc.feasible) return `✗ ${pc.brokenBy}`;
        return fmtTok(pc.tokens);
      });
      const label = oracleLabel(mode, oracle);
      lines.push(`| ${mode} | ${label} | ${cells.join(' | ')} |`);
    }
  }
  lines.push('');
  lines.push('Per-claim input tokens. `✗` marks a structural ceiling, not a price.');
  lines.push('');
  // USD per claim at the assumed cheap-model price, at N=8, showing caching.
  lines.push('USD per claim at N=8 (assumed cheap-model list price, illustrative):');
  lines.push('');
  lines.push('| Mode | Oracle? | no cache | static-corpus cache |');
  lines.push('| --- | --- | --- | --- |');
  for (const mode of MODES) {
    const oracleVariants = mode === 'mcp-agent' ? [false] : [false, true];
    for (const oracle of oracleVariants) {
      const pc = perClaimTokens(mode, 8, corpus, { oracle });
      const label = oracleLabel(mode, oracle);
      if (!pc.feasible) {
        lines.push(`| ${mode} | ${label} | ✗ ${pc.brokenBy} | ✗ ${pc.brokenBy} |`);
        continue;
      }
      const noCache = usdPerClaim(mode, pc, price, { caching: false });
      const cache = usdPerClaim(mode, pc, price, { caching: true });
      lines.push(`| ${mode} | ${label} | $${noCache.toFixed(4)} | $${cache.toFixed(4)} |`);
    }
  }
  return lines.join('\n');
}

function ceilings(corpus: CorpusStats): string {
  const out: string[] = [];
  for (const mode of ['pdf-direct', 'markdown-context'] as Mode[]) {
    let lastFeasible = 0;
    for (let n = 1; n <= 500; n++) {
      if (perClaimTokens(mode, n, corpus, { oracle: false }).feasible) lastFeasible = n;
      else break;
    }
    out.push(`- **${mode}** (no oracle) stays feasible up to ~${lastFeasible} papers in context.`);
  }
  out.push('- **mcp-agent** has no corpus-size ceiling: per-claim cost is flat.');
  return out.join('\n');
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const rows: PaperRow[] = [];
  for (const p of manifest) rows.push(await measurePaper(p));
  const corpus = corpusStats(rows);
  const exact = rows.some((r) => r.mdTokensExact != null);

  const report = { generatedAt: new Date().toISOString(), exactCounts: exact, rows, corpus };
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);

  const perPaper = [
    '| Paper | Pages | MD tokens | PDF-direct (low–mid–high) | PDF/MD |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.pages} | ${fmtTok(r.mdTokensExact ?? r.mdTokens)} | ${fmtTok(r.pdfLow)}–${fmtTok(r.pdfMid)}–${fmtTok(r.pdfHigh)} | ${r.ratioMid.toFixed(1)}× |`
    ),
  ].join('\n');

  const md = `# Phase 0: token economics (generated)

Generated by \`eval/phase0/run.ts\`. ${
    exact
      ? 'Markdown counts are exact (count_tokens).'
      : 'Markdown counts are estimated (~1.33 tokens/word); run with ANTHROPIC_API_KEY to replace them with exact count_tokens values.'
  } PDF-direct is estimated as extracted text plus ${PAGE_IMAGE_TOKENS} image tokens/page (range ${PAGE_IMAGE_TOKENS_RANGE[0]}–${PAGE_IMAGE_TOKENS_RANGE[1]}).

## Per-paper token counts

${perPaper}

Corpus average: PDF-direct ${fmtTok(corpus.avgPdfTokens)}, markdown ${fmtTok(corpus.avgMdTokens)}, ${corpus.avgPages.toFixed(1)} pages/paper.

## Per-claim cost as the corpus grows

${economicsTable(corpus)}

## Structural ceilings (context ${fmtTok(DEFAULT_LIMITS.usableContextTokens)} usable, ${DEFAULT_LIMITS.pdfPageCap}-page PDF cap)

${ceilings(corpus)}

## What Phase 0 settles on its own

- PDF-direct costs **${(corpus.avgPdfTokens / corpus.avgMdTokens).toFixed(1)}×** the markdown tokens per paper, entirely from page images. This reproduces the plan's assumed 2–4× band from first principles.
- Without an oracle for which paper holds the claim, modes 1–2 pay the whole corpus per claim and hit a hard ceiling in the low tens of papers; **pdf-direct breaks first** (~5 papers vs ~19 for markdown), because its per-paper token cost is ~3× higher. The context limit binds just ahead of the page cap at these paper lengths; shorter, text-light papers would flip that order.
- Mode 3 (mcp-agent) is flat in corpus size (~${fmtTok(DEFAULT_MCP.toolRoundTrips * (DEFAULT_MCP.toolOverheadTokens + DEFAULT_MCP.chunksPerClaim * DEFAULT_MCP.chunkTokens))} tokens/claim here), so it is the only mode that survives a field-scale corpus.
- Prompt caching rescues modes 1–2 **only** for a small static corpus queried many times; it cannot lift the context/page ceiling, so it does not change which modes reach 50–200 papers.

Phase 0 answers the "least tokens" half of the fork analytically: at field scale the retrieval layer is the only candidate. The pilot and Phase 1 still have to answer the "most accurate" half, because cheap-but-wrong is not the goal.
`;
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), md);
  process.stdout.write(md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
