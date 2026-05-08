import type {
  AgentClient,
  AgentFile,
  AgentResponseStreamEvent,
} from "@agent-relay/agent-transport";
import type { ChannelBindingSnapshot } from "@agent-relay/domain";
import { OpenClawPluginHost } from "@agent-relay/openclaw-compat";
import type { ChannelBindingStatusUpdate } from "@agent-relay/openclaw-compat";

import { channelTypeRegistry } from "../channel-type-registry.js";
import type { GatewayLogger } from "../../infra/logger.js";
import type {
  ConnectionCallbacks,
  GatewayMessageInboundEvent,
} from "./events.js";
import {
  ChannelReplyDelivery,
  type ReplyDeliveryResult,
} from "./reply-delivery.js";

type ChannelBinding = ChannelBindingSnapshot;

export interface ConnectionOptions {
  agentClient: AgentClient;
  binding: ChannelBinding;
  callbacks?: ConnectionCallbacks;
  logger?: GatewayLogger;
}

/**
 * Live plugin and agent connection for one owned channel binding.
 *
 * Session mapping policy lives in AgentClientFactory's transport wrapper. This
 * connection passes the owned binding and raw channel session key with each
 * request so that downstream session derivation and persistence decisions stay
 * in one place.
 */
export class Connection {
  readonly abortController = new AbortController();
  hasReportedConnected = false;
  promise: Promise<void> = Promise.resolve();
  suppressDisconnectStatus = false;
  private readonly replyDelivery = new ChannelReplyDelivery();

  constructor(private readonly options: ConnectionOptions) {}

  get binding(): ChannelBinding {
    return this.options.binding;
  }

  start(host: OpenClawPluginHost): void {
    this.options.logger?.info(
      this.bindingLogFields(),
      "starting channel binding connection",
    );

    this.options.callbacks?.onConnectionStatus?.({
      binding: this.binding,
      status: "connecting",
    });

    this.promise = Promise.resolve()
      .then(() =>
        host.startChannelBinding(this.binding, this.abortController.signal, {
          onStatus: (status) => this.maybeReportConnected(status),
        }),
      )
      .then(() => {
        if (this.suppressDisconnectStatus) {
          return;
        }

        this.options.callbacks?.onConnectionStatus?.({
          binding: this.binding,
          status: "disconnected",
        });
      })
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name === "AbortError") {
          if (this.suppressDisconnectStatus) {
            return;
          }

          this.options.callbacks?.onConnectionStatus?.({
            binding: this.binding,
            status: "disconnected",
          });
          return;
        }

        this.options.callbacks?.onConnectionStatus?.({
          binding: this.binding,
          status: "error",
          error: err,
        });
        this.options.logger?.error(
          { ...this.bindingLogFields(), err },
          "channel binding connection failed",
        );
      });
  }

  async stop(): Promise<void> {
    this.suppressDisconnectStatus = true;
    this.abortController.abort();
    await this.promise.catch(() => {});
  }

  matchesChannelAccount(
    channelType: string | undefined,
    accountId: string,
  ): boolean {
    const bindingChannelType = channelTypeRegistry.canonicalize(
      this.binding.channelType,
    );
    const incomingChannelType = channelTypeRegistry.canonicalize(
      channelType ?? "feishu",
    );

    return (
      this.binding.enabled &&
      bindingChannelType === incomingChannelType &&
      this.binding.accountId === accountId
    );
  }

  /** Handles a full inbound runtime message for this connection when it owns the binding. */
  async handleInbound(
    event: GatewayMessageInboundEvent,
  ): Promise<ReplyDeliveryResult | undefined> {
    if (!this.matchesChannelAccount(event.channelType, event.accountId)) {
      return undefined;
    }

    this.options.callbacks?.emitMessageInbound?.(event);

    const replyEvent = event.event;
    if (!replyEvent) {
      throw new Error("Inbound channel message is missing a reply event.");
    }

    if (!event.userMessage.trim() && !event.files?.length) {
      return this.replyDelivery.deliver(replyEvent, null);
    }

    return this.replyDelivery.deliverStream(
      replyEvent,
      this.handleMessageStream(event),
    );
  }

  /** Sends inbound channel text to the bound agent and emits outbound telemetry. */
  async handleMessage(
    event: GatewayMessageInboundEvent,
  ): Promise<{ text: string; files?: AgentFile[] } | null> {
    const { accountId, channelType, sessionKey, userMessage, files } = event;

    if (!userMessage.trim() && !files?.length) {
      return null;
    }

    let result: { text: string; files?: AgentFile[] } | null;
    try {
      result = await this.options.agentClient.send({
        message: userMessage,
        sessionKey,
        accountId,
        binding: this.binding,
        ...(files?.length ? { files } : {}),
      });
    } catch (error) {
      this.options.callbacks?.onAgentCallFailed?.({
        binding: this.binding,
        error,
      });
      result = { text: "(agent temporarily unavailable)" };
    }

    if (result) {
      this.options.callbacks?.emitMessageOutbound?.({
        accountId,
        channelType,
        sessionKey,
        replyText: result.text,
        metadata: {
          kind: "final",
          ...(result.files?.length ? { files: result.files } : {}),
        },
      });
    }

    return result;
  }

  /** Streams inbound channel text to the bound agent and emits final outbound telemetry. */
  async *handleMessageStream(
    event: GatewayMessageInboundEvent,
  ): AsyncIterable<AgentResponseStreamEvent> {
    const { accountId, channelType, sessionKey, userMessage, files } = event;
    let sawFinal = false;
    let lastText = "";

    try {
      for await (const chunk of this.options.agentClient.stream({
        message: userMessage,
        sessionKey,
        accountId,
        binding: this.binding,
        ...(files?.length ? { files } : {}),
      })) {
        if (chunk.text) {
          lastText = chunk.text;
        }
        if (chunk.kind === "final") {
          sawFinal = true;
          this.options.callbacks?.emitMessageOutbound?.({
            accountId,
            channelType,
            sessionKey,
            replyText: chunk.text,
            metadata: {
              kind: chunk.kind,
              ...(chunk.files?.length ? { files: chunk.files } : {}),
            },
          });
        }
        if (chunk.kind === "block") {
          this.options.callbacks?.emitMessageOutbound?.({
            accountId,
            channelType,
            sessionKey,
            replyText: chunk.text,
            metadata: {
              kind: chunk.kind,
              ...(chunk.files?.length ? { files: chunk.files } : {}),
            },
          });
        }
        yield chunk;
      }

      if (!sawFinal && lastText) {
        this.options.callbacks?.emitMessageOutbound?.({
          accountId,
          channelType,
          sessionKey,
          replyText: lastText,
          metadata: { kind: "final" },
        });
      }
    } catch (error) {
      this.options.callbacks?.onAgentCallFailed?.({
        binding: this.binding,
        error,
      });
      yield { kind: "final", text: "(agent temporarily unavailable)" };
      this.options.callbacks?.emitMessageOutbound?.({
        accountId,
        channelType,
        sessionKey,
        replyText: "(agent temporarily unavailable)",
        metadata: { kind: "final", error: true },
      });
    }
  }

  private maybeReportConnected(status: ChannelBindingStatusUpdate): void {
    if (this.hasReportedConnected) {
      return;
    }

    if (status.connected === false || status.running === false) {
      return;
    }

    if (
      status.connected !== true &&
      status.running !== true &&
      status.accountId !== this.binding.accountId
    ) {
      return;
    }

    this.hasReportedConnected = true;
    this.options.callbacks?.onConnectionStatus?.({
      binding: this.binding,
      status: "connected",
    });
  }

  private bindingLogFields(): Record<string, unknown> {
    return {
      bindingId: this.binding.id,
      channelType: this.binding.channelType,
      accountId: this.binding.accountId,
      agentId: this.binding.agentId,
    };
  }
}
