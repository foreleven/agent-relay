/**
 * Repository interfaces for the domain layer.
 *
 * These are pure interfaces – the concrete implementations live in
 * apps/gateway/src/infra/ and depend on Prisma state tables.
 */

import type {
  AgentConfigAggregate,
  AgentConfigSnapshot,
  AgentProtocol,
} from "./aggregates/agent-config.js";
import type {
  ChannelBindingAggregate,
  ChannelBindingSnapshot,
} from "./aggregates/channel-binding.js";
import type { ChannelMessageRecord } from "./messages.js";
import type {
  SandboxAggregate,
  SandboxSnapshot,
} from "./sandbox.js";

export const ChannelBindingRepository = Symbol.for(
  "ports.ChannelBindingRepository",
);
export const AgentConfigRepository = Symbol.for("ports.AgentConfigRepository");
export const ChannelMessageRepository = Symbol.for(
  "ports.ChannelMessageRepository",
);
export const SessionMappingRepository = Symbol.for(
  "ports.SessionMappingRepository",
);
export const SandboxRepository = Symbol.for("ports.SandboxRepository");

export interface ChannelBindingRepository {
  /** Load the aggregate from the current state table. Returns null if unknown. */
  findById(id: string): Promise<ChannelBindingAggregate | null>;

  /**
   * Load all non-deleted bindings as snapshots from the current state table.
   * Returns snapshots – not aggregates – since callers only need read access.
   */
  findAll(): Promise<ChannelBindingSnapshot[]>;

  /**
   * Find the single enabled binding for a channelType + accountId pair.
   * Returns a snapshot for existence checks only; never mutate and re-save.
   */
  findEnabled(
    channelType: string,
    accountId: string,
    excludeId?: string,
  ): Promise<ChannelBindingSnapshot | null>;

  findByAgentId(agentId: string): Promise<ChannelBindingSnapshot[]>;
  findByChannelAccount(
    channelType: string,
    accountId: string,
  ): Promise<ChannelBindingSnapshot | null>;

  /**
   * Persist current aggregate state, then clear pending events.
   */
  save(aggregate: ChannelBindingAggregate): Promise<void>;
}

export interface AgentConfigRepository {
  findById(id: string): Promise<AgentConfigAggregate | null>;
  /** Load all non-deleted agents as snapshots from the current state table. */
  findAll(): Promise<AgentConfigSnapshot[]>;
  save(aggregate: AgentConfigAggregate): Promise<void>;
}

export interface SandboxRepository {
  findById(id: string): Promise<SandboxAggregate | null>;
  findAll(): Promise<SandboxSnapshot[]>;
  findByAgentId(agentId: string): Promise<SandboxSnapshot[]>;
  save(aggregate: SandboxAggregate): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface ChannelMessageRepository {
  append(record: ChannelMessageRecord): Promise<ChannelMessageRecord>;
  listRecent(query?: {
    channelBindingId?: string;
    agentId?: string;
    limit?: number;
  }): Promise<ChannelMessageRecord[]>;
}

export interface SessionMappingKey {
  readonly agentId: string;
  readonly protocol: AgentProtocol;
  readonly sessionKey: string;
}

export interface SessionMappingRepository {
  get(key: SessionMappingKey): Promise<string | null>;
  set(key: SessionMappingKey, protocolSessionId: string): Promise<void>;
}
