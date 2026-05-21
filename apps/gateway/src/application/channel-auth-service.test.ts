import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ChannelAuthService,
  UnsupportedChannelQrAuthError,
} from "./channel-auth-service.js";
import type { AccountIdGenerator } from "./account-id-generator.js";
import {
  importFeishuAppRegistration,
  WechatQrLoginProvider,
} from "./channel-qr-login-provider.js";

const accountIds = {
  resolve: (accountId: string | undefined) => accountId?.trim() || "generated",
  normalize: (accountId: string | undefined) => accountId?.trim() || undefined,
  generate: () => "generated",
} as AccountIdGenerator;

describe("ChannelAuthService", () => {
  test("dispatches QR login to the first matching provider", async () => {
    const calls: string[] = [];
    const service = new ChannelAuthService([
      {
        supports: (channelType) => channelType === "wechat",
        start: async (channelType, params) => {
          calls.push(`start:${channelType}:${params.force}`);
          return {
            qrDataUrl: "data:image/png;base64,abc",
            message: "scan",
            accountId: "generated",
            sessionKey: "session-1",
          };
        },
        wait: async (channelType, params) => {
          calls.push(
            `wait:${channelType}:${params.accountId}:${params.sessionKey}:${params.timeoutMs}`,
          );
          return {
            connected: true,
            message: "connected",
            accountId: "wx-account",
          };
        },
      },
    ]);

    const start = await service.startQrLogin("wechat", {
      force: true,
    });
    const wait = await service.waitForQrLogin("wechat", {
      accountId: start.accountId,
      sessionKey: start.sessionKey,
      timeoutMs: 1500,
    });

    assert.deepEqual(calls, [
      "start:wechat:true",
      "wait:wechat:generated:session-1:1500",
    ]);
    assert.equal(start.qrDataUrl, "data:image/png;base64,abc");
    assert.equal(wait.connected, true);
    assert.equal(wait.accountId, "wx-account");
  });

  test("rejects channels without a QR login provider", async () => {
    const service = new ChannelAuthService([]);

    await assert.rejects(
      () => service.startQrLogin("slack", {}),
      UnsupportedChannelQrAuthError,
    );
  });
});

describe("WechatQrLoginProvider", () => {
  test("renders a gateway-owned WeChat login URL as QR image data", async () => {
    const calls: string[] = [];
    class TestWechatQrLoginProvider extends WechatQrLoginProvider {
      protected override async fetchQrCode(apiBaseUrl: string) {
        calls.push(apiBaseUrl);
        return {
          qrcode: "qrcode-token",
          qrcodeUrl: "https://weixin.example.test/login",
        };
      }
    }
    const provider = new TestWechatQrLoginProvider(accountIds);

    const result = await provider.start("wechat", { force: true });

    assert.deepEqual(calls, ["https://ilinkai.weixin.qq.com"]);
    assert.equal(result.accountId, "generated");
    assert.equal(result.sessionKey, "generated");
    assert.match(result.qrDataUrl ?? "", /^data:image\/png;base64,/);
  });

  test("returns completed WeChat credentials as channel config for the gateway DB", async () => {
    class TestWechatQrLoginProvider extends WechatQrLoginProvider {
      protected override async fetchQrCode() {
        return {
          qrcode: "qrcode-token",
          qrcodeUrl: "https://weixin.example.test/login",
        };
      }

      protected override async pollQrStatus() {
        return {
          status: "confirmed" as const,
          ilink_bot_id: "abc@im.bot",
          bot_token: "bot-token",
          baseurl: "https://ilink-returned.example.test",
          ilink_user_id: "user@im.wechat",
        };
      }
    }
    const provider = new TestWechatQrLoginProvider(accountIds);
    const start = await provider.start("wechat", { force: true });

    const result = await provider.wait("wechat", {
      accountId: start.accountId,
      sessionKey: start.sessionKey,
    });

    assert.equal(result.accountId, "abc-im-bot");
    assert.deepEqual(result.channelConfig, {
      accountId: "abc-im-bot",
      allowFrom: ["user@im.wechat"],
      baseUrl: "https://ilink-returned.example.test",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      configured: true,
      enabled: true,
      token: "bot-token",
      userId: "user@im.wechat",
    });
  });
});

describe("FeishuQrLoginProvider", () => {
  test("loads the packaged Feishu app registration runtime module", async () => {
    const registration = await importFeishuAppRegistration();

    assert.equal(typeof registration.initAppRegistration, "function");
    assert.equal(typeof registration.beginAppRegistration, "function");
    assert.equal(typeof registration.pollAppRegistration, "function");
  });
});
