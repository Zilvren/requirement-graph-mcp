const fs = require("node:fs");
const path = require("node:path");

const DATA_DIRECTORY_NAME = ".requirement-graph";
const GITIGNORE_MARKER = "# Requirement Graph data files — local to each machine, not for committing.";
const GENERATED_GITIGNORE = GITIGNORE_MARKER + "\n*\n!.gitignore\n";

function resolveProjectRoot(projectPath) {
  const absolute = path.resolve(projectPath);
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile() ? path.dirname(absolute) : absolute;
}

function graphDirectory(projectPath) {
  return path.join(resolveProjectRoot(projectPath), DATA_DIRECTORY_NAME);
}

function hasBareStar(content) {
  return content.split(/\r?\n/).some((line) => line.trim() === "*");
}

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
  ensureGraphGitignore,
  graphDirectory,
  resolveProjectRoot
};
