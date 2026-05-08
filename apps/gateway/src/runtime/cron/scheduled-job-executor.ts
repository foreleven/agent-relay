import { inject, injectable } from "inversify";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
  ChannelMessageRepository,
  SessionKey,
  type ChannelBindingSnapshot,
  type ChannelMessageRepository as ChannelMessageRepositoryPort,
} from "@agent-relay/domain";
import { OpenClawPluginHost } from "@agent-relay/openclaw-compat";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../../infra/logger.js";
import { RuntimeAgentRegistry } from "../runtime-agent-registry.js";
import { RuntimeOpenClawConfigProjection } from "../runtime-openclaw-config-projection.js";

export interface ScheduledJobPayload {
  bindingId: string;
  sessionKey: string;
  prompt: string;
}

export interface ScheduledJobExecutionContext {
  jobId: string;
  jobName: string;
  queuedAt?: string;
}

export interface ScheduledJobExecutionResult {
  status: "sent" | "skipped";
  reason?: string;
  bindingId: string;
}

type ChannelBinding = ChannelBindingSnapshot;

/** Executes one BunQueue-delivered scheduled outbound job. */
@injectable()
export class ScheduledJobExecutor {
  constructor(
    @inject(ChannelBindingRepository)
    private readonly bindingRepo: ChannelBindingRepository,
    @inject(AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
    @inject(RuntimeOpenClawConfigProjection)
    private readonly openClawConfigProjection: RuntimeOpenClawConfigProjection,
    @inject(OpenClawPluginHost)
    private readonly host: OpenClawPluginHost,
    @inject(ChannelMessageRepository)
    private readonly messageRepository: ChannelMessageRepositoryPort,
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
  ) {}

  async execute(
    payload: ScheduledJobPayload,
    context: ScheduledJobExecutionContext,
  ): Promise<ScheduledJobExecutionResult> {
    const normalized = parseScheduledJobPayload(payload);
    const bindingAggregate = await this.bindingRepo.findById(
      normalized.bindingId,
    );
    if (!bindingAggregate) {
      return this.skipped(normalized.bindingId, "binding_not_found");
    }

    const binding = bindingAggregate.snapshot();
    if (!binding.enabled) {
      return this.skipped(binding.id, "binding_disabled");
    }

    const agentAggregate = await this.agentRepo.findById(binding.agentId);
    if (!agentAggregate) {
      return this.skipped(binding.id, "agent_not_found");
    }

    const agent = agentAggregate.snapshot();
    await this.agentRegistry.upsertAgent(agent);
    const scopedConfig = this.openClawConfigProjection.buildScopedConfig([
      binding,
    ]);

    const agentClient = await this.agentRegistry.getAgentClient(
      binding.agentId,
    );
    const sessionKey = SessionKey.fromString(normalized.sessionKey);
    const metadata = buildScheduledJobMetadata(context);

    await this.persistInput(binding, sessionKey, normalized.prompt, metadata);

    let replyText: string | undefined;
    try {
      const result = await agentClient.send({
        message: normalized.prompt,
        sessionKey,
        accountId: binding.accountId,
        binding,
      });
      replyText = result?.text;
    } catch (error) {
      this.logger.error(
        { bindingId: binding.id, agentId: binding.agentId, err: error },
        "agent call failed for scheduled job",
      );
      replyText = "(agent temporarily unavailable)";
    }

    if (!replyText) {
      return this.skipped(binding.id, "empty_agent_reply");
    }

    const delivery = await this.deliverReply(
      binding,
      sessionKey,
      replyText,
      scopedConfig,
    );
    await this.persistOutput(binding, sessionKey, replyText, {
      ...metadata,
      kind: "final",
      proactive: true,
      ...(delivery ? { delivery } : {}),
    });

    return { status: "sent", bindingId: binding.id };
  }

  private skipped(
    bindingId: string,
    reason: string,
  ): ScheduledJobExecutionResult {
    this.logger.warn({ bindingId, reason }, "scheduled job skipped");
    return { status: "skipped", reason, bindingId };
  }

  private async deliverReply(
    binding: ChannelBinding,
    sessionKey: SessionKey,
    replyText: string,
    config: OpenClawConfig,
  ): Promise<Record<string, unknown> | undefined> {
    const target = sessionKey.agentParts?.peerId;
    if (!target) {
      throw new Error(
        `Cannot resolve scheduled job target from session key ${sessionKey.toString()}`,
      );
    }

    const plugin = this.host.getChannelPlugin(binding.channelType);
    const sendText = plugin?.outbound?.sendText;
    if (!sendText) {
      throw new Error(
        `OpenClaw plugin for ${binding.channelType} does not expose outbound.sendText`,
      );
    }

    const result = await sendText({
      cfg: config,
      to: target,
      text: replyText,
      accountId: binding.accountId,
    });

    return isRecord(result) ? result : undefined;
  }

  private async persistInput(
    binding: ChannelBinding,
    sessionKey: SessionKey,
    prompt: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.messageRepository.append({
      channelBindingId: binding.id,
      direction: "input",
      channelType: binding.channelType,
      accountId: binding.accountId,
      sessionKey,
      content: prompt,
      metadata: {
        channelType: binding.channelType,
        ...metadata,
      },
    });
  }

  private async persistOutput(
    binding: ChannelBinding,
    sessionKey: SessionKey,
    replyText: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.messageRepository.append({
      channelBindingId: binding.id,
      direction: "output",
      channelType: binding.channelType,
      accountId: binding.accountId,
      sessionKey,
      content: replyText,
      metadata: {
        channelType: binding.channelType,
        ...metadata,
      },
    });
  }
}

function parseScheduledJobPayload(
  value: ScheduledJobPayload,
): ScheduledJobPayload {
  if (!isRecord(value)) {
    throw new Error("Scheduled job payload must be an object.");
  }

  return {
    bindingId: readRequiredString(value, "bindingId"),
    sessionKey: readRequiredString(value, "sessionKey"),
    prompt: readRequiredString(value, "prompt"),
  };
}

function buildScheduledJobMetadata(
  context: ScheduledJobExecutionContext,
): Record<string, unknown> {
  return {
    source: "scheduled-job",
    proactive: true,
    job: {
      id: context.jobId,
      name: context.jobName,
      ...(context.queuedAt ? { queuedAt: context.queuedAt } : {}),
      triggeredAt: new Date().toISOString(),
    },
  };
}

function readRequiredString(
  value: Record<string, unknown>,
  key: keyof ScheduledJobPayload,
): string {
  const raw = value[key];
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`Scheduled job payload ${key} must be a non-empty string.`);
  }
  return raw.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
