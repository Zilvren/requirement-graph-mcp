const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { RequirementGraph, projectDbPath } = require("./db");
const { syncImportedDocuments } = require("./importer");
const { MAX_STATE_BYTES, readMapViewState, removeMapViewState, writeMapViewState } = require("./map-view-state");
const { resolveProjectRoot } = require("./project");
const { activeProject, listProjects } = require("./registry");
const { listRequirementDocuments, readRequirementDocument } = require("./requirement-web-documents");
const { buildRequirementWebGraph } = require("./requirement-web-graph");
const { webUiHtml } = require("./web-ui");

const DEFAULT_UI_HOST = "127.0.0.1";
const DEFAULT_UI_PORT = 4747;
const MAX_AUTOMATIC_PORT_TRIES = 20;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const RELATIONSHIP_SCOPES = new Set(["all", "structural"]);
const MAX_PROJECT_SELECTION_BYTES = 4 * 1024;
const MAX_PROJECT_SELECTIONS = 64;
const PROJECT_SELECTION_TTL_MS = 8 * 60 * 60 * 1000;

function normalizeHost(value) {
  const host = String(value || DEFAULT_UI_HOST).trim();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error("The local UI may only bind to 127.0.0.1, ::1, or localhost.");
  }
  return host;
}

function normalizePort(value, allowZero = false) {
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    throw new Error("Port must be an integer from " + minimum + " to 65535.");
  }
  return port;
}

function clientError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

async function readJsonBody(request, maximumBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) throw clientError("Request body is too large.");
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (!source) throw clientError("A JSON request body is required.");
  try {
    return JSON.parse(source);
  } catch (error) {
    throw clientError("Request body must be valid JSON.");
  }
}

function graphOptions(searchParams) {
  if (searchParams.has("source") || searchParams.has("detail")) {
    throw clientError("This web UI does not expose source or detail selectors.");
  }
  const relationshipScope = searchParams.get("relationship_scope") || "structural";
  if (!RELATIONSHIP_SCOPES.has(relationshipScope)) throw clientError("Unsupported relationship scope.");
  return { relationshipScope };
}

function nonNegativeInteger(searchParams, name, fallback) {
  const value = searchParams.get(name);
  if (value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw clientError(name + " must be a non-negative integer.");
  return number;
}

function positiveInteger(searchParams, name, fallback) {
  const value = searchParams.get(name);
  if (value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw clientError(name + " must be a positive integer.");
  return number;
}

function documentListOptions(searchParams) {
  return {
    query: searchParams.get("query") || "",
    offset: nonNegativeInteger(searchParams, "offset", 0),
    limit: positiveInteger(searchParams, "limit", 200)
  };
}

function documentReadOptions(searchParams) {
  return {
    offset: nonNegativeInteger(searchParams, "offset", 0),
    limit: positiveInteger(searchParams, "limit", 50_000)
  };
}

function writeJson(response, status, value, extraHeaders = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  response.end(JSON.stringify(value));
}

function writeHtml(response, value) {
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Content-Type": "text/html; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(value);
}

function expectedAuthority(host, port) {
  return browserHost(host) + ":" + port;
}

function requestMatchesHost(request, host) {
  return String(request.headers.host || "") === expectedAuthority(host, request.socket.localPort);
}

function requestMatchesOrigin(request, host) {
  const origin = request.headers.origin;
  if (!origin) return true;
  return origin === "http://" + expectedAuthority(host, request.socket.localPort);
}

function createWebHandler(projectRoot, options = {}) {
  const host = options.host || DEFAULT_UI_HOST;
  const csrfToken = options.csrfToken;
  const projectSelections = new Map();

  function pruneProjectSelections(now = Date.now()) {
    for (const [token, selection] of projectSelections) {
      if (selection.expiresAt <= now) projectSelections.delete(token);
    }
    while (projectSelections.size >= MAX_PROJECT_SELECTIONS) {
      const oldest = projectSelections.keys().next().value;
      if (!oldest) return;
      projectSelections.delete(oldest);
    }
  }

  function selectProject(rawProjectPath) {
    const candidate = String(rawProjectPath || "").trim();
    if (!candidate || candidate.length > 2048) throw clientError("Project path is invalid.");
    const selectedRoot = resolveProjectRoot(candidate);
    try {
      if (!fs.statSync(selectedRoot).isDirectory()) throw clientError("Project path must be an existing directory.");
    } catch (error) {
      if (error && error.status) throw error;
      throw clientError("Project path must be an existing directory.");
    }
    pruneProjectSelections();
    const token = crypto.randomBytes(24).toString("base64url");
    projectSelections.set(token, { projectRoot: selectedRoot, expiresAt: Date.now() + PROJECT_SELECTION_TTL_MS });
    return { projectRoot: selectedRoot, token };
  }

  function projectForRequest(searchParams) {
    const token = String(searchParams.get("project") || "").trim();
    if (!token) return projectRoot;
    pruneProjectSelections();
    const selection = projectSelections.get(token);
    if (!selection) throw clientError("Project selection is invalid or expired.");
    return selection.projectRoot;
  }

  function availableProjects() {
    const registeredProjects = listProjects();
    const includesDefaultProject = registeredProjects.some((project) => project.root === projectRoot);
    const projects = includesDefaultProject
      ? registeredProjects
      : [{ id: null, name: path.basename(projectRoot) || projectRoot, root: projectRoot }, ...registeredProjects];
    return {
      activeProject: activeProject(),
      defaultProjectPath: projectRoot,
      projects
    };
  }

  return async function handle(request, response) {
    const url = new URL(request.url || "/", "http://localhost");
    try {
      if (!requestMatchesHost(request, host)) {
        return writeJson(response, 403, { error: "Unexpected Host header." });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return writeHtml(response, webUiHtml({ projectPath: projectRoot, csrfToken }));
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        return writeJson(response, 200, { ok: true, project: projectRoot });
      }
      if (request.method === "GET" && url.pathname === "/api/projects") {
        return writeJson(response, 200, { structuredContent: availableProjects() });
      }
      if (request.method === "POST" && url.pathname === "/api/project-selection") {
        if (!requestMatchesOrigin(request, host) || request.headers["x-requirement-graph-token"] !== csrfToken) {
          return writeJson(response, 403, { error: "Invalid local UI write request." });
        }
        const body = await readJsonBody(request, MAX_PROJECT_SELECTION_BYTES);
        const selection = selectProject(body && body.projectPath);
        return writeJson(response, 200, {
          structuredContent: { projectPath: selection.projectRoot, selectionToken: selection.token }
        });
      }
      const selectedProjectRoot = projectForRequest(url.searchParams);
      if (request.method === "GET" && url.pathname === "/api/graph") {
        const graph = buildRequirementWebGraph(selectedProjectRoot, graphOptions(url.searchParams));
        return writeJson(response, 200, { structuredContent: graph });
      }
      if (request.method === "GET" && url.pathname === "/api/documents") {
        const documents = listRequirementDocuments(selectedProjectRoot, documentListOptions(url.searchParams));
        return writeJson(response, 200, { structuredContent: documents });
      }
      if (request.method === "GET" && url.pathname === "/api/document") {
        const id = String(url.searchParams.get("id") || "").trim();
        if (!id) throw clientError("Document id is required.");
        const document = readRequirementDocument(selectedProjectRoot, id, documentReadOptions(url.searchParams));
        if (!document) return writeJson(response, 404, { error: "Document not found." });
        return writeJson(response, 200, { structuredContent: document });
      }
      if (request.method === "GET" && url.pathname === "/api/map-view-state") {
        return writeJson(response, 200, { structuredContent: { state: readMapViewState(selectedProjectRoot) } });
      }
      if (request.method === "PUT" && url.pathname === "/api/map-view-state") {
        if (!requestMatchesOrigin(request, host) || request.headers["x-requirement-graph-token"] !== csrfToken) {
          return writeJson(response, 403, { error: "Invalid local UI write request." });
        }
        const state = writeMapViewState(selectedProjectRoot, await readJsonBody(request, MAX_STATE_BYTES));
        return writeJson(response, 200, { structuredContent: { state } });
      }
      if (request.method === "DELETE" && url.pathname === "/api/map-view-state") {
        if (!requestMatchesOrigin(request, host) || request.headers["x-requirement-graph-token"] !== csrfToken) {
          return writeJson(response, 403, { error: "Invalid local UI write request." });
        }
        removeMapViewState(selectedProjectRoot);
        return writeJson(response, 200, { structuredContent: { deleted: true } });
      }
      if (request.method === "POST" && url.pathname === "/api/sync") {
        if (!requestMatchesOrigin(request, host) || request.headers["x-requirement-graph-token"] !== csrfToken) {
          return writeJson(response, 403, { error: "Invalid local UI write request." });
        }
        const graph = new RequirementGraph(projectDbPath(selectedProjectRoot));
        try {
          return writeJson(response, 200, { structuredContent: syncImportedDocuments(graph) });
        } finally {
          graph.close();
        }
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(204, { "Cache-Control": "no-store" });
        return response.end();
      }
      const allowedMethods = {
        "/api/health": "GET",
        "/api/projects": "GET",
        "/api/project-selection": "POST",
        "/api/graph": "GET",
        "/api/documents": "GET",
        "/api/document": "GET",
        "/api/map-view-state": "GET, PUT, DELETE",
        "/api/sync": "POST"
      };
      if (allowedMethods[url.pathname]) {
        return writeJson(response, 405, { error: "Method not allowed." }, { Allow: allowedMethods[url.pathname] });
      }
      return writeJson(response, 404, { error: "Not found." });
    } catch (error) {
      return writeJson(response, error.status || 500, { error: error.message || "Local UI request failed." });
    }
  };
}

function createWebServer(projectPath, options = {}) {
  const projectRoot = resolveProjectRoot(projectPath || process.cwd());
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error("Project path must be an existing directory.");
  }
  const host = normalizeHost(options.host);
  const csrfToken = crypto.randomBytes(32).toString("base64url");
  return {
    csrfToken,
    host,
    projectRoot,
    server: http.createServer(createWebHandler(projectRoot, { host, csrfToken }))
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeQuietly(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && error.code !== "ERR_SERVER_NOT_RUNNING") return reject(error);
      resolve();
    });
  });
}

function browserHost(host) {
  return host.includes(":") ? "[" + host + "]" : host;
}

async function startWebServer(projectPath, options = {}) {
  const explicitPort = Object.prototype.hasOwnProperty.call(options, "port") && options.port !== undefined;
  const firstPort = explicitPort
    ? normalizePort(options.port, true)
    : DEFAULT_UI_PORT;
  const attempts = firstPort === 0 || explicitPort
    ? [firstPort]
    : Array.from({ length: MAX_AUTOMATIC_PORT_TRIES }, (_, index) => firstPort + index);
  let lastError;
  for (const port of attempts) {
    const instance = createWebServer(projectPath, options);
    try {
      await listen(instance.server, port, instance.host);
      const address = instance.server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      return {
        ...instance,
        close: () => closeQuietly(instance.server),
        port: actualPort,
        url: "http://" + browserHost(instance.host) + ":" + actualPort + "/"
      };
    } catch (error) {
      lastError = error;
      await closeQuietly(instance.server);
      if (!error || error.code !== "EADDRINUSE" || explicitPort) throw error;
    }
  }
  throw lastError || new Error("Unable to start the local UI server.");
}

module.exports = {
  DEFAULT_UI_HOST,
  DEFAULT_UI_PORT,
  MAX_AUTOMATIC_PORT_TRIES,
  createWebHandler,
  createWebServer,
  normalizeHost,
  normalizePort,
  startWebServer
};
