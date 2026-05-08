/**
 * Domain events for the agent-relay bounded context.
 *
 * All events are immutable plain objects (no classes).  The `eventType`
 * discriminant includes a version suffix (`.v1`) so consumers can perform
 * upcasting when the schema evolves.
 */

import type {
  AgentProtocol,
  AgentProtocolConfig,
} from "./aggregates/agent-config.js";
import type { SessionIsolationStrategy } from "./aggregates/channel-binding.js";

// ---------------------------------------------------------------------------
// ChannelBinding events
// ---------------------------------------------------------------------------

export interface ChannelBindingCreated {
  readonly eventType: "ChannelBindingCreated.v1";
  readonly bindingId: string;
  readonly name: string;
  readonly channelType: string;
  readonly accountId: string;
  readonly channelConfig: Record<string, unknown>;
  readonly agentId: string;
  readonly sessionIsolationStrategy?: SessionIsolationStrategy;
  readonly enabled: boolean;
  readonly occurredAt: string;
}

export interface ChannelBindingUpdated {
  readonly eventType: "ChannelBindingUpdated.v1";
  readonly bindingId: string;
  readonly changes: Partial<{
    readonly name: string;
    readonly channelType: string;
    readonly accountId: string;
    readonly channelConfig: Record<string, unknown>;
    readonly agentId: string;
    readonly sessionIsolationStrategy: SessionIsolationStrategy;
    readonly enabled: boolean;
  }>;
  readonly occurredAt: string;
}

export interface ChannelBindingDeleted {
  readonly eventType: "ChannelBindingDeleted.v1";
  readonly bindingId: string;
  readonly occurredAt: string;
}

export type ChannelBindingEvent =
  | ChannelBindingCreated
  | ChannelBindingUpdated
  | ChannelBindingDeleted;

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

export interface AgentRegistered {
  readonly eventType: "AgentRegistered.v1";
  readonly agentId: string;
  readonly name: string;
  readonly protocol: AgentProtocol;
  readonly config: AgentProtocolConfig;
  readonly description?: string;
  readonly occurredAt: string;
}

export interface AgentUpdated {
  readonly eventType: "AgentUpdated.v1";
  readonly agentId: string;
  readonly changes: Partial<{
    readonly name: string;
    readonly protocol: AgentProtocol;
    readonly config: AgentProtocolConfig;
    readonly description: string | null;
  }>;
  readonly occurredAt: string;
}

export interface AgentDeleted {
  readonly eventType: "AgentDeleted.v1";
  readonly agentId: string;
  readonly occurredAt: string;
}

export type AgentEvent = AgentRegistered | AgentUpdated | AgentDeleted;

// ---------------------------------------------------------------------------
// Message relay events (audit / monitoring)
// ---------------------------------------------------------------------------

export interface MessageRelayed {
  readonly eventType: "MessageRelayed.v1";
  readonly bindingId?: string;
  readonly sessionKey?: string;
  readonly userMessage: string;
  readonly replyText: string;
  readonly occurredAt: string;
}

// ---------------------------------------------------------------------------
// Union of all domain events
// ---------------------------------------------------------------------------

export type DomainEvent = ChannelBindingEvent | AgentEvent | MessageRelayed;
