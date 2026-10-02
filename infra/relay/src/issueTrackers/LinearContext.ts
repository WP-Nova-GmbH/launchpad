import type { RelayLinearDiscussion } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { RelaySecretBox } from "../auth/SecretBox.ts";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";
import {
  clipComment,
  COMMENT_PAGE_SIZE,
  DISCUSSION_BYTES,
  linearImageUrls,
  readLinearComments,
  utf8Bytes,
} from "./LinearDiscussion.ts";

const Reference = Schema.Struct({
  kind: Schema.Literals(["issue", "comments", "image", "images"]),
  organizationId: Schema.String,
  generation: Schema.String,
  workspaceId: Schema.String,
  issueId: Schema.String,
  after: Schema.optionalKey(Schema.String),
  imageUrl: Schema.optionalKey(Schema.String),
  afterImage: Schema.optionalKey(Schema.String),
  commentId: Schema.optionalKey(Schema.String),
  commentCursor: Schema.optionalKey(Schema.String),
});
export type LinearReference = typeof Reference.Type;
export type LinearSource = Pick<
  LinearReference,
  "organizationId" | "generation" | "workspaceId" | "issueId"
>;
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Reference));
const encode = Schema.encodeEffect(Schema.fromJsonString(Reference));
const unavailable = () =>
  new IssueTrackerFailure({ code: "unavailable", message: "Could not prepare Linear context." });

export const sealLinearReference = Effect.fn("linearContext.seal_reference")(function* (
  reference: LinearReference,
) {
  const box = yield* RelaySecretBox;
  return yield* encode(reference).pipe(Effect.flatMap(box.seal), Effect.mapError(unavailable));
});

export const openLinearReference = Effect.fn("linearContext.open_reference")(function* (
  reference: string,
) {
  const box = yield* RelaySecretBox;
  return yield* box.open(reference).pipe(
    Effect.flatMap(decode),
    Effect.mapError(
      () =>
        new IssueTrackerFailure({
          code: "invalid_input",
          message: "Use a reference returned by a Linear issue read.",
        }),
    ),
  );
});

/** A reference authenticates its source, not current access: every read must still check the binding. */
export function validateLinearSource(
  reference: LinearSource,
  active: Omit<LinearSource, "issueId">,
) {
  return reference.organizationId === active.organizationId &&
    reference.generation === active.generation &&
    reference.workspaceId === active.workspaceId
    ? Effect.void
    : Effect.fail(
        new IssueTrackerFailure({
          code: "conflict",
          message: "The Linear connection changed. Read the issue again for fresh references.",
        }),
      );
}

export const IMAGE_REFERENCE_PAGE_SIZE = 5;

export const linearImageReferences = Effect.fn("linearContext.image_references")(function* (
  source: LinearSource,
  markdown: string,
  commentId?: string,
  afterImage?: string,
  commentCursor?: string,
) {
  const urls = linearImageUrls(markdown);
  const previous = afterImage === undefined ? -1 : urls.indexOf(afterImage);
  if (afterImage !== undefined && previous === -1)
    return yield* new IssueTrackerFailure({
      code: "conflict",
      message: "The image list changed. Read the issue or discussion again for fresh references.",
    });
  const page = urls.slice(previous + 1, previous + 1 + IMAGE_REFERENCE_PAGE_SIZE);
  const images = yield* Effect.forEach(page, (url) =>
    sealLinearReference({
      ...source,
      kind: "image",
      imageUrl: url,
      ...(commentId ? { commentId } : {}),
      ...(commentCursor ? { commentCursor } : {}),
    }).pipe(Effect.map((reference) => ({ url, reference }))),
  );
  const imagesTruncated = previous + 1 + images.length < urls.length;
  const imagesContinuation = imagesTruncated
    ? yield* sealLinearReference({
        ...source,
        kind: "images",
        afterImage: page[page.length - 1]!,
        ...(commentId ? { commentId } : {}),
        ...(commentCursor ? { commentCursor } : {}),
      })
    : null;
  return { images, imagesTruncated, imagesContinuation };
});

export const linearDiscussion = Effect.fn("linearContext.discussion")(function* (input: {
  readonly source: LinearSource;
  readonly accessToken: string;
  readonly after?: string;
  readonly byteBudget?: number;
}) {
  const page = yield* readLinearComments({
    ...input.source,
    accessToken: input.accessToken,
    ...(input.after ? { after: input.after } : {}),
  });
  const comments: Extract<RelayLinearDiscussion, { status: "available" }>["comments"][number][] =
    [];
  const budget = Math.min(input.byteBudget ?? DISCUSSION_BYTES, DISCUSSION_BYTES);
  let cursor = input.after;
  let omitted = false;
  for (const { node, cursor: nextCursor } of page.edges.slice(0, COMMENT_PAGE_SIZE)) {
    const comment = {
      id: node.id,
      parentId: node.parentId,
      ...clipComment(node.body),
      author: node.user?.name || null,
      createdAt: node.createdAt,
      editedAt: node.editedAt,
      url: node.url,
      ...(yield* linearImageReferences(input.source, node.body, node.id, undefined, cursor)),
    };
    // Reserve room for the sealed continuation and status fields.
    if (utf8Bytes([...comments, comment]) + 8192 > budget) {
      omitted = true;
      break;
    }
    comments.push(comment);
    cursor = nextCursor;
  }
  const hasMore = omitted || page.edges.length > COMMENT_PAGE_SIZE || page.pageInfo.hasNextPage;
  if (hasMore && comments.length === 0)
    return yield* new IssueTrackerFailure({
      code: "unavailable",
      message:
        "This discussion page could not fit the response budget. Retry from the issue source or open the issue in Linear.",
    });
  const continuation = hasMore
    ? yield* sealLinearReference({
        ...input.source,
        kind: "comments",
        ...(cursor ? { after: cursor } : {}),
      })
    : null;
  return {
    status: "available" as const,
    comments,
    continuation,
    hasMore,
    contentTruncated:
      omitted || comments.some((comment) => comment.bodyTruncated || comment.imagesTruncated),
  };
});
