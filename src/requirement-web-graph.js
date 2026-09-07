const { resolveProjectRoot } = require("./project");
const { readRequirementGraph } = require("./requirement-graph-reader");

function relationshipScope(options = {}) {
  return options.relationshipScope === "all" ? "all" : "structural";
}

function sourceDescriptor(requirement) {
  return {
    source: "requirements",
    available: requirement.available,
    database: requirement.database || null,
    totalNodes: requirement.totalNodes || 0,
    totalEdges: requirement.totalEdges || 0,
    hiddenReferenceEdges: requirement.hiddenReferenceEdges || 0,
    mode: requirement.mode || "documents",
    truncated: Boolean(requirement.truncated),
    reason: requirement.reason || null
  };
}

function buildRequirementWebGraph(projectPath, options = {}) {
  const projectRoot = resolveProjectRoot(projectPath);
  const scope = relationshipScope(options);
  const requirement = readRequirementGraph(projectRoot, { ...options, relationshipScope: scope });
  const nodes = requirement.nodes;
  const ids = new Set(nodes.map((node) => node.id));
  const edges = requirement.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
  const warnings = [...(requirement.warnings || [])];
  if (!nodes.length && !warnings.length) {
    warnings.push("No Requirement Graph data is available yet. Import requirement documents first.");
  }
  return {
    version: 1,
    projectPath: projectRoot,
    source: "requirements",
    detail: "documents",
    relationshipScope: scope,
    nodes,
    edges,
    sources: [sourceDescriptor(requirement)],
    warnings
  };
}

module.exports = { buildRequirementWebGraph };
