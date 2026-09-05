import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as OrganizationSkills from "../relay/OrganizationSkills.ts";
import {
  applyOrganizationSkills,
  ORGANIZATION_SKILL_MARKER_FILE,
  syncOrganizationSkills,
} from "./organizationSkills.ts";

const withTempDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | FileSystem.FileSystem> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-org-skills-" });
      return yield* use(directory);
    }),
  ).pipe(Effect.orDie);

const review = (version: string) => ({
  name: "review",
  version,
  files: [
    { path: "SKILL.md", content: `---\nname: review\n---\n# v${version}\n` },
    { path: "scripts/check.sh", content: "#!/bin/sh\necho ok\n" },
  ],
});

const deploy = {
  name: "deploy",
  version: "1",
  files: [{ path: "SKILL.md", content: "# Deploy\n" }],
};

function skillsWith(
  skills: ReadonlyArray<OrganizationSkills.OrganizationSkill>,
): OrganizationSkills.OrganizationSkillsShape {
  return {
    ...OrganizationSkills.none,
    current: Effect.succeed(new Map(skills.map((skill) => [skill.name, skill]))),
  };
}

describe("syncOrganizationSkills", () => {
  it.effect("writes each skill with its files, a marker, and executable scripts", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillsDir = path.join(directory, "skills");
        const result = yield* syncOrganizationSkills({
          directory: skillsDir,
          skills: [review("1"), deploy],
        });
        expect(result).toEqual({
          written: ["review", "deploy"],
          unchanged: [],
          removed: [],
          skipped: [],
        });
        expect(
          yield* fileSystem.readFileString(path.join(skillsDir, "review", "SKILL.md")),
        ).toContain("# v1");
        const script = path.join(skillsDir, "review", "scripts", "check.sh");
        expect(((yield* fileSystem.stat(script)).mode & 0o777).toString(8)).toBe("755");
        const manifest = path.join(skillsDir, "deploy", "SKILL.md");
        expect(((yield* fileSystem.stat(manifest)).mode & 0o777).toString(8)).toBe("644");
        expect(
          yield* fileSystem.readFileString(
            path.join(skillsDir, "review", ORGANIZATION_SKILL_MARKER_FILE),
          ),
        ).toBe("1");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates nothing when there is nothing to place", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillsDir = path.join(directory, "skills");
        yield* syncOrganizationSkills({ directory: skillsDir, skills: [] });
        expect(yield* fileSystem.exists(skillsDir)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a changed skill wholesale and removes one the organization dropped", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* syncOrganizationSkills({ directory, skills: [review("1"), deploy] });
        expect(yield* syncOrganizationSkills({ directory, skills: [review("1"), deploy] })).toEqual(
          { written: [], unchanged: ["review", "deploy"], removed: [], skipped: [] },
        );
        const next = {
          ...review("2"),
          files: [{ path: "SKILL.md", content: "---\nname: review\n---\n# v2\n" }],
        };
        const result = yield* syncOrganizationSkills({ directory, skills: [next] });
        expect(result).toEqual({
          written: ["review"],
          unchanged: [],
          removed: ["deploy"],
          skipped: [],
        });
        expect(yield* fileSystem.exists(path.join(directory, "deploy"))).toBe(false);
        expect(yield* fileSystem.exists(path.join(directory, "review", "scripts"))).toBe(false);
        expect(
          yield* fileSystem.readFileString(path.join(directory, "review", "SKILL.md")),
        ).toContain("# v2");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a directory that is not ours alone, in both directions", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // Someone installed their own `review` and `local` skills on the machine.
        for (const name of ["review", "local"]) {
          yield* fileSystem.makeDirectory(path.join(directory, name), { recursive: true });
          yield* fileSystem.writeFileString(path.join(directory, name, "SKILL.md"), "# Mine\n");
        }
        const result = yield* syncOrganizationSkills({ directory, skills: [review("1")] });
        expect(result).toEqual({ written: [], unchanged: [], removed: [], skipped: ["review"] });
        expect(yield* fileSystem.readFileString(path.join(directory, "review", "SKILL.md"))).toBe(
          "# Mine\n",
        );
        expect(yield* fileSystem.exists(path.join(directory, "local", "SKILL.md"))).toBe(true);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("applyOrganizationSkills", () => {
  it.effect("does nothing on a machine with no organization skills", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const skillsDir = path.join(directory, "skills");
        yield* applyOrganizationSkills({ provider: "claudeAgent", directory: skillsDir });
        expect(yield* fileSystem.exists(skillsDir)).toBe(false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("places the organization's skills in the provider's directory", () =>
    withTempDirectory((directory) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* applyOrganizationSkills({ provider: "codex", directory }).pipe(
          Effect.provideService(
            OrganizationSkills.OrganizationSkills,
            skillsWith([{ ...deploy, description: "Deploy the app." }]),
          ),
        );
        expect(yield* fileSystem.readFileString(path.join(directory, "deploy", "SKILL.md"))).toBe(
          "# Deploy\n",
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
