import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { AgentRequest } from "@agent-relay/agent-transport";
import {
  AgentConfigAggregate,
  ChannelBindingAggregate,
  SessionKey,
  type AgentConfigRepository,
  type AgentConfigSnapshot,
  type ChannelBindingRepository,
  type ChannelBindingSnapshot,
  type ChannelMessageRecord,
  type ChannelMessageRepository,
} from "@agent-relay/domain";

import { ScheduledJobExecutor } from "./scheduled-job-executor.js";

const binding: ChannelBindingSnapshot = {
  id: "binding-1",
  name: "Binding One",
  channelType: "feishu",
  accountId: "default",
  channelConfig: {},
  agentId: "agent-1",
  enabled: true,
  createdAt: "2026-05-07T08:00:00.000Z",
};

describe("ScheduledJobExecutor", () => {
  test("uses the binding agent id and sends the reply through channel outbound", async () => {
    const records: ChannelMessageRecord[] = [];
    const requests: AgentRequest[] = [];
    const deliveries: Array<{
      cfg: unknown;
      to: string;
      text: string;
      accountId?: string | null;
    }> = [];
    const upsertedAgentIds: string[] = [];
    let globalConfigReads = 0;

    const executor = new ScheduledJobExecutor(
      createBindingRepo(binding),
      createAgentRepo(),
      {
        upsertAgent: async (agent: AgentConfigSnapshot) => {
          upsertedAgentIds.push(agent.id);
        },
        getAgentClient: async (agentId: string) => {
          assert.equal(agentId, "agent-1");
          return {
            send: async (request: AgentRequest) => {
              requests.push(request);
              return { text: "scheduled reply" };
            },
            stream: async function* () {},
          };
        },
      } as never,
      {
        buildScopedConfig: (bindings: ChannelBindingSnapshot[]) => {
          assert.deepEqual(
            bindings.map((candidate) => candidate.id),
            ["binding-1"],
          );
          return { channels: { feishu: { scoped: true } } };
        },
        getConfig: () => {
          globalConfigReads += 1;
          return { channels: { feishu: { global: true } } };
        },
      } as never,
      {
        getChannelPlugin: () => ({
          outbound: {
            sendText: async (ctx: {
              cfg: unknown;
              to: string;
              text: string;
              accountId?: string | null;
            }) => {
              deliveries.push({
                cfg: ctx.cfg,
                to: ctx.to,
                text: ctx.text,
                accountId: ctx.accountId,
              });
              return { channel: "feishu", messageId: "om_1" };
            },
          },
        }),
      } as never,
      createMessageRepository(records),
    );

    const result = await executor.execute(
      {
        bindingId: "binding-1",
        sessionKey: "agent:stale-agent:feishu:default:direct:ou_user_1",
        prompt: "daily prompt",
      },
      {
        jobId: "job-1",
        jobName: "daily",
        queuedAt: "2026-05-07T08:55:00.000Z",
      },
    );

    assert.deepEqual(result, { status: "sent", bindingId: "binding-1" });
    assert.deepEqual(upsertedAgentIds, ["agent-1"]);
    assert.equal(requests[0]?.message, "daily prompt");
    assert.equal(
      requests[0]?.sessionKey.toString(),
      "agent:stale-agent:feishu:default:direct:ou_user_1",
    );
    assert.equal(requests[0]?.accountId, "default");
    assert.deepEqual(requests[0]?.binding, {
      ...binding,
      sessionIsolationStrategy: "sessionKey",
    });
    assert.equal(globalConfigReads, 0);
    assert.deepEqual(deliveries, [
      {
        cfg: { channels: { feishu: { scoped: true } } },
        to: "ou_user_1",
        text: "scheduled reply",
        accountId: "default",
      },
    ]);
    assert.equal(records[0]?.direction, "input");
    assert.equal(records[0]?.metadata?.["proactive"], true);
    assert.equal(records[1]?.direction, "output");
    assert.equal(records[1]?.metadata?.["proactive"], true);
    assert.deepEqual(records[1]?.metadata?.["delivery"], {
      channel: "feishu",
      messageId: "om_1",
    });
  });
});

function createBindingRepo(
  snapshot: ChannelBindingSnapshot,
): ChannelBindingRepository {
  return {
    findById: async (id) =>
      id === snapshot.id
        ? ChannelBindingAggregate.fromSnapshot(snapshot)
        : null,
    findAll: async () => [snapshot],
    findEnabled: async () => snapshot,
    findByAgentId: async () => [snapshot],
    findByChannelAccount: async () => snapshot,
    save: async () => {},
  };
}

function createAgentRepo(): AgentConfigRepository {
  return {
    findById: async (id) =>
      id === "agent-1"
        ? AgentConfigAggregate.fromSnapshot({
            id: "agent-1",
            name: "Agent One",
            protocol: "a2a",
            config: { url: "http://agent.test" },
            createdAt: "2026-05-07T08:00:00.000Z",
          })
        : null,
    findAll: async () => [],
    save: async () => {},
  };
}

function createMessageRepository(
  records: ChannelMessageRecord[],
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
    listRecent: async () => records,
  };
}
