const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Per-user data holds the project registry, web-daemon state, and legacy
// central graph databases. New graph databases live in their project root.
// Override this location (tests, portable setups) with REQUIREMENT_GRAPH_HOME.
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
    // Windows, so one directory always maps to exactly one project-local database.
    return fs.realpathSync(base);
  } catch {
    return base;
  }
}

// The graph database and per-project UI state intentionally travel with the
// selected project directory.
const DATA_DIRECTORY_NAME = ".requirement-graph";
const PROJECT_DATABASE_FILE = "requirements-graph.db";

function graphDirectory(projectPath) {
  return path.join(resolveProjectRoot(projectPath), DATA_DIRECTORY_NAME);
}

function localProjectDbPath(projectPath) {
  return path.join(graphDirectory(projectPath), PROJECT_DATABASE_FILE);
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
  PROJECT_DATABASE_FILE,
  centralDbPath,
  dataHome,
  encodeRoot,
  ensureGraphGitignore,
  graphDirectory,
  localProjectDbPath,
  registryFile,
  resolveProjectRoot
};
