import type {
  CreateChannelBindingData,
  UpdateChannelBindingData,
} from "../../application/channel-binding-service.js";
import type {
  RegisterAgentData,
  UpdateAgentData,
} from "../../application/agent-service.js";
import type {
  CreateScheduledJobData,
  UpdateScheduledJobData,
} from "@agent-relay/domain";
import { isValidAgentName } from "@agent-relay/domain";
import { z } from "../utils/schema.js";

const nonEmptyString = z.string().min(1);
const agentNameSchema = nonEmptyString.refine(isValidAgentName, {
  message:
    "Agent name must be a folder-safe name using only letters, numbers, dots, underscores, and hyphens",
});
const agentProtocolSchema = z.enum(["a2a", "acp"]);
const a2aContextIdStrategySchema = z.enum([
  "client-provided",
  "server-assigned",
]);
const sessionIsolationStrategySchema = z.enum([
  "request",
  "sessionKey",
  "accountId",
]);
const acpPermissionSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);
const a2aAgentConfigSchema = z.object({
  url: nonEmptyString,
  contextIdStrategy: a2aContextIdStrategySchema.default("client-provided"),
}).strict();
const acpStdioAgentConfigSchema = z.object({
  transport: z.literal("stdio"),
  command: nonEmptyString,
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  permission: acpPermissionSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
const agentConfigSchema = z.union([
  acpStdioAgentConfigSchema,
  a2aAgentConfigSchema,
]);

function validateAgentProtocolConfig(
  data: { protocol?: "a2a" | "acp"; config?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (!data.protocol || !data.config || typeof data.config !== "object") {
    return;
  }

  const config = data.config as { transport?: unknown };
  if (data.protocol === "a2a" && config.transport !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["config"],
      message: "A2A agent config must contain only protocol-specific URL fields",
    });
  }
  if (data.protocol === "acp" && config.transport === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["config"],
      message: "ACP agent config requires transport",
    });
  }
}

/**
 * HTTP request schemas are owned by the transport layer.
 *
 * They describe the public JSON contract and can apply API-specific defaults
 * without coupling the application layer to a validation library.
 */
export const createChannelBindingBodySchema: z.ZodType<CreateChannelBindingData> =
  z.object({
    name: nonEmptyString,
    channelType: z.string().default("feishu"),
    accountId: z.string().optional(),
    channelConfig: z.record(z.string(), z.unknown()),
    agentId: nonEmptyString,
    sessionIsolationStrategy:
      sessionIsolationStrategySchema.default("sessionKey"),
    enabled: z.boolean().default(true),
  });

export const updateChannelBindingBodySchema: z.ZodType<UpdateChannelBindingData> =
  z.object({
    name: z.string().optional(),
    channelType: z.string().optional(),
    accountId: z.string().optional(),
    channelConfig: z.record(z.string(), z.unknown()).optional(),
    agentId: z.string().optional(),
    sessionIsolationStrategy: sessionIsolationStrategySchema.optional(),
    enabled: z.boolean().optional(),
  });

export const startChannelQrLoginBodySchema = z.object({
  accountId: z.string().optional(),
  force: z.boolean().optional(),
});

export const waitForChannelQrLoginBodySchema = z.object({
  accountId: z.string().optional(),
  sessionKey: z.string().optional(),
  timeoutMs: z.number().int().positive().max(480_000).optional(),
});

export const registerAgentBodySchema: z.ZodType<RegisterAgentData> = z
  .object({
    name: agentNameSchema,
    protocol: agentProtocolSchema.default("a2a"),
    config: agentConfigSchema,
    description: z.string().optional(),
  })
  .superRefine(validateAgentProtocolConfig);

export const updateAgentBodySchema: z.ZodType<UpdateAgentData> = z
  .object({
    name: agentNameSchema.optional(),
    protocol: agentProtocolSchema.optional(),
    config: agentConfigSchema.optional(),
    description: z.string().optional(),
  })
  .superRefine(validateAgentProtocolConfig);

export const createScheduledJobBodySchema: z.ZodType<CreateScheduledJobData> =
  z.object({
    name: nonEmptyString,
    channelBindingId: nonEmptyString,
    sessionKey: nonEmptyString,
    prompt: nonEmptyString,
    cronExpression: nonEmptyString,
    enabled: z.boolean().default(true),
  });

export const updateScheduledJobBodySchema: z.ZodType<UpdateScheduledJobData> =
  z.object({
    name: z.string().optional(),
    channelBindingId: z.string().optional(),
    sessionKey: z.string().optional(),
    prompt: z.string().optional(),
    cronExpression: z.string().optional(),
    enabled: z.boolean().optional(),
  });
