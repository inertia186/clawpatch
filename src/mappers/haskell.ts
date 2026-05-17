import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.js";
import { isSafeFile, normalize, walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

type CabalStanza = {
  kind: "library" | "executable" | "test-suite" | "benchmark";
  name: string;
  body: string;
};

const defaultSourceDirs = ["src"];
const defaultTestDirs = ["test", "tests", "spec"];
const defaultAppDirs = ["app"];
const maxOwnedSourceFiles = 12;

export async function haskellSeeds(root: string): Promise<FeatureSeed[]> {
  const cabalFiles = await rootCabalFiles(root);
  if (
    cabalFiles.length === 0 &&
    !(await pathExists(join(root, "package.yaml"))) &&
    !(await pathExists(join(root, "stack.yaml"))) &&
    !(await pathExists(join(root, "cabal.project")))
  ) {
    return [];
  }

  const seeds: FeatureSeed[] = [];
  const testCommand = await haskellTestCommand(root);
  for (const cabalFile of cabalFiles) {
    seeds.push(...(await cabalSeeds(root, cabalFile, testCommand)));
  }
  if (cabalFiles.length === 0) {
    seeds.push(...(await conventionSeeds(root, testCommand)));
  }
  return seeds;
}

async function cabalSeeds(
  root: string,
  cabalFile: string,
  testCommand: string,
): Promise<FeatureSeed[]> {
  const manifest = await readFile(join(root, cabalFile), "utf8");
  const packageName = cabalField(manifest, "name") ?? cabalFile.replace(/\.cabal$/u, "");
  const tests = await haskellTestRefs(root, testCommand);
  const seeds: FeatureSeed[] = [];

  for (const stanza of cabalStanzas(manifest, packageName)) {
    const sourceDirs = cabalListField(stanza.body, "hs-source-dirs");
    const dirs =
      sourceDirs.length > 0 ? sourceDirs : defaultDirsForStanza(stanza.kind, stanza.name);
    const mainIs = cabalField(stanza.body, "main-is");
    const files = await haskellFiles(root, dirs);
    const entryPath = await stanzaEntryPath(root, stanza, dirs, mainIs, files, cabalFile);
    const ownedFiles = files.slice(0, maxOwnedSourceFiles).map((path) => ({
      path,
      reason: `${stanza.kind} source`,
    }));

    if (stanza.kind === "library") {
      seeds.push({
        title: `Haskell library ${stanza.name}`,
        summary: `Cabal library stanza ${stanza.name} in ${cabalFile}.`,
        kind: "library",
        source: "cabal-library",
        confidence: "medium",
        entryPath,
        symbol: stanza.name,
        route: null,
        command: null,
        ownedFiles: ownedFiles.length > 0 ? ownedFiles : [{ path: cabalFile, reason: "manifest" }],
        contextFiles: [{ path: cabalFile, reason: "Cabal manifest" }],
        tags: ["haskell", "cabal", "library"],
        trustBoundaries: await haskellTrustBoundaries(root, files),
        tests,
        testCommand,
        testPrefixes: defaultTestDirs,
      });
      continue;
    }

    if (stanza.kind === "test-suite") {
      seeds.push({
        title: `Haskell test suite ${stanza.name}`,
        summary: `Cabal test-suite stanza ${stanza.name} in ${cabalFile}.`,
        kind: "test-suite",
        source: "cabal-test-suite",
        confidence: "medium",
        entryPath,
        symbol: stanza.name,
        route: null,
        command: null,
        ownedFiles:
          ownedFiles.length > 0 ? ownedFiles : [{ path: entryPath, reason: "test entrypoint" }],
        contextFiles: [{ path: cabalFile, reason: "Cabal manifest" }],
        tags: ["haskell", "cabal", "test"],
        trustBoundaries: [],
        skipNearbyTests: true,
      });
      continue;
    }

    seeds.push({
      title:
        stanza.kind === "benchmark"
          ? `Haskell benchmark ${stanza.name}`
          : `Haskell executable ${stanza.name}`,
      summary: `Cabal ${stanza.kind} stanza ${stanza.name} in ${cabalFile}.`,
      kind: stanza.kind === "benchmark" ? "unknown" : "cli-command",
      source: stanza.kind === "benchmark" ? "cabal-benchmark" : "cabal-executable",
      confidence: "medium",
      entryPath,
      symbol: mainIs ?? "Main",
      route: null,
      command: stanza.name,
      ownedFiles: ownedFiles.length > 0 ? ownedFiles : [{ path: entryPath, reason: "entrypoint" }],
      contextFiles: [{ path: cabalFile, reason: "Cabal manifest" }],
      tags: ["haskell", "cabal", stanza.kind],
      trustBoundaries: await haskellTrustBoundaries(root, files),
      tests,
      testCommand,
      testPrefixes: defaultTestDirs,
    });
  }

  if (seeds.length === 0) {
    seeds.push(...(await conventionSeeds(root, testCommand)));
  }
  return seeds;
}

async function conventionSeeds(root: string, testCommand: string): Promise<FeatureSeed[]> {
  const seeds: FeatureSeed[] = [];
  const sourceFiles = await haskellFiles(root, defaultSourceDirs);
  const appFiles = await haskellFiles(root, defaultAppDirs);
  const testFiles = await haskellFiles(root, defaultTestDirs);
  const tests = testFiles.map((path) => ({ path, command: testCommand }));
  if (sourceFiles.length > 0) {
    seeds.push({
      title: "Haskell source src",
      summary: `Conventional Haskell source group with ${sourceFiles.length} files.`,
      kind: "library",
      source: "haskell-source-group",
      confidence: "low",
      entryPath: sourceFiles[0] ?? "package.yaml",
      symbol: "src",
      route: null,
      command: null,
      ownedFiles: sourceFiles.slice(0, maxOwnedSourceFiles).map((path) => ({
        path,
        reason: "Haskell source group",
      })),
      tags: ["haskell", "source"],
      trustBoundaries: await haskellTrustBoundaries(root, sourceFiles),
      tests,
      testCommand,
      testPrefixes: defaultTestDirs,
    });
  }
  for (const file of appFiles.filter((path) => path.endsWith("/Main.hs") || path === "Main.hs")) {
    seeds.push({
      title: `Haskell executable ${file}`,
      summary: `Conventional Haskell executable entrypoint at ${file}.`,
      kind: "cli-command",
      source: "haskell-main",
      confidence: "low",
      entryPath: file,
      symbol: "main",
      route: null,
      command: null,
      tags: ["haskell", "executable"],
      trustBoundaries: await haskellTrustBoundaries(root, [file]),
      tests,
      testCommand,
      testPrefixes: defaultTestDirs,
    });
  }
  if (testFiles.length > 0) {
    seeds.push({
      title: "Haskell test suite",
      summary: `Conventional Haskell test group with ${testFiles.length} files.`,
      kind: "test-suite",
      source: "haskell-test-group",
      confidence: "low",
      entryPath: testFiles[0] ?? "package.yaml",
      symbol: null,
      route: null,
      command: null,
      ownedFiles: testFiles.slice(0, maxOwnedSourceFiles).map((path) => ({
        path,
        reason: "Haskell test group",
      })),
      tags: ["haskell", "test"],
      trustBoundaries: [],
      skipNearbyTests: true,
    });
  }
  return seeds;
}

async function rootCabalFiles(root: string): Promise<string[]> {
  return (await walk(root, [""]))
    .filter((path) => /^[^/]+\.cabal$/u.test(path))
    .toSorted((left, right) => left.localeCompare(right));
}

function cabalStanzas(manifest: string, packageName: string): CabalStanza[] {
  const stanzaMatches = [
    ...manifest.matchAll(/^(library|executable|test-suite|benchmark)(?:\s+([^\s]+))?\s*$/gimu),
  ];
  return stanzaMatches.flatMap((match, index) => {
    const kind = match[1]?.toLowerCase() as CabalStanza["kind"] | undefined;
    if (kind === undefined || match.index === undefined) {
      return [];
    }
    const next = stanzaMatches[index + 1]?.index ?? manifest.length;
    const name = kind === "library" ? (match[2] ?? packageName) : (match[2] ?? kind);
    return [
      {
        kind,
        name,
        body: manifest.slice(match.index + match[0].length, next),
      },
    ];
  });
}

function cabalField(source: string, field: string): string | null {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*${escapedField}\\s*:\\s*(.+?)\\s*$`, "imu").exec(source)?.[1] ?? null;
}

function cabalListField(source: string, field: string): string[] {
  const value = cabalField(source, field);
  return value === null
    ? []
    : value
        .split(/[\s,]+/u)
        .map((entry) => normalize(entry.trim()).replace(/^\.\//u, "").replace(/\/$/u, ""))
        .filter(isSafeRelativePath);
}

function defaultDirsForStanza(kind: CabalStanza["kind"], name: string): string[] {
  if (kind === "library") {
    return defaultSourceDirs;
  }
  if (kind === "test-suite") {
    return defaultTestDirs;
  }
  if (kind === "benchmark") {
    return ["bench", "benchmark", "benchmarks"];
  }
  return [...defaultAppDirs, `app/${name}`, "src"];
}

async function stanzaEntryPath(
  root: string,
  stanza: CabalStanza,
  dirs: string[],
  mainIs: string | null,
  files: string[],
  fallback: string,
): Promise<string> {
  if (mainIs !== null) {
    for (const dir of dirs) {
      const candidate = normalize(join(dir, mainIs));
      if (await isSafeFile(root, join(root, candidate))) {
        return candidate;
      }
    }
  }
  if (stanza.kind === "library") {
    return files.find((file) => /\/?Lib\.hs$/u.test(file)) ?? files[0] ?? fallback;
  }
  return files.find((file) => /\/?Main\.hs$/u.test(file)) ?? files[0] ?? fallback;
}

async function haskellFiles(root: string, dirs: string[]): Promise<string[]> {
  const safeDirs = dirs.filter(isSafeRelativePath);
  return (await walk(root, safeDirs))
    .filter((path) => /\.(hs|lhs)$/u.test(path))
    .toSorted((left, right) => left.localeCompare(right));
}

async function haskellTestCommand(root: string): Promise<string> {
  if (await pathExists(join(root, "stack.yaml"))) {
    return "stack test";
  }
  return "cabal test all";
}

async function haskellTestRefs(
  root: string,
  command: string,
): Promise<
  Array<{
    path: string;
    command: string;
  }>
> {
  return (await haskellFiles(root, defaultTestDirs))
    .slice(0, maxOwnedSourceFiles)
    .map((path) => ({ path, command }));
}

async function haskellTrustBoundaries(
  root: string,
  files: string[],
): Promise<FeatureSeed["trustBoundaries"]> {
  const boundaries = new Set<FeatureSeed["trustBoundaries"][number]>();
  for (const file of files.slice(0, maxOwnedSourceFiles)) {
    const source = await readFile(join(root, file), "utf8").catch(() => "");
    if (/\bimport\s+(qualified\s+)?(Network|Network\.HTTP|Network\.Wai|Servant)\b/mu.test(source)) {
      boundaries.add("network");
      boundaries.add("external-api");
    }
    if (/\bimport\s+(qualified\s+)?(Database|Persistent|Hasql)\b/mu.test(source)) {
      boundaries.add("database");
    }
    if (/\bimport\s+(qualified\s+)?System\.(Directory|FilePath|IO)\b/mu.test(source)) {
      boundaries.add("filesystem");
    }
    if (/\bimport\s+(qualified\s+)?System\.Process\b/mu.test(source)) {
      boundaries.add("process-exec");
    }
    if (/\bimport\s+(qualified\s+)?System\.Environment\b/mu.test(source)) {
      boundaries.add("secrets");
      boundaries.add("user-input");
    }
    if (/\bimport\s+(qualified\s+)?Control\.Concurrent\b/mu.test(source)) {
      boundaries.add("concurrency");
    }
    if (/\bimport\s+(qualified\s+)?Data\.(Aeson|Binary|Serialize)\b/mu.test(source)) {
      boundaries.add("serialization");
    }
  }
  return [...boundaries].toSorted((left, right) => left.localeCompare(right));
}

function isSafeRelativePath(path: string): boolean {
  return (
    path.length > 0 && path !== "." && !path.startsWith("/") && !path.split("/").includes("..")
  );
}
