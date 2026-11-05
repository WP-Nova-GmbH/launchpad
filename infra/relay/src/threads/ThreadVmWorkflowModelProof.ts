import { TrimmedNonEmptyString } from "@t3tools/contracts";
import { WorkflowVmModelCatalog } from "@t3tools/contracts/workflows";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const WORKFLOW_VM_MODEL_PROOF_VERSION = 2;
export const WORKFLOW_VM_ISOLATION_VERSION = 4;

export const WorkflowVmModelProof = Schema.Struct({
  schemaVersion: Schema.Literal(WORKFLOW_VM_MODEL_PROOF_VERSION),
  templateRef: TrimmedNonEmptyString,
  buildId: TrimmedNonEmptyString,
  catalog: WorkflowVmModelCatalog,
  isolationVersion: Schema.optional(Schema.Int),
}).check(
  Schema.makeFilter(({ catalog }) => {
    const slugs = new Set(catalog.models.map(({ slug }) => slug));
    return (
      (slugs.size === catalog.models.length &&
        slugs.size <= 32 &&
        slugs.has(catalog.defaultModel) &&
        catalog.models.every(
          ({ isCustom, slug, name }) => !isCustom && slug.length <= 128 && name.length <= 256,
        )) ||
      "Expected unique built-in VM models including the managed default."
    );
  }),
);

const decodeProof = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowVmModelProof));

/** Different builds can complete their smoke checks concurrently without replacing each other's proof. */
export const workflowVmModelProofPath = (selectionPath: string, buildId: string) =>
  `${selectionPath}.workflow-models.${buildId}.json`;

export function verifiedWorkflowVmModelProof(
  content: string,
  templateRef: string,
  buildId: string,
) {
  if (content.length > 64 * 1024) return undefined;
  const proof = Option.getOrUndefined(decodeProof(content));
  return proof?.templateRef === templateRef && proof.buildId === buildId ? proof : undefined;
}
