/**
 * Corpus builder. Materialises the 60-paper eval corpus into a gitignored cache
 * (PDFs are never checked in; only manifest.json is), running every PDF through
 * the production markdown extractor so the eval consumes exactly what the tool
 * produces.
 *
 *   npx ts-node --transpile-only eval/corpus/build.ts            # all 60
 *   npx ts-node --transpile-only eval/corpus/build.ts --limit 3  # smoke test
 *
 * Resumable: a PDF or markdown file already in the cache is not refetched or
 * re-extracted. Writes eval/corpus/manifest.json and eval/corpus/build-log.json.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { extractPdfMarkdown } from '../../src/verification/markdown';

const DIR = __dirname;
const CACHE = path.join(DIR, 'cache');
const PDF_DIR = path.join(CACHE, 'pdf');
const MD_DIR = path.join(CACHE, 'markdown');
const SEED_SRC = path.resolve(DIR, '..', '..', '..', 'velocity.report', 'docs', 'papers');
const LIMIT = process.argv.includes('--limit')
  ? Number(process.argv[process.argv.indexOf('--limit') + 1])
  : Infinity;

interface Selected {
  title: string;
  citedBy: number;
  crossCites: number;
  year: number | null;
  doi: string | null;
  pdfUrl: string | null;
  arxivId: string | null;
  citedBySeeds: string[];
}

interface Entry {
  id: string;
  origin: 'seed' | 'mined';
  title: string;
  arxivId?: string;
  doi?: string;
  pages: number;
  sha256: string;
  tags: string[];
  source: string; // where the PDF came from (provenance)
  crossCites?: number;
  citedBy?: number;
}

// The 19 papers we already hold. The three pilot papers keep their rich tags;
// the rest get a coarse origin tag (pilot claim-authoring only touches the three).
const SEED: Array<{ id: string; arxivId?: string; doi?: string; title: string; tags: string[] }> = [
  {
    id: 'Behley2019',
    title: 'SemanticKITTI: A Dataset for Semantic Scene Understanding of LiDAR Sequences',
    tags: ['seed', 'dataset', 'segmentation'],
  },
  {
    id: 'Bewley2016',
    arxivId: '1602.00763',
    doi: '10.1109/ICIP.2016.7533003',
    title: 'Simple Online and Realtime Tracking (SORT)',
    tags: ['seed', 'pilot', 'clean-prose', 'mode-invariance-control'],
  },
  {
    id: 'Caesar2020',
    arxivId: '1903.11027',
    doi: '10.1109/CVPR42600.2020.01164',
    title: 'nuScenes: A Multimodal Dataset for Autonomous Driving',
    tags: ['seed', 'pilot', 'table-dense', 'numeric'],
  },
  {
    id: 'Chiu2021PolarStream',
    title: 'PolarStream: Streaming Object Detection and Segmentation with Polar Pillars',
    tags: ['seed', 'detection'],
  },
  {
    id: 'Fong2021PanopticNuScenes',
    title: 'Panoptic nuScenes',
    tags: ['seed', 'segmentation', 'tracking'],
  },
  {
    id: 'Lefevre2014',
    title: 'A survey on motion prediction and risk assessment for intelligent vehicles',
    tags: ['seed', 'survey', 'prediction'],
  },
  {
    id: 'Li2022HDMap',
    title: 'HDMapNet: An Online HD Map Construction and Evaluation Framework',
    tags: ['seed', 'hd-map'],
  },
  {
    id: 'Liang2020',
    arxivId: '2007.13732',
    doi: '10.1007/978-3-030-58536-5_32',
    title: 'Learning Lane Graph Representations for Motion Forecasting (LaneGCN)',
    tags: [
      'seed',
      'pilot',
      'worst-case',
      'equation-dense',
      'table-grouped-headers',
      'figure-dependent',
    ],
  },
  {
    id: 'Lim2022Patchwork',
    title: 'Patchwork++: Fast and Robust Ground Segmentation',
    tags: ['seed', 'segmentation'],
  },
  {
    id: 'Luiten2021HOTA',
    title: 'HOTA: A Higher Order Metric for Evaluating Multi-Object Tracking',
    tags: ['seed', 'tracking', 'metric'],
  },
  {
    id: 'Mei2022Waymo',
    title: 'Waymo Open Dataset: Panoramic Video Panoptic Segmentation',
    tags: ['seed', 'dataset', 'segmentation'],
  },
  {
    id: 'Pannen2020',
    title: 'How to Keep HD Maps for Automated Driving Up To Date',
    tags: ['seed', 'hd-map'],
  },
  {
    id: 'Qi2017PointNet',
    title: 'PointNet: Deep Learning on Point Sets for 3D Classification and Segmentation',
    tags: ['seed', 'point-cloud'],
  },
  {
    id: 'Salzmann2020',
    title: 'Trajectron++: Dynamically-Feasible Trajectory Forecasting with Heterogeneous Data',
    tags: ['seed', 'prediction'],
  },
  {
    id: 'Scholler2020',
    title: 'What the Constant Velocity Model Can Teach Us About Pedestrian Motion Prediction',
    tags: ['seed', 'prediction'],
  },
  {
    id: 'Shi2019PointRCNN',
    title: 'PointRCNN: 3D Object Proposal Generation and Detection from Point Cloud',
    tags: ['seed', 'detection', 'point-cloud'],
  },
  {
    id: 'Sun2020Waymo',
    title: 'Scalability in Perception for Autonomous Driving: Waymo Open Dataset',
    tags: ['seed', 'dataset'],
  },
  {
    id: 'Wojke2017DeepSORT',
    title: 'Simple Online and Realtime Tracking with a Deep Association Metric (DeepSORT)',
    tags: ['seed', 'tracking'],
  },
  {
    id: 'Zhou2018VoxelNet',
    title: 'VoxelNet: End-to-End Learning for Point Cloud Based 3D Object Detection',
    tags: ['seed', 'detection', 'point-cloud'],
  },
];

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms);
  });
const sha256 = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');
const pageCount = (pdf: string): number =>
  Number(
    execFileSync('pdfinfo', [pdf], { encoding: 'utf-8' }).match(/^Pages:\s+(\d+)/m)?.[1] ?? '0'
  );

const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'to', 'with', 'on', 'in', 'from']);
function slug(title: string, year: number | null, taken: Set<string>): string {
  const words = title
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
  const base = words.slice(0, 2).join('') + (year ?? '');
  let id = base;
  let n = 2;
  while (taken.has(id)) id = `${base}_${n++}`;
  taken.add(id);
  return id;
}

async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'citation-needed-eval/0.1' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024 || buf.subarray(0, 4).toString() !== '%PDF') {
    throw new Error(`not a PDF (${buf.length} bytes)`);
  }
  fs.writeFileSync(dest, buf);
}

interface Task {
  id: string;
  origin: 'seed' | 'mined';
  title: string;
  arxivId?: string;
  doi?: string;
  tags: string[];
  fetch: { kind: 'copy'; from: string } | { kind: 'url'; url: string; source: string };
  crossCites?: number;
  citedBy?: number;
}

function buildTasks(): Task[] {
  const tasks: Task[] = SEED.map((s) => ({
    id: s.id,
    origin: 'seed',
    title: s.title,
    arxivId: s.arxivId,
    doi: s.doi,
    tags: s.tags,
    fetch: { kind: 'copy', from: path.join(SEED_SRC, 'pdf', `${s.id}.pdf`) },
  }));
  const selection = JSON.parse(
    fs.readFileSync(path.join(DIR, 'selection.json'), 'utf-8')
  ) as Selected[];
  const taken = new Set(tasks.map((t) => t.id));
  for (const c of selection) {
    const url = c.arxivId ? `https://arxiv.org/pdf/${c.arxivId}` : c.pdfUrl;
    if (!url) continue;
    tasks.push({
      id: slug(c.title, c.year, taken),
      origin: 'mined',
      title: c.title,
      arxivId: c.arxivId ?? undefined,
      doi: c.doi ?? undefined,
      tags: ['mined', 'reference'],
      fetch: { kind: 'url', url, source: c.arxivId ? `arXiv:${c.arxivId}` : (c.pdfUrl ?? url) },
      crossCites: c.crossCites,
      citedBy: c.citedBy,
    });
  }
  return tasks;
}

async function main(): Promise<void> {
  fs.mkdirSync(PDF_DIR, { recursive: true });
  fs.mkdirSync(MD_DIR, { recursive: true });
  const tasks = buildTasks().slice(0, LIMIT);
  const entries: Entry[] = [];
  const failures: Array<{ id: string; stage: string; error: string }> = [];

  for (const t of tasks) {
    const pdf = path.join(PDF_DIR, `${t.id}.pdf`);
    const md = path.join(MD_DIR, `${t.id}.md`);
    const source = t.fetch.kind === 'copy' ? `velocity.report/${t.id}.pdf` : t.fetch.source;

    try {
      if (!fs.existsSync(pdf)) {
        if (t.fetch.kind === 'copy') {
          fs.copyFileSync(t.fetch.from, pdf);
        } else {
          await download(t.fetch.url, pdf);
          await sleep(1500); // polite to arXiv
        }
      }
    } catch (e) {
      failures.push({
        id: t.id,
        stage: 'fetch',
        error: String(e instanceof Error ? e.message : e),
      });
      process.stderr.write(`  FETCH FAIL ${t.id}: ${String(e)}\n`);
      continue;
    }

    try {
      if (!fs.existsSync(md)) {
        const markdown = await extractPdfMarkdown(pdf);
        fs.writeFileSync(md, markdown, 'utf-8');
      }
    } catch (e) {
      failures.push({
        id: t.id,
        stage: 'extract',
        error: String(e instanceof Error ? e.message : e),
      });
      process.stderr.write(`  EXTRACT FAIL ${t.id}: ${String(e)}\n`);
      continue;
    }

    const buf = fs.readFileSync(pdf);
    entries.push({
      id: t.id,
      origin: t.origin,
      title: t.title,
      arxivId: t.arxivId,
      doi: t.doi,
      pages: pageCount(pdf),
      sha256: sha256(buf),
      tags: t.tags,
      source,
      crossCites: t.crossCites,
      citedBy: t.citedBy,
    });
    process.stderr.write(
      `  ok ${t.origin === 'seed' ? '[seed] ' : '[mined]'} ${t.id} (${entries[entries.length - 1].pages}p)\n`
    );
  }

  const manifest = {
    note: 'Claim-grounding eval corpus (docs/plans/claim-grounding-eval.md). 19 seed perception papers plus references mined from them by cross-citation. PDFs are not checked in; they are materialised into eval/corpus/cache/ by eval/corpus/build.ts and pinned here by sha256.',
    generatedAt: new Date().toISOString(),
    count: entries.length,
    papers: entries,
  };
  fs.writeFileSync(path.join(DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(
    path.join(DIR, 'build-log.json'),
    `${JSON.stringify({ built: entries.length, failures }, null, 2)}\n`
  );
  process.stderr.write(`\nBuilt ${entries.length}/${tasks.length}; ${failures.length} failed.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
