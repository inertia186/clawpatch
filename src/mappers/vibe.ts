import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

type VibeFinding = {
  label: string;
  count: number;
};

type VibeScore = {
  path: string;
  findings: VibeFinding[];
  score: number;
};

const maxVibeFeatures = 5;
const maxReadBytes = 64_000;

const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".yml",
  ".yaml",
]);

const vibePatterns: Array<{ label: string; pattern: RegExp; weight: number }> = [
  { label: "TODO", pattern: /\bTODO\b/giu, weight: 2 },
  { label: "FIXME", pattern: /\bFIXME\b/giu, weight: 4 },
  { label: "HACK", pattern: /\bHACK\b/giu, weight: 5 },
  { label: "XXX", pattern: /\bXXX\b/giu, weight: 4 },
  { label: "cursed", pattern: /\bcursed\b/giu, weight: 5 },
  { label: "sorry", pattern: /\bsorry\b/giu, weight: 3 },
  { label: "probably", pattern: /\bprobably\b/giu, weight: 2 },
  { label: "yolo", pattern: /\byolo\b/giu, weight: 6 },
  { label: "panic punctuation", pattern: /!{2,}/gu, weight: 1 },
];

export async function vibeSeeds(root: string): Promise<FeatureSeed[]> {
  const candidates = (await walk(root, [""])).filter(isVibeScannablePath);
  const scored: VibeScore[] = [];

  for (const path of candidates) {
    const source = await readFile(join(root, path), "utf8").catch(() => "");
    const score = scoreVibes(source.slice(0, maxReadBytes), path);
    if (score.score > 0) {
      scored.push(score);
    }
  }

  return scored
    .toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxVibeFeatures)
    .map((score) => vibeSeed(score));
}

function vibeSeed(score: VibeScore): FeatureSeed {
  const labels = score.findings.map((finding) => `${finding.label} x${finding.count}`).join(", ");
  return {
    title: `Vibe check ${score.path}`,
    summary: `Indefensible textual vibe score ${score.score}: ${labels}.`,
    kind: "unknown",
    source: "vibe-check",
    confidence: "low",
    entryPath: score.path,
    symbol: "vibes",
    route: null,
    command: null,
    ownedFiles: [{ path: score.path, reason: "failed the vibe check" }],
    tags: ["vibe-check", "indefensible"],
    trustBoundaries: trustBoundariesForVibes(score.path),
    skipNearbyTests: true,
  };
}

function scoreVibes(source: string, path: string): VibeScore {
  const findings = vibePatterns
    .map((vibe) => {
      const count = [...source.matchAll(vibe.pattern)].length;
      return { label: vibe.label, count, weighted: count * vibe.weight };
    })
    .filter((finding) => finding.count > 0);

  return {
    path,
    findings: findings.map(({ label, count }) => ({ label, count })),
    score: findings.reduce((total, finding) => total + finding.weighted, 0),
  };
}

function isVibeScannablePath(path: string): boolean {
  if (path.length === 0 || path.includes("/fixtures/") || path.includes("/testdata/")) {
    return false;
  }
  if (/\/?pnpm-lock\.yaml$/u.test(path) || /\/?package-lock\.json$/u.test(path)) {
    return false;
  }
  return sourceExtensions.has(extension(path));
}

function extension(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? "" : path.slice(index);
}

function trustBoundariesForVibes(path: string): FeatureSeed["trustBoundaries"] {
  if (/\.(ya?ml|json)$/u.test(path)) {
    return ["filesystem", "serialization"];
  }
  if (/\.(sh|js|mjs|ts|tsx|py|rb|php)$/u.test(path)) {
    return ["user-input", "filesystem", "process-exec"];
  }
  return ["filesystem"];
}
