// Smoke test for the built server binary on the oldest supported Node.
// The test runner requires a newer Node than 18, so continuous integration
// proves Node 18 support directly: spawn dist/index.js over stdio, complete
// a real protocol handshake, list the tools, and assert all three are there.
import { spawn } from "node:child_process";
import assert from "node:assert";

const env = { ...process.env };
delete env.ISITDISPOSABLE_API_KEY;

const child = spawn(process.execPath, ["dist/index.js"], {
  stdio: ["pipe", "pipe", "pipe"],
  env,
});

const timeout = setTimeout(() => {
  console.error("smoke: timed out waiting for the server");
  child.kill();
  process.exit(1);
}, 15000);

let buffer = "";
const pending = new Map();

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function send(message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

function request(id, method, params) {
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

try {
  const initialize = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "node18-smoke", version: "0.0.0" },
  });
  assert.strictEqual(initialize.result.serverInfo.name, "isitdisposable-mcp");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const toolsList = await request(2, "tools/list", {});
  const names = toolsList.result.tools.map((tool) => tool.name).sort();
  assert.deepStrictEqual(names, ["check_batch", "check_domain", "check_email"]);

  const call = await request(3, "tools/call", {
    name: "check_email",
    arguments: { email: "person@example.com" },
  });
  assert.strictEqual(call.result.isError, true);
  assert.ok(JSON.stringify(call.result.content).includes("ISITDISPOSABLE_API_KEY"));

  console.log("stdio smoke ok on " + process.version);
} finally {
  // Self-contained cleanup: a failed assertion above must still stop the
  // timer and the spawned server rather than rely on stdin closing.
  clearTimeout(timeout);
  child.kill();
}
process.exit(0);
