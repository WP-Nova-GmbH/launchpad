import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const Identity = TrimmedNonEmptyString.check(Schema.isMaxLength(191));
export const WorkflowOrigin = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("manual"), userId: Identity }),
  Schema.Struct({
    kind: Schema.Literal("automation"),
    organizationId: Identity,
    repositoryId: Identity,
    workflowId: Identity,
    source: Schema.Struct({
      provider: Schema.Literal("linear"),
      applicationId: Identity,
      workspaceId: Identity,
      connectionId: Identity,
      grantId: Identity,
    }),
    occurrenceId: Identity,
  }),
]);
export type WorkflowOrigin = typeof WorkflowOrigin.Type;
export const sameWorkflowOrigin = Schema.toEquivalence(WorkflowOrigin);

/** Display data only; authority always comes from the saved run and signed dispatch. */
export const WorkflowAttribution = Schema.Struct({
  kind: Schema.Literal("automation"),
  jobId: Identity,
  workflowId: Identity,
  workflowName: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
});
export type WorkflowAttribution = typeof WorkflowAttribution.Type;
export const WorkflowOriginSummary = Schema.Struct({
  kind: Schema.Literals(["manual", "automation"]),
  workflowName: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
});
