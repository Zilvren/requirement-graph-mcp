const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { embedMarkdownImages } = require("./markdown-images");

const RELATION_FIELDS = {
  depends_on: "DEPENDS_ON",
  blocked_by: "BLOCKED_BY",
  related_to: "RELATED_TO",
  implements: "IMPLEMENTS",
  validates: "VALIDATES",
  parent: "CHILD_OF",
  derives_from: "DERIVES_FROM"
};

const SUPPORTED = new Set([".md", ".markdown", ".txt", ".json", ".csv"]);
const IGNORE_DIRECTORIES = new Set([".git", "node_modules", ".requirement-graph"]);

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function toArray(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (value === undefined || value === null || value === "") return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function unquote(value) {
  const trimmed = String(value).trim();
  return trimmed.replace(/^(['"])([\s\S]*)\1$/, "$2");
}

function splitList(value) {
  const items = [];
  let current = "";
  let quote = null;
  for (const character of String(value)) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === ",") {
      items.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  items.push(current.trim());
  return items.filter(Boolean).map(unquote);
}

function parseScalar(value) {
  const raw = String(value || "").trim();
  if (raw.startsWith("[") && raw.endsWith("]")) return splitList(raw.slice(1, -1));
  return unquote(raw);
}

// The importer reads the YAML subset that Markdown Frontmatter normally needs:
// scalar values, inline [a, b] lists, quoted values, and "- item" block lists.
// More exotic YAML (nested maps, anchors, multi-line scalars) is not supported.
function parseFrontmatter(content) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { metadata: {}, body: content };
  const metadata = {};
  let lastKey = null;
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (entry) {
      lastKey = entry[1].toLowerCase();
      const value = entry[2].trim();
      metadata[lastKey] = value === "" ? [] : parseScalar(value);
      continue;
    }
    const item = line.match(/^-\s+(.+)$/);
    if (item && lastKey) {
      const list = Array.isArray(metadata[lastKey]) ? metadata[lastKey] : [];
      list.push(unquote(item[1]));
      metadata[lastKey] = list;
    }
  }
  return { metadata, body: content.slice(match[0].length) };
}

function firstHeading(body) {
  const match = body.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : "";
}

function slugFromPath(sourcePath) {
  return path.basename(sourcePath, path.extname(sourcePath)).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "document";
}

const LABELLED_RELATIONS = new Map([
  ["父需求", "CHILD_OF"],
  ["父级需求", "CHILD_OF"],
  ["上级需求", "CHILD_OF"],
  ["依赖", "DEPENDS_ON"],
  ["依赖于", "DEPENDS_ON"],
  ["前置", "DEPENDS_ON"],
  ["前置依赖", "DEPENDS_ON"],
  ["阻塞于", "BLOCKED_BY"],
  ["关联", "RELATED_TO"],
  ["关联需求", "RELATED_TO"],
  ["验证", "VALIDATED_BY"],
  ["验收", "VALIDATED_BY"],
  ["支撑", "SUPPORTS"],
  ["实现", "IMPLEMENTS"]
]);

const LABELLED_RELATION_RE = /^\s*(?:[-*+]\s+)?(?<label>父(?:级)?需求|上级需求|依赖(?:于)?|前置(?:依赖)?|阻塞于|关联(?:需求)?|验证|验收|支撑|实现)\s*[：:]\s*(?<value>.+?)\s*$/u;

function markdownLinkTargets(value, sourcePath) {
  const targets = [];
  const add = (target, excerpt) => {
    const cleaned = String(target || "").trim();
    if (!cleaned || targets.some((item) => item.target === cleaned)) return;
    targets.push({ target: cleaned, excerpt });
  };

  for (const match of String(value).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
    add(match[1], match[0]);
  }
  for (const match of String(value).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const href = match[1].trim().replace(/^<|>$/g, "");
    if (!/\.(?:md|markdown)(?:#.*)?$/i.test(href) || /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(href)) continue;
    const relative = href.split("#")[0].trim();
    if (relative) add(path.resolve(path.dirname(sourcePath), relative), match[0]);
  }
  return targets;
}

function semanticMarkdownRelations(body, sourcePath) {
  const relations = [];
  const consumedLines = new Set();
  String(body).split(/\r?\n/).forEach((line, index) => {
    const match = line.match(LABELLED_RELATION_RE);
    if (!match || !match.groups) return;
    const relationType = LABELLED_RELATIONS.get(match.groups.label);
    const targets = markdownLinkTargets(match.groups.value, sourcePath);
    if (!relationType || !targets.length) return;
    consumedLines.add(index);
    for (const target of targets) {
      relations.push({
        target: target.target,
        relationType,
        excerpt: line.trim(),
        confidence: 0.9,
        reviewStatus: "proposed",
        provenance: "labeled_markdown"
      });
    }
  });
  return { relations, consumedLines };
}

function markdownLinks(body, sourcePath, consumedLines = new Set()) {
  const links = [];
  String(body).split(/\r?\n/).forEach((line, index) => {
    if (consumedLines.has(index)) return;
    for (const target of markdownLinkTargets(line, sourcePath)) {
      links.push({
        target: target.target,
        relationType: "REFERENCES",
        excerpt: target.excerpt,
        confidence: 0.35,
        reviewStatus: "observed",
        provenance: "citation"
      });
    }
  });
  return links;
}

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (character === '"') {
      if (quoted && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && content[index + 1] === "\n") index += 1;
      row.push(cell);
      if (row.some((item) => item !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  row.push(cell);
  if (row.some((item) => item !== "")) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((item) => item.trim().toLowerCase());
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, (values[index] || "").trim()])));
}

function standardRecord({ sourcePath, format, content, body: suppliedBody, metadata = {}, title, kind, stableId }) {
  const sourceBody = String(suppliedBody === undefined ? content : suppliedBody).trim();
  // Keep the source document unchanged, but make supported local Markdown
  // images portable in the graph's reader body. This lets the loopback web UI
  // render them without exposing project files as a web-server asset route.
  const body = format === "markdown" ? embedMarkdownImages(sourceBody, sourcePath) : sourceBody;
  const id = stableId || String(metadata.id || metadata.key || "").trim() || slugFromPath(sourcePath);
  const relations = [];
  for (const [field, relationType] of Object.entries(RELATION_FIELDS)) {
    for (const target of toArray(metadata[field])) {
      relations.push({ target, relationType, excerpt: field + ": " + target, provenance: "frontmatter" });
    }
  }
  if (format === "markdown") {
    const semantic = semanticMarkdownRelations(sourceBody, sourcePath);
    relations.push(...semantic.relations, ...markdownLinks(sourceBody, sourcePath, semantic.consumedLines));
  }
  return {
    sourcePath, format, content, stableId: id, title: title || String(metadata.title || "").trim() || firstHeading(body) || id,
    kind: kind || String(metadata.kind || metadata.type || "requirement").trim() || "requirement",
    body, metadata, relations
  };
}

function parseFile(file) {
  const extension = path.extname(file).toLowerCase();
  const content = fs.readFileSync(file, "utf8");
  if (extension === ".md" || extension === ".markdown") {
    const parsed = parseFrontmatter(content);
    return [standardRecord({
      sourcePath: path.resolve(file), format: "markdown", content, body: parsed.body,
      metadata: parsed.metadata, title: parsed.metadata.title, kind: parsed.metadata.kind
    })];
  }
  if (extension === ".txt") return [standardRecord({ sourcePath: path.resolve(file), format: "text", content })];
  if (extension === ".csv") {
    return parseCsv(content).map((item, index) => {
      const stableId = item.id || item.key || slugFromPath(file) + "-" + (index + 1);
      const body = item.body || item.description || item.text || "";
      return standardRecord({
        sourcePath: path.resolve(file) + "#record-" + (index + 1), format: "csv", content: JSON.stringify(item),
        body, metadata: item, title: item.title || item.name || stableId, kind: item.kind || item.type, stableId,
      });
    });
  }
  if (extension === ".json") {
    const parsed = JSON.parse(content);
    const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed.items) ? parsed.items : [parsed];
    return records.map((item, index) => {
      const safe = item && typeof item === "object" ? item : { body: String(item) };
      const stableId = safe.id || safe.key || slugFromPath(file) + "-" + (index + 1);
      const body = safe.body || safe.description || safe.text || JSON.stringify(safe);
      return standardRecord({
        sourcePath: path.resolve(file) + "#record-" + (index + 1), format: "json", content: JSON.stringify(safe),
        body, metadata: safe, title: safe.title || safe.name || stableId, kind: safe.kind || safe.type, stableId
      });
    });
  }
  return [];
}

function collectFiles(input) {
  const absolute = path.resolve(input);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return SUPPORTED.has(path.extname(absolute).toLowerCase()) ? [absolute] : [];
  const files = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && !IGNORE_DIRECTORIES.has(entry.name)) files.push(...collectFiles(path.join(absolute, entry.name)));
    if (entry.isFile() && SUPPORTED.has(path.extname(entry.name).toLowerCase())) files.push(path.join(absolute, entry.name));
  }
  return files;
}

function importFiles(graph, files) {
  let imported = 0;
  let relations = 0;
  for (const file of files) {
    for (const record of parseFile(file)) {
      const documentId = graph.upsertDocument({
        sourcePath: record.sourcePath, format: record.format, content: record.content, checksum: hash(record.content)
      });
      const nodeId = graph.upsertNode({
        documentId, stableId: record.stableId, title: record.title, kind: record.kind, body: record.body, metadata: record.metadata
      });
      graph.addAliases(nodeId, [
        record.stableId, record.title, slugFromPath(record.sourcePath),
        record.sourcePath, path.relative(process.cwd(), record.sourcePath)
      ]);
      for (const relation of record.relations) {
        graph.queueOrCreateEdge({
          fromNodeId: nodeId, targetAlias: relation.target, relationType: relation.relationType,
          sourcePath: record.sourcePath, excerpt: relation.excerpt,
          confidence: relation.confidence, reviewStatus: relation.reviewStatus, provenance: relation.provenance
        });
        relations += 1;
      }
      imported += 1;
    }
  }
  const resolvedPending = graph.resolvePendingEdges();
  return { imported, files: files.length, declaredRelations: relations, resolvedPending, stats: graph.stats() };
}

function importPath(graph, input) {
  const files = collectFiles(input);
  // A single transaction keeps an import atomic: if one record fails, nothing
  // is left half-imported, and the whole directory imports in one write batch.
  return graph.transaction(() => importFiles(graph, files));
}

function sourceFileFromDocumentPath(sourcePath) {
  return String(sourcePath || "").replace(/#record-\d+$/, "");
}

function syncImportedDocuments(graph) {
  const sourceFiles = Array.from(new Set(graph.documentSourcePaths()
    .map(sourceFileFromDocumentPath)
    .filter((file) => fs.existsSync(file) && SUPPORTED.has(path.extname(file).toLowerCase()))));
  const seen = new Set();
  const files = [];
  for (const sourceFile of sourceFiles) {
    for (const candidate of collectFiles(sourceFile)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        files.push(candidate);
      }
    }
  }
  const result = graph.transaction(() => importFiles(graph, files));
  return {
    syncedFiles: sourceFiles.length,
    imported: result.imported,
    declaredRelations: result.declaredRelations,
    resolvedPending: result.resolvedPending,
    stats: result.stats
  };
}

module.exports = {
  RELATION_FIELDS,
  collectFiles,
  importPath,
  parseFile,
  semanticMarkdownRelations,
  syncImportedDocuments
};
