import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionKey } from "@agent-relay/domain";
import { ACPTransport } from "./acp.js";

const binding = {
  id: "binding-1",
  name: "Binding One",
  channelType: "feishu",
  accountId: "default",
  channelConfig: {},
  agentId: "agent-1",
  sessionIsolationStrategy: "sessionKey" as const,
  enabled: true,
  createdAt: new Date().toISOString(),
};

/** Minimal ACP stdio agent script that echoes prompts and reports its cwd. */
const ECHO_AGENT_SCRIPT = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    return;
  }

  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "session-1" },
    });
    return;
  }

  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "echo:" + message.params.prompt[0].text,
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
});
`;

const INSPECT_AGENT_SCRIPT = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    return;
  }

  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "session-1" },
    });
    return;
  }

  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: JSON.stringify({
              argv: process.argv.slice(2),
              cwd: process.cwd(),
              prompt: message.params.prompt[0].text,
            }),
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
});
`;

const SESSION_INSPECT_AGENT_SCRIPT = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    return;
  }

  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "new-session" },
    });
    return;
  }

  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: message.params.sessionId,
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }
});
`;

const LOADABLE_SESSION_AGENT_SCRIPT = `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true },
      },
    });
    return;
  }

  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "new-session" },
    });
    return;
  }

  if (message.method === "session/load") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {},
    });
    return;
  }

  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: message.params.sessionId,
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }
});
`;

test("ACPTransport calls an ACP stdio agent through the SDK client", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-stdio-test-"));
  const agentPath = join(tempDir, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const transport = new ACPTransport();
  const command = "node";
  const config = { transport: "stdio" as const, command, args: [agentPath] };
  const client = transport.create(config);

  try {
    const response = await client.send({
      message: "hello",
      accountId: "default",
      sessionKey: SessionKey.fromString("ctx"),
      binding,
    }, {});

    assert.deepEqual(response, { text: "echo:hello" });
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ACPTransport start waits for account-scoped request context", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-stdio-start-test-"));
  const agentPath = join(tempDir, "agent.mjs");
  const cwd = join(tempDir, "agent-cwd");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const transport = new ACPTransport();
  const config = {
    transport: "stdio" as const,
    command: "node",
    args: [agentPath],
    cwd,
  };
  const client = transport.create(config);

  try {
    await client.start?.();

    const entries = await readdir(tempDir);
    assert.ok(
      !entries.includes("agent-cwd"),
      "start should not create an account-scoped worker without accountId",
    );
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ACPTransport spawns separate processes per accountId when ACP_BASE_PATH and agentName are set", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "acp-base-"));
  const agentPath = join(basePath, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const originalBasePath = process.env["ACP_BASE_PATH"];
  process.env["ACP_BASE_PATH"] = basePath;

  const transport = new ACPTransport();
  const config = {
    transport: "stdio" as const,
    command: "node",
    args: [agentPath],
  };
  const client = transport.create(config, { agentName: "my-agent" });

  try {
    await client.send({
      message: "hello",
      accountId: "user-1",
      sessionKey: SessionKey.fromString("s1"),
      binding,
    }, {});
    await client.send({
      message: "world",
      accountId: "user-2",
      sessionKey: SessionKey.fromString("s2"),
      binding,
    }, {});

    // Each account should have its own subdirectory under basePath/name/
    const entries = await readdir(join(basePath, "my-agent"));
    assert.ok(
      entries.includes("user-1"),
      "user-1 cwd directory should be created",
    );
    assert.ok(
      entries.includes("user-2"),
      "user-2 cwd directory should be created",
    );
  } finally {
    await client.stop?.();
    if (originalBasePath === undefined) {
      delete process.env["ACP_BASE_PATH"];
    } else {
      process.env["ACP_BASE_PATH"] = originalBasePath;
    }
    await rm(basePath, { recursive: true, force: true });
  }
});

test("ACPTransport prefers configured ACP stdio cwd over isolated base path", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "acp-base-"));
  const explicitCwd = await mkdtemp(join(tmpdir(), "acp-configured-cwd-"));
  const agentPath = join(basePath, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const originalBasePath = process.env["ACP_BASE_PATH"];
  process.env["ACP_BASE_PATH"] = basePath;

  const transport = new ACPTransport();
  const client = transport.create(
    {
      transport: "stdio",
      command: "node",
      args: [agentPath],
      cwd: explicitCwd,
    },
    { agentName: "my-agent" },
  );

  try {
    await client.send({
      message: "hello",
      accountId: "user-1",
      sessionKey: SessionKey.fromString("s1"),
      binding,
    }, {});

    const baseEntries = await readdir(basePath);
    assert.ok(
      !baseEntries.includes("my-agent"),
      "configured cwd should bypass ACP_BASE_PATH account workspace derivation",
    );
  } finally {
    await client.stop?.();
    if (originalBasePath === undefined) {
      delete process.env["ACP_BASE_PATH"];
    } else {
      process.env["ACP_BASE_PATH"] = originalBasePath;
    }
    await rm(basePath, { recursive: true, force: true });
    await rm(explicitCwd, { recursive: true, force: true });
  }
});

test("ACPTransport treats blank ACP stdio cwd as unset", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "acp-base-"));
  const agentPath = join(basePath, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const originalBasePath = process.env["ACP_BASE_PATH"];
  process.env["ACP_BASE_PATH"] = basePath;

  const transport = new ACPTransport();
  const client = transport.create(
    {
      transport: "stdio",
      command: "node",
      args: [agentPath],
      cwd: "   ",
    },
    { agentName: "my-agent" },
  );

  try {
    await client.send({
      message: "hello",
      accountId: "user-1",
      sessionKey: SessionKey.fromString("s1"),
      binding,
    }, {});

    const entries = await readdir(join(basePath, "my-agent"));
    assert.ok(entries.includes("user-1"), "blank cwd should use default logic");
  } finally {
    await client.stop?.();
    if (originalBasePath === undefined) {
      delete process.env["ACP_BASE_PATH"];
    } else {
      process.env["ACP_BASE_PATH"] = originalBasePath;
    }
    await rm(basePath, { recursive: true, force: true });
  }
});

test("ACPTransport expands account and session placeholders in args and cwd", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-template-test-"));
  const agentPath = join(tempDir, "agent.mjs");

  await writeFile(agentPath, INSPECT_AGENT_SCRIPT, "utf8");

  const transport = new ACPTransport();
  const client = transport.create({
    transport: "stdio",
    command: "node",
    args: [agentPath, "--account={accountId}", "--session={sessionKey}"],
    cwd: join(tempDir, "work", "{accountId}", "{sessionKey}"),
  });

  try {
    const first = await client.send({
      message: "hello",
      accountId: "user-1",
      sessionKey: SessionKey.fromString("session-a"),
      binding,
    }, {});
    const second = await client.send({
      message: "world",
      accountId: "user-1",
      sessionKey: SessionKey.fromString("session-b"),
      binding,
    }, {});

    const firstCwd = await realpath(
      join(tempDir, "work", "user-1", "session-a"),
    );
    const secondCwd = await realpath(
      join(tempDir, "work", "user-1", "session-b"),
    );

    assert.deepEqual(JSON.parse(first.text), {
      argv: ["--account=user-1", "--session=session-a"],
      cwd: firstCwd,
      prompt: "hello",
    });
    assert.deepEqual(JSON.parse(second.text), {
      argv: ["--account=user-1", "--session=session-b"],
      cwd: secondCwd,
      prompt: "world",
    });
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ACPTransport ignores protocol session IDs when loadSession is unsupported", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-session-store-test-"));
  const agentPath = join(tempDir, "agent.mjs");

  await writeFile(agentPath, SESSION_INSPECT_AGENT_SCRIPT, "utf8");

  const transport = new ACPTransport();
  const client = transport.create({
    transport: "stdio",
    command: "node",
    args: [agentPath],
  });

  try {
    const response = await client.send(
      {
        message: "hello",
        accountId: "default",
        sessionKey: SessionKey.fromString("ctx"),
        binding,
      },
      { protocolSessionId: "stale-session" },
    );

    assert.deepEqual(response, { text: "new-session" });
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ACPTransport loads protocol session IDs when supported", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-session-load-test-"));
  const agentPath = join(tempDir, "agent.mjs");

  await writeFile(agentPath, LOADABLE_SESSION_AGENT_SCRIPT, "utf8");

  const transport = new ACPTransport();
  const client = transport.create({
    transport: "stdio",
    command: "node",
    args: [agentPath],
  });

  try {
    const loadedSessionId = SessionKey.fromString("ctx").toMd5();
    const response = await client.send(
      {
        message: "hello",
        accountId: "default",
        sessionKey: SessionKey.fromString("ctx"),
        binding,
      },
      { protocolSessionId: loadedSessionId },
    );

    assert.deepEqual(response, {
      text: loadedSessionId,
      protocolSessionId: loadedSessionId,
    });
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ACPTransport rejects unsafe agentName values for isolated workspaces", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "acp-base-"));
  const agentPath = join(basePath, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const originalBasePath = process.env["ACP_BASE_PATH"];
  process.env["ACP_BASE_PATH"] = basePath;

  const transport = new ACPTransport();
  const client = transport.create(
    { transport: "stdio", command: "node", args: [agentPath] },
    { agentName: "../agent" },
  );

  try {
    await assert.rejects(() =>
      client.send({
        message: "hello",
        accountId: "user-1",
        sessionKey: SessionKey.fromString("s1"),
        binding,
      }, {}),
    );
  } finally {
    await client.stop?.();
    if (originalBasePath === undefined) {
      delete process.env["ACP_BASE_PATH"];
    } else {
      process.env["ACP_BASE_PATH"] = originalBasePath;
    }
    await rm(basePath, { recursive: true, force: true });
  }
});
