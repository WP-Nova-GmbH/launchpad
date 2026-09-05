import { describe, expect, it } from "vite-plus/test";
import type { RelayOrganizationSkill } from "@t3tools/contracts/relay";

import { buildSkillUpload, organizationSkillDescription } from "./OrganizationSettings.logic";

const manifest = (name?: string, description = "Review the change.") =>
  [
    "---",
    ...(name ? [`name: ${name}`] : []),
    `description: ${description}`,
    "---",
    "",
    "# Body",
  ].join("\n");

describe("buildSkillUpload", () => {
  it("strips the picked folder from every path and names the skill after the manifest", () => {
    const upload = buildSkillUpload([
      { relativePath: "my-review/SKILL.md", content: manifest("review") },
      { relativePath: "my-review/scripts/check.sh", content: "#!/bin/sh\n" },
      { relativePath: "my-review/.DS_Store", content: "junk" },
    ]);
    expect(upload).toEqual({
      ok: true,
      name: "review",
      files: [
        { path: "SKILL.md", content: manifest("review") },
        { path: "scripts/check.sh", content: "#!/bin/sh\n" },
      ],
    });
  });

  it("names the skill after the folder when the manifest carries no name", () => {
    const upload = buildSkillUpload([
      { relativePath: "deploy/SKILL.md", content: manifest() },
      { relativePath: "deploy/notes.md", content: "notes" },
    ]);
    expect(upload).toMatchObject({ ok: true, name: "deploy" });
  });

  it("accepts a single manifest picked on its own", () => {
    const upload = buildSkillUpload([{ relativePath: "SKILL.md", content: manifest("deploy") }]);
    expect(upload).toEqual({
      ok: true,
      name: "deploy",
      files: [{ path: "SKILL.md", content: manifest("deploy") }],
    });
  });

  it("refuses a selection without a manifest at the top", () => {
    const upload = buildSkillUpload([
      { relativePath: "deploy/docs/SKILL.md", content: manifest("deploy") },
    ]);
    expect(upload).toMatchObject({ ok: false, reason: expect.stringContaining("SKILL.md") });
  });

  it("refuses a nameless skill and a name the agents would not accept", () => {
    expect(buildSkillUpload([{ relativePath: "SKILL.md", content: manifest() }])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("Name the skill"),
    });
    expect(
      buildSkillUpload([{ relativePath: "My Skill/SKILL.md", content: manifest() }]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("'My Skill'") });
  });

  it("refuses binary files and paths the relay would not take", () => {
    expect(
      buildSkillUpload([
        { relativePath: "review/SKILL.md", content: manifest("review") },
        { relativePath: "review/logo.png", content: "\u0000PNG" },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("'logo.png'") });
    expect(
      buildSkillUpload([
        { relativePath: "review/SKILL.md", content: manifest("review") },
        { relativePath: "review/odd name.txt", content: "x" },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("'odd name.txt'") });
  });

  it("refuses frontmatter the agents would not load", () => {
    expect(
      buildSkillUpload([{ relativePath: "SKILL.md", content: "---\n- a\n- list\n---\n" }]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("frontmatter") });
  });
});

describe("organizationSkillDescription", () => {
  const skill = (overrides: Partial<RelayOrganizationSkill> = {}): RelayOrganizationSkill => ({
    name: "review",
    description: "Review the change.",
    filePaths: ["SKILL.md"],
    version: "v1",
    updatedByUserId: "user-1",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
    ...overrides,
  });

  it("leads with the manifest's description and the last change", () => {
    expect(organizationSkillDescription(skill())).toBe("Review the change. Updated 2026-09-05.");
  });

  it("says when the manifest describes nothing", () => {
    expect(organizationSkillDescription(skill({ description: "" }))).toBe(
      "No description in SKILL.md. Updated 2026-09-05.",
    );
  });
});
