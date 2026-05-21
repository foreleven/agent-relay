import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@agent-relay/openclaw-compat";

import { registerAllPlugins } from "./register-plugins.js";
import { OpenClawChannelPackageDescriptor } from "./runtime/channel-plugin-descriptor.js";

const require = createRequire(import.meta.url);

function createHost(): OpenClawPluginHost {
  const runtime = new OpenClawPluginRuntime({
    config: {
      loadConfig: () => ({ channels: {} }),
      writeConfigFile: async () => {},
    },
  });

  return new OpenClawPluginHost(runtime);
}

describe("registerAllPlugins", () => {
  test("discovers channel ids and aliases from OpenClaw package metadata", () => {
    const packageRoot = mkdtempSync(join(tmpdir(), "openclaw-channel-"));
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@openclaw/feishu",
        openclaw: {
          channel: {
            id: "feishu-package-id",
            aliases: ["lark"],
          },
        },
      }),
    );
    writeFileSync(
      join(packageRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: "feishu",
        channels: ["feishu"],
      }),
    );

    const descriptor = OpenClawChannelPackageDescriptor.fromPackageRoot(
      packageRoot,
    );

    assert.equal(descriptor.pluginId, "feishu");
    assert.deepEqual(descriptor.channelIds, ["feishu"]);
    assert.deepEqual(descriptor.aliases, ["lark"]);
  });

  test("discovers Feishu channel metadata from @openclaw/feishu", () => {
    const descriptor = OpenClawChannelPackageDescriptor.fromPackageRoot(
      dirname(require.resolve("@openclaw/feishu/package.json")),
    );

    assert.equal(descriptor.pluginId, "feishu");
    assert.deepEqual(descriptor.channelIds, ["feishu"]);
    assert.deepEqual(descriptor.aliases, ["lark"]);
  });

  test("discovers Slack channel metadata from @openclaw/slack", () => {
    const descriptor = OpenClawChannelPackageDescriptor.fromPackageRoot(
      dirname(require.resolve("@openclaw/slack/package.json")),
    );

    assert.equal(descriptor.pluginId, "slack");
    assert.deepEqual(descriptor.channelIds, ["slack"]);
    assert.deepEqual(descriptor.extensionSpecifiers, ["./dist/index.js"]);
  });

  test("discovers Tencent-origin channel metadata through OpenClaw package specifiers", () => {
    const qqbot = OpenClawChannelPackageDescriptor.fromPackageRoot(
      dirname(require.resolve("@openclaw/qqbot/package.json")),
    );
    const weixin = OpenClawChannelPackageDescriptor.fromPackageRoot(
      dirname(require.resolve("@openclaw/weixin/package.json")),
    );

    assert.deepEqual(qqbot.channelIds, ["qqbot"]);
    assert.deepEqual(weixin.channelIds, ["openclaw-weixin"]);
  });

  test("registers all OpenClaw channel plugins supported by the gateway", async () => {
    const host = createHost();

    await registerAllPlugins(host);

    for (const channelType of [
      "feishu",
      "lark",
      "discord",
      "slack",
      "telegram",
      "whatsapp",
      "weixin",
      "wechat",
      "qqbot",
    ]) {
      assert.equal(host.hasChannel(channelType), true, channelType);
    }
  });
});
