/**
 * Managed endpoint tunnel and DNS clients backed by Cloudflare's REST API.
 *
 * The Worker deployment reaches Cloudflare through Alchemy bindings
 * (`layerCloudflareBindings`). A self-hosted relay has no bindings, so it
 * makes the same calls with an API token instead — the seam is
 * `layerTunnelClient` / `layerDnsClient`, and everything above it is shared.
 *
 * The token needs Account -> Cloudflare Tunnel -> Edit and Zone -> DNS -> Edit
 * on the tunnel zone.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import {
  ManagedEndpointDnsClientError,
  type ManagedEndpointTunnel,
  ManagedEndpointTunnelClientError,
  type ManagedEndpointTunnelListRequest,
  layerDnsClient,
  layerTunnelClient,
} from "./ManagedEndpointProvider.ts";

const CLOUDFLARE_API_BASE_URL = "https://api.cloudflare.com/client/v4";

export class CloudflareZoneNotFound extends Schema.TaggedError<CloudflareZoneNotFound>()(
  "CloudflareZoneNotFound",
  { zoneName: Schema.String },
) {
  override get message(): string {
    return `Cloudflare zone '${this.zoneName}' was not found for this token. Check RELAY_TUNNEL_ZONE_NAME and that the token is scoped to that zone.`;
  }
}

export interface CloudflareEndpointSettings {
  readonly apiToken: Redacted.Redacted<string>;
  readonly accountId: string;
  /** The zone that owns tunnel hostnames, e.g. `tunnels.example.com`. */
  readonly zoneId: string;
}

const TunnelResult = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  status: Schema.optionalKey(Schema.NullOr(Schema.String)),
  created_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  conns_inactive_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const toTunnel = (result: typeof TunnelResult.Type): ManagedEndpointTunnel => ({
  id: result.id ?? null,
  name: result.name ?? null,
  status: result.status ?? null,
  createdAt: result.created_at ?? null,
  connsInactiveAt: result.conns_inactive_at ?? null,
});

const decodeTunnelList = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    result: Schema.NullOr(Schema.Array(TunnelResult)),
    result_info: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          page: Schema.optionalKey(Schema.NullOr(Schema.Number)),
          per_page: Schema.optionalKey(Schema.NullOr(Schema.Number)),
          total_count: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        }),
      ),
    ),
  }),
);

/** The same filters the Worker passes to its binding, spelled as Cloudflare's query string. */
const tunnelListQuery = (request: ManagedEndpointTunnelListRequest): string => {
  const params = new URLSearchParams({ is_deleted: "false" });
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined) params.set(key, String(value));
  };
  set("name", request.name);
  set("include_prefix", request.includePrefix);
  set("status", request.status);
  set("existed_at", request.existedAt);
  set("was_inactive_at", request.wasInactiveAt);
  set("page", request.page);
  set("per_page", request.perPage);
  return params.toString();
};
const decodeTunnel = HttpClientResponse.schemaBodyJson(Schema.Struct({ result: TunnelResult }));
const decodeTunnelToken = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ result: Schema.String }),
);
const decodeDnsRecords = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ result: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String }))) }),
);
const decodeDnsRecord = HttpClientResponse.schemaBodyJson(
  Schema.Struct({ result: Schema.Struct({ id: Schema.String }) }),
);

/**
 * Resolves a zone name to its id, so operators configure the hostname they
 * already know rather than an opaque identifier.
 */
export const resolveZoneId = Effect.fn("relay.managed_endpoint.cloudflare.resolve_zone")(
  function* (input: { readonly apiToken: Redacted.Redacted<string>; readonly zoneName: string }) {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* HttpClientRequest.get(
      `${CLOUDFLARE_API_BASE_URL}/zones?name=${encodeURIComponent(input.zoneName)}`,
    ).pipe(
      (request) => HttpClientRequest.bearerToken(request, Redacted.value(input.apiToken)),
      httpClient.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(
        HttpClientResponse.schemaBodyJson(
          Schema.Struct({
            result: Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String }))),
          }),
        ),
      ),
    );
    const zone = response.result?.[0];
    if (!zone) {
      return yield* new CloudflareZoneNotFound({ zoneName: input.zoneName });
    }
    return zone.id;
  },
);

export const layerCloudflareApi = (settings: CloudflareEndpointSettings) => {
  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientRequest.bearerToken(request, Redacted.value(settings.apiToken));
  const accountBase = `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(settings.accountId)}/cfd_tunnel`;
  const zoneBase = `${CLOUDFLARE_API_BASE_URL}/zones/${encodeURIComponent(settings.zoneId)}/dns_records`;

  const tunnelClient = Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const tunnelError =
      (
        operation: ManagedEndpointTunnelClientError["operation"],
        target: { name?: string | undefined; id?: string | undefined },
      ) =>
      (cause: unknown) =>
        new ManagedEndpointTunnelClientError({
          operation,
          ...(target.name === undefined ? {} : { tunnelName: target.name }),
          ...(target.id === undefined ? {} : { tunnelId: target.id }),
          cause,
        });

    return layerTunnelClient({
      get: (tunnelId) =>
        HttpClientRequest.get(`${accountBase}/${encodeURIComponent(tunnelId)}`).pipe(
          authorized,
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeTunnel),
          Effect.map((response) => toTunnel(response.result)),
          Effect.mapError(tunnelError("get", { id: tunnelId })),
        ),
      list: (request) =>
        HttpClientRequest.get(`${accountBase}?${tunnelListQuery(request)}`).pipe(
          authorized,
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeTunnelList),
          Effect.map((response) => ({
            result: (response.result ?? []).map(toTunnel),
            resultInfo:
              response.result_info == null
                ? null
                : {
                    page: response.result_info.page ?? null,
                    perPage: response.result_info.per_page ?? null,
                    totalCount: response.result_info.total_count ?? null,
                  },
          })),
          Effect.mapError(tunnelError("list", { name: request.name })),
        ),
      create: (request) =>
        HttpClientRequest.post(accountBase).pipe(
          authorized,
          HttpClientRequest.bodyJson({ name: request.name, config_src: request.configSrc }),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeTunnel),
          Effect.map((response) => toTunnel(response.result)),
          Effect.mapError(tunnelError("create", { name: request.name })),
        ),
      putConfiguration: (tunnelId, config) =>
        HttpClientRequest.put(`${accountBase}/${encodeURIComponent(tunnelId)}/configurations`).pipe(
          authorized,
          HttpClientRequest.bodyJson({ config }),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(tunnelError("put-configuration", { id: tunnelId })),
        ),
      getToken: (tunnelId) =>
        HttpClientRequest.get(`${accountBase}/${encodeURIComponent(tunnelId)}/token`).pipe(
          authorized,
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeTunnelToken),
          Effect.map((response) => response.result),
          Effect.mapError(tunnelError("get-token", { id: tunnelId })),
        ),
      delete: (tunnelId) =>
        HttpClientRequest.delete(`${accountBase}/${encodeURIComponent(tunnelId)}`).pipe(
          authorized,
          httpClient.execute,
          // A tunnel that is already gone is the outcome delete wanted.
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeed(response)
              : HttpClientResponse.filterStatusOk(response),
          ),
          Effect.mapError(tunnelError("delete", { id: tunnelId })),
        ),
    });
  });

  const dnsClient = Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const dnsError =
      (
        operation: ManagedEndpointDnsClientError["operation"],
        target: { hostname?: string; dnsRecordId?: string },
      ) =>
      (cause: unknown) =>
        new ManagedEndpointDnsClientError({
          operation,
          ...(target.hostname === undefined ? {} : { hostname: target.hostname }),
          ...(target.dnsRecordId === undefined ? {} : { dnsRecordId: target.dnsRecordId }),
          cause,
        });

    return layerDnsClient({
      listRecords: (hostname) =>
        HttpClientRequest.get(`${zoneBase}?type=CNAME&name=${encodeURIComponent(hostname)}`).pipe(
          authorized,
          httpClient.execute,
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeDnsRecords),
          Effect.map((response) => response.result ?? []),
          Effect.mapError(dnsError("list-records", { hostname })),
        ),
      createRecord: (request) =>
        HttpClientRequest.post(zoneBase).pipe(
          authorized,
          HttpClientRequest.bodyJson(request),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(decodeDnsRecord),
          Effect.map((response) => response.result),
          Effect.mapError(dnsError("create-record", { hostname: request.name })),
        ),
      updateRecord: (dnsRecordId, request) =>
        HttpClientRequest.put(`${zoneBase}/${encodeURIComponent(dnsRecordId)}`).pipe(
          authorized,
          HttpClientRequest.bodyJson(request),
          Effect.flatMap(httpClient.execute),
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.mapError(dnsError("update-record", { dnsRecordId, hostname: request.name })),
        ),
      deleteRecord: (dnsRecordId) =>
        HttpClientRequest.delete(`${zoneBase}/${encodeURIComponent(dnsRecordId)}`).pipe(
          authorized,
          httpClient.execute,
          // Already gone is the outcome delete wanted.
          Effect.flatMap((response) =>
            response.status === 404
              ? Effect.succeed(response)
              : HttpClientResponse.filterStatusOk(response),
          ),
          Effect.mapError(dnsError("delete-record", { dnsRecordId })),
        ),
    });
  });

  return Layer.merge(Layer.unwrap(tunnelClient), Layer.unwrap(dnsClient));
};
