import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  importInstalledThreadVmRestore,
  ThreadVmRestoreInstallError,
} from "../relay/ThreadVmRestoreInstall.ts";
import { ThreadVmRestoreBoot, RelayThreadVmRestoreImportReceipt } from "@t3tools/contracts/relay";
import { ThreadVmProviderAuthControl, RelayThreadVmProviderAuth } from "@t3tools/contracts/relay";
import { THREAD_VM_PROVIDER_AUTH_PATH } from "../relay/ThreadVmProviderAuth.ts";
import { readInstalledThreadVm } from "../relay/ThreadVmEnrollment.ts";
import {
  cleanupThreadVmRestoreIdentity,
  prepareThreadVmRestoreIdentity,
} from "../relay/ThreadVmRestoreIdentity.ts";
import { inspectVmWorkloads } from "../vmWorkload.ts";
import { withVmWorkloads } from "../vmWorkloadCommand.ts";
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Stream from "effect/Stream";
import {
  threadVmGitCredential,
  ThreadVmRepositoryCredentialError,
} from "../relay/ThreadVmRepositoryCredentials.ts";
import { RelayThreadVmEnrollmentReceipt, RelayThreadVmSetupReply } from "@t3tools/contracts/relay";
import * as ConfigProvider from "effect/ConfigProvider";
import { runServer } from "../server.ts";
import {
  requireThreadVmRestoreServerStart,
  requireThreadVmMoveServerStart,
  requireThreadVmServerStart,
} from "../relay/ThreadVmServer.ts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  prepareThreadVmInitialState,
  ThreadVmInitialStateInput,
  ThreadVmInitialStateError,
} from "../relay/ThreadVmInitialState.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as Sqlite from "../persistence/Layers/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  enrollThreadVm,
  ThreadVmEnrollmentError,
  ThreadVmEnrollmentInput,
} from "../relay/ThreadVmEnrollment.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveCliAuthConfig, resolveServerConfig } from "./config.ts";

const encodeSetupReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmSetupReply));
const encodeRestoreReceipt = Schema.encodeEffect(
  Schema.fromJsonString(RelayThreadVmRestoreImportReceipt),
);
const encodeReceipt = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmEnrollmentReceipt));
const encodeProviderAuth = Schema.encodeEffect(Schema.fromJsonString(RelayThreadVmProviderAuth));

/** Fixed loopback bridge; stdin contains identity and action, never credentials or shell commands. */
export const threadVmProviderAuthCommand = Command.make("__thread-vm-provider-auth").pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmProviderAuth.command")(function* () {
      if ((yield* HostProcessPlatform) !== "linux")
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      const input = yield* readBootstrapEnvelope(ThreadVmProviderAuthControl, 0, {
        timeoutMs: 30_000,
      });
      if (Option.isNone(input))
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some("/home/user/.launchpad") },
        Option.some("None"),
      ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})));
      const reply = yield* Effect.gen(function* () {
        const vm = yield* readInstalledThreadVm();
        if (!vm) return yield* new ThreadVmEnrollmentError({ stage: "identity" });
        const client = yield* HttpClient.HttpClient;
        const request = yield* HttpClientRequest.post(
          `http://127.0.0.1:3773${THREAD_VM_PROVIDER_AUTH_PATH}`,
        ).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${vm.environmentCredential}`),
          HttpClientRequest.schemaBodyJson(ThreadVmProviderAuthControl)(input.value),
        );
        return yield* client
          .execute(request)
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayThreadVmProviderAuth)),
            Effect.timeout("30 seconds"),
          );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(ServerSecretStore.layer, FetchHttpClient.layer).pipe(
            Layer.provide(ServerConfig.layer(config)),
          ),
        ),
        Effect.mapError(() => new ThreadVmEnrollmentError({ stage: "request" })),
      );
      yield* Console.log(yield* encodeProviderAuth(reply));
    }),
  ),
);

/** Root-only offline identity rotation, called under the guest enrollment flock. */
export const threadVmRestoreIdentityCommand = Command.make("__thread-vm-restore-identity", {
  baseDir: Flag.String("base-dir"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmRestoreIdentity.command")(function* ({ baseDir }) {
      if (
        (yield* HostProcessPlatform) !== "linux" ||
        process.getuid?.() !== 0 ||
        baseDir !== "/home/user/.launchpad"
      )
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      const input = yield* readBootstrapEnvelope(ThreadVmRestoreBoot, 0, {
        timeoutMs: 30_000,
      }).pipe(Effect.mapError(() => new ThreadVmEnrollmentError({ stage: "configuration" })));
      if (Option.isNone(input))
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      if (!(yield* inspectVmWorkloads({ type: "inspect" })).stopped)
        return yield* new ThreadVmEnrollmentError({ stage: "identity" });
      yield* Effect.tryPromise({
        try: () => prepareThreadVmRestoreIdentity(input.value, baseDir),
        catch: () => new ThreadVmEnrollmentError({ stage: "identity" }),
      });
      yield* Console.log('{"prepared":true}');
    }),
  ),
);

/** Host-authorized cleanup after relay activation; the fresh server may be running. */
export const threadVmRestoreCleanupCommand = Command.make("__thread-vm-restore-cleanup", {
  baseDir: Flag.String("base-dir"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmRestoreCleanup.command")(function* ({ baseDir }) {
      if (
        (yield* HostProcessPlatform) !== "linux" ||
        process.getuid?.() !== 0 ||
        baseDir !== "/home/user/.launchpad"
      )
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      const input = yield* readBootstrapEnvelope(ThreadVmRestoreBoot, 0, { timeoutMs: 30_000 });
      if (Option.isNone(input))
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      yield* Effect.tryPromise({
        try: () => cleanupThreadVmRestoreIdentity(input.value, baseDir),
        catch: () => new ThreadVmEnrollmentError({ stage: "identity" }),
      });
      yield* Console.log('{"cleaned":true}');
    }),
  ),
);

/** Import is offline and serialized with enrollment. No runtime reactors or provider sessions start. */
export const threadVmRestoreImportCommand = Command.make("__thread-vm-restore-import", {
  baseDir: Flag.String("base-dir"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmRestoreImport.command")(function* ({ baseDir }) {
      if (baseDir !== "/home/user/.launchpad") return yield* new ThreadVmRestoreInstallError();
      const input = yield* readBootstrapEnvelope(ThreadVmRestoreBoot, 0, { timeoutMs: 30_000 });
      if (Option.isNone(input)) return yield* new ThreadVmRestoreInstallError();
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        Option.some("Error"),
      );
      const running = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (
        (Option.isSome(running) && isProcessAlive(running.value.pid)) ||
        !(yield* inspectVmWorkloads({ type: "inspect" })).stopped
      )
        return yield* new ThreadVmRestoreInstallError();
      const receipt = yield* importInstalledThreadVmRestore(input.value).pipe(
        Effect.provide(
          Layer.mergeAll(
            OrchestrationLayerLive.pipe(Layer.provide(RepositoryIdentityResolver.layer)),
            ServerSecretStore.layer,
            ServerEnvironment.identityLayer,
            FetchHttpClient.layer,
            ProcessRunner.layer,
          ).pipe(
            Layer.provideMerge(Sqlite.layerConfig),
            Layer.provideMerge(ServerConfig.layer(config)),
          ),
        ),
      );
      yield* Console.log(yield* encodeRestoreReceipt(receipt));
    }),
  ),
);

/** Private control-plane entry point. Secrets arrive over stdin, never argv or process environment. */
export const threadVmEnrollmentCommand = Command.make("__thread-vm-enroll", {
  baseDir: Flag.String("base-dir"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmEnrollment.command")(function* ({ baseDir }) {
      const path = yield* Path.Path;
      if (!path.isAbsolute(baseDir))
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      const input = yield* readBootstrapEnvelope(ThreadVmEnrollmentInput, 0, {
        timeoutMs: 30_000,
      }).pipe(Effect.mapError(() => new ThreadVmEnrollmentError({ stage: "configuration" })));
      if (Option.isNone(input))
        return yield* new ThreadVmEnrollmentError({ stage: "configuration" });
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        Option.some("Error"),
      );
      const running = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
        Effect.mapError(() => new ThreadVmEnrollmentError({ stage: "identity" })),
      );
      if (Option.isSome(running) && isProcessAlive(running.value.pid))
        return yield* new ThreadVmEnrollmentError({ stage: "identity" });
      const enrolled = yield* enrollThreadVm(input.value).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            ServerEnvironment.identityLayer,
            FetchHttpClient.layer,
          ).pipe(Layer.provide(ServerConfig.layer(config))),
        ),
      );
      yield* Console.log(
        yield* encodeReceipt({
          enrolled: true,
          environmentId: enrolled.environmentId,
          allocationId: enrolled.scope.allocationId,
          operationId: enrolled.operationId,
          threadId: enrolled.scope.threadId,
          generation: enrolled.scope.generation,
        }),
      );
    }),
  ),
);

/** Preparing a checkout and baseline leaves execution frozen until relay ownership is committed. */
export const threadVmSetupCommand = Command.make("__thread-vm-setup", {
  baseDir: Flag.String("base-dir"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmSetup.command")(function* ({ baseDir }) {
      const path = yield* Path.Path;
      if (!path.isAbsolute(baseDir))
        return yield* new ThreadVmInitialStateError({ code: "identity_changed" });
      const input = yield* readBootstrapEnvelope(ThreadVmInitialStateInput, 0, {
        timeoutMs: 30_000,
      }).pipe(Effect.mapError(() => new ThreadVmInitialStateError({ code: "identity_changed" })));
      if (Option.isNone(input))
        return yield* new ThreadVmInitialStateError({ code: "identity_changed" });
      const config = yield* resolveCliAuthConfig(
        { baseDir: Option.some(baseDir) },
        Option.some("Error"),
      );
      const running = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isSome(running) && isProcessAlive(running.value.pid))
        return yield* new ThreadVmInitialStateError({ code: "identity_changed" });
      yield* inspectVmWorkloads({ type: "inspect" });
      const reply = yield* prepareThreadVmInitialState(input.value).pipe(
        Effect.map((receipt) => ({ status: "prepared" as const, receipt })),
        Effect.catch((error) => Effect.succeed({ status: "blocked" as const, code: error.code })),
        Effect.provide(
          Layer.mergeAll(
            OrchestrationLayerLive.pipe(Layer.provide(RepositoryIdentityResolver.layer)),
            ServerSecretStore.layer,
            ServerEnvironment.identityLayer,
            FetchHttpClient.layer,
            ProcessRunner.layer,
          ).pipe(Layer.provideMerge(Sqlite.layerConfig), Layer.provide(ServerConfig.layer(config))),
        ),
        withVmWorkloads,
      );
      yield* Console.log(yield* encodeSetupReceipt(reply));
    }),
  ),
);

/** Private VM entry point; the relay invokes it under flock, which also survives lost start replies. */
export const threadVmServeCommand = Command.make("__thread-vm-serve", {
  receiptSha256: Flag.String("receipt-sha256"),
  move: Flag.Boolean("move").pipe(Flag.withDefault(false)),
  restore: Flag.Boolean("restore").pipe(Flag.withDefault(false)),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmServer.command")(function* ({ receiptSha256, move, restore }) {
      if (move && restore) return yield* new ThreadVmRestoreInstallError();
      // Dedicated guests do not inherit desktop bootstrap descriptors, dev origins or public listeners.
      const config = yield* resolveServerConfig(
        {
          mode: Option.some("web"),
          port: Option.some(3773),
          host: Option.some("127.0.0.1"),
          baseDir: Option.some("/home/user/.launchpad"),
          cwd: Option.some("/workspace/project"),
          devUrl: Option.none(),
          noBrowser: Option.some(true),
          bootstrapFd: Option.none(),
          autoBootstrapProjectFromCwd: Option.some(false),
          logWebSocketEvents: Option.some(false),
          tailscaleServeEnabled: Option.some(false),
          tailscaleServePort: Option.none(),
        },
        Option.some("Info"),
      ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})));
      yield* (
        restore
          ? requireThreadVmRestoreServerStart(receiptSha256)
          : move
            ? requireThreadVmMoveServerStart(receiptSha256)
            : requireThreadVmServerStart(receiptSha256)
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSecretStore.layer,
            ServerEnvironment.identityLayer,
            Sqlite.layerConfig,
          ).pipe(Layer.provide(ServerConfig.layer(config))),
        ),
        Effect.scoped,
      );
      yield* inspectVmWorkloads({ type: "inspect" });
      return yield* runServer.pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        withVmWorkloads,
      );
    }),
  ),
);

/** Git calls this only for an HTTP credential exchange; stdout is exclusively its line protocol. */
export const threadVmGitCredentialCommand = Command.make("__thread-vm-git-credential", {
  action: Argument.String("action"),
}).pipe(
  Command.unlisted,
  Command.withHandler(
    Effect.fn("ThreadVmGitCredential.command")(function* ({ action }) {
      const reply = yield* Effect.gen(function* () {
        const request = yield* NodeStream.fromReadable({
          evaluate: () => process.stdin,
          onError: () => new ThreadVmRepositoryCredentialError(),
          chunkSize: 1024,
        }).pipe(
          Stream.decodeText(),
          Stream.runFoldEffect(
            () => "",
            (text, chunk) =>
              text.length + chunk.length > 16384
                ? Effect.fail(new ThreadVmRepositoryCredentialError())
                : Effect.succeed(text + chunk),
          ),
          Effect.timeout("10 seconds"),
        );
        const config = yield* resolveCliAuthConfig(
          { baseDir: Option.some("/home/user/.launchpad") },
          Option.some("None"),
        ).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
        );
        return yield* threadVmGitCredential(action, request).pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSecretStore.layer,
              ServerEnvironment.identityLayer,
              FetchHttpClient.layer,
            ).pipe(Layer.provide(ServerConfig.layer(config))),
          ),
        );
      }).pipe(Effect.catch(() => Effect.succeed("quit=1\n\n")));
      if (reply === "quit=1\n\n")
        yield* Console.error(
          "Launchpad could not authorize this VM's repository. Check the organization's GitHub connection, repository access, and VM connection, then retry.",
        );
      yield* Console.log(reply);
    }),
  ),
);
