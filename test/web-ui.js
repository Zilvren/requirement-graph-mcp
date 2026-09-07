const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const hierarchyApi = require("../src/requirement-hierarchy");
const { RequirementGraph, projectDbPath } = require("../src/db");
const { importPath } = require("../src/importer");
const { startWebServer } = require("../src/web");

async function testLayeredInteractions(html) {
  class StubElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.attributes = {};
      this.listeners = {};
      this.value = "";
      this.hidden = false;
      const classes = new Set();
      this.classList = {
        add: (value) => classes.add(value), remove: (value) => classes.delete(value),
        toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value)
      };
    }
    get firstChild() { return this.children[0]; }
    appendChild(child) { this.children.push(child); return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    fire(type, options = {}) {
      for (const listener of this.listeners[type] || []) listener({ preventDefault() {}, stopPropagation() {}, ...options });
    }
    getBoundingClientRect() { return { width: 1200, height: 800 }; }
    setPointerCapture() {}
    focus() {}
    select() {}
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, new StubElement("DIV"));
    return elements.get(id);
  };
  get("layer-depth").value = "2";
  get("reader-view").hidden = true;
  const markdownBody = [
    "# 阅读标题",
    "",
    "正文含有 **粗体**、*斜体* 和 `inline_code`。",
    "",
    "- 无序项一",
    "- [安全链接](https://example.test/docs)",
    "",
    "| 字段 | 说明 |",
    "| :--- | ---: |",
    "| `feedback_id` | <img src=x onerror=window.__tableXss=true> |",
    "| status | **处理状态** |",
    "",
    "1. 有序项一",
    "2. 有序项二",
    "",
    "---",
    "",
    "![嵌入架构图](data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlB9HcAAAAASUVORK5CYII=)",
    "![不安全 SVG](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)",
    "",
    "```json",
    "<script>window.__markdownXss = true</script>",
    "```",
    "",
    "<script>window.__rawMarkdownXss = true</script>",
    "<img src=x onerror=window.__markdownXss=true>",
    "[不安全链接](javascript:window.__markdownXss=true)"
  ].join("\n");
  const incompleteTableBody = [
    "字段 | 说明",
    "--- | ---",
    "这一行缺少第二列"
  ].join("\n");
  const fixture = {
    nodes: ["root", "group", "leaf", "nested", "right", "right-leaf"].map((id) => ({
      id, title: id, kind: "requirement",
      body: id === "nested" ? markdownBody : (id === "right" ? incompleteTableBody : "")
    })),
    edges: [
      ["group", "root", "CHILD_OF"], ["right", "root", "CHILD_OF"],
      ["leaf", "group", "CHILD_OF"], ["nested", "leaf", "CHILD_OF"],
      ["right-leaf", "right", "CHILD_OF"], ["nested", "root", "DERIVES_FROM"],
      ["leaf", "right", "SUPPORTS"]
    ].map(([source, target, relationType], index) => ({ id: String(index), source, target, relationType })),
    sources: [], warnings: [], relationshipScope: "structural", projectPath: "D:\\fixture-project"
  };
  const alternateFixture = {
    nodes: [{ id: "alternate", title: "alternate", kind: "requirement", body: "alternate project body" }],
    edges: [], sources: [], warnings: [], relationshipScope: "structural", projectPath: "D:\\alternate-project"
  };
  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(String(key), String(value)); }
  };
  let persistedMapState = null;
  const requests = [];
  const fetchStub = async (url, options = {}) => {
    const requestUrl = String(url);
    requests.push({ url: requestUrl, options });
    if (requestUrl.includes("/api/projects")) {
      return {
        ok: true,
        json: async () => ({
          structuredContent: {
            projects: [
              { id: "fixture-project", name: "fixture-project", root: "D:\\fixture-project" },
              { id: "alternate-project", name: "alternate-project", root: "D:\\alternate-project" }
            ]
          }
        })
      };
    }
    if (requestUrl.includes("/api/project-selection")) {
      return {
        ok: true,
        json: async () => ({ structuredContent: { projectPath: "D:\\alternate-project", selectionToken: "alternate-project-token" } })
      };
    }
    if (requestUrl.includes("/api/map-view-state")) {
      if (options.method === "PUT") {
        persistedMapState = JSON.parse(options.body);
        return { ok: true, json: async () => ({ structuredContent: { state: persistedMapState } }) };
      }
      if (options.method === "DELETE") {
        persistedMapState = null;
        return { ok: true, json: async () => ({ structuredContent: { deleted: true } }) };
      }
      return { ok: true, json: async () => ({ structuredContent: { state: persistedMapState } }) };
    }
    const graphFixture = requestUrl.includes("project=alternate-project-token") ? alternateFixture : fixture;
    return { ok: true, json: async () => ({ structuredContent: graphFixture }) };
  };
  const windowStub = {
    RequirementGraphHierarchy: hierarchyApi, addEventListener() {}, clearTimeout() {},
    setTimeout(callback) { callback(); return 1; }, localStorage
  };
  const context = vm.createContext({
    window: windowStub, URLSearchParams, Map, Set,
    document: { getElementById: get, querySelector: () => get("map-view"), createElement: (name) => new StubElement(name), createElementNS: (_, name) => new StubElement(name) },
    fetch: fetchStub
  });
  const script = Array.from(html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)).map((match) => match[1]).find((body) => body.includes("const config = window.__REQUIREMENT_GRAPH_WEB__"));
  assert.ok(script);
  vm.runInContext(script, context, { timeout: 2000 });
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.ok(get("project-picker").children.some((option) => option.value === "D:\\alternate-project"),
    "the registered project dropdown loads from the local project list");
  function bootReloadedUi() {
    const reloadedElements = new Map();
    const reloadedGet = (id) => {
      if (!reloadedElements.has(id)) reloadedElements.set(id, new StubElement("DIV"));
      return reloadedElements.get(id);
    };
    reloadedGet("layer-depth").value = "2";
    reloadedGet("reader-view").hidden = true;
    const reloadedWindow = {
      RequirementGraphHierarchy: hierarchyApi, addEventListener() {}, clearTimeout() {},
      setTimeout(callback) { callback(); return 1; }, localStorage
    };
    const reloadedContext = vm.createContext({
      window: reloadedWindow, URLSearchParams, Map, Set,
      document: { getElementById: reloadedGet, querySelector: () => reloadedGet("map-view"), createElement: (name) => new StubElement(name), createElementNS: (_, name) => new StubElement(name) },
      fetch: fetchStub
    });
    vm.runInContext(script, reloadedContext, { timeout: 2000 });
    return reloadedGet;
  }
  const cards = () => get("nodes").children.filter((item) => /^node(?:\s|$)/.test(item.attributes.class || ""));
  const titles = () => cards().map((item) => item.attributes["aria-label"]).sort();
  const toggle = (id) => get("nodes").children.find((item) => item.attributes.class === "node-toggle" && item.attributes["aria-label"].endsWith("：" + id));
  const crossEdges = () => get("edges").children.filter((item) => /\bcross\b/.test(item.attributes.class || ""));
  const descendants = (root, tagName) => {
    const result = [];
    for (const child of root.children || []) {
      if (String(child.tagName || "").toUpperCase() === tagName) result.push(child);
      result.push(...descendants(child, tagName));
    }
    return result;
  };
  const renderedText = (root) => [root.textContent || "", ...(root.children || []).map(renderedText)].join("");
  assert.deepEqual(titles(), ["group", "right", "root"]);
  const root = cards().find((item) => item.attributes["aria-label"] === "root");
  root.fire("pointerdown", { pointerId: 1, clientX: 10, clientY: 10 });
  get("graph").fire("pointerup", { pointerId: 1, clientX: 10, clientY: 10, timeStamp: 100 });
  assert.equal(get("detail-title").textContent, "root", "a single click keeps the node selected in the map");
  assert.equal(get("reader-view").hidden, true, "a single click must not navigate away from the map");
  assert.equal(root.attributes["aria-description"], "单击查看关系；双击阅读正文");
  assert.equal(toggle("group").attributes["aria-expanded"], "false");
  get("graph").fire("wheel", { deltaY: -1 });
  const cameraBeforeToggle = get("camera").attributes.transform;
  toggle("group").fire("click");
  assert.equal(get("camera").attributes.transform, cameraBeforeToggle, "expanding keeps the user's pan and zoom; only Fit reframes the canvas");
  assert.deepEqual(titles(), ["group", "leaf", "right", "root"]);
  assert.equal(crossEdges().length, 0);
  cards().find((item) => item.attributes["aria-label"] === "leaf").fire("keydown", { key: "Enter" });
  assert.equal(crossEdges().length, 0, "selecting must not implicitly expose cross-relations");
  get("show-cross-relations").fire("click");
  assert.equal(crossEdges().length, 1);
  get("show-cross-relations").fire("click");
  toggle("leaf").fire("keydown", { key: "Enter" });
  assert.ok(titles().includes("nested"));
  toggle("group").fire("click");
  assert.deepEqual(titles(), ["group", "right", "root"]);
  get("search").value = "nested";
  get("search").fire("input");
  assert.deepEqual(titles(), ["group", "leaf", "nested", "root"]);
  assert.equal(toggle("group").attributes["aria-disabled"], "true");
  let nestedCard = cards().find((item) => item.attributes["aria-label"] === "nested");
  nestedCard.fire("pointerdown", { pointerId: 2, clientX: 20, clientY: 20 });
  get("graph").fire("pointerup", { pointerId: 2, clientX: 20, clientY: 20, timeStamp: 1000 });
  assert.equal(get("reader-view").hidden, true, "the first click of a double click remains in the map");
  nestedCard = cards().find((item) => item.attributes["aria-label"] === "nested");
  nestedCard.fire("pointerdown", { pointerId: 3, clientX: 20, clientY: 20 });
  get("graph").fire("pointerup", { pointerId: 3, clientX: 20, clientY: 20, timeStamp: 1200 });
  await new Promise(setImmediate);
  assert.equal(get("reader-document-title").textContent, "nested");
  assert.equal(get("reader-view").hidden, false, "a double click opens node reading");
  assert.equal(get("map-view").hidden, true, "a double click leaves the map for node reading");
  const selectedReaderItems = get("reader-document-list").children.filter((item) => /\bis-selected\b/.test(item.className || ""));
  assert.equal(selectedReaderItems.length, 1, "the matching reader node stays selected");
  assert.equal(selectedReaderItems[0].children[0].textContent, "nested");
  const renderedNodeBody = get("reader-document-content");
  assert.equal(descendants(renderedNodeBody, "H1").length, 1, "ATX headings render as headings");
  assert.equal(renderedText(descendants(renderedNodeBody, "H1")[0]), "阅读标题");
  assert.equal(renderedText(descendants(renderedNodeBody, "STRONG")[0]), "粗体", "strong Markdown renders safely");
  assert.equal(renderedText(descendants(renderedNodeBody, "EM")[0]), "斜体", "emphasis Markdown renders safely");
  assert.ok(descendants(renderedNodeBody, "CODE").some((item) => renderedText(item) === "inline_code"), "inline code renders as code");
  assert.equal(descendants(renderedNodeBody, "UL").length, 1, "unordered lists render as lists");
  assert.equal(descendants(renderedNodeBody, "OL").length, 1, "ordered lists render as lists");
  assert.equal(descendants(renderedNodeBody, "HR").length, 1, "horizontal rules render as rules");
  const markdownTables = descendants(renderedNodeBody, "TABLE");
  assert.equal(markdownTables.length, 1, "a valid pipe table renders as a table");
  assert.equal(descendants(markdownTables[0], "THEAD").length, 1);
  assert.equal(descendants(markdownTables[0], "TBODY").length, 1);
  assert.equal(descendants(markdownTables[0], "TH").length, 2);
  assert.equal(descendants(markdownTables[0], "TD").length, 4);
  assert.ok(descendants(markdownTables[0], "CODE").some((item) => renderedText(item) === "feedback_id"), "table cells support inline Markdown");
  assert.equal(descendants(markdownTables[0], "IMG").length, 0, "raw HTML in a table cell is never parsed");
  assert.equal(windowStub.__tableXss, undefined, "raw table HTML never executes");
  assert.match(renderedText(markdownTables[0]), /<img src=x onerror=window\.__tableXss=true>/);
  const codeBlocks = descendants(renderedNodeBody, "PRE");
  assert.equal(codeBlocks.length, 1, "fenced Markdown renders as a code block");
  assert.match(renderedText(codeBlocks[0]), /<script>window\.__markdownXss = true<\/script>/, "fenced content remains literal text");
  const renderedLinks = descendants(renderedNodeBody, "A");
  assert.equal(renderedLinks.length, 1, "only allowlisted links become anchors");
  assert.equal(renderedLinks[0].attributes.href, "https://example.test/docs");
  assert.equal(renderedLinks[0].attributes.target, "_blank");
  assert.equal(renderedLinks[0].attributes.rel, "noopener noreferrer");
  assert.equal(descendants(renderedNodeBody, "SCRIPT").length, 0, "raw script tags are never parsed into DOM");
  const renderedImages = descendants(renderedNodeBody, "IMG");
  assert.equal(renderedImages.length, 1, "allowlisted Base64 Markdown images render as images");
  assert.equal(renderedImages[0].attributes.alt, "嵌入架构图");
  assert.match(renderedImages[0].attributes.src, /^data:image\/png;base64,/);
  assert.equal(renderedImages[0].attributes.loading, "lazy");
  assert.match(renderedText(renderedNodeBody), /data:image\/svg\+xml;base64/, "SVG data URLs stay harmless Markdown text");
  assert.equal(windowStub.__rawMarkdownXss, undefined, "raw script text never executes");
  assert.doesNotMatch(renderedText(renderedNodeBody), /^$/, "the Markdown renderer preserves a text fallback");
  assert.match(renderedText(renderedNodeBody), /javascript:window\.__markdownXss=true/, "unsafe links remain harmless text");
  const incompleteTableReaderItem = get("reader-document-list").children.find((item) => item.children && item.children[0] && item.children[0].textContent === "right");
  incompleteTableReaderItem.fire("click");
  assert.equal(descendants(get("reader-document-content"), "TABLE").length, 0, "an incomplete pipe table stays ordinary text");
  assert.match(renderedText(get("reader-document-content")), /字段 \| 说明/);
  assert.match(renderedText(get("reader-document-content")), /这一行缺少第二列/);
  assert.ok(Array.from(storage.values()).includes("right"), "an explicit reader choice is stored by project");
  const reloadedGet = bootReloadedUi();
  await new Promise(setImmediate);
  assert.ok(persistedMapState, "map interactions are stored through the local map-state API");
  assert.equal(reloadedGet("layer-depth").value, persistedMapState.layerDepth, "the saved layer preference is restored before rendering");
  assert.equal(
    reloadedGet("camera").attributes.transform,
    "translate(" + persistedMapState.camera.x + " " + persistedMapState.camera.y + ") scale(" + persistedMapState.camera.scale + ")",
    "an unchanged hierarchy restores the saved camera"
  );
  reloadedGet("reader-view-control").fire("click");
  await new Promise(setImmediate);
  assert.equal(reloadedGet("reader-document-title").textContent, "right", "the reader restores its saved node after reload");
  const reloadedSelectedItems = reloadedGet("reader-document-list").children.filter((item) => /\bis-selected\b/.test(item.className || ""));
  assert.equal(reloadedSelectedItems.length, 1, "the restored node remains selected in the left reader menu");
  assert.equal(reloadedSelectedItems[0].children[0].textContent, "right");
  const emptyReaderItem = get("reader-document-list").children.find((item) => item.children && item.children[0] && item.children[0].textContent === "root");
  emptyReaderItem.fire("click");
  assert.equal(get("reader-document-content").textContent, "（此需求节点尚未填写正文。）", "empty node bodies keep the plain-text fallback");
  get("map-view-control").fire("click");
  get("search").value = "";
  get("search").fire("input");
  assert.deepEqual(titles(), ["group", "right", "root"], "clearing search restores collapsed branches");
  get("layer-depth").value = "3";
  get("layer-depth").fire("change");
  assert.deepEqual(titles(), ["group", "leaf", "right", "right-leaf", "root"]);
  get("layer-depth").value = "all";
  get("layer-depth").fire("change");
  assert.equal(cards().length, 6);
  get("layer-depth").value = "1";
  get("layer-depth").fire("change");
  assert.deepEqual(titles(), ["root"]);
  get("search").value = "unmatched";
  get("search").fire("input");
  assert.deepEqual(titles(), []);
  assert.equal(get("empty").hidden, false);
  get("reset-map-state").fire("click");
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(persistedMapState, null, "Reset map clears the project-local saved view");
  get("project-picker").value = "D:\\alternate-project";
  get("project-picker").fire("change");
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(get("project-label").textContent, "alternate-project", "switching updates the visible project label");
  assert.deepEqual(titles(), ["alternate"], "switching replaces the current graph rather than merging projects");
  assert.ok(requests.some((request) => request.url.includes("/api/projects")), "the picker reads the registered project list");
  assert.ok(requests.some((request) => request.url.includes("/api/project-selection") && request.options.method === "POST"));
  assert.ok(requests.some((request) => request.url.includes("/api/graph?") && request.url.includes("project=alternate-project-token")),
    "all graph reads after selection carry the server-issued project token");
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-graph-web-ui-"));
  process.env.REQUIREMENT_GRAPH_HOME = path.join(projectRoot, "rg-home");
  try {
    const documentPath = path.join(projectRoot, "requirement.md");
    const originalDocument = "---\nid: WEB-ONLY\ntitle: Web-only requirement\n---\n# Web-only requirement\n\nThe UI must only use Requirement Graph data.\n";
    fs.writeFileSync(documentPath, originalDocument, "utf8");
    const graph = new RequirementGraph(projectDbPath(projectRoot));
    importPath(graph, documentPath);
    const generatedDocumentId = graph.upsertDocument({
      sourcePath: "codex://requirement-graph/test/generated/WEB-GEN.json",
      format: "codex-generated",
      content: "{\"stable_id\":\"WEB-GEN\"}",
      checksum: "generated-web-gen"
    });
    graph.upsertNode({
      documentId: generatedDocumentId,
      stableId: "WEB-GEN",
      title: "Generated web requirement",
      kind: "goal",
      body: "The generated requirement body must be readable in the node reader.",
      metadata: {
        origin: "codex_generated",
        source_document_ids: ["WEB-ONLY"],
        source_refs: [{ path: documentPath, excerpt: "The UI must only use Requirement Graph data." }]
      }
    });
    graph.close();
    const codeGraphDirectory = path.join(projectRoot, ".codegraph");
    fs.mkdirSync(codeGraphDirectory, { recursive: true });
    fs.writeFileSync(path.join(codeGraphDirectory, "codegraph.db"), "not a SQLite database", "utf8");

    const ui = await startWebServer(projectRoot, { port: 0 });
    try {
      const root = await fetch(ui.url);
      assert.equal(root.status, 200);
      const html = await root.text();
      const configMatch = html.match(/window\.__REQUIREMENT_GRAPH_WEB__ = ([\s\S]*?);<\/script>/);
      assert.ok(configMatch);
      assert.equal(JSON.parse(configMatch[1]).source, "requirements");
      assert.equal(JSON.parse(configMatch[1]).relationshipScope, "structural");
      assert.match(html, /window\.RequirementGraphHierarchy/);
      assert.match(html, /deriveSingleParentHierarchy/);
      assert.match(html, /id="show-cross-relations"/);
      assert.match(html, /id="layer-depth"/);
      assert.match(html, /value="2" selected/);
      assert.match(html, /"aria-expanded"/);
      assert.match(html, /layoutHierarchySubtrees/);
      await testLayeredInteractions(html);
      assert.match(html, /function layoutHierarchy/);
      assert.match(html, /showCrossRelations/);
      assert.doesNotMatch(html, /id="data-source"/);
      assert.doesNotMatch(html, /id="detail-level"/);
      assert.doesNotMatch(html, /<option[^>]+value="(?:codegraph|both)"/);
      assert.doesNotMatch(html, /postMessage|ui\/initialize|requirement_graph_render_canvas|CodeGraph/);
      assert.match(html, /class:\s*"shape node-card"/);
      assert.match(html, /"data-node-shape":\s*"card"/);
      assert.match(html, /\.node-card\s*\{[\s\S]*?stroke:/);
      assert.match(html, /height:\s*40/);
      assert.match(html, /rx:\s*0/);
      assert.match(html, /function edgeEndpoint/);
      assert.match(html, /id="reader-document-list"/);
      assert.match(html, /id="reader-document-content"/);
      assert.match(html, /<div id="reader-document-content"[^>]*>/);
      assert.doesNotMatch(html, /<pre id="reader-document-content"/);
      assert.match(html, /function renderMarkdownContent/);
      assert.match(html, /function safeMarkdownLinkHref/);
      assert.match(html, /function safeMarkdownImageSrc/);
      assert.match(html, /function parseMarkdownTable/);
      assert.match(html, /markdown-table-scroll/);
      assert.doesNotMatch(html, /\.innerHTML\s*=/);
      assert.match(html, /class="reader-info"/);
      assert.match(html, /grid-template-columns:\s*minmax\(240px, 300px\) minmax\(0, 1fr\) minmax\(240px, 300px\)/);
      assert.match(html, /REQUIREMENT NODES/);
      assert.match(html, /NODE CONTENT/);
      assert.match(html, /SOURCE EVIDENCE/);
      assert.match(html, /id="reader-node-evidence"/);
      assert.match(html, /单击查看关系，双击阅读正文/);
      assert.match(html, /function refreshReaderNodes/);
      assert.match(html, /function readerNodeSourceRefs/);
      assert.match(html, /id="project-path"/);
      assert.match(html, /id="switch-project"/);
      assert.match(html, /id="project-picker"/);
      assert.match(html, /function openProjectPath/);
      assert.match(html, /function refreshProjectPicker/);
      assert.match(html, /\/api\/projects/);
      assert.match(html, /apiUrl\("\/api\/graph"/);
      assert.doesNotMatch(html, /reader-load-more|\/api\/documents|\/api\/document\?/);
      assert.match(html, /\.layout, \.reader-view\s*\{\s*grid-row:\s*4;/);
      assert.match(html, /\.legend\[hidden\]/);
      assert.match(html, /const legend = document\.getElementById\("legend"\);/);
      assert.match(html, /legend\.hidden = readerActive;/);
      assert.match(html, /\.layout\[hidden\], \.toolbar\[hidden\]/);
      assert.doesNotMatch(html, /reader-inbound|reader-outbound|上游关系|下游关系/);

      const response = await fetch(ui.url + "api/graph");
      assert.equal(response.status, 200);
      const requirementGraph = (await response.json()).structuredContent;
      assert.equal(requirementGraph.source, "requirements");
      assert.equal(requirementGraph.detail, "documents");
      assert.equal(requirementGraph.relationshipScope, "structural");
      assert.deepEqual(requirementGraph.sources.map((source) => source.source), ["requirements"]);
      assert.ok(requirementGraph.nodes.every((node) => node.source === "requirements"));
      assert.ok(requirementGraph.edges.every((edge) => edge.sourceKind === "requirements"));
      assert.doesNotMatch(requirementGraph.warnings.join(" "), /CodeGraph/i);
      const generatedNode = requirementGraph.nodes.find((node) => node.id === "rg:WEB-GEN");
      assert.ok(generatedNode);
      assert.equal(generatedNode.body, "The generated requirement body must be readable in the node reader.");
      assert.equal(generatedNode.metadata.origin, "codex_generated");
      assert.deepEqual(generatedNode.metadata.source_document_ids, ["WEB-ONLY"]);
      assert.deepEqual(generatedNode.metadata.source_refs, [{
        path: documentPath,
        excerpt: "The UI must only use Requirement Graph data."
      }]);

      const documentsResponse = await fetch(ui.url + "api/documents");
      assert.equal(documentsResponse.status, 200);
      const documents = (await documentsResponse.json()).structuredContent;
      assert.equal(documents.documents.length, 1);
      const documentInfo = documents.documents.find((item) => item.stableId === "WEB-ONLY");
      assert.ok(documentInfo);
      const original = await fetch(ui.url + "api/document?id=" + documentInfo.documentId);
      assert.equal(original.status, 200);
      assert.equal((await original.json()).structuredContent.document.content, originalDocument);

      for (const source of ["requirements", "auto", "both", "codegraph"]) {
        const rejected = await fetch(ui.url + "api/graph?source=" + source);
        assert.equal(rejected.status, 400);
      }
      for (const detail of ["auto", "symbols"]) {
        const rejected = await fetch(ui.url + "api/graph?detail=" + detail);
        assert.equal(rejected.status, 400);
      }
    } finally {
      await ui.close();
    }
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  process.stdout.write("web UI test passed\n");
}

main().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
