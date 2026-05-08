import { createHash, randomUUID } from "node:crypto";
import type { SessionIsolationStrategy } from "./aggregates/channel-binding.js";

export interface AgentSessionKeyParts {
  readonly agentId: string;
  readonly scope: string;
  readonly channel?: string;
  readonly accountId?: string;
  readonly peerKind?: string;
  readonly peerId?: string;
}

export interface AgentPeerSessionKeyInput {
  readonly agentId: string;
  readonly channel: string;
  readonly accountId: string;
  readonly peerKind: string;
  readonly peerId: string;
}

export type SessionIdStrategy =
  | { type: "request" }
  | { type: "sessionKey" }
  | { type: "accountId"; bindingId: string; accountId: string };

export interface SessionIdResult {
  readonly sessionId: string;
  readonly persistMapping: boolean;
}

/** Domain representation of a channel-to-agent session key. */
export class SessionKey {
  private constructor(private readonly raw: string) {}

  /** Wraps any non-empty session key, including legacy and fallback keys. */
  static fromString(value: string): SessionKey {
    const normalized = normalizeRequired(value, "sessionKey");
    return new SessionKey(normalized);
  }

  /** Builds `agent:<agentId>:main` or another explicit main key. */
  static main(agentId: string, mainKey = "main"): SessionKey {
    return new SessionKey(
      [
        "agent",
        normalizeRequired(agentId, "agentId"),
        normalizeRequired(mainKey, "mainKey"),
      ].join(":"),
    );
  }

  /** Builds an agent session scoped to a channel/account/peer route. */
  static forPeer(input: AgentPeerSessionKeyInput): SessionKey {
    return new SessionKey(
      [
        "agent",
        normalizeRequired(input.agentId, "agentId"),
        normalizeRequired(input.channel, "channel"),
        normalizeRequired(input.accountId, "accountId"),
        normalizeRequired(input.peerKind, "peerKind"),
        normalizeRequired(input.peerId, "peerId"),
      ].join(":"),
    );
  }

  /** Parses the raw key and returns a SessionKey wrapper. */
  static parse(value: string): SessionKey {
    return SessionKey.fromString(value);
  }

  /** Returns parsed agent-session parts when this is an `agent:*` key. */
  get agentParts(): AgentSessionKeyParts | null {
    return parseAgentSessionKey(this.raw);
  }

  toString(): string {
    return this.raw;
  }

  /** Returns a stable 32-character MD5 digest suitable for downstream session IDs. */
  toMd5(): string {
    return createHash("md5").update(this.raw).digest("hex");
  }

  /** Derives a downstream agent session id from this gateway session key. */
  toSessionId(strategy: SessionIdStrategy): string | undefined {
    switch (strategy.type) {
      case "request":
        return undefined;
      case "accountId":
        return SessionKey.fromString(
          `binding:${strategy.bindingId}:account:${strategy.accountId}`,
        ).toMd5();
      case "sessionKey":
        return this.toMd5();
    }
  }

  /** Alias for callers that prefer noun-style naming. */
  md5(): string {
    return this.toMd5();
  }
}

export function sessionIdStrategyFromBinding(input: {
  readonly strategy?: SessionIsolationStrategy;
  readonly bindingId: string;
  readonly accountId: string;
}): SessionIdStrategy {
  switch (input.strategy) {
    case "request":
      return { type: "request" };
    case "accountId":
      return {
        type: "accountId",
        bindingId: input.bindingId,
        accountId: input.accountId,
      };
    case "sessionKey":
    default:
      return { type: "sessionKey" };
  }
}

function parseAgentSessionKey(raw: string): AgentSessionKeyParts | null {
  const parts = raw.split(":");
  if (parts.length < 3 || parts[0] !== "agent") {
    return null;
  }

  const agentId = normalizeOptional(parts[1]);
  if (!agentId) return null;

  if (parts.length === 3) {
    const scope = normalizeOptional(parts[2]);
    return scope ? { agentId, scope } : null;
  }

  if (parts.length < 6) {
    return {
      agentId,
      scope: parts.slice(2).join(":"),
    };
  }

  const channel = normalizeOptional(parts[2]);
  const accountId = normalizeOptional(parts[3]);
  const peerKind = normalizeOptional(parts[4]);
  const peerId = normalizeOptional(parts.slice(5).join(":"));
  if (!channel || !accountId || !peerKind || !peerId) return null;

  return {
    agentId,
    scope: `${channel}:${accountId}:${peerKind}:${peerId}`,
    channel,
    accountId,
    peerKind,
    peerId,
  };
}

function normalizeRequired(value: string, label: string): string {
  const normalized = normalizeOptional(value);
  if (!normalized) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
