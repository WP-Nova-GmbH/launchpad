import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { fixture, toolName } from "./Connections.test-fixture.ts";
import {
  linearDiscussion,
  linearImageReferences,
  openLinearReference,
  validateLinearSource,
} from "./LinearContext.ts";
import {
  clipComment,
  fetchLinearImage,
  linearImageUrls,
  readLinearComments,
  utf8Bytes,
} from "./LinearDiscussion.ts";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const source = {
  ownerUserId: "org",
  generation: "generation",
  workspaceId: "workspace",
  issueId: "issue",
};
const input = { ...source, accessToken: "access-secret" };
const comment = (id: string, body = "Comment") => ({
  id,
  issueId: "issue",
  parentId: null as string | null,
  body,
  user: { name: "Alice" } as { name: string } | null,
  createdAt: "2026-09-30T12:00:00Z",
  editedAt: null as string | null,
  url: `https://linear.app/org/issue/LP-1#comment-${id}`,
});
const page = (nodes: ReturnType<typeof comment>[], more = false) =>
  Response.json({
    data: {
      organization: { id: "workspace" },
      issue: { id: "issue" },
      comments: {
        edges: nodes.map((node) => ({ cursor: `cursor-${node.id}`, node })),
        pageInfo: { hasNextPage: more },
      },
    },
  });
function harness(responses: Response[]) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const test = yield* fixture({
        respond: (request) => {
          requests.push(request);
          if (toolName(request) === "get_workspace" || toolName(request) === "get_issue")
            return Effect.succeed(
              Response.json({
                data: {
                  organization: { id: source.workspaceId, urlKey: "org" },
                  issue: {
                    id: source.issueId,
                    identifier: "LP-1",
                    url: "https://linear.app/org/issue/LP-1",
                  },
                },
              }),
            );
          return Effect.succeed(responses.shift()!);
        },
      });
      return yield* effect.pipe(test.provide);
    });
  return { requests, provide };
}

describe("Linear discussion and images", () => {
  it.effect("returns replies, author/time and an exact next-page cursor", () =>
    Effect.gen(function* () {
      const reply = {
        ...comment("reply"),
        parentId: "parent",
        editedAt: "2026-09-30T12:01:00Z",
        user: null,
      };
      const test = harness([page([reply, comment("parent")], true), page([])]);
      const first = yield* linearDiscussion({ source, accessToken: input.accessToken }).pipe(
        test.provide,
      );
      expect(first.comments[0]).toMatchObject({
        parentId: "parent",
        author: null,
        editedAt: reply.editedAt,
      });
      expect(first.hasMore).toBe(true);
      const next = yield* openLinearReference(first.continuation!).pipe(test.provide);
      expect(next).toMatchObject({ ...source, kind: "comments", after: '{"page":"next-page"}' });
      const last = yield* linearDiscussion({
        source,
        accessToken: input.accessToken,
        ...(next.after ? { after: next.after } : {}),
      }).pipe(test.provide);
      expect(last).toMatchObject({
        status: "available",
        comments: [],
        continuation: null,
        hasMore: false,
      });
      expect(test.requests[1]?.body._tag).toBe("Uint8Array");
    }),
  );

  it.effect("does not advance past comments omitted by the byte budget", () =>
    Effect.gen(function* () {
      const test = harness([
        page([comment("first", "a".repeat(4000)), comment("second", "b".repeat(4000))]),
      ]);
      const result = yield* linearDiscussion({
        source,
        accessToken: input.accessToken,
        byteBudget: 13000,
      }).pipe(test.provide);
      expect(result.comments.map((entry) => entry.id)).toEqual(["first"]);
      expect(result.contentTruncated).toBe(true);
      expect((yield* openLinearReference(result.continuation!).pipe(test.provide)).after).toBe(
        '{"after":"first"}',
      );
      expect(utf8Bytes(result)).toBeLessThan(13000);
    }),
  );

  it.effect("does not return a repeating cursor when no comment fits", () =>
    Effect.gen(function* () {
      const test = harness([page([comment("large")], true)]);
      const failure = yield* linearDiscussion({
        source,
        accessToken: input.accessToken,
        byteBudget: 1,
      }).pipe(test.provide, Effect.flip);
      expect(failure.code).toBe("unavailable");
    }),
  );

  it("clips UTF-8 without splitting a code point", () => {
    const clipped = clipComment("🙂".repeat(2000));
    expect(clipped.bodyTruncated).toBe(true);
    expect(new TextEncoder().encode(clipped.body)).toHaveLength(4096);
    expect(clipped.body).not.toContain("�");
  });

  it.effect("keeps image references bound to the original issue and comment", () =>
    Effect.gen(function* () {
      const test = harness([]);
      const result = yield* linearImageReferences(
        source,
        "![screen](https://uploads.linear.app/a.png)",
        "comment",
      ).pipe(test.provide);
      expect(
        yield* openLinearReference(result.images[0]!.reference).pipe(test.provide),
      ).toMatchObject({ ...source, kind: "image", commentId: "comment" });
      for (const mismatch of [
        { ownerUserId: "other" },
        { workspaceId: "other" },
        { generation: "other" },
      ]) {
        expect(
          (yield* validateLinearSource(source, { ...source, ...mismatch }).pipe(Effect.flip)).code,
        ).toBe("conflict");
      }
      yield* validateLinearSource(source, source);
    }),
  );

  it("extracts reference images and leaves documents, HTML and external images alone", () => {
    expect(
      linearImageUrls(
        '![a][s]\n\n[s]: https://uploads.linear.app/a.png\n\n[file](https://uploads.linear.app/a.pdf)\n![b](https://example.com/b.png)\n<img src="https://uploads.linear.app/c.png">\n`![fake](https://uploads.linear.app/fake.png)`',
      ),
    ).toEqual(["https://uploads.linear.app/a.png"]);
  });

  it.effect("denies comments belonging to another issue", () =>
    Effect.gen(function* () {
      const test = harness([page([{ ...comment("foreign"), issueId: "other" }])]);
      expect((yield* readLinearComments(input).pipe(test.provide, Effect.flip)).code).toBe(
        "unavailable",
      );
    }),
  );

  it.effect("fetches authenticated image bytes", () =>
    Effect.gen(function* () {
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const test = harness([new Response(bytes, { headers: { "content-type": "image/png" } })]);
      expect(
        yield* fetchLinearImage({
          accessToken: input.accessToken,
          url: "https://uploads.linear.app/a.png",
        }).pipe(test.provide),
      ).toEqual({ mimeType: "image/png", data: "iVBORw==" });
      expect(test.requests[0]?.headers.authorization).toBe("Bearer access-secret");
      const request = test.requests.find((request) => toolName(request) === "extract_images");
      if (request?.body._tag !== "Uint8Array") throw new Error("Expected MCP request body");
      expect(yield* decodeJson(new TextDecoder().decode(request.body.body))).toMatchObject({
        params: {
          name: "extract_images",
          arguments: { markdown: "![image](https://uploads.linear.app/a.png)" },
        },
      });
    }),
  );

  it.effect.each([
    "https://attacker.test/image.png",
    "http://uploads.linear.app/a.png",
    "https://user@uploads.linear.app/a.png",
  ])("refuses arbitrary image destinations: %s", (url) =>
    Effect.gen(function* () {
      const test = harness([]);
      expect(
        (yield* fetchLinearImage({ accessToken: input.accessToken, url }).pipe(
          test.provide,
          Effect.flip,
        )).code,
      ).toBe("invalid_input");
      expect(test.requests).toHaveLength(0);
    }),
  );

  it.effect.each([
    {
      response: new Response(null, { status: 302, headers: { location: "https://attacker.test" } }),
      code: "unavailable",
    },
    {
      response: new Response("document", { headers: { "content-type": "application/pdf" } }),
      code: "unsupported_image",
    },
    {
      response: new Response(new Uint8Array(5 * 1024 * 1024 + 1), {
        headers: { "content-type": "image/png" },
      }),
      code: "image_too_large",
    },
    { response: new Response(null, { status: 404 }), code: "not_found" },
    { response: new Response(null, { status: 410 }), code: "not_found" },
  ])("rejects redirects, documents and oversized images %#", ({ response, code }) =>
    Effect.gen(function* () {
      const test = harness([response]);
      expect(
        (yield* fetchLinearImage({
          accessToken: input.accessToken,
          url: "https://uploads.linear.app/a.png",
        }).pipe(test.provide, Effect.flip)).code,
      ).toBe(code);
      expect(test.requests).toHaveLength(1);
    }),
  );
});

it.effect(
  "pages every image without skipping entries and rejects a removed continuation anchor",
  () =>
    Effect.gen(function* () {
      const test = harness([]);
      const urls = Array.from({ length: 12 }, (_, i) => `https://uploads.linear.app/${i}.png`);
      const markdown = urls.map((url) => `![image](${url})`).join("\n");
      const found: string[] = [];
      let afterImage: string | undefined;
      let continuation: string | null = null;
      for (let page = 0; page < 3; page++) {
        const result = yield* linearImageReferences(source, markdown, "comment", afterImage).pipe(
          test.provide,
        );
        found.push(...result.images.map((image) => image.url));
        expect(result.images.length).toBeLessThanOrEqual(5);
        continuation = result.imagesContinuation;
        if (continuation) {
          const reference = yield* openLinearReference(continuation).pipe(test.provide);
          expect(reference).toMatchObject({ ...source, kind: "images", commentId: "comment" });
          afterImage = reference.afterImage;
        }
      }
      expect(found).toEqual(urls);
      expect(continuation).toBeNull();
      const error = yield* linearImageReferences(source, "", "comment", afterImage).pipe(
        test.provide,
        Effect.flip,
      );
      expect(error.code).toBe("conflict");
    }),
);
