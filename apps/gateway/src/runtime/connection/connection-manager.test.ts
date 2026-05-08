import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentClient,
  type AgentRequest,
  type AgentResponseStreamEvent,
  type AgentTransport,
} from "@agent-relay/agent-transport";
import {
  SessionKey,
  type ChannelBindingSnapshot,
  type ChannelMessageRecord,
  type ChannelMessageRepository,
} from "@agent-relay/domain";
import { OpenClawPluginRuntime } from "@agent-relay/openclaw-compat";

import { Connection, ConnectionManager } from "./index.js";

const binding: ChannelBindingSnapshot = {
  id: "binding-1",
  name: "Binding One",
  channelType: "feishu",
  accountId: "default",
  channelConfig: { appId: "cli_1", appSecret: "sec_1" },
  agentId: "agent-1",
  enabled: true,
  createdAt: new Date().toISOString(),
};

function createAgentClient(
  _target: string,
  send: (request: AgentRequest) => Promise<{ text: string }> = async () => ({
    text: "ok",
  }),
  stream?: (request: AgentRequest) => AsyncIterable<AgentResponseStreamEvent>,
): AgentClient {
  const transport: AgentTransport = {
    protocol: "a2a",
    send,
    ...(stream ? { stream } : {}),
  };
  return new AgentClient({
    protocol: "a2a",
    transport,
  });
}

async function* streamEvents(
  events: AgentResponseStreamEvent[],
): AsyncIterable<AgentResponseStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

describe("Connection", () => {
  test("marks connected when a channel binding reports a generic status update", async () => {
    const statuses: string[] = [];
    const connection = new Connection({
      agentClient: createAgentClient("http://agent-1"),
      binding,
      callbacks: {
        onConnectionStatus: (event) => statuses.push(event.status),
      },
    });
    const host = {
      startChannelBinding: async (
        _binding: ChannelBindingSnapshot,
        signal: AbortSignal,
        callbacks: {
          onStatus?: (status: { accountId: string; port: null }) => void;
        },
      ) => {
        callbacks.onStatus?.({ accountId: "default", port: null });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    };

    connection.start(host as never);
    await waitFor(() => statuses.includes("connected"));
    await connection.stop();

    assert.deepEqual(statuses, ["connecting", "connected"]);
  });

  test("handles inbound messages when called directly", async () => {
    const sentMessages: string[] = [];
    const connection = new Connection({
      agentClient: createAgentClient("http://agent-1", async (request) => {
        sentMessages.push(request.message);
        return { text: `echo: ${request.message}` };
      }),
      binding,
    });

    const response = await connection.handleInbound({
      accountId: "default",
      channelType: "feishu",
      event: {
        type: "channel.reply.buffered.dispatch",
        ctx: {} as never,
        dispatcherOptions: {
          deliver: async () => {},
        },
      },
      sessionKey: SessionKey.fromString("session-1"),
      userMessage: "hello",
    });

    assert.deepEqual(sentMessages, ["hello"]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  test("emits input and output message events for an accepted channel message", async () => {
    const inbound: string[] = [];
    const outbound: Array<{ text: string; kind: unknown }> = [];
    const connection = new Connection({
      agentClient: createAgentClient(
        "http://agent-1",
        async () => ({ text: "unused" }),
        () =>
          streamEvents([
            { kind: "block", text: "working" },
            { kind: "final", text: "done" },
          ]),
      ),
      binding,
      callbacks: {
        emitMessageInbound: (event) => {
          inbound.push(event.userMessage);
        },
        emitMessageOutbound: (event) => {
          outbound.push({
            text: event.replyText,
            kind: event.metadata?.["kind"],
          });
        },
      },
    });

    await connection.handleInbound({
      accountId: "default",
      channelType: "feishu",
      event: {
        type: "channel.reply.buffered.dispatch",
        ctx: {} as never,
        dispatcherOptions: {
          deliver: async () => {},
        },
      },
      sessionKey: SessionKey.fromString("session-1"),
      userMessage: "hello",
    });

    assert.deepEqual(inbound, ["hello"]);
    assert.deepEqual(outbound, [
      { text: "working", kind: "block" },
      { text: "done", kind: "final" },
    ]);
  });

  test("matches channel account across channel type aliases", async () => {
    const sentMessages: string[] = [];
    const connection = new Connection({
      agentClient: createAgentClient("http://agent-1", async (request) => {
        sentMessages.push(request.message);
        return { text: `echo: ${request.message}` };
      }),
      binding: {
        ...binding,
        channelType: "wechat",
        accountId: "911b9b000589-im-bot",
      },
    });

    const response = await connection.handleInbound({
      accountId: "911b9b000589-im-bot",
      channelType: "openclaw-weixin",
      event: {
        type: "channel.reply.buffered.dispatch",
        ctx: {} as never,
        dispatcherOptions: {
          deliver: async () => {},
        },
      },
      sessionKey: SessionKey.fromString("session-1"),
      userMessage: "hello",
    });

    assert.deepEqual(sentMessages, ["hello"]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  test("delivers streamed buffered blocks before the final reply", async () => {
    const delivered: Array<{ text: string; kind: string }> = [];
    const connection = new Connection({
      agentClient: createAgentClient(
        "http://agent-1",
        async () => ({ text: "unused" }),
        () =>
          streamEvents([
            { kind: "block", text: "first block" },
            { kind: "block", text: "second block" },
            { kind: "final", text: "complete reply" },
          ]),
      ),
      binding,
    });

    const response = await connection.handleInbound({
      accountId: "default",
      channelType: "feishu",
      event: {
        type: "channel.reply.buffered.dispatch",
        ctx: {} as never,
        dispatcherOptions: {
          deliver: async (payload, info) => {
            delivered.push({
              text: payload.text ?? "",
              kind: info.kind,
            });
          },
        },
      },
      sessionKey: SessionKey.fromString("session-1"),
      userMessage: "hello",
    });

    assert.deepEqual(delivered, [
      { text: "first block", kind: "block" },
      { text: "second block", kind: "block" },
      { text: "complete reply", kind: "final" },
    ]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 2, final: 1 },
    });
  });

  test("streams dispatch partial updates through Feishu reply options", async () => {
    const partials: string[] = [];
    const blocks: Array<{ text: string }> = [];
    const finals: Array<{ text: string }> = [];
    const sequence: string[] = [];
    let markedComplete = false;
    let waitedForIdle = false;
    const connection = new Connection({
      agentClient: createAgentClient(
        "http://agent-1",
        async () => ({ text: "unused" }),
        () =>
          streamEvents([
            { kind: "partial", text: "hello" },
            { kind: "block", text: "hello block" },
            { kind: "partial", text: "hello world" },
            { kind: "final", text: "hello world" },
          ]),
      ),
      binding,
    });

    const response = await connection.handleInbound({
      accountId: "default",
      channelType: "feishu",
      event: {
        type: "channel.reply.dispatch",
        ctx: {
          ReplyToId: "om_parent",
        } as never,
        cfg: {} as never,
        dispatcher: {
          markComplete: () => {
            sequence.push("markComplete");
            markedComplete = true;
          },
          sendBlockReply: (payload: { text: string }) => {
            sequence.push("sendBlockReply");
            blocks.push(payload);
          },
          sendFinalReply: (payload: { text: string }) => {
            sequence.push("sendFinalReply");
            finals.push(payload);
          },
          waitForIdle: async () => {
            sequence.push("waitForIdle");
            waitedForIdle = true;
          },
        } as never,
        replyOptions: {
          onPartialReply: async (payload: { text: string }) => {
            partials.push(payload.text);
          },
        } as never,
      },
      sessionKey: SessionKey.fromString("session-1"),
      userMessage: "hello",
    });

    assert.deepEqual(partials, ["hello", "hello world"]);
    assert.deepEqual(blocks, [{ text: "hello block" }]);
    assert.deepEqual(finals, [{ text: "hello world" }]);
    assert.deepEqual(sequence, [
      "sendBlockReply",
      "sendFinalReply",
      "markComplete",
      "waitForIdle",
    ]);
    assert.equal(markedComplete, true);
    assert.equal(waitedForIdle, true);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 1, final: 1 },
    });
  });
});

describe("ConnectionManager", () => {
  test("routes runtime reply events to its matching connection", async () => {
    const sentMessages: string[] = [];
    const agentClient = createAgentClient("http://agent-1", async (request) => {
      sentMessages.push(request.message);
      return { text: `echo: ${request.message}` };
    });
    const runtime = createRuntime();
    const manager = new ConnectionManager(
      null as never,
      runtime,
      null as never,
      createMessageRepository(),
    );
    const connection = new Connection({
      agentClient,
      binding,
    });

    Reflect.get(manager, "trackConnection").call(manager, connection);

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {
        BodyForAgent: "hello",
        Surface: "feishu",
        AccountId: "default",
        SessionKey: "session-1",
      } as never,
      dispatcherOptions: {
        deliver: async () => {},
      },
    });

    assert.deepEqual(sentMessages, ["hello"]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  test("routes by channel account without probing unrelated connections", async () => {
    const sentMessages: string[] = [];
    const agentClient = createAgentClient("http://agent-1", async (request) => {
      sentMessages.push(request.message);
      return { text: `echo: ${request.message}` };
    });
    const runtime = createRuntime();
    const manager = new ConnectionManager(
      null as never,
      runtime,
      null as never,
      createMessageRepository(),
    );
    const matchingConnection = new Connection({
      agentClient,
      binding,
    });
    const unrelatedConnection = new Connection({
      agentClient: createAgentClient("http://agent-2"),
      binding: {
        ...binding,
        id: "binding-2",
        accountId: "other-account",
      },
    });
    unrelatedConnection.handleInbound = async () => {
      throw new Error("unrelated connection should not be probed");
    };

    Reflect.get(manager, "trackConnection").call(manager, unrelatedConnection);
    Reflect.get(manager, "trackConnection").call(manager, matchingConnection);

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {
        BodyForAgent: "hello",
        Surface: "feishu",
        AccountId: "default",
        SessionKey: "session-1",
      } as never,
      dispatcherOptions: {
        deliver: async () => {},
      },
    });

    assert.deepEqual(sentMessages, ["hello"]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  test("routes runtime reply events across channel type aliases", async () => {
    const sentMessages: string[] = [];
    const agentClient = createAgentClient("http://agent-1", async (request) => {
      sentMessages.push(request.message);
      return { text: `echo: ${request.message}` };
    });
    const runtime = createRuntime();
    const manager = new ConnectionManager(
      null as never,
      runtime,
      null as never,
      createMessageRepository(),
    );
    const connection = new Connection({
      agentClient,
      binding: {
        ...binding,
        channelType: "wechat",
        accountId: "911b9b000589-im-bot",
      },
    });

    Reflect.get(manager, "trackConnection").call(manager, connection);

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {
        BodyForAgent: "hello",
        Surface: "openclaw-weixin",
        AccountId: "911b9b000589-im-bot",
        SessionKey: "session-1",
      } as never,
      dispatcherOptions: {
        deliver: async () => {},
      },
    });

    assert.deepEqual(sentMessages, ["hello"]);
    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 1 },
    });
  });

  test("generates stable compact fallback session keys for missing channel session key", async () => {
    const sessionKeys: string[] = [];
    const agentClient = createAgentClient("http://agent-1", async (request) => {
      sessionKeys.push(request.sessionKey.toString());
      return { text: `echo: ${request.message}` };
    });
    const runtime = createRuntime();
    const manager = new ConnectionManager(
      null as never,
      runtime,
      null as never,
      createMessageRepository(),
    );
    const connection = new Connection({
      agentClient,
      binding,
    });

    Reflect.get(manager, "trackConnection").call(manager, connection);

    for (const body of ["hello", "hello again"]) {
      await runtime.handleChannelReplyEvent({
        type: "channel.reply.buffered.dispatch",
        ctx: {
          BodyForAgent: body,
          Surface: "feishu",
          AccountId: "default",
          From: "user-1",
          To: "bot-1",
        } as never,
        dispatcherOptions: {
          deliver: async () => {},
        },
      });
    }

    assert.equal(sessionKeys.length, 2);
    assert.match(sessionKeys[0] ?? "", /^fallback:[a-f0-9]{32}$/);
    assert.equal(sessionKeys[1], sessionKeys[0]);
  });

  test("prefers OpenClaw route session key over sender id for agent requests", async () => {
    const sessionKeys: string[] = [];
    const agentClient = createAgentClient("http://agent-1", async (request) => {
      sessionKeys.push(request.sessionKey.toString());
      return { text: `echo: ${request.message}` };
    });
    const runtime = createRuntime();
    const manager = new ConnectionManager(
      null as never,
      runtime,
      null as never,
      createMessageRepository(),
    );
    const connection = new Connection({
      agentClient,
      binding,
    });

    Reflect.get(manager, "trackConnection").call(manager, connection);

    await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {
        BodyForAgent: "hello",
        Surface: "feishu",
        AccountId: "default",
        SessionKey: "agent:agent-1:feishu:default:direct:ou_user_1",
        SenderId: "ou_user_1",
      } as never,
      dispatcherOptions: {
        deliver: async () => {},
      },
    });

    assert.deepEqual(sessionKeys, [
      "agent:agent-1:feishu:default:direct:ou_user_1",
    ]);
  });

  test("passes binding context with agent requests", async () => {
    const sessionKeys: string[] = [];
    const bindings: Array<AgentRequest["binding"]> = [];
    const agentClient = createAgentClient("http://agent-1", async (request) => {
      sessionKeys.push(request.sessionKey.toString());
      bindings.push(request.binding);
      return { text: `echo: ${request.message}` };
    });
    const runtime = createRuntime();
    const manager = new ConnectionManager(
      null as never,
      runtime,
      null as never,
      createMessageRepository(),
    );
    const connection = new Connection({
      agentClient,
      binding: { ...binding, sessionIsolationStrategy: "accountId" },
    });

    Reflect.get(manager, "trackConnection").call(manager, connection);

    for (const sessionKey of ["session-1", "session-2"]) {
      await runtime.handleChannelReplyEvent({
        type: "channel.reply.buffered.dispatch",
        ctx: {
          BodyForAgent: "hello",
          Surface: "feishu",
          AccountId: "default",
          SessionKey: sessionKey,
        } as never,
        dispatcherOptions: {
          deliver: async () => {},
        },
      });
    }

    assert.deepEqual(sessionKeys, [
      "session-1",
      "session-2",
    ]);
    assert.deepEqual(bindings, [
      { ...binding, sessionIsolationStrategy: "accountId" },
      { ...binding, sessionIsolationStrategy: "accountId" },
    ]);
  });

  test("completes dispatch replies when no connection owns the message", async () => {
    const runtime = createRuntime();
    new ConnectionManager(
      null as never,
      runtime,
      null as never,
      createMessageRepository(),
    );
    let markedComplete = false;
    let waitedForIdle = false;

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.dispatch",
      ctx: {
        BodyForAgent: "hello",
        Surface: "feishu",
        AccountId: "other-account",
        SessionKey: "session-1",
      } as never,
      cfg: {} as never,
      dispatcher: {
        markComplete: () => {
          markedComplete = true;
        },
        sendFinalReply: () => {},
        waitForIdle: async () => {
          waitedForIdle = true;
        },
      } as never,
    });

    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    });
    assert.equal(markedComplete, true);
    assert.equal(waitedForIdle, true);
  });

  test("routes channel events through a registered reply dispatcher", async () => {
    const runtime = createRuntime();

    runtime.setReplyEventDispatcher({
      dispatchReplyEvent: async () => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 7 },
      }),
    });

    const response = await runtime.handleChannelReplyEvent({
      type: "channel.reply.buffered.dispatch",
      ctx: {} as never,
      dispatcherOptions: {
        deliver: async () => {},
      },
    });

    assert.deepEqual(response, {
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 7 },
    });
  });

  test("OpenClawPluginRuntime supports OpenClaw channel turn dispatch", async () => {
    const runtime = createRuntime().asPluginRuntime();
    let recordedSessionKey: string | undefined;
    let dispatchCalled = false;

    const result = await runtime.channel.turn.run({
      channel: "feishu",
      accountId: "default",
      raw: { messageId: "message-1" },
      adapter: {
        ingest: () => ({
          id: "message-1",
          rawText: "hello",
          raw: { messageId: "message-1" },
        }),
        resolveTurn: () => ({
          channel: "feishu",
          accountId: "default",
          routeSessionKey: "session-1",
          storePath: "/tmp/a2a-test-sessions",
          ctxPayload: {
            BodyForAgent: "hello",
            AccountId: "default",
            SessionKey: "session-1",
          } as never,
          recordInboundSession: async ({ sessionKey }) => {
            recordedSessionKey = sessionKey;
          },
          runDispatch: async () => {
            dispatchCalled = true;
            return {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 1 },
            };
          },
        }),
      },
    });

    assert.equal(recordedSessionKey, "session-1");
    assert.equal(dispatchCalled, true);
    assert.deepEqual(result, {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: {
        BodyForAgent: "hello",
        AccountId: "default",
        SessionKey: "session-1",
      },
      routeSessionKey: "session-1",
      dispatchResult: {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 1 },
      },
    });
  });
});

function createRuntime(): OpenClawPluginRuntime {
  return new OpenClawPluginRuntime({
    config: {
      loadConfig: () => ({ channels: {} }) as never,
      writeConfigFile: async () => {},
    },
  });
}

function createMessageRepository(
  records: ChannelMessageRecord[] = [],
): ChannelMessageRepository {
  return {
    append: async (record) => {
      const saved = {
        ...record,
        id: record.id ?? `message-${records.length + 1}`,
        createdAt: record.createdAt ?? new Date().toISOString(),
      };
      records.push(saved);
      return saved;
    },
    listRecent: async () => [...records].reverse(),
  };
}

async function waitFor(assertion: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!assertion()) {
    if (Date.now() - startedAt > 500) {
      throw new Error("Timed out waiting for assertion");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
