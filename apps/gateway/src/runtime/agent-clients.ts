import { inject, injectable, multiInject, optional } from "inversify";
import {
  AgentClient,
  AgentRequestSession,
  AgentTransportFactory,
  TransportRegistry,
  type AgentCallContext,
  type AgentProtocol,
  type AgentRequest,
  type AgentResponse,
  type AgentResponseStreamEvent,
  type AgentTransport,
} from "@agent-relay/agent-transport";
import {
  SessionMappingRepository,
  sessionIdStrategyFromBinding,
  type AgentConfigSnapshot,
  type SessionMappingRepository as SessionMappingRepositoryPort,
  SessionKey,
} from "@agent-relay/domain";

/** Creates runtime agent client handles from registered transport implementations. */
@injectable()
export class AgentClientFactory {
  private readonly transportRegistry = new TransportRegistry();

  /** Registers all injected transport implementations by protocol. */
  constructor(
    @multiInject(AgentTransportFactory)
    transports: AgentTransportFactory[],
    @inject(SessionMappingRepository)
    @optional()
    private readonly sessionMappingStore?: SessionMappingRepositoryPort,
  ) {
    for (const transport of transports) {
      this.transportRegistry.register(transport);
    }
  }

  /** Creates an agent client for the configured agent transport. */
  create(agent: AgentConfigSnapshot): AgentClient {
    const factory = this.transportRegistry.resolve(agent.protocol);
    const baseTransport = factory.create(agent.config, {
      agentName: agent.name,
    });
    const transport = new SessionMappingTransport({
      inner: baseTransport,
      agentId: agent.id,
      protocol: agent.protocol,
      store: this.sessionMappingStore,
    });

    return new AgentClient({
      protocol: agent.protocol,
      transport,
    });
  }

  /** Starts a client when its transport exposes startup work. */
  async start(client: AgentClient): Promise<void> {
    await client.start();
  }

  /** Stops a client when its transport exposes cleanup work. */
  async stop(client: AgentClient): Promise<void> {
    await client.stop();
  }

  /** Stops a set of clients concurrently during registry cleanup. */
  async stopAll(clients: Iterable<AgentClient>): Promise<void> {
    await Promise.all(Array.from(clients, (client) => this.stop(client)));
  }
}

interface SessionMappingTransportOptions {
  inner: AgentTransport;
  agentId: string;
  protocol: AgentProtocol;
  store?: SessionMappingRepositoryPort;
}

/**
 * Gateway-owned protocol session mapping policy.
 *
 * This wrapper is the single place that interprets channel binding session
 * isolation. It derives the downstream agent session key, decides whether
 * protocol session ids may be persisted, and passes any stored protocol-native
 * id to the transport. Transports may return an updated protocol session id,
 * but they do not know how or where mappings are stored.
 */
class SessionMappingTransport implements AgentTransport {
  readonly protocol: AgentProtocol;
  readonly store?: SessionMappingRepositoryPort;

  constructor(private readonly options: SessionMappingTransportOptions) {
    this.protocol = options.inner.protocol;
    this.store = options.store;
  }

  async send(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): Promise<AgentResponse> {
    const sessionId = await this.getProtocolSessionId(request);
    const response = await this.options.inner.send(request, {
      ...ctx,
      protocolSessionId: sessionId,
    });
    await this.recordProtocolSession(request, response.protocolSessionId);
    return response;
  }

  async *stream(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): AsyncIterable<AgentResponseStreamEvent> {
    if (!this.options.inner.stream) {
      const response = await this.send(request, ctx);
      yield {
        kind: "final",
        text: response.text,
        ...(response.protocolSessionId
          ? { protocolSessionId: response.protocolSessionId }
          : {}),
        ...(response.files?.length ? { files: response.files } : {}),
      };
      return;
    }

    const sessionId = await this.getProtocolSessionId(request);

    let protocolSessionId: string | undefined;
    for await (const event of this.options.inner.stream(request, {
      ...ctx,
      protocolSessionId: sessionId,
    })) {
      protocolSessionId = event.protocolSessionId ?? protocolSessionId;
      yield event;
    }
    await this.recordProtocolSession(request, protocolSessionId);
  }

  async start(): Promise<void> {
    await this.options.inner.start?.();
  }

  async stop(): Promise<void> {
    await this.options.inner.stop?.();
  }

  private async getProtocolSessionId(
    request: AgentRequest,
  ): Promise<string | undefined> {
    const storeSessionId = await this.store?.get({
      agentId: this.options.agentId,
      protocol: this.options.protocol,
      sessionKey: request.sessionKey.toString(),
    });

    const sessionId = storeSessionId ?? undefined;
    return sessionId;
  }

  private async recordProtocolSession(
    request: AgentRequest,
    protocolSessionId: string | undefined,
  ): Promise<void> {
    const sessionId = AgentRequestSession.sessionId(request);

    if (!this.options.store || !sessionId || !protocolSessionId) {
      return;
    }

    await this.options.store.set(
      {
        agentId: this.options.agentId,
        protocol: this.options.protocol,
        sessionKey: request.sessionKey.toString(),
      },
      protocolSessionId,
    );
  }
}
