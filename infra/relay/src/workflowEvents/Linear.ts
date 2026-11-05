import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { stableStringify } from "@t3tools/shared/relaySigning";
import type { WorkflowTrigger } from "@t3tools/contracts/workflows";

export const WEBHOOK_PATH = "/webhooks/workflow-sources/linear";
export const MAX_BODY_BYTES = 1_048_576;
export const FRESHNESS_MS = 60_000;
export class WebhookError extends Schema.TaggedError<WebhookError>()("WorkflowWebhookError", {
  status: Schema.Int,
  code: Schema.String,
}) {}
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(191));
const Time = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((s) => Number.isFinite(Date.parse(s)) || "Invalid event time"),
);
const Envelope = Schema.Struct({
  type: Id,
  action: Id,
  organizationId: Id,
  createdAt: Time,
  webhookTimestamp: Schema.Int.check(Schema.isGreaterThan(0)),
  oauthClientId: Schema.optional(Id),
  data: Schema.optional(Schema.Unknown),
  updatedFrom: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
});
// Official SDK IssueWebhookPayload; the synthetic fixture records the inspected source revision.
const Issue = Schema.Struct({
  id: Id,
  teamId: Id,
  stateId: Id,
  labelIds: Schema.Array(Id).check(Schema.isMaxLength(100)),
  updatedAt: Time,
  identifier: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_000)),
  url: Schema.String.check(Schema.isMaxLength(2048)),
  trashed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  archivedAt: Schema.optional(Schema.NullOr(Time)),
});
const OldState = Schema.Struct({ stateId: Schema.optional(Schema.NullOr(Id)) });
const decodeEnvelope = Schema.decodeUnknownEffect(Envelope);
const decodeIssue = Schema.decodeUnknownEffect(Issue);
const decodeOldState = Schema.decodeEffect(OldState);
const invalid = () => new WebhookError({ status: 400, code: "invalid_event" });
export const hash = (input: string) =>
  Effect.tryPromise({
    try: async () =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))),
        (n) => n.toString(16).padStart(2, "0"),
      ).join(""),
    catch: () => new WebhookError({ status: 500, code: "digest_failed" }),
  });
export const normalize = Effect.fn("workflowEvents.linear.normalize")(function* (
  value: unknown,
  applicationId: string,
) {
  const e = yield* decodeEnvelope(value).pipe(Effect.mapError(invalid));
  const base = {
    workspaceId: e.organizationId,
    occurredAt: DateTime.formatIso(DateTime.makeUnsafe(e.createdAt)),
    deliveredAt: e.webhookTimestamp,
  };
  if (e.type === "OAuthApp" && e.action === "revoked") {
    if (e.oauthClientId !== applicationId) return yield* invalid();
    return {
      ...base,
      kind: "revocation" as const,
      eventKey:
        "v1:" +
        (yield* hash(
          stableStringify({
            applicationId,
            ...base,
            deliveredAt: undefined,
            type: e.type,
            action: e.action,
          }),
        )),
    };
  }
  if (e.type !== "Issue" || !["create", "update"].includes(e.action))
    return { ...base, kind: "ignored" as const };
  const data = yield* decodeIssue(e.data).pipe(Effect.mapError(invalid));
  const old = yield* decodeOldState(e.updatedFrom ?? {}).pipe(Effect.mapError(invalid));
  // Keep the 120-code-unit bound without creating a lone surrogate for jsonb.
  const title = /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(data.title.slice(119, 121))
    ? data.title.slice(0, 119)
    : data.title.slice(0, 120);
  const facts = {
    issueId: data.id,
    teamId: data.teamId,
    stateId: data.stateId,
    labelIds: [...new Set(data.labelIds)].sort(),
    identifier: data.identifier,
    title,
    url: data.url,
    occurredAt: base.occurredAt,
    issueUpdatedAt: DateTime.formatIso(DateTime.makeUnsafe(data.updatedAt)),
    ...(old.stateId !== undefined ? { previousStateId: old.stateId } : {}),
  };
  const eligible = !data.trashed && !data.archivedAt;
  const eventKey =
    "v1:" +
    (yield* hash(
      stableStringify({
        applicationId,
        workspaceId: e.organizationId,
        type: e.type,
        action: e.action,
        occurredAt: base.occurredAt,
        issueId: data.id,
        issueUpdatedAt: facts.issueUpdatedAt,
        teamId: data.teamId,
        stateId: data.stateId,
        labelIds: facts.labelIds,
        ...(old.stateId !== undefined ? { previousStateId: old.stateId } : {}),
        eligible,
      }),
    ));
  return {
    ...base,
    kind: "issue" as const,
    action: e.action as "create" | "update",
    eventKey,
    facts,
    eligible,
    entered: e.action === "update" && old.stateId !== undefined && old.stateId !== data.stateId,
  };
});
export type NormalizedEvent = Effect.Success<ReturnType<typeof normalize>>;
export type IssueEvent = Extract<NormalizedEvent, { kind: "issue" }>;
export const matches = (trigger: WorkflowTrigger, event: IssueEvent) =>
  event.eligible &&
  trigger.teamId === event.facts.teamId &&
  trigger.labelIds.every((id) => event.facts.labelIds.includes(id)) &&
  (trigger.event === "issue_created"
    ? event.action === "create"
    : event.entered && trigger.stateId === event.facts.stateId);
export const verify = (bytes: Uint8Array, signature: string | undefined, secret: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const digest = Uint8Array.from(signature.match(/../g)!, (b) => Number.parseInt(b, 16));
      return crypto.subtle.verify("HMAC", key, digest, new Uint8Array(bytes));
    },
    catch: () => new WebhookError({ status: 500, code: "verification_failed" }),
  });
