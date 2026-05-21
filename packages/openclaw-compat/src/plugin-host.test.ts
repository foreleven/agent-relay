import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ChannelBindingSnapshot } from "@agent-relay/domain";

import { OpenClawPluginHost, OpenClawPluginRuntime } from "./index.js";

function createHost() {
  const runtime = new OpenClawPluginRuntime({
    config: {
      loadConfig: () => ({ channels: {} }),
      writeConfigFile: async () => {},
    },
  });
  return new OpenClawPluginHost(runtime);
}

function createMeta(id: string, aliases: string[]) {
  return {
    id,
    label: id,
    selectionLabel: id,
    docsPath: id,
    blurb: id,
    aliases,
  };
}

describe("OpenClawPluginHost channel login", () => {
  test("runs auth.login through a registered alias", async () => {
    const host = createHost();
    const calls: string[] = [];

    host.registerPlugin((api) => {
      api.registerChannel({
        id: "openclaw-example",
        meta: createMeta("openclaw-example", ["example"]),
        capabilities: { chatTypes: [] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({}),
        },
        auth: {
          login: async ({ accountId, verbose, runtime }) => {
            calls.push(`${accountId}:${String(verbose)}`);
            runtime?.log?.("login-output");
          },
        },
      });
    });
    host.registerChannelAlias("demo", "openclaw-example");

    assert.equal(host.hasChannelLogin("demo"), true);
    await host.runChannelLogin("demo", {
      accountId: "default",
      verbose: true,
      runtime: {
        log: (message) => calls.push(String(message)),
        error: () => {},
        exit: () => {},
      },
    });

    assert.deepEqual(calls, ["default:true", "login-output"]);
  });

  test("rejects a channel without auth.login", async () => {
    const host = createHost();
    host.registerPlugin((api) => {
      api.registerChannel({
        id: "no-login",
        meta: createMeta("no-login", ["plain"]),
        capabilities: { chatTypes: [] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({}),
        },
      });
    });

    assert.equal(host.hasChannelLogin("plain"), false);
    await assert.rejects(
      () => host.runChannelLogin("plain", { accountId: "default" }),
      /Channel login is not supported for plain/,
    );
  });
});

describe("OpenClawPluginHost channel lifecycle", () => {
  test("injects channel runtime when starting a binding", async () => {
    const host = createHost();
    let receivedChannelRuntime: unknown;

    host.registerPlugin((api) => {
      api.registerChannel({
        id: "openclaw-example",
        meta: createMeta("openclaw-example", ["example"]),
        capabilities: { chatTypes: [] },
        config: {
          listAccountIds: () => [],
          resolveAccount: () => ({}),
        },
        gateway: {
          startAccount: async (ctx) => {
            receivedChannelRuntime = ctx.channelRuntime;
          },
        },
      });
    });

    const binding: ChannelBindingSnapshot = {
      id: "binding-1",
      name: "Example",
      channelType: "openclaw-example",
      accountId: "default",
      channelConfig: {},
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date(0).toISOString(),
    };

    await host.startChannelBinding(binding, new AbortController().signal);

    assert.equal(typeof receivedChannelRuntime, "object");
    assert.notEqual(receivedChannelRuntime, null);
    assert.equal(
      typeof (receivedChannelRuntime as { reply?: { dispatchReplyFromConfig?: unknown } })
        .reply?.dispatchReplyFromConfig,
      "function",
    );
    assert.equal(
      typeof (receivedChannelRuntime as { routing?: { resolveAgentRoute?: unknown } })
        .routing?.resolveAgentRoute,
      "function",
    );
  });
});
