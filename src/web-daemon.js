const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { dataHome, encodeRoot, resolveProjectRoot } = require("./project");
const { DEFAULT_UI_HOST, DEFAULT_UI_PORT, MAX_AUTOMATIC_PORT_TRIES } = require("./web");

// A per-project persistent web UI. The MCP stdio process dies with the Codex
// session, so an in-process HTTP server cannot outlive the session. This module
// runs the existing `serve --web` server as a detached background process and
// records it under the central data home as web-ui/<encoded root>.json. Later
// sessions probe that record's health and reuse the still-running server
// instead of restarting it, which keeps an opened graph page from going offline.

const STATE_FILE_NAME = "web-ui.json";
const HEALTH_PATH = "/api/health";
const DAEMON_READY_TIMEOUT_MS = 10_000;
const PROBE_INTERVAL_MS = 120;
const STOP_WAIT_MS = 3_000;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function daemonStatePath(projectRoot) {
  return path.join(dataHome(), "web-ui", encodeRoot(projectRoot) + ".json");
}

function readDaemonState(projectRoot) {
  try {
    return JSON.parse(fs.readFileSync(daemonStatePath(projectRoot), "utf8"));
  } catch (error) {
    // Missing, unreadable, or corrupt state is treated as absent so a stale
    // record can never keep a project from starting its UI again.
    return null;
  }
}

function writeDaemonState(projectRoot, info) {
  fs.mkdirSync(path.dirname(daemonStatePath(projectRoot)), { recursive: true });
  fs.writeFileSync(
    daemonStatePath(projectRoot),
    JSON.stringify({ ...info, saved_at: new Date().toISOString() }, null, 2) + "\n",
    "utf8"
  );
}

function removeDaemonState(projectRoot) {
  try {
    fs.rmSync(daemonStatePath(projectRoot), { force: true });
  } catch (error) {
    if (!error || (error.code !== "ENOENT" && error.code !== "EACCES")) throw error;
  }
}

function probeHealth(url, expectedProjectRoot, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      resolve({ ok: false });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(result);
    };
    const request = http.get(
      {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : undefined,
        path: HEALTH_PATH,
        method: "GET",
        headers: { Connection: "close" }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          let payload = null;
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (error) {
            payload = null;
          }
          const ok = response.statusCode === 200 && payload && payload.ok === true;
          const project = payload && typeof payload.project === "string" ? path.resolve(payload.project) : null;
          finish({ ok, project, status: response.statusCode });
        });
      }
    );
    request.on("error", () => finish({ ok: false }));
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
  });
}

function startDaemon(projectRoot, port) {
  const entry = path.join(__dirname, "index.js");
  const child = spawn(
    process.execPath,
    [entry, "serve", "--web", "--project", projectRoot, "--port", String(port)],
    { detached: true, stdio: "ignore", windowsHide: true }
  );
  return child;
}

function waitUntilHealthy(url, projectRoot, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    if (child.exitCode !== null) return { ok: false, exitCode: child.exitCode };
    const probe = await probeHealth(url, projectRoot, Math.min(700, Math.max(150, deadline - Date.now())));
    if (probe.ok && probe.project === projectRoot) return { ok: true };
    if (Date.now() >= deadline || probe.status === 200) return { ok: false };
    await sleep(PROBE_INTERVAL_MS);
    return poll();
  })();
}

function candidatePorts(previous) {
  const ports = [];
  if (previous && Number.isInteger(previous.port) && previous.port >= 0 && previous.port <= 65535) {
    ports.push(previous.port);
  }
  for (let offset = 0; offset < MAX_AUTOMATIC_PORT_TRIES; offset += 1) {
    const port = DEFAULT_UI_PORT + offset;
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

// Returns { url, project_path, reused } like the previous in-process opener, but
// the server itself is a detached daemon that survives the calling session.
async function ensureWebServer(projectPath) {
  const projectRoot = resolveProjectRoot(projectPath);
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw new Error("Project path must be an existing directory.");
  }
  const previous = readDaemonState(projectRoot);

  // A recorded daemon that is still healthy for this project is reused as-is;
  // this is what lets a new Codex session reconnect to the same running UI.
  if (previous && previous.url) {
    const probe = await probeHealth(previous.url, projectRoot);
    if (probe.ok && probe.project === projectRoot) {
      return { url: previous.url, project_path: projectRoot, reused: true };
    }
  }

  let lastError;
  for (const port of candidatePorts(previous)) {
    if (previous && previous.port === port && previous.url) {
      const probe = await probeHealth(previous.url, projectRoot);
      if (probe.ok) continue; // occupied by a different project's UI
    }
    const url = "http://" + DEFAULT_UI_HOST + ":" + port + "/";
    const child = startDaemon(projectRoot, port);
    const ready = await waitUntilHealthy(url, projectRoot, child, DAEMON_READY_TIMEOUT_MS);
    if (ready.ok) {
      child.unref();
      writeDaemonState(projectRoot, {
        project_path: projectRoot,
        pid: child.pid,
        port,
        url,
        started_at: new Date().toISOString()
      });
      return { url, project_path: projectRoot, reused: false };
    }
    lastError = ready.exitCode === undefined ? new Error("The local UI did not become ready on port " + port + ".") : new Error("Unable to bind the local UI on port " + port + ".");
    try {
      child.kill();
    } catch (error) {
      if (!error || error.code !== "ESRCH") lastError = error;
    }
    await sleep(80);
  }
  throw lastError || new Error("Unable to start the persistent local UI for " + projectRoot + ".");
}

async function stopWebServer(projectPath) {
  const projectRoot = resolveProjectRoot(projectPath);
  const state = readDaemonState(projectRoot);
  if (!state || !Number.isInteger(state.pid)) {
    removeDaemonState(projectRoot);
    return { project_path: projectRoot, stopped: false, url: null, pid: null };
  }
  let stopped = true;
  try {
    process.kill(state.pid);
  } catch (error) {
    stopped = false;
    if (!error || error.code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(state.pid, 0);
    } catch (error) {
      if (!error || error.code === "ESRCH") break;
    }
    await sleep(80);
  }
  removeDaemonState(projectRoot);
  return { project_path: projectRoot, stopped, url: state.url || null, pid: state.pid };
}

module.exports = {
  STATE_FILE_NAME,
  daemonStatePath,
  ensureWebServer,
  readDaemonState,
  removeDaemonState,
  stopWebServer,
  writeDaemonState
};
