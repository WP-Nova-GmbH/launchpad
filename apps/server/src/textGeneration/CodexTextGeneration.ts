import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  type CodexSettings,
  DEFAULT_TEXT_GENERATION_REASONING_EFFORT,
  type ModelSelection,
  type ServerProviderModel,
  TextGenerationError,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath } from "../pathExpansion.ts";
import {
  managedCodexModelIssue,
  codexExecLaunchArgs,
  resolveCodexLaunchArgs,
} from "../provider/Layers/codexLaunchArgs.ts";
import type {
  ManagedThreadVmCodexAuthContext,
  ThreadVmCodexAuthSourceError,
} from "../relay/ThreadVmCodexAuthSource.ts";
import { WorkflowVmGuest } from "../vmWorkloadCommand.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildApprovalVerdictPrompt,
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
  toJsonSchemaObject,
} from "./TextGenerationUtils.ts";
import { codexModelFamily, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../codexModelOptions.ts";

const CODEX_TIMEOUT_MS = 180_000;
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApprovalResponseTerminal = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("response.completed"),
        response: Schema.Struct({
          status: Schema.Literal("completed"),
          output: Schema.Array(Schema.Unknown),
        }),
      }),
      Schema.Struct({ type: Schema.Literals(["response.failed", "response.incomplete", "error"]) }),
    ]),
  ),
);
const isAssistantMessage = Schema.is(
  Schema.Struct({
    type: Schema.Literal("message"),
    role: Schema.Literal("assistant"),
    content: Schema.Array(Schema.Unknown),
  }),
);
const isOutputText = Schema.is(
  Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }),
);
/**
 * Build a Codex text-generation closure bound to a specific `CodexSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
export const makeCodexTextGeneration = Effect.fn("makeCodexTextGeneration")(function* (
  codexConfig: CodexSettings,
  environment?: NodeJS.ProcessEnv,
  getModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  managedAuth?: ManagedThreadVmCodexAuthContext,
  authPreflight?: Effect.Effect<void, ThreadVmCodexAuthSourceError>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* Effect.service(ServerConfig.ServerConfig);
  const resolvedEnvironment = environment ?? process.env;
  const workflowGuest = yield* WorkflowVmGuest;

  const resolveModel = Effect.fnUntraced(function* (
    operation: string,
    modelSelection: ModelSelection,
  ) {
    const models = yield* getModels;
    const requestedModel = modelSelection.model;
    const model =
      models.find((candidate) => candidate.slug === requestedModel)?.slug ??
      models.find(
        (candidate) => !candidate.isCustom && codexModelFamily(candidate.slug) === requestedModel,
      )?.slug ??
      requestedModel;
    if (managedAuth) {
      const issue = managedCodexModelIssue(model);
      if (issue) return yield* new TextGenerationError({ operation, detail: issue });
    }
    yield* (authPreflight ?? managedAuth?.preflight ?? Effect.void).pipe(
      Effect.mapError((error) => new TextGenerationError({ operation, detail: error.message })),
    );
    return model;
  });

  type MaterializedImageAttachments = {
    readonly imagePaths: ReadonlyArray<string>;
  };

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("codex", operation, cause, "Failed to collect process output"),
      ),
    );

  const writeTempFile = (
    operation: string,
    prefix: string,
    content: string,
  ): Effect.Effect<string, TextGenerationError, Scope.Scope> =>
    fileSystem
      .makeTempFileScoped({
        prefix: `t3code-${prefix}-${process.pid}-`,
      })
      .pipe(
        Effect.tap((filePath) => fileSystem.writeFileString(filePath, content)),
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: `Failed to write temp file`,
              cause,
            }),
        ),
      );

  const safeUnlink = (filePath: string): Effect.Effect<void, never> =>
    fileSystem.remove(filePath).pipe(Effect.ignore);

  const encodeJsonForOperation = (
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateApprovalVerdict",
    value: unknown,
  ): Effect.Effect<string, TextGenerationError> =>
    encodeJsonString(value).pipe(
      Effect.mapError(
        (cause) =>
          new TextGenerationError({
            operation,
            detail: "Failed to encode structured output schema.",
            cause,
          }),
      ),
    );

  const materializeImageAttachments = Effect.fn("materializeImageAttachments")(function* (
    _operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateApprovalVerdict",
    attachments: TextGeneration.BranchNameGenerationInput["attachments"],
  ): Effect.fn.Return<MaterializedImageAttachments, TextGenerationError> {
    if (!attachments || attachments.length === 0) {
      return { imagePaths: [] };
    }

    const imagePaths: string[] = [];
    for (const attachment of attachments) {
      if (attachment.type !== "image") {
        continue;
      }

      const resolvedPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!resolvedPath || !path.isAbsolute(resolvedPath)) {
        continue;
      }
      const fileInfo = yield* fileSystem.stat(resolvedPath).pipe(Effect.orElseSucceed(() => null));
      if (!fileInfo || fileInfo.type !== "File") {
        continue;
      }
      imagePaths.push(resolvedPath);
    }
    return { imagePaths };
  });

  const runCodexJson = Effect.fn("runCodexJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    imagePaths = [],
    cleanupPaths = [],
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateApprovalVerdict";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    imagePaths?: ReadonlyArray<string>;
    cleanupPaths?: ReadonlyArray<string>;
    modelSelection: ModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const schemaJson = yield* encodeJsonForOperation(
      operation,
      toJsonSchemaObject(outputSchemaJson),
    );
    const schemaPath = yield* writeTempFile(operation, "codex-schema", schemaJson);
    const outputPath = yield* writeTempFile(operation, "codex-output", "");

    const runCodexCommand = Effect.fn("runCodexJson.runCodexCommand")(function* () {
      const model = yield* resolveModel(operation, modelSelection);
      const launchArgs = resolveCodexLaunchArgs(codexConfig.launchArgs, resolvedEnvironment);
      const reasoningEffort =
        getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
        DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
      const serviceTier = getCodexServiceTierOptionValue(modelSelection);
      const spawnCommand = yield* resolveSpawnCommand(
        codexConfig.binaryPath || "codex",
        [
          "exec",
          ...codexExecLaunchArgs(launchArgs, managedAuth?.connectionId),
          "--ephemeral",
          "--skip-git-repo-check",
          "-s",
          "read-only",
          "--model",
          model,
          "--config",
          `model_reasoning_effort="${reasoningEffort}"`,
          ...(serviceTier ? ["--config", `service_tier="${serviceTier}"`] : []),
          "--output-schema",
          schemaPath,
          "--output-last-message",
          outputPath,
          ...imagePaths.flatMap((imagePath) => ["--image", imagePath]),
          "-",
        ],
        { env: resolvedEnvironment, extendEnv: !managedAuth },
      );
      const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: {
          ...resolvedEnvironment,
          ...(codexConfig.homePath ? { CODEX_HOME: expandHomePath(codexConfig.homePath) } : {}),
        },
        cwd,
        extendEnv: !managedAuth,
        shell: spawnCommand.shell,
        stdin: {
          stream: Stream.encodeText(Stream.make(prompt)),
        },
      });

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("codex", operation, cause, "Failed to spawn Codex CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("codex", operation, cause, "Failed to read Codex CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const stderrDetail = stderr.trim();
        const stdoutDetail = stdout.trim();
        const detail = stderrDetail.length > 0 ? stderrDetail : stdoutDetail;
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Codex CLI command failed: ${detail}`
              : `Codex CLI command failed with code ${exitCode}.`,
        });
      }
    });

    const cleanup = Effect.forEach(
      [schemaPath, outputPath, ...cleanupPaths],
      (filePath) => safeUnlink(filePath),
      {
        concurrency: "unbounded",
      },
    ).pipe(Effect.asVoid);

    return yield* Effect.gen(function* () {
      yield* runCodexCommand().pipe(
        Effect.scoped,
        Effect.timeoutOption(CODEX_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({ operation, detail: "Codex CLI request timed out." }),
              ),
            onSome: () => Effect.void,
          }),
        ),
      );

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));

      return yield* fileSystem.readFileString(outputPath).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Failed to read Codex output file.",
              cause,
            }),
        ),
        Effect.flatMap(decodeOutput),
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "Codex returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(Effect.ensuring(cleanup));
  });

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CodexTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runCodexJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CodexTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runCodexJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CodexTextGeneration.generateBranchName")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateBranchName",
        input.attachments,
      );
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runCodexJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CodexTextGeneration.generateThreadTitle")(function* (input) {
      const { imagePaths } = yield* materializeImageAttachments(
        "generateThreadTitle",
        input.attachments,
      );
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        linkedContext: input.linkedContext,
        attachments: input.attachments,
      });

      const generated = yield* runCodexJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        imagePaths,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  const runWorkflowApprovalVerdict = Effect.fnUntraced(function* (
    prompt: string,
    outputSchema: ReturnType<typeof buildApprovalVerdictPrompt>["outputSchema"],
    modelSelection: ModelSelection,
  ) {
    const operation = "generateApprovalVerdict";
    const unavailable = () =>
      new TextGenerationError({
        operation,
        detail: "The workflow supervisor could not reach Codex.",
      });
    const invalid = () =>
      new TextGenerationError({
        operation,
        detail: "Codex did not return a complete workflow approval verdict.",
      });
    const mintToken = managedAuth?.mintToken;
    if (!mintToken) return yield* unavailable();
    const model = yield* resolveModel(operation, modelSelection);
    const effort =
      getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") ??
      DEFAULT_TEXT_GENERATION_REASONING_EFFORT;
    return yield* Effect.gen(function* () {
      const http = HttpClient.withScope(yield* HttpClient.HttpClient);
      const token = yield* mintToken.pipe(Effect.mapError(unavailable));
      // Keep the organization credential in the coordinator, and make a tool-free
      // structured request independent of the workflow checkout and its config.
      const response = yield* HttpClientRequest.post("https://api.openai.com/v1/responses").pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.accept("text/event-stream"),
        HttpClientRequest.bodyJson({
          model,
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          stream: true,
          store: false,
          reasoning: { effort },
          tools: [],
          tool_choice: "none",
          text: {
            format: {
              type: "json_schema",
              name: "workflow_approval_verdict",
              strict: true,
              schema: toJsonSchemaObject(outputSchema),
            },
          },
        }),
        Effect.flatMap(http.execute),
        Effect.mapError(unavailable),
      );
      if (response.status < 200 || response.status >= 300) return yield* unavailable();
      if (!response.headers["content-type"]?.startsWith("text/event-stream"))
        return yield* invalid();
      const terminal = yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 1024 * 1024 })),
        Stream.filterMap((event) => decodeApprovalResponseTerminal(event.data)),
        Stream.runHead,
        Effect.mapError(invalid),
      );
      if (Option.isNone(terminal) || terminal.value.type !== "response.completed")
        return yield* invalid();
      const messages = terminal.value.response.output.filter(isAssistantMessage);
      const content = messages[0]?.content;
      const text = content?.[0];
      if (messages.length !== 1 || content?.length !== 1 || !isOutputText(text))
        return yield* invalid();
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(outputSchema))(text.text, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(invalid));
    }).pipe(
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeoutOrElse({
        duration: CODEX_TIMEOUT_MS,
        orElse: () => Effect.fail(unavailable()),
      }),
      Effect.withTracerEnabled(false),
    );
  });

  const generateApprovalVerdict: TextGeneration.TextGeneration["Service"]["generateApprovalVerdict"] =
    Effect.fn("CodexTextGeneration.generateApprovalVerdict")(function* (input) {
      const { prompt, outputSchema } = buildApprovalVerdictPrompt({
        toolKind: input.toolKind,
        requestType: input.requestType,
        requestDetail: input.requestDetail,
        stepInstruction: input.stepInstruction,
        jobContext: input.jobContext,
        reviewConstraint: input.reviewConstraint,
        policy: input.policy,
      });

      const generated = yield* workflowGuest
        ? runWorkflowApprovalVerdict(prompt, outputSchema, input.modelSelection)
        : runCodexJson({
            operation: "generateApprovalVerdict",
            cwd: input.cwd,
            prompt,
            outputSchemaJson: outputSchema,
            imagePaths: [],
            modelSelection: input.modelSelection,
          });

      return {
        verdict: generated.verdict,
        reasoning: generated.reasoning,
      } satisfies TextGeneration.ApprovalVerdictGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateApprovalVerdict,
  } satisfies TextGeneration.TextGeneration["Service"];
});
