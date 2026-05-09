import { Hono } from "hono";
import { inject, injectable } from "inversify";
import type { WsTunnelAgentConfig } from "@agent-relay/domain";

import {
  AgentService,
  InvalidAgentConfigError,
  ReferencedAgentError,
} from "../../application/agent-service.js";
import { GatewayConfigService } from "../../bootstrap/config.js";
import { parseJsonBody } from "../utils/schema.js";
import {
  registerAgentBodySchema,
  updateAgentBodySchema,
} from "../schemas/request-schemas.js";

/** Extracts a bearer token from the Authorization header. */
function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

/**
 * HTTP adapter for agent configuration CRUD.
 *
 * Also exposes two relay-CLI–specific endpoints that use relay-token auth
 * instead of the standard JWT:
 *   GET  /api/agents/:id/runner-config   – fetch executor config for relay CLI
 *   POST /api/agents/:id/regenerate-token – rotate the relay token
 *
 * Reference checks and deletion constraints live in AgentService.
 */
@injectable()
export class AgentRoutes {
  constructor(
    @inject(AgentService)
    private readonly agentService: AgentService,
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
  ) {}

  register(app: Hono): void {
    app.get("/api/agents", async (c) => c.json(await this.agentService.list()));

    app.get("/api/agents/:id", async (c) => {
      const agent = await this.agentService.getById(c.req.param("id"));
      return agent ? c.json(agent) : c.json({ error: "Not found" }, 404);
    });

    /**
     * Relay-token–authenticated endpoint used by the relay CLI at startup.
     * Returns the executor configuration and the gateway WS URL.
     * This route is exempt from JWT auth in app.ts (path-matched bypass).
     */
    app.get("/api/agents/:id/runner-config", async (c) => {
      const agentId = c.req.param("id");
      const token = extractBearerToken(c.req.header("authorization"));

      const agent = await this.agentService.getById(agentId);
      if (!agent) {
        return c.json({ error: "Agent not found" }, 404);
      }
      if (agent.protocol !== "ws-tunnel") {
        return c.json(
          { error: "Agent is not a ws-tunnel agent" },
          400,
        );
      }

      const wsCfg = agent.config as WsTunnelAgentConfig;
      if (!token || token !== wsCfg.relayToken) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      // Build the gateway WS URL from the runtime address.
      // Normalise to an absolute URL first so that the protocol swap is reliable.
      const runtimeAddress = this.config.runtimeAddress;
      const absoluteAddress = /^https?:\/\//i.test(runtimeAddress)
        ? runtimeAddress
        : `http://${runtimeAddress}`;
      const gatewayWsUrl =
        absoluteAddress
          .replace(/^https:\/\//i, "wss://")
          .replace(/^http:\/\//i, "ws://")
          .replace(/\/$/, "") +
        `/ws/a2a/${agentId}`;

      return c.json({
        agentId: agent.id,
        name: agent.name,
        gatewayWsUrl,
        executor: wsCfg.executor,
      });
    });

    /**
     * Rotates the relay token for a ws-tunnel agent.
     * The new token is returned in the response.  Protected by standard JWT.
     */
    app.post("/api/agents/:id/regenerate-token", async (c) => {
      const id = c.req.param("id");
      try {
        const updated = await this.agentService.regenerateRelayToken(id);
        if (!updated) {
          return c.json({ error: `Agent ${id} not found` }, 404);
        }
        const wsCfg = updated.config as WsTunnelAgentConfig;
        return c.json({ relayToken: wsCfg.relayToken });
      } catch (err) {
        if (err instanceof InvalidAgentConfigError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    });

    app.post("/api/agents", async (c) => {
      const parsed = await parseJsonBody(c, registerAgentBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        // Default protocol selection is an API concern; deeper routing and
        // transport behavior remains encapsulated behind the runtime layer.
        const agent = await this.agentService.register(parsed.data);
        return c.json(agent, 201);
      } catch (err) {
        if (err instanceof InvalidAgentConfigError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    });

    app.patch("/api/agents/:id", async (c) => {
      const id = c.req.param("id");
      const parsed = await parseJsonBody(c, updateAgentBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        const updated = await this.agentService.update(id, parsed.data);
        if (!updated) {
          return c.json({ error: `Agent ${id} not found` }, 404);
        }
        return c.json(updated);
      } catch (err) {
        if (err instanceof InvalidAgentConfigError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    });

    app.delete("/api/agents/:id", async (c) => {
      const id = c.req.param("id");
      try {
        const deleted = await this.agentService.delete(id);
        if (!deleted) {
          return c.json({ error: `Agent ${id} not found` }, 404);
        }
        return c.json({ deleted: true });
      } catch (err) {
        // Service-level referential integrity becomes a 409 for the admin UI.
        if (err instanceof ReferencedAgentError) {
          return c.json(
            { error: err.message, bindingIds: err.bindingIds },
            409,
          );
        }
        throw err;
      }
    });
  }
}
