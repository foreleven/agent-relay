import "reflect-metadata";

import { Container } from "inversify";
import { fileURLToPath } from "node:url";
import {
  A2ATransport,
  ACPTransport,
  AgentTransportFactory,
  WsTunnelTransportFactory,
  WsTunnelConnectionSource,
} from "@agent-relay/agent-transport";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@agent-relay/openclaw-compat";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
  ChannelMessageRepository,
  SandboxRepository,
  SessionMappingRepository,
} from "@agent-relay/domain";
import { AgentService } from "../application/agent-service.js";
import { AccountIdGenerator } from "../application/account-id-generator.js";
import { AccountService } from "../application/account-service.js";
import { ChannelAuthService } from "../application/channel-auth-service.js";
import { ChannelMessageService } from "../application/channel-message-service.js";
import {
  ScheduledJobService,
  type ScheduledJobService as ScheduledJobServicePort,
} from "../application/scheduled-job-service.js";
import {
  ChannelQrLoginProviderToken,
  FeishuQrLoginProvider,
  PluginQrLoginProvider,
  WechatQrLoginProvider,
} from "../application/channel-qr-login-provider.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { RuntimeStatusService } from "../application/runtime-status-service.js";
import { SandboxService } from "../application/sandbox-service.js";
import { GatewayServer } from "./gateway-server.js";
import { GatewayApp, GatewayWebDir, HonoGatewayApp } from "../http/app.js";
import { AgentRoutes } from "../http/routes/agents.js";
import { AccountRoutes } from "../http/routes/accounts.js";
import { ChannelRoutes } from "../http/routes/channels.js";
import { MessageRoutes } from "../http/routes/messages.js";
import { RuntimeStatusRoutes } from "../http/routes/runtime-status.js";
import { ScheduledJobRoutes } from "../http/routes/scheduled-jobs.js";
import { SandboxRoutes } from "../http/routes/sandboxes.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { AccountStateRepository } from "../infra/account-repo.js";
import { AccountCredentialsStateRepository } from "../infra/account-credentials-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { ChannelMessageStateRepository } from "../infra/channel-message-repo.js";
import { SessionMappingStateRepository } from "../infra/session-mapping-repo.js";
import { BunQueueScheduledJobService } from "../infra/bunqueue-scheduled-job-service.js";
import {
  createGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../infra/logger.js";
import { RedisClientService } from "../infra/redis-client.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { SandboxStateRepository } from "../infra/sandbox-repo.js";
import { PluginRegistrationService } from "../register-plugins.js";
import { AgentClientRegistry } from "../runtime/agent-client-registry.js";
import { AgentClientFactory } from "../runtime/agent-clients.js";
import { RuntimeScheduler } from "../runtime/scheduler.js";
import { ConnectionManager } from "../runtime/connection/index.js";
import { LeaderScheduler } from "../runtime/cluster/leader-scheduler.js";
import { RedisOwnershipGate } from "../runtime/cluster/redis-ownership-gate.js";
import { RedisRuntimeEventBus } from "../runtime/cluster/redis-runtime-event-bus.js";
import { LocalOwnershipGate } from "../runtime/local/local-ownership-gate.js";
import { LocalScheduler } from "../runtime/local/local-scheduler.js";
import { RuntimeOwnershipState } from "../runtime/ownership-state.js";
import { RuntimeOwnershipGate } from "../runtime/ownership-gate.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";
import { RuntimeAgentChangeSubscriber } from "../runtime/runtime-agent-change-subscriber.js";
import { RuntimeAgentRegistry } from "../runtime/runtime-agent-registry.js";
import { RuntimeAssignmentCoordinator } from "../runtime/runtime-assignment-coordinator.js";
import { RuntimeCommandHandler } from "../runtime/runtime-command-handler.js";
import {
  LocalRuntimeEventBus,
  RuntimeEventBus,
} from "../runtime/event-transport/index.js";
import { RuntimeAssignmentService } from "../runtime/runtime-assignment-service.js";
import { RuntimeOpenClawConfigProjection } from "../runtime/runtime-openclaw-config-projection.js";
import { BunQueueScheduledJobWorkerService } from "../runtime/cron/bunqueue-scheduled-job-service.js";
import { ScheduledJobExecutor } from "../runtime/cron/scheduled-job-executor.js";
import { WsTunnelConnectionRegistry } from "../runtime/ws-tunnel-registry.js";
import { WsTunnelRouteHandler } from "../runtime/ws-tunnel-route-handler.js";
import { AioSandboxProvider } from "../runtime/sandbox/aio-sandbox-provider.js";
import {
  SandboxProvider,
  type SandboxProvider as SandboxProviderPort,
} from "../runtime/sandbox/provider.js";
import { SandboxRuntimeManager } from "../runtime/sandbox/sandbox-runtime-manager.js";
import type { GatewayConfigSnapshot } from "./config.js";
import {
  buildGatewayConfig,
  GatewayConfigOverrides,
  GatewayConfigService,
} from "./config.js";
import {
  type ServiceContribution,
  ServiceContributionToken,
} from "./service-contribution.js";

const DEFAULT_GATEWAY_WEB_DIR = fileURLToPath(
  new URL("../../web", import.meta.url),
);

/**
 * Builds the process-wide DI container.
 *
 * Module order documents the intended dependency direction:
 * infrastructure -> application -> runtime -> HTTP -> bootstrap surface.
 *
 * Inversify resolves lazily, so this order is not a hard runtime requirement,
 * but keeping it explicit makes composition easier to audit.
 */
export function buildGatewayContainer(
  overrides: Partial<GatewayConfigSnapshot> = {},
): Container {
  const config = buildGatewayConfig(overrides);

  const container = createGatewayContainer();
  container.bind(GatewayConfigOverrides).toConstantValue(config);
  container.bind(GatewayConfigService).toSelf().inSingletonScope();
  bindInfrastructure(container, config);
  bindApplication(container);
  bindRuntime(container, config);
  bindHttp(container);
  bindBootstrap(container);
  return container;
}

/**
 * Creates an empty gateway DI container with the project-wide Inversify
 * options. Keep direct Container construction here so alternate composition
 * paths and focused tests do not drift from production defaults.
 */
export function createGatewayContainer(): Container {
  return new Container({ defaultScope: "Singleton" });
}

function bindInfrastructure(
  container: Container,
  config: GatewayConfigSnapshot,
): void {
  // Infrastructure adapters are the only concrete implementations of domain
  // repository ports. Application services consume the ports below, not Prisma.
  container
    .bind<GatewayLoggerPort>(GatewayLogger)
    .toDynamicValue(() => createGatewayLogger())
    .inSingletonScope();
  container.bind(AccountStateRepository).toSelf().inSingletonScope();
  container.bind(AccountCredentialsStateRepository).toSelf().inSingletonScope();
  container.bind(AgentConfigStateRepository).toSelf().inSingletonScope();
  container.bind(ChannelBindingStateRepository).toSelf().inSingletonScope();
  container.bind(ChannelMessageStateRepository).toSelf().inSingletonScope();
  container.bind(SessionMappingStateRepository).toSelf().inSingletonScope();
  container.bind(BunQueueScheduledJobService).toSelf().inSingletonScope();
  container.bind(RuntimeNodeStateRepository).toSelf().inSingletonScope();
  container.bind(SandboxStateRepository).toSelf().inSingletonScope();

  if (config.clusterMode) {
    container.bind(RedisClientService).toSelf().inSingletonScope();
    container.bind(RedisRuntimeEventBus).toSelf().inSingletonScope();
    container
      .bind<ServiceContribution>(ServiceContributionToken)
      .toService(RedisClientService);
    container
      .bind<ServiceContribution>(ServiceContributionToken)
      .toService(RedisRuntimeEventBus);
  }
}

function bindApplication(container: Container): void {
  container
    .bind(ChannelBindingRepository)
    .toService(ChannelBindingStateRepository);
  container.bind(AgentConfigRepository).toService(AgentConfigStateRepository);
  container
    .bind(ChannelMessageRepository)
    .toService(ChannelMessageStateRepository);
  container
    .bind(SessionMappingRepository)
    .toService(SessionMappingStateRepository);
  container.bind(SandboxRepository).toService(SandboxStateRepository);
  container
    .bind<ScheduledJobServicePort>(ScheduledJobService)
    .toService(BunQueueScheduledJobService);
  container.bind(AccountService).toSelf().inSingletonScope();
  container.bind(ChannelBindingService).toSelf().inSingletonScope();
  container.bind(ChannelMessageService).toSelf().inSingletonScope();
  container.bind(ChannelAuthService).toSelf().inSingletonScope();
  container.bind(AccountIdGenerator).toSelf().inSingletonScope();
  container
    .bind(ChannelQrLoginProviderToken)
    .to(FeishuQrLoginProvider)
    .inSingletonScope();
  container
    .bind(ChannelQrLoginProviderToken)
    .to(WechatQrLoginProvider)
    .inSingletonScope();
  container
    .bind(ChannelQrLoginProviderToken)
    .to(PluginQrLoginProvider)
    .inSingletonScope();
  container.bind(AgentService).toSelf().inSingletonScope();
  container.bind(RuntimeStatusService).toSelf().inSingletonScope();
  container.bind(SandboxService).toSelf().inSingletonScope();
}

function bindRuntime(
  container: Container,
  config: GatewayConfigSnapshot,
): void {
  // Runtime services are split by responsibility:
  // - Scheduler/Coordinator decide what this node should own.
  // - CommandHandler reloads one binding and delegates local side effects.
  // - AssignmentService mutates the local runtime aggregate.
  // - ConnectionManager performs the imperative plugin/transport work.

  container.bind(ConnectionManager).toSelf().inSingletonScope();

  container
    .bind<AgentTransportFactory>(AgentTransportFactory)
    .toDynamicValue(() => new A2ATransport())
    .inSingletonScope();
  container
    .bind<AgentTransportFactory>(AgentTransportFactory)
    .toDynamicValue(() => new ACPTransport())
    .inSingletonScope();

  // ws-tunnel transport: the registry holds live WS connections from relay CLI
  // instances; the factory resolves them at request time.
  container
    .bind(WsTunnelConnectionRegistry)
    .toSelf()
    .inSingletonScope();
  container
    .bind(WsTunnelConnectionSource)
    .toService(WsTunnelConnectionRegistry);
  // Register as a ServiceContribution so GatewayServer calls stop() on shutdown,
  // cleanly closing all active WS connections and rejecting pending requests.
  container
    .bind<ServiceContribution>(ServiceContributionToken)
    .toDynamicValue(() => container.get(WsTunnelConnectionRegistry))
    .inSingletonScope();
  container
    .bind<AgentTransportFactory>(AgentTransportFactory)
    .toDynamicValue(() =>
      new WsTunnelTransportFactory(container.get(WsTunnelConnectionRegistry)),
    )
    .inSingletonScope();

  container.bind(WsTunnelRouteHandler).toSelf().inSingletonScope();
  container.bind(AioSandboxProvider).toSelf().inSingletonScope();
  container
    .bind<SandboxProviderPort>(SandboxProvider)
    .toService(AioSandboxProvider);
  container.bind(SandboxRuntimeManager).toSelf().inSingletonScope();
  container.bind(AgentClientFactory).toSelf().inSingletonScope();

  container.bind(AgentClientRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeAgentRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeOpenClawConfigProjection).toSelf().inSingletonScope();
  container
    .bind(OpenClawPluginRuntime)
    .toDynamicValue(
      () =>
        new OpenClawPluginRuntime({
          config: {
            loadConfig: () =>
              container.get(RuntimeOpenClawConfigProjection).getConfig(),
            writeConfigFile: async () => {
              throw new Error("Not implemented");
            },
          },
        }),
    )
    .inSingletonScope();
  container
    .bind(OpenClawPluginHost)
    .toDynamicValue(() => {
      return new OpenClawPluginHost(
        container.get(OpenClawPluginRuntime),
        container
          .get<GatewayLoggerPort>(GatewayLogger)
          .child({ component: "openclaw-host" }),
      );
    })
    .inSingletonScope();
  container.bind(PluginRegistrationService).toSelf().inSingletonScope();
  container
    .bind<ServiceContribution>(ServiceContributionToken)
    .toService(PluginRegistrationService);

  container.bind(RuntimeOwnershipState).toSelf().inSingletonScope();

  container.bind(RuntimeAssignmentService).toSelf().inSingletonScope();
  container.bind(RelayRuntime).toSelf().inSingletonScope();
  container.bind(RuntimeAgentChangeSubscriber).toSelf().inSingletonScope();
  container
    .bind<ServiceContribution>(ServiceContributionToken)
    .toService(RuntimeAgentChangeSubscriber);

  container.bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
  container.bind(RuntimeCommandHandler).toSelf().inSingletonScope();
  container.bind(ScheduledJobExecutor).toSelf().inSingletonScope();
  container.bind(BunQueueScheduledJobWorkerService).toSelf().inSingletonScope();
  container
    .bind<ServiceContribution>(ServiceContributionToken)
    .toService(BunQueueScheduledJobWorkerService);

  if (config.clusterMode) {
    bindClusterRuntime(container);
  } else {
    bindLocalRuntime(container);
  }
}

function bindLocalRuntime(container: Container): void {
  container
    .bind(RuntimeOwnershipGate)
    .to(LocalOwnershipGate)
    .inSingletonScope();
  container.bind(RuntimeEventBus).to(LocalRuntimeEventBus).inSingletonScope();

  container.bind(LocalScheduler).toSelf().inSingletonScope();
  container.bind(RuntimeScheduler).toService(LocalScheduler);
}

function bindClusterRuntime(container: Container): void {
  container
    .bind(RuntimeOwnershipGate)
    .to(RedisOwnershipGate)
    .inSingletonScope();
  // RedisRuntimeEventBus is already bound in bindInfrastructure (cluster path).
  container.bind(RuntimeEventBus).toService(RedisRuntimeEventBus);

  container.bind(LeaderScheduler).toSelf().inSingletonScope();
  container.bind(RuntimeScheduler).toService(LeaderScheduler);
}

function bindHttp(container: Container): void {
  // HTTP routes depend on application query boundaries. They must not
  // reach into RelayRuntime or ConnectionManager directly.
  container.bind(GatewayWebDir).toConstantValue(DEFAULT_GATEWAY_WEB_DIR);
  container.bind(AccountRoutes).toSelf().inSingletonScope();
  container.bind(ChannelRoutes).toSelf().inSingletonScope();
  container.bind(AgentRoutes).toSelf().inSingletonScope();
  container.bind(MessageRoutes).toSelf().inSingletonScope();
  container.bind(RuntimeStatusRoutes).toSelf().inSingletonScope();
  container.bind(ScheduledJobRoutes).toSelf().inSingletonScope();
  container.bind(SandboxRoutes).toSelf().inSingletonScope();
  container.bind(HonoGatewayApp).toSelf().inSingletonScope();
  container.bind(GatewayApp).toService(HonoGatewayApp);
}

function bindBootstrap(container: Container): void {
  container.bind(GatewayServer).toSelf().inSingletonScope();
}
