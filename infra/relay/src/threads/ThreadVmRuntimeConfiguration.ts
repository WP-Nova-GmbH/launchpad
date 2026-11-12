import type { WorkflowVmModelCatalog } from "@t3tools/contracts/workflows";
import * as Context from "effect/Context";
import type { E2BThreadVmSettings } from "../machines/E2BThreadVmCompute.ts";

export interface ThreadVmRuntimeSettings {
  readonly compute: E2BThreadVmSettings;
  readonly templateBuildId: string;
  readonly workflowModelCatalog?: WorkflowVmModelCatalog;
  readonly workflowExecutionEnabled?: boolean;
  readonly hostId: string;
  readonly maxRunningVms: number;
  readonly publicRelayUrl: string;
  readonly autoPauseEnabled: boolean;
  readonly autoBackupEnabled: boolean;
  readonly autoDeleteEnabled: boolean;
  readonly replacementEnabled: boolean;
  readonly restoreEnabled: boolean;
  readonly resetEnabled: boolean;
  readonly permanentDeleteEnabled?: boolean;
  readonly previewBaseUrl?: string;
}

export class ThreadVmRuntimeConfiguration extends Context.Service<
  ThreadVmRuntimeConfiguration,
  {
    readonly settings: ThreadVmRuntimeSettings | undefined;
  }
>()("launchpad-relay/threads/ThreadVmRuntimeConfiguration") {}
