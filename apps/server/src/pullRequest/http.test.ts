import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ProjectId,
  PullRequestDiffInput,
} from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import { PullRequestService } from "./PullRequestService.ts";
import { pullRequestHttpApiLayer } from "./http.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.pullRequests) {}

const projectId = ProjectId.make("vm:workflow:run");
const input = {
  projectId,
  repository: "example/private-repo",
  number: 1,
  commit: "a".repeat(40),
} satisfies PullRequestDiffInput;
const patch = { patch: "fixture patch", truncated: false, nextCursor: null };
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(PullRequestDiffInput));

const requestDiff = Effect.fnUntraced(function* (workflowVm: boolean) {
  const diff = vi.fn((_input: PullRequestDiffInput) => Effect.succeed(patch));
  const access = yield* RepositoryAccess;
  const routes = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(pullRequestHttpApiLayer),
    Layer.provide(Layer.mock(PullRequestService)({ diff })),
    Layer.provide(
      Layer.succeed(RepositoryAccess, {
        ...access,
        ...(workflowVm ? { workflowVm: true } : {}),
        requireProject: (_actor, requestedProjectId) =>
          Effect.sync(() => expect(requestedProjectId).toBe(projectId)),
      }),
    ),
    Layer.provide(
      Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
        Effect.provideService(effect, EnvironmentAuthenticatedPrincipal, {
          sessionId: AuthSessionId.make("reviewer"),
          subject: "cloud-connect",
          method: "dpop-access-token",
          user: { userId: "reviewer", displayName: null, imageUrl: null },
          scopes: new Set([AuthOrchestrationReadScope]),
        }),
      ),
    ),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provide(NodeServices.layer),
  );
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
    (route) =>
      Effect.promise(async () => {
        const response = await route.handler(
          new Request("https://environment.test/api/pull-requests/diff", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: encodeRequest(input),
          }),
        );
        return { status: response.status, body: await response.json(), diff };
      }),
    (route) => Effect.promise(() => route.dispose()),
  );
});

it.effect(
  "rejects a workflow VM reviewer's request for an unrelated commit before reaching GitHub",
  () =>
    Effect.gen(function* () {
      const { status, body, diff } = yield* requestDiff(true);
      expect(status).toBe(404);
      expect(body).toMatchObject({ code: "not_found", reason: "project_not_found" });
      expect(diff).not.toHaveBeenCalled();
    }),
);

it.effect("serves the same pull request diff in a regular environment", () =>
  Effect.gen(function* () {
    const { status, body, diff } = yield* requestDiff(false);
    expect(status).toBe(200);
    expect(body).toEqual(patch);
    expect(diff).toHaveBeenCalledExactlyOnceWith(input);
  }),
);
