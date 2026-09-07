# Project Graph Web Codex Plugin

This optional prompt-and-workflow plugin guides Codex to use the standalone
Requirement Graph webpage. It does not launch an MCP server, does not include
.mcp.json, and does not hold graph data.

Register the local Requirement Graph MCP separately in Codex first:

~~~toml
[mcp_servers.requirement_graph]
command = "requirement-graph"
args = ["serve", "--mcp"]
~~~

Once the connection is available, this plugin teaches Codex when to use the
existing requirement_graph_* data tools and when to call
requirement_graph_open_web. That tool starts or reuses a loopback-only local
web server and returns its URL; Codex can open that URL in its browser.

The webpage is the visual entry point. It reads only the active project's
Requirement Graph data (stored centrally under the user data directory) and
does not load any external code index. Installing or removing this plugin never
starts a second MCP server.

Neither component uploads project data: each project's graph stays local in the
user data directory, keyed by that project's directory.
