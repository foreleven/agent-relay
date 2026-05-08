/**
 * A2A (Agent-to-Agent) protocol transport adapter.
 *
 * Implements AgentTransport over the A2A JSON-RPC protocol using
 * @a2a-js/sdk.
 */

import crypto from "node:crypto";
import { ClientFactory } from "@a2a-js/sdk/client";
import type { MessageSendParams, Part } from "@a2a-js/sdk";
import {
  type A2AAgentConfig,
  type AgentFile,
  type AgentProtocolConfig,
  type AgentResponse,
  type AgentResponseStreamEvent,
  type AgentTransport,
  type AgentTransportContext,
  type AgentTransportFactory,
  type AgentRequest,
  AgentRequestSession,
  type AgentCallContext,
} from "./transport.js";

/** Extract the first text reply from an A2A result envelope. */
function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const rec = result as Record<string, unknown>;

  // Unwrap JSON-RPC success envelope
  if ("jsonrpc" in rec && "result" in rec) return extractText(rec["result"]);

  if (rec["kind"] === "message") {
    const parts = Array.isArray(rec["parts"]) ? rec["parts"] : [];
    return parts
      .filter(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          (p as Record<string, unknown>)["kind"] === "text",
      )
      .map(
        (p: unknown) =>
          ((p as Record<string, unknown>)["text"] as string) ?? "",
      )
      .join("\n")
      .trim();
  }

  if (rec["kind"] === "task") {
    const texts: string[] = [];
    for (const artifact of (Array.isArray(rec["artifacts"])
      ? rec["artifacts"]
      : []) as Array<Record<string, unknown>>) {
      for (const part of (Array.isArray(artifact["parts"])
        ? artifact["parts"]
        : []) as Array<Record<string, unknown>>) {
        if (part["kind"] === "text" && typeof part["text"] === "string") {
          texts.push(part["text"]);
        }
      }
    }
    return texts.join("\n").trim();
  }

  if (rec["kind"] === "artifact-update") {
    return extractText({
      kind: "task",
      artifacts: [rec["artifact"]],
    });
  }

  return "";
}

/** Extract file attachments from an A2A result envelope. */
function extractFiles(result: unknown): AgentFile[] {
  if (!result || typeof result !== "object") return [];
  const rec = result as Record<string, unknown>;

  // Unwrap JSON-RPC success envelope
  if ("jsonrpc" in rec && "result" in rec) return extractFiles(rec["result"]);

  if (rec["kind"] === "message") {
    return extractFilesFromParts(
      Array.isArray(rec["parts"]) ? rec["parts"] : [],
    );
  }

  if (rec["kind"] === "task") {
    const files: AgentFile[] = [];
    for (const artifact of (Array.isArray(rec["artifacts"])
      ? rec["artifacts"]
      : []) as Array<Record<string, unknown>>) {
      files.push(
        ...extractFilesFromParts(
          Array.isArray(artifact["parts"]) ? artifact["parts"] : [],
        ),
      );
    }
    return files;
  }

  if (rec["kind"] === "artifact-update") {
    return extractFiles({ kind: "task", artifacts: [rec["artifact"]] });
  }

  return [];
}

/** Convert raw A2A part objects with kind "file" into AgentFile values. */
function extractFilesFromParts(parts: unknown[]): AgentFile[] {
  const files: AgentFile[] = [];
  for (const p of parts) {
    if (
      typeof p !== "object" ||
      p === null ||
      (p as Record<string, unknown>)["kind"] !== "file"
    ) {
      continue;
    }
    const part = p as Record<string, unknown>;
    const file = part["file"] as Record<string, unknown> | undefined;
    if (!file) continue;

    const agentFile: AgentFile = {
      mimeType:
        typeof file["mimeType"] === "string" ? file["mimeType"] : undefined,
      name: typeof file["name"] === "string" ? file["name"] : undefined,
    };

    if (typeof file["uri"] === "string") {
      agentFile.url = file["uri"];
    } else if (typeof file["bytes"] === "string") {
      agentFile.data = file["bytes"];
    } else {
      continue;
    }

    files.push(agentFile);
  }
  return files;
}

function extractContextId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const rec = result as Record<string, unknown>;
  if ("jsonrpc" in rec && "result" in rec) {
    return extractContextId(rec["result"]);
  }
  if (typeof rec["contextId"] === "string" && rec["contextId"].trim()) {
    return rec["contextId"];
  }
  if (rec["kind"] === "artifact-update") {
    return extractContextId(rec["task"]);
  }
  return undefined;
}

/** Build A2A FilePart objects from AgentFile attachments. */
function buildFileParts(files: AgentFile[]): Array<Part> {
  const parts: Array<Part> = [];
  for (const f of files) {
    if (f.url) {
      parts.push({
        kind: "file",
        file: {
          uri: f.url,
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
          ...(f.name ? { name: f.name } : {}),
        },
      });
    } else if (f.data) {
      parts.push({
        kind: "file",
        file: {
          bytes: f.data,
          ...(f.mimeType ? { mimeType: f.mimeType } : {}),
          ...(f.name ? { name: f.name } : {}),
        },
      });
    }
  }
  return parts;
}

/** Factory for JSON-RPC A2A-compatible agent transports. */
export class A2ATransport implements AgentTransportFactory {
  readonly protocol = "a2a";

  create(
    config: AgentProtocolConfig,
    context?: AgentTransportContext,
  ): AgentTransport {
    if (!isA2AAgentConfig(config)) {
      throw new Error("A2A transport requires config.url");
    }

    return new A2AAgentTransport(config, context);
  }
}

function isA2AAgentConfig(
  config: AgentProtocolConfig,
): config is A2AAgentConfig {
  return "url" in config && typeof config.url === "string";
}

/** Agent transport adapter for one configured JSON-RPC A2A-compatible agent. */
class A2AAgentTransport implements AgentTransport {
  readonly protocol = "a2a";
  private readonly factory = new ClientFactory();
  /** Cache the resolved client to avoid re-fetching the agent card. */
  private readonly clientCache = new Map<
    string,
    Awaited<ReturnType<ClientFactory["createFromUrl"]>>
  >();

  constructor(
    private readonly config: A2AAgentConfig,
    _context?: AgentTransportContext,
  ) {}

  async send(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): Promise<AgentResponse> {
    const timeoutMs = 30_000;
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        const err = new Error(`A2A request timed out after ${timeoutMs}ms`);
        abortController.abort(err);
        reject(err);
      }, timeoutMs);
    });

    const requestPromise = (async () => {
      // createFromUrl is included in the timeout race via Promise.race below,
      // so a hang in client discovery will be cancelled by the timeout winning.
      const agentUrl = this.config.url;
      let client = this.clientCache.get(agentUrl);
      if (!client) {
        client = await this.factory.createFromUrl(agentUrl);
        this.clientCache.set(agentUrl, client);
      }
      const payload = await this.buildPayload(request, ctx);
      const result = await client.sendMessage(payload, {
        signal: abortController.signal,
      });
      const text = extractText(result);
      const files = extractFiles(result);
      const protocolSessionId = this.extractServerContextId(result);
      return {
        text: text || "(no response from agent)",
        ...(protocolSessionId ? { protocolSessionId } : {}),
        ...(files.length ? { files } : {}),
      };
    })();

    try {
      return await Promise.race([requestPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async *stream(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): AsyncIterable<AgentResponseStreamEvent> {
    const timeoutMs = 120_000;
    const abortController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let finalText = "";
    let yielded = false;
    let yieldedFinal = false;

    try {
      timeoutHandle = setTimeout(() => {
        abortController.abort(
          new Error(`A2A stream timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      const agentUrl = this.config.url;
      let client = this.clientCache.get(agentUrl);
      if (!client) {
        client = await this.factory.createFromUrl(agentUrl);
        this.clientCache.set(agentUrl, client);
      }

      const payload = await this.buildPayload(request, ctx);
      const stream = client.sendMessageStream(payload, {
        signal: abortController.signal,
      });

      for await (const event of stream) {
        const text = extractText(event);
        const files = extractFiles(event);
        const protocolSessionId = this.extractServerContextId(event);
        const hasContent = text || files.length > 0;
        if (!hasContent) {
          continue;
        }

        if (event.kind === "artifact-update") {
          yielded = true;
          finalText = event.append ? `${finalText}${text}` : text;
          yield {
            kind: event.lastChunk ? "final" : "block",
            text: event.lastChunk ? finalText : text,
            ...(protocolSessionId ? { protocolSessionId } : {}),
            ...(files.length ? { files } : {}),
          };
          if (event.lastChunk) {
            yieldedFinal = true;
          }
          continue;
        }

        finalText = text;
        yielded = true;
        if (event.kind === "message") {
          yieldedFinal = true;
          yield {
            kind: "final",
            text,
            ...(protocolSessionId ? { protocolSessionId } : {}),
            ...(files.length ? { files } : {}),
          };
        } else {
          yield {
            kind: "partial",
            text,
            ...(protocolSessionId ? { protocolSessionId } : {}),
          };
        }
      }

      if (!yielded) {
        const response = await this.send(request);
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

      if (finalText && !yieldedFinal) {
        yield { kind: "final", text: finalText };
      }
    } catch (error) {
      if (yielded && finalText && !yieldedFinal) {
        yield { kind: "final", text: finalText };
        return;
      }

      throw error;
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private async buildPayload(
    request: AgentRequest,
    ctx: AgentCallContext,
  ): Promise<MessageSendParams> {
    const contextId = ctx.protocolSessionId ?? this.resolveContextId(request);
    const parts: Array<Part> = [];
    if (request.message.trim()) {
      parts.push({ kind: "text", text: request.message });
    }
    parts.push(...buildFileParts(request.files ?? []));
    return {
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts,
        ...(contextId ? { contextId } : {}),
        metadata: { userId: request.accountId },
      },
    };
  }

  private resolveContextId(request: AgentRequest): string | undefined {
    if (this.config.contextIdStrategy !== "server-assigned") {
      return AgentRequestSession.sessionId(request);
    }

    return undefined;
  }

  private extractServerContextId(result: unknown): string | undefined {
    if (this.config.contextIdStrategy !== "server-assigned") {
      return undefined;
    }

    return extractContextId(result);
  }
}
