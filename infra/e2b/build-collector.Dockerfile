FROM golang:1.26.8-bookworm@sha256:a688600ca24f8a4d3ca77f95b0dd40704a9fc787c826660eb7ba0b641b8b175d AS build
WORKDIR /src
COPY ./shared ./shared
COPY ./clickhouse ./clickhouse
COPY ./orchestrator ./orchestrator
COPY ./db ./db
COPY ./auth ./auth
COPY ./api ./api
RUN go work init ./api ./db ./auth ./shared ./orchestrator ./clickhouse
RUN --mount=type=cache,target=/root/.cache/go-build --mount=type=cache,target=/go/pkg/mod CGO_ENABLED=0 go build -trimpath -o /launchpad-build-collector ./api/cmd/launchpad-build-collector
FROM scratch
COPY --from=build /launchpad-build-collector /launchpad-build-collector
ENTRYPOINT ["/launchpad-build-collector"]
