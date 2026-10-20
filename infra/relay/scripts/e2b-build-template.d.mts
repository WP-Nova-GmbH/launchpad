import type { BuildInfo } from "e2b";

export function prepareTemplateContext(archive: string, expectedSha256: string): Promise<string>;
export function validateBuildTarget(apiUrl: string, name: string): string;
export function validateTemplateResources(resources: unknown): {
  cpuCount: number;
  memoryMB: number;
  minFreeDiskMb: number;
};
export function buildTemplate(
  args: {
    "api-url": string;
    name: string;
    "server-archive": string;
    "server-sha256": string;
    output: string;
    "skip-cache"?: boolean;
  },
  apiKey: string | undefined,
): Promise<BuildInfo>;
