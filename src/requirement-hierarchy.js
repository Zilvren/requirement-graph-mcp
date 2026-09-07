(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.RequirementGraphHierarchy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PARENT_RELATION_TYPES = new Set(["CHILD_OF", "DERIVES_FROM"]);

  function compareText(left, right) {
    return String(left).localeCompare(String(right));
  }

  function relationRank(edge) {
    return edge && edge.relationType === "CHILD_OF" ? 0 : 1;
  }

  function compareEdges(left, right) {
    return relationRank(left) - relationRank(right)
      || compareText(left && left.id, right && right.id)
      || compareText(left && left.source, right && right.source)
      || compareText(left && left.target, right && right.target);
  }

  function sorted(values) {
    return Array.from(values).sort(compareText);
  }

  function findCycleNodeIds(parentCandidates) {
    const state = new Map();
    const stack = [];
    const cyclicNodeIds = new Set();

    function visit(nodeId) {
      state.set(nodeId, "visiting");
      stack.push(nodeId);
      const candidate = parentCandidates.get(nodeId);
      const parentId = candidate && candidate.parentId;
      if (parentId && parentCandidates.has(parentId)) {
        if (state.get(parentId) === "visiting") {
          const cycleStart = stack.indexOf(parentId);
          stack.slice(cycleStart).forEach(function (id) { cyclicNodeIds.add(id); });
        } else if (state.get(parentId) !== "done") {
          visit(parentId);
        }
      }
      stack.pop();
      state.set(nodeId, "done");
    }

    sorted(parentCandidates.keys()).forEach(function (nodeId) {
      if (!state.has(nodeId)) visit(nodeId);
    });
    return cyclicNodeIds;
  }

  function deriveSingleParentHierarchy(nodes, edges) {
    const nodeIds = new Set((Array.isArray(nodes) ? nodes : []).map(function (node) {
      return String(node && node.id || "");
    }).filter(Boolean));
    const candidatesByChild = new Map();
    const cyclicNodeIds = new Set();

    (Array.isArray(edges) ? edges : []).forEach(function (edge) {
      if (!edge || !PARENT_RELATION_TYPES.has(edge.relationType)) return;
      const childId = String(edge.source || "");
      const parentId = String(edge.target || "");
      if (!nodeIds.has(childId) || !nodeIds.has(parentId)) return;
      let candidates = candidatesByChild.get(childId);
      if (!candidates) {
        candidates = new Map();
        candidatesByChild.set(childId, candidates);
      }
      const existing = candidates.get(parentId);
      if (!existing || compareEdges(edge, existing) < 0) candidates.set(parentId, edge);
    });

    const parentCandidates = new Map();
    const ambiguousNodeIds = new Set();
    sorted(nodeIds).forEach(function (childId) {
      const candidates = candidatesByChild.get(childId);
      if (!candidates || candidates.size === 0) return;
      // CHILD_OF is containment; DERIVES_FROM is source evidence and only a
      // legacy parent fallback when there is no explicit containment edge.
      const explicitParentIds = sorted(Array.from(candidates.keys()).filter(function (id) {
        return candidates.get(id).relationType === "CHILD_OF";
      }));
      const parentIds = explicitParentIds.length ? explicitParentIds : sorted(candidates.keys());
      if (parentIds.length !== 1) {
        ambiguousNodeIds.add(childId);
        return;
      }
      const parentId = parentIds[0];
      parentCandidates.set(childId, { parentId: parentId, edge: candidates.get(parentId) });
    });

    findCycleNodeIds(parentCandidates).forEach(function (nodeId) { cyclicNodeIds.add(nodeId); });
    cyclicNodeIds.forEach(function (nodeId) { parentCandidates.delete(nodeId); });

    const parentByChild = new Map();
    const parentEdgeIds = new Set();
    const childrenByParent = new Map();
    sorted(parentCandidates.keys()).forEach(function (childId) {
      const candidate = parentCandidates.get(childId);
      parentByChild.set(childId, candidate.parentId);
      if (candidate.edge && candidate.edge.id !== undefined && candidate.edge.id !== null) {
        parentEdgeIds.add(String(candidate.edge.id));
      }
      const children = childrenByParent.get(candidate.parentId) || [];
      children.push(childId);
      childrenByParent.set(candidate.parentId, children);
    });
    childrenByParent.forEach(function (children, parentId) {
      childrenByParent.set(parentId, sorted(children));
    });

    return {
      parentByChild: parentByChild,
      childrenByParent: childrenByParent,
      rootIds: sorted(Array.from(nodeIds).filter(function (nodeId) { return !parentByChild.has(nodeId); })),
      parentEdgeIds: parentEdgeIds,
      ambiguousNodeIds: ambiguousNodeIds,
      cyclicNodeIds: cyclicNodeIds
    };
  }

  function projectHierarchy(nodes, edges, options) {
    options = options || {};
    const hierarchy = deriveSingleParentHierarchy(nodes, edges);
    const nodeIds = new Set(nodes.map(function (node) { return String(node.id); }));
    const depthLimit = options.depth === "all" ? Infinity : Math.max(1, Number(options.depth) || 2);
    const expanded = options.expandedIds || new Set();
    const collapsed = options.collapsedIds || new Set();
    const matchedIds = options.matchingIds === undefined ? null : new Set(options.matchingIds);
    const visibleIds = new Set();
    const depthById = new Map();
    const descendantCountById = new Map();
    const hiddenDescendantCountById = new Map();

    function countDescendants(id) {
      const children = hierarchy.childrenByParent.get(id) || [];
      const count = children.reduce(function (sum, childId) { return sum + 1 + countDescendants(childId); }, 0);
      descendantCountById.set(id, count);
      return count;
    }
    function walk(id, depth, visible) {
      depthById.set(id, depth);
      if (visible) visibleIds.add(id);
      const descend = visible && !collapsed.has(id) && (depth < depthLimit || expanded.has(id));
      (hierarchy.childrenByParent.get(id) || []).forEach(function (childId) { walk(childId, depth + 1, descend); });
    }
    hierarchy.rootIds.forEach(function (id) { countDescendants(id); walk(id, 1, true); });
    if (matchedIds !== null) {
      visibleIds.clear();
      matchedIds.forEach(function (id) {
        if (!nodeIds.has(id)) return;
        let current = id;
        while (current && !visibleIds.has(current)) {
          visibleIds.add(current);
          current = hierarchy.parentByChild.get(current);
        }
      });
    }
    function countVisibleDescendants(id) {
      const count = (hierarchy.childrenByParent.get(id) || []).reduce(function (sum, childId) {
        return sum + (visibleIds.has(childId) ? 1 : 0) + countVisibleDescendants(childId);
      }, 0);
      hiddenDescendantCountById.set(id, descendantCountById.get(id) - count);
      return count;
    }
    hierarchy.rootIds.forEach(countVisibleDescendants);
    return {
      hierarchy: hierarchy,
      nodes: nodes.filter(function (node) { return visibleIds.has(String(node.id)); }),
      edges: edges.filter(function (edge) { return visibleIds.has(String(edge.source)) && visibleIds.has(String(edge.target)); }),
      visibleIds: visibleIds,
      depthById: depthById,
      descendantCountById: descendantCountById,
      hiddenDescendantCountById: hiddenDescendantCountById,
      matchingIds: matchedIds,
      searchActive: matchedIds !== null
    };
  }

  // Left-to-right tidy forest: each parent's descendants own a disjoint
  // vertical interval. Unlike per-depth grids, sibling branches never interleave.
  function layoutHierarchySubtrees(nodes, hierarchy, cardSize) {
    const nodeById = new Map(nodes.map(function (node) { return [String(node.id), node]; }));
    const children = new Map();
    const depthById = new Map();
    const widths = [];
    const spans = new Map();
    const result = new Map();
    const siblingGap = 22;
    const levelGap = 72;
    const rootGap = 64;
    const roots = sorted(Array.from(nodeById.keys()).filter(function (id) {
      return !nodeById.has(hierarchy.parentByChild.get(id));
    }));
    function measure(id, depth) {
      const size = cardSize(nodeById.get(id));
      depthById.set(id, depth);
      widths[depth] = Math.max(widths[depth] || 0, size.width);
      const childIds = (hierarchy.childrenByParent.get(id) || []).filter(function (childId) { return nodeById.has(childId); });
      children.set(id, childIds);
      const childHeight = childIds.reduce(function (sum, childId) { return sum + measure(childId, depth + 1); }, 0)
        + siblingGap * Math.max(0, childIds.length - 1);
      const span = Math.max(size.height, childHeight);
      spans.set(id, span);
      return span;
    }
    roots.forEach(function (id) { measure(id, 0); });
    const levelX = [];
    let x = 0;
    widths.forEach(function (width, index) { levelX[index] = x + width / 2; x += width + levelGap; });
    function place(id, top) {
      const childIds = children.get(id);
      const span = spans.get(id);
      result.set(id, { x: levelX[depthById.get(id)], y: top + span / 2 });
      const childHeight = childIds.reduce(function (sum, childId) { return sum + spans.get(childId); }, 0)
        + siblingGap * Math.max(0, childIds.length - 1);
      let nextTop = top + (span - childHeight) / 2;
      childIds.forEach(function (childId) { place(childId, nextTop); nextTop += spans.get(childId) + siblingGap; });
    }
    let top = 0;
    roots.forEach(function (id) { place(id, top); top += spans.get(id) + rootGap; });
    return result;
  }

  return {
    parentRelationTypes: ["CHILD_OF", "DERIVES_FROM"],
    deriveSingleParentHierarchy: deriveSingleParentHierarchy,
    projectHierarchy: projectHierarchy,
    layoutHierarchySubtrees: layoutHierarchySubtrees
  };
});
