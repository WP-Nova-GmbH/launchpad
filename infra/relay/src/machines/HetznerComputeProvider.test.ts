import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { HttpClientRequest } from "effect/unstable/http";

import {
  hetznerServerName,
  layerHetzner,
  renderHetznerCloudInit,
  type HetznerComputeSettings,
} from "./HetznerComputeProvider.ts";
import { MachineComputeProvider } from "./MachineComputeProvider.ts";

const settings: HetznerComputeSettings = {
  apiToken: Redacted.make("hetzner-token"),
  serverType: "cx22",
  image: "ubuntu-24.04",
  location: "fsn1",
  sshKeys: ["ops-key"],
  bootstrapUrl: "https://example.test/machine-bootstrap.sh",
  sourceGitUrl: "https://example.test/launchpad.git",
};

const decodeCreateServerBody = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      server_type: Schema.String,
      labels: Schema.Record(Schema.String, Schema.String),
      user_data: Schema.String,
    }),
  ),
);

const createInput = {
  machineId: "0A1B2C3D-4E5F-6071-8293-A4B5C6D7E8F9",
  organizationId: "organization-1",
  role: "agent_executor" as const,
  label: "Executor 1",
  relayUrl: "https://relay.example.test",
  seed: "t3mseed_abc123",
};

function harnessLayer(input: {
  readonly requests: Array<HttpClientRequest.HttpClientRequest>;
  readonly respond: (request: HttpClientRequest.HttpClientRequest) => Response;
}) {
  return layerHetzner(settings).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            input.requests.push(request);
            return HttpClientResponse.fromWeb(request, input.respond(request));
          }),
        ),
      ),
    ),
  );
}

describe("renderHetznerCloudInit", () => {
  it("writes the enrollment env file and fetches the bootstrap script", () => {
    const rendered = renderHetznerCloudInit({
      seed: "t3mseed_abc123",
      relayUrl: "https://relay.example.test",
      bootstrapUrl: "https://example.test/machine-bootstrap.sh",
      sourceGitUrl: "https://example.test/launchpad.git",
    });
    expect(rendered).toContain("T3CODE_MACHINE_ENROLLMENT_SEED=t3mseed_abc123");
    expect(rendered).toContain("T3CODE_MACHINE_ENROLLMENT_RELAY_URL=https://relay.example.test");
    expect(rendered).toContain(
      "T3CODE_MACHINE_ENROLLMENT_ENV_FILE=/etc/t3code/machine-enrollment.env",
    );
    expect(rendered).toContain("https://example.test/machine-bootstrap.sh");
  });

  it("refuses values that could break out of their line", () => {
    expect(() =>
      renderHetznerCloudInit({
        seed: "evil\nruncmd: [rm -rf /]",
        relayUrl: "https://relay.example.test",
        bootstrapUrl: "https://example.test/machine-bootstrap.sh",
        sourceGitUrl: "https://example.test/launchpad.git",
      }),
    ).toThrow(/cannot be embedded/u);
  });
});

describe("hetznerServerName", () => {
  it("derives an RFC 1123 name from the machine id", () => {
    expect(hetznerServerName(createInput.machineId)).toBe(
      "t3-machine-0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9",
    );
  });
});

describe("HetznerComputeProvider", () => {
  it.effect("creates a labeled server with seeded cloud-init and returns its id", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      const result = yield* provider.create(createInput);
      expect(result).toEqual({ computeKind: "hetzner", computeRef: "424242" });
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.url).toBe("https://api.hetzner.cloud/v1/servers");
      expect(request.headers.authorization).toBe("Bearer hetzner-token");
      const body = request.body as { readonly _tag?: string; readonly body?: Uint8Array };
      const parsed = decodeCreateServerBody(new TextDecoder().decode(body.body));
      expect(parsed.server_type).toBe("cx22");
      expect(parsed.labels).toEqual({
        "t3-machine-id": createInput.machineId,
        "t3-organization-id": "organization-1",
        "t3-role": "agent_executor",
      });
      expect(parsed.user_data).toContain("T3CODE_MACHINE_ENROLLMENT_SEED=t3mseed_abc123");
    }).pipe(
      Effect.provide(
        harnessLayer({
          requests,
          respond: () => Response.json({ server: { id: 424242 } }),
        }),
      ),
    );
  });

  it.effect("treats a missing server as already destroyed", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      yield* provider.destroy({ computeKind: "hetzner", computeRef: "424242" });
      expect(requests[0]?.method).toBe("DELETE");
      expect(requests[0]?.url).toBe("https://api.hetzner.cloud/v1/servers/424242");
    }).pipe(
      Effect.provide(
        harnessLayer({
          requests,
          respond: () => Response.json({ error: { code: "not_found" } }, { status: 404 }),
        }),
      ),
    );
  });

  it.effect("never destroys compute a different driver created", () => {
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const provider = yield* MachineComputeProvider;
      yield* provider.destroy({ computeKind: "docker", computeRef: "container-1" });
      expect(requests).toHaveLength(0);
    }).pipe(
      Effect.provide(
        harnessLayer({
          requests,
          respond: () => Response.json({}),
        }),
      ),
    );
  });
});
