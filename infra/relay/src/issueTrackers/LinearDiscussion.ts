import { markdownImageUrls } from "@t3tools/client-runtime/markdown-image-urls";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { IssueTrackerFailure } from "./IssueTrackerModels.ts";
import { graphql } from "./Linear.ts";

export const COMMENT_PAGE_SIZE = 10;
export const COMMENT_BODY_BYTES = 4096;
export const DISCUSSION_BYTES = 64 * 1024;
export const ISSUE_RESPONSE_BYTES = 128 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Comment = Schema.Struct({
  id: Id,
  issueId: Schema.NullOr(Id),
  parentId: Schema.NullOr(Id),
  body: Schema.String,
  user: Schema.NullOr(Schema.Struct({ name: Text })),
  createdAt: Text,
  editedAt: Schema.NullOr(Text),
  url: Text,
});
const decodeComments = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({
      organization: Schema.Struct({ id: Id }),
      issue: Schema.NullOr(Schema.Struct({ id: Id })),
      comments: Schema.Struct({
        edges: Schema.Array(
          Schema.Struct({ cursor: Schema.String.check(Schema.isMaxLength(1024)), node: Comment }),
        ),
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
      }),
    }),
  }),
);
const decodeComment = Schema.decodeUnknownEffect(
  Schema.Struct({
    data: Schema.Struct({ organization: Schema.Struct({ id: Id }), comment: Comment }),
  }),
);
const failure = (code: IssueTrackerFailure["code"], message: string) =>
  new IssueTrackerFailure({ code, message });

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

export function linearUploadUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.origin !== "https://uploads.linear.app" ||
      url.username ||
      url.password ||
      value.length > 2048
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function linearImageUrls(markdown: string): readonly string[] {
  return markdownImageUrls(markdown).flatMap((value) => {
    const url = linearUploadUrl(value);
    return url ? [url] : [];
  });
}

/** The workspace-wide comments collection includes replies; retain their parent IDs. */
export const readLinearComments = Effect.fn("relay.linear.read_comments")(function* (input: {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly issueId: string;
  readonly after?: string;
}) {
  const data = yield* graphql(
    input.accessToken,
    `
      query LaunchpadComments($id: String!, $issueId: ID!, $after: String) {
        organization {
          id
        }
        issue(id: $id) {
          id
        }
        comments(
          first: 10
          after: $after
          orderBy: createdAt
          filter: { issue: { id: { eq: $issueId } } }
        ) {
          edges {
            cursor
            node {
              id
              issueId
              parentId
              body
              user {
                name
              }
              createdAt
              editedAt
              url
            }
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `,
    { id: input.issueId, issueId: input.issueId, after: input.after ?? null },
    decodeComments,
  );
  if (data.organization.id !== input.workspaceId)
    return yield* failure("forbidden", "The Linear workspace is no longer accessible.");
  if (!data.issue || data.issue.id !== input.issueId)
    return yield* failure("not_found", "The Linear issue is no longer accessible.");
  if (data.comments.edges.some(({ node }) => node.issueId !== input.issueId))
    return yield* failure("unavailable", "Linear returned comments for a different issue.");
  return data.comments;
});

export const readLinearCommentBody = Effect.fn("relay.linear.read_comment_body")(function* (input: {
  readonly accessToken: string;
  readonly workspaceId: string;
  readonly issueId: string;
  readonly commentId: string;
}) {
  const data = yield* graphql(
    input.accessToken,
    `
      query LaunchpadCommentImage($id: String!) {
        organization {
          id
        }
        comment(id: $id) {
          id
          issueId
          parentId
          body
          user {
            name
          }
          createdAt
          editedAt
          url
        }
      }
    `,
    { id: input.commentId },
    decodeComment,
  );
  if (
    data.organization.id !== input.workspaceId ||
    data.comment.issueId !== input.issueId ||
    data.comment.id !== input.commentId
  )
    return yield* failure("forbidden", "This image does not belong to the accessible issue.");
  return data.comment.body;
});

const ImageType = Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const decodeImageType = Schema.decodeUnknownEffect(ImageType);

export const fetchLinearImage = Effect.fn("relay.linear.fetch_image")(function* (input: {
  readonly accessToken: string;
  readonly url: string;
}) {
  const url = linearUploadUrl(input.url);
  if (!url)
    return yield* failure("invalid_input", "Only Linear-hosted image uploads are supported.");
  const http = yield* HttpClient.HttpClient;
  // Do not follow redirects with the bearer token to another destination.
  const response = yield* http
    .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.bearerToken(input.accessToken)))
    .pipe(
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "error",
        credentials: "omit",
      }),
      Effect.mapError(() => failure("unavailable", "The Linear image could not be fetched.")),
    );
  if (response.status === 401)
    return yield* failure("auth_required", "Reconnect Linear to view this image.");
  if (response.status === 403)
    return yield* failure("forbidden", "The connected account cannot view this image.");
  if (response.status === 404 || response.status === 410)
    return yield* failure("not_found", "The Linear image is no longer available.");
  if (response.status !== 200)
    return yield* failure("unavailable", "The Linear image is unavailable.");
  const mimeType = yield* decodeImageType(
    response.headers["content-type"]?.split(";")[0]?.trim(),
  ).pipe(
    Effect.mapError(() =>
      failure(
        "unsupported_image",
        "This upload is not a supported image (PNG, JPEG, WebP or GIF).",
      ),
    ),
  );
  const bytes = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ size: 0, chunks: [] as Uint8Array[] }),
      (state, chunk) => {
        if (state.size + chunk.byteLength > IMAGE_BYTES)
          return Effect.fail(
            failure("image_too_large", "The Linear image exceeds the 5 MiB limit."),
          );
        state.chunks.push(chunk);
        return Effect.succeed({ size: state.size + chunk.byteLength, chunks: state.chunks });
      },
    ),
    Effect.mapError((error) =>
      error._tag === "RelayIssueTrackerError"
        ? error
        : failure("unavailable", "The Linear image could not be read."),
    ),
  );
  if (bytes.size === 0) return yield* failure("unavailable", "The Linear image was empty.");
  const joined = new Uint8Array(bytes.size);
  let offset = 0;
  for (const chunk of bytes.chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  // Keep this portable to the relay's Workers runtime.
  let binary = "";
  for (let start = 0; start < joined.length; start += 8192)
    binary += String.fromCharCode(...joined.subarray(start, start + 8192));
  return { mimeType, data: btoa(binary) };
});
