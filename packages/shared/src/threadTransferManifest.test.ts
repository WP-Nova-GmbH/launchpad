import { describe, expect, it } from "vite-plus/test";
import {
  isThreadTransferPackEligible,
  normalizeThreadTransferManifest,
  THREAD_TRANSFER_MANIFEST_MAX_BYTES,
  THREAD_TRANSFER_MAX_BYTES,
  THREAD_TRANSFER_MAX_FILES,
  THREAD_TRANSFER_MAX_OBJECTS,
  THREAD_TRANSFER_MAX_SLICES,
  THREAD_TRANSFER_PACKED_OBJECT_MAX_BYTES as PACK,
  ThreadTransferManifestError,
} from "./threadTransferManifest.ts";

const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const hash = "a".repeat(64);
const id = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const path = (index: number) => `workspace/objects/${index.toString(16).padStart(64, "0")}`;
const object = (index: number, sizeBytes: number, kind = "workspace") => ({
  artifactId: id(index),
  kind,
  sha256: hash,
  sizeBytes,
});
const slice = (index: number, offset: number, length: number) => ({
  artifactId: id(index),
  offset,
  length,
});
const file = (name: string, sizeBytes: number, slices: ReturnType<typeof slice>[]) => ({
  path: name,
  sha256: sizeBytes ? hash : emptyHash,
  sizeBytes,
  slices,
});
const header = {
  threadId: "thread",
  operationId: "operation",
  sourceEnvironmentId: "environment",
  generation: 1,
  transferManifestSha256: hash,
};
const packed = (objects: ReturnType<typeof object>[], files: ReturnType<typeof file>[]) => ({
  format: "launchpad-thread-chunks-v2",
  ...header,
  objects,
  files,
});
const validPack = () =>
  packed([object(1, 5)], [file(path(1), 2, [slice(1, 0, 2)]), file(path(2), 3, [slice(1, 2, 3)])]);
const rejected = (input: unknown, message?: RegExp) => {
  expect(() => normalizeThreadTransferManifest(input)).toThrow(ThreadTransferManifestError);
  if (message) expect(() => normalizeThreadTransferManifest(input)).toThrow(message);
};

describe("normalizeThreadTransferManifest", () => {
  it("normalizes legacy whole chunks without changing their order or 64 MiB allowance", () => {
    const input = {
      format: "launchpad-thread-chunks-v1",
      ...header,
      files: [
        {
          path: "workspace/repository.bundle",
          sha256: hash,
          sizeBytes: 64 * 1024 * 1024,
          chunks: [{ artifactId: id(1), sha256: hash, sizeBytes: 64 * 1024 * 1024 }],
        },
      ],
    };
    expect(normalizeThreadTransferManifest(input)).toEqual({
      format: input.format,
      ...header,
      objects: [object(1, 64 * 1024 * 1024)],
      files: [
        file("workspace/repository.bundle", 64 * 1024 * 1024, [slice(1, 0, 64 * 1024 * 1024)]),
      ],
    });
    expect(input.files[0]!.chunks).toHaveLength(1);
  });

  it("keeps legacy independent history indexes without a top-level manifest readable", () => {
    expect(
      normalizeThreadTransferManifest({
        format: "launchpad-thread-chunks-v1",
        ...header,
        files: [
          {
            path: "history/manifest.json",
            sha256: hash,
            sizeBytes: 1,
            chunks: [{ artifactId: id(1), sha256: hash, sizeBytes: 1 }],
          },
        ],
      }).objects,
    ).toEqual([object(1, 1, "history")]);
  });

  it("normalizes a shared pack and empty files without mutating the index", () => {
    const input = validPack();
    input.files.splice(1, 0, file(`${path(1)}0`, 0, []));
    const before = structuredClone(input);
    expect(normalizeThreadTransferManifest(input)).toEqual(input);
    expect(input).toEqual(before);
  });

  it("accepts exact-fit packs, overflow into the next pack and exclusive large chunks", () => {
    const input = packed(
      [object(1, PACK), object(2, 1), object(3, PACK), object(4, 1)],
      [
        file(path(1), PACK - 1, [slice(1, 0, PACK - 1)]),
        file(path(2), 1, [slice(1, PACK - 1, 1)]),
        file(path(3), 1, [slice(2, 0, 1)]),
        file("workspace/repository.bundle", PACK + 1, [slice(3, 0, PACK), slice(4, 0, 1)]),
      ],
    );
    expect(normalizeThreadTransferManifest(JSON.stringify(input))).toEqual(input);
  });

  it("keeps metadata isolated and treats nonempty private files as pack barriers", () => {
    const input = packed(
      [object(1, 1, "manifest"), object(2, 2), object(3, 1), object(4, 1)],
      [
        file("manifest.json", 1, [slice(1, 0, 1)]),
        file("workspace/index", 2, [slice(2, 0, 2)]),
        file(path(1), 1, [slice(3, 0, 1)]),
        file("workspace/objects/z", 1, [slice(4, 0, 1)]),
      ],
    );
    expect(normalizeThreadTransferManifest(input)).toEqual(input);
  });

  it.each([
    ["duplicate object", (m: ReturnType<typeof validPack>) => m.objects.push(m.objects[0]!)],
    [
      "unknown reference",
      (m: ReturnType<typeof validPack>) => {
        m.files[0]!.slices[0]!.artifactId = id(9);
      },
    ],
    ["unreferenced object", (m: ReturnType<typeof validPack>) => m.objects.push(object(2, 1))],
    [
      "wrong kind",
      (m: ReturnType<typeof validPack>) => {
        m.objects[0]!.kind = "history";
      },
    ],
    [
      "overlapping slices",
      (m: ReturnType<typeof validPack>) => {
        m.files[1]!.slices[0]!.offset = 1;
      },
    ],
    [
      "unexplained bytes",
      (m: ReturnType<typeof validPack>) => {
        m.objects[0]!.sizeBytes++;
      },
    ],
    [
      "file size mismatch",
      (m: ReturnType<typeof validPack>) => {
        m.files[0]!.sizeBytes++;
      },
    ],
    [
      "noncanonical file order",
      (m: ReturnType<typeof validPack>) => {
        m.files = m.files.toReversed();
      },
    ],
    [
      "unsafe integer",
      (m: ReturnType<typeof validPack>) => {
        m.files[0]!.slices[0]!.offset = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "negative offset",
      (m: ReturnType<typeof validPack>) => {
        m.files[0]!.slices[0]!.offset = -1;
      },
    ],
    [
      "zero slice",
      (m: ReturnType<typeof validPack>) => {
        m.files[0]!.slices[0]!.length = 0;
      },
    ],
    [
      "oversized object",
      (m: ReturnType<typeof validPack>) => {
        m.objects[0]!.sizeBytes = PACK + 1;
      },
    ],
    [
      "wrong empty checksum",
      (m: ReturnType<typeof validPack>) => m.files.push({ ...file(path(3), 0, []), sha256: hash }),
    ],
    [
      "empty file with payload",
      (m: ReturnType<typeof validPack>) => m.files.push(file(path(3), 0, [slice(1, 0, 1)])),
    ],
  ])("rejects %s", (_name, mutate) => {
    const input = validPack();
    mutate(input);
    rejected(input);
  });

  it("rejects splitting small files, underfilled nonfinal chunks, needless pack splits and reordered objects", () => {
    rejected(
      packed([object(1, 1), object(2, 1)], [file(path(1), 2, [slice(1, 0, 1), slice(2, 0, 1)])]),
    );
    rejected(
      packed(
        [object(1, 1), object(2, PACK)],
        [file("workspace/repository.bundle", PACK + 1, [slice(1, 0, 1), slice(2, 0, PACK)])],
      ),
    );
    rejected(
      packed(
        [object(1, 2), object(2, 3)],
        [file(path(1), 2, [slice(1, 0, 2)]), file(path(2), 3, [slice(2, 0, 3)])],
      ),
    );
    rejected(
      packed(
        [object(2, 3), object(1, PACK)],
        [file(path(1), PACK, [slice(1, 0, PACK)]), file(path(2), 3, [slice(2, 0, 3)])],
      ),
    );
  });

  it("rejects sharing isolated files or a Git bundle with workspace data", () => {
    rejected(
      packed(
        [object(1, 2)],
        [file("workspace/index", 1, [slice(1, 0, 1)]), file(path(1), 1, [slice(1, 1, 1)])],
      ),
    );
    rejected(
      packed(
        [object(1, 2)],
        [
          file(path(1), 1, [slice(1, 0, 1)]),
          file("workspace/repository.bundle", 1, [slice(1, 1, 1)]),
        ],
      ),
    );
  });

  it.each([
    "../x",
    "workspace/../x",
    "/workspace/x",
    "workspace/a\\b",
    "workspace/a:b",
    "workspace/a.",
    "workspace/a ",
    "workspace/a\u0000b",
    "other/x",
  ])("rejects unsafe archive path %s", (name) => {
    rejected(packed([object(1, 1)], [file(name, 1, [slice(1, 0, 1)])]));
  });

  it.each([
    ["workspace/a", "workspace/a"],
    ["workspace/A/x", "workspace/a/y"],
    ["workspace/é/x", "workspace/e\u0301/y"],
    ["workspace/a", "workspace/a/b"],
  ])("rejects colliding paths %s and %s", (first, second) => {
    const names = [first, second].toSorted();
    rejected(
      packed(
        [object(1, 1), object(2, 1)],
        names.map((name, i) => file(name, 1, [slice(i + 1, 0, 1)])),
      ),
      /collid|duplicated/,
    );
  });

  it("rejects a root manifest checksum detached from the captured archive", () => {
    rejected({
      ...packed([object(1, 1, "manifest")], [file("manifest.json", 1, [slice(1, 0, 1)])]),
      transferManifestSha256: "b".repeat(64),
    });
  });

  it("caps files, physical objects and references independently before layout validation", () => {
    rejected(
      packed(
        [],
        Array.from({ length: THREAD_TRANSFER_MAX_FILES + 1 }, (_, i) => file(path(i), 0, [])),
      ),
      /file count/,
    );
    rejected(
      packed(
        Array.from({ length: THREAD_TRANSFER_MAX_OBJECTS + 1 }, (_, i) => object(i, 1)),
        [],
      ),
      /object count/,
    );
    rejected(
      packed(
        [object(1, 1)],
        [
          file(
            "workspace/repository.bundle",
            THREAD_TRANSFER_MAX_SLICES + 1,
            Array.from({ length: THREAD_TRANSFER_MAX_SLICES + 1 }, () => slice(1, 0, 1)),
          ),
        ],
      ),
      /reference count/,
    );
  });

  it("caps raw index bytes before decoding and aggregate payload sizes without allocating payloads", () => {
    rejected(" ".repeat(THREAD_TRANSFER_MANIFEST_MAX_BYTES + 1), /index/);
    rejected(
      packed([], [file("workspace/repository.bundle", THREAD_TRANSFER_MAX_BYTES + 1, [])]),
      /payload/,
    );
    rejected(
      packed(
        Array.from({ length: THREAD_TRANSFER_MAX_BYTES / PACK + 1 }, (_, i) => object(i, PACK)),
        [],
      ),
      /payload/,
    );
  });

  it("rejects duplicated legacy chunks and chunks larger than the legacy limit", () => {
    const chunk = { artifactId: id(1), sha256: hash, sizeBytes: 1 };
    rejected({
      format: "launchpad-thread-chunks-v1",
      ...header,
      files: [{ path: "workspace/index", sha256: hash, sizeBytes: 2, chunks: [chunk, chunk] }],
    });
    rejected({
      format: "launchpad-thread-chunks-v1",
      ...header,
      files: [
        {
          path: "workspace/index",
          sha256: hash,
          sizeBytes: 64 * 1024 * 1024 + 1,
          chunks: [{ ...chunk, sizeBytes: 64 * 1024 * 1024 + 1 }],
        },
      ],
    });
  });
});

it("only packs nonempty small content-addressed workspace objects", () => {
  expect(isThreadTransferPackEligible({ path: path(1), sizeBytes: PACK })).toBe(true);
  for (const entry of [
    file(path(1), 0, []),
    file(path(1), PACK + 1, []),
    file("workspace/objects/not-a-hash", 1, []),
    file(`native/objects/${hash}`, 1, []),
    file("workspace/index", 1, []),
    file("workspace/repository.bundle", 1, []),
  ])
    expect(isThreadTransferPackEligible(entry)).toBe(false);
});
