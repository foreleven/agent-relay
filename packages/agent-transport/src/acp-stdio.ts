/**
 * ACP stdio transport for local Agent Client Protocol processes.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  type ACPStdioAgentConfig,
  type AgentFile,
  type AgentResponse,
  type AgentTransport,
  type AgentTransportContext,
  type AgentRequest,
  AgentRequestSession,
  type AgentCallContext,
} from "./transport.js";

interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  permission: string;
  timeoutMs: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/** Agent transport implementation backed by ACP-compatible stdio processes. */
export class ACPStdioTransport implements AgentTransport {
  readonly protocol = "acp";
  private readonly processPool: ACPStdioAgentProcessPool;

  constructor(config: ACPStdioAgentConfig, context?: AgentTransportContext) {
    this.processPool = new ACPStdioAgentProcessPool(config, context);
  }

  send(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): Promise<AgentResponse> {
    return this.processPool.send(request, ctx);
  }

  start(): Promise<void> {
    return this.processPool.start();
  }

  stop(): Promise<void> {
    return this.processPool.stop();
  }
}

/**
 * Owns ACP worker processes for one transport config.
 *
 * ACP sessions are created below the worker layer. The pool only decides which
 * long-lived process should receive a request, so account/workspace isolation
 * stays separate from protocol-level session id reuse.
 */
class ACPStdioAgentProcessPool {
  private readonly workers = new Map<string, ACPStdioAgentProcess>();
  private stopping = false;

  constructor(
    private readonly config: ACPStdioAgentConfig,
    private readonly context?: AgentTransportContext,
  ) {}

  async send(
    request: AgentRequest,
    ctx: AgentCallContext = {},
  ): Promise<AgentResponse> {
    if (this.stopping) {
      return { text: "(agent unavailable: ACP stdio transport is stopping)" };
    }

    const workerKey = buildWorkerKey(this.config, request);
    const worker = this.getOrCreateWorker(workerKey, request);

    try {
      return await worker.send(request, ctx);
    } catch (error) {
      if (this.workers.get(workerKey) === worker) {
        this.workers.delete(workerKey);
      }
      await worker.stop();
      console.error("[acp stdio] agent request failed:", String(error));
      return { text: `(agent unavailable: ${String(error)})` };
    }
  }

  async start(): Promise<void> {
    // Account-scoped workers are created lazily because accountId is request context.
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const allWorkers = Array.from(this.workers.values());
    this.workers.clear();
    await Promise.all(allWorkers.map((worker) => worker.stop()));
  }

  private getOrCreateWorker(
    workerKey: string,
    request: AgentRequest,
  ): ACPStdioAgentProcess {
    let worker = this.workers.get(workerKey);
    if (!worker) {
      worker = new ACPStdioAgentProcess(
        parseCommandSpec(
          this.config,
          request.accountId,
          request.sessionKey.toString(),
          this.context,
        ),
      );
      this.workers.set(workerKey, worker);
    }

    return worker;
  }
}

/**
 * Wraps one ACP stdio process and maps gateway session keys to ACP session ids.
 *
 * Session behavior follows the ACP session setup contract:
 * - Each request gets a fresh `session/new` session unless the caller provides
 *   a protocol session id through the call context.
 * - A provided ACP session id is loaded only when the agent advertises the
 *   top-level `loadSession` capability and accepts `session/load`.
 *
 * This class intentionally does not know where mappings are stored. It accepts
 * a previous ACP session id through context and returns a reusable ACP session
 * id in the response only when later `session/load` is supported.
 */
class ACPStdioAgentProcess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: acp.ClientSideConnection | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly activeTextBuffers = new Map<string, string[]>();
  private readonly activeFileBuffers = new Map<string, AgentFile[]>();
  private readonly client: ACPStdioClientCallbacks;
  private agentCapabilities?: acp.AgentCapabilities;
  private turnQueue = Promise.resolve();
  private stopping = false;

  constructor(private readonly command: CommandSpec) {
    this.client = new ACPStdioClientCallbacks(
      this.activeTextBuffers,
      this.activeFileBuffers,
      command.permission,
    );
  }

  start(): Promise<void> {
    return this.initialize();
  }

  send(request: AgentRequest, ctx: AgentCallContext): Promise<AgentResponse> {
    const turn = this.turnQueue.then(() => this.sendSerialized(request, ctx));
    this.turnQueue = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.stopping = true;
    this.child = null;
    this.connection = null;
    this.initializePromise = null;
    this.agentCapabilities = undefined;
    this.activeTextBuffers.clear();
    this.activeFileBuffers.clear();

    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  private async sendSerialized(
    request: AgentRequest,
    ctx: AgentCallContext,
  ): Promise<AgentResponse> {
    await this.initialize();
    const connection = this.requireConnection();
    const sessionId = await this.getOrCreateSession(ctx);
    const collectedText: string[] = [];
    const collectedFiles: AgentFile[] = [];
    this.activeTextBuffers.set(sessionId, collectedText);
    this.activeFileBuffers.set(sessionId, collectedFiles);

    try {
      const contentBlocks = buildACPPromptBlocks(request);
      const response = await withTimeout(
        connection.prompt({ sessionId, prompt: contentBlocks }),
        this.command.timeoutMs,
        'ACP request "session/prompt"',
      );

      if (response.stopReason === "cancelled") {
        return { text: "(agent cancelled)" };
      }

      const text = collectedText.join("").trim();
      return {
        text: text || "(no response from agent)",
        ...(this.canReturnProtocolSessionId()
          ? { protocolSessionId: sessionId }
          : {}),
        ...(collectedFiles.length ? { files: collectedFiles } : {}),
      };
    } finally {
      this.activeTextBuffers.delete(sessionId);
      this.activeFileBuffers.delete(sessionId);
    }
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;

    this.initializePromise = (async () => {
      try {
        await mkdir(this.command.cwd, { recursive: true });
      } catch (err) {
        throw new Error(
          `[acp stdio] failed to create working directory "${this.command.cwd}": ${String(err)}`,
        );
      }
      this.startChild();
      const connection = this.requireConnection();
      const response = await withTimeout(
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "agent-relay-gateway",
            version: "0.1.0",
          },
        }),
        this.command.timeoutMs,
        'ACP request "initialize"',
      );
      this.agentCapabilities = response.agentCapabilities;
      console.log(
        "[acp stdio] agent initialized with capabilities:",
        JSON.stringify(this.agentCapabilities),
      );
    })();

    return this.initializePromise;
  }

  private async getOrCreateSession(ctx: AgentCallContext): Promise<string> {
    const loaded = await this.loadProtocolSession(ctx.protocolSessionId);
    if (loaded) return loaded;

    // No reusable ACP session exists for this gateway session key. Create a new
    // protocol session and return it only when the agent can load it later.
    const response = await withTimeout(
      this.requireConnection().newSession({
        cwd: this.command.cwd,
        mcpServers: [],
      }),
      this.command.timeoutMs,
      'ACP request "session/new"',
    );

    return response.sessionId;
  }

  private async loadProtocolSession(
    sessionId: string | undefined,
  ): Promise<string | null> {
    if (!this.canLoadSessions() || !sessionId) {
      return null;
    }

    try {
      await withTimeout(
        this.requireConnection().loadSession({
          sessionId: sessionId,
          cwd: this.command.cwd,
          mcpServers: [],
        }),
        this.command.timeoutMs,
        'ACP request "session/load"',
      );
      return sessionId;
    } catch (error) {
      console.error(
        "[acp stdio] failed to load mapped session:",
        String(error),
      );
      return null;
    }
  }

  private canReturnProtocolSessionId(): boolean {
    return this.canLoadSessions();
  }

  private canLoadSessions(): boolean {
    return Boolean(this.agentCapabilities?.loadSession);
  }

  private startChild(): void {
    if (this.child) return;

    const child = spawn(this.command.command, this.command.args, {
      cwd: this.command.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.stopping = false;

    const input = Writable.toWeb(child.stdin);
    const output = Readable.toWeb(child.stdout);
    const stream = acp.ndJsonStream(input, output);
    this.connection = new acp.ClientSideConnection(() => this.client, stream);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (text) console.error("[acp stdio stderr]", text);
    });
    child.on("error", (error) => {
      this.clearConnection();
      console.error("[acp stdio] failed to start:", String(error));
    });
    child.on("exit", (code, signal) => {
      const wasStopping = this.stopping;
      this.clearConnection();
      this.stopping = false;
      if (wasStopping) return;

      console.error(
        `[acp stdio] exited with code ${code ?? "null"} signal ${signal ?? "null"}`,
      );
    });
  }

  private requireConnection(): acp.ClientSideConnection {
    if (!this.connection) {
      throw new Error("ACP stdio process is not connected");
    }

    return this.connection;
  }

  private clearConnection(): void {
    this.child = null;
    this.connection = null;
    this.initializePromise = null;
    this.agentCapabilities = undefined;
    this.activeTextBuffers.clear();
    this.activeFileBuffers.clear();
  }
}

class ACPStdioClientCallbacks implements acp.Client {
  constructor(
    private readonly activeTextBuffers: Map<string, string[]>,
    private readonly activeFileBuffers: Map<string, AgentFile[]>,
    private readonly permission: string,
  ) {}

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const preferred = params.options.find(
      (option) => option.kind === this.permission,
    );
    const fallback =
      preferred ??
      params.options.find((option) => option.kind === "reject_once") ??
      params.options.find((option) => option.kind === "reject_always") ??
      params.options[0];

    if (!fallback) {
      return { outcome: { outcome: "cancelled" } };
    }

    return {
      outcome: {
        outcome: "selected",
        optionId: fallback.optionId,
      },
    };
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    if (params.update.sessionUpdate !== "agent_message_chunk") return;

    const textBuffer = this.activeTextBuffers.get(params.sessionId);
    const fileBuffer = this.activeFileBuffers.get(params.sessionId);

    const content = params.update.content;
    if (content.type === "text") {
      if (textBuffer) textBuffer.push(content.text);
    } else if (content.type === "image") {
      if (fileBuffer && content.data && content.mimeType) {
        fileBuffer.push({
          data: content.data,
          mimeType: content.mimeType,
          ...(content.uri ? { url: content.uri } : {}),
        });
      }
    } else if (content.type === "audio") {
      if (fileBuffer && content.data && content.mimeType) {
        fileBuffer.push({
          data: content.data,
          mimeType: content.mimeType,
        });
      }
    }
  }
}

/** Build the ACP prompt content block array from an AgentRequest. */
function buildACPPromptBlocks(request: AgentRequest): acp.ContentBlock[] {
  const blocks: acp.ContentBlock[] = [];

  if (request.message.trim()) {
    blocks.push({ type: "text", text: request.message });
  }

  for (const f of request.files ?? []) {
    if (!f.mimeType) continue;

    if (f.mimeType.startsWith("image/")) {
      if (f.data) {
        blocks.push({
          type: "image",
          data: f.data,
          mimeType: f.mimeType,
          ...(f.url ? { uri: f.url } : {}),
        });
      } else if (f.url) {
        // No inline data: send as a resource link so the agent can fetch it.
        blocks.push({
          type: "resource_link",
          uri: f.url,
          name: f.name ?? f.url,
          mimeType: f.mimeType,
        });
      }
    } else if (f.mimeType.startsWith("audio/")) {
      if (f.data) {
        blocks.push({
          type: "audio",
          data: f.data,
          mimeType: f.mimeType,
        });
      } else if (f.url) {
        blocks.push({
          type: "resource_link",
          uri: f.url,
          name: f.name ?? f.url,
          mimeType: f.mimeType,
        });
      }
    } else if (f.url) {
      // Non-image/audio files: send as resource_link
      blocks.push({
        type: "resource_link",
        uri: f.url,
        name: f.name ?? f.url,
        mimeType: f.mimeType,
      });
    }
  }

  return blocks;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}

function parseCommandSpec(
  config: ACPStdioAgentConfig,
  accountId: string,
  sessionKey: string,
  context?: AgentTransportContext,
): CommandSpec {
  const command = config.command.trim();
  const templateVars = { accountId, sessionKey };
  const args = (config.args ?? []).map((arg) =>
    renderCommandTemplate(arg, templateVars),
  );

  const acpBasePath = process.env["ACP_BASE_PATH"];
  const agentName = context?.agentName;
  if (acpBasePath && agentName && !isFolderSafePathSegment(agentName)) {
    throw new Error(
      "ACP stdio agentName must be a folder-safe name using only letters, numbers, dots, underscores, and hyphens",
    );
  }
  const configuredCwd = config.cwd
    ? renderCommandTemplate(config.cwd, templateVars).trim()
    : undefined;
  const cwd = configuredCwd
    ? configuredCwd
    : acpBasePath && agentName && accountId
      ? join(acpBasePath, agentName, sanitizePathSegment(accountId))
      : (process.env["ACP_STDIO_CWD"] ?? process.cwd());

  const permission =
    config.permission ?? process.env["ACP_STDIO_PERMISSION"] ?? "reject_once";
  const timeoutMs = readPositiveIntegerValue(
    config.timeoutMs ?? process.env["ACP_STDIO_REQUEST_TIMEOUT_MS"],
    DEFAULT_REQUEST_TIMEOUT_MS,
  );

  if (command) {
    return { command, args, cwd, permission, timeoutMs };
  }

  throw new Error("ACP stdio config requires command");
}

function buildWorkerKey(
  config: ACPStdioAgentConfig,
  request: AgentRequest,
): string {
  const sessionScoped = commandTemplatesUseSessionKey(config);
  return [
    request.accountId,
    sessionScoped ? request.sessionKey.toString() : "",
  ].join("\0");
}

function commandTemplatesUseSessionKey(config: ACPStdioAgentConfig): boolean {
  return (
    (config.cwd?.includes("{sessionKey}") ?? false) ||
    (config.args ?? []).some((arg) => arg.includes("{sessionKey}"))
  );
}

function renderCommandTemplate(
  value: string,
  vars: { accountId: string; sessionKey: string },
): string {
  return value
    .replaceAll("{accountId}", vars.accountId)
    .replaceAll("{sessionKey}", vars.sessionKey);
}

function readPositiveIntegerValue(value: unknown, fallback: number): number {
  if (!value) return fallback;

  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Strips directory separators and parent-directory components from a segment
 * that will be used as part of a filesystem path, preventing path traversal.
 */
function sanitizePathSegment(segment: string): string {
  return basename(segment);
}

function isFolderSafePathSegment(segment: string): boolean {
  return (
    /^[A-Za-z0-9._-]+$/.test(segment) && segment !== "." && segment !== ".."
  );
}
