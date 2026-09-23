// Fails when docs/architecture.md and the real import graph disagree. The
// diagram is a second spelling of what src/ imports, so it ships with the
// check that keeps the two honest: every real edge drawn, every drawn edge
// real, no edge pointing up a layer, no new cycle, no module nobody imports.
// The known exceptions are declared below, each with the reason it is one.
//
// `node scripts/check-architecture.mjs --graph` prints the mermaid body of
// the current graph, which is where the diagram in the doc comes from.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// The layers, top to bottom. An edge may point sideways or down, never up:
// this is the rule that stops `util` acquiring a dependency on `chooser` and
// src/ becoming a cat bag. A module under src/ that is in no layer fails.
const LAYERS = [
  {
    name: "entry",
    comment: "What the outside world calls: the CLI binary and the run entry point.",
    modules: ["bin", "main"],
  },
  {
    name: "stages",
    comment: "The phases of one run. A stage may use another stage and the whole vocabulary.",
    modules: ["spec", "cli", "investigate", "compile", "replay", "navigate", "prestep"],
  },
  {
    name: "vocabulary",
    comment: "The nouns every stage shares. These must not know which stage is running.",
    modules: ["input", "scraper", "declared", "browser", "chooser", "blocked", "heuristics", "template", "billing", "secrets", "util"],
  },
];

// Edges that point up a layer, are known, and are wrong. Same discipline as
// the cycles: declared with a reason, so a new one fails.
const KNOWN_UPWARD = [
  ["replay", "main", "replay/crawler.ts takes `RunSummary` as a type from the entry point. Type-only, so nothing points up at run time, but the type belongs below both."],
];

// The knots that exist today, are known, and are being unwound separately.
// Each is a set of modules that can all reach each other, declared whole
// rather than edge by edge: inside a knot the edges are not the problem, the
// knot is. A new knot fails, and so does a module joining one of these.
const KNOWN_CYCLES = [
  {
    modules: ["billing", "browser", "chooser", "input", "scraper", "secrets"],
    comment: "The vocabulary knot, tied by input/schema.ts: it declares the run's vocabulary and then reaches back out to use it. billing and chooser also share NavviError, which lives in billing/budget.ts.",
  },
  {
    modules: ["compile", "main", "replay"],
    comment: "replay/detail.ts and heal.ts recompile a field while compile/compile.ts borrows replay/entry.ts's scroll; replay/crawler.ts takes RunSummary as a type from main.ts, which is also the KNOWN_UPWARD edge.",
  },
];

// Directories under src/ that nothing in src/ or bin/ imports, on purpose.
// Each entry states why, the way tsconfig.actor.json states its exclusion.
const ORPHAN_ALLOWLIST = [
  ["investigate", "The discovery cascade, reached today only by scripts/live-investigate.ts. Phase E's U7a wires it into the compile path; the plan is claude-buddy specs/plans/2026-09-22-008-navvi-remaining-phases.md."],
];

const layerOf = new Map();
for (const [index, layer] of LAYERS.entries()) {
  for (const module of layer.modules) layerOf.set(module, index);
}
const ENTRY = new Set(LAYERS.find((layer) => layer.name === "entry").modules);

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.[^"']*)\1/g;
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

// A file belongs to the module named by its first segment under src/, except
// src/main.ts and bin/, which are the entry points and are their own nodes.
function moduleOf(path) {
  const rel = relative(root, path).split(sep);
  if (rel[0] === "bin") return "bin";
  if (rel[0] !== "src") return null;
  if (rel.length === 2) return rel[1].replace(/\.ts$/, "") === "main" ? "main" : null;
  return rel[1];
}

const files = [...walk(join(root, "src")), ...walk(join(root, "bin"))];
const modules = new Set();
for (const dir of readdirSync(join(root, "src"))) {
  if (statSync(join(root, "src", dir)).isDirectory()) modules.add(dir);
}
modules.add("main");
modules.add("bin");

/** @type {Map<string, Set<string>>} module -> modules it imports */
const edges = new Map([...modules].map((name) => [name, new Set()]));
for (const file of files) {
  const from = moduleOf(file);
  if (!from) continue;
  const text = stripComments(readFileSync(file, "utf8"));
  for (const match of text.matchAll(IMPORT)) {
    const to = moduleOf(resolve(dirname(file), match[2].replace(/\.js$/, ".ts")));
    if (to && to !== from) edges.get(from).add(to);
  }
}

const pairs = [];
for (const [from, targets] of edges) for (const to of targets) pairs.push(`${from} -> ${to}`);
pairs.sort();

if (process.argv.includes("--graph")) {
  const order = LAYERS.map((layer) => ({ ...layer, present: layer.modules.filter((m) => modules.has(m)) }));
  const lines = ["graph TD"];
  for (const layer of order) {
    if (!layer.present.length) continue;
    lines.push(`  subgraph ${layer.name}[" ${layer.name} "]`);
    for (const m of layer.present) lines.push(`    ${m}`);
    lines.push("  end");
  }
  const drawn = new Set();
  for (const line of pairs) {
    const [from, to] = line.split(" -> ");
    if (drawn.has(`${to} -> ${from}`)) {
      lines.push(`  ${to} <--> ${from}`);
      drawn.add(line);
      continue;
    }
    drawn.add(line);
  }
  const mutual = new Set(lines.filter((l) => l.includes("<-->")).flatMap((l) => {
    const [a, b] = l.trim().split(" <--> ");
    return [`${a} -> ${b}`, `${b} -> ${a}`];
  }));
  for (const line of pairs) {
    if (mutual.has(line)) continue;
    const [from, to] = line.split(" -> ");
    lines.push(`  ${from} --> ${to}`);
  }
  console.log(lines.join("\n"));
  process.exit(0);
}

let failed = false;
const fail = (message) => {
  console.error(`check-architecture: ${message}`);
  failed = true;
};

// 1. The diagram and the import graph are the same set of edges.
const docPath = join(root, "docs", "architecture.md");
const fence = /```mermaid\n([\s\S]*?)```/.exec(readFileSync(docPath, "utf8"));
if (!fence) {
  fail("docs/architecture.md: no ```mermaid fence");
  process.exit(1);
}
const ARROW = /\s(<-->|-->|-\.->)(?:\|[^|]*\|)?\s/;
const drawn = new Set();
for (const raw of fence[1].split("\n")) {
  const line = raw.trim();
  if (!line || line.startsWith("%%") || line.startsWith("subgraph") || line === "end" || line.startsWith("graph ")) continue;
  const arrow = ARROW.exec(line);
  if (!arrow) continue;
  const [left, right] = line.split(arrow[0]);
  const from = left.trim().split(/\s+/).pop();
  const to = right.trim().split(/\s+/)[0];
  if (/[[({]/.test(from) || /[[({]/.test(to)) {
    fail(`docs/architecture.md: edge line carries node shape syntax, declare nodes separately: ${line}`);
    continue;
  }
  drawn.add(`${from} -> ${to}`);
  if (arrow[1] === "<-->") drawn.add(`${to} -> ${from}`);
}

const real = new Set(pairs);
for (const edge of [...real].sort()) if (!drawn.has(edge)) fail(`architecture.md: undrawn edge  ${edge}`);
for (const edge of [...drawn].sort()) if (!real.has(edge)) fail(`architecture.md: drawn edge  ${edge}  no longer exists`);

// 2. No edge goes up a layer.
for (const module of modules) {
  if (!layerOf.has(module)) fail(`src/${module}: in no layer, add it to LAYERS in scripts/check-architecture.mjs`);
}
const upward = new Set(KNOWN_UPWARD.map(([from, to]) => `${from} -> ${to}`));
for (const edge of [...real].sort()) {
  const [from, to] = edge.split(" -> ");
  if (!layerOf.has(from) || !layerOf.has(to)) continue;
  if (layerOf.get(to) < layerOf.get(from) && !upward.has(edge)) {
    fail(`layers: ${edge}  points up, ${LAYERS[layerOf.get(from)].name} may not import ${LAYERS[layerOf.get(to)].name}`);
  }
}
for (const edge of upward) {
  if (!real.has(edge)) console.log(`check-architecture: upward edge ${edge} is gone, drop it from KNOWN_UPWARD`);
}

// 3. Cycles: the declared knots are known, a new or a grown one is not.
// Tarjan: a strongly connected component of more than one module is a knot.
const index = new Map();
const low = new Map();
const onStack = new Set();
const stack = [];
const components = [];
let counter = 0;
const connect = (node) => {
  index.set(node, counter);
  low.set(node, counter);
  counter += 1;
  stack.push(node);
  onStack.add(node);
  for (const next of edges.get(node) ?? []) {
    if (!index.has(next)) {
      connect(next);
      low.set(node, Math.min(low.get(node), low.get(next)));
    } else if (onStack.has(next)) {
      low.set(node, Math.min(low.get(node), index.get(next)));
    }
  }
  if (low.get(node) === index.get(node)) {
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    components.push(component);
  }
};
for (const node of modules) if (!index.has(node)) connect(node);
const knots = components.filter((component) => component.length > 1).map((component) => component.sort().join(", "));
const declaredKnots = KNOWN_CYCLES.map((knot) => [...knot.modules].sort().join(", "));
for (const knot of knots) {
  if (declaredKnots.includes(knot)) continue;
  const grown = declaredKnots.find((d) => d.split(", ").some((m) => knot.split(", ").includes(m)));
  const joined = grown ? knot.split(", ").filter((m) => !grown.split(", ").includes(m)) : [];
  fail(
    grown
      ? `cycles: the knot (${grown}) has taken in ${joined.join(", ")}, break the loop or widen it in KNOWN_CYCLES`
      : `cycles: new cycle among (${knot}), break it or declare it in KNOWN_CYCLES`,
  );
}
for (const knot of declaredKnots) {
  // Only a knot that is genuinely gone or smaller, not one already reported as grown.
  if (knots.includes(knot)) continue;
  if (knots.some((real) => real.split(", ").some((m) => knot.split(", ").includes(m)))) continue;
  console.log(`check-architecture: the knot (${knot}) is untied, drop it from KNOWN_CYCLES`);
}

// 4. No orphans.
const allowed = new Map(ORPHAN_ALLOWLIST);
const imported = new Set(pairs.map((edge) => edge.split(" -> ")[1]));
for (const module of [...modules].sort()) {
  if (ENTRY.has(module) || imported.has(module)) continue;
  if (allowed.has(module)) continue;
  fail(`orphans: src/${module}/ has no importer in src/ or bin/, wire it up or allowlist it with a reason`);
}
for (const [module] of ORPHAN_ALLOWLIST) {
  if (!modules.has(module)) console.log(`check-architecture: allowlisted orphan ${module} is gone, drop it from ORPHAN_ALLOWLIST`);
  else if (imported.has(module)) console.log(`check-architecture: allowlisted orphan ${module} now has importers, drop it from ORPHAN_ALLOWLIST`);
}

if (!failed) {
  const orphans = ORPHAN_ALLOWLIST.filter(([m]) => modules.has(m)).length;
  console.log(`check-architecture: ${modules.size} modules, ${real.size} edges, ${LAYERS.length} layers, ${knots.length} known knots, ${orphans} allowlisted orphan${orphans === 1 ? "" : "s"}; docs/architecture.md matches`);
}
process.exit(failed ? 1 : 0);
