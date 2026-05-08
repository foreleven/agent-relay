import {
  sessionIdStrategyFromBinding,
  type ChannelBindingSnapshot,
  type SessionKey,
} from "@agent-relay/domain";

/** A file attachment sent to or received from an agent. */
export interface AgentFile {
  /** Remote URL for the file content. Preferred over inline data when available. */
  url?: string;
  /** Base64-encoded file content. Used when a URL is not available. */
  data?: string;
  /** MIME type of the file (e.g. "image/jpeg", "application/pdf"). */
  mimeType?: string;
  /** Optional display name for the file. */
  name?: string;
}

export interface AgentRequest {
  message: string;
  sessionKey: SessionKey;
  accountId: string;
  /** Channel binding context for gateway-owned session mapping policy. */
  binding: ChannelBindingSnapshot;
  /** Optional file attachments from the user message (e.g. images, documents). */
  files?: AgentFile[];
}

export interface AgentCallContext {
  /** Previously stored protocol-native session identifier, if any. */
  protocolSessionId?: string;
}

export interface AgentResponse {
  text: string;
  /**
   * Protocol-native session identifier returned by the transport. Callers own
   * the decision to persist it for later requests.
   */
  protocolSessionId?: string;
  /** Optional file attachments in the agent's reply. */
  files?: AgentFile[];
}

export namespace AgentRequestSession {
  export function sessionId(request: AgentRequest): string | undefined {
    return request.sessionKey.toSessionId(
      sessionIdStrategyFromBinding({
        strategy: request.binding.sessionIsolationStrategy,
        bindingId: request.binding.id,
        accountId: request.accountId,
      }),
    );
  }
}

export type AgentResponseStreamEventKind = "partial" | "block" | "final";

export interface AgentResponseStreamEvent {
  kind: AgentResponseStreamEventKind;
  text: string;
  /**
   * Protocol-native session identifier returned by the transport. Callers own
   * the decision to persist it for later requests.
   */
  protocolSessionId?: string;
  /** Optional file attachments in this stream event. Only populated for block/final events. */
  files?: AgentFile[];
}

export type AgentProtocol = "a2a" | "acp";

export interface A2AAgentConfig {
  readonly url: string;
  readonly contextIdStrategy?: A2AContextIdStrategy;
}

export type A2AContextIdStrategy = "client-provided" | "server-assigned";

export interface ACPStdioAgentConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly permission?:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always";
  readonly timeoutMs?: number;
}

export type ACPAgentConfig = ACPStdioAgentConfig;
export type AgentProtocolConfig = A2AAgentConfig | ACPAgentConfig;

export interface AgentClientOptions {
  protocol: AgentProtocol;
  transport: AgentTransport;
}

export class AgentClient {
  readonly protocol: AgentProtocol;

  constructor(private readonly options: AgentClientOptions) {
    this.protocol = options.protocol;
  }

  send(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): Promise<AgentResponse> {
    return this.options.transport.send(request, ctx);
  }

  stream(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): AsyncIterable<AgentResponseStreamEvent> {
    if (this.options.transport.stream) {
      return this.options.transport.stream(request, ctx);
    }

    return this.streamFinalResponse(request);
  }

  async start(): Promise<void> {
    await this.options.transport.start?.();
  }

  async stop(): Promise<void> {
    await this.options.transport.stop?.();
  }

  private async *streamFinalResponse(
    request: AgentRequest,
  ): AsyncIterable<AgentResponseStreamEvent> {
    const response = await this.send(request);
    yield {
      kind: "final",
      text: response.text,
      ...(response.protocolSessionId
        ? { protocolSessionId: response.protocolSessionId }
        : {}),
      ...(response.files?.length ? { files: response.files } : {}),
    };
  }
}

export interface AgentTransport {
  readonly protocol: AgentProtocol;
  send(request: AgentRequest, ctx: AgentCallContext): Promise<AgentResponse>;
  stream?(
    request: AgentRequest,
    ctx: AgentCallContext,
  ): AsyncIterable<AgentResponseStreamEvent>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

/** DI multi-binding token for registered agent transport implementations. */
export const AgentTransportFactory = Symbol.for(
  "@agent-relay/gateway/AgentTransportFactory",
);

export interface AgentTransportFactory {
  readonly protocol: AgentProtocol;
  create(
    config: AgentProtocolConfig,
    context?: AgentTransportContext,
  ): AgentTransport;
}

export interface AgentTransportContext {
  readonly agentName?: string;
}

/** Protocol-keyed registry for resolving agent transport implementations. */
export class TransportRegistry {
  private readonly factories = new Map<AgentProtocol, AgentTransportFactory>();

  register(factory: AgentTransportFactory): this {
    this.factories.set(factory.protocol, factory);
    return this;
  }

  resolve(protocol: AgentProtocol): AgentTransportFactory {
    const factory = this.factories.get(protocol) ?? this.factories.get("a2a");
    if (!factory) {
      throw new Error(
        `No transport registered for protocol "${protocol}" and no "a2a" fallback available.`,
      );
    }

    return factory;
  }

  has(protocol: AgentProtocol): boolean {
    return this.factories.has(protocol);
  }
}
