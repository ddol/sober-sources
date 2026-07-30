/**
 * Corpus expansion by reference mining. Takes the 19 perception papers we
 * already hold, pulls each one's reference list from OpenAlex (free, no key),
 * and ranks the referenced works by how many of our papers cite them
 * (cross-citation = foundational to this corpus) and by their global citation
 * count (seminality). The top of that ranking is the expansion set.
 *
 *   npx ts-node --transpile-only eval/corpus/mine-references.ts
 *
 * Writes eval/corpus/candidates.json (full ranked list) and prints the top.
 * Selection into manifest.json is a separate, reviewable step.
 */
import fs from 'fs';
import path from 'path';

const MAILTO = 'tyrion.skynet@gmail.com'; // OpenAlex polite pool
const API = 'https://api.openalex.org';

// The papers we already have (velocity.report). DOI where known (exact resolve),
// otherwise a canonical title for OpenAlex title search.
interface Seed {
  id: string;
  doi?: string;
  title: string;
}
const SEEDS: Seed[] = [
  {
    id: 'Behley2019',
    title: 'SemanticKITTI: A Dataset for Semantic Scene Understanding of LiDAR Sequences',
  },
  {
    id: 'Bewley2016',
    doi: '10.1109/ICIP.2016.7533003',
    title: 'Simple Online and Realtime Tracking',
  },
  {
    id: 'Caesar2020',
    doi: '10.1109/CVPR42600.2020.01164',
    title: 'nuScenes: A multimodal dataset for autonomous driving',
  },
  {
    id: 'Chiu2021PolarStream',
    title: 'PolarStream: Streaming Object Detection and Segmentation with Polar Pillars',
  },
  {
    id: 'Fong2021PanopticNuScenes',
    title:
      'Panoptic nuScenes: A Large-Scale Benchmark for LiDAR Panoptic Segmentation and Tracking',
  },
  {
    id: 'Lefevre2014',
    title: 'A survey on motion prediction and risk assessment for intelligent vehicles',
  },
  { id: 'Li2022HDMap', title: 'HDMapNet: An Online HD Map Construction and Evaluation Framework' },
  {
    id: 'Liang2020',
    doi: '10.1007/978-3-030-58536-5_32',
    title: 'Learning Lane Graph Representations for Motion Forecasting',
  },
  {
    id: 'Lim2022Patchwork',
    title:
      'Patchwork++: Fast and Robust Ground Segmentation Solving Partial Under-Segmentation Using 3D Point Cloud',
  },
  {
    id: 'Luiten2021HOTA',
    title: 'HOTA: A Higher Order Metric for Evaluating Multi-Object Tracking',
  },
  { id: 'Mei2022Waymo', title: 'Waymo Open Dataset: Panoramic Video Panoptic Segmentation' },
  { id: 'Pannen2020', title: 'How to keep HD maps for automated driving up to date' },
  {
    id: 'Qi2017PointNet',
    title: 'PointNet: Deep Learning on Point Sets for 3D Classification and Segmentation',
  },
  {
    id: 'Salzmann2020',
    title: 'Trajectron++: Dynamically-Feasible Trajectory Forecasting with Heterogeneous Data',
  },
  {
    id: 'Scholler2020',
    title: 'What the Constant Velocity Model Can Teach Us About Pedestrian Motion Prediction',
  },
  {
    id: 'Shi2019PointRCNN',
    title: 'PointRCNN: 3D Object Proposal Generation and Detection from Point Cloud',
  },
  {
    id: 'Sun2020Waymo',
    title: 'Scalability in Perception for Autonomous Driving: Waymo Open Dataset',
  },
  {
    id: 'Wojke2017DeepSORT',
    title: 'Simple Online and Realtime Tracking with a Deep Association Metric',
  },
  {
    id: 'Zhou2018VoxelNet',
    title: 'VoxelNet: End-to-End Learning for Point Cloud Based 3D Object Detection',
  },
];

interface OAWork {
  id: string;
  title: string | null;
  cited_by_count: number;
  publication_year: number | null;
  type: string | null;
  doi: string | null;
  referenced_works?: string[];
  best_oa_location?: { pdf_url: string | null; landing_page_url: string | null } | null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

async function oa<T>(url: string): Promise<T> {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}mailto=${MAILTO}`);
  if (res.status === 429) {
    await sleep(2000);
    return oa<T>(url);
  }
  if (!res.ok) throw new Error(`OpenAlex ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token-overlap sanity check so a bad title search does not resolve garbage. */
function titleMatches(a: string, b: string): boolean {
  const at = new Set(
    norm(a)
      .split(' ')
      .filter((w) => w.length > 3)
  );
  const bt = norm(b)
    .split(' ')
    .filter((w) => w.length > 3);
  if (bt.length === 0) return false;
  const hit = bt.filter((w) => at.has(w)).length;
  return hit / bt.length >= 0.5;
}

async function resolveSeed(seed: Seed): Promise<OAWork | null> {
  const select = 'id,title,cited_by_count,publication_year,type,doi,referenced_works';
  if (seed.doi) {
    try {
      return await oa<OAWork>(`${API}/works/https://doi.org/${seed.doi}?select=${select}`);
    } catch {
      /* fall through to title search */
    }
  }
  const q = encodeURIComponent(seed.title);
  const page = await oa<{ results: OAWork[] }>(
    `${API}/works?filter=title.search:${q}&select=${select}&per_page=5`
  );
  const hit = page.results.find((w) => w.title && titleMatches(w.title, seed.title));
  return hit ?? page.results[0] ?? null;
}

async function fetchWorks(ids: string[]): Promise<Map<string, OAWork>> {
  const out = new Map<string, OAWork>();
  const select = 'id,title,cited_by_count,publication_year,type,doi,best_oa_location';
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50).map((x) => x.replace('https://openalex.org/', ''));
    const page = await oa<{ results: OAWork[] }>(
      `${API}/works?filter=openalex:${batch.join('|')}&select=${select}&per_page=50`
    );
    for (const w of page.results) out.set(w.id, w);
    await sleep(150);
  }
  return out;
}

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

function arxivIdFrom(w: OAWork): string | null {
  const url = w.best_oa_location?.landing_page_url ?? w.best_oa_location?.pdf_url ?? '';
  const m = url.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]{4}\.[0-9]{4,5})/i);
  if (m) return m[1];
  if (w.doi) {
    const d = w.doi.match(/10\.48550\/arxiv\.([0-9]{4}\.[0-9]{4,5})/i);
    if (d) return d[1];
  }
  return null;
}

async function main(): Promise<void> {
  const seedRefs = new Map<string, string[]>();
  const resolvedSeedIds = new Set<string>();
  for (const seed of SEEDS) {
    const w = await resolveSeed(seed);
    if (!w) {
      process.stderr.write(`  ! could not resolve seed ${seed.id}\n`);
      continue;
    }
    resolvedSeedIds.add(w.id);
    seedRefs.set(seed.id, w.referenced_works ?? []);
    process.stderr.write(
      `  resolved ${seed.id} -> ${(w.title ?? '').slice(0, 45)} (${(w.referenced_works ?? []).length} refs)\n`
    );
    await sleep(150);
  }

  // Cross-citation count: how many distinct seeds reference each work.
  const crossCites = new Map<string, string[]>();
  for (const [seedId, refs] of seedRefs) {
    for (const ref of refs) {
      const list = crossCites.get(ref) ?? [];
      list.push(seedId);
      crossCites.set(ref, list);
    }
  }
  const allRefIds = [...crossCites.keys()];
  process.stderr.write(`\n${allRefIds.length} distinct referenced works; fetching metadata...\n`);
  const works = await fetchWorks(allRefIds);

  const candidates: Candidate[] = [];
  for (const [refId, seeds] of crossCites) {
    const w = works.get(refId);
    if (!w || !w.title) continue;
    if (resolvedSeedIds.has(refId)) continue; // already in our corpus
    candidates.push({
      openalexId: refId,
      title: w.title,
      citedBy: w.cited_by_count,
      crossCites: new Set(seeds).size,
      year: w.publication_year,
      type: w.type,
      doi: w.doi,
      pdfUrl: w.best_oa_location?.pdf_url ?? null,
      arxivId: arxivIdFrom(w),
      citedBySeeds: [...new Set(seeds)],
    });
  }

  // Rank: foundational-to-this-corpus first, then globally seminal.
  candidates.sort((a, b) => b.crossCites - a.crossCites || b.citedBy - a.citedBy);

  fs.writeFileSync(
    path.join(__dirname, 'candidates.json'),
    `${JSON.stringify(candidates, null, 2)}\n`
  );

  const fetchable = candidates.filter((c) => c.arxivId || c.pdfUrl);
  process.stdout.write(
    `\n${candidates.length} candidates, ${fetchable.length} with a fetchable PDF. Top 45 fetchable:\n\n`
  );
  process.stdout.write(
    '| # | xcites | cited_by | year | arXiv? | title |\n|---|---|---|---|---|---|\n'
  );
  fetchable.slice(0, 45).forEach((c, i) => {
    process.stdout.write(
      `| ${i + 1} | ${c.crossCites} | ${c.citedBy} | ${c.year ?? '?'} | ${c.arxivId ? 'y' : 'oa'} | ${c.title.slice(0, 60)} |\n`
    );
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
