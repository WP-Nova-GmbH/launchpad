import { describe, expect, it, vi } from "vite-plus/test";

import { ensureDevRelayTunnel } from "./dev-relay-tunnel.ts";

const config = {
  apiToken: "private-api-token",
  accountId: "a".repeat(32),
  zoneName: "example.test",
  hostname: "relay-dev.example.test",
  port: 8610,
  namespace: "dev-stefan",
};
const tunnelId = "19c9df38-1c60-49d0-8d81-72885ba4a818";
const tunnel = { id: tunnelId, name: "launchpad-relay-dev-stefan", config_src: "cloudflare" };
const ingress = [
  { hostname: config.hostname, service: "http://127.0.0.1:8610" },
  { service: "http_status:404" },
];
const dns = {
  id: "dns-id",
  name: config.hostname,
  type: "CNAME",
  content: `${tunnelId}.cfargotunnel.com`,
  proxied: true,
};
const response = (result: unknown) => Response.json({ success: true, result });
const duplicate = (status = 400) =>
  Response.json(
    { success: false, errors: [{ message: "A record with this name already exists." }] },
    { status },
  );

function cloudflare(
  options: {
    existing?: boolean;
    existingIngress?: unknown;
    records?: unknown[];
    accountId?: string;
    tunnelRace?: boolean;
    dnsRace?: boolean;
    racedRecord?: unknown;
    conflictStatus?: number;
  } = {},
) {
  let currentTunnel = options.existing ? tunnel : undefined;
  let currentIngress = options.existingIngress ?? ingress;
  let records = options.records ?? [dns];
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.cloudflare.com");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${config.apiToken}` });
    const method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    if (url.pathname.endsWith("/zones")) {
      expect(url.searchParams.get("name")).toBe(config.zoneName);
      return response([
        {
          id: "b".repeat(32),
          name: config.zoneName,
          account: { id: options.accountId ?? config.accountId },
        },
      ]);
    }
    if (url.pathname.endsWith("/cfd_tunnel")) {
      if (method === "GET") {
        expect(url.searchParams.get("name")).toBe(tunnel.name);
        return response(currentTunnel ? [currentTunnel] : []);
      }
      expect(body).toEqual({ name: tunnel.name, config_src: "cloudflare" });
      currentTunnel = tunnel;
      return options.tunnelRace ? duplicate(options.conflictStatus) : response(tunnel);
    }
    if (url.pathname.endsWith("/configurations")) {
      if (method === "GET") return response({ config: { ingress: currentIngress } });
      expect(body).toEqual({ config: { ingress } });
      currentIngress = ingress;
      return response({ config: { ingress } });
    }
    if (url.pathname.endsWith("/dns_records")) {
      if (method === "GET") {
        expect(url.searchParams.get("name")).toBe(config.hostname);
        return response(records);
      }
      expect(method).toBe("POST");
      expect(body).toEqual({ type: "CNAME", name: dns.name, content: dns.content, proxied: true });
      records = [options.racedRecord ?? dns];
      return options.dnsRace ? duplicate(options.conflictStatus) : response(dns);
    }
    if (url.pathname.endsWith("/token")) return response("private-connector-token");
    throw new Error("Unexpected request");
  });
  return { fetchImpl, calls };
}

describe("dedicated development relay tunnel", () => {
  it("creates a dedicated tunnel once and reuses existing DNS without changing it", async () => {
    const api = cloudflare();
    const expected = {
      tunnelId,
      hostname: config.hostname,
      connectorToken: "private-connector-token",
    };
    expect(await ensureDevRelayTunnel(config, api.fetchImpl)).toEqual(expected);
    const initialWrites = api.calls.filter((call) => call.method !== "GET");
    expect(initialWrites.map((call) => call.method)).toEqual(["POST", "PUT"]);
    expect(await ensureDevRelayTunnel(config, api.fetchImpl)).toEqual(expected);
    expect(api.calls.filter((call) => call.method !== "GET")).toEqual(initialWrites);
    expect(
      api.calls
        .filter((call) => call.path.endsWith("/dns_records"))
        .every((call) => call.method === "GET"),
    ).toBe(true);
    expect(api.calls.every((call) => !call.path.includes("t3coderelay-managedendpoint"))).toBe(
      true,
    );
  });

  it.each([false, true])(
    "creates a missing proxied CNAME once and reuses it (existing tunnel: %s)",
    async (existing) => {
      const api = cloudflare({ existing, records: [] });
      expect(await ensureDevRelayTunnel(config, api.fetchImpl)).toMatchObject({ tunnelId });
      expect(await ensureDevRelayTunnel(config, api.fetchImpl)).toMatchObject({ tunnelId });
      const creates = api.calls.filter(
        (call) => call.path.endsWith("/dns_records") && call.method === "POST",
      );
      expect(creates).toHaveLength(1);
      expect(creates[0]?.body).toEqual({
        type: "CNAME",
        name: config.hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      });
      expect(
        api.calls.filter((call) => call.path.endsWith("/cfd_tunnel") && call.method === "POST"),
      ).toHaveLength(existing ? 0 : 1);
    },
  );

  it.each([400, 409])("reuses DNS created concurrently after HTTP %i", async (conflictStatus) => {
    const api = cloudflare({ existing: true, records: [], dnsRace: true, conflictStatus });
    expect(await ensureDevRelayTunnel(config, api.fetchImpl)).toMatchObject({ tunnelId });
    expect(
      api.calls.filter((call) => call.path.endsWith("/dns_records")).map((call) => call.method),
    ).toEqual(["GET", "POST", "GET"]);
  });

  it("refuses a conflicting concurrently-created record without overwriting it", async () => {
    const api = cloudflare({
      existing: true,
      records: [],
      dnsRace: true,
      racedRecord: { ...dns, content: "other.cfargotunnel.com" },
    });
    await expect(ensureDevRelayTunnel(config, api.fetchImpl)).rejects.toThrow(
      "different DNS target",
    );
    expect(api.calls.filter((call) => call.method !== "GET").map((call) => call.method)).toEqual([
      "POST",
    ]);
    expect(api.calls.some((call) => call.path.endsWith("/token"))).toBe(false);
  });

  it("reports DNS permission failures without retrying creation or reading a connector token", async () => {
    const api = cloudflare({ existing: true, records: [] });
    const fetchImpl: typeof fetch = vi.fn(async (input, init) =>
      init?.method === "POST" && new URL(String(input)).pathname.endsWith("/dns_records")
        ? Response.json({ success: false }, { status: 403 })
        : api.fetchImpl(input, init),
    );
    await expect(ensureDevRelayTunnel(config, fetchImpl)).rejects.toThrow("DNS Edit");
    expect(
      vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(api.calls.some((call) => call.path.endsWith("/token"))).toBe(false);
  });

  it("refuses an existing tunnel with unrelated routes without changing anything", async () => {
    const api = cloudflare({
      existing: true,
      existingIngress: [{ hostname: "other.example.test", service: "http://localhost:3000" }],
    });
    await expect(ensureDevRelayTunnel(config, api.fetchImpl)).rejects.toThrow("different routes");
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("finishes configuring an existing dedicated empty tunnel", async () => {
    const api = cloudflare({ existing: true, existingIngress: [] });
    expect(await ensureDevRelayTunnel(config, api.fetchImpl)).toMatchObject({ tunnelId });
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
    expect(
      api.calls.filter((call) => call.path.endsWith("/cfd_tunnel") && call.method === "POST"),
    ).toHaveLength(0);
  });

  it("recovers an interrupted configuration on rerun without creating a second tunnel", async () => {
    const api = cloudflare({ existingIngress: [] });
    let firstPut = true;
    const fetchImpl: typeof fetch = vi.fn(async (input, init) => {
      if (init?.method === "PUT" && firstPut) {
        firstPut = false;
        return Response.json({ success: false }, { status: 500 });
      }
      return api.fetchImpl(input, init);
    });
    await expect(ensureDevRelayTunnel(config, fetchImpl)).rejects.toThrow("HTTP 500");
    expect(await ensureDevRelayTunnel(config, fetchImpl)).toMatchObject({ tunnelId });
    expect(
      api.calls.filter((call) => call.path.endsWith("/cfd_tunnel") && call.method === "POST"),
    ).toHaveLength(1);
    expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it.each([
    { ...dns, type: "A", content: "203.0.113.1" },
    { ...dns, content: "different-tunnel.cfargotunnel.com" },
    { ...dns, proxied: false },
  ])("never overwrites an existing DNS conflict: $content / $proxied", async (record) => {
    const api = cloudflare({ existing: true, records: [record] });
    await expect(ensureDevRelayTunnel(config, api.fetchImpl)).rejects.toThrow(
      /DNS target|proxying/,
    );
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("refuses a matching hostname route restricted by an unrelated path", async () => {
    const api = cloudflare({
      existing: true,
      existingIngress: [{ ...ingress[0], path: "/other-only" }, ingress[1]],
    });
    await expect(ensureDevRelayTunnel(config, api.fetchImpl)).rejects.toThrow("different routes");
    expect(api.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it.each([400, 409])(
    "rechecks concurrent tunnel creates once (HTTP %i) without writing over the winning routes",
    async (conflictStatus) => {
      const api = cloudflare({ tunnelRace: true, conflictStatus });
      expect(await ensureDevRelayTunnel(config, api.fetchImpl)).toMatchObject({ tunnelId });
      expect(api.calls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(api.calls.filter((call) => call.method === "PUT")).toHaveLength(0);
      expect(
        api.calls.filter((call) => call.path.endsWith("/cfd_tunnel") && call.method === "GET"),
      ).toHaveLength(2);
      expect(
        api.calls.filter((call) => call.path.endsWith("/dns_records") && call.method === "GET"),
      ).toHaveLength(1);
    },
  );

  it("refuses a non-UUID tunnel identity before configuring it", async () => {
    const api = cloudflare();
    const fetchImpl: typeof fetch = vi.fn(async (input, init) =>
      init?.method === "POST"
        ? response({ ...tunnel, id: "../../unrelated" })
        : api.fetchImpl(input, init),
    );
    await expect(ensureDevRelayTunnel(config, fetchImpl)).rejects.toThrow(
      "invalid dedicated relay tunnel identity",
    );
    expect(vi.mocked(fetchImpl).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("checks that the DNS zone is owned by the selected account before creating anything", async () => {
    const api = cloudflare({ accountId: "c".repeat(32) });
    await expect(ensureDevRelayTunnel(config, api.fetchImpl)).rejects.toThrow(
      "configured Cloudflare account",
    );
    expect(api.calls).toHaveLength(1);
  });

  it.each([
    { hostname: "relay.other.test" },
    { hostname: "https://relay-dev.example.test" },
    { port: 0 },
    { accountId: "../../wrong" },
    { namespace: "t3coderelay/managedendpoint" },
    { apiToken: "" },
  ])("rejects invalid input before contacting Cloudflare: %j", async (invalid) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(ensureDevRelayTunnel({ ...config, ...invalid }, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps provider response bodies and fetch errors out of reported errors", async () => {
    const secret = `${config.apiToken} private-connector-token`;
    const providerFailure = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ success: false, errors: [{ message: secret }] }, { status: 403 }),
      );
    const fetchFailure = vi.fn<typeof fetch>().mockRejectedValue(new Error(secret));
    for (const fetchImpl of [providerFailure, fetchFailure]) {
      const error = await ensureDevRelayTunnel(config, fetchImpl).catch(
        (failure: unknown) => failure,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(config.apiToken);
      expect(String(error)).not.toContain("private-connector-token");
      expect(Object.keys(error as Error)).not.toContain("cause");
    }
  });

  it("does not retry an ambiguous failed create", async () => {
    const api = cloudflare();
    const fetchImpl: typeof fetch = vi.fn(async (input, init) =>
      init?.method === "POST"
        ? Response.json({ success: false }, { status: 500 })
        : api.fetchImpl(input, init),
    );
    await expect(ensureDevRelayTunnel(config, fetchImpl)).rejects.toThrow("HTTP 500");
    expect(
      vi.mocked(fetchImpl).mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  });
});
