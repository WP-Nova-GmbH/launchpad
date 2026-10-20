FROM golang:1.26.8-bookworm@sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d AS test
WORKDIR /src
COPY ./shared ./shared
COPY ./clickhouse ./clickhouse
COPY ./orchestrator ./orchestrator
COPY ./db ./db
COPY ./auth ./auth
COPY ./api ./api
WORKDIR /src/shared
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestFS(StoreFile|PutCancelled|MultipartCancelled|ReplaceCancelled|ReplaceFailure|Uncompressed)' ./pkg/storage
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestFSReadHandleCannotWriteOrCreateObjects$' ./pkg/storage
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestRetiredBuild|^TestRetirement' ./pkg/storage
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race ./pkg/restoreresult
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestReferencedBuildIDs' ./pkg/storage/header
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /routing-catalog-tests ./pkg/sandbox-catalog
WORKDIR /src/orchestrator
RUN --mount=type=cache,target=/root/.cache/go-build go test -race -count=1 -timeout=15s ./pkg/factories/shutdown.go ./pkg/factories/shutdown_test.go
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^(TestFinalConfigurationPreservesImageExecutableModes|TestConfigureScriptIsValidBash|TestConfigureScriptInvokesNoCd|TestPackCertBundleCmdIsValidSh)$' ./pkg/template/build/phases/finalize
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -o /network-firewall-tests ./pkg/sandbox/network
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run "^TestApplicationIngressStripsEdgeCredentials$" ./pkg/proxy
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestHostBudget' ./pkg/sandbox/cgroup
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestColdBoot' ./pkg/cfg ./pkg/server
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestBuildKernelArgs|^TestParse|^TestValidateCmdlineArgs' ./pkg/sandbox/fc
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestRetainedBuilds|^TestCollectBuildObjects' ./pkg/template/template
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race ./pkg/sandbox/execution
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race ./pkg/localupload
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^Test(MemfdCopyFault|RunFaultSafe)' ./pkg/sandbox/block
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race ./pkg/routing ./pkg/hostfirewall
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestTracker' ./pkg/metrics
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race ./pkg/sandbox/rootfs ./pkg/sandbox/filesystemtools
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestRestore|^TestCheckpoint' ./pkg/server
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^Test(FilesystemToolReservation|ReleaseDevice|GetDevice|CloseBounds)' ./pkg/sandbox/nbd
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestOfflinePreBoot|^TestGuestPrepareFsForPause|^TestThawRootfs|^TestEnvdPost' ./pkg/sandbox
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -tags=integration -o /filesystem-tool-tests ./pkg/sandbox/filesystemtools
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -tags=integration -o /rootfs-tests ./pkg/sandbox/rootfs
RUN /rootfs-tests -test.list '^TestPreparedDiskOfflineSurvivesSourceDeletion$' | grep -x TestPreparedDiskOfflineSurvivesSourceDeletion
WORKDIR /src/db
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /execution-db-tests ./pkg/executions
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /restore-db-tests ./pkg/tests/restores
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /build-retention-db-tests ./pkg/buildretention
WORKDIR /src/api
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestExecutionStop|^TestLaunchpadPrivateTraffic|^TestLaunchpadCapabilities' ./internal/handlers
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /reservation-tests ./internal/sandbox/reservations/redis
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestRenewable' ./internal/cfg
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -race -run '^TestGetMaxTTL|^TestRenewableLifetimeKeepsFinite|^TestPreparedRestore|^TestLiveCollectionRefuses' ./internal/orchestrator
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /lifetime-api-tests ./internal/orchestrator
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /lifetime-store-tests ./internal/sandbox
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /restore-api-tests ./internal/handlers
WORKDIR /src
RUN go work init ./api ./db ./auth ./shared ./orchestrator ./clickhouse
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod go test -c -race -o /build-collector-tests ./api/cmd/launchpad-build-collector
FROM scratch AS artifacts
COPY --from=test /reservation-tests /reservation-tests
COPY --from=test /rootfs-tests /rootfs-tests
COPY --from=test /filesystem-tool-tests /filesystem-tool-tests
COPY --from=test /restore-db-tests /restore-db-tests
COPY --from=test /restore-api-tests /restore-api-tests
COPY --from=test /routing-catalog-tests /routing-catalog-tests
COPY --from=test /lifetime-api-tests /lifetime-api-tests
COPY --from=test /lifetime-store-tests /lifetime-store-tests
COPY --from=test /execution-db-tests /execution-db-tests
COPY --from=test /build-retention-db-tests /build-retention-db-tests
COPY --from=test /build-collector-tests /build-collector-tests
COPY --from=test /network-firewall-tests /network-firewall-tests
