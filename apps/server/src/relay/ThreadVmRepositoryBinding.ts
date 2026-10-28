import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayRepositoryCanonicalKey,
  RelayThreadVmCredentialScope,
  type RelayThreadVmGitMetadata,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeThreadExecutionFence } from "../persistence/ThreadExecutionFence.ts";
import { make as makeCheckoutAccess } from "../workspace/CheckoutAccess.ts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import { readThreadVmInitialState } from "./ThreadVmInitialStateRecord.ts";
import { makeThreadCheckoutClaims } from "./ThreadCheckoutClaim.ts";
import type { ThreadMoveOwner } from "./ThreadMoveTransport.ts";
import { workspaceFailure } from "./ThreadWorkspaceFiles.ts";
import { workspaceGitText } from "./ThreadWorkspaceGit.ts";
import {
  prepareThreadVmGitConfig,
  publishThreadVmGitConfig,
  threadVmGitConfigHash,
} from "./ThreadVmGitConfig.ts";

export const THREAD_VM_REPOSITORY_BINDING_SECRET = "thread-vm-repository-binding";
export const THREAD_VM_GIT_SETUP_SECRET = "thread-vm-git-setup";
const Binding = Schema.Struct({
  operationId: Schema.NonEmptyString,
  environmentId: EnvironmentId,
  scope: RelayThreadVmCredentialScope,
  canonicalKey: RelayRepositoryCanonicalKey,
});
const Setup = Schema.Struct({
  version: Schema.Literal(2),
  binding: Binding,
  root: Schema.String,
  configPath: Schema.String,
  headPath: Schema.String,
  head: Schema.String,
  configHash: Schema.String,
  metadataKey: Schema.String,
});
const decode = Schema.decodeEffect(Schema.fromJsonString(Binding)),
  encode = Schema.encodeSync(Schema.fromJsonString(Binding)),
  decodeSetup = Schema.decodeUnknownOption(Schema.fromJsonString(Setup)),
  encodeSetup = Schema.encodeSync(Schema.fromJsonString(Setup)),
  encodeMetadata = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const readThreadVmRepositoryBinding = Effect.fn("ThreadVmRepositoryBinding.read")(
  function* () {
    const raw = yield* (yield* ServerSecretStore).get(THREAD_VM_REPOSITORY_BINDING_SECRET);
    return Option.isSome(raw) ? yield* decode(new TextDecoder().decode(raw.value)) : null;
  },
);

/** Configure imports and repair active guests without changing checkout contents or branches. */
export const configureThreadVmRepository = Effect.fn("ThreadVmRepositoryBinding.configure")(
  function* (owner: ThreadMoveOwner, root: string, mode: "import" | "active" = "import") {
    const vm = yield* readInstalledThreadVm();
    // Active ownership can advance after pause or cancellation; enrollment and its binding stay fixed.
    if (
      !vm ||
      (mode === "import" && vm.operationId !== owner.operationId) ||
      vm.scope.threadId !== owner.threadId ||
      vm.scope.generation !== owner.generation ||
      vm.environmentId !== owner.environmentId ||
      vm.relayUrl !== owner.relayUrl ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId)
    )
      return yield* workspaceFailure("The repository binding does not match this VM.");
    const fs = yield* FileSystem.FileSystem,
      sql = yield* SqlClient.SqlClient,
      secrets = yield* ServerSecretStore,
      fences = makeThreadExecutionFence(sql),
      claims = makeThreadCheckoutClaims(sql);
    let preparedCommonDirectory: string | null = null,
      projectId: string | null = null;
    const assertOwner = Effect.gen(function* () {
      const installed = yield* readInstalledThreadVm();
      if (
        !installed ||
        installed.operationId !== vm.operationId ||
        installed.environmentId !== vm.environmentId ||
        installed.relayUrl !== vm.relayUrl ||
        installed.scope.allocationId !== vm.scope.allocationId ||
        installed.scope.threadId !== vm.scope.threadId ||
        installed.scope.repositoryId !== vm.scope.repositoryId ||
        installed.scope.generation !== vm.scope.generation
      )
        return yield* workspaceFailure("The installed VM identity changed during Git setup.");
      const current = yield* fences.get(owner.threadId);
      if (
        !current ||
        current.phase !== (mode === "active" ? "active" : "frozen") ||
        current.operationId !== owner.operationId ||
        current.environmentId !== owner.environmentId ||
        current.generation !== owner.generation ||
        current.relayUrl !== owner.relayUrl
      )
        return yield* workspaceFailure("The VM repository setup no longer owns this checkout.");
      projectId = current.projectId;
      const [project] = yield* sql<{
        root: string;
        repositoryRoot: string;
      }>`SELECT COALESCE(t.worktree_path,p.workspace_root) AS root, p.workspace_root AS "repositoryRoot"
        FROM projection_threads t JOIN projection_projects p ON p.project_id=t.project_id
        WHERE t.thread_id=${owner.threadId} AND t.project_id=${current.projectId}
          AND t.deleted_at IS NULL AND p.deleted_at IS NULL`;
      if (project?.root !== root || (yield* fs.realPath(root)) !== root)
        return yield* workspaceFailure("The VM repository checkout changed.");
      if (
        preparedCommonDirectory !== null &&
        (yield* fs.realPath(`${project.repositoryRoot}/.git`)) !== preparedCommonDirectory
      )
        return yield* workspaceFailure("The VM repository Git directory changed.");
      if (mode === "import") {
        const claim = yield* claims.get(owner.operationId);
        if (
          !claim ||
          claim.phase !== "installed" ||
          claim.threadId !== owner.threadId ||
          claim.generation !== owner.generation ||
          claim.projectId !== current.projectId ||
          claim.repositoryRoot !== project.repositoryRoot ||
          claim.checkoutPath !== root
        )
          return yield* workspaceFailure(
            "Git setup requires this import's installed frozen checkout.",
          );
        const busy =
          yield* sql`SELECT 1 FROM thread_execution_work WHERE thread_id=${owner.threadId} AND completed=0
          UNION ALL SELECT 1 FROM provider_session_runtime WHERE thread_id=${owner.threadId} AND status NOT IN ('stopped','error')
          UNION ALL SELECT 1 FROM checkout_operations LIMIT 1`;
        if (busy.length)
          return yield* workspaceFailure("Wait for checkout work to stop before Git setup.");
      }
    });
    yield* assertOwner;
    const url = normalizeSecureRelayUrl(vm.relayUrl),
      issuer = normalizeSecureRelayUrl(vm.relayIssuer);
    if (!url || !issuer) return yield* workspaceFailure("The VM relay configuration is invalid.");
    const prior = yield* readThreadVmRepositoryBinding();
    const client = yield* makeExecutorRelayApiClient({
      url,
      issuer,
      environmentCredential: vm.environmentCredential,
    });
    // Bot metadata is optional. Offline repair can use an already verified binding and cached author.
    const remote = yield* client.threadEnvironment
      .repositoryBinding({
        params: { environmentId: vm.environmentId, threadId: vm.scope.threadId },
        payload: { generation: vm.scope.generation },
      })
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.orElseSucceed(() => null),
      );
    if (
      remote &&
      (remote.operationId !== vm.operationId ||
        remote.repositoryId !== vm.scope.repositoryId ||
        remote.threadId !== vm.scope.threadId ||
        remote.environmentId !== vm.environmentId ||
        remote.generation !== vm.scope.generation ||
        !/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/u.test(remote.canonicalKey))
    )
      return yield* workspaceFailure("The relay did not confirm this VM repository.");
    let canonicalKey = remote?.canonicalKey ?? prior?.canonicalKey;
    if (!canonicalKey && vm.scope.generation === 1 && mode === "active") {
      const initial = yield* readThreadVmInitialState(),
        workspace = initial?.input.workspace;
      if (
        initial?.receipt &&
        workspace?.operationId === vm.operationId &&
        workspace.scope.allocationId === vm.scope.allocationId &&
        workspace.scope.threadId === vm.scope.threadId &&
        workspace.scope.repositoryId === vm.scope.repositoryId &&
        workspace.scope.generation === 1 &&
        initial.workspaceRoot === root &&
        initial.receipt.environmentId === vm.environmentId &&
        initial.receipt.operationId === vm.operationId &&
        initial.receipt.projectId === projectId &&
        initial.receipt.workspaceRoot === root &&
        initial.receipt.scope.allocationId === vm.scope.allocationId &&
        initial.receipt.scope.threadId === vm.scope.threadId &&
        initial.receipt.scope.repositoryId === vm.scope.repositoryId &&
        initial.receipt.scope.generation === 1
      )
        canonicalKey = workspace.canonicalKey;
    }
    if (!canonicalKey || !/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/u.test(canonicalKey))
      return yield* workspaceFailure("The VM is waiting for its repository binding.");
    const record = {
      operationId: vm.operationId,
      environmentId: vm.environmentId,
      scope: vm.scope,
      canonicalKey,
    };
    if (prior && encode(prior) !== encode(record))
      return yield* workspaceFailure("The installed repository binding changed.");
    if (!prior)
      yield* secrets.create(
        THREAD_VM_REPOSITORY_BINDING_SECRET,
        new TextEncoder().encode(encode(record)),
      );
    const metadata: RelayThreadVmGitMetadata | undefined = remote?.git,
      metadataKey = encodeMetadata(metadata ?? null),
      rawSetup = yield* secrets.get(THREAD_VM_GIT_SETUP_SECRET),
      setup = Option.isSome(rawSetup)
        ? decodeSetup(new TextDecoder().decode(rawSetup.value))
        : Option.none();
    if (Option.isSome(setup)) {
      const saved = setup.value;
      const gitPaths = (yield* workspaceGitText(root, [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--absolute-git-dir",
      ])).split("\n");
      const currentConfig = yield* fs.readFileString(`${gitPaths[0]}/config`);
      if (
        encode(saved.binding) === encode(record) &&
        saved.root === root &&
        saved.metadataKey === metadataKey &&
        !/\[\s*include(?:if)?(?:[\s"\]])/iu.test(currentConfig) &&
        saved.configPath === `${gitPaths[0]}/config` &&
        saved.headPath === `${gitPaths[1]}/HEAD` &&
        (yield* fs.realPath(saved.configPath)) === saved.configPath &&
        (yield* fs.readFileString(saved.headPath)) === saved.head &&
        threadVmGitConfigHash(currentConfig) === saved.configHash
      ) {
        preparedCommonDirectory = gitPaths[0]!;
        yield* assertOwner;
        return { metadataPending: metadata?.status !== "ready" };
      }
    }
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const config = yield* prepareThreadVmGitConfig(root, canonicalKey, metadata),
          access = mode === "active" ? yield* makeCheckoutAccess : null,
          receipt = encodeSetup({
            version: 2,
            binding: record,
            root,
            configPath: config.configPath,
            headPath: `${config.gitDirectory}/HEAD`,
            head: config.head,
            configHash: config.configHash,
            metadataKey,
          });
        preparedCommonDirectory = config.commonDirectory;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* assertOwner;
            // No network or subprocess is allowed after this admission. SQLite rolls back a failed repair.
            const admission = access ? yield* access.begin({ paths: [root], kind: "vcs" }) : null;
            yield* publishThreadVmGitConfig(config);
            if (admission) yield* access!.complete(admission);
            yield* secrets.set(THREAD_VM_GIT_SETUP_SECRET, new TextEncoder().encode(receipt));
          }),
        );
        return { metadataPending: config.metadataPending };
      }),
    );
  },
  Effect.mapError((error) =>
    workspaceFailure(
      error._tag === "ThreadWorkspaceTransferError"
        ? error.message
        : "The VM is waiting for its Git repository setup. Retry after checking the repository and connection.",
    ),
  ),
);

/** Existing move call sites use the exact frozen-import path. */
export const configureThreadVmMoveRepository = configureThreadVmRepository;
