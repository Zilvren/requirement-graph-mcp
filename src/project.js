const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Central, per-user data home. Every project's graph database lives here,
// keyed by the canonical project root it was created from, so a single MCP
// registration can serve any number of repositories/folders by switching the
// active project id. Override the location (tests, portable setups) with the
// REQUIREMENT_GRAPH_HOME environment variable.
function dataHome() {
  return path.resolve(process.env.REQUIREMENT_GRAPH_HOME || path.join(os.homedir(), ".requirement-graph"));
}

function encodeRoot(projectPath) {
  return Buffer.from(path.resolve(projectPath)).toString("base64url");
}

function centralDbPath(projectPath) {
  const root = resolveProjectRoot(projectPath);
  return path.join(dataHome(), "data", encodeRoot(root) + ".db");
}

function registryFile() {
  return path.join(dataHome(), "projects.json");
}

function resolveProjectRoot(projectPath) {
  const absolute = path.resolve(projectPath);
  let base = absolute;
  try {
    if (fs.statSync(absolute).isFile()) base = path.dirname(absolute);
  } catch {
    // Path does not exist yet; keep it as given.
  }
  try {
    // realpath collapses 8.3 short names, case differences and symlinks on
    // Windows, so one directory always maps to exactly one central database.
    return fs.realpathSync(base);
  } catch {
    return base;
  }
}

// Kept only for per-project web-daemon state files; graph data itself is central.
const DATA_DIRECTORY_NAME = ".requirement-graph";

function graphDirectory(projectPath) {
  return path.join(resolveProjectRoot(projectPath), DATA_DIRECTORY_NAME);
}

module.exports = {
  DATA_DIRECTORY_NAME,
  centralDbPath,
  dataHome,
  encodeRoot,
  graphDirectory,
  registryFile,
  resolveProjectRoot
};
