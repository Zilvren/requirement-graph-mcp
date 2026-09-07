const assert = require("node:assert/strict");
const { deriveSingleParentHierarchy, projectHierarchy, layoutHierarchySubtrees } = require("../src/requirement-hierarchy");

function nodes() {
  return Array.from(arguments).map((id) => ({ id }));
}

function edge(id, source, target, relationType) {
  return { id, source, target, relationType };
}

{
  const hierarchy = deriveSingleParentHierarchy(nodes("document", "requirement", "child"), [
    edge("derived", "requirement", "document", "DERIVES_FROM"),
    edge("nested", "child", "requirement", "CHILD_OF")
  ]);
  assert.equal(hierarchy.parentByChild.get("requirement"), "document");
  assert.equal(hierarchy.parentByChild.get("child"), "requirement");
  assert.deepEqual(hierarchy.childrenByParent.get("document"), ["requirement"]);
  assert.deepEqual(hierarchy.rootIds, ["document"]);
  assert.deepEqual(Array.from(hierarchy.parentEdgeIds).sort(), ["derived", "nested"]);
}

{
  const hierarchy = deriveSingleParentHierarchy(nodes("parent", "child"), [
    edge("derived", "child", "parent", "DERIVES_FROM"),
    edge("nested", "child", "parent", "CHILD_OF")
  ]);
  assert.equal(hierarchy.parentByChild.get("child"), "parent");
  assert.deepEqual(Array.from(hierarchy.parentEdgeIds), ["nested"]);
}

{
  const hierarchy = deriveSingleParentHierarchy(nodes("left", "right", "child"), [
    edge("left-parent", "child", "left", "CHILD_OF"),
    edge("right-parent", "child", "right", "DERIVES_FROM")
  ]);
  assert.equal(hierarchy.parentByChild.get("child"), "left");
  assert.equal(hierarchy.ambiguousNodeIds.has("child"), false);
  assert.equal(hierarchy.rootIds.includes("child"), false);
  assert.deepEqual(Array.from(hierarchy.parentEdgeIds), ["left-parent"]);
}

{
  for (const relationType of ["CHILD_OF", "DERIVES_FROM"]) {
    const hierarchy = deriveSingleParentHierarchy(nodes("left", "right", "child", "source"), [
      edge("left", "child", "left", relationType),
      edge("right", "child", "right", relationType),
      edge("source", "child", "source", "DERIVES_FROM")
    ]);
    assert.equal(hierarchy.parentByChild.has("child"), false);
    assert.equal(hierarchy.ambiguousNodeIds.has("child"), true);
  }
}

{
  const hierarchy = deriveSingleParentHierarchy(nodes("self", "source"), [
    edge("self", "self", "self", "CHILD_OF"),
    edge("source", "self", "source", "DERIVES_FROM")
  ]);
  assert.equal(hierarchy.parentByChild.has("self"), false);
  assert.equal(hierarchy.cyclicNodeIds.has("self"), true);
}

{
  const hierarchy = deriveSingleParentHierarchy(nodes("parent", "child"), [
    edge("business-only", "child", "parent", "SUPPORTS")
  ]);
  assert.equal(hierarchy.parentByChild.size, 0);
  assert.equal(hierarchy.parentEdgeIds.size, 0);
}

{
  const hierarchy = deriveSingleParentHierarchy(nodes("a", "b"), [
    edge("a-to-b", "a", "b", "CHILD_OF"),
    edge("b-to-a", "b", "a", "CHILD_OF")
  ]);
  assert.equal(hierarchy.parentByChild.size, 0);
  assert.deepEqual(Array.from(hierarchy.cyclicNodeIds).sort(), ["a", "b"]);
  assert.deepEqual(hierarchy.rootIds, ["a", "b"]);
}

{
  const allNodes = nodes("document", "a", "b", "a1", "a2", "b1", "deep", "other-document");
  const allEdges = [
    edge("a-parent", "a", "document", "CHILD_OF"), edge("b-parent", "b", "document", "CHILD_OF"),
    edge("a1-parent", "a1", "a", "CHILD_OF"), edge("a2-parent", "a2", "a", "CHILD_OF"),
    edge("b1-parent", "b1", "b", "CHILD_OF"), edge("deep-parent", "deep", "a1", "CHILD_OF"),
    edge("evidence", "deep", "other-document", "DERIVES_FROM"), edge("dependency", "deep", "b1", "DEPENDS_ON")
  ];
  const ids = (projection) => Array.from(projection.visibleIds).sort();
  const initial = projectHierarchy(allNodes, allEdges);
  assert.deepEqual(ids(initial), ["a", "b", "document", "other-document"]);
  assert.equal(initial.hiddenDescendantCountById.get("a"), 3);
  assert.equal(initial.descendantCountById.get("document"), 6);
  assert.equal(initial.hierarchy.parentByChild.get("deep"), "a1");
  const expanded = new Set(["a"]);
  assert.deepEqual(ids(projectHierarchy(allNodes, allEdges, { expandedIds: expanded })), ["a", "a1", "a2", "b", "document", "other-document"]);
  const collapsed = new Set(["a"]);
  assert.deepEqual(ids(projectHierarchy(allNodes, allEdges, { depth: "all", collapsedIds: collapsed })), ["a", "b", "b1", "document", "other-document"]);
  const searched = projectHierarchy(allNodes, allEdges, { matchingIds: ["deep"], collapsedIds: collapsed });
  assert.deepEqual(ids(searched), ["a", "a1", "deep", "document"]);
  assert.equal(searched.edges.some((item) => item.id === "dependency" || item.id === "evidence"), false);
  assert.deepEqual(ids(projectHierarchy(allNodes, allEdges, { matchingIds: [] })), []);
  assert.deepEqual(ids(projectHierarchy(allNodes, allEdges, { depth: 1 })), ["document", "other-document"]);
  assert.deepEqual(ids(projectHierarchy(allNodes, allEdges, { depth: "all" })), allNodes.map((node) => node.id).sort());
  assert.deepEqual(ids(projectHierarchy(allNodes, allEdges, { collapsedIds: collapsed })), ids(initial));

  const cardSize = (node) => ({ width: node.id === "document" ? 300 : 180, height: node.id === "a1" ? 64 : 40 });
  const positions = layoutHierarchySubtrees(allNodes, initial.hierarchy, cardSize);
  assert.equal(positions.size, allNodes.length);
  for (let i = 0; i < allNodes.length; i += 1) {
    for (let j = i + 1; j < allNodes.length; j += 1) {
      const a = allNodes[i]; const b = allNodes[j];
      const p = positions.get(a.id); const q = positions.get(b.id);
      const width = (cardSize(a).width + cardSize(b).width) / 2;
      const height = (cardSize(a).height + cardSize(b).height) / 2;
      assert.ok(Math.abs(p.x - q.x) >= width || Math.abs(p.y - q.y) >= height, a.id + " overlaps " + b.id);
    }
  }
  assert.ok(Math.max(...["a", "a1", "a2", "deep"].map((id) => positions.get(id).y + cardSize(allNodes.find((node) => node.id === id)).height / 2))
    < Math.min(...["b", "b1"].map((id) => positions.get(id).y - cardSize(allNodes.find((node) => node.id === id)).height / 2)));
  assert.deepEqual(layoutHierarchySubtrees(allNodes.slice().reverse(), initial.hierarchy, cardSize), positions);
}

process.stdout.write("hierarchy test passed\n");
