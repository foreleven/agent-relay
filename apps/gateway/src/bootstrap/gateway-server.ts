import { serve as honoServe, type ServerType } from "@hono/node-server";
import { Server as HttpServer } from "node:http";
import {
  inject,
  injectable,
  multiInject,
  optional,
  unmanaged,
} from "inversify";

import { GatewayConfigService } from "./config.js";
import {
  ServiceContributionToken,
  type ServiceContribution,
} from "./service-contribution.js";
import { GatewayApp } from "../http/app.js";
import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../infra/logger.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";
import { WsTunnelRouteHandler } from "../runtime/ws-tunnel-route-handler.js";

interface StartupLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface GatewayServerStartOptions {
  logger?: StartupLogger;
  serve?: typeof honoServe;
}

const defaultLogger: StartupLogger = {
  info(message) {
    process.stdout.write(`${message}\n`);
  },
  error(message, error) {
    process.stderr.write(`${message}${error ? ` ${String(error)}` : ""}\n`);
  },
};

/**
 * Owns the outer process lifecycle once initialization has completed.
 *
 * Responsibilities are intentionally narrow:
 * - start/stop the Hono HTTP server
 * - start/stop background workers that must follow process lifetime
 * - bootstrap runtime orchestration before opening the HTTP listener
 * - attach the WebSocket upgrade handler for the ws-tunnel agent protocol
 *
 * Domain behavior stays outside this class; this is a system boundary, not an
 * application service.
 */
@injectable()
export class GatewayServer {
  private server: ServerType | null = null;
  private startupLogger: StartupLogger = defaultLogger;
  private startedServices: ServiceContribution[] = [];

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(GatewayApp)
    private readonly app: GatewayApp,
    @inject(RelayRuntime)
    private readonly relayRuntime: Pick<RelayRuntime, "bootstrap" | "shutdown">,
    @unmanaged()
    private readonly defaultServe: typeof honoServe = honoServe,
    @multiInject(ServiceContributionToken)
    @optional()
    private readonly serviceContributions: ServiceContribution[] = [],
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
    @inject(WsTunnelRouteHandler)
    @optional()
    private readonly wsTunnelRouteHandler: WsTunnelRouteHandler | null = null,
  ) {}

  async start(options: GatewayServerStartOptions = {}): Promise<void> {
    if (this.server) {
      throw new Error("GatewayServer is already started");
    }

    this.startupLogger = options.logger ?? defaultLogger;

    const serve = options.serve ?? this.defaultServe;

    this.logger.info(
      { port: this.config.port },
      "agent relay gateway starting",
    );
    this.startupLogger.info(
      `Agent Relay Gateway starting on http://localhost:${this.config.port}`,
    );

    try {
      await this.startServiceContributions();
      await this.relayRuntime.bootstrap();
    } catch (error) {
      await this.stopStartedServicesAfterFailedStart();
      throw error;
    }

    try {
      this.server = serve(
        { fetch: this.app.fetch.bind(this.app), port: this.config.port },
        () => {
          this.logger.info(
            { port: this.config.port },
            "agent relay gateway listening",
          );
          this.startupLogger.info(
            `Gateway listening on http://localhost:${this.config.port}`,
          );
          this.startupLogger.info(`Web UI: http://localhost:${this.config.port}/`);
          this.startupLogger.info(
            `API:    http://localhost:${this.config.port}/api/channels`,
          );
        },
      );

      // Attach WebSocket upgrade handler for the ws-tunnel protocol.
      // Node.js http.Server emits 'upgrade' for HTTP → WS upgrades.
      if (this.wsTunnelRouteHandler !== null && this.server instanceof HttpServer) {
        const handler = this.wsTunnelRouteHandler;
        this.server.on(
          "upgrade",
          (
            req: Parameters<WsTunnelRouteHandler["handleUpgrade"]>[0],
            socket: Parameters<WsTunnelRouteHandler["handleUpgrade"]>[1],
            head: Parameters<WsTunnelRouteHandler["handleUpgrade"]>[2],
          ) => {
            handler.handleUpgrade(req, socket, head).catch(
              (err: unknown) => {
                this.logger.error({ err }, "ws-tunnel upgrade error");
                socket.destroy();
              },
            );
          },
        );
      }
    } catch (error) {
      await this.relayRuntime.shutdown();
      await this.stopStartedServicesAfterFailedStart();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.server?.close();
    this.server = null;

    await this.relayRuntime.shutdown();
    await this.stopStartedServices();
  }

  private async startServiceContributions(): Promise<void> {
    this.startedServices = [];
    for (const service of this.serviceContributions) {
      await service.start();
      this.startedServices.push(service);
    }
  }

  private async stopStartedServices(): Promise<void> {
    const services = [...this.startedServices].reverse();
    this.startedServices = [];
    for (const service of services) {
      await service.stop();
    }
  }

  private async stopStartedServicesAfterFailedStart(): Promise<void> {
    try {
      await this.stopStartedServices();
    } catch (error) {
      this.logger.error(
        { err: error },
        "failed to stop service contribution after startup failure",
      );
      this.startupLogger.error("[gateway] failed to stop service contribution", error);
    }
  }
}
