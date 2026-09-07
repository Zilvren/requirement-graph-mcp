#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { RequirementGraph, projectDbPath } = require("./db");
const { importPath } = require("./importer");
const { startMcpServer } = require("./mcp");
const { startWebServer } = require("./web");
const { stopWebServer } = require("./web-daemon");
const { activeProject, listProjects, registerProject, removeProject, resolveProject, setActiveProject } = require("./registry");

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
    "  import <path> [--project project-path|id] [--db path]",
    "  status [project-path] [--db path]",
    "  project list|add <dir>|use <dir|id>|active|rm <dir|id>",
    "  serve --mcp [--db path]",
    "  ui [project-path] [--project project-path|id] [--port port] [--host 127.0.0.1]",
    "  web [project-path] [--project project-path|id] [--port port] [--host 127.0.0.1]",
    "  web stop [project-path] [--project project-path|id]  stop the project's persistent web UI daemon",
    "  serve --web [project-path] [--project project-path|id] [--port port] [--host 127.0.0.1]",
    "",
    "Graph databases are stored centrally under the user data directory",
    "(REQUIREMENT_GRAPH_HOME or ~/.requirement-graph), keyed by project root."
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

// Resolves a "--project" value that may be a real directory path or a
// registered project id; falls back to the current directory.
function projectRootOption(args, positional) {
  const value = option(args, "--project") || positional || process.cwd();
  try {
    if (fs.statSync(value).isDirectory()) return path.resolve(value);
  } catch {
    // Not a path: try the registry.
  }
  const resolved = resolveProject(value);
  return resolved ? resolved.root : path.resolve(value);
}

function localProjectDatabase(args, positional) {
  const custom = option(args, "--db");
  if (custom) return custom;
  return projectDbPath(projectRootOption(args, positional));
}

function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const database = option(args, "--db");
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }
  if (command === "project") {
    const sub = args[1];
    if (sub === "list") {
      printJson({ projects: listProjects(), active: activeProject() });
      return;
    }
    if (sub === "active") {
      printJson(activeProject());
      return;
    }
    if (sub === "add" && args[2]) {
      printJson(registerProject(args[2]));
      return;
    }
    if (sub === "use" && args[2]) {
      const switched = setActiveProject(args[2]);
      if (!switched) throw new Error("Unknown project reference: " + args[2]);
      printJson(switched);
      return;
    }
    if (sub === "rm" && args[2]) {
      const removed = removeProject(args[2]);
      if (!removed) throw new Error("Unknown project reference: " + args[2]);
      printJson(removed);
      return;
    }
    throw new Error("Usage: project list | add <dir> | use <dir|id> | active | rm <dir|id>");
  }
  if (command === "web" && args[1] === "stop") {
    const projectPath = projectRootOption(args, args[2]);
    printJson(await stopWebServer(projectPath));
    return;
  }
  if (command === "serve" && args.includes("--mcp") && args.includes("--web")) {
    throw new Error("Choose either --mcp or --web, not both.");
  }
  if (command === "ui" || command === "web" || (command === "serve" && args.includes("--web"))) {
    if (database) throw new Error("The web UI uses the central per-project database; --db is not supported.");
    const projectPath = projectRootOption(args, firstPositional(args));
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
    printJson(graph.stats());
    graph.close();
    return;
  }
  if (command === "import" && args[1]) {
    const graph = new RequirementGraph(localProjectDatabase(args));
    printJson(importPath(graph, path.resolve(args[1])));
    graph.close();
    return;
  }
  if (command === "status" || command === "stats") {
    const graph = new RequirementGraph(localProjectDatabase(args, args[1]));
    printJson(graph.stats());
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
