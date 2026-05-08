import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  CHANNEL_OPTIONS,
  ChannelFormMapper,
  channelCreateHref,
  channelGuide,
  normalizeChannelType,
} from "./channel-binding-form.js";

describe("channel binding form metadata", () => {
  test("maps every channel selection to a stable create route", () => {
    for (const channel of CHANNEL_OPTIONS) {
      assert.equal(
        channelCreateHref(channel.value),
        `/channels/new/${channel.value}`,
      );
    }
    assert.equal(channelCreateHref("feishu"), "/channels/new/feishu");
    assert.equal(channelCreateHref("wechat"), "/channels/new/wechat");
    assert.equal(channelCreateHref("unknown"), "/channels/new/feishu");
  });

  test("normalizes route params to supported channel types", () => {
    assert.equal(normalizeChannelType("telegram"), "telegram");
    assert.equal(normalizeChannelType("bad-channel"), "feishu");
  });

  test("has a user-facing guide for every selectable channel", () => {
    for (const channel of CHANNEL_OPTIONS) {
      const guide = channelGuide(channel.value);
      assert.equal(typeof guide.docsUrl, "string", channel.value);
      assert.ok(guide.docsUrl.startsWith("https://docs.openclaw.ai/channels/"));
      assert.ok(guide.summary.length > 0, channel.value);
      assert.ok(guide.setup.length > 0, channel.value);
      assert.ok(guide.fields.length > 0, channel.value);
    }
  });

  test("omits blank account IDs so the gateway can generate them", () => {
    const payload = new ChannelFormMapper().toPayload({
      name: "WeChat",
      channelType: "wechat",
      accountId: " ",
      agentId: "agent-1",
      sessionIsolationStrategy: "sessionKey",
      enabled: true,
      channelConfigJson: "{}",
    });

    assert.equal("accountId" in payload, false);
  });
});
