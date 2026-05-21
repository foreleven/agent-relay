import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../bootstrap/config.js";
import { AccountService } from "../application/account-service.js";
import { AccountRoutes } from "./routes/accounts.js";
import { AgentRoutes } from "./routes/agents.js";
import { ChannelRoutes } from "./routes/channels.js";
import { MessageRoutes } from "./routes/messages.js";
import { RuntimeStatusRoutes } from "./routes/runtime-status.js";
import { ScheduledJobRoutes } from "./routes/scheduled-jobs.js";
import { SandboxRoutes } from "./routes/sandboxes.js";
import { extractAuthToken } from "./routes/accounts.js";

export interface GatewayApp {
  fetch(request: Request, env: unknown): Promise<unknown> | unknown;
  request?: Hono["request"];
}

export const GatewayApp = Symbol.for("http.GatewayApp");
export const GatewayWebDir = Symbol.for("http.GatewayWebDir");

/**
 * Thin HTTP composition layer.
 *
 * This class owns transport concerns only: CORS policy, static root handling,
 * and route registration. Business logic lives in the injected route classes
 * and deeper application/runtime services.
 */
@injectable()
export class HonoGatewayApp implements GatewayApp {
  readonly request: Hono["request"];
  private readonly app: Hono;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(GatewayWebDir)
    private readonly webDir: string,
    @inject(AccountService)
    private readonly accountService: AccountService,
    @inject(AccountRoutes)
    private readonly accountRoutes: AccountRoutes,
    @inject(ChannelRoutes)
    private readonly channelRoutes: ChannelRoutes,
    @inject(AgentRoutes)
    private readonly agentRoutes: AgentRoutes,
    @inject(MessageRoutes)
    private readonly messageRoutes: MessageRoutes,
    @inject(RuntimeStatusRoutes)
    private readonly runtimeStatusRoutes: RuntimeStatusRoutes,
    @inject(ScheduledJobRoutes)
    private readonly scheduledJobRoutes: ScheduledJobRoutes,
    @inject(SandboxRoutes)
    private readonly sandboxRoutes: SandboxRoutes,
  ) {
    this.app = this.createApp();
    this.request = this.app.request.bind(this.app);
  }

  fetch(request: Request, env: unknown): Promise<unknown> | unknown {
    return this.app.fetch(request, env);
  }

  private createApp(): Hono {
    const app = new Hono();

    // The browser-based admin UI calls the JSON API directly, so CORS is only
    // needed on the API subtree.
    app.use(
      "/api/*",
      cors({
        origin: this.config.corsOrigin,
        allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        credentials: true,
      }),
    );

    app.get("/", async (c) => {
      try {
        // The gateway can still serve a legacy/static web UI build at "/".
        const html = await readFile(`${this.webDir}/index.html`, "utf-8");
        return c.html(html);
      } catch {
        return c.html("<h1>Web UI not found</h1>", 404);
      }
    });

    app.get("/api/health", (c) =>
      c.json({ status: "ok", service: "agent-relay-gateway" }),
    );

    // Auth middleware: protect all API routes except /api/auth/* and the
    // relay-token–authenticated runner-config endpoint.
    app.use("/api/*", async (c, next) => {
      if (
        c.req.path === "/api/health" ||
        c.req.path.startsWith("/api/auth/") ||
        /^\/api\/agents\/[^/]+\/runner-config$/.test(c.req.path)
      ) {
        return next();
      }
      const token = extractAuthToken(c.req.raw.headers);
      if (!token) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const account = await this.accountService.verifyToken(token);
      if (!account) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      c.req.raw.headers.set("x-gateway-account-id", account.id);
      return next();
    });

    this.channelRoutes.register(app);
    this.agentRoutes.register(app);
    this.messageRoutes.register(app);
    this.runtimeStatusRoutes.register(app);
    this.scheduledJobRoutes.register(app);
    this.sandboxRoutes.register(app);
    this.accountRoutes.register(app);

    return app;
  }
}
