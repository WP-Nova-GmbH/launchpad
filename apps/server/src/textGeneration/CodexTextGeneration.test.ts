import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { createModelSelection } from "@t3tools/shared/model";
import { expect } from "vite-plus/test";
import { FetchHttpClient } from "effect/unstable/http";

import { CodexSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import {
  ThreadVmCodexAuthSourceError,
  type ManagedThreadVmCodexAuthContext,
} from "../relay/ThreadVmCodexAuthSource.ts";
import { writeFakeCli } from "../testUtils/fakeCli.ts";
import { WorkflowVmGuest } from "../vmWorkloadCommand.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sse = (event: unknown) => `data: ${encodeJson(event)}\n\n`;
const completedApproval = (content: ReadonlyArray<unknown>) =>
  sse({
    type: "response.completed",
    response: {
      status: "completed",
      output: [{ type: "reasoning" }, { type: "message", role: "assistant", content }],
    },
  });

const DEFAULT_TEST_MODEL_SELECTION = createModelSelection(
  ProviderInstanceId.make("codex"),
  "gpt-5.4-mini",
);

const CodexTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-codex-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakeCodexInput {
  output: string;
  exitCode?: number;
  stderr?: string;
  requireImage?: boolean;
  requireServiceTier?: string;
  requireReasoningEffort?: string;
  forbidReasoningEffort?: boolean;
  requireArg?: string;
  forbidArg?: string;
  stdinMustContain?: string;
  stdinMustNotContain?: string;
}

// The stub walks argv the way the shell script it replaced did: `--image`,
// `--config key=value`, and `--output-last-message <path>` are consumed, the
// prompt arrives on stdin, and each check exits with its own code so a
// failing test names the assertion that tripped.
function makeFakeCodexBinary(dir: string, input: FakeCodexInput) {
  const check = JSON.stringify({
    requireImage: input.requireImage ?? false,
    requireServiceTier: input.requireServiceTier ?? null,
    requireReasoningEffort: input.requireReasoningEffort ?? null,
    forbidReasoningEffort: input.forbidReasoningEffort ?? false,
    requireArg: input.requireArg ?? null,
    forbidArg: input.forbidArg ?? null,
    stdinMustContain: input.stdinMustContain ?? null,
    stdinMustNotContain: input.stdinMustNotContain ?? null,
    stderr: input.stderr ?? null,
    output: input.output,
    exitCode: input.exitCode ?? 0,
  });
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    return writeFakeCli({
      directory: path.join(dir, "bin"),
      name: "codex",
      source: [
        'import * as NodeFS from "node:fs";',
        `const check = ${check};`,
        "const args = process.argv.slice(2);",
        'const originalArgs = ` ${args.join(" ")} `;',
        "let outputPath = null;",
        "let seenImage = false;",
        'let seenServiceTier = "";',
        'let seenReasoningEffort = "";',
        "for (let index = 0; index < args.length; index += 1) {",
        '  if (args[index] === "--image") {',
        "    index += 1;",
        "    if (args[index]) seenImage = true;",
        '  } else if (args[index] === "--config") {',
        "    index += 1;",
        '    const value = args[index] ?? "";',
        '    if (value.startsWith("service_tier=")) seenServiceTier = value;',
        '    if (value.startsWith("model_reasoning_effort=")) seenReasoningEffort = value;',
        '  } else if (args[index] === "--output-last-message") {',
        "    index += 1;",
        "    outputPath = args[index] ?? null;",
        "  }",
        "}",
        "const chunks = [];",
        "for await (const chunk of process.stdin) chunks.push(chunk);",
        'const stdinContent = Buffer.concat(chunks).toString("utf8");',
        "function fail(message, code) {",
        '  process.stderr.write(message + "\\n");',
        "  process.exit(code);",
        "}",
        "if (check.requireArg !== null && !originalArgs.includes(` ${check.requireArg} `)) {",
        '  fail("missing arg: " + check.requireArg, 8);',
        "}",
        "if (check.forbidArg !== null && originalArgs.includes(` ${check.forbidArg} `)) {",
        '  fail("forbidden arg: " + check.forbidArg, 9);',
        "}",
        'if (check.requireImage && !seenImage) fail("missing --image input", 2);',
        "if (",
        "  check.requireServiceTier !== null &&",
        '  seenServiceTier !== `service_tier="${check.requireServiceTier}"`',
        ") {",
        '  fail("unexpected service tier config: " + seenServiceTier, 5);',
        "}",
        "if (",
        "  check.requireReasoningEffort !== null &&",
        '  seenReasoningEffort !== `model_reasoning_effort="${check.requireReasoningEffort}"`',
        ") {",
        '  fail("unexpected reasoning effort config: " + seenReasoningEffort, 6);',
        "}",
        "if (check.forbidReasoningEffort && seenReasoningEffort.length > 0) {",
        '  fail("reasoning effort config should be omitted: " + seenReasoningEffort, 7);',
        "}",
        "if (check.stdinMustContain !== null && !stdinContent.includes(check.stdinMustContain)) {",
        '  fail("stdin missing expected content", 3);',
        "}",
        "if (check.stdinMustNotContain !== null && stdinContent.includes(check.stdinMustNotContain)) {",
        '  fail("stdin contained forbidden content", 4);',
        "}",
        'if (check.stderr !== null) process.stderr.write(check.stderr + "\\n");',
        'if (outputPath !== null) NodeFS.writeFileSync(outputPath, check.output + "\\n");',
        "process.exitCode = check.exitCode;",
        "",
      ].join("\n"),
    });
  });
}

function withFakeCodexEnv<A, E, R>(
  input: FakeCodexInput & {
    launchArgs?: string;
    environment?: NodeJS.ProcessEnv;
    models?: ReadonlyArray<string>;
    managedAuth?: ManagedThreadVmCodexAuthContext;
    authPreflight?: Effect.Effect<void, ThreadVmCodexAuthSourceError>;
  },
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-codex-text-" });
    const codexPath = yield* makeFakeCodexBinary(tempDir, input);
    const config = decodeCodexSettings({ binaryPath: codexPath, launchArgs: input.launchArgs });
    const textGeneration = yield* makeCodexTextGeneration(
      config,
      input.environment,
      Effect.succeed(
        (input.models ?? []).map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
      ),
      input.managedAuth,
      input.authPreflight,
    );
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

it.layer(CodexTextGenerationTestLayer)("CodexTextGeneration", (it) => {
  const approval = {
    cwd: "/untrusted-workflow-repository",
    toolKind: "command",
    requestType: "command_execution_approval",
    requestDetail: "Run repository tests",
    stepInstruction: "Fix the failing test",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
  } as const;
  const supervisor = (mintToken?: ManagedThreadVmCodexAuthContext["mintToken"]) =>
    makeCodexTextGeneration(
      decodeCodexSettings({ binaryPath: "/must-not-spawn-codex-for-supervisor" }),
      { OPENAI_BASE_URL: "https://repo-config.invalid" },
      Effect.succeed([]),
      {
        connectionId: "connection",
        label: "Organization account",
        status: Effect.die("No separate status probe required"),
        preflight: Effect.void,
        ...(mintToken ? { mintToken } : {}),
      },
    ).pipe(Effect.provideService(WorkflowVmGuest, true));

  it.effect.each(["text/event-stream", "Text/Event-Stream ; charset=utf-8", undefined] as const)(
    "uses coordinator transport and a fragmented completed approval with Content-Type %s",
    (contentType) =>
      Effect.gen(function* () {
        let minted = 0;
        const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];
        const generation = yield* supervisor(
          Effect.sync(() => {
            minted++;
            return Redacted.make("supervisor-fixture-token");
          }),
        );
        const result = yield* generation.generateApprovalVerdict(approval).pipe(
          Effect.provideService(FetchHttpClient.Fetch, async (url, init) => {
            requests.push({ url: String(url), init });
            const body = new TextEncoder().encode(
              [
                sse({ type: "response.output_text.delta", delta: '{"verdict":"deny"}' }),
                completedApproval([
                  {
                    type: "output_text",
                    text: encodeJson({ verdict: "approve", reasoning: "In scope." }),
                  },
                ]),
              ].join(""),
            );
            return new Response(
              new ReadableStream({
                start(controller) {
                  for (let offset = 0; offset < body.length; offset += 7)
                    controller.enqueue(body.subarray(offset, offset + 7));
                  controller.close();
                },
              }),
              { headers: contentType === undefined ? {} : { "content-type": contentType } },
            );
          }),
        );
        expect(minted).toBe(1);
        expect(requests).toHaveLength(1);
        const request = requests[0]!;
        expect(request.url).toBe("https://api.openai.com/v1/responses");
        expect(request.init?.method).toBe("POST");
        expect(request.init?.redirect).toBe("manual");
        expect(new Headers(request.init?.headers).get("authorization")).toBe(
          "Bearer supervisor-fixture-token",
        );
        const body = yield* Effect.promise(() => new Response(request.init?.body).text());
        expect(decodeJson(body)).toMatchObject({
          model: "gpt-6-astra",
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: expect.stringContaining("Run repository tests") },
              ],
            },
          ],
          tools: [],
          tool_choice: "none",
          store: false,
          stream: true,
          reasoning: { effort: "low" },
          text: {
            format: {
              type: "json_schema",
              name: "workflow_approval_verdict",
              strict: true,
              schema: {
                type: "object",
                required: ["verdict", "reasoning"],
                additionalProperties: false,
              },
            },
          },
        });
        expect(result).toEqual({ verdict: "approve", reasoning: "In scope." });
      }),
  );

  it.effect("fails closed when isolated approval inference has no coordinator credential", () =>
    Effect.gen(function* () {
      const generation = yield* supervisor();
      const error = yield* generation.generateApprovalVerdict(approval).pipe(
        Effect.provideService(FetchHttpClient.Fetch, () => {
          throw new Error("No network request expected");
        }),
        Effect.flip,
      );
      expect(error.detail).toBe(TextGeneration.WORKFLOW_APPROVAL_FAILURE_DETAILS.credential);
    }),
  );

  const approvalReasoningItem = { id: "reasoning-1", type: "reasoning" };
  const approvalMessageItem = {
    id: "message-1",
    type: "message",
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [
      { type: "output_text", text: encodeJson({ verdict: "approve", reasoning: "In scope." }) },
    ],
  };
  const outputItem = (type: "added" | "done", output_index: number, item: unknown) =>
    sse({ type: `response.output_item.${type}`, output_index, item });
  const completedOutput = (output: ReadonlyArray<unknown>) =>
    sse({ type: "response.completed", response: { status: "completed", output } });

  it.effect.each(["sparse", "snapshot"] as const)(
    "uses completed item receipts with a %s completion and no Content-Type",
    (completion) =>
      Effect.gen(function* () {
        const generation = yield* supervisor(Effect.succeed(Redacted.make("fixture-token")));
        const result = yield* generation.generateApprovalVerdict(approval).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            async () =>
              new Response(
                new TextEncoder().encode(
                  [
                    outputItem("added", 0, approvalReasoningItem),
                    outputItem("done", 0, approvalReasoningItem),
                    outputItem("added", 1, {
                      ...approvalMessageItem,
                      status: "in_progress",
                      content: [],
                    }),
                    sse({ type: "response.output_text.delta", delta: '{"verdict":"deny"}' }),
                    sse({
                      type: "response.content_part.done",
                      output_index: 1,
                      content_index: 0,
                      item_id: approvalMessageItem.id,
                      part: approvalMessageItem.content[0],
                    }),
                    outputItem("done", 1, approvalMessageItem),
                    completedOutput(
                      completion === "sparse" ? [] : [approvalReasoningItem, approvalMessageItem],
                    ),
                  ].join(""),
                ),
              ),
          ),
        );
        expect(result).toEqual({ verdict: "approve", reasoning: "In scope." });
      }),
  );

  it.effect.each([
    ["duplicate-index", "conflictingOutput"],
    ["duplicate-id", "conflictingOutput"],
    ["duplicate-added", "conflictingOutput"],
    ["changed-added-id", "conflictingOutput"],
    ["cross-index-added-done", "conflictingOutput"],
    ["cross-index-done-added", "conflictingOutput"],
    ["negative-index", "outputItem"],
    ["missing-id", "outputItem"],
    ["missing-index", "outputItem"],
    ["unfinished-message", "outputItem"],
    ["unsupported-item", "outputItem"],
    ["refusal", "refusal"],
    ["delta-only", "output"],
    ["no-terminal", "missingTerminal"],
    ["unfinished-added", "outputItem"],
    ["conflicting-snapshot", "conflictingOutput"],
    ["unfinished-snapshot", "outputItem"],
    ["duplicate-snapshot-id", "conflictingOutput"],
    ["multiple-messages", "output"],
  ] as const)(
    "rejects ambiguous or incomplete completed-item receipts: %s",
    ([outcome, failureKind]) =>
      Effect.gen(function* () {
        const generation = yield* supervisor(Effect.succeed(Redacted.make("fixture-token")));
        const reasoning = outputItem("done", 0, approvalReasoningItem);
        const message = outputItem("done", 1, approvalMessageItem);
        let events = [reasoning, message];
        let terminal = completedOutput([]);
        switch (outcome) {
          case "duplicate-index":
            events = [reasoning, reasoning, message];
            break;
          case "duplicate-id":
            events = [
              reasoning,
              outputItem("done", 1, { ...approvalMessageItem, id: approvalReasoningItem.id }),
            ];
            break;
          case "duplicate-added":
            events = [
              outputItem("added", 0, approvalReasoningItem),
              outputItem("added", 0, approvalReasoningItem),
            ];
            break;
          case "changed-added-id":
            events = [
              reasoning,
              outputItem("added", 1, { ...approvalMessageItem, id: "other-message" }),
              message,
            ];
            break;
          case "cross-index-added-done":
            events = [
              outputItem("added", 0, approvalReasoningItem),
              outputItem("done", 1, { ...approvalMessageItem, id: approvalReasoningItem.id }),
            ];
            terminal = completedOutput([
              approvalReasoningItem,
              { ...approvalMessageItem, id: approvalReasoningItem.id },
            ]);
            break;
          case "cross-index-done-added":
            events = [
              outputItem("done", 1, { ...approvalMessageItem, id: approvalReasoningItem.id }),
              outputItem("added", 0, approvalReasoningItem),
            ];
            terminal = completedOutput([
              approvalReasoningItem,
              { ...approvalMessageItem, id: approvalReasoningItem.id },
            ]);
            break;
          case "negative-index":
            events = [outputItem("done", -1, approvalMessageItem)];
            break;
          case "missing-id":
            events = [outputItem("done", 0, { type: "reasoning" })];
            break;
          case "missing-index":
            events = [message];
            break;
          case "unfinished-message":
            events = [
              reasoning,
              outputItem("done", 1, { ...approvalMessageItem, status: "incomplete" }),
            ];
            break;
          case "unsupported-item":
            events = [outputItem("done", 0, { id: "tool-1", type: "function_call" })];
            break;
          case "refusal":
            events = [
              reasoning,
              outputItem("done", 1, {
                ...approvalMessageItem,
                content: [{ type: "refusal", refusal: "private refusal sentinel" }],
              }),
            ];
            break;
          case "delta-only":
            events = [
              sse({
                type: "response.output_text.delta",
                delta: encodeJson({ verdict: "approve", reasoning: "In scope." }),
              }),
            ];
            break;
          case "no-terminal":
            terminal = "";
            break;
          case "unfinished-added":
            events = [
              reasoning,
              outputItem("added", 1, {
                ...approvalMessageItem,
                status: "in_progress",
                content: [],
              }),
            ];
            break;
          case "conflicting-snapshot":
            terminal = completedOutput([
              approvalReasoningItem,
              {
                ...approvalMessageItem,
                content: [
                  {
                    type: "output_text",
                    text: encodeJson({ verdict: "deny", reasoning: "Out of scope." }),
                  },
                ],
              },
            ]);
            break;
          case "unfinished-snapshot":
            events = [];
            terminal = completedOutput([
              approvalReasoningItem,
              { ...approvalMessageItem, status: "incomplete" },
            ]);
            break;
          case "duplicate-snapshot-id":
            events = [];
            terminal = completedOutput([
              approvalReasoningItem,
              { ...approvalMessageItem, id: approvalReasoningItem.id },
            ]);
            break;
          case "multiple-messages":
            events = [
              reasoning,
              message,
              outputItem("done", 2, { ...approvalMessageItem, id: "message-2" }),
            ];
            break;
        }
        const error = yield* generation.generateApprovalVerdict(approval).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            async () => new Response(new TextEncoder().encode([...events, terminal].join(""))),
          ),
          Effect.flip,
        );
        expect(error.detail).toBe(TextGeneration.WORKFLOW_APPROVAL_FAILURE_DETAILS[failureKind]);
        expect(encodeJson(error)).not.toContain("private refusal sentinel");
      }),
  );

  it.effect.each([
    ["redirect", "http", true],
    ["content-type", "contentType", true],
    ["missing-terminal", "missingTerminal", true],
    ["malformed-terminal", "malformedTerminal", true],
    ["failed", "failed", true],
    ["incomplete", "incomplete", true],
    ["error", "upstreamError", true],
    ["refusal", "refusal", true],
    ["output-shape", "output", true],
    ["verdict-json", "verdictJson", true],
    ["verdict-schema", "verdictSchema", true],
    ["malformed-event", "stream", true],
    ["stream-failure", "stream", true],
    ["transport", "transport", true],
    ["missing-terminal", "missingTerminal", false],
    ["malformed-terminal", "malformedTerminal", false],
    ["incomplete", "incomplete", false],
    ["refusal", "refusal", false],
    ["malformed-event", "stream", false],
  ] as const)(
    "rejects an isolated approval %s without exposing upstream details",
    ([outcome, failureKind, declaredContentType]) =>
      Effect.gen(function* () {
        let forwarded = 0;
        let signal: AbortSignal | null | undefined;
        const logs: unknown[] = [];
        const logger = Logger.make(({ message }) => logs.push(message));
        const generation = yield* supervisor(Effect.succeed(Redacted.make("fixture-token")));
        const error = yield* generation
          .generateApprovalVerdict({
            ...approval,
            requestDetail: "private request sentinel",
          })
          .pipe(
            Effect.provideService(FetchHttpClient.Fetch, async (_url, init) => {
              forwarded++;
              signal = init?.signal;
              expect(init?.redirect).toBe("manual");
              if (outcome === "redirect")
                return new Response("private upstream details", {
                  status: 307,
                  headers: { location: "https://redirect.invalid" },
                });
              if (outcome === "content-type")
                return new Response(
                  completedApproval([
                    {
                      type: "output_text",
                      text: encodeJson({ verdict: "approve", reasoning: "In scope." }),
                    },
                  ]),
                  { headers: { "content-type": "application/json" } },
                );
              if (outcome === "transport") throw new Error("private upstream details");
              if (outcome === "stream-failure")
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.error(new Error("private upstream details"));
                    },
                  }),
                  { headers: { "content-type": "text/event-stream" } },
                );
              const body =
                outcome === "missing-terminal"
                  ? sse({ type: "response.output_text.delta", delta: "private upstream details" })
                  : outcome === "malformed-terminal"
                    ? sse({ type: "response.completed", response: { status: "completed" } })
                    : outcome === "failed" || outcome === "incomplete" || outcome === "error"
                      ? sse({
                          type: outcome === "error" ? "error" : `response.${outcome}`,
                          message: "private upstream details",
                        })
                      : outcome === "refusal"
                        ? completedApproval([
                            { type: "refusal", refusal: "private upstream details" },
                          ])
                        : outcome === "output-shape"
                          ? completedApproval([])
                          : outcome === "malformed-event"
                            ? "data: private upstream details\n\n"
                            : completedApproval([
                                {
                                  type: "output_text",
                                  text:
                                    outcome === "verdict-json"
                                      ? "private upstream details"
                                      : encodeJson({
                                          verdict: "approve",
                                          reasoning: "private upstream details",
                                          unexpected: "private upstream details",
                                        }),
                                },
                              ]);
              const responseBody =
                outcome === "missing-terminal"
                  ? body
                  : body +
                    completedApproval([
                      {
                        type: "output_text",
                        text: encodeJson({ verdict: "approve", reasoning: "In scope." }),
                      },
                    ]);
              return new Response(
                declaredContentType ? responseBody : new TextEncoder().encode(responseBody),
                { headers: declaredContentType ? { "content-type": "text/event-stream" } : {} },
              );
            }),
            Effect.flip,
            Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          );
        expect(forwarded).toBe(1);
        expect(signal?.aborted).toBe(true);
        expect(error.detail).toBe(TextGeneration.WORKFLOW_APPROVAL_FAILURE_DETAILS[failureKind]);
        const saved = encodeJson({ error, logs });
        for (const privateText of [
          "private upstream details",
          "private request sentinel",
          "fixture-token",
        ])
          expect(saved).not.toContain(privateText);
      }),
  );

  it.effect(
    "pins structured text generation to the managed helper after conflicting environment flags",
    () =>
      withFakeCodexEnv(
        {
          output: '{"title":"Managed title"}',
          requireArg: 'model_provider="launchpad_vm"',
          environment: { ...process.env, T3CODE_CODEX_LAUNCH_ARGS: '-c model_provider="personal"' },
          managedAuth: {
            connectionId: "connection",
            label: "Organization account",
            status: Effect.die("No status probe required"),
            preflight: Effect.void,
          },
        },
        (generation) =>
          generation.generateThreadTitle({
            cwd: process.cwd(),
            message: "Title",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-luna"),
          }),
      ),
  );

  it.effect("blocks new auxiliary inference after central disconnection", () =>
    withFakeCodexEnv(
      {
        output: '{"title":"must-not-be-generated"}',
        managedAuth: {
          connectionId: "connection",
          label: "Organization account",
          status: Effect.die("No status probe required"),
          preflight: Effect.fail(
            new ThreadVmCodexAuthSourceError({ reason: "reconnect_required" }),
          ),
        },
      },
      (generation) =>
        Effect.gen(function* () {
          const error = yield* generation
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Title",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-luna"),
            })
            .pipe(Effect.flip);
          expect(error.detail).toContain("Reconnect the organization's Codex");
        }),
    ),
  );

  it.effect("requires an explicitly supported auxiliary model", () =>
    withFakeCodexEnv(
      {
        output: '{"title":"must-not-be-generated"}',
        managedAuth: {
          connectionId: "connection",
          label: "Organization account",
          status: Effect.die("No status probe required"),
          preflight: Effect.die("Unsupported model must fail before token lookup"),
        },
      },
      (generation) =>
        Effect.gen(function* () {
          const error = yield* generation
            .generateThreadTitle({
              cwd: process.cwd(),
              message: "Title",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.5"),
            })
            .pipe(Effect.flip);
          expect(error.detail).toContain("Select a supported model");
        }),
    ),
  );

  it.effect(
    "blocks a captured personal provider after the VM switches to organization sign-in",
    () =>
      withFakeCodexEnv(
        {
          output: '{"title":"must-not-be-generated"}',
          authPreflight: Effect.fail(
            new ThreadVmCodexAuthSourceError({ reason: "selection_changed" }),
          ),
        },
        (generation) =>
          Effect.gen(function* () {
            const error = yield* generation
              .generateThreadTitle({
                cwd: process.cwd(),
                message: "Title",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.flip);
            expect(error.detail).toContain("selection changed");
          }),
      ),
  );

  it.effect("forwards workflow approval context into the actual model prompt", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ verdict: "approve", reasoning: "In scope" }),
        stdinMustContain:
          "Job context:\nFix JOB_CONTEXT\n\nRequired review constraint:\nREVIEW_REQUIRED",
      },
      (textGeneration) =>
        textGeneration.generateApprovalVerdict({
          cwd: process.cwd(),
          toolKind: "command",
          requestType: "command_execution_approval",
          stepInstruction: "s".repeat(5_000),
          jobContext: "Fix JOB_CONTEXT",
          reviewConstraint: "REVIEW_REQUIRED",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );
  for (const selectedModel of ["gpt-5.6-luna", "openai.gpt-5.6-luna"]) {
    it.effect(`dispatches the qualified live model for ${selectedModel}`, () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({ title: "Bedrock title" }),
          models: ["openai.gpt-5.6-luna"],
          requireArg: "--model openai.gpt-5.6-luna",
          forbidArg: "--model gpt-5.6-luna",
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Describe this change",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), selectedModel),
            });
            expect(result.title).toBe("Bedrock title");
          }),
      ),
    );
  }
  it.effect("generates and sanitizes commit messages without branch by default", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject:
            "  Add important change to the system with too much detail and a trailing period.\nsecondary line",
          body: "\n- added migration\n- updated tests\n",
        }),
        stdinMustNotContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject.length).toBeLessThanOrEqual(72);
          expect(generated.subject.endsWith(".")).toBe(false);
          expect(generated.body).toBe("- added migration\n- updated tests");
          expect(generated.branch).toBeUndefined();
        }),
    ),
  );

  it.effect(
    "forwards codex service tier and non-default reasoning effort into codex exec config",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            subject: "Add important change",
            body: "",
          }),
          requireServiceTier: "priority",
          requireReasoningEffort: "xhigh",
          stdinMustNotContain: "branch must be a short semantic git branch fragment",
        },
        (textGeneration) =>
          textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ]),
          }),
      ),
  );

  it.effect("passes exec-safe launch args into codex exec", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--strict-config --listen off",
        requireArg: "--strict-config",
        forbidArg: "--listen",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("uses T3CODE_CODEX_LAUNCH_ARGS for codex exec over settings", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        launchArgs: "--enable settings-feature",
        environment: { ...process.env, T3CODE_CODEX_LAUNCH_ARGS: " --strict-config --listen off " },
        requireArg: "--strict-config",
        forbidArg: "settings-feature",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("defaults git text generation codex effort to low", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
        }),
        requireReasoningEffort: "low",
      },
      (textGeneration) =>
        textGeneration.generateCommitMessage({
          cwd: process.cwd(),
          branch: "feature/codex-effect",
          stagedSummary: "M README.md",
          stagedPatch: "diff --git a/README.md b/README.md",
          modelSelection: DEFAULT_TEST_MODEL_SELECTION,
        }),
    ),
  );

  it.effect("generates commit message with branch when includeBranch is true", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          subject: "Add important change",
          body: "",
          branch: "fix/important-system-change",
        }),
        stdinMustContain: "branch must be a short semantic git branch fragment",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/codex-effect",
            stagedSummary: "M README.md",
            stagedPatch: "diff --git a/README.md b/README.md",
            includeBranch: true,
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.subject).toBe("Add important change");
          expect(generated.branch).toBe("feature/fix/important-system-change");
        }),
    ),
  );

  it.effect("generates PR content and trims markdown body", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: "  Improve orchestration flow\nwith ignored suffix",
          body: "\n## Summary\n- improve flow\n\n## Testing\n- bun test\n\n",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generatePrContent({
            cwd: process.cwd(),
            baseBranch: "main",
            headBranch: "feature/codex-effect",
            commitSummary: "feat: improve orchestration flow",
            diffSummary: "2 files changed",
            diffPatch: "diff --git a/a.ts b/a.ts",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("Improve orchestration flow");
          expect(generated.body.startsWith("## Summary")).toBe(true);
          expect(generated.body.endsWith("\n\n")).toBe(false);
        }),
    ),
  );

  it.effect("generates branch names and normalizes branch fragments", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "  Feat/Session  ",
        }),
        stdinMustNotContain: "Image attachments supplied to the model",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Please update session handling.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("feat/session");
        }),
    ),
  );

  it.effect("generates thread titles and trims them for sidebar use", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title:
            '  "Investigate websocket reconnect regressions after worktree restore"  \nignored line',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Please investigate websocket reconnect regressions after a worktree restore.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe(
            "Investigate websocket reconnect regressions after worktree restore",
          );
        }),
    ),
  );

  it.effect("returns the refinement signal for an unresolved subject", () =>
    withFakeCodexEnv(
      { output: JSON.stringify({ title: "Investigate issue", needsRefinement: true }) },
      (textGeneration) =>
        Effect.gen(function* () {
          expect(
            yield* textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "Fix this",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            }),
          ).toEqual({ title: "Investigate issue", needsRefinement: true });
        }),
    ),
  );

  it.effect("falls back when thread title normalization becomes whitespace-only", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: '  """   """  ',
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("New thread");
        }),
    ),
  );

  it.effect("trims whitespace exposed after quote removal in thread titles", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          title: `  "' hello world '"  `,
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "Name this thread.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.title).toBe("hello world");
        }),
    ),
  );

  it.effect("omits attachment metadata section when no attachments are provided", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/session-timeout",
        }),
        stdinMustNotContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateBranchName({
            cwd: process.cwd(),
            message: "Fix timeout behavior.",
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
          });

          expect(generated.branch).toBe("fix/session-timeout");
        }),
    ),
  );

  it.effect("passes image attachments through as codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
        stdinMustContain: "Attachment metadata:",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-branch-image-attachment";
          const attachmentPath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(attachmentPath, Buffer.from("hello"));

          const generated = yield* textGeneration.generateBranchName({
            modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            cwd: process.cwd(),
            message: "Fix layout bug from screenshot.",
            attachments: [
              {
                type: "image",
                id: attachmentId,
                name: "bug.png",
                mimeType: "image/png",
                sizeBytes: 5,
              },
            ],
          });

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("resolves persisted attachment ids to files for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const attachmentId = "thread-1-attachment";
          const imagePath = path.join(attachmentsDir, `${attachmentId}.png`);
          yield* fs.makeDirectory(attachmentsDir, { recursive: true });
          yield* fs.writeFile(imagePath, Buffer.from("hello"));

          const generated = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: attachmentId,
                  name: "bug.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(
              Effect.tap(() =>
                fs.stat(imagePath).pipe(
                  Effect.map((fileInfo) => {
                    expect(fileInfo.type).toBe("File");
                  }),
                ),
              ),
              Effect.ensuring(fs.remove(imagePath).pipe(Effect.ignore)),
            );

          expect(generated.branch).toBe("fix/ui-regression");
        }),
    ),
  );

  it.effect("ignores missing attachment ids for codex image inputs", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({
          branch: "fix/ui-regression",
        }),
        requireImage: true,
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { attachmentsDir } = yield* ServerConfig.ServerConfig;
          const missingAttachmentId = "thread-missing-attachment";
          const missingPath = path.join(attachmentsDir, `${missingAttachmentId}.png`);
          yield* fs.remove(missingPath).pipe(Effect.ignore);

          const result = yield* textGeneration
            .generateBranchName({
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              cwd: process.cwd(),
              message: "Fix layout bug from screenshot.",
              attachments: [
                {
                  type: "image",
                  id: missingAttachmentId,
                  name: "outside.png",
                  mimeType: "image/png",
                  sizeBytes: 5,
                },
              ],
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain("missing --image input");
          }
        }),
    ),
  );

  it.effect(
    "fails with typed TextGenerationError when codex returns wrong branch payload shape",
    () =>
      withFakeCodexEnv(
        {
          output: JSON.stringify({
            title: "This is not a branch payload",
          }),
        },
        (textGeneration) =>
          Effect.gen(function* () {
            const result = yield* textGeneration
              .generateBranchName({
                cwd: process.cwd(),
                message: "Fix websocket reconnect flake",
                modelSelection: DEFAULT_TEST_MODEL_SELECTION,
              })
              .pipe(Effect.result);

            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure).toBeInstanceOf(TextGenerationError);
              expect(result.failure.message).toContain("Codex returned invalid structured output");
            }
          }),
      ),
  );

  it.effect("returns typed TextGenerationError when codex exits non-zero", () =>
    withFakeCodexEnv(
      {
        output: JSON.stringify({ subject: "ignored", body: "" }),
        exitCode: 1,
        stderr: "codex execution failed",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const result = yield* textGeneration
            .generateCommitMessage({
              cwd: process.cwd(),
              branch: "feature/codex-error",
              stagedSummary: "M README.md",
              stagedPatch: "diff --git a/README.md b/README.md",
              modelSelection: DEFAULT_TEST_MODEL_SELECTION,
            })
            .pipe(Effect.result);

          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure).toBeInstanceOf(TextGenerationError);
            expect(result.failure.message).toContain(
              "Codex CLI command failed: codex execution failed",
            );
          }
        }),
    ),
  );
});
