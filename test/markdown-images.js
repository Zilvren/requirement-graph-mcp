const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RequirementGraph } = require("../src/db");
const { importPath } = require("../src/importer");
const { embedMarkdownImages } = require("../src/markdown-images");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-graph-markdown-images-"));
const root = path.join(temporary, "docs");
const outsidePath = path.join(temporary, "outside.png");
try {
  fs.mkdirSync(root);
  const images = path.join(root, "images");
  fs.mkdirSync(images);
  const imagePath = path.join(images, "architecture diagram.png");
  const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  fs.writeFileSync(imagePath, imageBytes);
  fs.writeFileSync(path.join(root, "unsafe.svg"), "<svg onload=alert(1) />", "utf8");
  fs.writeFileSync(outsidePath, imageBytes);
  const sourcePath = path.join(root, "overview.md");
  const inline = "data:image/png;base64,iVBORw0KGgo=";
  const result = embedMarkdownImages([
    "![Architecture](<images/architecture diagram.png>)",
    "![Inline](" + inline + ")",
    "![Outside](../outside.png)",
    "![SVG](unsafe.svg)",
    "![Remote](https://example.test/diagram.png)"
  ].join("\n"), sourcePath);

  assert.match(result, new RegExp("!\\[Architecture\\]\\(data:image/png;base64," + imageBytes.toString("base64") + "\\)"));
  assert.match(result, new RegExp("!\\[Inline\\]\\(" + inline + "\\)"), "already inline data is not rewritten");
  assert.match(result, /!\[Outside\]\(\.\.\/outside\.png\)/, "the importer never escapes the source document directory");
  assert.match(result, /!\[SVG\]\(unsafe\.svg\)/, "SVG stays source text rather than becoming an active image data URL");
  assert.match(result, /!\[Remote\]\(https:\/\/example\.test\/diagram\.png\)/, "remote images are never fetched during import");

  fs.writeFileSync(sourcePath, [
    "---",
    "id: IMAGE-TEST",
    "---",
    "# Image test",
    "",
    "![Architecture](<images/architecture diagram.png>)"
  ].join("\n"), "utf8");
  const graph = new RequirementGraph(path.join(temporary, "graph.db"));
  try {
    importPath(graph, sourcePath);
    assert.match(graph.context("IMAGE-TEST").node.body, /data:image\/png;base64,/,
      "the importer stores the portable image form in the node body");
    assert.match(graph.readSourceDocument("IMAGE-TEST").document.content, /<images\/architecture diagram\.png>/,
      "the original Markdown document remains unchanged");
  } finally {
    graph.close();
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

process.stdout.write("markdown image test passed\n");
