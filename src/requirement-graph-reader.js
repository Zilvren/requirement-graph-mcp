const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { projectDbPath } = require("./db");

const DEFAULT_MAX_NODES = 500;
const DEFAULT_MAX_EDGES = 1500;

function boundedNumber(value, fallback, ceiling) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(Math.floor(number), ceiling));
}

function limits(options = {}) {
  return {
    maxNodes: boundedNumber(options.maxNodes, DEFAULT_MAX_NODES, 2000),
    maxEdges: boundedNumber(options.maxEdges, DEFAULT_MAX_EDGES, 6000)
  };
}

function relationshipScope(options = {}) {
  return options.relationshipScope === "all" ? "all" : "structural";
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sourceState(data = {}) {
  return { source: "requirements", available: false, nodes: [], edges: [], warnings: [], ...data };
}

function databaseExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableColumns(db, table) {
  return new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name));
}

function countRows(db, table) {
  return db.prepare("SELECT COUNT(*) AS count FROM " + table).get().count;
}

function withSnapshot(db, work) {
  db.exec("BEGIN");
  try {
    const value = work();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed read-only query may already have ended its transaction.
    }
    throw error;
  }
}

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    // Closing a failed read-only snapshot must not hide the useful error.
  }
}

function readRequirementGraph(projectRoot, options = {}) {
  const database = projectDbPath(projectRoot);
  if (!databaseExists(database)) {
    return sourceState({
      database,
      reason: "No Requirement Graph database exists in this project yet."
    });
  }

  let db;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    if (!hasTable(db, "nodes") || !hasTable(db, "edges") || !hasTable(db, "documents")) {
      return sourceState({
        database,
        reason: "The Requirement Graph database does not have the expected graph tables."
      });
    }
    return withSnapshot(db, () => {
      const max = limits(options);
      const edgeColumns = tableColumns(db, "edges");
      const nodeColumns = tableColumns(db, "nodes");
      const nodeBody = nodeColumns.has("body") ? "n.body" : "''";
      const scope = relationshipScope(options);
      const includeReferences = scope === "all";
      const totalNodes = countRows(db, "nodes");
      const totalEdges = countRows(db, "edges");
      const structuralEdges = db.prepare(
        "SELECT COUNT(*) AS count FROM edges WHERE relation_type <> 'REFERENCES'"
      ).get().count;
      const rows = db.prepare([
        "SELECT n.id, n.stable_id, n.title, n.kind, n.metadata_json, " + nodeBody + " AS body, d.source_path",
        "FROM nodes n JOIN documents d ON d.id = n.document_id",
        "ORDER BY n.stable_id LIMIT ?"
      ].join(" ")).all(max.maxNodes);
      const edgeRows = db.prepare([
        "WITH visible AS (SELECT id FROM nodes ORDER BY stable_id LIMIT ?)",
        "SELECT from_node.stable_id AS source_stable_id, to_node.stable_id AS target_stable_id,",
        "e.relation_type, e.confidence, e.review_status, " + (edgeColumns.has("provenance") ? "e.provenance" : "'legacy' AS provenance"),
        "FROM edges e",
        "JOIN visible source_visible ON source_visible.id = e.from_node_id",
        "JOIN visible target_visible ON target_visible.id = e.to_node_id",
        "JOIN nodes from_node ON from_node.id = e.from_node_id",
        "JOIN nodes to_node ON to_node.id = e.to_node_id",
        includeReferences ? "" : "WHERE e.relation_type <> 'REFERENCES'",
        "ORDER BY e.id LIMIT ?"
      ].join(" ")).all(max.maxNodes, max.maxEdges);
      const displayedTotalEdges = includeReferences ? totalEdges : structuralEdges;
      const hiddenReferenceEdges = totalEdges - displayedTotalEdges;
      const referenceEdges = totalEdges - structuralEdges;
      const warnings = [];
      if (includeReferences && referenceEdges) {
        warnings.push(referenceEdges + " 条文档引用以虚线显示；它们是引用，不等同于已确认的需求依赖。");
      } else if (!includeReferences && hiddenReferenceEdges) {
        warnings.push(hiddenReferenceEdges + " 条文档引用已隐藏。可点击“显示文档引用”，或重新识别文档中的父需求、依赖、验证等明确标签。");
      }

      return sourceState({
        available: true,
        database,
        mode: "documents",
        totalNodes,
        totalEdges,
        hiddenReferenceEdges,
        truncated: totalNodes > rows.length || displayedTotalEdges > edgeRows.length,
        warnings,
        nodes: rows.map((row) => ({
          id: "rg:" + row.stable_id,
          source: "requirements",
          kind: row.kind,
          label: row.title || row.stable_id,
          title: row.title || row.stable_id,
          sourcePath: row.source_path,
          body: row.body || "",
          metadata: safeJson(row.metadata_json)
        })),
        edges: edgeRows.map((row) => ({
          id: ["rg", row.source_stable_id, row.target_stable_id, row.relation_type].join(":"),
          source: "rg:" + row.source_stable_id,
          target: "rg:" + row.target_stable_id,
          sourceKind: "requirements",
          relationType: row.relation_type,
          confidence: row.confidence,
          reviewStatus: row.review_status,
          provenance: row.provenance || "declared",
          isWeak: row.relation_type === "REFERENCES",
          isProposed: row.review_status === "proposed",
          weight: 1
        }))
      });
    });
  } catch (error) {
    return sourceState({
      database,
      reason: error.message,
      warnings: ["Requirement Graph could not be read: " + error.message]
    });
  } finally {
    if (db) closeQuietly(db);
  }
}

module.exports = { readRequirementGraph };
