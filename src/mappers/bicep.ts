import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.js";
import { walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

type BicepSummary = {
  resources: string[];
  modules: string[];
  params: string[];
  outputs: string[];
  secureParams: string[];
};

const maxOwnedFiles = 8;

export async function bicepSeeds(root: string): Promise<FeatureSeed[]> {
  const files = await bicepFiles(root);
  if (files.length === 0) {
    return [];
  }

  const configFiles = await bicepContextFiles(root);
  return Promise.all(files.map((file) => bicepSeed(root, file, configFiles)));
}

async function bicepFiles(root: string): Promise<string[]> {
  return (await walk(root, [""]))
    .filter((path) => /\.(bicep|bicepparam)$/u.test(path))
    .toSorted((left, right) => left.localeCompare(right));
}

async function bicepContextFiles(root: string): Promise<Array<{ path: string; reason: string }>> {
  const candidates = ["bicepconfig.json", "azure.yaml"];
  const refs: Array<{ path: string; reason: string }> = [];
  for (const path of candidates) {
    if (await pathExists(join(root, path))) {
      refs.push({ path, reason: "Azure deployment configuration" });
    }
  }
  return refs;
}

async function bicepSeed(
  root: string,
  path: string,
  configFiles: Array<{ path: string; reason: string }>,
): Promise<FeatureSeed> {
  const source = await readFile(join(root, path), "utf8");
  const summary = bicepSummary(source);
  const moduleFiles = await localModuleFiles(root, source);
  const isParamsFile = path.endsWith(".bicepparam");
  return {
    title: isParamsFile ? `Bicep parameters ${path}` : `Bicep deployment ${path}`,
    summary: bicepSummaryText(summary, isParamsFile),
    kind: "infra",
    source: isParamsFile ? "bicep-params" : "bicep-deployment",
    confidence: "medium",
    entryPath: path,
    symbol: path.replace(/\.(bicep|bicepparam)$/u, ""),
    route: null,
    command: null,
    ownedFiles: [
      { path, reason: isParamsFile ? "Bicep parameter file" : "Bicep deployment file" },
      ...moduleFiles.slice(0, maxOwnedFiles - 1).map((modulePath) => ({
        path: modulePath,
        reason: "local Bicep module",
      })),
    ],
    contextFiles: configFiles,
    tags: ["azure", "bicep", isParamsFile ? "parameters" : "deployment"],
    trustBoundaries: bicepTrustBoundaries(source, summary),
    skipNearbyTests: true,
  };
}

function bicepSummary(source: string): BicepSummary {
  return {
    resources: uniqueCapture2(source, /^\s*resource\s+([A-Za-z_][\w]*)\s+'([^']+)'/gmu).map(
      ([name, type]) => `${name}:${type}`,
    ),
    modules: uniqueCapture2(source, /^\s*module\s+([A-Za-z_][\w]*)\s+'([^']+)'/gmu).map(
      ([name, target]) => `${name}:${target}`,
    ),
    params: uniqueCapture1(source, /^\s*param\s+([A-Za-z_][\w]*)\b/gmu),
    outputs: uniqueCapture1(source, /^\s*output\s+([A-Za-z_][\w]*)\b/gmu),
    secureParams: secureParamNames(source),
  };
}

function bicepSummaryText(summary: BicepSummary, isParamsFile: boolean): string {
  if (isParamsFile) {
    return `Bicep parameter file with ${summary.params.length} parameters.`;
  }
  const parts = [
    `${summary.resources.length} resources`,
    `${summary.modules.length} modules`,
    `${summary.params.length} parameters`,
    `${summary.outputs.length} outputs`,
  ];
  if (summary.secureParams.length > 0) {
    parts.push(`${summary.secureParams.length} secure parameters`);
  }
  return `Bicep deployment with ${parts.join(", ")}.`;
}

function uniqueCapture1(source: string, pattern: RegExp): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const match of source.matchAll(pattern)) {
    const value = match[1];
    if (value === undefined || seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function uniqueCapture2(source: string, pattern: RegExp): Array<[string, string]> {
  const seen = new Set<string>();
  const output: Array<[string, string]> = [];
  for (const match of source.matchAll(pattern)) {
    const left = match[1];
    const right = match[2];
    if (left === undefined || right === undefined) {
      continue;
    }
    const key = `${left}:${right}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push([left, right]);
  }
  return output;
}

function secureParamNames(source: string): string[] {
  const lines = source.split(/\r?\n/u);
  const secure: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/@secure\(\)/u.test(lines[index] ?? "")) {
      continue;
    }
    const paramLine = lines.slice(index + 1, index + 4).find((line) => /^\s*param\s+/u.test(line));
    const name = /^\s*param\s+([A-Za-z_][\w]*)\b/u.exec(paramLine ?? "")?.[1];
    if (name !== undefined) {
      secure.push(name);
    }
  }
  return [...new Set(secure)].toSorted((left, right) => left.localeCompare(right));
}

async function localModuleFiles(root: string, source: string): Promise<string[]> {
  const moduleTargets = uniqueCapture1(source, /^\s*module\s+[A-Za-z_][\w]*\s+'([^']+)'/gmu).filter(
    (target) => target.startsWith("./") || target.startsWith("../"),
  );
  const files: string[] = [];
  for (const target of moduleTargets) {
    const normalized = target.replace(/^\.\//u, "");
    if (!normalized.startsWith("..") && (await pathExists(join(root, normalized)))) {
      files.push(normalized);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function bicepTrustBoundaries(
  source: string,
  summary: BicepSummary,
): FeatureSeed["trustBoundaries"] {
  const boundaries = new Set<FeatureSeed["trustBoundaries"][number]>([
    "external-api",
    "permissions",
    "serialization",
  ]);
  if (
    summary.secureParams.length > 0 ||
    /\b(keyVault|secret|password|credential)\b/iu.test(source)
  ) {
    boundaries.add("secrets");
  }
  if (
    /\b(Microsoft\.Network|virtualNetworks|privateEndpoints|publicIPAddresses)\b/iu.test(source)
  ) {
    boundaries.add("network");
  }
  if (/\b(Microsoft\.Storage|Microsoft\.Sql|Microsoft\.DocumentDB|database)\b/iu.test(source)) {
    boundaries.add("database");
  }
  if (/\b(roleAssignments|authorization|identity|principalId|tenantId)\b/iu.test(source)) {
    boundaries.add("auth");
    boundaries.add("permissions");
  }
  if (/\b(deploymentScripts|Microsoft\.Resources\/deploymentScripts)\b/iu.test(source)) {
    boundaries.add("process-exec");
  }
  return [...boundaries].toSorted((left, right) => left.localeCompare(right));
}
