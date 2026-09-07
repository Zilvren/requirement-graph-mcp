---
name: project-graph-canvas
description: Use the separately configured local Requirement Graph MCP to analyze project documents, generate traceable requirement graphs, inspect traceability, and open its standalone local web UI.
---

# Requirement Graph Web

This optional plugin contains only behavior guidance. The requirement_graph
MCP server must be registered separately in Codex before using this skill.

The graph visual is a standalone local webpage. It reads the Requirement
Graph database only; external code indexes are outside this workflow.

## Choose the operation

At the start of the conversation, activate the project being discussed by calling
requirement_graph_use_project once with its directory path (switch later by calling it again).
Every tool then acts on that project; do not ask the user to supply tool names, call syntax, or a
project path on each call.

- **View or open:** call requirement_graph_open_web and open or return its
  localhost URL. A view-only request does not authorize import, sync, or
  regeneration, even if the graph is sparse. This is the sole visual path;
  do not substitute a static diagram or Mermaid.
- **Import or refresh:** use requirement_graph_import for relevant source
  files, or requirement_graph_sync for already imported documents. These
  operations index source records and explicit links, not semantic requirements.
- **Generate, split, or reorganize:** analyze the requested material and use
  the generation workflow below. Do not treat importing and opening as a
  completed generation request.

## Decomposition policy

Prefer at most three useful levels, following the user's requested scope:

| Level | Meaning | Example |
| --- | --- | --- |
| L1 | Project or document scope | Feedback API document |
| L2 | Business capability or domain group | AI batch processing |
| L3 | Coherent deliverable requirement | Submit an AI processing job |

An imported document can serve as L1: do not generate a duplicate document
container. Group by business meaning, not by every heading or sentence. A
capability often has 3-7 meaningful children, but this is a readability guide,
not a quota. Simple material may need fewer levels; collapse redundant
single-child groups. There is no target total node count.

Keep closely related parameters, field definitions, null handling, permissions,
error codes, and acceptance checks in the deliverable's structured body or
metadata.acceptance_criteria. For example, an endpoint and its request,
response, authorization, idempotency, and failure rules normally form one
requirement, not six leaves. Use L4 only if the user explicitly requests more
detail or a complex sub-capability is independently deliverable. Do not add a
level just to fill a tree or split each validation into its own node.

Use CHILD_OF from child to its unique owning parent; ownership must be acyclic.
A unique CHILD_OF takes precedence over DERIVES_FROM when displaying hierarchy.
Keep source_document_ids for **all** mapped imported sources on every generated
node, including children; these DERIVES_FROM evidence links do not create
competing parents. Always retain metadata.source_refs with source paths and
supporting excerpts. If a source has no stable_id, cite its path rather than
inventing an ID.

Document-declared relations are confirmed. Conservative inferred cross-relations
are proposed with confidence at most 0.8. Do not fabricate edges for visual
connectedness. Plain Markdown REFERENCES remain weak citations, hidden by
default unless the user asks for that layer.

## Generate or reorganize

1. For document-driven work, import or refresh only the relevant sources. Call
   requirement_graph_documents, then read every relevant document through all
   next_offset pages with requirement_graph_read_document until EOF. For a
   natural-language request, analyze the supplied description directly; do not
   ask the user to author documents or JSON.
2. Inspect the existing generated graph when revising it. Analyze the sources
   under the decomposition policy; preserve requirements outside the requested
   scope. When reducing granularity, merge details and evidence into retained
   bodies or acceptance criteria, remap justified cross-relations, deduplicate
   them, and drop self-relations created by merging. Keep a recoverable backup
   of the prior generated graph; do not delete imported documents or history.
3. Validate the complete nodes and edges, source mappings, unique parents, and
   absence of cycles. Each generated node needs an evidence-backed source link
   or a non-self relationship. Call requirement_graph_replace once with the
   complete generated layer, not successive partial payloads.
4. After replacement succeeds, call requirement_graph_open_web. Report the
   useful levels, node/edge counts, important unresolved or proposed relations,
   and the returned local URL. Do not present inferred relations as facts.

The webpage reads only Requirement Graph data, not external code indexes. For
search, context, traceability, or impact questions, use the corresponding
read-only requirement_graph_* tools without regenerating the graph.
