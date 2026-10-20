import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayRepositoryCanonicalKey,
  RelayThreadVmCredentialScope,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { ProcessRunner } from "../processRunner.ts";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";
import type { ThreadMoveOwner } from "./ThreadMoveTransport.ts";
import { workspaceFailure } from "./ThreadWorkspaceFiles.ts";

export const THREAD_VM_REPOSITORY_BINDING_SECRET = "thread-vm-repository-binding";
const Binding = Schema.Struct({
  operationId: Schema.NonEmptyString,
  environmentId: EnvironmentId,
  scope: RelayThreadVmCredentialScope,
  canonicalKey: RelayRepositoryCanonicalKey,
});
const decode = Schema.decodeEffect(Schema.fromJsonString(Binding)),
  encode = Schema.encodeEffect(Schema.fromJsonString(Binding));
export const readThreadVmRepositoryBinding = Effect.fn("ThreadVmRepositoryBinding.read")(
  function* () {
    const raw = yield* (yield* ServerSecretStore).get(THREAD_VM_REPOSITORY_BINDING_SECRET);
    return Option.isSome(raw) ? yield* decode(new TextDecoder().decode(raw.value)) : null;
  },
);

/** Resolve the assigned Git repository before setup; never copy a source host's credential-bearing origin. */
export const configureThreadVmMoveRepository = Effect.fn("ThreadVmRepositoryBinding.configure")(
  function* (owner: ThreadMoveOwner, root: string) {
    const vm = yield* readInstalledThreadVm();
    if (
      !vm ||
      vm.scope.generation <= 1 ||
      vm.operationId !== owner.operationId ||
      vm.scope.threadId !== owner.threadId ||
      vm.scope.generation !== owner.generation ||
      vm.environmentId !== owner.environmentId ||
      vm.relayUrl !== owner.relayUrl ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId)
    )
      return yield* workspaceFailure("The repository binding does not match this VM move.");
    const fs = yield* FileSystem.FileSystem;
    if ((yield* fs.realPath(root)) !== root)
      return yield* workspaceFailure("The moved repository path changed.");
    const url = normalizeSecureRelayUrl(vm.relayUrl),
      issuer = normalizeSecureRelayUrl(vm.relayIssuer);
    if (!url || !issuer) return yield* workspaceFailure("The VM relay configuration is invalid.");
    const client = yield* makeExecutorRelayApiClient({
      url,
      issuer,
      environmentCredential: vm.environmentCredential,
    });
    const remote = yield* client.threadEnvironment.repositoryBinding({
      params: { environmentId: vm.environmentId, threadId: vm.scope.threadId },
      payload: { generation: vm.scope.generation },
    });
    if (
      remote.operationId !== vm.operationId ||
      remote.repositoryId !== vm.scope.repositoryId ||
      remote.threadId !== vm.scope.threadId ||
      remote.environmentId !== vm.environmentId ||
      remote.generation !== vm.scope.generation ||
      !/^github\.com\/[a-z0-9-]+\/[a-z0-9_.-]+$/u.test(remote.canonicalKey)
    )
      return yield* workspaceFailure("The relay did not confirm the moved repository.");
    const record = {
      operationId: vm.operationId,
      environmentId: vm.environmentId,
      scope: vm.scope,
      canonicalKey: remote.canonicalKey,
    };
    const prior = yield* readThreadVmRepositoryBinding();
    if (prior && (yield* encode(prior)) !== (yield* encode(record)))
      return yield* workspaceFailure("The installed repository binding changed.");
    if (!prior)
      yield* (yield* ServerSecretStore).create(
        THREAD_VM_REPOSITORY_BINDING_SECRET,
        new TextEncoder().encode(yield* encode(record)),
      );
    const runner = yield* ProcessRunner;
    for (const [key, value] of [
      ["remote.origin.url", `https://${record.canonicalKey}.git`],
      ["remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"],
    ]) {
      const result = yield* runner.run({
        command: "git",
        cwd: root,
        args: [
          "-c",
          "core.hooksPath=/dev/null",
          "config",
          "--local",
          "--replace-all",
          key!,
          value!,
        ],
        timeout: "10 seconds",
        maxOutputBytes: 16384,
        env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" },
      });
      if (result.code !== 0)
        return yield* workspaceFailure("The moved repository origin could not be configured.");
    }
  },
  Effect.timeout("20 seconds"),
  Effect.mapError(() => workspaceFailure("The moved VM is waiting for its repository binding.")),
);
