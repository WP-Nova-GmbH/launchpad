// @effect-diagnostics globalFetch:off - This development bootstrap runs directly in Node.
type DevRelayTunnelConfig = {
  apiToken: string;
  accountId: string;
  zoneName: string;
  hostname: string;
  port: number;
  namespace: string;
};

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const dnsName = (value: string) => value.toLowerCase().replace(/\.$/, "");
const validDnsName = (value: string) =>
  value.length <= 253 &&
  value.split(".").length >= 2 &&
  value.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CloudflareRequestError extends Error {
  readonly conflict: boolean;

  constructor(operation: string, status: number, conflict: boolean) {
    super(
      `Cloudflare could not ${operation} (HTTP ${status}). Check the API token's account, Zone Read, DNS Edit, and Cloudflare Tunnel Edit permissions.`,
    );
    this.conflict = conflict;
  }
}

/** Creates missing relay tunnel/DNS resources and reuses matching ones without overwriting conflicts. */
export async function ensureDevRelayTunnel(
  config: DevRelayTunnelConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tunnelId: string; hostname: string; connectorToken: string }> {
  const hostname = dnsName(config.hostname);
  const zoneName = dnsName(config.zoneName);
  if (!config.apiToken.trim() || /\s/.test(config.apiToken)) {
    throw new Error("Set a nonempty Cloudflare API token without whitespace.");
  }
  if (!/^[a-f0-9]{32}$/i.test(config.accountId)) {
    throw new Error("Set the 32-character Cloudflare account ID.");
  }
  if (!validDnsName(zoneName) || !validDnsName(hostname)) {
    throw new Error("Set valid Cloudflare zone and relay DNS hostnames, without a URL or path.");
  }
  if (hostname !== zoneName && !hostname.endsWith(`.${zoneName}`)) {
    throw new Error("The relay hostname must belong to the configured Cloudflare zone.");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new Error("The local relay port must be between 1 and 65535.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(config.namespace)) {
    throw new Error("Use a relay namespace of 1–48 lowercase letters, numbers, or hyphens.");
  }

  const request = async (operation: string, path: string, method = "GET", body?: unknown) => {
    let response: Response;
    try {
      response = await fetchImpl(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: {
          authorization: `Bearer ${config.apiToken}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch {
      // Fetch errors and provider error bodies can contain credentials. Keep them out of logs.
      throw new Error(`Cloudflare could not ${operation}. Check connectivity and try again.`);
    }
    let payload: Record<string, unknown>;
    try {
      payload = object(await response.json());
    } catch {
      throw new Error(`Cloudflare returned an invalid response while trying to ${operation}.`);
    }
    if (!response.ok || payload.success !== true) {
      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const conflict =
        response.status === 409 ||
        errors.some((error) => {
          const { message, code } = object(error);
          return (
            code === 81057 ||
            (typeof message === "string" &&
              /\balready exists\b|\balready been taken\b/i.test(message))
          );
        });
      throw new CloudflareRequestError(operation, response.status, conflict);
    }
    return payload;
  };
  const list = async (operation: string, path: string, query: Record<string, string>) => {
    const results: unknown[] = [];
    for (let page = 1; ; page++) {
      const params = new URLSearchParams({ ...query, page: String(page), per_page: "100" });
      const payload = await request(operation, `${path}?${params}`);
      if (!Array.isArray(payload.result)) {
        throw new Error(`Cloudflare returned an invalid list while trying to ${operation}.`);
      }
      results.push(...payload.result);
      const totalPages = object(payload.result_info).total_pages ?? 1;
      if (!Number.isInteger(totalPages) || Number(totalPages) > 100) {
        throw new Error(`Cloudflare returned invalid pagination while trying to ${operation}.`);
      }
      if (page >= Number(totalPages)) return results;
    }
  };

  const zones = (await list("find the relay DNS zone", "/zones", { name: zoneName })).filter(
    (zone) => object(zone).name === zoneName,
  );
  const zone = object(zones[0]);
  if (zones.length !== 1 || object(zone.account).id !== config.accountId) {
    throw new Error("The configured DNS zone was not found in the configured Cloudflare account.");
  }
  if (typeof zone.id !== "string" || !/^[a-f0-9]{32}$/i.test(zone.id)) {
    throw new Error("Cloudflare returned an invalid DNS zone ID.");
  }
  const accountPath = `/accounts/${encodeURIComponent(config.accountId)}/cfd_tunnel`;
  const tunnelName = `launchpad-relay-${config.namespace}`;
  const findTunnel = async () => {
    const tunnels = (
      await list("find the dedicated relay tunnel", accountPath, {
        name: tunnelName,
        is_deleted: "false",
      })
    ).filter((tunnel) => object(tunnel).name === tunnelName);
    if (tunnels.length > 1) throw new Error("More than one dedicated relay tunnel has this name.");
    return tunnels[0];
  };
  let tunnel = await findTunnel();
  let created = false;
  if (tunnel === undefined) {
    try {
      tunnel = (
        await request("create the dedicated relay tunnel", accountPath, "POST", {
          name: tunnelName,
          config_src: "cloudflare",
        })
      ).result;
      created = true;
    } catch (error) {
      if (!(error instanceof CloudflareRequestError) || !error.conflict) throw error;
      tunnel = await findTunnel();
      if (tunnel === undefined) throw error;
    }
  }
  const { id: tunnelId, name, config_src: configSource } = object(tunnel);
  if (typeof tunnelId !== "string" || !uuid.test(tunnelId) || name !== tunnelName) {
    throw new Error("Cloudflare returned an invalid dedicated relay tunnel identity.");
  }
  if (configSource !== "cloudflare") {
    throw new Error("The dedicated relay tunnel must use Cloudflare-managed configuration.");
  }
  const tunnelPath = `${accountPath}/${encodeURIComponent(tunnelId)}`;
  const ingress = [
    { hostname, service: `http://127.0.0.1:${config.port}` },
    { service: "http_status:404" },
  ];
  let configure = created;
  if (!created) {
    const result = object(
      (await request("check the dedicated relay tunnel routes", `${tunnelPath}/configurations`))
        .result,
    );
    const existing = object(result.config);
    const rules = existing.ingress;
    const isRule = (rule: unknown, expected: (typeof ingress)[number]) => {
      const fields = object(rule);
      return (
        fields.hostname === expected.hostname &&
        fields.service === expected.service &&
        Object.keys(fields).every((key) =>
          ["hostname", "service", "originRequest"].includes(key),
        ) &&
        Object.keys(object(fields.originRequest)).length === 0
      );
    };
    const noOtherConfiguration =
      object(existing["warp-routing"]).enabled !== true &&
      Object.keys(object(existing.originRequest)).length === 0;
    const matches =
      Array.isArray(rules) &&
      rules.length === ingress.length &&
      rules.every((rule, index) => isRule(rule, ingress[index]!)) &&
      noOtherConfiguration;
    configure =
      noOtherConfiguration &&
      (rules === undefined ||
        (Array.isArray(rules) &&
          (rules.length === 0 || (rules.length === 1 && isRule(rules[0], ingress[1]!)))));
    if (!matches && !configure) {
      throw new Error(
        "The dedicated relay tunnel already has different routes. Leave it unchanged and choose another namespace.",
      );
    }
  }
  if (configure) {
    await request("configure the dedicated relay tunnel", `${tunnelPath}/configurations`, "PUT", {
      config: { ingress },
    });
  }

  const dnsPath = `/zones/${encodeURIComponent(zone.id)}/dns_records`;
  const findDns = async () =>
    (await list("check the relay DNS record", dnsPath, { name: hostname })).filter((record) => {
      const { name: recordName } = object(record);
      return typeof recordName === "string" && dnsName(recordName) === hostname;
    });
  let records = await findDns();
  if (records.length === 0) {
    try {
      const created = await request("create the relay DNS record", dnsPath, "POST", {
        type: "CNAME",
        name: hostname,
        content: `${tunnelId}.cfargotunnel.com`,
        proxied: true,
      });
      records = [created.result];
    } catch (error) {
      if (!(error instanceof CloudflareRequestError) || !error.conflict) throw error;
      records = await findDns();
      if (records.length === 0) throw error;
    }
  }
  const record = object(records[0]);
  if (
    records.length !== 1 ||
    record.type !== "CNAME" ||
    typeof record.name !== "string" ||
    dnsName(record.name) !== hostname ||
    typeof record.content !== "string" ||
    dnsName(record.content) !== `${tunnelId.toLowerCase()}.cfargotunnel.com`
  ) {
    throw new Error(
      "The relay hostname already has a different DNS target. Choose an unused hostname.",
    );
  }
  if (record.proxied !== true) {
    throw new Error("Enable Cloudflare proxying for the existing relay CNAME, then try again.");
  }
  const connectorToken = (
    await request("read the dedicated relay connector token", `${tunnelPath}/token`)
  ).result;
  if (typeof connectorToken !== "string" || !connectorToken || /\s/.test(connectorToken)) {
    throw new Error("Cloudflare returned an invalid relay connector token.");
  }
  return { tunnelId, hostname, connectorToken };
}
