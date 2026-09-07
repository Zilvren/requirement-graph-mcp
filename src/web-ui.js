const fs = require("node:fs");
const path = require("node:path");

function webUiHtml(options = {}) {
  const config = {
    projectPath: options.projectPath ? path.resolve(options.projectPath) : null,
    source: "requirements",
    relationshipScope: options.relationshipScope || "structural",
    apiBase: options.apiBase || "",
    csrfToken: options.csrfToken || null
  };
  const serialized = JSON.stringify(config)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  const html = fs.readFileSync(path.join(__dirname, "web-ui.html"), "utf8");
  const hierarchyScript = fs.readFileSync(path.join(__dirname, "requirement-hierarchy.js"), "utf8")
    .replace(/<\/script/gi, "<\\/script");
  return html.replace("</head>", "    <script>" + hierarchyScript + "</script>\n    <script>window.__REQUIREMENT_GRAPH_WEB__ = " + serialized + ";</script>\n</head>");
}

module.exports = { webUiHtml };
