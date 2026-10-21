import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { RelayApi } from "@t3tools/contracts/relay";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { RelayDb } from "../db.ts";
import {
  ThreadVmRuntimeConfiguration,
  type ThreadVmRuntimeSettings,
} from "../threads/ThreadVmRuntime.ts";
import { healthApi } from "./Api.ts";

const settings: ThreadVmRuntimeSettings = {
  compute: {
    apiUrl: "https://compute.example.test",
    sandboxUrl: "https://sandbox.example.test",
    apiKey: Redacted.make("not-public"),
    templateId: "runner:build-verified",
    hostAddresses: ["host.example.test"],
    timeoutMs: 600_000,
  },
  templateBuildId: "build-verified",
  hostId: "private-host",
  maxRunningVms: 2,
  publicRelayUrl: "https://relay.example.test",
  autoPauseEnabled: false,
  autoBackupEnabled: false,
  autoDeleteEnabled: false,
  replacementEnabled: false,
  restoreEnabled: false,
  resetEnabled: false,
};

describe("relay health VM capability", () => {
  for (const testCase of [
    { name: "reports an unconfigured host", settings: undefined, databaseFails: false },
    { name: "reports a configured host without exposing settings", settings, databaseFails: false },
    { name: "preserves database failure responses", settings, databaseFails: true },
  ]) {
    it.effect(testCase.name, () =>
      Effect.gen(function* () {
        const execute = vi.fn().mockReturnValue(
          testCase.databaseFails
            ? Effect.fail(
                new EffectDrizzleQueryError({
                  query: "SELECT 1",
                  params: [],
                  cause: "database unavailable",
                }),
              )
            : Effect.succeed([]),
        );
        const handlers = healthApi.pipe(
          Layer.provide(Layer.succeed(RelayDb, { execute } as unknown as RelayDb["Service"])),
          Layer.provide(
            Layer.succeed(ThreadVmRuntimeConfiguration, { settings: testCase.settings }),
          ),
        );
        const app = yield* Effect.acquireRelease(
          Effect.sync(() =>
            HttpRouter.toWebHandler(
              HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.health)).pipe(
                Layer.provide(handlers),
                Layer.provide(HttpServer.layerServices),
              ),
              { disableLogger: true },
            ),
          ),
          (app) => Effect.promise(() => app.dispose()),
        );
        const response = yield* Effect.promise(() =>
          app.handler(new Request("https://relay.example.test/health")),
        );
        expect(execute).toHaveBeenCalledTimes(1);
        expect(response.status).toBe(testCase.databaseFails ? 500 : 200);
        const body = yield* Effect.promise(() => response.json());
        if (testCase.databaseFails) {
          expect(body).toMatchObject({
            code: "internal_error",
            reason: "database_unavailable",
            traceId: expect.any(String),
          });
          expect(body).not.toHaveProperty("threadVmConfigured");
        } else {
          expect(body).toEqual({
            ok: true,
            service: "relay",
            threadVmConfigured: testCase.settings !== undefined,
          });
        }
      }).pipe(Effect.scoped),
    );
  }
});
