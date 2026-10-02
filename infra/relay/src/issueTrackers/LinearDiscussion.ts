import { markdownImageUrls } from "@t3tools/client-runtime/markdown-image-urls";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { IssueTrackerFailure } from "./IssueTrackerModels.ts";
import { callLinearTools, linearToolJson } from "./LinearMcp.ts";
import { linearUploadUrl, normalizeLinearMarkdown } from "./LinearMarkdown.ts";
export { linearUploadUrl } from "./LinearMarkdown.ts";

export const COMMENT_PAGE_SIZE = 10;
export const COMMENT_BODY_BYTES = 4096;
export const DISCUSSION_BYTES = 64 * 1024;
export const ISSUE_RESPONSE_BYTES = 128 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Cursor = Schema.Struct({
  page: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Id),
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));
const decodeComments = Schema.decodeUnknownEffect(
  Schema.Struct({
    comments: Schema.Array(
      Schema.Struct({
        id: Id,
        issueId: Schema.optionalKey(Schema.NullOr(Id)),
        body: Schema.String,
        createdAt: Text,
        updatedAt: Schema.optionalKey(Schema.NullOr(Text)),
        editedAt: Schema.optionalKey(Schema.NullOr(Text)),
        parentId: Schema.optionalKey(Schema.NullOr(Id)),
        author: Schema.NullOr(Schema.Struct({ name: Text })),
      }),
    ),
    hasNextPage: Schema.Boolean,
    endCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);
const decodeWorkspace = Schema.decodeUnknownEffect(Schema.Struct({ id: Id }));
const decodeIssue = Schema.decodeUnknownEffect(Schema.Struct({ uuid: Id, url: Schema.String }));
const failure = (code: IssueTrackerFailure["code"], message: string) =>
  new IssueTrackerFailure({ code, message });
const unavailable = () =>
  failure(
    "unavailable",
    "Linear could not read this discussion. Open the issue in Linear or retry.",
  );

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function clipComment(body: string) {
  const bytes = new TextEncoder().encode(body);
  if (bytes.byteLength <= COMMENT_BODY_BYTES) return { body, bodyTruncated: false };
  // Streaming decoding omits an incomplete trailing code point.
  return {
    body: new TextDecoder().decode(bytes.subarray(0, COMMENT_BODY_BYTES), { stream: true }),
    bodyTruncated: true,
  };
}

export function linearImageUrls(markdown: string): readonly string[] {
  return [
    ...new Set(
      markdownImageUrls(normalizeLinearMarkdown(markdown)).flatMap((value) => {
        const url = linearUploadUrl(value);
        return url ? [url] : [];
      }),
    ),
  ];
}

export const readLinearComments = Effect.fn("relay.linear.read_comments")(function* (input: {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly issueId: string;
  readonly after?: string;
}) {
  const position = input.after
    ? yield* decodeCursor(input.after).pipe(
        Effect.mapError(() =>
          failure("invalid_input", "Read the issue again for a fresh discussion reference."),
        ),
      )
    : {};
  const results = yield* callLinearTools(input.accessToken, [
    { name: "get_workspace", arguments: {} },
    { name: "get_issue", arguments: { id: input.issueId } },
    {
      name: "list_comments",
      arguments: {
        issueId: input.issueId,
        limit: COMMENT_PAGE_SIZE,
        orderBy: "createdAt",
        ...(position.page ? { cursor: position.page } : {}),
      },
    },
  ]);
  const workspace = yield* linearToolJson(results[0]!).pipe(
    Effect.flatMap(decodeWorkspace),
    Effect.mapError(unavailable),
  );
  const issue = yield* linearToolJson(results[1]!).pipe(
    Effect.flatMap(decodeIssue),
    Effect.mapError(unavailable),
  );
  if (workspace.id !== input.workspaceId || issue.uuid !== input.issueId)
    return yield* failure("forbidden", "The Linear workspace or issue is no longer accessible.");
  const issueUrl = URL.parse(issue.url);
  if (issueUrl?.origin !== "https://linear.app" || issueUrl.username || issueUrl.password)
    return yield* unavailable();
  const page = yield* linearToolJson(results[2]!).pipe(
    Effect.flatMap(decodeComments),
    Effect.mapError(unavailable),
  );
  if (page.hasNextPage && (!page.endCursor || page.endCursor === position.page))
    return yield* unavailable();
  if (
    page.comments.some(
      (comment) => comment.issueId !== undefined && comment.issueId !== input.issueId,
    )
  )
    return yield* unavailable();
  const previous = position.after
    ? page.comments.findIndex((comment) => comment.id === position.after)
    : -1;
  if (position.after && previous === -1)
    return yield* failure(
      "conflict",
      "The discussion changed. Read the issue again for fresh references.",
    );
  const comments = page.comments.slice(previous + 1);
  return {
    edges: comments.map((comment, index) => ({
      cursor:
        index === comments.length - 1 && page.hasNextPage
          ? encodeCursor({ page: page.endCursor! })
          : encodeCursor({ ...position, after: comment.id }),
      node: {
        id: comment.id,
        issueId: input.issueId,
        parentId: comment.parentId ?? null,
        body: normalizeLinearMarkdown(comment.body),
        user: comment.author,
        createdAt: comment.createdAt,
        editedAt:
          comment.editedAt ??
          (comment.updatedAt && comment.updatedAt !== comment.createdAt ? comment.updatedAt : null),
        url: `${issue.url}#comment-${comment.id}`,
      },
    })),
    pageInfo: { hasNextPage: page.hasNextPage },
  };
});

export const readLinearCommentBody = Effect.fn("relay.linear.read_comment_body")(function* (input: {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly issueId: string;
  readonly commentId: string;
  readonly commentCursor?: string;
}) {
  const page = yield* readLinearComments({
    ...input,
    ...(input.commentCursor ? { after: input.commentCursor } : {}),
  });
  const comment = page.edges.find(({ node }) => node.id === input.commentId);
  if (!comment)
    return yield* failure(
      "not_found",
      "This comment is no longer available. Read the discussion again.",
    );
  return comment.node.body;
});

const Image = Schema.Struct({
  type: Schema.Literal("image"),
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  data: Schema.NonEmptyString,
});
const decodeImage = Schema.decodeUnknownEffect(Image);
export const fetchLinearImage = Effect.fn("relay.linear.fetch_image")(function* (input: {
  readonly accessToken: string;
  readonly url: string;
}) {
  const url = linearUploadUrl(input.url);
  if (!url)
    return yield* failure("invalid_input", "Only Linear-hosted image uploads are supported.");
  // Linear's extractor does not recognize angle-bracket Markdown destinations.
  const destination = url.replace(/[()]/g, (character) => (character === "(" ? "%28" : "%29"));
  const results = yield* callLinearTools(input.accessToken, [
    { name: "extract_images", arguments: { markdown: `![image](${destination})` } },
  ]);
  const images = results[0]!.content.filter((entry) => entry.type === "image");
  if (images.length !== 1)
    return yield* failure("unavailable", "Linear could not fetch this image.");
  const image = yield* decodeImage(images[0]).pipe(
    Effect.mapError(() =>
      failure(
        "unsupported_image",
        "This upload is not a supported image (PNG, JPEG, WebP or GIF).",
      ),
    ),
  );
  if (image.data.length > Math.ceil(IMAGE_BYTES / 3) * 4)
    return yield* failure("image_too_large", "The Linear image exceeds the 5 MiB limit.");
  const size = yield* Effect.try({
    try: () => atob(image.data).length,
    catch: () => failure("unavailable", "Linear returned an invalid image."),
  });
  if (size > IMAGE_BYTES)
    return yield* failure("image_too_large", "The Linear image exceeds the 5 MiB limit.");
  if (size === 0) return yield* failure("unavailable", "The Linear image was empty.");
  return { mimeType: image.mimeType, data: image.data };
});
