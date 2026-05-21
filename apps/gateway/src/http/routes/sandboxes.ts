import { Hono, type Context } from "hono";
import { inject, injectable } from "inversify";

import {
  InvalidSandboxConfigError,
  SandboxService,
} from "../../application/sandbox-service.js";
import { SandboxRuntimeManager } from "../../runtime/sandbox/sandbox-runtime-manager.js";
import { parseJsonBody } from "../utils/schema.js";
import {
  createSandboxBodySchema,
  updateSandboxBodySchema,
} from "../schemas/request-schemas.js";

const encoder = new TextEncoder();

@injectable()
export class SandboxRoutes {
  constructor(
    @inject(SandboxService)
    private readonly sandboxes: SandboxService,
    @inject(SandboxRuntimeManager)
    private readonly runtime: SandboxRuntimeManager,
  ) {}

  register(app: Hono): void {
    app.get("/api/sandboxes", async (c) =>
      c.json(await this.sandboxes.list()),
    );

    app.get("/api/sandboxes/:id", async (c) => {
      const sandbox = await this.sandboxes.getById(c.req.param("id"));
      return sandbox ? c.json(sandbox) : c.json({ error: "Not found" }, 404);
    });

    app.post("/api/sandboxes", async (c) => {
      const parsed = await parseJsonBody(c, createSandboxBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const sandbox = await this.sandboxes.create(parsed.data);
        return c.json(sandbox, 201);
      } catch (err) {
        if (err instanceof InvalidSandboxConfigError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    });

    app.patch("/api/sandboxes/:id", async (c) => {
      const parsed = await parseJsonBody(c, updateSandboxBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }
      try {
        const sandbox = await this.sandboxes.update(c.req.param("id"), parsed.data);
        return sandbox ? c.json(sandbox) : c.json({ error: "Not found" }, 404);
      } catch (err) {
        if (err instanceof InvalidSandboxConfigError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    });

    app.post("/api/sandboxes/:id/start", async (c) => {
      try {
        const sandbox = await this.sandboxes.start(c.req.param("id"));
        return c.json(sandbox);
      } catch (err) {
        return sandboxErrorResponse(c, err);
      }
    });

    app.post("/api/sandboxes/:id/stop", async (c) => {
      try {
        const sandbox = await this.sandboxes.stop(c.req.param("id"));
        return c.json(sandbox);
      } catch (err) {
        return sandboxErrorResponse(c, err);
      }
    });

    app.post("/api/sandboxes/:id/refresh", async (c) => {
      try {
        const sandbox = await this.sandboxes.refresh(c.req.param("id"));
        return c.json(sandbox);
      } catch (err) {
        return sandboxErrorResponse(c, err);
      }
    });

    app.delete("/api/sandboxes/:id", async (c) => {
      const deleted = await this.sandboxes.delete(c.req.param("id"));
      return deleted
        ? c.json({ deleted: true })
        : c.json({ error: "Not found" }, 404);
    });

    app.get("/api/sandboxes/:id/events", (c) => {
      const sandboxId = c.req.param("id");
      const stream = new ReadableStream({
        start: (controller) => {
          const send = (event: string, data: unknown) => {
            controller.enqueue(
              encoder.encode(
                `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
              ),
            );
          };
          const unsubscribe = this.runtime.subscribe(sandboxId, (event) => {
            send(event.type, event.data);
          });
          c.req.raw.signal.addEventListener("abort", () => {
            unsubscribe();
            controller.close();
          });
        },
      });
      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
        },
      });
    });
  }
}

function sandboxErrorResponse(
  c: Context,
  err: unknown,
) {
  if (err instanceof Error && /not found/i.test(err.message)) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof Error) {
    return c.json({ error: err.message }, 400);
  }
  return c.json({ error: String(err) }, 400);
}
