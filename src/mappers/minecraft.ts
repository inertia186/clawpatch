import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.js";
import { walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

type DatapackFile = {
  namespace: string;
  category: string;
  name: string;
  path: string;
};

const datapackCategories = new Map<string, DatapackCategory>([
  ["functions", { title: "function", kind: "job", source: "minecraft-function" }],
  ["advancements", { title: "advancement", kind: "unknown", source: "minecraft-advancement" }],
  ["recipes", { title: "recipe", kind: "config", source: "minecraft-recipe" }],
  ["loot_tables", { title: "loot table", kind: "config", source: "minecraft-loot-table" }],
  ["predicates", { title: "predicate", kind: "config", source: "minecraft-predicate" }],
  ["tags", { title: "tag", kind: "config", source: "minecraft-tag" }],
]);

type DatapackCategory = {
  title: string;
  kind: FeatureSeed["kind"];
  source: string;
};

export async function minecraftSeeds(root: string): Promise<FeatureSeed[]> {
  if (!(await pathExists(join(root, "pack.mcmeta"))) || !(await pathExists(join(root, "data")))) {
    return [];
  }

  const files = await datapackFiles(root);
  return [packSeed(), ...(await Promise.all(files.map((file) => datapackSeed(root, file))))];
}

function packSeed(): FeatureSeed {
  return {
    title: "Minecraft datapack metadata",
    summary: "Minecraft datapack pack.mcmeta metadata.",
    kind: "config",
    source: "minecraft-pack-metadata",
    confidence: "high",
    entryPath: "pack.mcmeta",
    symbol: null,
    route: null,
    command: null,
    ownedFiles: [{ path: "pack.mcmeta", reason: "datapack metadata" }],
    tags: ["minecraft", "datapack", "metadata"],
    trustBoundaries: ["serialization"],
    skipNearbyTests: true,
  };
}

async function datapackFiles(root: string): Promise<DatapackFile[]> {
  return (await walk(root, ["data"]))
    .flatMap(parseDatapackPath)
    .toSorted((left, right) => left.path.localeCompare(right.path));
}

function parseDatapackPath(path: string): DatapackFile[] {
  const match = /^data\/([^/]+)\/([^/]+)\/(.+)$/u.exec(path);
  if (match === null) {
    return [];
  }
  const [, namespace, category, rest] = match;
  if (
    namespace === undefined ||
    category === undefined ||
    rest === undefined ||
    !datapackCategories.has(category) ||
    !isDatapackCategoryFile(category, rest)
  ) {
    return [];
  }
  return [
    {
      namespace,
      category,
      name: rest.replace(/\.(mcfunction|json)$/u, ""),
      path,
    },
  ];
}

function isDatapackCategoryFile(category: string, path: string): boolean {
  if (category === "functions") {
    return path.endsWith(".mcfunction");
  }
  return path.endsWith(".json");
}

async function datapackSeed(root: string, file: DatapackFile): Promise<FeatureSeed> {
  const category = datapackCategories.get(file.category);
  if (category === undefined) {
    throw new Error(`unknown datapack category: ${file.category}`);
  }
  const source = await readFile(join(root, file.path), "utf8").catch(() => "");
  const command = file.category === "functions" ? `${file.namespace}:${file.name}` : null;
  return {
    title: `Minecraft ${category.title} ${file.namespace}:${file.name}`,
    summary: datapackSummary(file, source),
    kind: category.kind,
    source: category.source,
    confidence: "medium",
    entryPath: file.path,
    symbol: `${file.namespace}:${file.name}`,
    route: null,
    command,
    ownedFiles: [{ path: file.path, reason: `minecraft ${category.title}` }],
    contextFiles: [{ path: "pack.mcmeta", reason: "datapack metadata" }],
    tags: ["minecraft", "datapack", file.namespace, file.category],
    trustBoundaries: minecraftTrustBoundaries(file, source),
    skipNearbyTests: true,
  };
}

function datapackSummary(file: DatapackFile, source: string): string {
  if (file.category === "functions") {
    const commands = source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    return `Minecraft function ${file.namespace}:${file.name} with ${commands.length} commands.`;
  }
  const jsonKinds = jsonSummaryParts(source);
  return `Minecraft ${file.category.replace(/_/gu, " ")} ${file.namespace}:${file.name}${jsonKinds}.`;
}

function jsonSummaryParts(source: string): string {
  const parts: string[] = [];
  const type = /"type"\s*:\s*"([^"]+)"/u.exec(source)?.[1];
  const trigger = /"trigger"\s*:\s*"([^"]+)"/u.exec(source)?.[1];
  const functionRef = /"function"\s*:\s*"([^"]+)"/u.exec(source)?.[1];
  if (type !== undefined) {
    parts.push(`type ${type}`);
  }
  if (trigger !== undefined) {
    parts.push(`trigger ${trigger}`);
  }
  if (functionRef !== undefined) {
    parts.push(`function ${functionRef}`);
  }
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

function minecraftTrustBoundaries(
  file: DatapackFile,
  source: string,
): FeatureSeed["trustBoundaries"] {
  const boundaries = new Set<FeatureSeed["trustBoundaries"][number]>(["serialization"]);
  if (file.category === "functions") {
    boundaries.add("process-exec");
    if (/\b(execute|function|schedule)\b/iu.test(source)) {
      boundaries.add("process-exec");
      boundaries.add("concurrency");
    }
    if (/@[pares]\b|\bselector\b/iu.test(source)) {
      boundaries.add("user-input");
      boundaries.add("permissions");
    }
    if (/\b(data|scoreboard|attribute|tag)\b/iu.test(source)) {
      boundaries.add("database");
    }
    if (/\b(give|clear|kill|tp|teleport|summon|setblock|fill|gamemode|op|deop)\b/iu.test(source)) {
      boundaries.add("permissions");
      boundaries.add("filesystem");
    }
  }
  if (/\b(function|loot|recipe|advancement)\b/iu.test(source)) {
    boundaries.add("external-api");
  }
  return [...boundaries].toSorted((left, right) => left.localeCompare(right));
}
