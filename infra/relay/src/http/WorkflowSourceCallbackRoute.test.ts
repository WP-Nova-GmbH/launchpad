import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { WORKFLOW_LINEAR_CALLBACK_PATH, WorkflowSourceError } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { vi } from "vite-plus/test";
import { RelaySecretBox } from "../auth/SecretBox.ts";
import { RelayDb } from "../db.ts";
import { WorkflowWake } from "../jobs/WorkflowWake.ts";
import { configLayer } from "../workflowSources/test-fixture.ts";
import { workflowSourceCallbackRoute } from "./WorkflowSourcesApi.ts";

const callback = vi.hoisted(() => vi.fn());
vi.mock("../workflowSources/Sources.ts", () => ({ callback }));

// The callback mock handles the exchange without reaching PostgreSQL or Linear.
const exchangeServices = Layer.mergeAll(
  NodeCrypto.layer,
  configLayer,
  Layer.succeed(RelayDb, {} as unknown as RelayDb["Service"]),
  Layer.mock(RelaySecretBox, {}),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("unexpected OAuth call")),
  ),
);
const route = workflowSourceCallbackRoute.pipe(HttpRouter.provideRequest(exchangeServices));

it.effect.each([
  {
    connected: true,
    status: 200,
    title: "Linear connected",
    instruction: "manage repository access",
  },
  {
    connected: false,
    status: 400,
    title: "Linear connection not confirmed",
    instruction: "check the connection status",
  },
])("returns the public callback page for $title", ({ connected, status, title, instruction }) =>
  Effect.gen(function* () {
    const state = "<b>private-callback-state</b>";
    const code = '"private-callback-code"';
    const denial = "<b>private-callback-denial</b>";
    const failure = "<b>private-callback-failure</b>";
    callback.mockReset();
    callback.mockReturnValue(
      connected
        ? Effect.succeed("connection-id")
        : Effect.fail(new WorkflowSourceError({ code: "invalid_input", message: failure })),
    );
    const url = new URL(WORKFLOW_LINEAR_CALLBACK_PATH, "https://relay.test");
    url.searchParams.set("state", state);
    if (connected) url.searchParams.set("code", code);
    else url.searchParams.set("error", denial);

    const wake = vi.fn();
    const handler = yield* HttpRouter.toHttpEffect(route);
    const response = HttpServerResponse.toWeb(
      yield* handler.pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(url)),
        ),
        Effect.provideService(WorkflowWake, { wake: () => Effect.sync(wake) }),
      ),
    );
    const html = yield* Effect.promise(() => response.text());

    expect(callback).toHaveBeenCalledExactlyOnceWith(state, connected ? code : null, !connected);
    expect(wake).toHaveBeenCalledTimes(connected ? 1 : 0);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")?.split("; ")).toEqual(
      expect.arrayContaining([
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "frame-ancestors 'none'",
      ]),
    );
    expect(html).toMatch(new RegExp(`<h1\\b[^>]*>${title}</h1>`, "u"));
    expect(html).toContain(instruction);
    expect(html).toContain("Organization settings");
    expect(html).toContain("Workflow sources");
    expect(html).toContain("You can close this tab");
    expect(html).not.toContain("private-callback-");
  }).pipe(Effect.scoped),
);
