/**
 * Mechanical grading for the pilot. Verdict is the primary grade; the evidence
 * check is secondary and never flips a verdict grade, because gold spans are
 * PDF-sourced while normalizeForMatch was built for markdown, so an evidence
 * miss can be a surface artifact (ligatures, hyphenation) rather than a wrong
 * answer. This mirrors the decision recorded in
 * docs/plans/claim-grounding-eval.md.
 */
import { normalizeForMatch } from '../../src/services/verify-quote';

export type Verdict = 'supported' | 'refuted' | 'not-found';

export interface ModelAnswer {
  verdict: Verdict;
  evidence?: string;
  confidence?: number;
}

export interface GoldClaim {
  id: string;
  paper: string;
  category: string;
  claim: string;
  verdict: Verdict;
  /** Verbatim span from the PDF; absent for not-found claims. */
  evidence?: string;
  page?: number;
}

export interface Grade {
  verdictCorrect: boolean;
  /** Only meaningful when the gold claim carries an evidence span. */
  evidenceMatched: boolean | null;
  /** The failure this tool exists to prevent: asserting support for nothing. */
  falseSupported: boolean;
  /**
   * The mirror-image failure: confidently refuting a claim the served document
   * is simply silent on, rather than saying not-found. Reported alongside
   * false-supported rather than folded into gold, since gold moving to match
   * this behavior would reward the overreach instead of measuring it (see
   * "Decision: the gold does not move" in docs/plans/claim-grounding-eval.md).
   */
  overRefuted: boolean;
}

/** Token-overlap ratio of predicted evidence against the gold span, normalized. */
function overlap(predicted: string, gold: string): number {
  const p = new Set(normalizeForMatch(predicted).split(' ').filter(Boolean));
  const g = normalizeForMatch(gold).split(' ').filter(Boolean);
  if (g.length === 0 || p.size === 0) return 0;
  const hit = g.filter((w) => p.has(w)).length;
  return hit / g.length;
}

export function grade(gold: GoldClaim, answer: ModelAnswer): Grade {
  const verdictCorrect = answer.verdict === gold.verdict;
  let evidenceMatched: boolean | null = null;
  if (gold.evidence) {
    evidenceMatched = answer.evidence ? overlap(answer.evidence, gold.evidence) >= 0.6 : false;
  }
  const falseSupported = gold.verdict === 'not-found' && answer.verdict === 'supported';
  const overRefuted = gold.verdict === 'not-found' && answer.verdict === 'refuted';
  return { verdictCorrect, evidenceMatched, falseSupported, overRefuted };
}

export interface CategorySummary {
  category: string;
  n: number;
  verdictAccuracy: number;
  evidenceRate: number | null;
  falseSupported: number;
  overRefuted: number;
}

export function summarize(graded: Array<{ gold: GoldClaim; grade: Grade }>): CategorySummary[] {
  const byCat = new Map<string, Array<{ gold: GoldClaim; grade: Grade }>>();
  for (const row of graded) {
    const list = byCat.get(row.gold.category) ?? [];
    list.push(row);
    byCat.set(row.gold.category, list);
  }
  const out: CategorySummary[] = [];
  for (const [category, rows] of byCat) {
    const withEvidence = rows.filter((r) => r.grade.evidenceMatched != null);
    out.push({
      category,
      n: rows.length,
      verdictAccuracy: rows.filter((r) => r.grade.verdictCorrect).length / rows.length,
      evidenceRate:
        withEvidence.length === 0
          ? null
          : withEvidence.filter((r) => r.grade.evidenceMatched).length / withEvidence.length,
      falseSupported: rows.filter((r) => r.grade.falseSupported).length,
      overRefuted: rows.filter((r) => r.grade.overRefuted).length,
    });
  }
  return out.sort((a, b) => a.category.localeCompare(b.category));
}
