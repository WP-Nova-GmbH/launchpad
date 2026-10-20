/**
 * The relay API as an enrolled executor calls it: every request carries the
 * environment credential enrollment left behind. Shared by the services
 * that pull organization state down to an executor so they agree on how the
 * relay is addressed.
 *
 * @module relay/executorRelayClient
 */
import { RelayApi } from "@t3tools/contracts/relay";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import type { ManagedExecutorRelayConfig } from "../cloud/machineEnrollment.ts";

export const makeExecutorRelayApiClient = (
  relayConfig: ManagedExecutorRelayConfig,
  transformRequest: (
    request: HttpClientRequest.HttpClientRequest,
  ) => HttpClientRequest.HttpClientRequest = (request) => request,
) =>
  HttpApiClient.make(RelayApi, {
    baseUrl: relayConfig.url,
    transformClient: HttpClient.mapRequest((request) =>
      transformRequest(
        HttpClientRequest.setHeader(
          request,
          "authorization",
          `Bearer ${relayConfig.environmentCredential}`,
        ),
      ),
    ),
  });
