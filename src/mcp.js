const readline = require("node:readline");
const { RequirementGraph, projectDbPath } = require("./db");
const { importPath, syncImportedDocuments } = require("./importer");
const { applyStructuredGraph } = require("./generated-graph");
const { resolveProjectRoot } = require("./project");
const { ensureWebServer } = require("./web-daemon");

// Shared generation policy; tool descriptions below describe only their operation.
const decompositionPolicy = [
  "Default to at most three useful levels: L1 project/document scope, L2 business capability or domain group, and L3 a coherent deliverable requirement such as an endpoint, workflow, or entity contract. An imported document may serve as L1; do not generate a duplicate document node. A group often has 3-7 meaningful children, but this is a readability guide, never a quota or a reason to invent requirements.",
  "Keep parameters, fields, null rules, error codes, permission checks, and closely related acceptance criteria inside that requirement's structured body or metadata.acceptance_criteria, not as one node per sentence or validation. Use L4 only when explicitly requested or a complex sub-capability is independently deliverable. Do not force simple material into three levels; collapse redundant single-child groups and impose no target total node count.",
  "Use CHILD_OF from child to its unique owning parent, with no multiple parents or cycles. A unique CHILD_OF determines hierarchy before any DERIVES_FROM fallback. Keep source_document_ids for every mapped imported source even on child nodes, and metadata.source_refs with source paths and supporting excerpts. Sources without stable IDs use source paths in metadata; never invent source IDs. DERIVES_FROM records evidence, not competing ownership.",
  "Explicitly stated relations may be confirmed; conservative inferred cross-relations must be proposed with confidence at most 0.8. Do not invent edges to connect the graph. Each generated node needs an evidence-backed source link or a non-self relationship.",
  "When coarsening an existing graph, preserve all requirement details and evidence in merged bodies or acceptance criteria, remap justified external edges, deduplicate them, and drop merge-created self edges. Inspect the existing generated layer and back it up before replacement; preserve imported documents and a recoverable prior graph."
].join(" ");

const serverInstructions = [
  "Use this local Requirement Graph automatically for requirements, documents, traceability, dependencies, and change impact, with the active project root as project_path; do not ask the user for tool names or that parameter.",
  "For view-only requests, call requirement_graph_open_web and open or return its localhost URL. Viewing never requires import, sync, or replacement. The standalone webpage is the only rendering surface and shows only Requirement Graph data; ordinary Markdown REFERENCES are weak citations, not confirmed dependencies.",
  "For an explicit import or refresh request, use requirement_graph_import or requirement_graph_sync respectively. These index sources and explicit links only, not semantic decomposition.",
  "For generation or regeneration from documents, import or refresh only the relevant sources, list them with requirement_graph_documents, and read each relevant source to EOF with requirement_graph_read_document. Analyze their meaning under the decomposition policy, then call requirement_graph_replace once with the complete graph before opening the webpage. Imported documents are evidence, not a completed requirement analysis. For natural-language generation, analyze the user's description directly; do not ask the user to author documents or raw JSON.",
  decompositionPolicy
].join(" ");

const projectPathProperty = {
  project_path: {
    type: "string",
    description: "Absolute project root. Its graph is stored in .requirement-graph/requirements-graph.db."
  }
};

function tool(name, description, properties, required, title) {
  return {
    name,
    ...(title ? { title } : {}),
    description,
    inputSchema: { type: "object", properties, required }
  };
}

const nodeSchema = {
  type: "object",
  properties: {
    id: { type: "string" }, title: { type: "string" }, kind: { type: "string" },
    body: { type: "string", description: "Coherent requirement content, including related parameters, validation, errors, and acceptance details that do not warrant separate nodes." },
    metadata: { type: "object", description: "Supporting source_refs (paths and excerpts), optional acceptance_criteria, and other requirement metadata." },
    source_document_ids: { type: "array", items: { type: "string" }, description: "All mapped imported source IDs substantiating this node, including child nodes. Creates evidence links, not competing CHILD_OF ownership." }
  },
  required: ["id", "title"]
};

const edgeSchema = {
  type: "object",
  properties: {
    from: { type: "string" }, to: { type: "string" },
    relation_type: { type: "string", enum: ["DEPENDS_ON", "BLOCKED_BY", "RELATED_TO", "IMPLEMENTS", "VALIDATES", "VALIDATED_BY", "SUPPORTS", "CHILD_OF", "DERIVES_FROM"], description: "CHILD_OF assigns the unique owning parent (child -> parent; acyclic). DERIVES_FROM is provenance; other types describe independently justified cross-relations." },
    source_excerpt: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
    review_status: { type: "string", enum: ["proposed", "confirmed"] }
  },
  required: ["from", "to", "relation_type"]
};

const tools = [
  tool("requirement_graph_import", "Index Markdown, TXT, JSON, or CSV source documents as coarse document or record nodes and extract only explicitly declared links. This does not semantically analyze text, split requirements, infer relationships, or complete a request to generate a requirement graph.", { path: { type: "string" }, ...projectPathProperty }, ["path"]),
  tool("requirement_graph_documents", "List imported source documents without generated nodes. For a document-driven requirement-graph request, call this after import and then read every relevant result with requirement_graph_read_document before replacing the graph.", { offset: { type: "number", description: "Zero-based page offset." }, limit: { type: "number", description: "Documents per page, from 1 to 100." }, ...projectPathProperty }, ["project_path"]),
  tool("requirement_graph_read_document", "Read a chunk of an imported source document's original content, including Markdown frontmatter. Pass the stable_id or source_path returned by requirement_graph_documents; repeat with next_offset until EOF before performing semantic requirement decomposition.", { id: { type: "string", description: "An imported document stable_id or source_path from requirement_graph_documents." }, offset: { type: "number", description: "Zero-based character offset." }, limit: { type: "number", description: "Characters to return, from 1 to 50000." }, ...projectPathProperty }, ["id", "project_path"]),
  tool("requirement_graph_replace", "Replace only the prior Codex-generated layer with a complete, evidence-backed graph after source analysis. Follow the shared decomposition policy: scope -> capability -> coherent deliverable; keep validation details inside requirements. Imported documents are preserved and source_document_ids create DERIVES_FROM links. Not needed for viewing.", { ...projectPathProperty, graph_id: { type: "string", description: "Optional identifier retained with the generated graph provenance." }, source_description: { type: "string", description: "The user's requirement description and the analyzed source scope." }, nodes: { type: "array", items: nodeSchema }, edges: { type: "array", items: edgeSchema } }, ["project_path", "source_description", "nodes", "edges"]),
  tool("requirement_graph_search", "Search requirement and document nodes by title, ID, or content.", { query: { type: "string" }, limit: { type: "number" }, ...projectPathProperty }, ["query", "project_path"]),
  tool("requirement_graph_sync", "Re-import the documents already known to this project's Requirement Graph, refreshing explicit relationship extraction without scanning unrelated files.", projectPathProperty, ["project_path"]),
  tool("requirement_graph_context", "Return a node, its metadata, and all direct incoming and outgoing relations.", { id: { type: "string" }, ...projectPathProperty }, ["id", "project_path"]),
  tool("requirement_graph_trace", "Follow dependencies or traceability links from a node.", { id: { type: "string" }, direction: { type: "string", enum: ["outgoing", "incoming"] }, depth: { type: "number" }, ...projectPathProperty }, ["id", "project_path"]),
  tool("requirement_graph_impact", "Find nodes that may be impacted when a requirement changes.", { id: { type: "string" }, depth: { type: "number" }, ...projectPathProperty }, ["id", "project_path"]),
  tool("requirement_graph_unlinked", "List imported nodes that are not connected to any other node.", projectPathProperty, ["project_path"]),
  tool("requirement_graph_stats", "Return local graph counts and database location.", projectPathProperty, ["project_path"]),
  tool("requirement_graph_open_web", "Start or reuse this project's standalone local Requirement Graph webpage and return its loopback URL. View-only operation: do not import, sync, or regenerate the graph merely to open it.", projectPathProperty, ["project_path"], "Open Requirement Graph web UI")
];

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function startMcpServer(databasePath) {
  const graphs = new Map();
  const fallbackDatabase = databasePath || null;
  const graphFor = (args, allowImportPath = false) => {
    const projectPath = args.project_path || (allowImportPath ? args.path : null);
    const database = projectPath ? projectDbPath(projectPath) : fallbackDatabase;
    if (!database) throw new Error("project_path is required so each project uses its own graph database.");
    if (!graphs.has(database)) graphs.set(database, new RequirementGraph(database));
    return graphs.get(database);
  };
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  const respond = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  input.on("line", async (line) => {
    let request;
    try {
      request = JSON.parse(line);
      if (request.method === "initialize") {
        respond(request.id, {
          protocolVersion: request.params && request.params.protocolVersion ? request.params.protocolVersion : "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "requirement-graph", version: "0.4.1" },
          instructions: serverInstructions
        });
        return;
      }
      if (request.method === "ping") return respond(request.id, {});
      if (request.method === "tools/list") return respond(request.id, { tools });
      if (request.method === "tools/call") {
        const args = request.params.arguments || {};
        let value;
        switch (request.params.name) {
          case "requirement_graph_import": value = importPath(graphFor(args, true), args.path); break;
          case "requirement_graph_documents": value = graphFor(args).sourceDocuments(args.offset, args.limit); break;
          case "requirement_graph_read_document": value = graphFor(args).readSourceDocument(args.id, args.offset, args.limit); break;
          case "requirement_graph_replace": value = applyStructuredGraph(graphFor(args), args); break;
          case "requirement_graph_sync": value = syncImportedDocuments(graphFor(args)); break;
          case "requirement_graph_search": value = graphFor(args).search(args.query, args.limit); break;
          case "requirement_graph_context": value = graphFor(args).context(args.id); break;
          case "requirement_graph_trace": value = graphFor(args).traverse(args.id, args.direction || "outgoing", args.depth); break;
          case "requirement_graph_impact": value = graphFor(args).traverse(args.id, "incoming", args.depth); break;
          case "requirement_graph_unlinked": value = graphFor(args).unlinked(); break;
          case "requirement_graph_stats": value = graphFor(args).stats(); break;
          case "requirement_graph_open_web": {
            // The web UI runs as a detached per-project daemon, so it stays up
            // after this MCP process (and the Codex session owning it) exits.
            // A later session reconnects to the same URL instead of restarting.
            value = await ensureWebServer(resolveProjectRoot(args.project_path));
            break;
          }
          default: return fail(request.id, -32602, "Unknown tool: " + request.params.name);
        }
        return respond(request.id, textResult(value));
      }
      if (!Object.prototype.hasOwnProperty.call(request, "id")) return;
      fail(request.id, -32601, "Unsupported method: " + request.method);
    } catch (error) {
      if (!request || !Object.prototype.hasOwnProperty.call(request, "id")) return;
      fail(request.id, -32603, error.message);
    }
  });
  input.on("close", () => {
    for (const graph of graphs.values()) graph.close();
  });
}

module.exports = { decompositionPolicy, serverInstructions, startMcpServer, tools };
