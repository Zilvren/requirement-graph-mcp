const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { escapeLike, projectDbPath } = require("./db");

const DEFAULT_DOCUMENT_LIMIT = 200;
const MAX_DOCUMENT_LIMIT = 500;
const DEFAULT_CONTENT_LIMIT = 50_000;
const MAX_CONTENT_LIMIT = 50_000;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(Math.floor(number), maximum));
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

function closeQuietly(db) {
  try {
    db.close();
  } catch {
    // Closing a failed read-only query must not hide the useful error.
  }
}

function withDocumentDatabase(projectRoot, work) {
  const database = projectDbPath(projectRoot);
  if (!databaseExists(database)) {
    return { available: false, database, reason: "No Requirement Graph database exists in this project yet." };
  }
  let db;
  try {
    db = new DatabaseSync(database, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    if (!hasTable(db, "documents") || !hasTable(db, "nodes")) {
      return { available: false, database, reason: "The Requirement Graph database does not have the expected document tables." };
    }
    return work(db, database);
  } catch (error) {
    return { available: false, database, reason: error.message };
  } finally {
    if (db) closeQuietly(db);
  }
}

function documentSummary(row) {
  return {
    documentId: row.document_id,
    stableId: row.stable_id || null,
    title: row.title || row.source_path,
    kind: row.kind || "document",
    sourcePath: row.source_path,
    format: row.format,
    contentLength: Number(row.content_length) || 0,
    importedAt: row.imported_at || null
  };
}

function listRequirementDocuments(projectRoot, options = {}) {
  const query = String(options.query || "").trim();
  const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(options.limit, DEFAULT_DOCUMENT_LIMIT, 1, MAX_DOCUMENT_LIMIT);
  return withDocumentDatabase(projectRoot, (db, database) => {
    const documentColumns = tableColumns(db, "documents");
    const importedAt = documentColumns.has("imported_at") ? "d.imported_at" : "NULL AS imported_at";
    const where = ["d.format <> ?"];
    const parameters = ["codex-generated"];
    if (query) {
      where.push("(n.stable_id LIKE ? ESCAPE '\\' OR n.title LIKE ? ESCAPE '\\' OR d.source_path LIKE ? ESCAPE '\\')");
      const pattern = "%" + escapeLike(query) + "%";
      parameters.push(pattern, pattern, pattern);
    }
    const whereClause = where.join(" AND ");
    const total = db.prepare([
      "SELECT COUNT(*) AS count FROM documents d",
      "LEFT JOIN nodes n ON n.document_id = d.id",
      "WHERE " + whereClause
    ].join(" ")).get(...parameters).count;
    const rows = db.prepare([
      "SELECT d.id AS document_id, n.stable_id, n.title, n.kind, d.source_path, d.format,",
      "LENGTH(d.content) AS content_length, " + importedAt,
      "FROM documents d LEFT JOIN nodes n ON n.document_id = d.id",
      "WHERE " + whereClause,
      "ORDER BY d.source_path, n.stable_id LIMIT ? OFFSET ?"
    ].join(" ")).all(...parameters, limit, offset);
    const documents = rows.map(documentSummary);
    const nextOffset = offset + documents.length;
    return {
      available: true,
      database,
      total,
      offset,
      limit,
      nextOffset: nextOffset < total ? nextOffset : null,
      documents
    };
  });
}

function readRequirementDocument(projectRoot, reference, options = {}) {
  const requested = String(reference || "").trim().replace(/^rg:/i, "");
  if (!requested) return null;
  const offset = boundedInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = boundedInteger(options.limit, DEFAULT_CONTENT_LIMIT, 1, MAX_CONTENT_LIMIT);
  return withDocumentDatabase(projectRoot, (db, database) => {
    const documentColumns = tableColumns(db, "documents");
    const importedAt = documentColumns.has("imported_at") ? "d.imported_at" : "NULL AS imported_at";
    const numericDocumentId = /^\d+$/.test(requested) ? Number(requested) : null;
    const lookup = numericDocumentId !== null
      ? { clause: "d.id = ?", value: numericDocumentId }
      : { clause: "n.stable_id = ? COLLATE NOCASE", value: requested };
    const row = db.prepare([
      "SELECT d.id AS document_id, n.stable_id, n.title, n.kind, d.source_path, d.format, " + importedAt + ", d.content",
      "FROM documents d LEFT JOIN nodes n ON n.document_id = d.id",
      "WHERE d.format <> ? AND " + lookup.clause,
      "LIMIT 1"
    ].join(" ")).get("codex-generated", lookup.value);
    if (!row) return null;
    const content = String(row.content || "");
    const contentOffset = Math.min(content.length, offset);
    const end = Math.min(content.length, contentOffset + limit);
    return {
      available: true,
      database,
      document: {
        ...documentSummary(row),
        content: content.slice(contentOffset, end),
        contentOffset,
        contentLength: content.length,
        nextOffset: end < content.length ? end : null,
        truncated: end < content.length
      }
    };
  });
}

module.exports = { listRequirementDocuments, readRequirementDocument };
