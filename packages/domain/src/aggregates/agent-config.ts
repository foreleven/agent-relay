/**
 * AgentConfigAggregate – write-model aggregate root for agent configurations.
 *
 * Mirrors the same event-sourcing pattern as ChannelBindingAggregate.
 */

import type {
  AgentDeleted,
  AgentEvent,
  AgentRegistered,
  AgentUpdated,
} from "../events.js";

export type AgentProtocol = "a2a" | "acp";

export interface A2AAgentConfig {
  readonly url: string;
  readonly contextIdStrategy?: A2AContextIdStrategy;
}

export type A2AContextIdStrategy = "client-provided" | "server-assigned";

export interface ACPStdioAgentConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly permission?:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always";
  readonly timeoutMs?: number;
}

export type ACPAgentConfig = ACPStdioAgentConfig;
export type AgentProtocolConfig = A2AAgentConfig | ACPAgentConfig;

export interface AgentConfigSnapshot {
  readonly id: string;
  readonly name: string;
  readonly protocol: AgentProtocol;
  readonly config: AgentProtocolConfig;
  readonly description?: string;
  readonly createdAt: string;
}

/** DDD aggregate root for agent configuration write-side invariants. */
export class AgentConfigAggregate {
  id!: string;
  name!: string;
  protocol!: AgentProtocol;
  config!: AgentProtocolConfig;
  description?: string;
  createdAt!: string;

  /** Number of events applied (stream version). */
  version = 0;

  /** True after an `AgentDeleted` event has been applied. */
  isDeleted = false;

  private _pendingEvents: AgentEvent[] = [];

  get pendingEvents(): readonly AgentEvent[] {
    return this._pendingEvents;
  }

  clearPendingEvents(): void {
    this._pendingEvents = [];
  }

  snapshot(): AgentConfigSnapshot {
    return {
      id: this.id,
      name: this.name,
      protocol: this.protocol,
      config: this.config,
      description: this.description,
      createdAt: this.createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  static register(data: {
    id: string;
    name: string;
    protocol: AgentProtocol;
    config: AgentProtocolConfig;
    description?: string;
  }): AgentConfigAggregate {
    assertValidAgentName(data.name);
    const agg = new AgentConfigAggregate();
    agg.raiseEvent({
      eventType: "AgentRegistered.v1",
      agentId: data.id,
      name: data.name,
      protocol: data.protocol,
      config: data.config,
      description: data.description,
      occurredAt: new Date().toISOString(),
    });
    return agg;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  update(
    changes: Partial<Omit<AgentConfigSnapshot, "id" | "createdAt">>,
  ): void {
    if (this.isDeleted) {
      throw new Error(`AgentConfig ${this.id} has been deleted`);
    }
    assertValidAgentName(changes.name ?? this.name);
    if (Object.keys(changes).length === 0) return;
    this.raiseEvent({
      eventType: "AgentUpdated.v1",
      agentId: this.id,
      changes: {
        name: changes.name,
        protocol: changes.protocol,
        config: changes.config,
        // `undefined` means "not included in changes", `null` means "clear the field".
        description:
          changes.description === undefined ? undefined : (changes.description ?? null),
      },
      occurredAt: new Date().toISOString(),
    });
  }

  delete(): void {
    if (this.isDeleted) {
      throw new Error(`AgentConfig ${this.id} is already deleted`);
    }
    this.raiseEvent({
      eventType: "AgentDeleted.v1",
      agentId: this.id,
      occurredAt: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Reconstitution
  // -------------------------------------------------------------------------

  static reconstitute(events: AgentEvent[]): AgentConfigAggregate {
    const agg = new AgentConfigAggregate();
    for (const event of events) {
      agg.apply(event);
      agg.version++;
    }
    return agg;
  }

  static fromSnapshot(snapshot: AgentConfigSnapshot): AgentConfigAggregate {
    const agg = new AgentConfigAggregate();
    agg.id = snapshot.id;
    agg.name = snapshot.name;
    agg.protocol = snapshot.protocol;
    agg.config = snapshot.config;
    agg.description = snapshot.description;
    agg.createdAt = snapshot.createdAt;
    return agg;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private raiseEvent(event: AgentEvent): void {
    this.apply(event);
    this._pendingEvents.push(event);
    this.version++;
  }

  apply(event: AgentEvent): void {
    switch (event.eventType) {
      case "AgentRegistered.v1":
        this.id = event.agentId;
        this.name = event.name;
        this.protocol = event.protocol;
        this.config = event.config;
        this.description = event.description;
        this.createdAt = event.occurredAt;
        break;

      case "AgentUpdated.v1": {
        const c = event.changes;
        if (c.name !== undefined) this.name = c.name;
        if (c.protocol !== undefined) this.protocol = c.protocol;
        if (c.config !== undefined) this.config = c.config;
        if (c.description !== undefined)
          this.description = c.description ?? undefined;
        break;
      }

      case "AgentDeleted.v1":
        this.isDeleted = true;
        break;
    }
  }
}

const AGENT_FOLDER_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidAgentName(value: string): boolean {
  return (
    AGENT_FOLDER_NAME_PATTERN.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function assertValidAgentName(value: string): void {
  if (!isValidAgentName(value)) {
    throw new Error(
      "Agent name must be a folder-safe name using only letters, numbers, dots, underscores, and hyphens",
    );
  }
}
