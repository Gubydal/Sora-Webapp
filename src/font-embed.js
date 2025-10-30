import fs from "fs/promises";
import path from "path";

const FONT_FAMILY = "Outfit";
const FONT_DIR = path.resolve("assets/fonts");

const EXTENSION_META = new Map([
  [".woff2", { mime: "font/woff2", format: "woff2", priority: 4 }],
  [".woff", { mime: "font/woff", format: "woff", priority: 3 }],
  [".ttf", { mime: "font/ttf", format: "truetype", priority: 2 }],
  [".otf", { mime: "font/otf", format: "opentype", priority: 2 }]
]);

let cachedCss;
let cachedMeta;
let cachedCollection;

function inferWeightFromName(name) {
  const lower = name.toLowerCase();
  if (lower.includes("thin")) return "100";
  if (lower.includes("extralight") || lower.includes("ultralight")) return "200";
  if (lower.includes("light")) return "300";
  if (lower.includes("regular") || lower.includes("book") || lower.includes("normal")) return "400";
  if (lower.includes("medium")) return "500";
  if (lower.includes("semibold") || lower.includes("demibold")) return "600";
  if (lower.includes("extrabold") || lower.includes("heavy")) return "800";
  if (lower.includes("black")) return "900";
  if (lower.includes("bold")) return "700";
  return "400";
}

function isVariableFontName(name) {
  const lower = name.toLowerCase();
  return lower.includes("variable") || lower.includes("vf");
}

function numericWeight(weight) {
  const value = Number(weight);
  return Number.isFinite(value) ? value : 400;
}

function selectNearestFace(targetWeight, faceMap) {
  if (!faceMap.size) return null;
  if (faceMap.has(targetWeight)) {
    return faceMap.get(targetWeight);
  }

  const target = numericWeight(targetWeight);
  let bestKey = null;
  let bestDiff = Infinity;

  for (const key of faceMap.keys()) {
    const diff = Math.abs(numericWeight(key) - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestKey = key;
    } else if (diff === bestDiff && bestKey !== null) {
      const keyValue = numericWeight(key);
      const bestValue = numericWeight(bestKey);
      if (keyValue > bestValue) {
        bestKey = key;
      }
    }
  }

  return bestKey ? faceMap.get(bestKey) : null;
}

async function loadFontCollection() {
  if (cachedCollection) return cachedCollection;

  let entries;
  try {
    entries = await fs.readdir(FONT_DIR);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`Font directory not found at ${FONT_DIR}`);
    }
    throw err;
  }

  const faces = [];
  for (const name of entries) {
    const ext = path.extname(name).toLowerCase();
    const meta = EXTENSION_META.get(ext);
    if (!meta) continue;

    const filePath = path.join(FONT_DIR, name);
    const fileBuffer = await fs.readFile(filePath);
    const variable = isVariableFontName(name);

    faces.push({
      name,
      base64: fileBuffer.toString("base64"),
      format: variable && meta.format === "truetype" ? "truetype-variations" : meta.format,
      mime: meta.mime,
      priority: meta.priority,
      isVariable: variable,
      weight: inferWeightFromName(name)
    });
  }

  if (!faces.length) {
    throw new Error("No font files found in assets/fonts");
  }

  const variableFace =
    faces
      .filter((face) => face.isVariable)
      .sort((a, b) => b.priority - a.priority)[0] ?? null;

  const weightedFaces = new Map();
  faces
    .filter((face) => !face.isVariable)
    .forEach((face) => {
      const existing = weightedFaces.get(face.weight);
      if (!existing || face.priority > existing.priority) {
        weightedFaces.set(face.weight, face);
      }
    });

  const availableWeights = Array.from(weightedFaces.keys()).sort(
    (a, b) => numericWeight(a) - numericWeight(b)
  );

  cachedCollection = { variableFace, weightedFaces, availableWeights };
  return cachedCollection;
}

export async function fontMeta() {
  if (cachedMeta) return cachedMeta;
  const collection = await loadFontCollection();
  const weightSet = new Set(collection.availableWeights);

  if (collection.variableFace) {
    ["400", "600", "700", "800", "900"].forEach((weight) => weightSet.add(weight));
  }

  const weights = Array.from(weightSet).sort(
    (a, b) => numericWeight(a) - numericWeight(b)
  );

  if (!weights.length) {
    weights.push("400");
  }

  const weightPreference = ["700", "800", "900", "600", "500", "400"];
  const headlineWeight =
    weightPreference.find((weight) => weights.includes(weight)) ??
    weights[weights.length - 1];
  const bodyWeight = weights.includes(headlineWeight)
    ? headlineWeight
    : weights[0];

  cachedMeta = {
    family: FONT_FAMILY,
    weights,
    headlineWeight,
    bodyWeight,
    isVariable: Boolean(collection.variableFace)
  };

  return cachedMeta;
}

export async function fontCSS() {
  if (cachedCss) return cachedCss;

  const collection = await loadFontCollection();
  const meta = await fontMeta();

  const declarations = [];

  if (collection.variableFace) {
    const variableFace = collection.variableFace;
    declarations.push(`
    @font-face {
      font-family: '${FONT_FAMILY}';
      font-style: normal;
      font-weight: 100 900;
      font-display: swap;
      src: url("data:${variableFace.mime};base64,${variableFace.base64}") format('${variableFace.format}');
    }`);

    const discreteWeights = new Set([...meta.weights, "400", "600", "700", "800", "900"]);
    discreteWeights.forEach((weight) => {
      const fallbackFace = selectNearestFace(weight, collection.weightedFaces);
      const weightFace = fallbackFace ?? variableFace;
      declarations.push(`
    @font-face {
      font-family: '${FONT_FAMILY}';
      font-style: normal;
      font-weight: ${weight};
      font-display: swap;
      src: url("data:${weightFace.mime};base64,${weightFace.base64}") format('${weightFace.format}');
    }`);
    });
  } else {
    const weightsToInclude = new Set([
      ...collection.availableWeights,
      ...meta.weights
    ]);
    const orderedWeights = Array.from(weightsToInclude).sort(
      (a, b) => numericWeight(a) - numericWeight(b)
    );

    orderedWeights.forEach((weight) => {
      const face = selectNearestFace(weight, collection.weightedFaces);
      if (!face) return;
      declarations.push(`
    @font-face {
      font-family: '${FONT_FAMILY}';
      font-style: normal;
      font-weight: ${weight};
      font-display: swap;
      src: url("data:${face.mime};base64,${face.base64}") format('${face.format}');
    }`);
    });
  }

  const headlineVariation =
    meta.isVariable ? ` font-variation-settings: 'wght' ${meta.headlineWeight};` : "";
  const bodyVariation =
    meta.isVariable ? ` font-variation-settings: 'wght' ${meta.bodyWeight};` : "";

  cachedCss = `${declarations.join("\n")}
    .hl {
      font-family: '${FONT_FAMILY}';
      font-weight: ${meta.headlineWeight};
      fill: #F5EF77;
      font-synthesis: none;
      ${headlineVariation}
    }
    .body {
      font-family: '${FONT_FAMILY}';
      font-weight: ${meta.bodyWeight};
      fill: #F5EF77;
      font-synthesis: none;
      ${bodyVariation}
    }
  `;

  return cachedCss;
}
