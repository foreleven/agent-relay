import { SessionKey } from "@agent-relay/domain";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@agent-relay/openclaw-compat";

import { prisma } from "../apps/gateway/src/store/prisma.js";
import { channelTypeRegistry } from "../apps/gateway/src/runtime/channel-type-registry.js";
import { projectRuntimeChannelConfig } from "../apps/gateway/src/runtime/channels/index.js";
import { registerAllPlugins } from "../apps/gateway/src/register-plugins.js";

type OpenClawConfigLike = Record<string, unknown>;

type OpenClawChannelPlugin = {
  outbound?: {
    sendText?: (params: {
      cfg: OpenClawConfigLike;
      to: string;
      text: string;
      accountId?: string;
    }) => Promise<unknown>;
  };
};

type OpenClawChannelHost = {
  readonly host: OpenClawPluginHost;
  readonly runtime: OpenClawPluginRuntime;
};

type ChannelTextSender = (params: {
  cfg: OpenClawConfigLike;
  to: string;
  text: string;
  accountId?: string;
}) => Promise<unknown>;

interface CliOptions {
  readonly to?: string;
  readonly text: string;
  readonly dryRun: boolean;
}

interface ChannelBindingRow {
  readonly id: string;
  readonly name: string;
  readonly channelType: string;
  readonly accountId: string;
  readonly channelConfig: string;
  readonly agentId: string;
  readonly enabled: boolean;
}

interface PushTarget {
  readonly to: string;
  readonly source: string;
}

interface ChannelPushSender {
  supports(channelType: string): boolean;
  send(params: {
    binding: ChannelBindingRow;
    cfg: OpenClawConfigLike;
    host: OpenClawPluginHost;
    to: string;
    text: string;
    dryRun: boolean;
  }): Promise<unknown>;
}

class OpenClawPluginChannelPushSender implements ChannelPushSender {
  supports(channelType: string): boolean {
    return Boolean(channelTypeRegistry.canonicalize(channelType));
  }

  async send(params: {
    binding: ChannelBindingRow;
    cfg: OpenClawConfigLike;
    host: OpenClawPluginHost;
    to: string;
    text: string;
    dryRun: boolean;
  }): Promise<unknown> {
    if (params.dryRun) {
      return { dryRun: true };
    }

    const sendText = this.resolveSendText(params.host, params.binding.channelType);
    return sendText({
      cfg: params.cfg,
      to: params.to,
      text: params.text,
      accountId: params.binding.accountId,
    });
  }

  private resolveSendText(
    host: OpenClawPluginHost,
    channelType: string,
  ): ChannelTextSender {
    const plugin = host.getChannelPlugin(channelType) as OpenClawChannelPlugin | undefined;
    const sendText = plugin?.outbound?.sendText;
    if (!sendText) {
      throw new Error(
        `OpenClaw plugin for ${channelType} does not expose outbound.sendText.`,
      );
    }
    return sendText;
  }
}

class BindingChannelPushProbe {
  private readonly senders: ChannelPushSender[] = [
    new OpenClawPluginChannelPushSender(),
  ];

  async run(options: CliOptions): Promise<void> {
    const binding = await this.loadFirstBinding();
    const cfg = this.buildOpenClawConfig(binding);
    const openClaw = await this.buildOpenClawHost(cfg);
    const target = await this.resolveTarget(binding, options.to);
    const sender = this.resolveSender(binding.channelType);

    this.printPlan(binding, target, options);
    const result = await sender.send({
      binding,
      cfg,
      host: openClaw.host,
      to: target.to,
      text: options.text,
      dryRun: options.dryRun,
    });
    console.log("push result:", JSON.stringify(result, null, 2));
  }

  private async loadFirstBinding(): Promise<ChannelBindingRow> {
    const binding = await prisma.channelBinding.findFirst({
      orderBy: { createdAt: "asc" },
    });
    if (!binding) {
      throw new Error("No rows found in channel_bindings.");
    }
    if (!binding.enabled) {
      throw new Error(`First binding ${binding.id} is disabled.`);
    }
    return binding;
  }

  private async buildOpenClawHost(
    cfg: OpenClawConfigLike,
  ): Promise<OpenClawChannelHost> {
    const runtime = new OpenClawPluginRuntime({
      config: {
        loadConfig: () => cfg as never,
        current: () => cfg as never,
        mutateConfigFile: async () => {
          throw new Error("Config mutation is not supported");
        },
        replaceConfigFile: async () => {
          throw new Error("Config mutation is not supported");
        },
        writeConfigFile: async () => {
          throw new Error("Config mutation is not supported");
        },
      },
    });
    const host = new OpenClawPluginHost(runtime);
    await registerAllPlugins(host);
    return { host, runtime };
  }

  private buildOpenClawConfig(binding: ChannelBindingRow): OpenClawConfigLike {
    const channelKey = channelTypeRegistry.canonicalize(binding.channelType);
    const config = projectRuntimeChannelConfig(
      channelKey as Parameters<typeof projectRuntimeChannelConfig>[0],
      {
        ...this.parseChannelConfig(binding),
        bindingId: binding.id,
        enabled: true,
      },
    );

    const channelConfig =
      binding.accountId === "default"
        ? config
        : { accounts: { [binding.accountId]: config } };

    return {
      channels: {
        [channelKey]: channelConfig,
      },
      agents: {
        list: [{ id: binding.agentId, name: binding.agentId }],
      },
      bindings: [
        {
          type: "route",
          agentId: binding.agentId,
          match: {
            channel: channelKey,
            accountId: binding.accountId,
          },
        },
      ],
      session: {
        dmScope: "per-account-channel-peer",
      },
    };
  }

  private parseChannelConfig(binding: ChannelBindingRow): Record<string, unknown> {
    const parsed = JSON.parse(binding.channelConfig) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Binding ${binding.id} channel_config is not an object.`);
    }
    return parsed;
  }

  private async resolveTarget(
    binding: ChannelBindingRow,
    explicitTarget: string | undefined,
  ): Promise<PushTarget> {
    const envTarget =
      process.env["PUSH_TO"] ??
      process.env["CHANNEL_PUSH_TO"] ??
      process.env["FEISHU_PUSH_TO"];
    const directTarget = normalizeOptional(explicitTarget ?? envTarget);
    if (directTarget) {
      return { to: directTarget, source: "argument/env" };
    }

    const recent = await prisma.message.findFirst({
      where: { channelBindingId: binding.id },
      orderBy: { createdAt: "desc" },
    });
    const peerId = recent
      ? SessionKey.fromString(recent.sessionKey).agentParts?.peerId
      : undefined;
    if (peerId) {
      return { to: peerId, source: `latest message ${recent?.id}` };
    }

    throw new Error(
      "No push target found. Pass --to <target> or set PUSH_TO/CHANNEL_PUSH_TO/FEISHU_PUSH_TO.",
    );
  }

  private resolveSender(channelType: string): ChannelPushSender {
    const sender = this.senders.find((candidate) =>
      candidate.supports(channelType),
    );
    if (!sender) {
      throw new Error(`No proactive sender implemented for ${channelType}.`);
    }
    return sender;
  }

  private printPlan(
    binding: ChannelBindingRow,
    target: PushTarget,
    options: CliOptions,
  ): void {
    console.log(
      JSON.stringify(
        {
          binding: {
            id: binding.id,
            name: binding.name,
            channelType: binding.channelType,
            accountId: binding.accountId,
          },
          target,
          text: options.text,
          dryRun: options.dryRun,
        },
        null,
        2,
      ),
    );
  }
}

function parseCliOptions(argv: string[]): CliOptions {
  let to: string | undefined;
  let text = `Manual channel push probe ${new Date().toISOString()}`;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--to") {
      to = readValue(argv, index, "--to");
      index += 1;
      continue;
    }
    if (arg === "--text") {
      text = readValue(argv, index, "--text");
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { to, text, dryRun };
}

function readValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printUsage(): void {
  console.log(`Usage:
  node --import tsx/esm scripts/push-channel-message.ts [--to <target>] [--text <text>] [--dry-run]

Target resolution:
  1. --to
  2. PUSH_TO / CHANNEL_PUSH_TO / FEISHU_PUSH_TO
  3. peer id from the latest message for the first channel binding
`);
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

try {
  await new BindingChannelPushProbe().run(parseCliOptions(process.argv.slice(2)));
} finally {
  await prisma.$disconnect();
}
