const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { ensureGraphGitignore, graphDirectory } = require("./project");

function defaultDbPath() {
  return path.join(graphDirectory(process.cwd()), "requirements-graph.db");
}

function projectDbPath(projectPath) {
  return path.join(graphDirectory(projectPath), "requirements-graph.db");
}

function ensureParent(file) {
  const directory = path.dirname(path.resolve(file));
  fs.mkdirSync(directory, { recursive: true });
  ensureGraphGitignore(directory);
}

function ensureColumn(db, table, column, definition) {
  const columns = new Set(db.prepare("PRAGMA table_info(" + table + ")").all().map((row) => row.name));
  if (!columns.has(column)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + column + " " + definition);
}

class RequirementGraph {
  constructor(file = defaultDbPath()) {
    this.file = path.resolve(file);
    ensureParent(this.file);
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initialize();
  }

  initialize() {
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS documents (",
      "  id INTEGER PRIMARY KEY,",
      "  source_path TEXT NOT NULL UNIQUE,",
      "  format TEXT NOT NULL,",
      "  content TEXT NOT NULL,",
      "  checksum TEXT NOT NULL,",
      "  imported_at TEXT NOT NULL",
      ")",
      ";",
      "CREATE TABLE IF NOT EXISTS nodes (",
      "  id INTEGER PRIMARY KEY,",
      "  stable_id TEXT NOT NULL UNIQUE,",
      "  title TEXT NOT NULL,",
      "  kind TEXT NOT NULL DEFAULT 'requirement',",
      "  body TEXT NOT NULL DEFAULT '',",
      "  metadata_json TEXT NOT NULL DEFAULT '{}',",
      "  document_id INTEGER NOT NULL UNIQUE REFERENCES documents(id) ON DELETE CASCADE",
      ")",
      ";",
      "CREATE TABLE IF NOT EXISTS aliases (",
      "  alias TEXT PRIMARY KEY COLLATE NOCASE,",
      "  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE",
      ")",
      ";",
      "CREATE TABLE IF NOT EXISTS edges (",
      "  id INTEGER PRIMARY KEY,",
      "  from_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,",
      "  to_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,",
      "  relation_type TEXT NOT NULL,",
      "  source_path TEXT NOT NULL,",
      "  source_excerpt TEXT NOT NULL DEFAULT '',",
      "  confidence REAL NOT NULL DEFAULT 1,",
      "  review_status TEXT NOT NULL DEFAULT 'confirmed',",
      "  provenance TEXT NOT NULL DEFAULT 'declared',",
      "  UNIQUE(from_node_id, to_node_id, relation_type, source_path)",
      ")",
      ";",
      "CREATE TABLE IF NOT EXISTS pending_edges (",
      "  id INTEGER PRIMARY KEY,",
      "  from_node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,",
      "  target_alias TEXT NOT NULL,",
      "  relation_type TEXT NOT NULL,",
      "  source_path TEXT NOT NULL,",
      "  source_excerpt TEXT NOT NULL DEFAULT '',",
      "  confidence REAL NOT NULL DEFAULT 1,",
      "  review_status TEXT NOT NULL DEFAULT 'confirmed',",
      "  provenance TEXT NOT NULL DEFAULT 'declared'",
      ")",
      ";",
      "CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(",
      "  stable_id UNINDEXED, title, body, tokenize = 'unicode61'",
      ")",
      ";"
    ].join("\n"));
    ensureColumn(this.db, "edges", "provenance", "TEXT NOT NULL DEFAULT 'declared'");
    ensureColumn(this.db, "pending_edges", "provenance", "TEXT NOT NULL DEFAULT 'declared'");
  }

  upsertDocument({ sourcePath, format, content, checksum }) {
    const now = new Date().toISOString();
    this.db.prepare([
      "INSERT INTO documents (source_path, format, content, checksum, imported_at)",
      "VALUES (?, ?, ?, ?, ?)",
      "ON CONFLICT(source_path) DO UPDATE SET",
      "format = excluded.format, content = excluded.content, checksum = excluded.checksum, imported_at = excluded.imported_at",
      "RETURNING id"
    ].join(" ")).get(sourcePath, format, content, checksum, now).id;
    return this.db.prepare("SELECT id FROM documents WHERE source_path = ?").get(sourcePath).id;
  }

  upsertNode({ documentId, stableId, title, kind, body, metadata }) {
    const previous = this.db.prepare("SELECT id FROM nodes WHERE document_id = ?").get(documentId);
    const result = this.db.prepare([
      "INSERT INTO nodes (stable_id, title, kind, body, metadata_json, document_id)",
      "VALUES (?, ?, ?, ?, ?, ?)",
      "ON CONFLICT(stable_id) DO UPDATE SET",
      "title = excluded.title, kind = excluded.kind, body = excluded.body, metadata_json = excluded.metadata_json, document_id = excluded.document_id",
      "RETURNING id"
    ].join(" ")).get(stableId, title, kind, body, JSON.stringify(metadata || {}), documentId);
    const nodeId = result.id;
    if (previous && previous.id !== nodeId) {
      this.deleteNodeArtifacts(previous.id);
    }
    this.db.prepare("DELETE FROM aliases WHERE node_id = ?").run(nodeId);
    this.db.prepare("DELETE FROM edges WHERE from_node_id = ?").run(nodeId);
    this.db.prepare("DELETE FROM pending_edges WHERE from_node_id = ?").run(nodeId);
    this.db.prepare("DELETE FROM documents_fts WHERE stable_id = ?").run(stableId);
    this.db.prepare("INSERT INTO documents_fts (stable_id, title, body) VALUES (?, ?, ?)").run(stableId, title, body);
    return nodeId;
  }

  deleteNodeArtifacts(nodeId) {
    const node = this.db.prepare("SELECT stable_id FROM nodes WHERE id = ?").get(nodeId);
    if (node) this.db.prepare("DELETE FROM documents_fts WHERE stable_id = ?").run(node.stable_id);
    this.db.prepare("DELETE FROM aliases WHERE node_id = ?").run(nodeId);
    this.db.prepare("DELETE FROM edges WHERE from_node_id = ? OR to_node_id = ?").run(nodeId, nodeId);
    this.db.prepare("DELETE FROM pending_edges WHERE from_node_id = ?").run(nodeId);
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  }

  addAliases(nodeId, aliases) {
    const statement = this.db.prepare("INSERT OR REPLACE INTO aliases (alias, node_id) VALUES (?, ?)");
    for (const alias of new Set(aliases.filter(Boolean))) statement.run(alias, nodeId);
  }

  findNode(reference) {
    if (!reference) return null;
    return this.db.prepare([
      "SELECT n.*, d.source_path FROM aliases a",
      "JOIN nodes n ON n.id = a.node_id",
      "JOIN documents d ON d.id = n.document_id",
      "WHERE a.alias = ? COLLATE NOCASE",
      "LIMIT 1"
    ].join(" ")).get(reference.trim()) || null;
  }

  queueOrCreateEdge({
    fromNodeId, targetAlias, relationType, sourcePath, excerpt = "", confidence = 1,
    reviewStatus = "confirmed", provenance = "declared"
  }) {
    const target = this.findNode(targetAlias);
    if (target) {
      this.db.prepare([
        "INSERT OR IGNORE INTO edges",
        "(from_node_id, to_node_id, relation_type, source_path, source_excerpt, confidence, review_status, provenance)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ].join(" ")).run(fromNodeId, target.id, relationType, sourcePath, excerpt, confidence, reviewStatus, provenance);
      return "resolved";
    }
    this.db.prepare([
      "INSERT INTO pending_edges",
      "(from_node_id, target_alias, relation_type, source_path, source_excerpt, confidence, review_status, provenance)",
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ].join(" ")).run(fromNodeId, targetAlias, relationType, sourcePath, excerpt, confidence, reviewStatus, provenance);
    return "pending";
  }

  resolvePendingEdges() {
    const pending = this.db.prepare("SELECT * FROM pending_edges").all();
    let resolved = 0;
    for (const edge of pending) {
      const target = this.findNode(edge.target_alias);
      if (!target) continue;
      this.db.prepare([
        "INSERT OR IGNORE INTO edges",
        "(from_node_id, to_node_id, relation_type, source_path, source_excerpt, confidence, review_status, provenance)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ].join(" ")).run(
        edge.from_node_id, target.id, edge.relation_type, edge.source_path, edge.source_excerpt,
        edge.confidence, edge.review_status, edge.provenance || "declared"
      );
      this.db.prepare("DELETE FROM pending_edges WHERE id = ?").run(edge.id);
      resolved += 1;
    }
    return resolved;
  }

  transaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A failed BEGIN must not mask the validation or write error.
      }
      throw error;
    }
  }

  clear() {
    // documents_fts is not linked by a foreign key, so clear it explicitly
    // before deleting the graph's persisted source documents and nodes.
    this.db.exec([
      "DELETE FROM pending_edges;",
      "DELETE FROM edges;",
      "DELETE FROM aliases;",
      "DELETE FROM documents_fts;",
      "DELETE FROM nodes;",
      "DELETE FROM documents;"
    ].join("\n"));
  }

  clearGenerated() {
    // Generated requirement nodes are a replaceable layer. Keep imported
    // source documents so a later graph can still be traced to its evidence.
    this.db.exec([
      "DELETE FROM documents_fts WHERE stable_id IN (",
      "  SELECT n.stable_id FROM nodes n JOIN documents d ON d.id = n.document_id",
      "  WHERE d.format = 'codex-generated'",
      ");",
      "DELETE FROM documents WHERE format = 'codex-generated';"
    ].join("\n"));
  }

  sourceDocuments(offset = 0, limit = 20) {
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 20), 100));
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM documents WHERE format <> ?")
      .get("codex-generated").count;
    const documents = this.db.prepare([
      "SELECT d.id AS document_id, n.stable_id, n.title, n.kind, d.source_path, d.format,",
      "LENGTH(d.content) AS content_length",
      "FROM documents d LEFT JOIN nodes n ON n.document_id = d.id",
      "WHERE d.format <> ? ORDER BY d.source_path, n.stable_id LIMIT ? OFFSET ?"
    ].join(" ")).all("codex-generated", safeLimit, safeOffset);
    const nextOffset = safeOffset + documents.length;
    return {
      total,
      offset: safeOffset,
      limit: safeLimit,
      next_offset: nextOffset < total ? nextOffset : null,
      documents
    };
  }

  readSourceDocument(reference, offset = 0, limit = 16_000) {
    const key = String(reference || "").trim();
    if (!key) return null;
    const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeLimit = Math.max(1, Math.min(Math.floor(Number(limit) || 16_000), 50_000));
    const row = this.db.prepare([
      "SELECT d.id AS document_id, n.stable_id, n.title, n.kind, d.source_path, d.format, d.content",
      "FROM documents d LEFT JOIN nodes n ON n.document_id = d.id",
      "WHERE d.format <> ? AND (n.stable_id = ? COLLATE NOCASE OR d.source_path = ? COLLATE NOCASE)",
      "LIMIT 1"
    ].join(" ")).get("codex-generated", key, key);
    if (!row) return null;

    const content = String(row.content || "");
    const safeOffset = Math.min(content.length, requestedOffset);
    const end = Math.min(content.length, safeOffset + safeLimit);
    const { content: ignoredContent, ...document } = row;
    return {
      document: {
        ...document,
        content: content.slice(safeOffset, end),
        content_offset: safeOffset,
        content_length: content.length,
        next_offset: end < content.length ? end : null,
        truncated: end < content.length
      }
    };
  }

  search(query, limit = 10) {
    const cleaned = String(query || "").trim();
    if (!cleaned) return [];
    return this.db.prepare([
      "SELECT n.stable_id, n.title, n.kind, n.body, d.source_path",
      "FROM nodes n JOIN documents d ON d.id = n.document_id",
      "WHERE n.title LIKE ? OR n.body LIKE ? OR n.stable_id LIKE ?",
      "ORDER BY n.stable_id LIMIT ?"
    ].join(" ")).all("%" + cleaned + "%", "%" + cleaned + "%", "%" + cleaned + "%", Math.max(1, Math.min(Number(limit) || 10, 100)));
  }

  context(reference) {
    const node = this.findNode(reference);
    if (!node) return null;
    const outgoing = this.db.prepare([
      "SELECT e.relation_type, e.confidence, e.review_status, e.provenance, n.stable_id, n.title, n.kind",
      "FROM edges e JOIN nodes n ON n.id = e.to_node_id WHERE e.from_node_id = ?",
      "ORDER BY e.relation_type, n.stable_id"
    ].join(" ")).all(node.id);
    const incoming = this.db.prepare([
      "SELECT e.relation_type, e.confidence, e.review_status, e.provenance, n.stable_id, n.title, n.kind",
      "FROM edges e JOIN nodes n ON n.id = e.from_node_id WHERE e.to_node_id = ?",
      "ORDER BY e.relation_type, n.stable_id"
    ].join(" ")).all(node.id);
    const pending = this.db.prepare("SELECT target_alias, relation_type, source_excerpt FROM pending_edges WHERE from_node_id = ?").all(node.id);
    return {
      node: {
        stableId: node.stable_id, title: node.title, kind: node.kind, body: node.body,
        metadata: JSON.parse(node.metadata_json), sourcePath: node.source_path
      },
      outgoing, incoming, unresolved: pending
    };
  }

  traverse(reference, direction = "outgoing", depth = 2) {
    const start = this.findNode(reference);
    if (!start) return null;
    const maxDepth = Math.max(1, Math.min(Number(depth) || 2, 8));
    const visited = new Set([start.id]);
    let frontier = [{ id: start.id, stableId: start.stable_id, depth: 0 }];
    const links = [];
    for (let level = 1; level <= maxDepth && frontier.length; level += 1) {
      const next = [];
      for (const current of frontier) {
        const rows = direction === "incoming"
          ? this.db.prepare([
            "SELECT e.relation_type, n.id, n.stable_id, n.title, n.kind",
            "FROM edges e JOIN nodes n ON n.id = e.from_node_id WHERE e.to_node_id = ?"
          ].join(" ")).all(current.id)
          : this.db.prepare([
            "SELECT e.relation_type, n.id, n.stable_id, n.title, n.kind",
            "FROM edges e JOIN nodes n ON n.id = e.to_node_id WHERE e.from_node_id = ?"
          ].join(" ")).all(current.id);
        for (const row of rows) {
          links.push({ from: current.stableId, to: row.stable_id, relationType: row.relation_type, depth: level });
          if (!visited.has(row.id)) {
            visited.add(row.id);
            next.push({ id: row.id, stableId: row.stable_id, title: row.title, kind: row.kind, depth: level });
          }
        }
      }
      frontier = next;
    }
    return { start: start.stable_id, direction, depth: maxDepth, nodes: Array.from(visited).map((id) => {
      const row = this.db.prepare("SELECT stable_id, title, kind FROM nodes WHERE id = ?").get(id);
      return row;
    }), links };
  }

  unlinked() {
    return this.db.prepare([
      "SELECT n.stable_id, n.title, n.kind, d.source_path",
      "FROM nodes n JOIN documents d ON d.id = n.document_id",
      "WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.from_node_id = n.id OR e.to_node_id = n.id)",
      "ORDER BY n.stable_id"
    ].join(" ")).all();
  }

  documentSourcePaths() {
    return this.db.prepare("SELECT source_path FROM documents ORDER BY source_path").all().map((row) => row.source_path);
  }

  stats() {
    const count = (sql) => this.db.prepare(sql).get().count;
    return {
      database: this.file,
      documents: count("SELECT COUNT(*) AS count FROM documents"),
      nodes: count("SELECT COUNT(*) AS count FROM nodes"),
      edges: count("SELECT COUNT(*) AS count FROM edges"),
      unresolvedEdges: count("SELECT COUNT(*) AS count FROM pending_edges"),
      byKind: this.db.prepare("SELECT kind, COUNT(*) AS count FROM nodes GROUP BY kind ORDER BY kind").all()
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = { RequirementGraph, defaultDbPath, projectDbPath };
