/**
 * OpenClaw-compatible runtime surface for community channel plugins.
 *
 * Only the subset used by OpenClaw channel plugins is implemented.
 * Channel reply events are constructed here and delegated to the gateway
 * runtime connection boundary.
 */

import type {
  LlmCompleteParams,
  OpenClawConfig,
  PluginRuntime,
} from "openclaw/plugin-sdk";

import type { AgentFile } from "@agent-relay/agent-transport";

import { buildAgentCompat } from "./compatibilities/agent.js";
import { buildChannelCompat } from "./compatibilities/channel.js";
import {
  buildImageGenerationCompat,
  buildVideoGenerationCompat,
} from "./compatibilities/generation.js";
import {
  buildMediaCompat,
  buildMediaUnderstandingCompat,
  buildTtsCompat,
} from "./compatibilities/media.js";
import { buildStateCompat } from "./compatibilities/state.js";
import { buildSystemCompat } from "./compatibilities/system.js";
import { buildTasksCompat } from "./compatibilities/tasks.js";

export type ConfigProvider = PluginRuntime["config"];

type ChannelReplyDispatchParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]
>[0];
type ChannelReplyBufferedDispatchParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
export type ChannelReplyDispatchResult = Awaited<
  ReturnType<PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]>
>;

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface PluginRuntimeOptions {
  config: ConfigProvider;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface MessageInboundEvent {
  channelType: string | undefined;
  accountId: string;
  sessionKey: string;
  userMessage: string;
  event: ChannelReplyEvent;
  replyToId?: string;
  /** Optional file attachments from the user message. */
  files?: AgentFile[];
}

export interface MessageOutboundEvent {
  channelType: string | undefined;
  accountId: string;
  sessionKey: string;
  replyText: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelReplyDispatchEvent {
  type: "channel.reply.dispatch";
  ctx: ChannelReplyDispatchParams["ctx"];
  cfg: ChannelReplyDispatchParams["cfg"];
  dispatcher: ChannelReplyDispatchParams["dispatcher"];
  replyOptions?: ChannelReplyDispatchParams["replyOptions"];
}

export interface ChannelReplyBufferedDispatchEvent {
  type: "channel.reply.buffered.dispatch";
  ctx: ChannelReplyBufferedDispatchParams["ctx"];
  dispatcherOptions: ChannelReplyBufferedDispatchParams["dispatcherOptions"];
  replyOptions?: ChannelReplyBufferedDispatchParams["replyOptions"];
}

export type ChannelReplyEvent =
  | ChannelReplyDispatchEvent
  | ChannelReplyBufferedDispatchEvent;

export interface ReplyEventDispatcher {
  dispatchReplyEvent(
    event: ChannelReplyEvent,
  ): Promise<ChannelReplyDispatchResult>;
}

const OPENCLAW_PLUGIN_API_VERSION = "2026.5.19";

// ---------------------------------------------------------------------------
// OpenClawPluginRuntime class
// ---------------------------------------------------------------------------

/** Class-based OpenClaw plugin runtime that delegates channel reply events. */
export class OpenClawPluginRuntime {
  private replyEventDispatcher: ReplyEventDispatcher | null = null;
  private readonly stateCompat = buildStateCompat();

  constructor(private readonly options: PluginRuntimeOptions) {}

  setReplyEventDispatcher(dispatcher: ReplyEventDispatcher): void {
    this.replyEventDispatcher = dispatcher;
  }

  async handleChannelReplyEvent(
    event: ChannelReplyEvent,
  ): Promise<ChannelReplyDispatchResult> {
    if (this.replyEventDispatcher) {
      return this.replyEventDispatcher.dispatchReplyEvent(event);
    }

    return this.completeUnhandledReplyEvent(event);
  }

  asPluginRuntime(): PluginRuntime {
    return this._buildPluginRuntime();
  }

  getConfig(): OpenClawConfig {
    return this.options.config.loadConfig();
  }

  private _buildPluginRuntime(): PluginRuntime {
    return {
      version: OPENCLAW_PLUGIN_API_VERSION,
      config: this.options.config,
      agent: buildAgentCompat(),
      system: buildSystemCompat(),
      media: buildMediaCompat(),
      tts: buildTtsCompat(),
      mediaUnderstanding: buildMediaUnderstandingCompat(),
      imageGeneration: buildImageGenerationCompat(),
      videoGeneration: buildVideoGenerationCompat(),
      musicGeneration: {
        generate: async () =>
          ({
            tracks: [],
            provider: "",
            model: "",
            attempts: [],
            ignoredOverrides: [],
          }) as Awaited<
            ReturnType<PluginRuntime["musicGeneration"]["generate"]>
          >,
        listProviders: () => [],
      },
      webSearch: {
        listProviders: () => [],
        search: async () => ({ provider: "", result: {} }),
      },
      stt: {
        transcribeAudioFile: async () => ({ text: undefined }),
      },
      events: {
        onAgentEvent: () => () => {},
        onSessionTranscriptUpdate: () => () => {},
      },
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
        }),
      },
      state: this.stateCompat,
      modelAuth: {
        getApiKeyForModel: async () => ({
          source: "stub",
          mode: "api-key" as const,
        }),
        getRuntimeAuthForModel: async () => ({
          source: "stub",
          mode: "api-key" as const,
        }),
        resolveApiKeyForProvider: async () => ({
          source: "stub",
          mode: "api-key" as const,
        }),
      },
      tasks: buildTasksCompat(),
      taskFlow: buildTasksCompat().flow,
      subagent: {
        run: async () => ({ runId: "" }),
        waitForRun: async () => ({ status: "ok" as const }),
        getSessionMessages: async () => ({ messages: [] }),
        getSession: async () => ({ messages: [] }),
        deleteSession: async () => {},
      },
      nodes: {
        list: async () => ({ nodes: [] }),
        invoke: async () => undefined,
      },
      channel: buildChannelCompat((event) =>
        this.handleChannelReplyEvent(event),
      ),
      llm: {
        complete: async (params: LlmCompleteParams) => {
          return {
            text: "",
            provider: "stub",
            model: params.model ?? "stub",
            agentId: params.agentId ?? "unknown",
            usage: {},
            audit: {
              caller: { kind: "unknown" as const },
              ...(params.purpose ? { purpose: params.purpose } : {}),
            },
          };
        },
      },
    } as PluginRuntime;
  }

  private async completeUnhandledReplyEvent(
    event: ChannelReplyEvent,
  ): Promise<ChannelReplyDispatchResult> {
    if (event.type === "channel.reply.dispatch") {
      event.dispatcher.markComplete();
      try {
        await event.dispatcher.waitForIdle();
      } catch {
        // Ignore draining errors when no connection handled the message.
      }
    }

    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  }
}
