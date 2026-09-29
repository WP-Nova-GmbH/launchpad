import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { RepositoryAccess } from "../auth/RepositoryAccess.ts";
import * as PullRequestService from "./PullRequestService.ts";

/** The patch is often the largest PR payload and benefits from HTTP compression and flow control. */
export const pullRequestHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pullRequests",
  Effect.fnUntraced(function* (handlers) {
    const pullRequests = yield* PullRequestService.PullRequestService;
    const access = yield* RepositoryAccess;
    return handlers.handle(
      "diff",
      Effect.fn("environment.pullRequests.diff")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        const actor = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        yield* access
          .requireProject(actor, args.payload.projectId)
          .pipe(Effect.catch(() => failEnvironmentNotFound("project_not_found")));
        return yield* pullRequests.diff(args.payload);
      }),
    );
  }),
);
