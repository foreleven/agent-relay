import type {
  AgentConfigSnapshot,
  SandboxSnapshot,
  SandboxSpec,
  WsTunnelAgentConfig,
} from "@agent-relay/domain";

export interface SandboxTemplateContext {
  readonly agent: AgentConfigSnapshot;
  readonly sandbox: SandboxSnapshot;
  readonly gatewayUrl: string;
  readonly gatewayWsUrl: string;
}

export interface RenderedSandboxSpec {
  readonly spec: SandboxSpec;
  readonly secrets: readonly string[];
}

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export class SandboxTemplateRenderer {
  validate(spec: SandboxSpec): void {
    for (const variable of collectVariables(spec)) {
      if (!SUPPORTED_VARIABLES.has(variable)) {
        throw new Error(`Unsupported sandbox template variable: ${variable}`);
      }
    }
  }

  render(spec: SandboxSpec, context: SandboxTemplateContext): RenderedSandboxSpec {
    const values = buildValues(context);
    const secrets = values.get("relay.token") ? [values.get("relay.token") ?? ""] : [];
    return {
      spec: renderValue(spec, values) as SandboxSpec,
      secrets: secrets.filter((secret) => secret.length > 0),
    };
  }
}

const SUPPORTED_VARIABLES = new Set([
  "agent.id",
  "agent.name",
  "agent.executor.type",
  "gateway.url",
  "gateway.wsUrl",
  "relay.token",
  "sandbox.id",
  "workspace.path",
]);

function collectVariables(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(VARIABLE_PATTERN)].map((match) => match[1] ?? "");
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectVariables);
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap(collectVariables);
  }
  return [];
}

function renderValue(value: unknown, values: Map<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(VARIABLE_PATTERN, (_, key: string) => {
      const replacement = values.get(key);
      if (replacement === undefined) {
        throw new Error(`Unsupported sandbox template variable: ${key}`);
      }
      return replacement;
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderValue(item, values));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderValue(item, values)]),
    );
  }
  return value;
}

function buildValues(context: SandboxTemplateContext): Map<string, string> {
  const config = context.agent.config as WsTunnelAgentConfig;
  return new Map([
    ["agent.id", context.agent.id],
    ["agent.name", context.agent.name],
    ["agent.executor.type", config.executor.type],
    ["gateway.url", context.gatewayUrl],
    ["gateway.wsUrl", context.gatewayWsUrl],
    ["relay.token", config.relayToken],
    ["sandbox.id", context.sandbox.id],
    ["workspace.path", context.sandbox.spec.workspace?.path ?? "/workspace"],
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
