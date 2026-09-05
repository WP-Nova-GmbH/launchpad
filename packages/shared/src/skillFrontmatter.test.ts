import { describe, expect, it } from "vite-plus/test";

import { parseSkillFrontmatter } from "./skillFrontmatter.ts";

describe("parseSkillFrontmatter", () => {
  it("reads name and description from the frontmatter block", () => {
    expect(
      parseSkillFrontmatter(
        ["---", "name: deploy", "description: Deploy the app.", "---", "", "# Deploy"].join("\n"),
      ),
    ).toEqual({ kind: "parsed", name: "deploy", description: "Deploy the app." });
  });

  it("tolerates CRLF line endings and a block that ends the file", () => {
    expect(parseSkillFrontmatter("---\r\nname: deploy\r\n---")).toEqual({
      kind: "parsed",
      name: "deploy",
    });
  });

  it("reports a manifest without frontmatter as missing", () => {
    expect(parseSkillFrontmatter("# Just a heading\n")).toEqual({ kind: "missing" });
  });

  it("reports frontmatter that is not a mapping as malformed", () => {
    expect(parseSkillFrontmatter("---\n- just\n- a list\n---\n")).toEqual({ kind: "malformed" });
    expect(parseSkillFrontmatter("---\njust a scalar\n---\n")).toEqual({ kind: "malformed" });
  });

  it("drops blank fields rather than returning empty strings", () => {
    expect(parseSkillFrontmatter("---\nname: '  '\ndescription: ''\n---\n")).toEqual({
      kind: "parsed",
    });
  });
});
