/**
 * OpenClaw-compatible plugin host facade.
 *
 * Exposes only the registration surface that community channel plugins
 * (e.g. @openclaw/feishu) actually use, while the gateway stays in
 * full control of the account lifecycle.
 *
 * This class is intentionally channel-agnostic.  Channel-specific bootstrap
 * (plugin loading) lives in each channel's own registration module under
 * apps/gateway/src/register-plugins.ts.
 *
 * Typical gateway startup:
 *   const host = new OpenClawPluginHost(() => configProjection.getConfig());
 *   registerLarkPlugin(host);        // channel-specific
 *   host.setRuntime(buildRuntime()); // shared runtime injected once
 */

import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import type { ChannelBindingSnapshot } from "@agent-relay/domain";
import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawPluginRuntime } from "./plugin-runtime";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Runtime environment passed to a channel plugin when starting an account.
 * Mirrors the env object a real OpenClaw host normally provides.
 *
 * This is intentionally kept internal — external callers should use
 * {@link OpenClawPluginHost.startChannelAccount} which creates this
 * automatically for the given channel/account pair.
 */
interface GatewayRuntimeEnv {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
}

export interface OpenClawHostLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  debug(message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  info(message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  warn(message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  error(message: string): void;
  child(fields: Record<string, unknown>): OpenClawHostLogger;
}

export interface ChannelBindingStatusUpdate extends ChannelAccountSnapshot {
  running?: boolean;
  connected?: boolean;
}

export interface StartChannelBindingCallbacks {
  onStatus?: (status: ChannelBindingStatusUpdate) => void;
}

export interface ChannelQrLoginStartParams {
  accountId?: string;
  force?: boolean;
  verbose?: boolean;
}

export interface ChannelLoginRuntimeEnv {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  exit?: (code: number) => void;
}

export interface ChannelLoginParams {
  accountId?: string;
  verbose?: boolean;
  runtime?: ChannelLoginRuntimeEnv;
}

export interface ChannelQrLoginStartResult {
  qrDataUrl?: string;
  message: string;
  accountId?: string;
  sessionKey?: string;
}

export interface ChannelQrLoginWaitParams {
  accountId?: string;
  sessionKey?: string;
  timeoutMs?: number;
}

export interface ChannelQrLoginWaitResult {
  connected: boolean;
  message: string;
  accountId?: string;
  channelConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const defaultLogger: OpenClawHostLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => defaultLogger,
};

// ---------------------------------------------------------------------------
// OpenClawPluginHost
// ---------------------------------------------------------------------------

/** Hosts OpenClaw channel plugins and controls channel account lifecycles. */
export class OpenClawPluginHost {
  private readonly channels = new Map<string, ChannelPlugin>();
  private readonly channelAliases = new Map<string, string>();
  private readonly hookHandlers = new Map<
    string,
    Array<(...args: any[]) => unknown>
  >();

  private runtime: PluginRuntime;

  /**
   * @param getConfig  Callback that returns the current OpenClaw-compatible
   *   channel config.  Injected by the gateway so this package has no
   *   dependency on the store implementation.
   */
  constructor(
    readonly _runtime: OpenClawPluginRuntime,
    private readonly logger: OpenClawHostLogger = defaultLogger,
  ) {
    this.runtime = _runtime.asPluginRuntime();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns true if a channel plugin with the given id or alias has been
   * registered. Used by the gateway runtime before starting channel bindings.
   */
  hasChannel(channelType: string): boolean {
    return this.resolveChannel(channelType) !== undefined;
  }

  /** Returns the registered plugin for a channel id or alias, if available. */
  getChannelPlugin(channelType: string): ChannelPlugin | undefined {
    return this.resolveChannel(channelType);
  }

  /**
   * Register a community plugin.  The loader receives the host's plugin API
   * object and is expected to call the plugin's own register() function:
   *
   *   host.registerPlugin((api) => larkPlugin.register(api));
   */
  registerPlugin(loader: (api: OpenClawPluginApi) => void): void {
    loader(this.buildPluginApi());
  }

  /** Register a gateway-owned channel id alias that points at a plugin id. */
  registerChannelAlias(alias: string, targetChannelId: string): void {
    this.channelAliases.set(alias, targetChannelId);
  }

  hasChannelLogin(channelType: string): boolean {
    const channel = this.resolveChannel(channelType);
    return channel?.auth?.login !== undefined;
  }

  async runChannelLogin(
    channelType: string,
    params: ChannelLoginParams,
  ): Promise<void> {
    const channel = this.resolveChannel(channelType);
    const login = channel?.auth?.login;
    if (!login) {
      throw new Error(`Channel login is not supported for ${channelType}`);
    }

    const { accountId, verbose } = params;
    const runtime = this.buildChannelLoginRuntime(params.runtime);
    const config = this.runtime.config.current() as OpenClawConfig;
    await login({
      cfg: config,
      accountId,
      verbose,
      runtime,
    });
  }

  /**
   * Start the gateway account for a registered channel type.
   *
   * This is the entry point called by the connection manager when assignment
   * grants a channel binding to the local node. It:
   *   1. Resolves the registered channel plugin for `channelType`.
   *   2. Creates a scoped logging environment for the account.
   *   3. Delegates to the plugin's `gateway.startAccount()` hook.
   *
   * The returned Promise settles when the account connection ends
   * (normally or via the `abortSignal`).
   */
  async startChannelBinding(
    binding: ChannelBindingSnapshot,
    abortSignal: AbortSignal,
    callbacks: StartChannelBindingCallbacks = {},
  ): Promise<void> {
    const { id: bindingId, channelType, accountId } = binding;
    const channel = this.resolveChannel(channelType);
    if (!channel?.gateway?.startAccount) {
      throw new Error(
        `No registered channel gateway for "${channelType}". ` +
          `Did you forget to call the channel's register function before starting accounts?`,
      );
    }

    const bindingLogger = this.logger.child({
      component: "openclaw-host",
      channelType,
      accountId,
      bindingId,
    });

    const runtimeEnv: GatewayRuntimeEnv = {
      log: (...args: unknown[]) =>
        bindingLogger.info({ args }, "channel runtime log"),
      error: (...args: unknown[]) =>
        bindingLogger.error({ args }, "channel runtime error"),
      exit: (code: number) => process.exit(code),
    };

    const emitStatus = (status: ChannelBindingStatusUpdate): void => {
      callbacks.onStatus?.(status);
      bindingLogger.info({ status }, "channel account status updated");
    };
    const config = this.runtime.config.current() as OpenClawConfig;
    const startPromise = channel.gateway.startAccount({
      cfg: config,
      accountId,
      account: binding.channelConfig,
      runtime: runtimeEnv,
      channelRuntime: this.runtime.channel,
      abortSignal,
      getStatus: (): ChannelAccountSnapshot => {
        return { accountId };
      },
      setStatus: (status) => emitStatus(status),
      log: this.asChannelLogSink(bindingLogger),
    });

    await startPromise;
  }

  async startChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginStartParams = {},
  ): Promise<ChannelQrLoginStartResult> {
    const channel = this.resolveChannel(channelType);
    const start = channel?.gateway?.loginWithQrStart;
    if (!start) {
      throw new Error(`Channel QR login is not supported for ${channelType}`);
    }

    return await start.bind(channel.gateway)(params);
  }

  async waitForChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    const channel = this.resolveChannel(channelType);
    const wait = channel?.gateway?.loginWithQrWait;
    if (!wait) {
      throw new Error(`Channel QR login is not supported for ${channelType}`);
    }

    return await wait.bind(channel.gateway)(params);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveChannel(channelType: string): ChannelPlugin | undefined {
    const exact = this.channels.get(channelType);
    if (exact) return exact;
    const aliasTarget = this.channelAliases.get(channelType);
    if (aliasTarget) {
      const aliased = this.channels.get(aliasTarget);
      if (aliased) return aliased;
    }
    for (const channel of this.channels.values()) {
      if (channel.meta?.aliases?.includes(channelType)) return channel;
    }
    return undefined;
  }

  private buildChannelLoginRuntime(
    runtime?: ChannelLoginRuntimeEnv,
  ): GatewayRuntimeEnv {
    return {
      log: runtime?.log ?? (() => {}),
      error: runtime?.error ?? (() => {}),
      exit: runtime?.exit ?? (() => {}),
    };
  }

  /**
   * Build the plugin API object passed to community plugins on registration.
   *
   * Only the surface that OpenClaw channel plugins actually call is
   * implemented.  Everything else is a deliberate no-op stub — stubs exist
   * to satisfy the plugin's registration phase without throwing.
   */
  private buildPluginApi(): OpenClawPluginApi {
    const host = this;
    const logger = this.asChannelLogSink(this.logger.child({ component: "openclaw-host" }));
    const config = host.runtime.config.current() as OpenClawConfig;

    const on: OpenClawPluginApi["on"] = (event, handler) => {
      const existing = host.hookHandlers.get(event) ?? [];
      existing.push(handler);
      host.hookHandlers.set(event, existing);
    };
    const registerSessionExtension: OpenClawPluginApi["registerSessionExtension"] =
      () => {};
    const enqueueNextTurnInjection: OpenClawPluginApi["enqueueNextTurnInjection"] =
      async (injection) => ({
        enqueued: false,
        id: "",
        sessionKey: injection.sessionKey,
      });
    const registerSessionSchedulerJob: OpenClawPluginApi["registerSessionSchedulerJob"] =
      () => undefined;
    const sendSessionAttachment: OpenClawPluginApi["sendSessionAttachment"] =
      async () => ({
        ok: false,
        error: "session attachments are not supported",
      });
    const scheduleSessionTurn: OpenClawPluginApi["scheduleSessionTurn"] =
      async () => undefined;
    const unscheduleSessionTurnsByTag: OpenClawPluginApi["unscheduleSessionTurnsByTag"] =
      async () => ({ removed: 0, failed: 0 });
    const registerSessionAction: OpenClawPluginApi["registerSessionAction"] =
      () => {};
    const registerControlUiDescriptor: OpenClawPluginApi["registerControlUiDescriptor"] =
      () => {};
    const registerAgentEventSubscription: OpenClawPluginApi["registerAgentEventSubscription"] =
      () => {};
    const emitAgentEvent: OpenClawPluginApi["emitAgentEvent"] = () => ({
      emitted: false,
      reason: "agent event emission is not supported",
    });
    const setRunContext: OpenClawPluginApi["setRunContext"] = () => false;
    const getRunContext: OpenClawPluginApi["getRunContext"] = () => undefined;
    const clearRunContext: OpenClawPluginApi["clearRunContext"] = () => {};
    const registerRuntimeLifecycle: OpenClawPluginApi["registerRuntimeLifecycle"] =
      () => {};

    const api: OpenClawPluginApi = {
      // ---- Identity -------------------------------------------------------
      id: "agent-relay-gateway",
      name: "Agent Relay Gateway",
      version: "0.1.0",
      description: "A2A-backed OpenClaw channel plugin host",
      source: "local",
      registrationMode: "setup-runtime",

      // ---- Live getters ---------------------------------------------------
      get config() {
        return config;
      },
      get runtime() {
        return host.runtime;
      },
      pluginConfig: {},
      session: {
        state: { registerSessionExtension },
        workflow: {
          enqueueNextTurnInjection,
          registerSessionSchedulerJob,
          sendSessionAttachment,
          scheduleSessionTurn,
          unscheduleSessionTurnsByTag,
        },
        controls: {
          registerSessionAction,
          registerControlUiDescriptor,
        },
      },
      agent: {
        events: {
          registerAgentEventSubscription,
          emitAgentEvent,
        },
      },
      runContext: {
        setRunContext,
        getRunContext,
        clearRunContext,
      },
      lifecycle: {
        registerRuntimeLifecycle,
      },

      logger,

      // ---- Implemented registration hooks ---------------------------------

      /** Called by channel plugins to register their gateway controller. */
      registerChannel: (
        registration: Parameters<OpenClawPluginApi["registerChannel"]>[0],
      ) => {
        const channel =
          typeof registration === "object" &&
          registration !== null &&
          "plugin" in registration
            ? registration.plugin
            : registration;

        if (!channel?.id) {
          throw new Error(
            "registerChannel: plugin object must have a non-empty id",
          );
        }
        host.channels.set(channel.id, channel);
        host.logger.info(
          { channelId: channel.id, aliases: channel.meta.aliases },
          "channel registered",
        );
      },

      /** Subscribe to host lifecycle events. */
      on: on,

      resolvePath: (input: string) => input,

      // ---- No-op stubs for unused registration surface --------------------
      // Allow plugin register() calls to complete without throwing when
      // the gateway doesn't implement the corresponding capability.
      registerTool: () => {},
      registerHook: () => {},
      registerHttpRoute: () => {},
      registerHostedMediaResolver: () => {},
      registerGatewayMethod: () => {},
      registerCli: () => {},
      registerNodeCliFeature: () => {},
      registerReload: () => {},
      registerNodeHostCommand: () => {},
      registerNodeInvokePolicy: () => {},
      registerSecurityAuditCollector: () => {},
      registerService: () => {},
      registerGatewayDiscoveryService: () => {},
      registerCliBackend: () => {},
      registerTextTransforms: () => {},
      registerConfigMigration: () => {},
      registerMigrationProvider: () => {},
      registerAutoEnableProbe: () => {},
      registerProvider: () => {},
      registerModelCatalogProvider: () => {},
      registerSpeechProvider: () => {},
      registerRealtimeTranscriptionProvider: () => {},
      registerRealtimeVoiceProvider: () => {},
      registerMediaUnderstandingProvider: () => {},
      registerImageGenerationProvider: () => {},
      registerVideoGenerationProvider: () => {},
      registerMusicGenerationProvider: () => {},
      registerWebFetchProvider: () => {},
      registerWebSearchProvider: () => {},
      registerInteractiveHandler: () => {},
      onConversationBindingResolved: () => {},
      registerCommand: () => {},
      registerContextEngine: () => {},
      registerCompactionProvider: () => {},
      registerAgentHarness: () => {},
      registerCodexAppServerExtensionFactory: () => {},
      registerAgentToolResultMiddleware: () => {},
      registerSessionExtension,
      enqueueNextTurnInjection,
      registerTrustedToolPolicy: () => {},
      registerToolMetadata: () => {},
      registerControlUiDescriptor,
      registerRuntimeLifecycle,
      registerAgentEventSubscription,
      emitAgentEvent,
      setRunContext,
      getRunContext,
      clearRunContext,
      registerSessionSchedulerJob,
      registerSessionAction,
      sendSessionAttachment,
      scheduleSessionTurn,
      unscheduleSessionTurnsByTag,
      registerDetachedTaskRuntime: () => {},
      registerMemoryCapability: () => {},
      registerMemoryPromptSection: () => {},
      registerMemoryPromptSupplement: () => {},
      registerMemoryCorpusSupplement: () => {},
      registerMemoryFlushPlan: () => {},
      registerMemoryRuntime: () => {},
      registerMemoryEmbeddingProvider: () => {},
    };

    return api;
  }

  private asChannelLogSink(logger: OpenClawHostLogger): ChannelLogSink {
    return {
      debug: (message) => logger.debug({ channelLog: true }, message),
      info: (message) => logger.info({ channelLog: true }, message),
      warn: (message) => logger.warn({ channelLog: true }, message),
      error: (message) => logger.error({ channelLog: true }, message),
    };
  }
}
