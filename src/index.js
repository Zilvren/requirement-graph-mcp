#!/usr/bin/env node
const path = require("node:path");
const { RequirementGraph, defaultDbPath, projectDbPath } = require("./db");
const { importPath } = require("./importer");
const { startMcpServer } = require("./mcp");
const { startWebServer } = require("./web");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function usage() {
  process.stdout.write([
    "Requirement Graph MCP",
    "",
    "Commands:",
    "  init [project-path] [--db path]",
    "  import <path> [--project project-path] [--db path]",
    "  status [project-path] [--db path]",
    "  serve --mcp [--db path]",
    "  ui [project-path] [--project project-path] [--port port] [--host 127.0.0.1]",
    "  web [project-path] [--project project-path] [--port port] [--host 127.0.0.1]",
    "  serve --web [project-path] [--project project-path] [--port port] [--host 127.0.0.1]"
  ].join("\n") + "\n");
}

function firstPositional(args) {
  const optionsWithValues = new Set(["--db", "--project", "--port", "--host"]);
  for (let index = 1; index < args.length; index += 1) {
    if (optionsWithValues.has(args[index])) {
      index += 1;
      continue;
    }
    if (!args[index].startsWith("--")) return args[index];
  }
  return undefined;
}

function localProjectDatabase(args, positional) {
  const custom = option(args, "--db");
  if (custom) return custom;
  return projectDbPath(option(args, "--project") || positional || process.cwd());
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const database = option(args, "--db");
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (command === "serve" && args.includes("--mcp") && args.includes("--web")) {
    throw new Error("Choose either --mcp or --web, not both.");
  }
  if (command === "ui" || command === "web" || (command === "serve" && args.includes("--web"))) {
    if (database) throw new Error("Web UI uses the selected project's .requirement-graph database; --db is not supported.");
    const projectPath = option(args, "--project") || firstPositional(args) || process.cwd();
    const instance = await startWebServer(projectPath, {
      host: option(args, "--host"),
      port: option(args, "--port")
    });
    process.stdout.write([
      "Requirement Graph UI",
      "Project: " + instance.projectRoot,
      "URL: " + instance.url,
      "Press Ctrl+C to stop."
    ].join("\n") + "\n");
    return;
  }
  if (command === "serve" && args.includes("--mcp")) return startMcpServer(database);
  if (command === "init") {
    const graph = new RequirementGraph(localProjectDatabase(args, args[1]));
    process.stdout.write(JSON.stringify(graph.stats(), null, 2) + "\n");
    graph.close();
    return;
  }
  if (command === "import" && args[1]) {
    const graph = new RequirementGraph(localProjectDatabase(args));
    process.stdout.write(JSON.stringify(importPath(graph, path.resolve(args[1])), null, 2) + "\n");
    graph.close();
    return;
  }
  if (command === "status" || command === "stats") {
    const graph = new RequirementGraph(localProjectDatabase(args, args[1]));
    process.stdout.write(JSON.stringify(graph.stats(), null, 2) + "\n");
    graph.close();
    return;
  }
  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write("Requirement Graph failed: " + error.message + "\n");
  process.exitCode = 1;
});
