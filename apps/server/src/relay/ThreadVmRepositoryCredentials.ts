import { readThreadVmRepositoryBinding } from "./ThreadVmRepositoryBinding.ts";
import { readThreadVmInitialState } from "./ThreadVmInitialStateRecord.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import { makeExecutorRelayApiClient } from "./executorRelayClient.ts";
import { readInstalledThreadVm } from "./ThreadVmEnrollment.ts";

export class ThreadVmRepositoryCredentialError extends Schema.TaggedError<ThreadVmRepositoryCredentialError>()(
  "ThreadVmRepositoryCredentialError",
  {},
) {
  override get message() {
    return "Repository access is unavailable for this thread VM.";
  }
}
const unavailable = () => new ThreadVmRepositoryCredentialError();

/** Short-lived credentials are requested only with the installed thread identity; never borrow a host account. */
export const mintThreadVmRepositoryCredential = Effect.fn("ThreadVmRepositoryCredentials.mint")(
  function* (canonicalKey: string) {
    const vm = yield* readInstalledThreadVm();
    const environmentId = yield* (yield* ServerEnvironmentIdentity).getEnvironmentId;
    if (!vm || vm.environmentId !== environmentId) return yield* unavailable();
    const url = normalizeSecureRelayUrl(vm.relayUrl);
    const issuer = normalizeSecureRelayUrl(vm.relayIssuer);
    if (!url || !issuer) return yield* unavailable();
    const client = yield* makeExecutorRelayApiClient({
      url,
      issuer,
      environmentCredential: vm.environmentCredential,
    });
    const response = yield* client.threadEnvironment.mintRepositoryToken({
      params: { environmentId, threadId: vm.scope.threadId },
      payload: { generation: vm.scope.generation, canonicalKey },
    });
    const expiresAt = Date.parse(response.expiresAt);
    if (
      response.canonicalKey !== canonicalKey ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= (yield* DateTime.now).epochMilliseconds
    )
      return yield* unavailable();
    return { canonicalKey, expiresAt: response.expiresAt, token: Redacted.make(response.token) };
  },
  Effect.timeout("15 seconds"),
  Effect.mapError(unavailable),
);

/** The current checkout binding is local; looking it up must not need relay connectivity. */
export const readThreadVmRepository = Effect.fn("ThreadVmRepositoryCredentials.repository")(
  function* () {
    const vm = yield* readInstalledThreadVm();
    if (!vm) return null;
    const initial = yield* readThreadVmInitialState();
    if (!initial && vm.scope.generation > 1) {
      const binding = yield* readThreadVmRepositoryBinding();
      if (
        !binding ||
        binding.environmentId !== vm.environmentId ||
        binding.operationId !== vm.operationId ||
        binding.scope.allocationId !== vm.scope.allocationId ||
        binding.scope.threadId !== vm.scope.threadId ||
        binding.scope.repositoryId !== vm.scope.repositoryId ||
        binding.scope.generation !== vm.scope.generation ||
        vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId)
      )
        return yield* unavailable();
      return binding.canonicalKey;
    }
    const workspace = initial?.input.workspace;
    if (
      !workspace ||
      !initial.receipt ||
      vm.environmentId !== (yield* (yield* ServerEnvironmentIdentity).getEnvironmentId) ||
      workspace.scope.repositoryId !== vm.scope.repositoryId ||
      workspace.scope.threadId !== vm.scope.threadId ||
      workspace.scope.allocationId !== vm.scope.allocationId ||
      workspace.scope.generation !== vm.scope.generation ||
      workspace.operationId !== vm.operationId ||
      initial.receipt.environmentId !== vm.environmentId
    )
      return yield* unavailable();
    return workspace.canonicalKey;
  },
  Effect.mapError(unavailable),
);

const decodeGitRequest = Schema.decodeUnknownEffect(
  Schema.Struct({
    protocol: Schema.Literal("https"),
    host: Schema.Literals(["github.com", "github.com:443"]),
    path: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/u)),
  }),
);

/** Git's line protocol is confined to get; store/erase never persist the short-lived token. */
export const threadVmGitCredential = Effect.fn("ThreadVmRepositoryCredentials.git_helper")(
  function* (action: string, request: string) {
    if (action === "store" || action === "erase") return "";
    if (action !== "get" || request.length > 16384 || request.includes("\0"))
      return yield* unavailable();
    const fields: Record<string, string> = {};
    for (const line of request.split("\n")) {
      if (line === "") break;
      const equals = line.indexOf("=");
      if (equals < 1) return yield* unavailable();
      const key = line.slice(0, equals);
      if (!["protocol", "host", "path"].includes(key)) continue;
      if (Object.hasOwn(fields, key)) return yield* unavailable();
      fields[key] = line.slice(equals + 1);
    }
    const input = yield* decodeGitRequest(fields);
    const canonicalKey = `github.com/${input.path.replace(/\.git$/iu, "").toLowerCase()}`;
    if (canonicalKey !== (yield* readThreadVmRepository())) return yield* unavailable();
    const credential = yield* mintThreadVmRepositoryCredential(canonicalKey);
    const token = Redacted.value(credential.token);
    if (/[\r\n\0]/u.test(token)) return yield* unavailable();
    return `username=x-access-token\npassword=${token}\n\n`;
  },
  Effect.catch(() => Effect.succeed("quit=1\n\n")),
);
