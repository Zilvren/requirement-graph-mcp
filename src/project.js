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

// Kept only for per-project state files that intentionally travel with a
// project (for example the map-view-state UI preference); graph databases
// themselves are central.
const DATA_DIRECTORY_NAME = ".requirement-graph";

function graphDirectory(projectPath) {
  return path.join(resolveProjectRoot(projectPath), DATA_DIRECTORY_NAME);
}

const GITIGNORE_MARKER = "# Requirement Graph data files — local to each machine, not for committing.";
const GENERATED_GITIGNORE = GITIGNORE_MARKER + "\n*\n!.gitignore\n";

function hasBareStar(content) {
  return content.split(/\r?\n/).some((line) => line.trim() === "*");
}

// Ensures a project-local state directory never becomes part of the project's
// committed files: it carries its own .gitignore that ignores everything but
// the rule itself.
function ensureGraphGitignore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, ".gitignore");
  let existing;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
    fs.writeFileSync(file, GENERATED_GITIGNORE, "utf8");
    return { path: file, status: "created" };
  }
  if (existing.includes(GITIGNORE_MARKER) && !hasBareStar(existing)) {
    fs.writeFileSync(file, GENERATED_GITIGNORE, "utf8");
    return { path: file, status: "upgraded" };
  }
  return { path: file, status: "unchanged" };
}

module.exports = {
  DATA_DIRECTORY_NAME,
  GENERATED_GITIGNORE,
  GITIGNORE_MARKER,
  centralDbPath,
  dataHome,
  encodeRoot,
  ensureGraphGitignore,
  graphDirectory,
  registryFile,
  resolveProjectRoot
};
