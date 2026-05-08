import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { test } from "node:test";
import { SessionKey } from "@agent-relay/domain";

import { A2ATransport } from "./a2a.js";

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

test("A2ATransport returns and accepts server-assigned context IDs", async () => {
  const receivedContextIds: Array<string | undefined> = [];
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      return writeJson(res, {
        name: "Test Agent",
        description: "Test",
        url: serverUrl(server) + "/a2a/jsonrpc",
        protocolVersion: "0.3.0",
        version: "0.1.0",
        skills: [{ id: "test", name: "Test", tags: ["test"] }],
        capabilities: { streaming: false, pushNotifications: false },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        additionalInterfaces: [
          { url: serverUrl(server) + "/a2a/jsonrpc", transport: "JSONRPC" },
        ],
      });
    }

    if (req.method === "POST" && req.url === "/a2a/jsonrpc") {
      const body = await readJson(req);
      const contextId = readContextId(body);
      receivedContextIds.push(contextId);
      return writeJson(res, {
        jsonrpc: "2.0",
        id: body.id,
        result: {
          kind: "task",
          id: "task-1",
          contextId: "ctx-server",
          status: { state: "completed" },
          artifacts: [
            {
              artifactId: "artifact-1",
              parts: [{ kind: "text", text: "done" }],
            },
          ],
        },
      });
    }

    res.statusCode = 404;
    res.end();
  });

  await listen(server);
  const client = new A2ATransport().create(
    {
      url: serverUrl(server),
      contextIdStrategy: "server-assigned",
    },
  );

  try {
    assert.deepEqual(
      await client.send({
        message: "first",
        accountId: "account-1",
        sessionKey: SessionKey.fromString("session-1"),
        binding,
      }, {}),
      { text: "done", protocolSessionId: "ctx-server" },
    );
    assert.deepEqual(
      await client.send({
        message: "second",
        accountId: "account-1",
        sessionKey: SessionKey.fromString("session-1"),
        binding,
      }, { protocolSessionId: "ctx-server" }),
      { text: "done", protocolSessionId: "ctx-server" },
    );

    assert.deepEqual(receivedContextIds, [undefined, "ctx-server"]);
  } finally {
    await close(server);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function serverUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Server is not listening on a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function readContextId(body: Record<string, unknown>): string | undefined {
  const params = body["params"];
  if (!params || typeof params !== "object") return undefined;
  const message = (params as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object") return undefined;
  const contextId = (message as Record<string, unknown>)["contextId"];
  return typeof contextId === "string" ? contextId : undefined;
}

function writeJson(res: ServerResponse, value: unknown): void {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(value));
}
