import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import type { SourceControlProviderDiscoveryItem } from "@t3tools/contracts";
import {
  applyOrganizationGithubAuth,
  providerAuth,
  unknownAuth,
} from "./SourceControlProviderDiscovery.ts";

function item(input: {
  readonly kind: SourceControlProviderDiscoveryItem["kind"];
  readonly status: SourceControlProviderDiscoveryItem["status"];
}): SourceControlProviderDiscoveryItem {
  return {
    kind: input.kind,
    label: input.kind,
    executable: input.kind === "github" ? "gh" : "glab",
    status: input.status,
    version: Option.none(),
    installHint: "install it",
    detail: Option.none(),
    auth:
      input.status === "available"
        ? providerAuth({ status: "unauthenticated", detail: "Run `gh auth login`." })
        : unknownAuth(),
  };
}

describe("applyOrganizationGithubAuth", () => {
  it("reports an available GitHub CLI as authenticated through the organization installation", () => {
    const [github, gitlab] = applyOrganizationGithubAuth(
      [
        item({ kind: "github", status: "available" }),
        item({ kind: "gitlab", status: "available" }),
      ],
      { accountLogin: "acme" },
    );

    expect(github?.auth).toEqual(
      providerAuth({
        status: "authenticated",
        account: "acme",
        host: "github.com",
        detail: "Organization GitHub App installation",
      }),
    );
    expect(gitlab?.auth.status).toBe("unauthenticated");
  });

  it("does not paper over a missing GitHub CLI", () => {
    // The token is useless until `gh` exists to serve it to git; the install
    // hint has to stay visible.
    const missing = item({ kind: "github", status: "missing" });
    expect(applyOrganizationGithubAuth([missing], { accountLogin: "acme" })).toEqual([missing]);
  });

  it("changes nothing without a credential", () => {
    const items = [item({ kind: "github", status: "available" })];
    expect(applyOrganizationGithubAuth(items, null)).toBe(items);
  });
});
