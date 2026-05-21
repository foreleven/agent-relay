import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import * as channelRuntimeSdk from "openclaw/plugin-sdk/channel-runtime";
import * as commandDetection from "openclaw/plugin-sdk/command-detection";
import * as markdownTableRuntime from "openclaw/plugin-sdk/markdown-table-runtime";
import * as replyDispatchRuntime from "openclaw/plugin-sdk/reply-dispatch-runtime";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import * as routingSdk from "openclaw/plugin-sdk/routing";
import * as textRuntimeSdk from "openclaw/plugin-sdk/text-runtime";

import type { PluginRuntime } from "openclaw/plugin-sdk";

import type { ChannelReplyEvent } from "../plugin-runtime.js";
import type { BuildChannelInboundEventContextParams, BuiltChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";

type PluginRuntimeChannel = PluginRuntime["channel"];

const DEFAULT_CHANNEL_EVENT_CLASS = {
  kind: "message",
  canStartAgentTurn: true,
};

const EMPTY_CHANNEL_TURN_DISPATCH_COUNTS = { tool: 0, block: 0, final: 0 };

function isChannelTurnAdmission(value: unknown): value is { kind: string } {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return (
    kind === "dispatch" ||
    kind === "observeOnly" ||
    kind === "handled" ||
    kind === "drop"
  );
}

function normalizeChannelTurnPreflight(
  value: unknown,
): Record<string, unknown> {
  if (!value) return {};
  if (isChannelTurnAdmission(value)) return { admission: value };
  return value as Record<string, unknown>;
}

function isPreparedChannelTurn(value: unknown): value is {
  runDispatch: () => Promise<unknown>;
} {
  return Boolean(value && typeof value === "object" && "runDispatch" in value);
}

async function runPreparedChannelTurn(params: any): Promise<any> {
  const admission = params.admission ?? { kind: "dispatch" };
  try {
    await params.recordInboundSession({
      storePath: params.storePath,
      sessionKey: params.ctxPayload.SessionKey ?? params.routeSessionKey,
      ctx: params.ctxPayload,
      groupResolution: params.record?.groupResolution,
      createIfMissing: params.record?.createIfMissing,
      updateLastRoute: params.record?.updateLastRoute,
      onRecordError: params.record?.onRecordError ?? (() => {}),
      trackSessionMetaTask: params.record?.trackSessionMetaTask,
    });
  } catch (err) {
    try {
      await params.onPreDispatchFailure?.(err);
    } catch {
      // Preserve the original record failure.
    }
    throw err;
  }

  const dispatchResult =
    admission.kind === "observeOnly"
      ? (params.observeOnlyDispatchResult ?? {
          queuedFinal: false,
          counts: EMPTY_CHANNEL_TURN_DISPATCH_COUNTS,
        })
      : await params.runDispatch();

  return {
    admission,
    dispatched: true,
    ctxPayload: params.ctxPayload,
    routeSessionKey: params.routeSessionKey,
    dispatchResult,
  };
}

async function dispatchAssembledChannelTurn(params: any): Promise<any> {
  return runPreparedChannelTurn({
    channel: params.channel,
    accountId: params.accountId,
    routeSessionKey: params.routeSessionKey,
    storePath: params.storePath,
    ctxPayload: params.ctxPayload,
    recordInboundSession: params.recordInboundSession,
    record: params.record,
    history: params.history,
    admission: params.admission,
    log: params.log,
    messageId: params.messageId,
    runDispatch: async () =>
      params.dispatchReplyWithBufferedBlockDispatcher({
        ctx: params.ctxPayload,
        cfg: params.cfg,
        dispatcherOptions: {
          ...params.dispatcherOptions,
          deliver: async (payload: unknown, info: unknown) => {
            await params.delivery.deliver(payload, info);
          },
          onError: params.delivery.onError,
        },
        replyOptions: params.replyOptions,
        replyResolver: params.replyResolver,
      }),
  });
}

async function runChannelTurn(params: any): Promise<any> {
  const input = await params.adapter.ingest(params.raw);
  if (!input) {
    return {
      admission: { kind: "drop", reason: "ingest-null" },
      dispatched: false,
    };
  }

  const eventClass =
    (await params.adapter.classify?.(input)) ?? DEFAULT_CHANNEL_EVENT_CLASS;
  if (!eventClass.canStartAgentTurn) {
    return {
      admission: { kind: "handled", reason: `event:${eventClass.kind}` },
      dispatched: false,
    };
  }

  const preflight = normalizeChannelTurnPreflight(
    await params.adapter.preflight?.(input, eventClass),
  );
  const preflightAdmission = preflight.admission as
    | { kind: string; reason?: string }
    | undefined;
  if (
    preflightAdmission &&
    preflightAdmission.kind !== "dispatch" &&
    preflightAdmission.kind !== "observeOnly"
  ) {
    return { admission: preflightAdmission, dispatched: false };
  }

  const resolved = await params.adapter.resolveTurn(
    input,
    eventClass,
    preflight,
  );
  const admission = resolved.admission ??
    preflightAdmission ?? { kind: "dispatch" };

  let result;
  try {
    result = {
      ...(isPreparedChannelTurn(resolved)
        ? await runPreparedChannelTurn({ ...resolved, admission })
        : await dispatchAssembledChannelTurn({
            ...resolved,
            admission,
            delivery:
              admission.kind === "observeOnly"
                ? { deliver: async () => ({ visibleReplySent: false }) }
                : resolved.delivery,
          })),
      admission,
    };
  } catch (err) {
    try {
      await params.adapter.onFinalize?.({
        admission,
        dispatched: false,
        ctxPayload: resolved.ctxPayload,
        routeSessionKey: resolved.routeSessionKey,
      });
    } catch {
      // Preserve the dispatch failure.
    }
    throw err;
  }

  await params.adapter.onFinalize?.(result);
  return result;
}

async function runResolvedChannelTurn(params: any): Promise<any> {
  return runChannelTurn({
    channel: params.channel,
    accountId: params.accountId,
    raw: params.raw,
    log: params.log,
    adapter: {
      ingest: (raw: unknown) =>
        typeof params.input === "function" ? params.input(raw) : params.input,
      resolveTurn: params.resolveTurn,
    },
  });
}

function buildChannelTurnContext(params: BuildChannelInboundEventContextParams): BuiltChannelInboundEventContext {
  return replyDispatchRuntime.finalizeInboundContext({
    InboundEventKind: params.message.inboundEventKind?? "user_request",
    Body: params.message?.body ?? params.message?.rawBody,
    BodyForAgent: params.message?.bodyForAgent ?? params.message?.rawBody,
    RawBody: params.message?.rawBody,
    CommandBody: params.message?.commandBody ?? params.message?.rawBody,
    BodyForCommands: params.message?.commandBody ?? params.message?.rawBody,
    From: params.from,
    To: params.reply?.to,
    SessionKey:
      params.route?.dispatchSessionKey ?? params.route?.routeSessionKey,
    AccountId: params.route?.accountId ?? params.accountId,
    MessageSid: params.messageId,
    ChatType: params.conversation?.kind,
    Provider: params.provider ?? params.channel,
    Surface: params.surface ?? params.provider ?? params.channel,
    OriginatingChannel: params.channel,
    OriginatingTo: params.reply?.originatingTo,
    ...params.extra,
  });
}

/**
 * Build the `channel` surface of a `PluginRuntime`.
 *
 * Real text/chunk/routing/mention helpers are wired to the actual openclaw
 * SDK implementations. The reply dispatch methods are intercepted and turned
 * into explicit channel reply events handled by the injected runtime owner.
 */
export function buildChannelCompat(
  handleChannelReplyEvent: (
    event: ChannelReplyEvent,
  ) => Promise<
    Awaited<
      ReturnType<PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]>
    >
  >,
): PluginRuntimeChannel {
  return {
    text: {
      chunkByNewline: (text: string, limit?: number) => {
        if (!limit) return text.split("\n");
        const chunks: string[] = [];
        let current = "";
        for (const line of text.split("\n")) {
          if (current.length + line.length + 1 > limit && current) {
            chunks.push(current);
            current = line;
          } else {
            current = current ? `${current}\n${line}` : line;
          }
        }
        if (current) chunks.push(current);
        return chunks;
      },
      chunkText: replyRuntime.chunkText,
      chunkTextWithMode: replyRuntime.chunkTextWithMode,
      chunkMarkdownText:
        replyRuntime.chunkMarkdownText ??
        replyRuntime.chunkMarkdownTextWithMode,
      chunkMarkdownTextWithMode: replyRuntime.chunkMarkdownTextWithMode,
      resolveChunkMode: replyRuntime.resolveChunkMode,
      resolveTextChunkLimit: replyRuntime.resolveTextChunkLimit,
      hasControlCommand: commandDetection.hasControlCommand,
      resolveMarkdownTableMode: markdownTableRuntime.resolveMarkdownTableMode,
      convertMarkdownTables: textRuntimeSdk.convertMarkdownTables,
    },

    reply: {
      dispatchReplyFromConfig: async (
        params: Parameters<
          PluginRuntimeChannel["reply"]["dispatchReplyFromConfig"]
        >[0],
      ) => {
        return handleChannelReplyEvent({
          type: "channel.reply.dispatch",
          ctx: params.ctx,
          cfg: params.cfg,
          dispatcher: params.dispatcher,
          replyOptions: params.replyOptions,
        });
      },

      dispatchReplyWithBufferedBlockDispatcher: async (
        params: Parameters<
          PluginRuntimeChannel["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
        >[0],
      ) => {
        return handleChannelReplyEvent({
          type: "channel.reply.buffered.dispatch",
          ctx: params.ctx,
          dispatcherOptions: params.dispatcherOptions,
          replyOptions: params.replyOptions,
        });
      },

      createReplyDispatcherWithTyping:
        replyRuntime.createReplyDispatcherWithTyping,
      finalizeInboundContext: replyDispatchRuntime.finalizeInboundContext,
      formatAgentEnvelope: (
        params: Parameters<
          PluginRuntimeChannel["reply"]["formatAgentEnvelope"]
        >[0],
      ) => {
        return channelInbound.formatInboundEnvelope({
          channel: params.channel,
          from: params.from ?? "",
          body: params.body,
          timestamp: params.timestamp,
          envelope: params.envelope,
        });
      },
      formatInboundEnvelope: channelInbound.formatInboundEnvelope,
      resolveEnvelopeFormatOptions: channelInbound.resolveEnvelopeFormatOptions,
      resolveEffectiveMessagesConfig: (
        ...params: Parameters<
          PluginRuntimeChannel["reply"]["resolveEffectiveMessagesConfig"]
        >
      ) => {
        const [cfg, agentId, opts] = params;
        return {
          messagePrefix: "occ",
          responsePrefix: "occ",
        };
      },
      resolveHumanDelayConfig: () => undefined,
      settleReplyDispatcher: async (
        params: Parameters<
          PluginRuntimeChannel["reply"]["settleReplyDispatcher"]
        >[0],
      ) => {
        params.dispatcher.markComplete();
        try {
          await params.dispatcher.waitForIdle();
        } finally {
          await params.onSettled?.();
        }
      },
      withReplyDispatcher: async <T>(
        params: Parameters<
          PluginRuntimeChannel["reply"]["withReplyDispatcher"]
        >[0],
      ): Promise<T> => {
        try {
          return (await params.run()) as T;
        } finally {
          params.dispatcher.markComplete();
          try {
            await params.dispatcher.waitForIdle();
          } finally {
            await params.onSettled?.();
          }
        }
      },
    },

    routing: {
      buildAgentSessionKey: routingSdk.buildAgentSessionKey,
      resolveAgentRoute: routingSdk.resolveAgentRoute,
    },

    pairing: {
      buildPairingReply: (
        params: Parameters<
          PluginRuntimeChannel["pairing"]["buildPairingReply"]
        >[0],
      ) => {
        const { channel, idLine, code } = params;
        const approveCommand = `openclaw pairing approve ${channel} ${code}`;
        return [
          "OpenClaw: access not configured.",
          "",
          idLine,
          "Pairing code:",
          "```",
          code,
          "```",
          "",
          "Ask the bot owner to approve with:",
          `openclaw pairing approve ${channel} ${code}`,
          "```",
          approveCommand,
          "```",
        ].join("\n");
      },
      readAllowFromStore: async () => [],
      upsertPairingRequest: async (
        params: Parameters<
          PluginRuntimeChannel["pairing"]["upsertPairingRequest"]
        >[0],
      ) => {
        return {
          code: "",
          created: true,
        };
      },
    },
    media: {
      readRemoteMediaBuffer: async () => {
        throw new Error("channel.media.readRemoteMediaBuffer not supported");
      },
      fetchRemoteMedia: async (
        params: Parameters<
          PluginRuntimeChannel["media"]["fetchRemoteMedia"]
        >[0],
      ) => {
        return {
          buffer: Buffer.from(""),
        };
      },
      saveMediaBuffer: async (
        ...params: Parameters<PluginRuntimeChannel["media"]["saveMediaBuffer"]>
      ) => {
        const [buffer, contentType, subdir, maxBytes, originalFilename] =
          params;
        return {
          id: "",
          path: "",
          size: 0,
          contentType: contentType,
        };
      },
      saveRemoteMedia: async () => {
        throw new Error("channel.media.saveRemoteMedia not supported");
      },
      saveResponseMedia: async () => {
        throw new Error("channel.media.saveResponseMedia not supported");
      },
    },
    activity: {
      record: channelRuntimeSdk.recordChannelActivity ?? (() => {}),
      get: (params: Parameters<PluginRuntimeChannel["activity"]["get"]>[0]) => {
        return {
          inboundAt: 0,
          outboundAt: 0,
        };
      },
    },
    session: {
      resolveStorePath: () => "/tmp/a2a-sessions",
      readSessionUpdatedAt: (
        params: Parameters<
          PluginRuntimeChannel["session"]["readSessionUpdatedAt"]
        >[0],
      ) => 0,
      recordSessionMetaFromInbound: async () => {
        return null;
      },
      recordInboundSession: async () => {},
      updateLastRoute: async () => {
        throw new Error("Not implemented");
      },
    },
    mentions: {
      buildMentionRegexes: channelInbound.buildMentionRegexes,
      matchesMentionPatterns: channelInbound.matchesMentionPatterns,
      matchesMentionWithExplicit: channelInbound.matchesMentionWithExplicit,
      implicitMentionKindWhen: channelInbound.implicitMentionKindWhen,
      resolveInboundMentionDecision:
        channelInbound.resolveInboundMentionDecision,
    },
    reactions: {
      createAckReactionHandle: () => null,
      shouldAckReaction: () => false,
      removeAckReactionAfterReply: () => {},
      removeAckReactionHandleAfterReply: () => {},
    },
    groups: {
      resolveGroupPolicy: () => ({ allowed: true, allowlistEnabled: true }),
      resolveRequireMention: () => false,
    },
    debounce: {
      createInboundDebouncer: replyRuntime.createInboundDebouncer,
      resolveInboundDebounceMs: replyRuntime.resolveInboundDebounceMs,
    },
    commands: {
      resolveCommandAuthorizedFromAuthorizers: () => true,
      isControlCommandMessage: commandDetection.isControlCommandMessage,
      shouldComputeCommandAuthorized:
        commandDetection.shouldComputeCommandAuthorized,
      shouldHandleTextCommands: () => true,
    },
    outbound: { loadAdapter: async () => undefined },
    turn: {
      run: runChannelTurn,
      runAssembled: dispatchAssembledChannelTurn,
      runResolved: runResolvedChannelTurn,
      buildContext: buildChannelTurnContext,
      runPrepared: runPreparedChannelTurn,
      dispatchAssembled: dispatchAssembledChannelTurn,
    },
    threadBindings: {
      setIdleTimeoutBySessionKey: () => [],
      setMaxAgeBySessionKey: () => [],
    },
    runtimeContexts: {
      register: (_p: unknown) => ({ dispose: () => {} }),
      get: () => undefined,
      watch: () => () => {},
    },
  } as PluginRuntimeChannel;
}
