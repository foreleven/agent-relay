/**
 * ChannelBindingAggregate – write-model aggregate root for channel bindings.
 *
 * Encapsulates all state transitions and business invariants.  Every mutating
 * method raises a domain event, updates internal state via `apply()`, and
 * appends the event to `pendingEvents`.  The repository drains `pendingEvents`
 * after persisting them to the event store.
 *
 * Reconstitution (replay) is handled by `ChannelBindingAggregate.reconstitute()`,
 * which replays a sequence of stored events without raising new pending events.
 */

import type { ChannelBindingEvent } from "../events.js";

export type SessionIsolationStrategy = "request" | "sessionKey" | "accountId";

export interface ChannelBindingSnapshot {
  readonly id: string;
  readonly name: string;
  readonly channelType: string;
  readonly accountId: string;
  readonly channelConfig: Record<string, unknown>;
  readonly agentId: string;
  readonly sessionIsolationStrategy?: SessionIsolationStrategy;
  readonly enabled: boolean;
  readonly createdAt: string;
}

/** DDD aggregate root for channel binding configuration invariants. */
export class ChannelBindingAggregate {
  id!: string;
  name!: string;
  channelType!: string;
  accountId!: string;
  channelConfig!: Record<string, unknown>;
  agentId!: string;
  sessionIsolationStrategy!: SessionIsolationStrategy;
  enabled!: boolean;
  createdAt!: string;

  /** Number of events that have been applied (stream version). */
  version = 0;

  /** True after a `ChannelBindingDeleted` event has been applied. */
  isDeleted = false;

  private _pendingEvents: ChannelBindingEvent[] = [];

  get pendingEvents(): readonly ChannelBindingEvent[] {
    return this._pendingEvents;
  }

  /** Called by the repository after persisting all pending events. */
  clearPendingEvents(): void {
    this._pendingEvents = [];
  }

  /** Returns a plain-object snapshot of the current state. */
  snapshot(): ChannelBindingSnapshot {
    return {
      id: this.id,
      name: this.name,
      channelType: this.channelType,
      accountId: this.accountId,
      channelConfig: this.channelConfig,
      agentId: this.agentId,
      sessionIsolationStrategy: this.sessionIsolationStrategy,
      enabled: this.enabled,
      createdAt: this.createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  static create(data: {
    id: string;
    name: string;
    channelType: string;
    accountId: string;
    channelConfig: Record<string, unknown>;
    agentId: string;
    sessionIsolationStrategy?: SessionIsolationStrategy;
    enabled: boolean;
  }): ChannelBindingAggregate {
    const agg = new ChannelBindingAggregate();
    agg.raiseEvent({
      eventType: "ChannelBindingCreated.v1",
      bindingId: data.id,
      name: data.name,
      channelType: data.channelType,
      accountId: data.accountId,
      channelConfig: data.channelConfig,
      agentId: data.agentId,
      sessionIsolationStrategy:
        data.sessionIsolationStrategy ?? "sessionKey",
      enabled: data.enabled,
      occurredAt: new Date().toISOString(),
    });
    return agg;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  update(
    changes: Partial<Omit<ChannelBindingSnapshot, "id" | "createdAt">>,
  ): void {
    if (this.isDeleted) {
      throw new Error(`ChannelBinding ${this.id} has been deleted`);
    }
    if (Object.keys(changes).length === 0) return;
    this.raiseEvent({
      eventType: "ChannelBindingUpdated.v1",
      bindingId: this.id,
      changes,
      occurredAt: new Date().toISOString(),
    });
  }

  delete(): void {
    if (this.isDeleted) {
      throw new Error(`ChannelBinding ${this.id} is already deleted`);
    }
    this.raiseEvent({
      eventType: "ChannelBindingDeleted.v1",
      bindingId: this.id,
      occurredAt: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Reconstitution
  // -------------------------------------------------------------------------

  /**
   * Replay a persisted event stream to rebuild the aggregate state.
   * Does NOT add events to `pendingEvents`.
   */
  static reconstitute(events: ChannelBindingEvent[]): ChannelBindingAggregate {
    const agg = new ChannelBindingAggregate();
    for (const event of events) {
      agg.apply(event);
      agg.version++;
    }
    return agg;
  }

  static fromSnapshot(
    snapshot: ChannelBindingSnapshot,
  ): ChannelBindingAggregate {
    const agg = new ChannelBindingAggregate();
    agg.id = snapshot.id;
    agg.name = snapshot.name;
    agg.channelType = snapshot.channelType;
    agg.accountId = snapshot.accountId;
    agg.channelConfig = snapshot.channelConfig;
    agg.agentId = snapshot.agentId;
    agg.sessionIsolationStrategy =
      snapshot.sessionIsolationStrategy ?? "sessionKey";
    agg.enabled = snapshot.enabled;
    agg.createdAt = snapshot.createdAt;
    return agg;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private raiseEvent(event: ChannelBindingEvent): void {
    this.apply(event);
    this._pendingEvents.push(event);
    this.version++;
  }

  apply(event: ChannelBindingEvent): void {
    switch (event.eventType) {
      case "ChannelBindingCreated.v1":
        this.id = event.bindingId;
        this.name = event.name;
        this.channelType = event.channelType;
        this.accountId = event.accountId;
        this.channelConfig = event.channelConfig;
        this.agentId = event.agentId;
        this.sessionIsolationStrategy =
          event.sessionIsolationStrategy ?? "sessionKey";
        this.enabled = event.enabled;
        this.createdAt = event.occurredAt;
        break;

      case "ChannelBindingUpdated.v1": {
        const c = event.changes;
        if (c.name !== undefined) this.name = c.name;
        if (c.channelType !== undefined) this.channelType = c.channelType;
        if (c.accountId !== undefined) this.accountId = c.accountId;
        if (c.channelConfig !== undefined) this.channelConfig = c.channelConfig;
        if (c.agentId !== undefined) this.agentId = c.agentId;
        if (c.sessionIsolationStrategy !== undefined)
          this.sessionIsolationStrategy = c.sessionIsolationStrategy;
        if (c.enabled !== undefined) this.enabled = c.enabled;
        break;
      }

      case "ChannelBindingDeleted.v1":
        this.isDeleted = true;
        break;
    }
  }
}
