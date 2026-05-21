import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { inject, injectable } from "inversify";

import {
  OpenClawPluginHost,
  type ChannelQrLoginStartParams,
  type ChannelQrLoginStartResult,
  type ChannelQrLoginWaitParams,
  type ChannelQrLoginWaitResult,
} from "@agent-relay/openclaw-compat";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import QRCode from "qrcode";

import { AccountIdGenerator } from "./account-id-generator.js";

export const ChannelQrLoginProviderToken = Symbol.for(
  "application.ChannelQrLoginProvider",
);

const WECHAT_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const WECHAT_DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const WECHAT_DEFAULT_BOT_TYPE = "3";
const WECHAT_QR_TTL_MS = 5 * 60_000;
const WECHAT_QR_POLL_TIMEOUT_MS = 35_000;
const FEISHU_APP_REGISTRATION_FILE_PATTERN = /^app-registration-.*\.js$/;
const requireFromHere = createRequire(import.meta.url);

let feishuAppRegistrationModulePromise:
  | Promise<FeishuAppRegistrationModule>
  | undefined;

type FeishuAppRegistrationModule = {
  initAppRegistration(channelType: "feishu"): Promise<void>;
  beginAppRegistration(channelType: "feishu"): Promise<{
    qrUrl: string;
    deviceCode: string;
    expireIn: number;
    interval: number;
  }>;
  pollAppRegistration(params: {
    deviceCode: string;
    interval: number;
    expireIn: number;
    initialDomain: "feishu";
    tp: "ob_app";
  }): Promise<
    | {
        status: "success";
        result: { appId: string; appSecret: string; openId?: string };
      }
    | { status: string }
  >;
};

export async function importFeishuAppRegistration(): Promise<FeishuAppRegistrationModule> {
  feishuAppRegistrationModulePromise ??= import(
    await resolveFeishuAppRegistrationModulePath()
  ) as Promise<FeishuAppRegistrationModule>;
  return feishuAppRegistrationModulePromise;
}

async function resolveFeishuAppRegistrationModulePath(): Promise<string> {
  const packageJsonPath = requireFromHere.resolve("@openclaw/feishu/package.json");
  const distDir = join(dirname(packageJsonPath), "dist");
  const files = await readdir(distDir);
  const moduleFile = files.find((file) =>
    FEISHU_APP_REGISTRATION_FILE_PATTERN.test(file),
  );
  if (!moduleFile) {
    throw new Error(
      "Could not find @openclaw/feishu dist app-registration module",
    );
  }

  return pathToFileURL(join(distDir, moduleFile)).href;
}

export interface ChannelQrAuthGateway {
  startChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult>;
  waitForChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult>;
}

export interface ChannelQrLoginProvider {
  supports(channelType: string): boolean;
  start(
    channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult>;
  wait(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult>;
}

@injectable()
export class FeishuQrLoginProvider implements ChannelQrLoginProvider {
  constructor(
    @inject(AccountIdGenerator)
    private readonly accountIdGenerator: AccountIdGenerator,
  ) {}

  supports(channelType: string): boolean {
    return channelType === "feishu" || channelType === "lark";
  }

  async start(
    _channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult> {
    const accountId = this.accountIdGenerator.resolve(params.accountId);
    const registration = await importFeishuAppRegistration();
    await registration.initAppRegistration("feishu");
    const begin = await registration.beginAppRegistration("feishu");
    const qrDataUrl = await QRCode.toDataURL(begin.qrUrl, {
      margin: 1,
      width: 256,
    });

    return {
      qrDataUrl,
      message: "Scan with Feishu/Lark to create and authorize the app.",
      accountId,
      sessionKey: encodeFeishuSetupSession({
        accountId,
        deviceCode: begin.deviceCode,
        expireIn: begin.expireIn,
        interval: begin.interval,
      }),
    };
  }

  async wait(
    _channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    const session = decodeFeishuSetupSession(params.sessionKey);
    const registration = await importFeishuAppRegistration();
    const expireIn = Math.min(
      session.expireIn,
      Math.max(
        Math.ceil((params.timeoutMs ?? 60_000) / 1000),
        session.interval,
      ),
    );
    const outcome = await registration.pollAppRegistration({
      deviceCode: session.deviceCode,
      interval: session.interval,
      expireIn,
      initialDomain: "feishu",
      tp: "ob_app",
    });

    if (!("result" in outcome)) {
      return {
        connected: false,
        message: `Feishu scan status: ${outcome.status}`,
      };
    }

    const result = outcome.result;
    return {
      connected: true,
      message: "Feishu app authorization completed.",
      accountId:
        this.accountIdGenerator.normalize(params.accountId) ??
        session.accountId,
      channelConfig: {
        appId: result.appId,
        appSecret: result.appSecret,
        allowFrom: result.openId ? [result.openId] : ["*"],
        streaming: true,
        groupPolicy: "open",
        requireMention: true,
        replyInThread: "enabled",
      },
    };
  }
}

@injectable()
export class WechatQrLoginProvider implements ChannelQrLoginProvider {
  private readonly activeLogins = new Map<string, WechatActiveLogin>();

  constructor(
    @inject(AccountIdGenerator)
    private readonly accountIdGenerator: AccountIdGenerator,
  ) {}

  supports(channelType: string): boolean {
    return (
      channelType === "wechat" ||
      channelType === "weixin" ||
      channelType === "openclaw-weixin"
    );
  }

  async start(
    _channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult> {
    const accountId = this.accountIdGenerator.resolve(params.accountId);
    this.purgeExpiredLogins();

    const existing = this.activeLogins.get(accountId);
    if (!params.force && existing && this.isLoginFresh(existing)) {
      return {
        accountId,
        message: "二维码已显示，请用手机微信扫描。",
        qrDataUrl: await this.renderQrCode(existing.qrcodeUrl),
        sessionKey: existing.sessionKey,
      };
    }

    const qr = await this.fetchQrCode(WECHAT_DEFAULT_BASE_URL);
    this.activeLogins.set(accountId, {
      accountId,
      currentApiBaseUrl: WECHAT_DEFAULT_BASE_URL,
      qrcode: qr.qrcode,
      qrcodeUrl: qr.qrcodeUrl,
      sessionKey: accountId || randomUUID(),
      startedAt: Date.now(),
    });

    return {
      accountId,
      message: "用手机微信扫描以下二维码，以继续连接：",
      qrDataUrl: await this.renderQrCode(qr.qrcodeUrl),
      sessionKey: accountId,
    };
  }

  protected async fetchQrCode(
    apiBaseUrl: string,
  ): Promise<WechatQrCodeResponse> {
    const { apiPostFetch } = await import("@openclaw/weixin/src/api/api.js");
    const rawText = await apiPostFetch({
      baseUrl: apiBaseUrl,
      endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(
        WECHAT_DEFAULT_BOT_TYPE,
      )}`,
      body: JSON.stringify({ local_token_list: [] }),
      label: "fetchWechatQRCode",
    });
    const parsed = JSON.parse(rawText) as {
      qrcode?: unknown;
      qrcode_img_content?: unknown;
    };
    if (
      typeof parsed.qrcode !== "string" ||
      typeof parsed.qrcode_img_content !== "string"
    ) {
      throw new Error("WeChat QR response is invalid.");
    }
    return {
      qrcode: parsed.qrcode,
      qrcodeUrl: parsed.qrcode_img_content,
    };
  }

  async wait(
    _channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    const sessionKey = params.sessionKey || params.accountId || "";
    const activeLogin = this.activeLogins.get(sessionKey);
    if (!activeLogin) {
      return {
        connected: false,
        message: "当前没有进行中的登录，请先发起登录。",
      };
    }

    if (!this.isLoginFresh(activeLogin)) {
      this.activeLogins.delete(sessionKey);
      return {
        connected: false,
        message: "二维码已过期，请重新生成。",
      };
    }

    const status = await this.pollQrStatus(
      activeLogin.currentApiBaseUrl,
      activeLogin.qrcode,
      params.timeoutMs,
    );
    return this.toWaitResult(sessionKey, activeLogin, status);
  }

  protected async pollQrStatus(
    apiBaseUrl: string,
    qrcode: string,
    timeoutMs?: number,
  ): Promise<WechatQrStatusResponse> {
    const { apiGetFetch } = await import("@openclaw/weixin/src/api/api.js");
    try {
      const rawText = await apiGetFetch({
        baseUrl: apiBaseUrl,
        endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(
          qrcode,
        )}`,
        timeoutMs: Math.min(
          Math.max(timeoutMs ?? WECHAT_QR_POLL_TIMEOUT_MS, 1000),
          WECHAT_QR_POLL_TIMEOUT_MS,
        ),
        label: "pollWechatQRStatus",
      });
      return JSON.parse(rawText) as WechatQrStatusResponse;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { status: "wait" };
      }
      throw err;
    }
  }

  private async toWaitResult(
    sessionKey: string,
    activeLogin: WechatActiveLogin,
    status: WechatQrStatusResponse,
  ): Promise<ChannelQrLoginWaitResult> {
    switch (status.status) {
      case "wait":
        return { connected: false, message: "等待微信扫码确认。" };
      case "scaned":
        return { connected: false, message: "正在验证。" };
      case "scaned_but_redirect":
        if (status.redirect_host) {
          activeLogin.currentApiBaseUrl = `https://${status.redirect_host}`;
        }
        return { connected: false, message: "正在切换登录验证节点。" };
      case "need_verifycode":
        return {
          connected: false,
          message: "微信要求输入验证码；当前网页登录暂不支持验证码提交。",
        };
      case "verify_code_blocked":
        this.activeLogins.delete(sessionKey);
        return {
          connected: false,
          message: "多次输入错误，连接流程已停止。请稍后再试。",
        };
      case "expired":
        this.activeLogins.delete(sessionKey);
        return { connected: false, message: "二维码已过期，请重新生成。" };
      case "binded_redirect":
        this.activeLogins.delete(sessionKey);
        return {
          connected: false,
          message: "已连接过此 OpenClaw，无需重复连接。",
        };
      case "confirmed":
        return this.toConfirmedResult(sessionKey, status);
      default:
        return {
          connected: false,
          message: `未知微信扫码状态: ${String(status.status)}`,
        };
    }
  }

  private toConfirmedResult(
    sessionKey: string,
    status: WechatQrStatusResponse,
  ): ChannelQrLoginWaitResult {
    this.activeLogins.delete(sessionKey);
    if (!status.bot_token || !status.ilink_bot_id) {
      return {
        connected: false,
        message: "WeChat login completed without account credentials.",
      };
    }

    const accountId = normalizeAccountId(status.ilink_bot_id);
    const baseUrl = status.baseurl?.trim() || WECHAT_DEFAULT_BASE_URL;
    return {
      connected: true,
      message: "已将此 OpenClaw 连接到微信。",
      accountId,
      channelConfig: {
        accountId,
        baseUrl,
        cdnBaseUrl: WECHAT_DEFAULT_CDN_BASE_URL,
        configured: true,
        enabled: true,
        token: status.bot_token,
        ...(status.ilink_user_id
          ? {
              userId: status.ilink_user_id,
              allowFrom: [status.ilink_user_id],
            }
          : {}),
      },
    };
  }

  private isLoginFresh(login: WechatActiveLogin): boolean {
    return Date.now() - login.startedAt < WECHAT_QR_TTL_MS;
  }

  private purgeExpiredLogins(): void {
    for (const [sessionKey, login] of this.activeLogins) {
      if (!this.isLoginFresh(login)) {
        this.activeLogins.delete(sessionKey);
      }
    }
  }

  private async renderQrCode(qrcodeUrl: string): Promise<string> {
    return await QRCode.toDataURL(qrcodeUrl, {
      margin: 1,
      width: 256,
    });
  }
}

interface WechatActiveLogin {
  accountId: string;
  currentApiBaseUrl: string;
  qrcode: string;
  qrcodeUrl: string;
  sessionKey: string;
  startedAt: number;
}

interface WechatQrCodeResponse {
  qrcode: string;
  qrcodeUrl: string;
}

interface WechatQrStatusResponse {
  status:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

@injectable()
export class PluginQrLoginProvider implements ChannelQrLoginProvider {
  constructor(
    @inject(OpenClawPluginHost)
    private readonly gateway: ChannelQrAuthGateway,
    @inject(AccountIdGenerator)
    private readonly accountIdGenerator: AccountIdGenerator,
  ) {}

  supports(): boolean {
    return true;
  }

  async start(
    channelType: string,
    params: ChannelQrLoginStartParams,
  ): Promise<ChannelQrLoginStartResult> {
    const accountId = this.accountIdGenerator.resolve(params.accountId);
    const result = await this.gateway.startChannelQrLogin(channelType, {
      ...params,
      accountId,
    });
    return { ...result, accountId: result.accountId ?? accountId };
  }

  async wait(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    return await this.gateway.waitForChannelQrLogin(channelType, {
      ...params,
      accountId: this.accountIdGenerator.normalize(params.accountId),
    });
  }
}

interface FeishuSetupSession {
  accountId: string;
  deviceCode: string;
  interval: number;
  expireIn: number;
}

function encodeFeishuSetupSession(session: FeishuSetupSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
}

function decodeFeishuSetupSession(rawSessionKey?: string): FeishuSetupSession {
  if (!rawSessionKey) {
    throw new Error("Feishu setup session is missing.");
  }
  const parsed = JSON.parse(
    Buffer.from(rawSessionKey, "base64url").toString("utf8"),
  ) as Partial<FeishuSetupSession>;
  if (
    !parsed.accountId ||
    !parsed.deviceCode ||
    !parsed.interval ||
    !parsed.expireIn
  ) {
    throw new Error("Feishu setup session is invalid.");
  }
  return {
    accountId: parsed.accountId,
    deviceCode: parsed.deviceCode,
    interval: parsed.interval,
    expireIn: parsed.expireIn,
  };
}
