const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RequirementGraph, projectDbPath } = require("../src/db");
const { importPath } = require("../src/importer");
const { webUiHtml } = require("../src/web-ui");
const { createWebServer, normalizeHost, normalizePort, startWebServer } = require("../src/web");

async function readWholeDocument(baseUrl, id, limit = 17) {
  const chunks = [];
  let offset = 0;
  let last;
  for (;;) {
    const response = await fetch(baseUrl + "api/document?id=" + encodeURIComponent(id) + "&offset=" + offset + "&limit=" + limit);
    assert.equal(response.status, 200);
    const payload = (await response.json()).structuredContent;
    const documentInfo = payload.document;
    assert.equal(documentInfo.contentOffset, offset);
    chunks.push(documentInfo.content);
    last = documentInfo;
    if (documentInfo.nextOffset === null) return { documentInfo: last, content: chunks.join("") };
    assert.ok(documentInfo.nextOffset > offset);
    offset = documentInfo.nextOffset;
  }
}

async function main() {
  assert.equal(normalizeHost(), "127.0.0.1");
  assert.throws(() => normalizeHost("0.0.0.0"), /only bind/);
  assert.throws(() => normalizePort("not-a-port"), /Port must/);
  assert.equal(normalizePort(0, true), 0);

  const unsafeProjectPath = "</script><script>window.evil = true</script>";
  const configuredPage = webUiHtml({ projectPath: unsafeProjectPath });
  const configMatch = configuredPage.match(/window\.__REQUIREMENT_GRAPH_WEB__ = ([\s\S]*?);<\/script>/);
  assert.ok(configMatch);
  assert.equal(JSON.parse(configMatch[1]).projectPath, path.resolve(unsafeProjectPath));
  assert.doesNotMatch(configMatch[0], /<\/script><script>window\.evil/);
  assert.doesNotMatch(configuredPage, /postMessage|ui\/initialize|requirement_graph_render_canvas|CodeGraph/);
  assert.match(configuredPage, /window\.RequirementGraphHierarchy/);
  assert.match(configuredPage, /deriveSingleParentHierarchy/);
  assert.match(configuredPage, /id="show-cross-relations"/);
  assert.match(configuredPage, /function layoutHierarchy/);

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-graph-web-"));
  process.env.REQUIREMENT_GRAPH_HOME = path.join(projectRoot, "rg-home");
  const documentPath = path.join(projectRoot, "requirement.md");
  const originalDocument = "---\nid: WEB-REQ\ntitle: Web requirement\n---\n# Web requirement\n\nA local web UI is available.\n\nOriginal body stays available to the document reader.\n";
  fs.writeFileSync(documentPath, originalDocument, "utf8");
  const graph = new RequirementGraph(projectDbPath(projectRoot));
  importPath(graph, documentPath);
  graph.close();

  assert.throws(() => createWebServer(projectRoot, { host: "0.0.0.0" }), /only bind/);
  const ui = await startWebServer(projectRoot, { port: 0 });
  try {
    assert.equal(ui.host, "127.0.0.1");
    assert.ok(ui.port > 0);
    assert.equal(typeof ui.close, "function");

    const root = await fetch(ui.url);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("cache-control"), /no-store/);
    assert.match(root.headers.get("content-security-policy"), /connect-src 'self'/);
    assert.equal(root.headers.get("x-content-type-options"), "nosniff");
    assert.equal(root.headers.get("referrer-policy"), "no-referrer");
    assert.equal(root.headers.get("access-control-allow-origin"), null);
    const rootHtml = await root.text();
    const rootConfigMatch = rootHtml.match(/window\.__REQUIREMENT_GRAPH_WEB__ = ([\s\S]*?);<\/script>/);
    assert.ok(rootConfigMatch);
    const rootConfig = JSON.parse(rootConfigMatch[1]);
    assert.equal(rootConfig.projectPath, projectRoot);
    assert.equal(rootConfig.csrfToken, ui.csrfToken);
    assert.equal(rootConfig.relationshipScope, "structural");
    assert.match(rootHtml, /data-node-shape/);
    assert.match(rootHtml, /id="reader-document-list"/);
    assert.match(rootHtml, /id="reader-document-content"/);
    assert.match(rootHtml, /REQUIREMENT NODES/);
    assert.match(rootHtml, /id="reader-node-evidence"/);
    assert.match(rootHtml, /function refreshReaderNodes/);
    assert.match(rootHtml, /window\.RequirementGraphHierarchy/);
    assert.match(rootHtml, /deriveSingleParentHierarchy/);
    assert.match(rootHtml, /showCrossRelations/);
    assert.match(rootHtml, /function layoutHierarchy/);
    assert.match(rootHtml, /\/api\/graph\?/);
    assert.doesNotMatch(rootHtml, /\/api\/documents|\/api\/document\?/);
    assert.match(rootHtml, /\.layout\[hidden\]/);
    assert.doesNotMatch(rootHtml, /reader-inbound|reader-outbound|上游关系|下游关系/);
    assert.doesNotMatch(rootHtml, /postMessage|ui\/initialize|requirement_graph_render_canvas|CodeGraph/);

    const fixedProject = await fetch(ui.url + "api/graph?relationship_scope=all&project_path=" + encodeURIComponent(os.tmpdir()));
    assert.equal(fixedProject.status, 200);
    const graphResult = await fixedProject.json();
    assert.equal(graphResult.structuredContent.projectPath, projectRoot);
    assert.equal(graphResult.structuredContent.source, "requirements");
    assert.ok(graphResult.structuredContent.nodes.some((node) => node.id === "rg:WEB-REQ"));

    const documentsResponse = await fetch(ui.url + "api/documents?project_path=" + encodeURIComponent(os.tmpdir()));
    assert.equal(documentsResponse.status, 200);
    const documents = (await documentsResponse.json()).structuredContent;
    assert.equal(documents.available, true);
    const listed = documents.documents.find((documentInfo) => documentInfo.stableId === "WEB-REQ");
    assert.ok(listed);
    assert.equal(listed.sourcePath, documentPath);
    assert.equal(listed.format, "markdown");
    assert.equal(listed.contentLength, originalDocument.length);

    const firstPage = await fetch(ui.url + "api/document?id=rg%3AWEB-REQ&limit=12");
    assert.equal(firstPage.status, 200);
    const firstDocument = (await firstPage.json()).structuredContent.document;
    assert.equal(firstDocument.content, originalDocument.slice(0, 12));
    assert.equal(firstDocument.contentOffset, 0);
    assert.equal(firstDocument.nextOffset, 12);
    assert.equal(firstDocument.truncated, true);
    const whole = await readWholeDocument(ui.url, String(listed.documentId));
    assert.equal(whole.content, originalDocument);
    assert.equal(whole.documentInfo.nextOffset, null);
    assert.equal(whole.documentInfo.truncated, false);

    const missingDocumentId = await fetch(ui.url + "api/document");
    assert.equal(missingDocumentId.status, 400);
    const unknownDocument = await fetch(ui.url + "api/document?id=not-a-document");
    assert.equal(unknownDocument.status, 404);
    const invalidDocumentOffset = await fetch(ui.url + "api/document?id=WEB-REQ&offset=-1");
    assert.equal(invalidDocumentOffset.status, 400);
    const wrongDocumentMethod = await fetch(ui.url + "api/documents", { method: "POST" });
    assert.equal(wrongDocumentMethod.status, 405);
    assert.equal(wrongDocumentMethod.headers.get("allow"), "GET");

    for (const legacyQuery of ["source=requirements", "source=auto", "source=both", "source=codegraph", "detail=auto", "detail=symbols"]) {
      const invalid = await fetch(ui.url + "api/graph?" + legacyQuery);
      assert.equal(invalid.status, 400, legacyQuery);
    }
    const invalidScope = await fetch(ui.url + "api/graph?relationship_scope=unexpected");
    assert.equal(invalidScope.status, 400);
    const wrongSyncMethod = await fetch(ui.url + "api/sync");
    assert.equal(wrongSyncMethod.status, 405);
    assert.equal(wrongSyncMethod.headers.get("allow"), "POST");
    const wrongGraphMethod = await fetch(ui.url + "api/graph", { method: "POST" });
    assert.equal(wrongGraphMethod.status, 405);
    assert.equal(wrongGraphMethod.headers.get("allow"), "GET");
    const wrongMapStateMethod = await fetch(ui.url + "api/map-view-state", { method: "POST" });
    assert.equal(wrongMapStateMethod.status, 405);
    assert.equal(wrongMapStateMethod.headers.get("allow"), "GET, PUT, DELETE");
    const unknown = await fetch(ui.url + "not-a-route");
    assert.equal(unknown.status, 404);

    const emptyMapState = await fetch(ui.url + "api/map-view-state?project_path=" + encodeURIComponent(os.tmpdir()));
    assert.equal(emptyMapState.status, 200);
    assert.equal((await emptyMapState.json()).structuredContent.state, null, "the UI route is fixed to its own project");
    const mapState = {
      version: 1,
      layoutRevision: "layout-v1",
      relationshipScope: "structural",
      layerDepth: "2",
      expandedIds: ["rg:WEB-REQ"],
      collapsedIds: [],
      selectedId: "rg:WEB-REQ",
      focusedId: null,
      showCrossRelations: false,
      camera: { x: 50, y: -30, scale: 0.9 },
      nodePositions: [{ id: "rg:WEB-REQ", x: 120, y: 80 }]
    };
    const missingMapToken = await fetch(ui.url + "api/map-view-state", {
      method: "PUT", body: JSON.stringify(mapState)
    });
    assert.equal(missingMapToken.status, 403);
    const invalidMapBody = await fetch(ui.url + "api/map-view-state", {
      method: "PUT",
      headers: { "X-Requirement-Graph-Token": ui.csrfToken, Origin: ui.url.slice(0, -1) },
      body: "{ invalid"
    });
    assert.equal(invalidMapBody.status, 400);
    const savedMapState = await fetch(ui.url + "api/map-view-state", {
      method: "PUT",
      headers: { "X-Requirement-Graph-Token": ui.csrfToken, Origin: ui.url.slice(0, -1) },
      body: JSON.stringify(mapState)
    });
    assert.equal(savedMapState.status, 200);
    assert.deepEqual((await savedMapState.json()).structuredContent.state, mapState);
    const restoredMapState = await fetch(ui.url + "api/map-view-state");
    assert.deepEqual((await restoredMapState.json()).structuredContent.state, mapState);
    const deletedMapState = await fetch(ui.url + "api/map-view-state", {
      method: "DELETE",
      headers: { "X-Requirement-Graph-Token": ui.csrfToken, Origin: ui.url.slice(0, -1) }
    });
    assert.equal(deletedMapState.status, 200);
    assert.equal((await (await fetch(ui.url + "api/map-view-state")).json()).structuredContent.state, null);

    const missingToken = await fetch(ui.url + "api/sync", { method: "POST" });
    assert.equal(missingToken.status, 403);
    const foreignOrigin = await fetch(ui.url + "api/sync", {
      method: "POST",
      headers: { "X-Requirement-Graph-Token": ui.csrfToken, Origin: "https://evil.example" }
    });
    assert.equal(foreignOrigin.status, 403);
    const synced = await fetch(ui.url + "api/sync", {
      method: "POST",
      headers: { "X-Requirement-Graph-Token": ui.csrfToken, Origin: ui.url.slice(0, -1) }
    });
    assert.equal(synced.status, 200);
    assert.equal((await synced.json()).structuredContent.syncedFiles, 1);
  } finally {
    await ui.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  process.stdout.write("web test passed\n");
}

main().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
