import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  InvalidReleaseVersionError,
  ReleaseNotAnIncreaseError,
  resolveNextVersion,
} from "./release.ts";

describe("resolveNextVersion", () => {
  it.effect("applies bump keywords to the current version", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveNextVersion("0.1.8", "patch"), "0.1.9");
      assert.equal(yield* resolveNextVersion("0.1.8", "minor"), "0.2.0");
      assert.equal(yield* resolveNextVersion("0.1.8", "major"), "1.0.0");
    }),
  );

  it.effect("promotes a prerelease to its release on patch", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveNextVersion("0.2.0-beta.1", "patch"), "0.2.0");
      assert.equal(yield* resolveNextVersion("0.2.0-beta.1", "minor"), "0.3.0");
    }),
  );

  it.effect("accepts explicit newer versions with or without the v prefix", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveNextVersion("0.1.8", "0.2.0-beta.1"), "0.2.0-beta.1");
      assert.equal(yield* resolveNextVersion("0.1.8", "v1.0.0"), "1.0.0");
      assert.equal(yield* resolveNextVersion("0.2.0-beta.1", "0.2.0-beta.2"), "0.2.0-beta.2");
      assert.equal(yield* resolveNextVersion("0.2.0-beta.1", "0.2.0"), "0.2.0");
    }),
  );

  it.effect("rejects versions that do not move forward", () =>
    Effect.gen(function* () {
      for (const input of ["0.1.8", "0.1.7", "0.0.33", "0.1.8-beta.1"]) {
        const error = yield* Effect.flip(resolveNextVersion("0.1.8", input));
        assert.instanceOf(error, ReleaseNotAnIncreaseError, `expected '${input}' to be rejected`);
      }
    }),
  );

  it.effect("rejects inputs that are neither a keyword nor a version", () =>
    Effect.gen(function* () {
      for (const input of ["", "latest", "1.2", "v1.2.3.4", "0.1.9 rc"]) {
        const error = yield* Effect.flip(resolveNextVersion("0.1.8", input));
        assert.instanceOf(error, InvalidReleaseVersionError, `expected '${input}' to be rejected`);
      }
    }),
  );
});
