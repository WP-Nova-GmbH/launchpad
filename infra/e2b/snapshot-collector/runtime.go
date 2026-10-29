package main

import (
	"context"
	"errors"
	"time"

	orchestrator "github.com/e2b-dev/infra/packages/shared/pkg/grpc/orchestrator"
	info "github.com/e2b-dev/infra/packages/shared/pkg/grpc/orchestrator-info"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/types/known/emptypb"
)

func inspectRuntime(ctx context.Context, address string) (runtimeInventory, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	connection, err := grpc.NewClient(address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return runtimeInventory{}, errors.New("native orchestrator connection is unavailable")
	}
	defer connection.Close()
	state, err := info.NewInfoServiceClient(connection).ServiceInfo(ctx, &emptypb.Empty{})
	if err != nil {
		return runtimeInventory{}, errors.New("native work inventory is unavailable")
	}
	guests, err := orchestrator.NewSandboxServiceClient(connection).List(ctx, &emptypb.Empty{})
	if err != nil {
		return runtimeInventory{}, errors.New("native VM inventory is unavailable")
	}
	if state.GetServiceStartup() == nil || state.GetServiceStartup().CheckValid() != nil {
		return runtimeInventory{}, errors.New("native runtime startup identity is incomplete")
	}
	result := runtimeInventory{Commit: state.GetServiceCommit(), NodeID: state.GetNodeId(), ServiceID: state.GetServiceId(), Startup: state.GetServiceStartup().AsTime(), Healthy: state.GetServiceStatus() == info.ServiceInfoStatus_Healthy, RunningVMs: state.GetMetricSandboxesRunning(), OutstandingWork: state.GetOutstandingWork(), BuildIDs: []string{}}
	for _, guest := range guests.GetSandboxes() {
		id := guest.GetConfig().GetBuildId()
		if !validBuildID(id) {
			return runtimeInventory{}, errors.New("native VM build identity is incomplete")
		}
		result.BuildIDs = append(result.BuildIDs, id)
	}
	return result, nil
}
