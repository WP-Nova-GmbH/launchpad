import { describe, expect, it } from "vite-plus/test";
import { matchesWorkflowRepository, workflowRepositoryRemote } from "./workflowRepositories.ts";

const repositories = [
  { name: "API", canonicalKeys: ["github.com/northstar/api", "gitlab.com/mirrors/platform"] },
  { name: "API", canonicalKeys: ["github.com/northstar-labs/api"] },
  { name: "Operations", canonicalKeys: [] },
];

const findRepositories = (query: string) =>
  repositories.filter((repository) => matchesWorkflowRepository(repository, query));

describe("workflow repository search", () => {
  it("distinguishes same-named repositories by remote and matches aliases", () => {
    expect(findRepositories(" API ")).toEqual(repositories.slice(0, 2));
    expect(findRepositories("  Northstar-Labs/API ")).toEqual([repositories[1]]);
    expect(findRepositories("platform API")).toEqual([repositories[0]]);
    expect(findRepositories("missing api")).toEqual([]);
  });

  it("keeps repositories without remote paths discoverable by name", () => {
    expect(findRepositories("   ")).toEqual(repositories);
    expect(findRepositories("operations")).toEqual([repositories[2]]);
  });

  it("shows the matching alias and keeps the primary path for name-only searches", () => {
    expect(workflowRepositoryRemote(repositories[0]!, "API mirrors/platform")).toBe(
      "gitlab.com/mirrors/platform",
    );
    expect(workflowRepositoryRemote(repositories[0]!, "API")).toBe("github.com/northstar/api");
    expect(workflowRepositoryRemote(repositories[0]!, "")).toBe("github.com/northstar/api");
    expect(workflowRepositoryRemote(repositories[2]!, "operations")).toBeUndefined();
  });
});
