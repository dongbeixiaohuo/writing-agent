import type { ModelRequest } from "./types.js";

const connectionProbeRequests = new WeakSet<ModelRequest>();

export function markConnectionProbeRequest(request: ModelRequest): ModelRequest {
  connectionProbeRequests.add(request);
  return request;
}

export function isConnectionProbeRequest(request: ModelRequest): boolean {
  return connectionProbeRequests.has(request);
}
