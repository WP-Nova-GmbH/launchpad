import * as Context from "effect/Context";

/** The private bare repository seeded by the workflow VM checkout bootstrap. */
export const WorkflowReviewGitDirectory = Context.Reference<string | undefined>(
  "t3/vcs/WorkflowReviewGitDirectory",
  { defaultValue: () => undefined },
);

export const WORKFLOW_REVIEW_SOURCE_REF = "refs/t3/transfer/head";
