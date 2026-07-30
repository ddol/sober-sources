/**
 * Curate the mined candidates into the expansion set. The raw ranking carries
 * OpenAlex artifacts that would poison an extraction-quality eval:
 *
 * - duplicate work records for the same paper (COCO, MOTChallenge appear twice),
 * - venue/paratext records that are not papers ("Robotics: Science and Systems"),
 * - spurious cross-matches (an ivermectin pharmacokinetics paper), and
 * - pre-arXiv scanned classics (RANSAC 1981, Hungarian method) that the plan
 *   defers because the pipeline has no OCR path, so their result is known a priori.
 *
 * Filters: dedupe by normalized title; keep genuine articles; require a
 * born-digital source (an arXiv id, or a non-arXiv OA PDF from 2013 on); drop
 * non-latin/malformed titles. Prefer arXiv for clean text.
 *
 *   npx ts-node --transpile-only eval/corpus/select.ts [N=41]
 */
import fs from 'fs';
import path from 'path';

interface Candidate {
  openalexId: string;
  title: string;
  citedBy: number;
  crossCites: number;
  year: number | null;
  type: string | null;
  doi: string | null;
  pdfUrl: string | null;
  arxivId: string | null;
  citedBySeeds: string[];
}

const N = Number(process.argv[2] ?? 41);
const raw = (
  JSON.parse(fs.readFileSync(path.join(__dirname, 'candidates.json'), 'utf-8')) as Candidate[]
).map((c) => ({ ...c, title: c.title.replace(/<[^>]+>/g, '').trim() })); // strip stray HTML

// The 19 papers we already hold, so a preprint record of one (e.g. VoxelNet)
// does not re-enter the corpus as a near-duplicate under a different OpenAlex id.
const SEED_TITLES = [
  'SemanticKITTI A Dataset for Semantic Scene Understanding of LiDAR Sequences',
  'Simple Online and Realtime Tracking',
  'nuScenes A multimodal dataset for autonomous driving',
  'PolarStream Streaming Object Detection and Segmentation with Polar Pillars',
  'Panoptic nuScenes A Large-Scale Benchmark for LiDAR Panoptic Segmentation and Tracking',
  'A survey on motion prediction and risk assessment for intelligent vehicles',
  'HDMapNet An Online HD Map Construction and Evaluation Framework',
  'Learning Lane Graph Representations for Motion Forecasting',
  'Patchwork Fast and Robust Ground Segmentation',
  'HOTA A Higher Order Metric for Evaluating Multi-Object Tracking',
  'Waymo Open Dataset Panoramic Video Panoptic Segmentation',
  'How to keep HD maps for automated driving up to date',
  'PointNet Deep Learning on Point Sets for 3D Classification and Segmentation',
  'Trajectron Dynamically-Feasible Trajectory Forecasting with Heterogeneous Data',
  'What the Constant Velocity Model Can Teach Us About Pedestrian Motion Prediction',
  'PointRCNN 3D Object Proposal Generation and Detection from Point Cloud',
  'Scalability in Perception for Autonomous Driving Waymo Open Dataset',
  'Simple Online and Realtime Tracking with a Deep Association Metric',
  'VoxelNet End-to-End Learning for Point Cloud Based 3D Object Detection',
];

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) if (s.charCodeAt(i) > 127) return true;
  return false;
}

const seedKeys = new Set(SEED_TITLES.map(norm));

function isFetchableCleanly(c: Candidate): boolean {
  if (!c.title || hasNonAscii(c.title)) return false; // non-latin/malformed record
  if (seedKeys.has(norm(c.title))) return false; // already in the corpus
  if (c.type && !['article', 'preprint', 'dataset'].includes(c.type)) return false;
  // Impossible citation count for the year: an OpenAlex metadata error, e.g. a
  // 2024 OA record claiming 14k citations from a spurious merge.
  if (!c.arxivId && (c.year ?? 0) >= 2023 && c.citedBy > 5000) return false;
  if (c.arxivId) return true; // arXiv: clean born-digital text
  if (c.pdfUrl && (c.year ?? 0) >= 2013) return true; // modern OA, born-digital
  return false;
}

// Dedupe by normalized title, keeping the strongest record (prefer arXiv, then
// higher cross-cites, then citation count).
const byTitle = new Map<string, Candidate>();
for (const c of raw) {
  if (!isFetchableCleanly(c)) continue;
  const key = norm(c.title);
  const cur = byTitle.get(key);
  if (!cur) {
    byTitle.set(key, c);
    continue;
  }
  const better =
    (c.arxivId ? 1 : 0) - (cur.arxivId ? 1 : 0) ||
    c.crossCites - cur.crossCites ||
    c.citedBy - cur.citedBy;
  const winner = better > 0 ? c : cur;
  byTitle.set(key, { ...winner, crossCites: Math.max(c.crossCites, cur.crossCites) });
}

const selected = [...byTitle.values()]
  .sort((a, b) => b.crossCites - a.crossCites || b.citedBy - a.citedBy)
  .slice(0, N);

fs.writeFileSync(path.join(__dirname, 'selection.json'), `${JSON.stringify(selected, null, 2)}\n`);

process.stdout.write(
  `Selected ${selected.length} of ${byTitle.size} clean-fetchable candidates:\n\n`
);
process.stdout.write('| # | xcites | cited_by | year | src | title |\n|---|---|---|---|---|---|\n');
selected.forEach((c, i) => {
  process.stdout.write(
    `| ${i + 1} | ${c.crossCites} | ${c.citedBy} | ${c.year ?? '?'} | ${c.arxivId ? 'arXiv' : 'OA'} | ${c.title.slice(0, 62)} |\n`
  );
});
