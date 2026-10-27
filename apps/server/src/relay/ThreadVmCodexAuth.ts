import { ProviderInstanceId, ProviderSetupError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProviderAuthFlow from "../provider/ProviderAuthFlow.ts";
import type { ProviderAccountAuthShape } from "../provider/ProviderAccountAuth.ts";
import { makeProviderAuthService } from "../provider/Layers/ProviderAuthService.ts";
import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
/** The transfer version pins the CLI. Keep native terminal text out of the relay;
 * advertise only its OpenAI device page and bounded one-time code. */
export function parseCodexDeviceSignIn(output: string) {
  const text = output.replace(ansi, "");
  const userCode = /(?:^|\n)[ \t]*([A-Z0-9]{4}-[A-Z0-9]{4,5})[ \t]*\r?\n/u.exec(text)?.[1];
  if (!userCode) return null;
  for (const candidate of text.match(/https:\/\/[^\s<>"'`]+/gu) ?? []) {
    try {
      const url = new URL(candidate);
      if (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        !url.port &&
        ((url.hostname === "auth.openai.com" && url.pathname === "/codex/device") ||
          (url.hostname === "chatgpt.com" && url.pathname === "/activate"))
      )
        return { url: url.href, userCode };
    } catch {
      /* Incomplete output chunks are not sign-in instructions. */
    }
  }
  return null;
}

export const makeThreadVmCodexAuth = Effect.fn("ThreadVmCodexAuth.make")(function* (
  account: ProviderAccountAuthShape,
  verify: Effect.Effect<boolean>,
) {
  const instanceId = ProviderInstanceId.make("codex");
  return yield* ProviderAuthFlow.make({
    instanceId,
    credentialBinding: { owner: "provider", key: "private-thread-vm-codex" },
    methods: Effect.succeed([
      { id: "device", name: "Codex sign-in", description: null, type: "agent" },
    ]),
    defaultMethodId: "device",
    authenticate: (_, context) =>
      Effect.gen(function* () {
        let output = "",
          advertised = false;
        yield* account.login.pipe(
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              if (event.type !== "output" || advertised) return;
              // Chunk boundaries and ANSI escapes may divide the code. Retain a bounded suffix only.
              output = (output + event.text).slice(-16_384);
              const code = parseCodexDeviceSignIn(output);
              if (!code) return;
              advertised = true;
              yield* context.setInteraction({ type: "deviceCode", id: context.flowId, ...code });
            }),
          ),
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Codex sign-in failed. Start again.",
              }),
          ),
        );
        yield* context.verifying;
        if (!(yield* verify))
          return yield* new ProviderSetupError({
            instanceId,
            operation: "start",
            detail: "Codex could not confirm sign-in. Start again.",
          });
      }),
    logout: account.logout.pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation: "logout",
            detail: "Could not sign out of Codex.",
          }),
      ),
    ),
  });
});

/** The guest-only HTTP control route reuses ProviderAuthService admission,
 * session invalidation and flow privacy. Other provider routes retain their service. */
export const threadVmCodexAuthServiceLayer = Layer.effect(
  ProviderAuthService,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const instanceId = ProviderInstanceId.make("codex");
    const instance = yield* registry.getInstance(instanceId);
    if (!instance?.accountAuth || instance.auth || instance.driverKind !== "codex")
      return yield* makeProviderAuthService;
    const auth = yield* makeThreadVmCodexAuth(
      instance.accountAuth,
      instance.snapshot.refresh.pipe(Effect.map((s) => s.auth.status === "authenticated")),
    );
    const guestInstance = { ...instance, auth };
    return yield* makeProviderAuthService.pipe(
      Effect.provideService(ProviderInstanceRegistry, {
        ...registry,
        getInstance: (id) =>
          id === instanceId ? Effect.succeed(guestInstance) : registry.getInstance(id),
        listInstances: registry.listInstances.pipe(
          Effect.map((instances) =>
            instances.map((i) => (i.instanceId === instanceId ? guestInstance : i)),
          ),
        ),
      }),
    );
  }),
);
