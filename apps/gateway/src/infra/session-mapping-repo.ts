import type {
  SessionMappingKey,
  SessionMappingRepository,
} from "@agent-relay/domain";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

/** Prisma-backed mapping from gateway session keys to protocol session IDs. */
@injectable()
export class SessionMappingStateRepository
  implements SessionMappingRepository
{
  async get(key: SessionMappingKey): Promise<string | null> {
    const row = await prisma.sessionMapping.findUnique({
      where: {
        agentId_protocol_sessionKey: {
          agentId: key.agentId,
          protocol: key.protocol,
          sessionKey: key.sessionKey,
        },
      },
    });
    return row?.protocolSessionId ?? null;
  }

  async set(
    key: SessionMappingKey,
    protocolSessionId: string,
  ): Promise<void> {
    await prisma.sessionMapping.upsert({
      where: {
        agentId_protocol_sessionKey: {
          agentId: key.agentId,
          protocol: key.protocol,
          sessionKey: key.sessionKey,
        },
      },
      create: {
        agentId: key.agentId,
        protocol: key.protocol,
        sessionKey: key.sessionKey,
        protocolSessionId,
      },
      update: { protocolSessionId },
    });
  }
}
