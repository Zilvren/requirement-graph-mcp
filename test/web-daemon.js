const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { RequirementGraph, projectDbPath } = require("../src/db");
const { importPath } = require("../src/importer");
const { daemonStatePath, ensureWebServer, readDaemonState, stopWebServer } = require("../src/web-daemon");

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function main() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "requirement-graph-daemon-"));
  let running = false;
  try {
    const documentPath = path.join(projectRoot, "requirement.md");
    const originalDocument = "---\nid: DAEMON-REQ\ntitle: Daemon requirement\n---\n# Daemon requirement\n\nThe persistent web UI must serve this document.\n";
    fs.writeFileSync(documentPath, originalDocument, "utf8");
    const graph = new RequirementGraph(projectDbPath(projectRoot));
    importPath(graph, documentPath);
    graph.close();

    const first = await ensureWebServer(projectRoot);
    running = true;
    assert.equal(first.reused, false);
    assert.equal(first.project_path, projectRoot);
    assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    const state = readDaemonState(projectRoot);
    assert.ok(state, "a running daemon is recorded in the project state directory");
    assert.equal(state.url, first.url);
    assert.equal(state.project_path, projectRoot);
    assert.ok(Number.isInteger(state.pid) && state.pid > 0);
    assert.ok(fs.existsSync(daemonStatePath(projectRoot)));

    const health = await (await fetch(first.url + "api/health")).json();
    assert.equal(health.ok, true);
    assert.equal(health.project, projectRoot, "the health endpoint identifies the project the daemon serves");

    // Opening again must reuse the same still-running daemon at the same URL.
    const second = await ensureWebServer(projectRoot);
    assert.equal(second.reused, true);
    assert.equal(second.url, first.url);

    const stopped = await stopWebServer(projectRoot);
    running = false;
    assert.equal(stopped.stopped, true);
    assert.equal(fs.existsSync(daemonStatePath(projectRoot)), false, "stopping removes the recorded state");
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await reachable(first.url), false, "the daemon is gone after being stopped");

    // A later open starts a fresh daemon again.
    const restarted = await ensureWebServer(projectRoot);
    running = true;
    assert.equal(restarted.reused, false);
    const afterRestart = await stopWebServer(projectRoot);
    running = false;
    assert.equal(afterRestart.stopped, true);
    assert.equal(fs.existsSync(daemonStatePath(projectRoot)), false);
  } finally {
    if (running) await stopWebServer(projectRoot);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
  process.stdout.write("web daemon test passed\n");
}

main().catch((error) => {
  process.stderr.write(error.stack + "\n");
  process.exitCode = 1;
});
