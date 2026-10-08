import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { fixture, encodeJson, linearRow } from "./Connections.test-fixture.ts";
import type { ConnectionRecord } from "./ConnectionStore.ts";

const decode = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
      params: Schema.optionalKey(
        Schema.Struct({
          name: Schema.optionalKey(Schema.String),
          arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
      ),
    }),
  ),
);
export const workspace = {
  id: "workspace",
  name: "Launchpad",
  url: "https://linear.app/launchpad",
};
export const issue = {
  id: "LP-42",
  uuid: "issue-id",
  title: "Read this issue",
  description: "Example",
  url: "https://linear.app/launchpad/issue/LP-42",
  status: "In Review",
  assignee: "Alice",
};
export const mcpFixture = Effect.fnUntraced(function* (
  handle: (name: string, args: Record<string, unknown>) => Effect.Effect<unknown> = () =>
    Effect.succeed(undefined),
  toolNames: ReadonlyArray<string> = [],
  rows: ReadonlyArray<ConnectionRecord> = [linearRow()],
) {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const test = yield* fixture({
    rawHttp: true,
    rows,
    respond: (request) =>
      Effect.gen(function* () {
        if (request.method === "GET") return new Response(null, { status: 405 });
        if (request.body._tag !== "Uint8Array") return yield* Effect.die("Missing MCP body");
        const rpc = decode(new TextDecoder().decode(request.body.body));
        if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
        if (rpc.method === "initialize")
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2025-11-25",
              capabilities: { tools: {} },
              serverInfo: { name: "Linear", version: "1" },
            },
          });
        if (rpc.method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: toolNames.map((name) => ({
                name,
                description: name,
                inputSchema: { type: "object" },
              })),
            },
          });
        if (!rpc.params?.name || !rpc.params.arguments)
          return yield* Effect.die("Missing tool parameters");
        calls.push({ name: rpc.params.name, arguments: rpc.params.arguments });
        const response = yield* handle(rpc.params.name, rpc.params.arguments);
        if (response instanceof Response) return response;
        const defaults: Record<string, unknown> = {
          get_workspace: workspace,
          get_user: { id: "account", name: "Alice" },
          get_issue: issue,
          list_issues: { issues: [issue], hasNextPage: false },
          list_comments: { comments: [], hasNextPage: false },
        };
        const value = response ?? defaults[rpc.params.name];
        return Response.json({
          jsonrpc: "2.0",
          id: rpc.id,
          result:
            typeof value === "object" && value !== null && "content" in value
              ? value
              : { content: [{ type: "text", text: encodeJson(value) }] },
        });
      }),
  });
  return { ...test, calls };
});
