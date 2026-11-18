import { describe, expect, it } from "@effect/vitest";
import { normalizeWorkflowVmPullRequestUrl } from "./WorkflowVmPublishing.ts";

describe("workflow VM pull request identity", () => {
  const repository = "github.com/wp-nova-gmbh/launchpad-acceptance-test";
  const canonicalUrl = `https://${repository}/pull/17`;

  it("accepts GitHub's case-preserved repository URL as the same PR", () => {
    expect(
      normalizeWorkflowVmPullRequestUrl(
        repository,
        "https://github.com/WP-Nova-GmbH/launchpad-acceptance-test/pull/17",
      ),
    ).toBe(canonicalUrl);
  });

  it.each([
    null,
    "http://github.com/wp-nova-gmbh/launchpad-acceptance-test/pull/17",
    "https://other.test/wp-nova-gmbh/launchpad-acceptance-test/pull/17",
    "https://github.com/other-owner/launchpad-acceptance-test/pull/17",
    "https://github.com/wp-nova-gmbh/other-repo/pull/17",
    `${canonicalUrl}?ref=17`,
    `${canonicalUrl}#17`,
    `${canonicalUrl}/files`,
    `https://${repository}/pull/017`,
    `https://${repository}/pull/9007199254740992`,
  ])("rejects a URL outside the exact GitHub PR scope (%s)", (url) => {
    expect(normalizeWorkflowVmPullRequestUrl(repository, url)).toBeNull();
  });
});
