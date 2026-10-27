import {
  THREAD_VM_REPOSITORY_BINDING_SECRET,
  configureThreadVmMoveRepository,
} from "./ThreadVmRepositoryBinding.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ProcessRunner, layer as processRunnerLayer } from "../processRunner.ts";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { THREAD_VM_IDENTITY_SECRET } from "./ThreadVmEnrollment.ts";
import { THREAD_VM_INITIAL_STATE_SECRET } from "./ThreadVmInitialStateRecord.ts";
import {
  mintThreadVmRepositoryCredential,
  readThreadVmRepository,
  threadVmGitCredential,
} from "./ThreadVmRepositoryCredentials.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const vm = {
  operationId: "00000000-0000-4000-8000-000000000001",
  scope: { allocationId: "allocation", threadId: "thread", repositoryId: "repo", generation: 2 },
  environmentId: "vm-environment",
  relayUrl: "https://relay.test",
  relayIssuer: "https://issuer.test",
  environmentCredential: "vm-credential",
  cloudMintPublicKey: "key",
};
const canonicalKey = "github.com/acme/project";
const token = { canonicalKey, token: "repository-token", expiresAt: "2099-01-01T00:00:00Z" };
const fixture = () => {
  let stored: string | undefined = encode(vm);
  let response: unknown = token;
  let initial: string | undefined;
  let repositoryBinding: string | undefined;
  const calls: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(ServerSecretStore, {
        get: (name) =>
          Effect.sync(() => {
            const value =
              name === THREAD_VM_IDENTITY_SECRET
                ? stored
                : name === THREAD_VM_REPOSITORY_BINDING_SECRET
                  ? repositoryBinding
                  : name === THREAD_VM_INITIAL_STATE_SECRET
                    ? initial
                    : undefined;
            return value === undefined
              ? Option.none()
              : Option.some(new TextEncoder().encode(value));
          }),
        set: () => Effect.die("must not persist token"),
        create: (name, value) =>
          name === THREAD_VM_REPOSITORY_BINDING_SECRET
            ? Effect.sync(() => {
                repositoryBinding = new TextDecoder().decode(value);
              })
            : Effect.die("must not persist token"),
        remove: () => Effect.void,
        getOrCreateRandom: () => Effect.die("must not create identity"),
      }),
      Effect.provideService(ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("vm-environment")),
      }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            calls.push({
              url: request.url,
              authorization: request.headers.authorization,
              body:
                request.body._tag === "Uint8Array"
                  ? decode(new TextDecoder().decode(request.body.body))
                  : null,
            });
            return HttpClientResponse.fromWeb(request, Response.json(response));
          }),
        ),
      ),
    );
  return {
    calls,
    setBindingRaw: (value: string | undefined) => {
      repositoryBinding = value;
    },
    getBinding: () => repositoryBinding,
    provide,
    setInitial: (value: unknown) => {
      initial = encode(value);
    },
    setInitialRaw: (value: string | undefined) => {
      initial = value;
    },
    setStored: (value: string | undefined) => {
      stored = value;
    },
    setResponse: (value: unknown) => {
      response = value;
    },
  };
};

const initial = {
  input: {
    workspace: {
      operationId: vm.operationId,
      scope: vm.scope,
      canonicalKey,
      branch: "main",
      revision: "a".repeat(40),
    },
    title: "Thread",
    modelSelection: { instanceId: "codex", model: "model" },
    createdAt: "2026-10-05T10:00:00.000Z",
  },
  workspaceRoot: "/workspace/project",
  receipt: {
    version: 1,
    operationId: vm.operationId,
    environmentId: vm.environmentId,
    projectId: "vm:thread",
    scope: vm.scope,
    workspaceRoot: "/workspace/project",
    revision: "a".repeat(40),
    sequence: 2,
    execution: "frozen",
  },
};

describe("thread VM repository credentials", () => {
  it.effect(
    "binds a moved checkout to the relay repository before setup and reads it offline",
    () => {
      const f = fixture();
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            runner = yield* ProcessRunner;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "vm-repository-binding-" }),
          );
          const run = (args: ReadonlyArray<string>) =>
            runner.run({
              command: "git",
              cwd: root,
              args,
              env: {
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_COUNT: "0",
              },
            });
          yield* run(["init", "-b", "main"]);
          yield* run([
            "remote",
            "add",
            "origin",
            "https://old-host.invalid/credential-bearing-origin",
          ]);
          f.setResponse({
            environmentId: vm.environmentId,
            threadId: vm.scope.threadId,
            generation: vm.scope.generation,
            repositoryId: vm.scope.repositoryId,
            operationId: vm.operationId,
            canonicalKey,
          });
          const owner = {
            threadId: vm.scope.threadId,
            environmentId: vm.environmentId,
            relayUrl: vm.relayUrl,
            generation: vm.scope.generation,
            operationId: vm.operationId,
          };
          yield* configureThreadVmMoveRepository(owner, root).pipe(f.provide);
          assert.equal(
            (yield* run(["remote", "get-url", "origin"])).stdout.trim(),
            "https://github.com/acme/project.git",
          );
          assert.equal(yield* readThreadVmRepository().pipe(f.provide), canonicalKey);
          assert.lengthOf(f.calls, 1);
          assert.notInclude(f.getBinding()!, "repository-token");
          f.setResponse(token);
          assert.include(
            yield* threadVmGitCredential(
              "get",
              "protocol=https\nhost=github.com\npath=acme/project\n",
            ).pipe(f.provide),
            "password=repository-token",
          );
          assert.equal(
            yield* threadVmGitCredential(
              "get",
              "protocol=https\nhost=github.com\npath=acme/other\n",
            ).pipe(f.provide),
            "quit=1\n\n",
          );
          assert.lengthOf(f.calls, 2);
          const good = f.getBinding()!;
          for (const raw of [
            undefined,
            "broken",
            encode({ ...vm, canonicalKey, scope: { ...vm.scope, generation: 1 } }),
            encode({ ...vm, canonicalKey, environmentId: "foreign" }),
          ]) {
            f.setBindingRaw(raw);
            yield* readThreadVmRepository().pipe(f.provide, Effect.flip);
          }
          f.setBindingRaw(good);
          f.setResponse({
            ...vm,
            threadId: vm.scope.threadId,
            generation: vm.scope.generation,
            repositoryId: "foreign",
            canonicalKey,
          });
          yield* configureThreadVmMoveRepository(owner, root).pipe(f.provide, Effect.flip);
          assert.equal(
            (yield* run(["remote", "get-url", "origin"])).stdout.trim(),
            "https://github.com/acme/project.git",
          );
        }),
      ).pipe(Effect.provide(processRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer))));
    },
  );
  it.effect(
    "supplies credentials through real Git and stops helper fallback for another repository",
    () => {
      const f = fixture();
      f.setInitial(initial);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const runner = yield* ProcessRunner;
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: "/tmp",
          prefix: "launchpad-git-credential-",
        });
        const responseFile = `${directory}/reply`;
        const script = `${directory}/helper.sh`;
        yield* fs.writeFileString(script, `#!/bin/sh\ncat "${responseFile}"\n`);
        const args = [
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=!sh ${script}`,
          "-c",
          "credential.helper=!printf 'username=fallback\\npassword=broad\\n'",
          "-c",
          "credential.useHttpPath=true",
          "credential",
          "fill",
        ];
        for (const repository of ["acme/project", "acme/other"]) {
          const request = `protocol=https\nhost=github.com\npath=${repository}\n\n`;
          const reply = yield* threadVmGitCredential("get", request).pipe(f.provide);
          yield* fs.writeFileString(responseFile, reply);
          const result = yield* runner.run({
            command: "git",
            args,
            cwd: directory,
            stdin: request,
            env: {
              HOME: directory,
              GIT_CONFIG_GLOBAL: "/dev/null",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_TERMINAL_PROMPT: "0",
              GIT_ASKPASS: "",
              SSH_ASKPASS: "",
            },
            timeout: 5000,
            maxOutputBytes: 16384,
            outputMode: "error",
          });
          if (repository === "acme/project") {
            assert.equal(result.code, 0);
            assert.include(result.stdout, "password=repository-token");
          } else {
            assert.notEqual(result.code, 0);
            assert.notInclude(result.stdout, "broad");
            assert.notInclude(result.stdout, "repository-token");
          }
        }
        assert.lengthOf(f.calls, 1);
      }).pipe(Effect.provide(processRunnerLayer.pipe(Layer.provideMerge(NodeServices.layer))));
    },
  );

  it.effect(
    "keeps local binding lookup offline and returns credentials only for that exact HTTPS repository",
    () => {
      const f = fixture();
      f.setInitial(initial);
      return Effect.gen(function* () {
        assert.equal(yield* readThreadVmRepository(), canonicalKey);
        assert.lengthOf(f.calls, 0);
        assert.equal(
          yield* threadVmGitCredential(
            "get",
            "protocol=https\nhost=github.com\npath=Acme/Project.git\n\n",
          ),
          "username=x-access-token\npassword=repository-token\n\n",
        );
        assert.lengthOf(f.calls, 1);
        assert.equal(yield* threadVmGitCredential("store", "password=discard-this\n\n"), "");
        assert.equal(yield* threadVmGitCredential("erase", "password=discard-this\n\n"), "");
        assert.lengthOf(f.calls, 1);
      }).pipe(f.provide);
    },
  );
  it.effect(
    "denies malformed, foreign and missing credential contexts without requesting a token",
    () => {
      const f = fixture();
      f.setInitial(initial);
      return Effect.gen(function* () {
        for (const request of [
          "protocol=http\nhost=github.com\npath=acme/project\n",
          "protocol=https\nhost=other.test\npath=acme/project\n",
          "protocol=https\nhost=github.com\npath=acme/other\n",
          "protocol=https\nhost=github.com\n",
          "protocol=https\nhost=github.com\npath=acme/project\npath=acme/other\n",
          "protocol=https\nhost=github.com\npath=acme/project%2Fother\n",
          "x".repeat(16385),
          "protocol=https\0",
        ]) {
          assert.equal(yield* threadVmGitCredential("get", request), "quit=1\n\n");
        }
        assert.equal(yield* threadVmGitCredential("unknown", ""), "quit=1\n\n");
        assert.lengthOf(f.calls, 0);
        for (const record of [
          undefined,
          "broken",
          encode({ ...initial, receipt: null }),
          encode({
            ...initial,
            input: {
              ...initial.input,
              workspace: {
                ...initial.input.workspace,
                scope: { ...vm.scope, repositoryId: "other" },
              },
            },
          }),
        ]) {
          f.setInitialRaw(record);
          yield* readThreadVmRepository().pipe(Effect.flip);
          assert.equal(
            yield* threadVmGitCredential(
              "get",
              "protocol=https\nhost=github.com\npath=acme/project\n",
            ),
            "quit=1\n\n",
          );
        }
        assert.lengthOf(f.calls, 0);
      }).pipe(f.provide);
    },
  );
  it.effect("quits instead of leaking a malformed token into Git's credential protocol", () => {
    const f = fixture();
    f.setInitial(initial);
    f.setResponse({ ...token, token: "secret\nurl=https://other.test" });
    return threadVmGitCredential(
      "get",
      "protocol=https\nhost=github.com\npath=acme/project\n",
    ).pipe(
      Effect.tap((reply) => Effect.sync(() => assert.equal(reply, "quit=1\n\n"))),
      f.provide,
    );
  });

  it.effect(
    "uses current scoped identity, redacts the token, and does not persist or cache it",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const result = yield* mintThreadVmRepositoryCredential(canonicalKey);
        assert.equal(Redacted.value(result.token), token.token);
        assert.notInclude(String(result.token), token.token);
        assert.deepEqual(f.calls, [
          {
            url: "https://relay.test/v1/environments/vm-environment/threads/thread/credentials/github",
            authorization: "Bearer vm-credential",
            body: { generation: 2, canonicalKey },
          },
        ]);
        f.setStored(encode({ ...vm, environmentCredential: "rotated" }));
        yield* mintThreadVmRepositoryCredential(canonicalKey);
        assert.equal(f.calls[1]?.authorization, "Bearer rotated");
      }).pipe(f.provide);
    },
  );

  it.effect(
    "does not borrow broad credentials when enrollment is absent, corrupt or belongs elsewhere",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        for (const stored of [
          undefined,
          "corrupt",
          encode({ ...vm, environmentId: "other" }),
          encode({ ...vm, relayUrl: "https://relay.test/?secret=leak" }),
        ]) {
          f.setStored(stored);
          assert.equal(
            (yield* Effect.flip(mintThreadVmRepositoryCredential(canonicalKey)))._tag,
            "ThreadVmRepositoryCredentialError",
          );
        }
        assert.lengthOf(f.calls, 0);
      }).pipe(f.provide);
    },
  );

  it.effect(
    "rejects wrong-repository, malformed and expired responses without exposing token data",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        for (const response of [
          { ...token, canonicalKey: "github.com/acme/other" },
          { ...token, expiresAt: "1970-01-01T00:00:00Z" },
          { ...token, expiresAt: "invalid" },
          { ...token, expiresAt: { sensitive: token.token } },
        ]) {
          f.setResponse(response);
          const error = yield* Effect.flip(mintThreadVmRepositoryCredential(canonicalKey));
          assert.equal(error._tag, "ThreadVmRepositoryCredentialError");
          assert.notInclude(String(error), token.token);
        }
      }).pipe(f.provide);
    },
  );
});
