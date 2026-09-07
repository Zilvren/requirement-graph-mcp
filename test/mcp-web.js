const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { RequirementGraph, projectDbPath } = require("../src/db");
const { importPath } = require("../src/importer");
const { decompositionPolicy } = require("../src/mcp");

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-graph-mcp-web-"));
  let child;
  try {
    const documentPath = path.join(projectRoot, "requirement.md");
    const originalDocument = "---\nid: MCP-WEB\ntitle: MCP web requirement\n---\n# MCP web requirement\n\nThe reader must return this original content.\n\nFeedback query provides list and detail operations. GET /feedbacks requires a positive page and pageSize in 1..100, returns the requested slice, and reports invalid pagination as a field error. GET /feedbacks/{id} returns the feedback and its audit history.\n";
    fs.writeFileSync(documentPath, originalDocument, "utf8");
    const graph = new RequirementGraph(projectDbPath(projectRoot));
    importPath(graph, documentPath);
    graph.close();

    child = spawn(process.execPath, [path.resolve(__dirname, "../src/index.js"), "serve", "--mcp"], { stdio: ["pipe", "pipe", "pipe"] });
    const errors = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => errors.push(chunk));
    const pending = new Map();
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    output.on("line", (line) => {
      const message = JSON.parse(line);
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        request.resolve(message);
      }
    });
    let id = 0;
    function request(method, params) {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n", "utf8");
      });
    }

    const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: { extensions: {} } });
    assert.deepEqual(initialized.result.capabilities, { tools: {} });
    assert.doesNotMatch(initialized.result.instructions, /render_canvas|MCP App|CodeGraph/i);
    // Initialization publishes one shared policy; tool schemas preserve the
    // ownership/provenance distinction without requiring a particular prose copy.
    assert.ok(initialized.result.instructions.includes(decompositionPolicy));
    for (const concept of ["L1", "L2", "L3", "L4", "CHILD_OF", "DERIVES_FROM", "source_document_ids", "metadata.acceptance_criteria"]) {
      assert.ok(decompositionPolicy.includes(concept), "Missing policy concept: " + concept);
    }
    assert.doesNotMatch(initialized.result.instructions, /fine-grained/);
    const listed = await request("tools/list", {});
    const names = listed.result.tools.map((tool) => tool.name);
    assert.ok(names.includes("requirement_graph_open_web"));
    assert.ok(!names.includes("requirement_graph_render_canvas"));
    assert.equal(new Set(names).size, names.length);
    const replaceTool = listed.result.tools.find((tool) => tool.name === "requirement_graph_replace");
    assert.deepEqual(replaceTool.inputSchema.required, ["project_path", "source_description", "nodes", "edges"]);
    const nodeProperties = replaceTool.inputSchema.properties.nodes.items.properties;
    assert.equal(nodeProperties.source_document_ids.type, "array");
    assert.equal(nodeProperties.body.type, "string");
    assert.equal(nodeProperties.metadata.type, "object");
    assert.ok(replaceTool.inputSchema.properties.edges.items.properties.relation_type.enum.includes("CHILD_OF"));
    const openTool = listed.result.tools.find((tool) => tool.name === "requirement_graph_open_web");
    assert.deepEqual(openTool.inputSchema.required, ["project_path"]);
    const resources = await request("resources/list", {});
    assert.equal(resources.error.code, -32601);

    const opened = await request("tools/call", { name: "requirement_graph_open_web", arguments: { project_path: projectRoot } });
    const openResult = JSON.parse(opened.result.content[0].text);
    assert.match(openResult.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const page = await fetch(openResult.url);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /data-node-shape/);
    assert.match(html, /id="reader-document-content"/);
    assert.doesNotMatch(html, /reader-inbound|reader-outbound|上游关系|下游关系/);
    assert.doesNotMatch(html, /postMessage|ui\/initialize|requirement_graph_render_canvas|CodeGraph/);
    const api = await fetch(openResult.url + "api/graph");
    const payload = (await api.json()).structuredContent;
    assert.equal(payload.source, "requirements");
    assert.deepEqual(payload.sources.map((source) => source.source), ["requirements"]);
    assert.ok(payload.nodes.some((node) => node.id === "rg:MCP-WEB"));
    const documentsResponse = await fetch(openResult.url + "api/documents");
    assert.equal(documentsResponse.status, 200);
    const documents = (await documentsResponse.json()).structuredContent;
    const documentInfo = documents.documents.find((item) => item.stableId === "MCP-WEB");
    assert.ok(documentInfo);
    const original = await fetch(openResult.url + "api/document?id=" + documentInfo.documentId);
    assert.equal(original.status, 200);
    assert.equal((await original.json()).structuredContent.document.content, originalDocument);

    // A complete endpoint retains its details rather than creating one leaf
    // per field. Both the group and its children retain direct source evidence.
    const generatedNodes = [
      { id: "QUERY", title: "Query feedback", kind: "capability_group", body: "List and inspect feedback." },
      { id: "LIST", title: "List feedback", kind: "interface_requirement", body: "GET /feedbacks\n\nParameters: page is positive; pageSize is 1..100.\nErrors: return a field error for invalid pagination.", metadata: { acceptance_criteria: ["Valid pagination returns the requested slice.", "Invalid pageSize returns a field error."] } },
      { id: "DETAIL", title: "Inspect feedback", kind: "interface_requirement", body: "GET /feedbacks/{id}\n\nReturn the feedback and its audit history." }
    ].map((node) => ({ ...node, source_document_ids: ["MCP-WEB"], metadata: { ...node.metadata, source_refs: [{ path: documentPath, excerpt: originalDocument.slice(originalDocument.indexOf("Feedback query provides")) }] } }));
    const replaced = await request("tools/call", { name: "requirement_graph_replace", arguments: {
      project_path: projectRoot, source_description: "MCP hierarchy and evidence contract fixture", graph_id: "layered-fixture",
      nodes: generatedNodes,
      edges: ["LIST", "DETAIL"].map((from) => ({ from, to: "QUERY", relation_type: "CHILD_OF", review_status: "confirmed", confidence: 1 }))
    } });
    assert.equal(replaced.error, undefined, JSON.stringify(replaced.error));
    assert.equal(JSON.parse(replaced.result.content[0].text).node_count, 3);
    const contextResponse = await request("tools/call", { name: "requirement_graph_context", arguments: { project_path: projectRoot, id: "LIST" } });
    const context = JSON.parse(contextResponse.result.content[0].text);
    assert.equal(context.node.body, generatedNodes[1].body);
    assert.deepEqual(context.node.metadata.acceptance_criteria, generatedNodes[1].metadata.acceptance_criteria);
    assert.deepEqual(context.node.metadata.source_document_ids, ["MCP-WEB"]);
    assert.ok(context.outgoing.some((edge) => edge.relation_type === "CHILD_OF" && edge.stable_id === "QUERY"));
    assert.ok(context.outgoing.some((edge) => edge.relation_type === "DERIVES_FROM" && edge.stable_id === "MCP-WEB"));

    const beforeView = (await (await fetch(openResult.url + "api/graph")).json()).structuredContent;
    const reopened = await request("tools/call", { name: "requirement_graph_open_web", arguments: { project_path: projectRoot } });
    const reopenedResult = JSON.parse(reopened.result.content[0].text);
    assert.equal(reopenedResult.reused, true);
    assert.equal(reopenedResult.url, openResult.url);
    const afterView = (await (await fetch(reopenedResult.url + "api/graph")).json()).structuredContent;
    assert.deepEqual(afterView.nodes, beforeView.nodes, "Opening a graph must not regenerate its nodes");
    assert.deepEqual(afterView.edges, beforeView.edges, "Opening a graph must not sync or replace its relationships");
    assert.equal(afterView.nodes.length, 4, "One source plus a group and two coherent requirements");
    assert.equal(afterView.edges.length, 5, "Two ownership links and three source-evidence links");
    const sourceAfterView = await fetch(reopenedResult.url + "api/document?id=" + documentInfo.documentId);
    assert.equal((await sourceAfterView.json()).structuredContent.document.content, originalDocument);

    child.stdin.end();
    const exited = await childExit(child);
    child = null;
    assert.equal(exited.signal, null, errors.join(""));
    assert.equal(exited.code, 0, errors.join(""));
  } finally {
    if (child) {
      child.stdin.end();
      await childExit(child);
    }
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  process.stdout.write("MCP web-only test passed\n");
}

main().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
