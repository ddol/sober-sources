/**
 * Local, deterministic token estimation for the Phase 0 economics analysis.
 *
 * No API key and no network. Phase 0 is the "free, run first" phase, and the
 * decision it feeds (which consumption modes survive at corpus scale) turns on
 * ratios and asymptotics, not on exact token counts. A `count_tokens`
 * refinement pass (opt-in, needs a key; see verifyWithCountTokens) only
 * tightens the constants below. It never changes the shape of the curves, so
 * the whole of Phase 0 is answerable offline.
 */

/** English technical prose runs ~0.75 words per token, so ~1.33 tokens/word. */
export const TOKENS_PER_WORD = 1.33;

/** Cross-check only: ~4 characters per token for the same register. */
export const TOKENS_PER_CHAR = 0.25;

/**
 * Anthropic serves a PDF as extracted text PLUS one rasterised image per page.
 * A rendered Letter/A4 page costs on the order of 1,300-2,000 vision tokens
 * (tokens ~= width*height/750, with the long side capped near 1568px). We model
 * the midpoint and carry the range, so the PDF/markdown ratio is reported as a
 * band rather than a false-precision point.
 */
export const PAGE_IMAGE_TOKENS = 1600;
export const PAGE_IMAGE_TOKENS_RANGE: readonly [number, number] = [1300, 2000];

export function countWords(text: string): number {
  return (text.match(/\S+/g) ?? []).length;
}

export function estimateMarkdownTokens(markdown: string): number {
  return Math.round(countWords(markdown) * TOKENS_PER_WORD);
}

/**
 * PDF-direct token cost: the extracted text (approximated by the markdown token
 * count, since it is the same underlying prose minus markup) plus the per-page
 * image overhead that a markdown context never pays. The text-proxy assumption
 * is the one place Phase 0 leans on markdown to reason about the PDF; it biases
 * the PDF estimate slightly low (PDF text carries running heads and reference
 * formatting markdown drops), which is the conservative direction for the
 * "is PDF too expensive" question.
 */
export function estimatePdfDirectTokens(
  markdownTokens: number,
  pages: number,
  imageTokensPerPage: number = PAGE_IMAGE_TOKENS
): number {
  return markdownTokens + pages * imageTokensPerPage;
}

export interface PdfEstimateBand {
  low: number;
  mid: number;
  high: number;
}

export function estimatePdfDirectBand(markdownTokens: number, pages: number): PdfEstimateBand {
  const [lo, hi] = PAGE_IMAGE_TOKENS_RANGE;
  return {
    low: estimatePdfDirectTokens(markdownTokens, pages, lo),
    mid: estimatePdfDirectTokens(markdownTokens, pages, PAGE_IMAGE_TOKENS),
    high: estimatePdfDirectTokens(markdownTokens, pages, hi),
  };
}

/**
 * Optional precision pass. Calls Anthropic's count-tokens endpoint over plain
 * fetch (no SDK dependency) when ANTHROPIC_API_KEY is set, so a future run can
 * replace the estimated markdown token count with the exact one. Returns null
 * when no key is present, which is the normal Phase 0 case. count-tokens is
 * billed at zero, so this stays inside the "free" phase.
 */
export async function verifyWithCountTokens(
  text: string,
  model: string,
  apiKey: string | undefined = process.env.ANTHROPIC_API_KEY
): Promise<number | null> {
  if (!apiKey) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error(`count_tokens failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { input_tokens: number };
  return body.input_tokens;
}
