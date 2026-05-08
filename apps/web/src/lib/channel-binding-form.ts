import type { ChannelBinding, SessionIsolationStrategy } from "@/lib/api";

export const SESSION_ISOLATION_OPTIONS: Array<{
  value: SessionIsolationStrategy;
  label: string;
  summary: string;
}> = [
  {
    value: "sessionKey",
    label: "SessionKey",
    summary: "Reuse protocol sessions per channel session.",
  },
  {
    value: "accountId",
    label: "Account ID",
    summary: "Reuse one protocol session for the bound account.",
  },
  {
    value: "request",
    label: "Request",
    summary: "Start an isolated protocol session for every request.",
  },
];

export const CHANNEL_OPTIONS = [
  { value: "feishu", label: "Feishu / Lark", supportsQr: true },
  { value: "discord", label: "Discord", supportsQr: false },
  { value: "slack", label: "Slack", supportsQr: false },
  { value: "telegram", label: "Telegram", supportsQr: false },
  { value: "whatsapp", label: "WhatsApp", supportsQr: false },
  { value: "wechat", label: "WeChat / Weixin", supportsQr: true },
  { value: "qqbot", label: "QQ Bot", supportsQr: false },
] as const;

export const CHANNEL_CONFIG_TEMPLATES: Record<
  string,
  Record<string, unknown>
> = {
  feishu: {
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    allowFrom: ["*"],
    streaming: true,
    groupPolicy: "open",
    requireMention: true,
    replyInThread: "enabled",
  },
  discord: {
    botToken: "",
    allowFrom: ["*"],
  },
  slack: {
    botToken: "",
    appToken: "",
    signingSecret: "",
    allowFrom: ["*"],
  },
  telegram: {
    botToken: "",
    allowFrom: ["*"],
  },
  whatsapp: {
    allowFrom: ["*"],
  },
  wechat: {},
  qqbot: {
    appId: "",
    token: "",
    secret: "",
    allowFrom: ["*"],
  },
};

export const CHANNEL_CONFIG_FIELDS: Record<
  string,
  Array<{
    key: string;
    label: string;
    secret?: boolean;
    help?: string;
    type?: "text" | "secret" | "boolean" | "select" | "list";
    options?: Array<{ value: string; label: string }>;
  }>
> = {
  feishu: [
    { key: "appId", label: "App ID", help: "Feishu/Lark app credential." },
    {
      key: "appSecret",
      label: "App Secret",
      secret: true,
      help: "Secret for the same app.",
    },
    {
      key: "verificationToken",
      label: "Verification Token",
      secret: true,
      help: "Optional event verification token.",
    },
    {
      key: "encryptKey",
      label: "Encrypt Key",
      secret: true,
      help: "Optional event encryption key.",
    },
    {
      key: "allowFrom",
      label: "Allow From",
      help: "Allowed user open IDs, comma-separated.",
      type: "list",
    },
    {
      key: "streaming",
      label: "Streaming Cards",
      help: "Use Feishu cards for streaming and rich final replies.",
      type: "boolean",
    },
    {
      key: "groupPolicy",
      label: "Group Policy",
      help: "Open allows group mentions by default; allowlist restricts group access.",
      type: "select",
      options: [
        { value: "open", label: "Open" },
        { value: "allowlist", label: "Allowlist" },
        { value: "disabled", label: "Disabled" },
      ],
    },
    {
      key: "requireMention",
      label: "Require Mention",
      help: "Require the bot to be mentioned before group messages dispatch.",
      type: "boolean",
    },
    {
      key: "replyInThread",
      label: "Reply In Thread",
      help: "Create or continue Feishu topic threads for group replies.",
      type: "select",
      options: [
        { value: "enabled", label: "Enabled" },
        { value: "disabled", label: "Disabled" },
      ],
    },
  ],
  discord: [
    {
      key: "botToken",
      label: "Bot Token",
      secret: true,
      help: "Bot token from the Discord Developer Portal.",
    },
    {
      key: "allowFrom",
      label: "Allow From",
      help: "Allowed Discord user IDs, comma-separated.",
      type: "list",
    },
  ],
  slack: [
    {
      key: "botToken",
      label: "Bot Token",
      secret: true,
      help: "xoxb token used by the bot.",
    },
    {
      key: "appToken",
      label: "App Token",
      secret: true,
      help: "xapp token for Socket Mode.",
    },
    {
      key: "signingSecret",
      label: "Signing Secret",
      secret: true,
      help: "Required when using HTTP Events API mode.",
    },
    {
      key: "allowFrom",
      label: "Allow From",
      help: "Allowed Slack user IDs, comma-separated.",
      type: "list",
    },
  ],
  telegram: [
    {
      key: "botToken",
      label: "Bot Token",
      secret: true,
      help: "Token created in BotFather.",
    },
    {
      key: "allowFrom",
      label: "Allow From",
      help: "Allowed numeric Telegram user IDs, comma-separated.",
      type: "list",
    },
  ],
  whatsapp: [
    {
      key: "allowFrom",
      label: "Allow From",
      help: "Allowed WhatsApp sender IDs or phone numbers, comma-separated.",
      type: "list",
    },
  ],
  qqbot: [
    { key: "appId", label: "App ID", help: "QQ Bot app ID." },
    {
      key: "token",
      label: "Token",
      secret: true,
      help: "QQ Bot verification token.",
    },
    {
      key: "secret",
      label: "Secret",
      secret: true,
      help: "QQ Bot app secret.",
    },
    {
      key: "allowFrom",
      label: "Allow From",
      help: "Allowed QQ sender IDs, comma-separated.",
      type: "list",
    },
  ],
};

export interface ChannelGuide {
  docsUrl: string;
  summary: string;
  setup: string;
  fields: string[];
}

export const CHANNEL_GUIDES: Record<string, ChannelGuide> = {
  feishu: {
    docsUrl: "https://docs.openclaw.ai/channels/feishu",
    summary:
      "Enterprise Feishu/Lark bot integration with app credentials, event verification, and optional scan-to-create setup.",
    setup:
      "Use QR setup to create and authorize a Feishu/Lark app, or paste an existing App ID and App Secret manually.",
    fields: [
      "App ID and App Secret identify the Feishu/Lark app.",
      "Verification Token and Encrypt Key are only needed when your event subscription requires them.",
      "Allow From limits who can route messages into the agent.",
      "Reply In Thread controls whether group replies create or continue Feishu topic threads.",
      "Group Policy and Require Mention control when group messages can dispatch.",
    ],
  },
  discord: {
    docsUrl: "https://docs.openclaw.ai/channels/discord",
    summary:
      "Discord bot integration for private servers, direct messages, and controlled guild access.",
    setup:
      "Create a Discord application and bot, copy the bot token, then allow the bot into the server or channel you want to use.",
    fields: [
      "Bot Token is required.",
      "Allow From should contain approved Discord user IDs.",
    ],
  },
  slack: {
    docsUrl: "https://docs.openclaw.ai/channels/slack",
    summary:
      "Slack workspace integration using Socket Mode or HTTP Events API.",
    setup:
      "Socket Mode uses Bot Token plus App Token. HTTP mode uses Bot Token plus Signing Secret.",
    fields: [
      "Bot Token is required for both modes.",
      "App Token is required for Socket Mode.",
      "Signing Secret is required for HTTP Events API mode.",
      "Allow From should contain approved Slack user IDs.",
    ],
  },
  telegram: {
    docsUrl: "https://docs.openclaw.ai/channels/telegram",
    summary:
      "Telegram bot integration backed by BotFather tokens and pairing allowlists.",
    setup:
      "Create or select a Telegram bot in BotFather, copy its token, then approve the users that can talk to the agent.",
    fields: [
      "Bot Token is required.",
      "Allow From should contain approved numeric Telegram user IDs.",
    ],
  },
  whatsapp: {
    docsUrl: "https://docs.openclaw.ai/channels/whatsapp",
    summary:
      "WhatsApp channel integration that relies on plugin login state and allowlists.",
    setup:
      "Install or enable the WhatsApp plugin, complete the login flow outside this binding form, then restrict access with allowlists.",
    fields: [
      "Allow From should contain approved WhatsApp senders.",
      "Additional group allowlist keys can be added in Advanced Config JSON.",
    ],
  },
  wechat: {
    docsUrl: "https://docs.openclaw.ai/channels/wechat",
    summary: "WeChat/Weixin QR login integration for OpenClaw account binding.",
    setup:
      "Generate a QR code, scan it in WeChat, then check login before saving.",
    fields: [
      "Account ID is generated automatically.",
      "Advanced Config JSON can stay empty for normal QR login.",
    ],
  },
  qqbot: {
    docsUrl: "https://docs.openclaw.ai/channels/qqbot",
    summary:
      "QQ Bot integration using Tencent bot application credentials and an inbound allowlist.",
    setup:
      "Create or use an existing QQ Bot application, then paste the app ID, token, and secret.",
    fields: [
      "App ID identifies the QQ Bot application.",
      "Token and Secret authenticate events.",
      "Allow From limits approved senders.",
    ],
  },
};

export interface FormState {
  name: string;
  channelType: string;
  accountId: string;
  agentId: string;
  sessionIsolationStrategy: SessionIsolationStrategy;
  enabled: boolean;
  channelConfigJson: string;
}

export const EMPTY_FORM: FormState = {
  name: "",
  channelType: "feishu",
  accountId: "default",
  agentId: "",
  sessionIsolationStrategy: "sessionKey",
  enabled: true,
  channelConfigJson: stringifyConfig(CHANNEL_CONFIG_TEMPLATES["feishu"]),
};

export class ChannelFormMapper {
  toPayload(form: FormState): Omit<
    ChannelBinding,
    "id" | "createdAt" | "accountId"
  > & {
    accountId?: string;
  } {
    const accountId = form.accountId.trim();
    return {
      name: form.name,
      channelType: form.channelType,
      ...(accountId ? { accountId } : {}),
      agentId: form.agentId,
      sessionIsolationStrategy: form.sessionIsolationStrategy,
      enabled: form.enabled,
      channelConfig: this.parseConfig(form.channelConfigJson),
    };
  }

  fromBinding(binding: ChannelBinding): FormState {
    return {
      name: binding.name,
      channelType: binding.channelType,
      accountId: binding.accountId,
      agentId: binding.agentId,
      sessionIsolationStrategy:
        binding.sessionIsolationStrategy ?? "sessionKey",
      enabled: binding.enabled,
      channelConfigJson: stringifyConfig(binding.channelConfig),
    };
  }

  private parseConfig(rawConfig: string): Record<string, unknown> {
    const parsed = JSON.parse(rawConfig || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Channel config must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }
}

export function channelLabel(channelType: string): string {
  return (
    CHANNEL_OPTIONS.find((channel) => channel.value === channelType)?.label ??
    channelType
  );
}

export function supportsQrLogin(channelType: string): boolean {
  return CHANNEL_OPTIONS.some(
    (channel) => channel.value === channelType && channel.supportsQr,
  );
}

export function normalizeChannelType(channelType: string | undefined): string {
  const normalized = channelType?.trim();
  return CHANNEL_OPTIONS.some((channel) => channel.value === normalized)
    ? normalized!
    : "feishu";
}

export function channelCreateHref(channelType: string): string {
  return `/channels/new/${normalizeChannelType(channelType)}`;
}

export function channelGuide(channelType: string): ChannelGuide {
  return CHANNEL_GUIDES[normalizeChannelType(channelType)];
}

export function stringifyConfig(
  config: Record<string, unknown> | undefined,
): string {
  return JSON.stringify(config ?? {}, null, 2);
}

export function summarizeConfig(config: Record<string, unknown>): string {
  const keys = Object.keys(config).filter((key) => config[key] !== "");
  if (keys.length === 0) {
    return "{}";
  }
  return keys.slice(0, 3).join(", ") + (keys.length > 3 ? "..." : "");
}
