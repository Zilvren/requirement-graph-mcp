const fs = require("node:fs");
const path = require("node:path");
const { ensureGraphGitignore, graphDirectory, resolveProjectRoot } = require("./project");

// Map view state is deliberately separate from the requirement graph. It is a
// local, per-project UI preference and must never affect generated nodes,
// edges, source documents, or traceability data.
const STATE_FILE_NAME = "map-view-state.json";
const STATE_VERSION = 1;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_IDS = 600;
const MAX_NODE_POSITIONS = 500;
const MAX_ID_LENGTH = 512;
const MAX_COORDINATE = 1_000_000;
const RELATIONSHIP_SCOPES = new Set(["structural", "all"]);
const LAYER_DEPTHS = new Set(["1", "2", "3", "all"]);

function invalid(message) {
  const error = new Error(message);
  error.status = 400;
  error.code = "INVALID_MAP_VIEW_STATE";
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function validId(value, name, allowNull = false) {
  if (allowNull && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string") throw invalid(name + " must be a string.");
  const id = value.trim();
  if (!id || id.length > MAX_ID_LENGTH) throw invalid(name + " is invalid.");
  return id;
}

function idList(value, name) {
  if (!Array.isArray(value)) throw invalid(name + " must be an array.");
  if (value.length > MAX_IDS) throw invalid(name + " contains too many entries.");
  const ids = [];
  const seen = new Set();
  value.forEach((item) => {
    const id = validId(item, name + " entry");
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  });
  return ids;
}

function finiteNumber(value, name, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalid(name + " is invalid.");
  }
  return value;
}

function camera(value) {
  if (!isPlainObject(value)) throw invalid("camera must be an object.");
  return {
    x: finiteNumber(value.x, "camera.x", -MAX_COORDINATE, MAX_COORDINATE),
    y: finiteNumber(value.y, "camera.y", -MAX_COORDINATE, MAX_COORDINATE),
    scale: finiteNumber(value.scale, "camera.scale", 0.25, 3)
  };
}

function nodePositions(value) {
  if (!Array.isArray(value)) throw invalid("nodePositions must be an array.");
  if (value.length > MAX_NODE_POSITIONS) throw invalid("nodePositions contains too many entries.");
  const positions = [];
  const seen = new Set();
  value.forEach((item) => {
    if (!isPlainObject(item)) throw invalid("nodePositions entry must be an object.");
    const id = validId(item.id, "nodePositions id");
    if (seen.has(id)) return;
    seen.add(id);
    positions.push({
      id,
      x: finiteNumber(item.x, "nodePositions.x", -MAX_COORDINATE, MAX_COORDINATE),
      y: finiteNumber(item.y, "nodePositions.y", -MAX_COORDINATE, MAX_COORDINATE)
    });
  });
  return positions;
}

function normalizeMapViewState(raw) {
  if (!isPlainObject(raw)) throw invalid("Map view state must be a JSON object.");
  if (raw.version !== STATE_VERSION) throw invalid("Unsupported map view state version.");
  if (!RELATIONSHIP_SCOPES.has(raw.relationshipScope)) throw invalid("relationshipScope is invalid.");
  if (!LAYER_DEPTHS.has(raw.layerDepth)) throw invalid("layerDepth is invalid.");
  const expandedIds = idList(raw.expandedIds, "expandedIds");
  const collapsedIds = idList(raw.collapsedIds, "collapsedIds");
  const collapsed = new Set(collapsedIds);
  const layoutRevision = raw.layoutRevision === undefined || raw.layoutRevision === null
    ? "" : validId(raw.layoutRevision, "layoutRevision");
  if (layoutRevision.length > 128) throw invalid("layoutRevision is invalid.");
  if (typeof raw.showCrossRelations !== "boolean") throw invalid("showCrossRelations must be a boolean.");
  return {
    version: STATE_VERSION,
    layoutRevision,
    relationshipScope: raw.relationshipScope,
    layerDepth: raw.layerDepth,
    expandedIds: expandedIds.filter((id) => !collapsed.has(id)),
    collapsedIds,
    selectedId: validId(raw.selectedId, "selectedId", true),
    focusedId: validId(raw.focusedId, "focusedId", true),
    showCrossRelations: raw.showCrossRelations,
    camera: camera(raw.camera),
    nodePositions: nodePositions(raw.nodePositions)
  };
}

function mapViewStatePath(projectPath) {
  return path.join(graphDirectory(resolveProjectRoot(projectPath)), STATE_FILE_NAME);
}

function readMapViewState(projectPath) {
  try {
    const source = fs.readFileSync(mapViewStatePath(projectPath), "utf8");
    if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) return null;
    return normalizeMapViewState(JSON.parse(source));
  } catch (error) {
    // A corrupt or old local preference must never keep the graph page from
    // opening. The next successful interaction replaces it with a valid file.
    return null;
  }
}

function writeMapViewState(projectPath, raw) {
  const state = normalizeMapViewState(raw);
  const target = mapViewStatePath(projectPath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  ensureGraphGitignore(directory);
  const source = JSON.stringify(state, null, 2) + "\n";
  if (Buffer.byteLength(source, "utf8") > MAX_STATE_BYTES) throw invalid("Map view state is too large.");
  const temporary = target + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(temporary, source, "utf8");
    fs.renameSync(temporary, target);
  } finally {
    try {
      fs.rmSync(temporary, { force: true });
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
    }
  }
  return state;
}

function removeMapViewState(projectPath) {
  try {
    fs.rmSync(mapViewStatePath(projectPath), { force: true });
  } catch (error) {
    if (!error || (error.code !== "ENOENT" && error.code !== "EACCES")) throw error;
  }
}

module.exports = {
  LAYER_DEPTHS,
  MAX_STATE_BYTES,
  RELATIONSHIP_SCOPES,
  STATE_FILE_NAME,
  STATE_VERSION,
  mapViewStatePath,
  normalizeMapViewState,
  readMapViewState,
  removeMapViewState,
  writeMapViewState
};
