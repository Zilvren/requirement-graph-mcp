const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  mapViewStatePath,
  normalizeMapViewState,
  readMapViewState,
  removeMapViewState,
  writeMapViewState
} = require("../src/map-view-state");

function sampleState(overrides = {}) {
  return {
    version: 1,
    layoutRevision: "layout-v1",
    relationshipScope: "structural",
    layerDepth: "2",
    expandedIds: ["root", "group"],
    collapsedIds: ["leaf"],
    selectedId: "leaf",
    focusedId: null,
    showCrossRelations: true,
    camera: { x: 120, y: -44, scale: 0.9 },
    nodePositions: [{ id: "root", x: 200, y: 100 }],
    ...overrides
  };
}

function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-graph-map-view-"));
  try {
    const state = writeMapViewState(projectRoot, sampleState({
      expandedIds: ["root", "root", "leaf"],
      collapsedIds: ["leaf"]
    }));
    assert.deepEqual(state.expandedIds, ["root"], "collapsed entries win over expanded entries");
    assert.deepEqual(readMapViewState(projectRoot), state);
    assert.ok(fs.existsSync(mapViewStatePath(projectRoot)));
    assert.match(fs.readFileSync(path.join(projectRoot, ".requirement-graph", ".gitignore"), "utf8"), /^\*/m);

    assert.throws(() => normalizeMapViewState(sampleState({ relationshipScope: "unexpected" })), /relationshipScope/);
    assert.throws(() => normalizeMapViewState(sampleState({ camera: { x: 0, y: 0, scale: 9 } })), /camera\.scale/);
    assert.throws(() => normalizeMapViewState(sampleState({ nodePositions: [{ id: "root", x: Infinity, y: 0 }] })), /nodePositions\.x/);

    fs.writeFileSync(mapViewStatePath(projectRoot), "{ definitely not JSON", "utf8");
    assert.equal(readMapViewState(projectRoot), null, "a corrupt local preference safely falls back to defaults");

    writeMapViewState(projectRoot, sampleState());
    removeMapViewState(projectRoot);
    assert.equal(readMapViewState(projectRoot), null);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  process.stdout.write("map view state test passed\n");
}

main();
