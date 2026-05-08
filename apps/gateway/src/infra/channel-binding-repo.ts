import type {
  ChannelBindingRepository,
  ChannelBindingSnapshot,
} from "@agent-relay/domain";
import {
  ChannelBindingAggregate,
  type SessionIsolationStrategy,
} from "@agent-relay/domain";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

function buildEnabledKey(snapshot: Pick<
  ChannelBindingSnapshot,
  "channelType" | "accountId" | "enabled"
>): string | null {
  if (!snapshot.enabled) {
    return null;
  }

  return `${snapshot.channelType}:${snapshot.accountId}`;
}

function mapPrismaRowToSnapshot(row: {
  id: string;
  name: string;
  channelType: string;
  accountId: string;
  channelConfig: string;
  agentId: string;
  sessionIsolationStrategy?: string;
  enabled: boolean;
  createdAt: Date;
}): ChannelBindingSnapshot {
  return {
    id: row.id,
    name: row.name,
    channelType: row.channelType,
    accountId: row.accountId,
    channelConfig: JSON.parse(row.channelConfig) as Record<string, unknown>,
    agentId: row.agentId,
    sessionIsolationStrategy: parseSessionIsolationStrategy(
      row.sessionIsolationStrategy,
    ),
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Prisma-backed current-state repository for ChannelBinding aggregates. */
@injectable()
export class ChannelBindingStateRepository implements ChannelBindingRepository {
  async findById(id: string): Promise<ChannelBindingAggregate | null> {
    const row = await prisma.channelBinding.findUnique({ where: { id } });
    if (!row) return null;
    return ChannelBindingAggregate.fromSnapshot(mapPrismaRowToSnapshot(row));
  }

  async findAll(): Promise<ChannelBindingSnapshot[]> {
    const rows = await prisma.channelBinding.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapPrismaRowToSnapshot);
  }

  async findEnabled(
    channelType: string,
    accountId: string,
    excludeId?: string,
  ): Promise<ChannelBindingSnapshot | null> {
    const row = await prisma.channelBinding.findFirst({
      where: {
        channelType,
        accountId,
        enabled: true,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
    });
    return row ? mapPrismaRowToSnapshot(row) : null;
  }

  async findByAgentId(agentId: string): Promise<ChannelBindingSnapshot[]> {
    const rows = await prisma.channelBinding.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapPrismaRowToSnapshot);
  }

  async findByChannelAccount(
    channelType: string,
    accountId: string,
  ): Promise<ChannelBindingSnapshot | null> {
    const row = await prisma.channelBinding.findFirst({
      where: { channelType, accountId },
      orderBy: { createdAt: "asc" },
    });
    return row ? mapPrismaRowToSnapshot(row) : null;
  }

  async save(aggregate: ChannelBindingAggregate): Promise<void> {
    const pending = aggregate.pendingEvents;
    if (pending.length === 0) return;

    await prisma.$transaction(async (tx) => {
      if (aggregate.isDeleted) {
        await tx.channelBinding.deleteMany({ where: { id: aggregate.id } });
      } else {
        const snapshot = aggregate.snapshot();
        await tx.channelBinding.upsert({
          where: { id: snapshot.id },
          create: {
            id: snapshot.id,
            name: snapshot.name,
            channelType: snapshot.channelType,
            accountId: snapshot.accountId,
            channelConfig: JSON.stringify(snapshot.channelConfig),
            agentId: snapshot.agentId,
            sessionIsolationStrategy:
              snapshot.sessionIsolationStrategy ?? "sessionKey",
            enabledKey: buildEnabledKey(snapshot),
            enabled: snapshot.enabled,
            createdAt: new Date(snapshot.createdAt),
          },
          update: {
            name: snapshot.name,
            channelType: snapshot.channelType,
            accountId: snapshot.accountId,
            channelConfig: JSON.stringify(snapshot.channelConfig),
            agentId: snapshot.agentId,
            sessionIsolationStrategy:
              snapshot.sessionIsolationStrategy ?? "sessionKey",
            enabledKey: buildEnabledKey(snapshot),
            enabled: snapshot.enabled,
          },
        });
      }

    });

    aggregate.clearPendingEvents();
  }
}

function parseSessionIsolationStrategy(
  value: string | undefined,
): SessionIsolationStrategy {
  return value === "request" || value === "accountId" ? value : "sessionKey";
}
