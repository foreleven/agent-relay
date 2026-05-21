import type {
  SandboxProviderName,
  SandboxRepository,
  SandboxSnapshot,
  SandboxSpec,
  SandboxStatus,
} from "@agent-relay/domain";
import { SandboxAggregate } from "@agent-relay/domain";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

interface SandboxRow {
  id: string;
  agentId: string;
  name: string;
  provider: string;
  specJson: string;
  status: string;
  providerInstanceId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

@injectable()
export class SandboxStateRepository implements SandboxRepository {
  async findById(id: string): Promise<SandboxAggregate | null> {
    const row = await prisma.sandbox.findUnique({ where: { id } });
    return row ? SandboxAggregate.fromSnapshot(mapRow(row)) : null;
  }

  async findAll(): Promise<SandboxSnapshot[]> {
    const rows = await prisma.sandbox.findMany({
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapRow);
  }

  async findByAgentId(agentId: string): Promise<SandboxSnapshot[]> {
    const rows = await prisma.sandbox.findMany({
      where: { agentId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(mapRow);
  }

  async save(aggregate: SandboxAggregate): Promise<void> {
    const snapshot = aggregate.snapshot();
    await prisma.sandbox.upsert({
      where: { id: snapshot.id },
      create: {
        id: snapshot.id,
        agentId: snapshot.agentId,
        name: snapshot.name,
        provider: snapshot.provider,
        specJson: JSON.stringify(snapshot.spec),
        status: snapshot.status,
        providerInstanceId: snapshot.providerInstanceId ?? null,
        lastError: snapshot.lastError ?? null,
        createdAt: new Date(snapshot.createdAt),
        updatedAt: new Date(snapshot.updatedAt),
      },
      update: {
        name: snapshot.name,
        specJson: JSON.stringify(snapshot.spec),
        status: snapshot.status,
        providerInstanceId: snapshot.providerInstanceId ?? null,
        lastError: snapshot.lastError ?? null,
        updatedAt: new Date(snapshot.updatedAt),
      },
    });
  }

  async delete(id: string): Promise<boolean> {
    const result = await prisma.sandbox.deleteMany({ where: { id } });
    return result.count > 0;
  }
}

function mapRow(row: SandboxRow): SandboxSnapshot {
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    provider: parseProvider(row.provider),
    spec: parseSpec(row.specJson),
    status: parseStatus(row.status),
    ...(row.providerInstanceId
      ? { providerInstanceId: row.providerInstanceId }
      : {}),
    ...(row.lastError ? { lastError: row.lastError } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseProvider(value: string): SandboxProviderName {
  return value === "aio-sandbox" ? "aio-sandbox" : "aio-sandbox";
}

function parseStatus(value: string): SandboxStatus {
  if (
    value === "draft" ||
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "stopped" ||
    value === "failed"
  ) {
    return value;
  }
  return "failed";
}

function parseSpec(value: string): SandboxSpec {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (isObject(parsed)) {
      return parsed as SandboxSpec;
    }
  } catch {
    return {};
  }
  return {};
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
