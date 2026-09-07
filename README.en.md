# Requirement Graph MCP

> A fully local, personal requirement & document graph. Import Markdown / TXT / JSON / CSV into a
> per-project SQLite database, query requirement context, relations and impact scope through MCP,
> and visualise the graph in a local web page.
> **Local-first**: no Feishu/Notion cloud sync, nothing is uploaded to any external service.

[中文](./README.md) · [MIT License](./LICENSE)

[![npm version](https://img.shields.io/npm/v/requirement-graph-mcp)](https://www.npmjs.com/package/requirement-graph-mcp)
![Node.js >= 22.5](https://img.shields.io/badge/node-%3E%3D%2022.5-339933)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![No runtime dependencies](https://img.shields.io/badge/runtime%20deps-0-green)

---

## Table of Contents

- [What it is](#what-it-is)
- [Key features](#key-features)
- [Supported import formats](#supported-import-formats)
- [Quick start (local CLI)](#quick-start-local-cli)
- [Local web UI](#local-web-ui)
- [Any MCP client integration](#any-mcp-client-integration)
- [Codex MCP integration](#codex-mcp-integration) (Codex is just an example)
- [Optional Codex web plugin](#optional-codex-web-plugin)
- [Graph data principles](#graph-data-principles)
- [Testing](#testing)
- [Project layout](#project-layout)
- [License & copyright](#license--copyright)
- [Roadmap](#roadmap)

## What it is

Requirement Graph MCP is a **fully local** requirement & document graph tool that:

- imports your requirement/document files (Markdown, TXT, JSON, CSV) into SQLite;
- extracts structural relations from Frontmatter, explicit line labels and Wiki/Markdown links;
- exposes the graph over MCP so Codex can answer requirement, dependency and impact questions;
- provides a local web page (relation map + document reader) as the **only recommended graph visualisation**.

Every project owns its own database, stored **centrally in the user data directory** (default
`~/.requirement-graph`, override with the `REQUIREMENT_GRAPH_HOME` environment variable) and keyed by
the project directory. No hidden directory is ever written inside a project. Switching projects means
switching a project id (see “Multiple projects & switching” below); data never mixes across projects.
Nothing leaves your machine except the local web page you run yourself.

## Key features

- **Local-first, zero upload**: the database, web server and MCP server run locally and only bind to loopback addresses.
- **Zero runtime dependencies**: requires Node.js 22.5+; no runtime npm packages; `npm test` is a full self-check.
- **Multiple import formats**: Markdown / TXT / JSON / CSV, with Frontmatter and line-label relations for Markdown.
- **Confirmed vs proposed relations**: explicit relations are `confirmed`; conservative semantic inferences are `proposed` with confidence ≤ 0.8 — no invented dependencies.
- **Codex-friendly**: the MCP server announces itself for requirement/document/dependency/impact questions — ask in plain language.
- **Web visualisation**: a zoomable, draggable, searchable relation map with expandable layers and a per-project saved view, plus a reader view showing node body text and source evidence.

## Supported import formats

| Format | Handling |
| --- | --- |
| Markdown | YAML Frontmatter, first-level headings, Wiki links and relative Markdown links |
| TXT | One document node per file |
| JSON | An object, an array of objects, or an object with an `items` array |
| CSV | One node per row |

Frontmatter fields that create graph relations automatically:

| Field | Graph relation |
| --- | --- |
| `depends_on` | DEPENDS_ON |
| `blocked_by` | BLOCKED_BY |
| `related_to` | RELATED_TO |
| `implements` | IMPLEMENTS |
| `validates` | VALIDATES |
| `parent` | CHILD_OF |
| `derives_from` | DERIVES_FROM |

Give each node a stable ID. Relation targets may be node IDs, titles, file names or Wiki-link names;
even if the target file is imported later, relations are back-filled once the import finishes.

~~~md
---
id: REQ-AUTH-001
title: Support SMS verification code login
kind: requirement
depends_on: [REQ-PLATFORM-001]
related_to: [REQ-AUTH-002]
---

# Support SMS verification code login

The login policy is described in [[ADR-001-login-policy]].
~~~

Existing Markdown without Frontmatter can keep its natural style: lines explicitly prefixed with
labels such as `父需求：`/`Parent:`, `依赖：`/`Depends on:`, `前置：`/`Prerequisite:`,
`阻塞于：`/`Blocked by:`, `关联：`/`Related:`, `验证：`/`Validates:`, `验收：`/`Acceptance:`,
`支撑：`/`Supports:`, `实现：`/`Implements:` have their Markdown/Wiki links extracted as structural
relations. These are marked as “document-label recognition” — ordinary mentions in prose are never
guessed as dependencies; plain links stay low-confidence document references.

> Try it with [`examples/requirements`](./examples/requirements), which ships sample documents ready to import.

## Quick start (local CLI)

The package is published on npm: [requirement-graph-mcp](https://www.npmjs.com/package/requirement-graph-mcp).
**No source clone needed** — install it and go. Requires Node.js 22.5+; no runtime npm dependencies.

#### Option 1: global install (recommended for daily use and Codex MCP)

~~~powershell
npm install -g requirement-graph-mcp

cd D:\Work\my-app
requirement-graph init
requirement-graph import docs\requirements
requirement-graph status
~~~

#### Option 2: npx without installing (trials, scripts, throwaway environments)

~~~powershell
cd D:\Work\my-app
npx requirement-graph-mcp init
npx requirement-graph-mcp import docs\requirements
npx requirement-graph-mcp status
# equivalent: npx -p requirement-graph-mcp requirement-graph <command>
~~~

- `init` creates the central database entry for the current project in the **user data directory**
  (files are named after an encoding of the project directory); the first `import` also creates it.
  The project directory itself stays clean.
- Commands accept `--project` (a directory path or a registered id) or `--db` for a custom database path.

### Multiple projects & switching (project ids)

Any directory — a standalone repo, a monorepo root, or one of its subfolders — can be registered as a
“project” and gets a human-readable id:

~~~powershell
requirement-graph project add D:\Work\repo-a        # id defaults to the folder name
requirement-graph project add D:\Work\repo-b
requirement-graph project list                       # ids / roots / active
requirement-graph project use repo-b                 # switch the default project
requirement-graph status --project repo-a            # or pick one per invocation
~~~

Inside any MCP client the same switching is one call: the server instructs the agent to invoke
`requirement_graph_use_project` once with the project directory or id at the start of the session, after
which every tool acts on that project; `requirement_graph_list_projects` lists registered projects. So
moving between several repositories/folders is just switching an id — no per-project MCP configuration
and no working-directory setup.

## Local web UI

You can browse the same graph in a browser without opening Codex:

~~~powershell
# After a global install:
requirement-graph ui D:\Work\my-app

# Or with npx, no install needed:
npx requirement-graph-mcp ui D:\Work\my-app
~~~

The command prints a local address such as `http://127.0.0.1:4747/`. It starts at 4747 and tries the
next free port if occupied. This is the **only recommended graph visualisation**: it reads only the
central database of the selected project and offers two views — the relation
map and the node reader, which lists requirement nodes with their body text and recorded source evidence.

Optional arguments:

~~~powershell
# Fixed port; --port 0 lets the OS pick a free one
requirement-graph ui D:\Work\my-app --port 4750

# Equivalent, service-style invocation
requirement-graph serve --web --project D:\Work\my-app
~~~

The web server only binds to `127.0.0.1`, `::1` or `localhost` — it never listens on LAN interfaces.
It is pinned to the project given at startup and refuses web requests for other project paths.
Clicking “re-identify relations” writes to that project’s database.
Press `Ctrl+C` to stop.

#### Persistent: the web page no longer drops when a Codex session ends

When opened through Codex (MCP) via `requirement_graph_open_web`, the web page is served by an
**independent background daemon**, recorded in the user data directory (`web-ui/<encoded root>.json`). It is
not tied to the MCP stdio process: closing Codex, ending a session, or restarting Codex does not take
an already-opened graph page offline. The next session first probes the recorded daemon for health and,
when the same project is still served, reuses the exact same URL (returns `reused: true`) instead of
drifting to another port.

Stop a project’s persistent web UI with:

~~~powershell
requirement-graph web stop D:\Work\my-app
# or
requirement-graph web stop --project D:\Work\my-app
~~~

Running `requirement-graph ui` (or `serve --web`) directly in a terminal remains interactive and stops
with `Ctrl+C`; it shares the same loopback-only web implementation as the MCP daemon without conflict.

## Any MCP client integration

Requirement Graph MCP is a **standard MCP (stdio) server** — it is not tied to any particular agent.
Codex, Claude, Cursor, custom agents, or any MCP-capable client can connect. Most clients only need a
command and its arguments:

~~~json
{ "mcpServers": { "requirement-graph": { "command": "requirement-graph", "args": ["serve", "--mcp"] } } }
~~~

- **Windows note**: if the client cannot launch the `requirement-graph` shim from PATH (the `.cmd`
  problem), set `command` to the absolute `node` path and `args` to
  `["<npm global dir>\\node_modules\\requirement-graph-mcp\\src\\index.js", "serve", "--mcp"]`.
- **If the client insists on a “working directory / project directory” field**: fill in the project
  directory of your current session. The server auto-activates it as the default project (zero setup
  for a single project); to switch projects later, use `requirement_graph_use_project` and
  `requirement_graph_list_projects` in the conversation — no per-project MCP configuration is needed.

## Codex MCP integration

First install the CLI globally once (this provides the `requirement-graph` command; no source clone and
no npx needed — Codex spawns the MCP process repeatedly, so a resident global command is recommended):

~~~powershell
npm install -g requirement-graph-mcp
~~~

Then add the config below to `C:\Users\<you>\.codex\config.toml`:

~~~toml
[mcp_servers.requirement_graph]
command = "requirement-graph"
args = ["serve", "--mcp"]
~~~

After restarting Codex, it shows up as an available MCP. The server tells Codex to automatically use
the graph for requirement, document, dependency and impact-analysis questions and to call
`requirement_graph_use_project` once with the project directory at the start of the session (switching
is another call to the same tool). You never need to name the MCP, its tools or a project path — just
ask in plain language:

- “Import D:\Work\my-app\docs\requirements into the requirement graph.”
- “Show the requirement context and direct dependencies of REQ-AUTH-001 in D:\Work\my-app.”
- “What would change if REQ-AUTH-002 in D:\Work\my-app changed?”
- “Find requirements in D:\Work\my-app that have no relations.”

The `/mcp` slash command only shows connection status — it is not a manual tool picker. Everyday use is
plain natural language; no call syntax is needed.

## Optional Codex web plugin

When you say “show this project’s relation graph”, Codex should call `requirement_graph_open_web` and
open the returned localhost URL. The relation map is zoomable, draggable and searchable; clicking a node
shows its source file, kind and visible relations. The “node reader” lists requirement nodes with their
split body text and recorded source-evidence excerpts.

The web page’s data scope is fixed:

- **Requirement Graph only**: reads the central database of the active project.
- It does **not** read external code indexes or show code symbols, files, modules or code-relation layers.

The page shows structural relations such as `depends_on`, `implements`, `validates` and `parent` by
default. Plain Markdown/Wiki links are low-confidence `REFERENCES` — not confirmed dependencies; enable
them via “include document references” only when explicitly needed.

If a legacy graph only contains old document references, the page shows a “re-identify relations”
button. It only re-processes documents already imported into the current project’s database to promote
explicit labels to structural relations; it never scans or imports unrelated files.

The page always reads Requirement Graph requirements, documents and traceable relations. Layer
navigation only changes the displayed scope — it never re-splits, merges or deletes requirement data.
“Show layers” offers 1-layer documents, 2-layer groups (default), 3-layer requirements or all layers;
+/− on a node expands or collapses the next level; search spans layers while keeping each match’s
ancestor path, and clearing search restores the previous expansion state. Cross-relations are hidden by
default and shown on demand via “show cross relations”.

The relation map automatically saves a project-local `.requirement-graph\map-view-state.json`: relation
scope, layer depth, expansion, selection, cross-relation setting, camera and manually dragged node
positions. It never changes requirement nodes, edges, source documents or the SQLite graph. It survives
web-server restarts and port changes. When the graph structure changes, valid preferences and manual
positions remain while the camera is refit; search text is intentionally not saved. “Reset map” clears
the saved view for that project; stopping the web server does not.

Never open the web page with `file://` — without the local graph API it stalls at “reading the
requirement graph”. Always start it with `requirement-graph ui`; inside Codex, use the URL returned by
`requirement_graph_open_web`.

### Separate from MCP

The core package and the Codex plugin are two independent pieces. Register the MCP first; the plugin is
only a set of prompting rules:

~~~toml
[mcp_servers.requirement_graph]
command = "requirement-graph"
args = ["serve", "--mcp"]
~~~

Then optionally install `plugins\project-graph-canvas` (display name **Requirement Graph Web**). It only
carries rules about when to call the registered MCP and when to call `requirement_graph_open_web` to
open the localhost page. It does not start any service, re-configure the MCP, or hold any graph data.

## Graph data principles

### How many layers by default

The default is at most three meaningful layers, rather than one node per sentence, field or acceptance
check:

| Layer | Organising meaning | Example (feedback handling) |
| --- | --- | --- |
| L1 | Project or document scope | Feedback handling interface document |
| L2 | Business capability or domain group | AI batch processing |
| L3 | Independently deliverable, complete requirement | Submit AI-processing job interface |

Imported documents can serve directly as L1 — no duplicate same-named document node is created. A group
usually holds 3–7 meaningful children; this is a readability guideline, not a metric. Simple material
may be one or two layers; a group with a single child and no independent meaning should be collapsed.
Add L4 only when explicitly requested or when a complex sub-capability is genuinely deliverable on its
own. Never invent requirements just to hit a layer count or total node count.

Request parameters, response fields, permissions, idempotency, null handling, error codes and acceptance
checks of one interface usually live in the body or `metadata.acceptance_criteria` of the same
requirement node instead of spawning rows of children. Cross-interface public contracts may form separate
complete requirements. Directory layout and headings are only locating evidence; they do not decide the
business split.

### Ownership and source evidence

- `CHILD_OF` points from a child requirement to its **single owning parent** — no multiple parents or cycles.
- When showing layers, the unique `CHILD_OF` wins over `DERIVES_FROM` inference; only without an explicit
  ownership relation is the unique source used as a fallback parent.
- Every generated node (children included) still records all mapped `source_document_ids` and keeps
  paths with original excerpts in `metadata.source_refs`.
- `DERIVES_FROM` is source evidence and never overturns an existing unique ownership relation just because
  a requirement references several source documents. Sources without a stable ID keep only their path —
  IDs are never invented.
- Relations written explicitly in imported files are `confirmed`; conservative semantic inferences are
  `proposed` with confidence ≤ 0.8. Never fabricate dependencies to make the map connected — plain
  Markdown references remain mere references.

### Generating, viewing and lowering granularity

“Open the web page” only calls `requirement_graph_open_web` — it does not import, sync or rebuild.
Imports and syncs index only the source documents and their explicit links. A full generation reads all
relevant source text to EOF, analyses semantics and checks the whole graph, then calls
`requirement_graph_replace` once, and finally opens the web page.

When merging over-fine nodes, first inspect and back up the current generated graph; fold full details,
acceptance criteria and source evidence into the retained nodes, remap real cross-node relations,
deduplicate, and drop self-links created by the merge. Never drop detail, delete imported documents, or
treat partial local payloads as a whole-graph replacement. After an MCP description update, the new
instructions arrive on the next MCP connection initialisation — no forced restart of connected services.

## Testing

Self-contained tests with no third-party dependencies (run all of them with `npm test`):

~~~powershell
npm test
# equivalent to:
node test/hierarchy.js && node test/smoke.js && node test/web.js && node test/web-ui.js && node test/web-daemon.js && node test/map-view-state.js && node test/mcp-web.js
~~~

- `test/smoke.js` — import/query smoke test
- `test/hierarchy.js` — layers and relations
- `test/web.js` — web server
- `test/web-ui.js` — web UI
- `test/web-daemon.js` — persistent web-UI daemon (start / reuse / stop)
- `test/map-view-state.js` — map-view state validation and local persistence
- `test/mcp-web.js` — MCP and web interplay

GitHub Actions runs the full suite on Node 22 (see `.github/workflows/test.yml`).

## Project layout

~~~text
requirement-graph-mcp/
├── .github/workflows/test.yml   # CI: Node 22 tests
├── examples/requirements/       # sample requirement documents (importable)
├── plugins/project-graph-canvas # optional Codex web-workflow plugin (no .mcp.json)
├── src/                         # CLI + SQLite + MCP + local web
│   ├── index.js                 # entry: init / import / status / serve / ui
│   ├── db.js                    # SQLite database wrapper
│   ├── importer.js              # Markdown/TXT/JSON/CSV import
│   ├── project.js               # user data home & central database resolution (realpath)
│   ├── registry.js              # project registry: projectId ↔ root, switching
│   ├── mcp.js                   # MCP server (use_project switches projects)
│   ├── web.js / web-ui.js       # local web server
│   ├── web-daemon.js            # persistent web-UI daemon (start / reuse / stop)
│   └── requirement-*.js         # graph, layers, web documents and graph data
├── test/                        # dependency-free self-contained tests
├── package.json
├── LICENSE                      # MIT
└── README.md / README.en.md
~~~

Architecture: a global MCP service, per-project local indexes, explicit initialisation and local-first design.

## License & copyright

This project is licensed under the **MIT License** — see [LICENSE](./LICENSE).

Copyright © 2026 Zilv · Steven Qiang

## Automatic releases (semantic-release)

Every push to `main` triggers the GitHub Actions **Release** workflow, which uses
[semantic-release](https://semantic-release.gitbook.io) to decide the next version from
Conventional Commits and publish it:

- `feat:` → minor; `fix:` / `perf:` → patch; `BREAKING CHANGE` or `!` → major; commits such as plain
  `chore:` never trigger a release.
- Each release updates `CHANGELOG.md`, pushes the version tag, creates a GitHub Release, and publishes
  the package to npm.
- Publishing uses **OIDC `id-token` + npm Trusted Publishing**, so packages ship with npm provenance and
  no token needs to be stored as a repository secret.

One-time prerequisites (npm side, done by the account owner):

1. Claim or create the package name `requirement-graph-mcp` on npmjs.com;
2. In that package’s **Trusted Publishing** settings, link the `Zilvren/requirement-graph-mcp` repository
   and this `Release` workflow;
3. After that, any `feat`/`fix` push to `main` publishes automatically.

If you prefer not to use OIDC: add an `NPM_TOKEN` repository secret and remove the
`NPM_CONFIG_PROVENANCE` environment variable from `.github/workflows/release.yml`.

## Roadmap

The MVP import layer can grow adapters for DOCX, PDF, HTML, Obsidian and Notion exports. Reliable
relation extraction from DOCX and PDF needs extra parsers plus human review, so the first release does
not pretend to be “automatically correct”. Issues and pull requests are welcome.
