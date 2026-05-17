import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

type LegalSection = {
  heading: string;
  startLine: number;
  endLine: number;
  body: string;
};

type LegalMetrics = {
  citations: number;
  absoluteClaims: number;
  crossReferences: number;
  quotedLines: number;
};

const maxBriefFiles = 20;
const maxSectionsPerBrief = 12;
const maxReadBytes = 250_000;

const sectionHeadingPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "Question Presented", pattern: /\bquestions?\s+presented\b/iu },
  { label: "Table of Authorities", pattern: /\btable\s+of\s+authorities\b/iu },
  { label: "Statement of Facts", pattern: /\b(statement\s+of\s+facts|facts)\b/iu },
  { label: "Procedural History", pattern: /\bprocedural\s+history\b/iu },
  { label: "Standard of Review", pattern: /\bstandard\s+of\s+review\b/iu },
  { label: "Argument", pattern: /\bargument\b/iu },
  { label: "Conclusion", pattern: /\bconclusion\b/iu },
  { label: "Relief Requested", pattern: /\b(relief\s+requested|prayer\s+for\s+relief)\b/iu },
  { label: "Certificate of Service", pattern: /\bcertificate\s+of\s+service\b/iu },
  { label: "Appendix", pattern: /\b(appendix|exhibit)\b/iu },
];

export async function legalSeeds(root: string): Promise<FeatureSeed[]> {
  const candidates = (await walk(root, [""])).filter(isLegalDocumentPath).slice(0, maxBriefFiles);
  const seeds: FeatureSeed[] = [];

  for (const path of candidates) {
    const source = await readFile(join(root, path), "utf8").catch(() => "");
    const text = source.slice(0, maxReadBytes);
    if (!looksLikeLegalBrief(path, text)) {
      continue;
    }
    const sections = legalSections(text);
    if (sections.length === 0) {
      seeds.push(briefDocumentSeed(path, text));
      continue;
    }
    seeds.push(
      ...sections
        .slice(0, maxSectionsPerBrief)
        .map((section, index) => sectionSeed(path, section, index)),
    );
  }

  return seeds;
}

function briefDocumentSeed(path: string, text: string): FeatureSeed {
  const metrics = legalMetrics(text);
  return {
    title: `Legal brief ${briefTitle(path)}`,
    summary: legalSummary("Legal brief document", metrics),
    kind: "unknown",
    source: "legal-brief-document",
    confidence: "low",
    entryPath: path,
    identityKey: "document",
    symbol: briefTitle(path),
    route: null,
    command: null,
    ownedFiles: [{ path, reason: "legal brief document" }],
    tags: ["legal", "brief", "document"],
    trustBoundaries: legalTrustBoundaries(text),
    skipNearbyTests: true,
  };
}

function sectionSeed(path: string, section: LegalSection, index: number): FeatureSeed {
  const label = canonicalSectionLabel(section.heading);
  const metrics = legalMetrics(section.body);
  return {
    title: `Legal brief ${label}`,
    summary: legalSummary(
      `${label} section in ${path}, lines ${section.startLine}-${section.endLine}`,
      metrics,
    ),
    kind: "unknown",
    source: "legal-brief-section",
    confidence: "medium",
    entryPath: path,
    identityKey: `${index}:${section.heading}`,
    symbol: section.heading,
    route: null,
    command: null,
    ownedFiles: [{ path, reason: `${label} section` }],
    tags: ["legal", "brief", legalTag(label)],
    trustBoundaries: legalTrustBoundaries(section.body),
    skipNearbyTests: true,
  };
}

function legalSections(text: string): LegalSection[] {
  const lines = text.split(/\r?\n/u);
  const starts: Array<{ heading: string; line: number }> = [];
  lines.forEach((line, index) => {
    const heading = legalHeading(line);
    if (heading !== null) {
      starts.push({ heading, line: index + 1 });
    }
  });

  return starts.flatMap((start, index) => {
    const next = starts[index + 1]?.line ?? lines.length + 1;
    const body = lines.slice(start.line, next - 1).join("\n");
    if (
      body.trim().length === 0 &&
      !sectionHeadingPatterns.some((entry) => entry.pattern.test(start.heading))
    ) {
      return [];
    }
    return [
      {
        heading: start.heading,
        startLine: start.line,
        endLine: next - 1,
        body,
      },
    ];
  });
}

function legalHeading(line: string): string | null {
  const trimmed = line.trim().replace(/\s+/gu, " ");
  if (trimmed.length === 0 || trimmed.length > 120) {
    return null;
  }
  const markdown = /^#{1,4}\s+(.+)$/u.exec(trimmed)?.[1];
  if (markdown !== undefined && isLegalHeadingText(markdown)) {
    return markdown;
  }
  const numbered = /^(?:[IVXLCDM]+\.|[A-Z]\.|\d+\.)\s+(.+)$/u.exec(trimmed)?.[1];
  if (numbered !== undefined && isLegalHeadingText(numbered)) {
    return numbered;
  }
  if (isAllCapsHeading(trimmed) && isLegalHeadingText(trimmed)) {
    return titleCase(trimmed);
  }
  return null;
}

function looksLikeLegalBrief(path: string, text: string): boolean {
  const headingHits = sectionHeadingPatterns.filter((entry) => entry.pattern.test(text)).length;
  const citationHits = legalMetrics(text).citations;
  const litigationHits = [
    /\b(plaintiff|defendant|appellant|appellee|petitioner|respondent)\b/iu,
    /\b(motion|memorandum|brief|complaint|petition|affidavit)\b/iu,
    /\b(court|jurisdiction|statute|rule|holding)\b/iu,
  ].filter((pattern) => pattern.test(text)).length;
  const nameHint = /\b(brief|motion|memo|memorandum|petition|complaint)\b/iu.test(path);
  return headingHits >= 2 || citationHits >= 3 || (nameHint && litigationHits >= 2);
}

function isLegalDocumentPath(path: string): boolean {
  return /\.(md|markdown|txt|rst)$/iu.test(path);
}

function isLegalHeadingText(text: string): boolean {
  return sectionHeadingPatterns.some((entry) => entry.pattern.test(text));
}

function isAllCapsHeading(text: string): boolean {
  return /[A-Z]/u.test(text) && text === text.toUpperCase();
}

function legalMetrics(text: string): LegalMetrics {
  return {
    citations: citationCount(text),
    absoluteClaims: matchCount(text, /\b(clearly|obviously|undisputed|always|never)\b/giu),
    crossReferences: matchCount(text, /\b(supra|infra|see\s+(?:section|part)\s+[IVXLCDM]+)\b/giu),
    quotedLines: text.split(/\r?\n/u).filter((line) => line.trim().startsWith(">")).length,
  };
}

function citationCount(text: string): number {
  return (
    matchCount(text, /\b\d+\s+(?:U\.S\.|F\.\s?(?:2d|3d|4th|Supp\.?\s?\d*d?)|S\.Ct\.)\s+\d+\b/gu) +
    matchCount(text, /\b\d+\s+[A-Z][A-Za-z.]*\s+(?:App\.|Rptr\.|Code|Stat\.)\s+\d+\b/gu) +
    matchCount(text, /\b(?:Fed\.|Cal\.|N\.Y\.|Tex\.)\s+R\.\s+[A-Za-z.]+\s+P\.\s+\d+/gu) +
    matchCount(text, /\b\d+\s+U\.S\.C\.\s+§+\s*\d+/gu)
  );
}

function matchCount(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function legalSummary(prefix: string, metrics: LegalMetrics): string {
  const details = [
    `${metrics.citations} citation-like references`,
    `${metrics.absoluteClaims} absolute-language claims`,
    `${metrics.crossReferences} internal cross references`,
    `${metrics.quotedLines} block-quote lines`,
  ];
  return `${prefix}. Contains ${details.join(", ")}.`;
}

function legalTrustBoundaries(text: string): FeatureSeed["trustBoundaries"] {
  const boundaries = new Set<FeatureSeed["trustBoundaries"][number]>([
    "user-input",
    "external-api",
    "serialization",
    "permissions",
  ]);
  if (/\b(privileged|confidential|attorney-client|work product)\b/iu.test(text)) {
    boundaries.add("auth");
    boundaries.add("secrets");
  }
  return [...boundaries].toSorted((left, right) => left.localeCompare(right));
}

function canonicalSectionLabel(heading: string): string {
  const match = sectionHeadingPatterns.find((entry) => entry.pattern.test(heading));
  return match?.label ?? titleCase(heading);
}

function legalTag(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function briefTitle(path: string): string {
  return basename(path).replace(/\.(md|markdown|txt|rst)$/iu, "");
}

function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/\b[a-z]/gu, (letter) => letter.toUpperCase())
    .replace(/\bOf\b/gu, "of")
    .replace(/\bAnd\b/gu, "and");
}
