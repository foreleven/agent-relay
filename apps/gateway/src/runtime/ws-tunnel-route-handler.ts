/**
 * WsTunnelRouteHandler
 *
 * Handles incoming `GET /ws/a2a/:agentId` WebSocket upgrade requests from
 * relay CLI instances.  Performs relay-token authentication before completing
 * the upgrade, then registers the live connection in `WsTunnelConnectionRegistry`.
 *
 * This handler operates at the raw Node.js HTTP level (listening on the
 * server's `upgrade` event) so it runs outside the Hono middleware chain.
 */

import { inject, injectable } from "inversify";
import { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { WebSocketServer } from "ws";

import { AgentService } from "../application/agent-service.js";
import { WsTunnelConnectionRegistry } from "./ws-tunnel-registry.js";
import type { GatewayLogger as GatewayLoggerPort } from "../infra/logger.js";
import { GatewayLogger } from "../infra/logger.js";
import type { WsTunnelAgentConfig } from "@agent-relay/domain";
import { extractBearerToken } from "../http/utils/auth.js";

const WS_TUNNEL_PATH_RE = /^\/ws\/a2a\/([^/?#]+)/;

@injectable()
export class WsTunnelRouteHandler {
  private readonly wss = new WebSocketServer({ noServer: true });

  constructor(
    @inject(AgentService)
    private readonly agentService: AgentService,
    @inject(WsTunnelConnectionRegistry)
    private readonly registry: WsTunnelConnectionRegistry,
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort,
  ) {}

  /**
   * Called by `GatewayServer` for every HTTP upgrade event.
   * Returns `true` if the request was handled (accepted or rejected), or
   * `false` if the path does not match the WS tunnel pattern.
   */
  async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<boolean> {
    const url = req.url ?? "";
    const match = WS_TUNNEL_PATH_RE.exec(url);
    if (!match) return false;

    const agentId = match[1] ?? "";
    const authHeader = req.headers["authorization"] ?? "";
    const token = extractBearerToken(authHeader);

    // Authenticate before completing the WS upgrade.
    const agent = await this.agentService.getById(agentId).catch(() => null);

    if (!agent || agent.protocol !== "ws-tunnel") {
      rejectUpgrade(socket, 404, "Not Found");
      return true;
    }

    const wsCfg = agent.config as WsTunnelAgentConfig;
    if (!token || token !== wsCfg.relayToken) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return true;
    }

    // All good – complete the WebSocket handshake.
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.logger.info(
        { agentId },
        "relay CLI connected via ws-tunnel",
      );
      this.registry.register(agentId, ws);
      ws.on("close", () => {
        this.logger.info(
          { agentId },
          "relay CLI disconnected from ws-tunnel",
        );
      });
    });

    return true;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sends an HTTP error response over the raw socket and destroys it. */
function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}
