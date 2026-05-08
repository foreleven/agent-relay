import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type {
  AgentResponseStreamEvent,
  AgentRequest,
  AgentTransportFactory,
} from "@agent-relay/agent-transport";
import {
  SessionKey,
  type AgentConfigSnapshot,
  type ChannelBindingSnapshot,
  type SessionMappingKey,
  type SessionMappingRepository,
} from "@agent-relay/domain";

import { AgentClientFactory } from "./agent-clients.js";

const agent: AgentConfigSnapshot = {
  id: "agent-1",
  name: "agent-one",
  protocol: "a2a",
  config: { url: "http://agent-1", contextIdStrategy: "server-assigned" },
  createdAt: new Date().toISOString(),
};
const binding: ChannelBindingSnapshot = {
  id: "binding-1",
  name: "Binding One",
  channelType: "feishu",
  accountId: "default",
  channelConfig: {},
  agentId: "agent-1",
  sessionIsolationStrategy: "sessionKey",
  enabled: true,
  createdAt: new Date().toISOString(),
};
const sessionOneKey = SessionKey.fromString("session-1").toMd5();

describe("AgentClientFactory", () => {
  test("records protocol session mapping above transports", async () => {
    const receivedRequests: AgentRequest[] = [];
    const store = createSessionMappingStore({});
    const factory = new AgentClientFactory(
      [createTransportFactory(receivedRequests, "next-context")],
      store,
    );

    const client = factory.create(agent);
    const response = await client.send({
      message: "hello",
      accountId: "account-1",
      sessionKey: SessionKey.fromString("session-1"),
      binding,
    });

    assert.equal(response.protocolSessionId, "next-context");
    assert.equal(
      store.values.get("agent-1:a2a:session-1"),
      "next-context",
    );
  });

  test("skips protocol session mapping when binding uses request isolation", async () => {
    const receivedRequests: AgentRequest[] = [];
    const store = createSessionMappingStore({
      [`agent-1:a2a:${sessionOneKey}`]: "stored-context",
    });
    const factory = new AgentClientFactory(
      [createTransportFactory(receivedRequests, "next-context")],
      store,
    );

    const client = factory.create(agent);
    await client.send({
      message: "hello",
      accountId: "account-1",
      sessionKey: SessionKey.fromString("session-1"),
      binding: { ...binding, sessionIsolationStrategy: "request" },
    });

    assert.equal(receivedRequests[0]?.sessionKey.toString(), "session-1");
    assert.equal(
      store.values.get(`agent-1:a2a:${sessionOneKey}`),
      "stored-context",
    );
  });

  test("passes binding-scoped session keys through to transports", async () => {
    const receivedRequests: AgentRequest[] = [];
    const store = createSessionMappingStore({});
    const factory = new AgentClientFactory(
      [createTransportFactory(receivedRequests, "next-context")],
      store,
    );
    const client = factory.create(agent);

    await client.send({
      message: "hello",
      accountId: "default",
      sessionKey: SessionKey.fromString("session-1"),
      binding: { ...binding, sessionIsolationStrategy: "accountId" },
    });
    await client.send({
      message: "hello",
      accountId: "default",
      sessionKey: SessionKey.fromString("session-1"),
      binding: {
        ...binding,
        id: "binding-telegram",
        channelType: "telegram",
        sessionIsolationStrategy: "accountId",
      },
    });

    assert.deepEqual(
      receivedRequests.map((request) => request.sessionKey.toString()),
      ["session-1", "session-1"],
    );
  });

  test("records streamed protocol session mapping once after the stream completes", async () => {
    const receivedRequests: AgentRequest[] = [];
    const setCalls: string[] = [];
    const store = createSessionMappingStore({}, setCalls);
    const factory = new AgentClientFactory(
      [
        createStreamingTransportFactory(receivedRequests, [
          { kind: "partial", text: "one", protocolSessionId: "ctx-1" },
          { kind: "block", text: "two", protocolSessionId: "ctx-2" },
          { kind: "final", text: "done" },
        ]),
      ],
      store,
    );

    const client = factory.create(agent);
    const events: AgentResponseStreamEvent[] = [];
    for await (const event of client.stream({
      message: "hello",
      accountId: "account-1",
      sessionKey: SessionKey.fromString("session-1"),
      binding,
    })) {
      events.push(event);
    }

    assert.deepEqual(
      events.map((event) => event.text),
      ["one", "two", "done"],
    );
    assert.deepEqual(setCalls, ["agent-1:a2a:session-1=ctx-2"]);
  });
});

function createTransportFactory(
  receivedRequests: AgentRequest[],
  protocolSessionId: string,
): AgentTransportFactory {
  return {
    protocol: "a2a",
    create: () => ({
      protocol: "a2a",
      send: async (request) => {
        receivedRequests.push(request);
        return { text: "ok", protocolSessionId };
      },
    }),
  };
}

function createStreamingTransportFactory(
  receivedRequests: AgentRequest[],
  events: AgentResponseStreamEvent[],
): AgentTransportFactory {
  return {
    protocol: "a2a",
    create: () => ({
      protocol: "a2a",
      send: async (request) => {
        receivedRequests.push(request);
        return { text: "ok" };
      },
      stream: async function* (request) {
        receivedRequests.push(request);
        for (const event of events) {
          yield event;
        }
      },
    }),
  };
}

function createSessionMappingStore(
  initial: Record<string, string>,
  setCalls: string[] = [],
) {
  const values = new Map(Object.entries(initial));
  const store: SessionMappingRepository & { values: Map<string, string> } = {
    values,
    get: async (key) => values.get(toStoreKey(key)) ?? null,
    set: async (key, protocolSessionId) => {
      const storeKey = toStoreKey(key);
      setCalls.push(`${storeKey}=${protocolSessionId}`);
      values.set(storeKey, protocolSessionId);
    },
  };
  return store;
}

function toStoreKey(key: SessionMappingKey): string {
  return `${key.agentId}:${key.protocol}:${key.sessionKey}`;
}
