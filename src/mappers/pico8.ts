import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

type Pico8Cart = {
  path: string;
  name: string;
  sections: Map<string, string>;
};

type Pico8Callback = {
  name: string;
  kind: FeatureSeed["kind"];
  summary: string;
  tags: string[];
};

const callbacks: Pico8Callback[] = [
  {
    name: "_init",
    kind: "service",
    summary: "PICO-8 initialization callback.",
    tags: ["init"],
  },
  {
    name: "_update",
    kind: "service",
    summary: "PICO-8 update loop callback.",
    tags: ["update-loop"],
  },
  {
    name: "_update60",
    kind: "service",
    summary: "PICO-8 60 FPS update loop callback.",
    tags: ["update-loop"],
  },
  {
    name: "_draw",
    kind: "ui-flow",
    summary: "PICO-8 draw callback.",
    tags: ["draw"],
  },
];

const assetSections = new Map<string, { title: string; tag: string }>([
  ["__gfx__", { title: "spritesheet", tag: "gfx" }],
  ["__map__", { title: "map", tag: "map" }],
  ["__sfx__", { title: "sound effects", tag: "sfx" }],
  ["__music__", { title: "music patterns", tag: "music" }],
  ["__label__", { title: "label art", tag: "label" }],
]);

export async function pico8Seeds(root: string): Promise<FeatureSeed[]> {
  const files = (await walk(root, [""]))
    .filter((path) => path.endsWith(".p8") || path.endsWith(".p8.lua"))
    .toSorted((left, right) => left.localeCompare(right));
  const seeds: FeatureSeed[] = [];

  for (const path of files) {
    const source = await readFile(join(root, path), "utf8").catch(() => "");
    const cart = pico8Cart(path, source);
    if (cart === null) {
      continue;
    }
    seeds.push(cartSeed(cart));
    seeds.push(...callbackSeeds(cart));
    seeds.push(...assetSeeds(cart));
  }

  return seeds;
}

function pico8Cart(path: string, source: string): Pico8Cart | null {
  if (path.endsWith(".p8") && !source.startsWith("pico-8 cartridge")) {
    return null;
  }
  const sections = path.endsWith(".p8.lua") ? luaOnlySections(source) : cartSections(source);
  if (!sections.has("__lua__")) {
    return null;
  }
  return {
    path,
    name: basename(path).replace(/\.p8(?:\.lua)?$/u, ""),
    sections,
  };
}

function cartSections(source: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = source.split(/\r?\n/u);
  let current: string | null = null;
  let body: string[] = [];
  for (const line of lines) {
    if (/^__[a-z0-9_]+__$/u.test(line.trim())) {
      if (current !== null) {
        sections.set(current, body.join("\n"));
      }
      current = line.trim();
      body = [];
      continue;
    }
    if (current !== null) {
      body.push(line);
    }
  }
  if (current !== null) {
    sections.set(current, body.join("\n"));
  }
  return sections;
}

function luaOnlySections(source: string): Map<string, string> {
  return new Map([["__lua__", source]]);
}

function cartSeed(cart: Pico8Cart): FeatureSeed {
  const lua = cart.sections.get("__lua__") ?? "";
  const sectionNames = [...cart.sections.keys()].join(", ");
  return {
    title: `PICO-8 cart ${cart.name}`,
    summary: `PICO-8 cart ${cart.path} with sections ${sectionNames}. Lua has ${luaLineCount(lua)} code lines.`,
    kind: "unknown",
    source: "pico8-cart",
    confidence: "medium",
    entryPath: cart.path,
    identityKey: "cart",
    symbol: cart.name,
    route: null,
    command: null,
    ownedFiles: [{ path: cart.path, reason: "PICO-8 cart" }],
    tags: ["pico-8", "cart"],
    trustBoundaries: pico8TrustBoundaries(lua),
    skipNearbyTests: true,
  };
}

function callbackSeeds(cart: Pico8Cart): FeatureSeed[] {
  const lua = cart.sections.get("__lua__") ?? "";
  return callbacks
    .filter((callback) => hasLuaFunction(lua, callback.name))
    .map((callback) => ({
      title: `PICO-8 ${cart.name} ${callback.name}`,
      summary: `${callback.summary} ${luaFunctionSummary(lua, callback.name)}`,
      kind: callback.kind,
      source: "pico8-lua-callback",
      confidence: "medium",
      entryPath: cart.path,
      identityKey: callback.name,
      symbol: callback.name,
      route: null,
      command: null,
      ownedFiles: [{ path: cart.path, reason: `PICO-8 ${callback.name} callback` }],
      tags: ["pico-8", "lua", ...callback.tags],
      trustBoundaries: pico8TrustBoundaries(luaFunctionBody(lua, callback.name)),
      skipNearbyTests: true,
    }));
}

function assetSeeds(cart: Pico8Cart): FeatureSeed[] {
  return [...assetSections.entries()].flatMap(([section, info]) => {
    const body = cart.sections.get(section);
    if (body === undefined || body.trim().length === 0) {
      return [];
    }
    return [
      {
        title: `PICO-8 ${cart.name} ${info.title}`,
        summary: `PICO-8 ${info.title} section ${section} in ${cart.path} with ${nonEmptyLineCount(
          body,
        )} data lines.`,
        kind: "config" as const,
        source: "pico8-cart-asset",
        confidence: "medium" as const,
        entryPath: cart.path,
        identityKey: section,
        symbol: section,
        route: null,
        command: null,
        ownedFiles: [{ path: cart.path, reason: `PICO-8 ${info.title} section` }],
        tags: ["pico-8", "asset", info.tag],
        trustBoundaries: ["serialization" as const],
        skipNearbyTests: true,
      },
    ];
  });
}

function hasLuaFunction(lua: string, name: string): boolean {
  return new RegExp(`(^|\\n)\\s*function\\s+${escapeRegExp(name)}\\s*\\(`, "u").test(lua);
}

function luaFunctionSummary(lua: string, name: string): string {
  const body = luaFunctionBody(lua, name);
  const calls = pico8ApiCalls(body);
  const details = [`${luaLineCount(body)} code lines`, `${calls.length} PICO-8 API call groups`];
  if (calls.length > 0) {
    details.push(`uses ${calls.join(", ")}`);
  }
  return details.join("; ") + ".";
}

function luaFunctionBody(lua: string, name: string): string {
  const start = new RegExp(`(^|\\n)\\s*function\\s+${escapeRegExp(name)}\\s*\\([^)]*\\)`, "u").exec(
    lua,
  );
  if (start?.index === undefined) {
    return "";
  }
  const rest = lua.slice(start.index + start[0].length);
  const nextFunction = /(^|\n)\s*function\s+[A-Za-z_][\w]*\s*\(/u.exec(rest);
  return nextFunction?.index === undefined ? rest : rest.slice(0, nextFunction.index);
}

function pico8ApiCalls(lua: string): string[] {
  const groups = new Set<string>();
  if (/\b(btn|btnp)\s*\(/u.test(lua)) {
    groups.add("input");
  }
  if (/\b(spr|sspr|map|mset|mget|pget|pset)\s*\(/u.test(lua)) {
    groups.add("graphics");
  }
  if (/\b(sfx|music)\s*\(/u.test(lua)) {
    groups.add("audio");
  }
  if (/\b(cartdata|dget|dset|memcpy|memset|peek|poke)\s*\(/u.test(lua)) {
    groups.add("memory");
  }
  if (/\b(stat|extcmd|run|reload|cstore)\s*\(/u.test(lua)) {
    groups.add("system");
  }
  return [...groups].toSorted((left, right) => left.localeCompare(right));
}

function pico8TrustBoundaries(lua: string): FeatureSeed["trustBoundaries"] {
  const boundaries = new Set<FeatureSeed["trustBoundaries"][number]>(["serialization"]);
  if (/\b(btn|btnp|stat)\s*\(/u.test(lua)) {
    boundaries.add("user-input");
  }
  if (/\b(cartdata|dget|dset|reload|cstore)\s*\(/u.test(lua)) {
    boundaries.add("filesystem");
  }
  if (/\b(peek|poke|memcpy|memset)\s*\(/u.test(lua)) {
    boundaries.add("permissions");
  }
  if (/\b(extcmd|run)\s*\(/u.test(lua)) {
    boundaries.add("process-exec");
  }
  return [...boundaries].toSorted((left, right) => left.localeCompare(right));
}

function luaLineCount(lua: string): number {
  return lua
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("--")).length;
}

function nonEmptyLineCount(text: string): number {
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
