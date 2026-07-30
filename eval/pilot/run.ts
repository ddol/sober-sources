/**
 * Pilot runner: one claim suite, two consumption modes (pdf-direct,
 * markdown-context), one model, mechanical grading. A single script by design
 * (docs/plans/claim-grounding-eval.md, phase "Pilot"); the Phase 1 harness
 * generalises it later.
 *
 *   npx ts-node eval/pilot/run.ts --dry        # offline, canned answers
 *   ANTHROPIC_API_KEY=... npx ts-node eval/pilot/run.ts --model claude-haiku-4-5-20251001
 *
 * --dry exercises the whole read -> answer -> grade -> summarise path with
 * canned perfect answers, so the grader and the claim formats are verifiable
 * with zero spend. The real path needs @anthropic-ai/sdk installed and a key,
 * and is bounded by --max-usd (default $2).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { grade, summarize, type GoldClaim, type ModelAnswer, type Verdict } from './grade';

const REPO = path.resolve(__dirname, '..', '..');
// The 3 pilot papers live in the sibling velocity.report set; the full suite
// serves mined papers that only exist in the built corpus cache. Both are
// selectable so the pilot stays comparable while the suite can reach every
// corpus paper.
const DEFAULT_PDF_DIR = path.resolve(REPO, '..', 'velocity.report', 'docs', 'papers', 'pdf');
const DEFAULT_MD_DIR = path.resolve(REPO, '..', 'velocity.report', 'docs', 'papers', 'markdown');
const CACHE_DIR = path.join(__dirname, '.cache');

type Mode = 'pdf-direct' | 'markdown-context';
const MODES: Mode[] = ['pdf-direct', 'markdown-context'];

interface Args {
  dry: boolean;
  model: string;
  maxUsd: number;
  claims: string;
  pdfDir: string;
  mdDir: string;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string, def: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
  };
  return {
    dry: argv.includes('--dry'),
    model: get('--model', 'claude-haiku-4-5-20251001'),
    maxUsd: Number(get('--max-usd', '2')),
    claims: get('--claims', path.join(__dirname, 'claims.jsonl')),
    pdfDir: get('--pdf-dir', DEFAULT_PDF_DIR),
    mdDir: get('--md-dir', DEFAULT_MD_DIR),
  };
}

function loadClaims(file: string): GoldClaim[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('//'))
    .map((l) => JSON.parse(l) as GoldClaim);
}

const SYSTEM = [
  'You verify a claim against a single scientific paper provided in this message.',
  'Reply with ONLY a JSON object, no prose, matching:',
  '{"verdict": "supported" | "refuted" | "not-found", "evidence": "<verbatim span from the paper, or empty>", "confidence": <0..1>}',
  'Definitions:',
  '- "supported": the paper states the claim.',
  '- "refuted": the paper states something that makes the claim false, including',
  '  filling a single-valued property (its architecture, dataset, benchmark, metric,',
  '  or a reported number) with a different value than the claim asserts.',
  '- "not-found": the paper is silent and the claim would merely add to what it',
  '  describes; nothing in the paper bears on it.',
  'Do not guess. Answer only from the provided paper.',
].join('\n');

function requestHash(mode: Mode, model: string, claim: GoldClaim): string {
  // SYSTEM is part of the key: change the prompt and the cache must miss,
  // otherwise a run silently reuses answers from the old instructions.
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ mode, model, id: claim.id, claim: claim.claim, sys: SYSTEM }))
    .digest('hex')
    .slice(0, 16);
}

/** First complete top-level {...}, brace-matched so trailing prose is ignored. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Model output parsing must never throw: a chatty model that adds prose around
// its JSON, or returns none, becomes a not-found rather than aborting the run.
function parseAnswer(text: string): ModelAnswer {
  const json = firstJsonObject(text);
  if (!json) return { verdict: 'not-found' };
  try {
    const obj = JSON.parse(json) as { verdict?: string; evidence?: string; confidence?: number };
    const verdict = (['supported', 'refuted', 'not-found'] as Verdict[]).includes(
      obj.verdict as Verdict
    )
      ? (obj.verdict as Verdict)
      : 'not-found';
    return { verdict, evidence: obj.evidence || undefined, confidence: obj.confidence };
  } catch {
    return { verdict: 'not-found' };
  }
}

// Canned "perfect oracle" answer for --dry: proves the pipeline and grader run
// end to end offline. A green summary (100% verdicts, 0 false-supported) is the
// expected smoke-test result; it says nothing about real model accuracy.
function cannedAnswer(claim: GoldClaim): ModelAnswer {
  return { verdict: claim.verdict, evidence: claim.evidence, confidence: 1 };
}

interface CallResult {
  answer: ModelAnswer;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  /** Set when the call could not be made or failed; excluded from accuracy. */
  error?: string;
}

/**
 * A base64 PDF has to fit in one request. Real papers routinely do not: the
 * corpus has a 30MB PDF (41MB base64). That is a structural limit of
 * pdf-direct, not a wrong answer, so those cells are recorded as unsupported.
 */
const MAX_PDF_B64_BYTES = 25 * 1024 * 1024;

async function callModel(
  mode: Mode,
  model: string,
  claim: GoldClaim,
  dirs: { pdfDir: string; mdDir: string }
): Promise<CallResult> {
  // Dynamic import so --dry and this file's parse do not require the SDK.
  const mod = (await import('@anthropic-ai/sdk').catch(() => {
    throw new Error(
      'Real runs need @anthropic-ai/sdk. Install it (npm i -S @anthropic-ai/sdk) or use --dry.'
    );
  })) as { default: new (o: { apiKey: string }) => unknown };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set. Use --dry for an offline check.');
  const Anthropic = mod.default;
  const client = new Anthropic({ apiKey }) as {
    messages: {
      create: (req: unknown) => Promise<{
        content: Array<{ type: string; text?: string }>;
        usage: {
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      }>;
    };
  };

  // The paper block is marked cache_control so the ~20 claims that share a paper
  // reuse it at cache-read price instead of re-sending the whole PDF/markdown
  // each call. The per-claim text after it stays uncached.
  const cache = { type: 'ephemeral' as const };
  let paperBlock: Record<string, unknown>;
  if (mode === 'markdown-context') {
    paperBlock = {
      type: 'text',
      text: fs.readFileSync(path.join(dirs.mdDir, `${claim.paper}.md`), 'utf-8'),
      cache_control: cache,
    };
  } else {
    const buf = fs.readFileSync(path.join(dirs.pdfDir, `${claim.paper}.pdf`));
    const data = buf.toString('base64');
    if (data.length > MAX_PDF_B64_BYTES) {
      throw new Error(
        `pdf-direct unsupported: ${claim.paper} is ${(buf.length / 1048576).toFixed(1)}MB, over the request size limit`
      );
    }
    paperBlock = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data },
      cache_control: cache,
    };
  }
  const user = [paperBlock, { type: 'text', text: `Claim: ${claim.claim}` }];

  const req: Record<string, unknown> = {
    model,
    max_tokens: 512,
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  };
  // Newer models (Sonnet 5, Opus 4.x) reject `temperature`; the cheap model
  // still takes it, and greedy decoding is the goal on all of them.
  if (model.includes('haiku')) req.temperature = 0;
  const res = await client.messages.create(req);
  const text = res.content.find((b) => b.type === 'text')?.text ?? '';
  return {
    answer: parseAnswer(text),
    inputTokens: res.usage.input_tokens,
    outputTokens: res.usage.output_tokens,
    cacheCreate: res.usage.cache_creation_input_tokens ?? 0,
    cacheRead: res.usage.cache_read_input_tokens ?? 0,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const claims = loadClaims(args.claims);
  if (!args.dry) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const results: Array<{ mode: Mode; gold: GoldClaim; answer: ModelAnswer; error?: string }> = [];
  let usd = 0;
  const tok = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  const PRICE_IN = 1.0 / 1_000_000; // assumed cheap-model input $/token; illustrative
  const PRICE_OUT = 5.0 / 1_000_000;

  // Process claims grouped by paper so consecutive same-paper calls hit the
  // paper's prompt cache (5-minute TTL) instead of recreating it.
  const ordered = [...claims].sort((a, b) => a.paper.localeCompare(b.paper));

  for (const mode of MODES) {
    for (const claim of ordered) {
      let call: CallResult;
      if (args.dry) {
        call = {
          answer: cannedAnswer(claim),
          inputTokens: 0,
          outputTokens: 0,
          cacheCreate: 0,
          cacheRead: 0,
        };
      } else {
        const cacheFile = path.join(CACHE_DIR, `${requestHash(mode, args.model, claim)}.json`);
        if (fs.existsSync(cacheFile)) {
          call = JSON.parse(fs.readFileSync(cacheFile, 'utf-8')) as CallResult;
        } else {
          try {
            call = await callModel(mode, args.model, claim, {
              pdfDir: args.pdfDir,
              mdDir: args.mdDir,
            });
            fs.writeFileSync(cacheFile, JSON.stringify(call));
          } catch (e) {
            // One unsupported or failing call must not abort the whole run. Not
            // cached, so a later run retries it; excluded from accuracy below.
            const error = e instanceof Error ? e.message : String(e);
            call = {
              answer: { verdict: 'not-found' },
              inputTokens: 0,
              outputTokens: 0,
              cacheCreate: 0,
              cacheRead: 0,
              error,
            };
            process.stderr.write(`  ! ${mode} ${claim.id}: ${error.slice(0, 100)}\n`);
          }
        }
        tok.input += call.inputTokens;
        tok.output += call.outputTokens;
        tok.cacheCreate += call.cacheCreate;
        tok.cacheRead += call.cacheRead;
        // Cache-aware pricing: fresh input 1x, cache write 1.25x, cache read 0.1x.
        usd +=
          (call.inputTokens + call.cacheCreate * 1.25 + call.cacheRead * 0.1) * PRICE_IN +
          call.outputTokens * PRICE_OUT;
        if (usd > args.maxUsd)
          throw new Error(`Aborting: spend $${usd.toFixed(2)} exceeded --max-usd $${args.maxUsd}.`);
      }
      results.push({ mode, gold: claim, answer: call.answer, error: call.error });
    }
  }

  const outFile = path.join(__dirname, args.dry ? 'results.dry.jsonl' : 'results.jsonl');
  fs.writeFileSync(
    outFile,
    `${results.map((r) => JSON.stringify({ ...r, grade: grade(r.gold, r.answer) })).join('\n')}\n`
  );

  const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((100 * n) / d).toFixed(0)}%`);
  process.stdout.write(
    `\nPilot ${args.dry ? '(DRY, canned answers)' : `model=${args.model}`}  claims=${claims.length}  spend=$${usd.toFixed(4)}\n`
  );
  if (!args.dry) {
    process.stdout.write(
      `tokens: input ${tok.input} + cache-read ${tok.cacheRead} (write ${tok.cacheCreate}), output ${tok.output}\n`
    );
  }
  process.stdout.write('\n');
  for (const mode of MODES) {
    const modeRows = results.filter((r) => r.mode === mode);
    // Unsupported/failed calls are not wrong answers; they leave the denominator.
    const unsupported = modeRows.filter((r) => r.error).length;
    const rows = modeRows
      .filter((r) => !r.error)
      .map((r) => ({ gold: r.gold, grade: grade(r.gold, r.answer) }));
    const correct = rows.filter((r) => r.grade.verdictCorrect).length;
    const absent = rows.filter((r) => r.gold.verdict === 'not-found');
    const falseSup = rows.filter((r) => r.grade.falseSupported).length;
    const overRef = rows.filter((r) => r.grade.overRefuted).length;
    const unsupportedNote = unsupported ? `; unsupported: ${unsupported}` : '';
    process.stdout.write(
      `## ${mode} — overall ${pct(correct, rows.length)} (${correct}/${rows.length}); ` +
        `false-supported on absent: ${falseSup}/${absent.length}; ` +
        `over-refuted on absent: ${overRef}/${absent.length}${unsupportedNote}\n`
    );
    process.stdout.write(
      '| category | n | verdict acc | evidence | false-supported | over-refuted |\n'
    );
    process.stdout.write('| --- | --- | --- | --- | --- | --- |\n');
    for (const s of summarize(rows)) {
      const ev = s.evidenceRate == null ? '—' : `${(s.evidenceRate * 100).toFixed(0)}%`;
      process.stdout.write(
        `| ${s.category} | ${s.n} | ${(s.verdictAccuracy * 100).toFixed(0)}% | ${ev} | ${s.falseSupported} | ${s.overRefuted} |\n`
      );
    }
    process.stdout.write('\n');
  }
  process.stdout.write(`Wrote ${path.relative(REPO, outFile)}\n`);
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
