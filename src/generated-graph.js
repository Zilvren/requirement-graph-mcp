const crypto = require("node:crypto");

const RELATION_TYPES = new Set([
  "DEPENDS_ON",
  "BLOCKED_BY",
  "RELATED_TO",
  "IMPLEMENTS",
  "VALIDATES",
  "VALIDATED_BY",
  "SUPPORTS",
  "CHILD_OF",
  "DERIVES_FROM"
]);
const REVIEW_STATUSES = new Set(["proposed", "confirmed"]);

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value, field) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) throw new Error(field + " is required.");
  return text;
}

function graphIdFor(value, description) {
  const supplied = String(value || "").trim();
  return supplied || "codex-" + hash(description).slice(0, 16);
}

function normalizeStructuredGraph(payload) {
  if (!isPlainObject(payload)) throw new Error("The generated graph payload must be an object.");

  const sourceDescription = requiredText(payload.source_description, "source_description");
  const graphId = graphIdFor(payload.graph_id, sourceDescription);
  if (graphId.length > 128) throw new Error("graph_id must be at most 128 characters.");

  if (!Array.isArray(payload.nodes)) throw new Error("nodes must be an array.");
  if (payload.nodes.length < 1) {
    throw new Error("A generated requirement graph must contain at least one evidence-backed node.");
  }
  if (payload.nodes.length > 500) throw new Error("A generated graph can contain at most 500 nodes.");

  const nodeIds = new Set();
  const nodes = payload.nodes.map((raw, index) => {
    if (!isPlainObject(raw)) throw new Error("nodes[" + index + "] must be an object.");
    const id = requiredText(raw.id, "nodes[" + index + "].id");
    if (id.length > 128) throw new Error("nodes[" + index + "].id must be at most 128 characters.");
    if (nodeIds.has(id)) throw new Error("Duplicate generated node id: " + id);
    nodeIds.add(id);

    const title = requiredText(raw.title, "nodes[" + index + "].title");
    const kind = raw.kind === undefined ? "requirement" : requiredText(raw.kind, "nodes[" + index + "].kind");
    const body = raw.body === undefined || raw.body === null ? "" : String(raw.body).trim();
    const metadata = raw.metadata === undefined ? {} : raw.metadata;
    if (!isPlainObject(metadata)) throw new Error("nodes[" + index + "].metadata must be an object.");
    if (raw.source_document_ids !== undefined && !Array.isArray(raw.source_document_ids)) {
      throw new Error("nodes[" + index + "].source_document_ids must be an array.");
    }
    const sourceDocumentIds = Array.from(new Set((raw.source_document_ids || []).map((reference, referenceIndex) =>
      requiredText(reference, "nodes[" + index + "].source_document_ids[" + referenceIndex + "]")
    )));

    return { id, title, kind, body, metadata, sourceDocumentIds };
  });

  if (!Array.isArray(payload.edges)) {
    throw new Error("edges must be an array.");
  }
  if (!payload.edges.length && !nodes.every((node) => node.sourceDocumentIds.length)) {
    throw new Error("A generated requirement graph must include an edge or link every node to an imported source document.");
  }
  if (payload.edges.length > 2_000) throw new Error("A generated graph can contain at most 2000 edges.");

  const connectedNodeIds = new Set(nodes.filter((node) => node.sourceDocumentIds.length).map((node) => node.id));
  const edgeKeys = new Set();
  const edges = payload.edges.map((raw, index) => {
    if (!isPlainObject(raw)) throw new Error("edges[" + index + "] must be an object.");
    const from = requiredText(raw.from, "edges[" + index + "].from");
    const to = requiredText(raw.to, "edges[" + index + "].to");
    if (!nodeIds.has(from) || !nodeIds.has(to)) {
      throw new Error("edges[" + index + "] must connect two generated node ids.");
    }
    if (from === to) throw new Error("edges[" + index + "] cannot be a self relationship.");

    const relationType = requiredText(raw.relation_type, "edges[" + index + "].relation_type").toUpperCase();
    if (!RELATION_TYPES.has(relationType)) {
      throw new Error("Unsupported generated relation_type: " + relationType);
    }

    const edgeKey = [from, to, relationType].join("\u0000");
    if (edgeKeys.has(edgeKey)) throw new Error("Duplicate generated edge: " + from + " -> " + to + " (" + relationType + ").");
    edgeKeys.add(edgeKey);

    const confidence = raw.confidence === undefined ? 0.7 : Number(raw.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("edges[" + index + "].confidence must be between 0 and 1.");
    }

    const reviewStatus = raw.review_status === undefined
      ? "proposed"
      : String(raw.review_status).trim().toLowerCase();
    if (!REVIEW_STATUSES.has(reviewStatus)) {
      throw new Error("edges[" + index + "].review_status must be proposed or confirmed.");
    }

    connectedNodeIds.add(from);
    connectedNodeIds.add(to);
    return {
      from,
      to,
      relationType,
      sourceExcerpt: raw.source_excerpt === undefined ? sourceDescription : String(raw.source_excerpt).trim(),
      confidence,
      reviewStatus
    };
  });

  const unlinked = nodes.filter((node) => !connectedNodeIds.has(node.id)).map((node) => node.id);
  if (unlinked.length) {
    throw new Error("Every generated node must be associated with at least one edge: " + unlinked.join(", "));
  }

  return { graphId, sourceDescription, nodes, edges };
}

function nodeSourcePath(graphId, nodeId) {
  return "codex://requirement-graph/" + encodeURIComponent(graphId) + "/nodes/" + encodeURIComponent(nodeId) + ".json";
}

function relationshipSourcePath(graphId) {
  return "codex://requirement-graph/" + encodeURIComponent(graphId) + "/relationships.json";
}

function applyStructuredGraph(graph, payload) {
  const generated = normalizeStructuredGraph(payload);

  return graph.transaction(() => {
    graph.clearGenerated();

    for (const node of generated.nodes) {
      if (graph.findNode(node.id)) {
        throw new Error("Generated node id conflicts with an imported source node: " + node.id);
      }
      for (const sourceDocumentId of node.sourceDocumentIds) {
        if (!graph.findNode(sourceDocumentId)) {
          throw new Error("Unknown imported source document node: " + sourceDocumentId);
        }
      }
    }

    const nodeIds = new Map();
    for (const node of generated.nodes) {
      const sourcePath = nodeSourcePath(generated.graphId, node.id);
      const content = JSON.stringify({
        graph_id: generated.graphId,
        source_description: generated.sourceDescription,
        generated_by: "codex",
        node
      });
      const documentId = graph.upsertDocument({
        sourcePath,
        format: "codex-generated",
        content,
        checksum: hash(content)
      });
      const nodeId = graph.upsertNode({
        documentId,
        stableId: node.id,
        title: node.title,
        kind: node.kind,
        body: node.body,
        metadata: {
          ...node.metadata,
          source_document_ids: node.sourceDocumentIds,
          origin: "codex_generated",
          graph_id: generated.graphId,
          source_description: generated.sourceDescription
        }
      });
      // Generated edges must resolve by stable id. Do not register titles as
      // aliases, because duplicate AI titles must never steal an alias.
      graph.addAliases(nodeId, [node.id]);
      nodeIds.set(node.id, nodeId);
    }

    const edgeSourcePath = relationshipSourcePath(generated.graphId);
    for (const edge of generated.edges) {
      graph.queueOrCreateEdge({
        fromNodeId: nodeIds.get(edge.from),
        targetAlias: edge.to,
        relationType: edge.relationType,
        sourcePath: edgeSourcePath,
        excerpt: edge.sourceExcerpt,
        confidence: edge.confidence,
        reviewStatus: edge.reviewStatus,
        provenance: "codex_generated"
      });
    }

    for (const node of generated.nodes) {
      for (const sourceDocumentId of node.sourceDocumentIds) {
        graph.queueOrCreateEdge({
          fromNodeId: nodeIds.get(node.id),
          targetAlias: sourceDocumentId,
          relationType: "DERIVES_FROM",
          sourcePath: edgeSourcePath,
          excerpt: "Generated from imported source document " + sourceDocumentId,
          confidence: 1,
          reviewStatus: "confirmed",
          provenance: "codex_generated"
        });
      }
    }

    graph.resolvePendingEdges();
    const stats = graph.stats();
    if (stats.unresolvedEdges) throw new Error("Generated graph contains unresolved edges.");
    const unlinked = generated.nodes.filter((node) => {
      const context = graph.context(node.id);
      return !context || (!context.outgoing.length && !context.incoming.length);
    }).map((node) => node.id);
    if (unlinked.length) {
      throw new Error("Generated graph contains unlinked nodes after write: " + unlinked.join(", "));
    }

    return {
      replaced: true,
      graph_id: generated.graphId,
      node_count: generated.nodes.length,
      edge_count: generated.edges.length,
      unlinked_nodes: [],
      stats
    };
  });
}

module.exports = {
  RELATION_TYPES,
  applyStructuredGraph,
  normalizeStructuredGraph
};

