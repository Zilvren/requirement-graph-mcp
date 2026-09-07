const fs = require("node:fs");
const path = require("node:path");
const { dataHome, registryFile, resolveProjectRoot } = require("./project");

// A lightweight registry that maps a stable, human-readable project id to a
// project root (any directory: a single repo, a monorepo root, a package
// folder). It exists so MCP/CLI can switch projects by id across many folders
// without requiring a per-project working-directory configuration. Graph
// databases live under their selected project root; older central databases
// remain a compatibility fallback.

function readRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryFile(), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.projects && typeof parsed.projects === "object") {
      return { active: typeof parsed.active === "string" ? parsed.active : null, projects: parsed.projects };
    }
  } catch {
    // Missing or corrupt registry: start empty. A later register() rewrites it.
  }
  return { active: null, projects: {} };
}

function writeRegistry(state) {
  fs.mkdirSync(dataHome(), { recursive: true });
  fs.writeFileSync(registryFile(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

function projectName(root) {
  return path.basename(root) || root;
}

function idForName(state, name, root) {
  const base = String(name).replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  let id = base;
  let counter = 2;
  while (Object.prototype.hasOwnProperty.call(state.projects, id)) {
    if (state.projects[id].root === root) return id;
    id = base + "-" + counter;
    counter += 1;
  }
  return id;
}

function normalizeRoot(value) {
  return resolveProjectRoot(String(value || ""));
}

function entryByRoot(state, root) {
  for (const [id, project] of Object.entries(state.projects)) {
    if (project.root === root) return { id, project };
  }
  return null;
}

function registerProject(projectPath) {
  const root = normalizeRoot(projectPath);
  const state = readRegistry();
  const existing = entryByRoot(state, root);
  if (existing) return { id: existing.id, root, name: existing.project.name, registered: false };
  const name = projectName(root);
  const id = idForName(state, name, root);
  state.projects[id] = { name, root };
  writeRegistry(state);
  return { id, root, name, registered: true };
}

function listProjects() {
  const state = readRegistry();
  return Object.entries(state.projects)
    .map(([id, project]) => ({ id, name: project.name, root: project.root }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Resolves a user-provided reference to a registered project root.
// Accepts: an absolute directory path (registered on first use), a project id,
// or a unique project name. Returns { id, root } or null.
function resolveProject(reference) {
  const raw = String(reference || "").trim();
  if (!raw) return null;
  const state = readRegistry();
  const byRoot = entryByRoot(state, normalizeRoot(raw));
  if (byRoot) return { id: byRoot.id, root: byRoot.project.root };
  const byId = state.projects[raw];
  if (byId) return { id: raw, root: byId.root };
  const matches = Object.entries(state.projects).filter(([, project]) => project.name === raw);
  if (matches.length === 1) return { id: matches[0][0], root: matches[0][1].root };
  if (fs.existsSync(raw)) return registerProject(raw);
  return null;
}

function activeProject() {
  const state = readRegistry();
  if (!state.active) return null;
  const project = state.projects[state.active];
  return project ? { id: state.active, root: project.root, name: project.name } : null;
}

function setActiveProject(reference) {
  const resolved = resolveProject(reference);
  if (!resolved) return null;
  const state = readRegistry();
  state.active = resolved.id;
  writeRegistry(state);
  return { id: resolved.id, root: resolved.root, name: state.projects[resolved.id].name };
}

function removeProject(reference) {
  const state = readRegistry();
  const resolved = resolveProject(reference);
  if (!resolved || !Object.prototype.hasOwnProperty.call(state.projects, resolved.id)) return null;
  delete state.projects[resolved.id];
  if (state.active === resolved.id) state.active = null;
  writeRegistry(state);
  return resolved;
}

module.exports = {
  activeProject,
  listProjects,
  readRegistry,
  registerProject,
  removeProject,
  resolveProject,
  setActiveProject
};
