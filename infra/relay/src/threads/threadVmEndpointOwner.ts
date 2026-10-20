/** Separate allocation namespace: a VM's connector never manages its owner's personal tunnels. */
export const threadVmEndpointOwner = (allocationId: string) => `thread-vm:${allocationId}`;
