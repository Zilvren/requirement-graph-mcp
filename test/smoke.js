const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { RequirementGraph, projectDbPath } = require("../src/db");
const { centralDbPath, localProjectDbPath } = require("../src/project");
const { importPath, syncImportedDocuments } = require("../src/importer");
const { applyStructuredGraph } = require("../src/generated-graph");
const { buildRequirementWebGraph } = require("../src/requirement-web-graph");
const { serverInstructions, tools } = require("../src/mcp");

assert.match(serverInstructions, /automatically/);
assert.match(serverInstructions, /requirement_graph_use_project/);
assert.match(serverInstructions, /requirement_graph_open_web/);
assert.doesNotMatch(serverInstructions, /render_canvas|MCP App|CodeGraph/i);
assert.ok(tools.some((tool) => tool.name === "requirement_graph_open_web"));
assert.ok(tools.some((tool) => tool.name === "requirement_graph_use_project"));
assert.ok(tools.some((tool) => tool.name === "requirement_graph_list_projects"));
assert.ok(!tools.some((tool) => tool.name === "requirement_graph_render_canvas"));

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-graph-"));
process.env.REQUIREMENT_GRAPH_HOME = path.join(temp, "rg-home");
try {
  const examplePath = path.resolve(__dirname, "../examples/requirements");
  const database = path.join(temp, "graph.db");
  const graph = new RequirementGraph(database);
  assert.equal(importPath(graph, examplePath).imported, 5);
  assert.equal(graph.stats().nodes, 5);
  const documentSlice = graph.readSourceDocument("REQ-AUTH-001", 0, 12);
  assert.ok(documentSlice.document.truncated);
  assert.ok(graph.search("验证码").some((item) => item.stable_id === "REQ-AUTH-001"));
  assert.equal(graph.context("REQ-AUTH-001").node.title, "支持短信验证码登录");
  assert.ok(graph.traverse("REQ-AUTH-001", "outgoing", 2).links.some((edge) => edge.to === "REQ-PLATFORM-001"));
  graph.close();

  const generatedProject = path.join(temp, "codex-generated-project");
  const generatedGraph = new RequirementGraph(projectDbPath(generatedProject));
  importPath(generatedGraph, examplePath);
  const generated = applyStructuredGraph(generatedGraph, {
    graph_id: "codex-login-v1",
    source_description: "Users sign in with a phone verification code, which depends on SMS delivery.",
    nodes: [
      { id: "REQ-GEN-LOGIN", title: "Phone verification-code login", source_document_ids: ["REQ-AUTH-001"] },
      { id: "CAP-GEN-SMS", title: "SMS delivery capability", kind: "capability", source_document_ids: ["REQ-PLATFORM-001"] }
    ],
    edges: [{ from: "REQ-GEN-LOGIN", to: "CAP-GEN-SMS", relation_type: "DEPENDS_ON", confidence: 0.93 }]
  });
  assert.equal(generated.replaced, true);
  assert.equal(generated.node_count, 2);
  assert.equal(generated.edge_count, 1);
  const generatedContext = generatedGraph.context("REQ-GEN-LOGIN");
  assert.equal(generatedContext.node.metadata.origin, "codex_generated");
  assert.equal(generatedContext.outgoing.find((edge) => edge.stable_id === "REQ-AUTH-001").relation_type, "DERIVES_FROM");
  assert.throws(() => applyStructuredGraph(generatedGraph, {
    source_description: "Invalid graph with an isolated requirement.",
    nodes: [{ id: "REQ-ONE", title: "One" }, { id: "REQ-TWO", title: "Two" }, { id: "REQ-ISOLATED", title: "Isolated" }],
    edges: [{ from: "REQ-ONE", to: "REQ-TWO", relation_type: "RELATED_TO" }]
  }), /Every generated node must be associated/);
  generatedGraph.close();
  const generatedWebGraph = buildRequirementWebGraph(generatedProject);
  assert.equal(generatedWebGraph.source, "requirements");
  assert.equal(generatedWebGraph.detail, "documents");
  assert.equal(generatedWebGraph.relationshipScope, "structural");
  assert.deepEqual(generatedWebGraph.sources.map((source) => source.source), ["requirements"]);
  assert.ok(generatedWebGraph.nodes.some((node) => node.id === "rg:REQ-GEN-LOGIN"));
  assert.ok(generatedWebGraph.edges.some((edge) => edge.source === "rg:REQ-GEN-LOGIN" && edge.target === "rg:CAP-GEN-SMS"));

  // One source-backed requirement must not force an artificial extra layer.
  const simpleGraph = new RequirementGraph(projectDbPath(path.join(temp, "simple-project")));
  importPath(simpleGraph, examplePath);
  const simple = applyStructuredGraph(simpleGraph, {
    source_description: "One coherent login requirement backed by its source.",
    nodes: [{ id: "REQ-SIMPLE", title: "Login", source_document_ids: ["REQ-AUTH-001"] }],
    edges: []
  });
  assert.equal(simple.node_count, 1);
  assert.equal(simpleGraph.context("REQ-SIMPLE").outgoing[0].relation_type, "DERIVES_FROM");
  assert.throws(() => applyStructuredGraph(simpleGraph, {
    source_description: "An isolated source-free node is still invalid.",
    nodes: [{ id: "REQ-ISOLATED", title: "Isolated" }], edges: []
  }), /link every node to an imported source document/);
  assert.equal(simpleGraph.context("REQ-SIMPLE").node.title, "Login");
  simpleGraph.close();

  const referencesProject = path.join(temp, "references-project");
  fs.mkdirSync(referencesProject, { recursive: true });
  fs.writeFileSync(path.join(referencesProject, "A.md"), "# A\n\nSee [[B]].\n", "utf8");
  fs.writeFileSync(path.join(referencesProject, "B.md"), "# B\n", "utf8");
  const referencesGraph = new RequirementGraph(projectDbPath(referencesProject));
  importPath(referencesGraph, referencesProject);
  assert.equal(referencesGraph.context("A").outgoing[0].relation_type, "REFERENCES");
  referencesGraph.close();
  const structuralOnly = buildRequirementWebGraph(referencesProject);
  assert.equal(structuralOnly.edges.length, 0);
  assert.match(structuralOnly.warnings.join(" "), /文档引用已隐藏/);
  assert.equal(buildRequirementWebGraph(referencesProject, { relationshipScope: "all" }).edges.length, 1);

  const legacyProject = path.join(temp, "legacy-requirement-project");
  const legacyPath = projectDbPath(legacyProject);
  fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec([
    "CREATE TABLE documents (id INTEGER PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, format TEXT NOT NULL, content TEXT NOT NULL, checksum TEXT NOT NULL, imported_at TEXT NOT NULL);",
    "CREATE TABLE nodes (id INTEGER PRIMARY KEY, stable_id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, kind TEXT NOT NULL, metadata_json TEXT NOT NULL, document_id INTEGER NOT NULL UNIQUE);",
    "CREATE TABLE edges (id INTEGER PRIMARY KEY, from_node_id INTEGER NOT NULL, to_node_id INTEGER NOT NULL, relation_type TEXT NOT NULL, source_path TEXT NOT NULL, source_excerpt TEXT NOT NULL, confidence REAL NOT NULL, review_status TEXT NOT NULL);"
  ].join("\n"));
  legacy.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)").run(1, "a.md", "markdown", "# A", "a", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)").run(2, "b.md", "markdown", "# B", "b", "2026-01-01T00:00:00.000Z");
  legacy.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)").run(1, "A", "A", "requirement", "{}", 1);
  legacy.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?)").run(2, "B", "B", "requirement", "{}", 2);
  legacy.prepare("INSERT INTO edges VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(1, 1, 2, "DEPENDS_ON", "a.md", "depends", 1, "confirmed");
  legacy.close();
  const legacyWebGraph = buildRequirementWebGraph(legacyProject);
  assert.equal(legacyWebGraph.nodes.length, 2);
  assert.equal(legacyWebGraph.edges.length, 1);
  assert.equal(legacyWebGraph.edges[0].provenance, "legacy");
  assert.equal(legacyWebGraph.nodes[0].body, "");

  const semanticProject = path.join(temp, "semantic-project");
  fs.mkdirSync(semanticProject, { recursive: true });
  const doc = (id, title, body = "") => ["---", "id: " + id, "title: " + title, "kind: requirement", "---", "# " + title, body].join("\n") + "\n";
  fs.writeFileSync(path.join(semanticProject, "root.md"), doc("ROOT", "Root"), "utf8");
  fs.writeFileSync(path.join(semanticProject, "child.md"), doc("CHILD", "Child", "父需求：[Root](./root.md)"), "utf8");
  const semanticGraph = new RequirementGraph(projectDbPath(semanticProject));
  importPath(semanticGraph, semanticProject);
  assert.ok(semanticGraph.context("CHILD").outgoing.some((edge) => edge.relation_type === "CHILD_OF"));
  fs.writeFileSync(path.join(semanticProject, "child.md"), doc("CHILD", "Child"), "utf8");
  assert.equal(syncImportedDocuments(semanticGraph).syncedFiles, 2);
  assert.equal(semanticGraph.context("CHILD").outgoing.length, 0);
  semanticGraph.close();

  // Registry: projects are registered by directory, switched by id, and all
  // Project registration does not create a graph directory by itself.
  const { activeProject, listProjects, registerProject, removeProject, resolveProject, setActiveProject } = require("../src/registry");
  const projectA = path.join(temp, "project-a");
  const projectB = path.join(temp, "project-b");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  const registeredA = registerProject(projectA);
  assert.equal(registeredA.registered, true);
  assert.equal(registeredA.id, "project-a");
  assert.equal(registerProject(projectB).id, "project-b");
  const againA = registerProject(projectA);
  assert.equal(againA.registered, false, "re-registering the same directory is idempotent");
  assert.equal(againA.id, "project-a");
  assert.deepEqual(listProjects().map((p) => p.id).sort(), ["project-a", "project-b"]);
  assert.equal(resolveProject("project-b").root, projectB);
  assert.equal(resolveProject(projectA).root, projectA);
  const switched = setActiveProject("project-a");
  assert.equal(switched.id, "project-a");
  assert.equal(activeProject().id, "project-a");
  removeProject("project-b");
  assert.deepEqual(listProjects().map((p) => p.id), ["project-a"]);

  // A new graph belongs to the selected project, but asking for its path does
  // not create files or folders.
  const projectDb = projectDbPath(projectA);
  assert.equal(projectDb, localProjectDbPath(projectA));
  assert.equal(fs.existsSync(path.join(projectA, ".requirement-graph")), false);

  // Keep pre-1.3 central databases readable for projects that do not yet have
  // a project-local graph; a local graph always wins once it exists.
  const compatibilityProject = path.join(temp, "compatibility-project");
  fs.mkdirSync(compatibilityProject, { recursive: true });
  const centralCompatibilityDb = centralDbPath(compatibilityProject);
  new RequirementGraph(centralCompatibilityDb).close();
  assert.equal(projectDbPath(compatibilityProject), centralCompatibilityDb);
  const localCompatibilityDb = localProjectDbPath(compatibilityProject);
  new RequirementGraph(localCompatibilityDb).close();
  assert.equal(projectDbPath(compatibilityProject), localCompatibilityDb);

  const frontmatterProject = path.join(temp, "frontmatter-project");
  fs.mkdirSync(frontmatterProject, { recursive: true });
  fs.writeFileSync(path.join(frontmatterProject, "fm.md"), [
    "---",
    "id: FM",
    'title: "Multi: colon"',
    "depends_on:",
    "  - REQ-ONE",
    "  - REQ-TWO",
    'related_to: ["Alpha, beta", Gamma]',
    "---",
    "# FM"
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(frontmatterProject, "one.md"), "---\nid: REQ-ONE\n---\n# One\n", "utf8");
  fs.writeFileSync(path.join(frontmatterProject, "two.md"), "---\nid: REQ-TWO\n---\n# Two\n", "utf8");
  const frontmatterGraph = new RequirementGraph(projectDbPath(frontmatterProject));
  importPath(frontmatterGraph, frontmatterProject);
  const frontmatterContext = frontmatterGraph.context("FM");
  assert.equal(frontmatterContext.node.title, "Multi: colon", "quoted Frontmatter values keep colons and lose their quotes");
  assert.ok(frontmatterContext.outgoing.some((edge) => edge.relation_type === "DEPENDS_ON" && edge.stable_id === "REQ-ONE"));
  assert.ok(frontmatterContext.outgoing.some((edge) => edge.relation_type === "DEPENDS_ON" && edge.stable_id === "REQ-TWO"));
  assert.ok(frontmatterContext.unresolved.some((edge) => edge.target_alias === "Gamma"), "an unresolved related target stays pending");
  assert.ok(frontmatterContext.unresolved.some((edge) => edge.target_alias === "Alpha, beta"), "a quoted comma inside a list item stays one alias");
  assert.equal(frontmatterGraph.stats().unresolvedEdges, 2, "unresolved related aliases are kept pending");
  frontmatterGraph.close();

  const renameProject = path.join(temp, "rename-project");
  fs.mkdirSync(renameProject, { recursive: true });
  const renameFile = path.join(renameProject, "r.md");
  fs.writeFileSync(renameFile, "---\nid: R-OLD\n---\n# R\n", "utf8");
  const renameGraph = new RequirementGraph(projectDbPath(renameProject));
  importPath(renameGraph, renameFile);
  assert.equal(renameGraph.stats().nodes, 1);
  fs.writeFileSync(renameFile, "---\nid: R-NEW\n---\n# R\n", "utf8");
  importPath(renameGraph, renameFile);
  assert.equal(renameGraph.stats().nodes, 1, "renaming a document's stable id keeps one node");
  assert.ok(renameGraph.context("R-NEW"), "the node is reachable under its new stable id");
  assert.equal(renameGraph.findNode("R-OLD"), null, "the old stable id alias is removed");
  renameGraph.close();

  const duplicateProject = path.join(temp, "duplicate-project");
  fs.mkdirSync(duplicateProject, { recursive: true });
  fs.writeFileSync(path.join(duplicateProject, "a.md"), "---\nid: DUP\n---\n# A\n", "utf8");
  fs.writeFileSync(path.join(duplicateProject, "b.md"), "---\nid: B-OWN\n---\n# B\n", "utf8");
  const duplicateGraph = new RequirementGraph(projectDbPath(duplicateProject));
  importPath(duplicateGraph, duplicateProject);
  fs.writeFileSync(path.join(duplicateProject, "b.md"), "---\nid: DUP\n---\n# B\n", "utf8");
  assert.throws(() => importPath(duplicateGraph, path.join(duplicateProject, "b.md")), /already claimed by another document/);
  assert.equal(duplicateGraph.stats().nodes, 2, "a rejected import leaves the graph untouched");
  assert.ok(duplicateGraph.context("B-OWN"), "the rejected duplicate does not steal the existing node");
  duplicateGraph.close();

  const pluginRoot = path.resolve(__dirname, "../plugins/project-graph-canvas");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, "project-graph-canvas");
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(fs.existsSync(path.join(pluginRoot, ".mcp.json")), false);
  const skill = fs.readFileSync(path.join(pluginRoot, "skills", "project-graph-canvas", "SKILL.md"), "utf8");
  assert.match(skill, /requirement_graph_open_web/);
  assert.doesNotMatch(skill, /requirement_graph_render_canvas/);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

process.stdout.write("smoke test passed\n");
