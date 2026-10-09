import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, relative, resolve, sep } from "node:path";

import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeSnapshot,
  type ClientBridge,
  type CreateProjectInput,
  type RevisionEditRequest,
} from "./protocol.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;

export interface LocalWebLogEvent {
  readonly code: string;
  readonly method?: string;
  readonly route?: string;
  readonly status?: number;
}

export interface LocalWebHostOptions {
  readonly staticRoot: string;
  readonly bridgeFactory: () => ClientBridge;
  readonly bootstrapTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly pollTimeoutMs?: number;
  readonly now?: () => number;
  readonly logger?: (event: LocalWebLogEvent) => void;
}

export interface RunningLocalWebHost {
  readonly origin: string;
  readonly port: number;
  close(): Promise<void>;
}

interface SessionCapability {
  readonly bridge: ClientBridge;
  readonly expiresAt: number;
}

interface JsonError {
  readonly error: { readonly code: string; readonly message: string };
}

class LocalWebRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "LocalWebRequestError";
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  response.end(JSON.stringify(body));
}

function requestHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > MAX_REQUEST_BYTES) {
      throw new LocalWebRequestError(
        413,
        "REQUEST_TOO_LARGE",
        "Request body exceeds the local bridge limit",
      );
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new LocalWebRequestError(
      400,
      "INVALID_JSON",
      "Request body must be valid JSON",
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LocalWebRequestError(
      400,
      "INVALID_REQUEST",
      "Request payload must be an object",
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 20_000,
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.trim().length === 0 ||
    candidate.length > maxLength
  ) {
    throw new LocalWebRequestError(
      400,
      "INVALID_REQUEST",
      `${key} must be a non-empty bounded string`,
    );
  }
  return candidate;
}

function requiredInteger(value: Record<string, unknown>, key: string): number {
  const candidate = value[key];
  if (!Number.isSafeInteger(candidate) || Number(candidate) < 0) {
    throw new LocalWebRequestError(
      400,
      "INVALID_REQUEST",
      `${key} must be a non-negative safe integer`,
    );
  }
  return Number(candidate);
}

function nullableString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 20_000,
): string | null {
  const candidate = value[key];
  if (candidate === null) return null;
  return requiredString(value, key, maxLength);
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength = 20_000,
): string | undefined {
  const candidate = value[key];
  if (candidate === undefined) return undefined;
  if (typeof candidate !== "string" || candidate.length > maxLength) {
    throw new LocalWebRequestError(
      400,
      "INVALID_REQUEST",
      `${key} must be a bounded string when provided`,
    );
  }
  return candidate;
}

function projectMaterials(value: Record<string, unknown>): CreateProjectInput["materials"] {
  const candidate = value.materials;
  if (!Array.isArray(candidate) || candidate.length > 100) {
    throw new LocalWebRequestError(400, "INVALID_REQUEST", "materials must be an array");
  }
  return candidate.map((entry) => {
    const material = record(entry);
    const role = requiredString(material, "role", 32);
    const sourceKind = requiredString(material, "sourceKind", 32);
    if (
      role !== "user_firsthand" &&
      role !== "source_verified" &&
      role !== "illustrative"
    ) {
      throw new LocalWebRequestError(400, "INVALID_REQUEST", "material role is invalid");
    }
    if (
      sourceKind !== "pasted_text" &&
      sourceKind !== "utf8_file" &&
      sourceKind !== "web_snapshot"
    ) {
      throw new LocalWebRequestError(400, "INVALID_REQUEST", "material sourceKind is invalid");
    }
    return {
      name: requiredString(material, "name", 512),
      content: requiredString(material, "content", 2_000_000),
      role,
      sourceKind,
      sourceReference: nullableString(material, "sourceReference", 4_096),
    };
  });
}

function optionalStringArray(
  value: Record<string, unknown>,
  key: string,
): readonly string[] {
  const candidate = value[key];
  if (candidate === undefined) return [];
  if (
    !Array.isArray(candidate) ||
    candidate.length > 100 ||
    candidate.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.trim().length === 0 ||
        entry.length > 2_000,
    )
  ) {
    throw new LocalWebRequestError(
      400,
      "INVALID_REQUEST",
      `${key} must be a bounded string array`,
    );
  }
  return candidate as string[];
}

function requiredRevisionEdits(
  value: Record<string, unknown>,
): readonly RevisionEditRequest[] {
  const candidate = value.edits;
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > 100) {
    throw new LocalWebRequestError(
      400,
      "INVALID_REQUEST",
      "edits must be a non-empty bounded array",
    );
  }
  return candidate.map((entry): RevisionEditRequest => {
    const edit = record(entry);
    const type = requiredString(edit, "type", 32);
    if (
      type !== "replace" &&
      type !== "delete" &&
      type !== "insert_before" &&
      type !== "insert_after"
    ) {
      throw new LocalWebRequestError(
        400,
        "INVALID_REQUEST",
        "Revision edit type is unsupported",
      );
    }
    const targetBlockId = requiredString(edit, "targetBlockId", 512);
    const baseBlockHash = requiredString(edit, "baseBlockHash", 64);
    if (!/^[a-f0-9]{64}$/u.test(baseBlockHash)) {
      throw new LocalWebRequestError(
        400,
        "INVALID_REQUEST",
        "baseBlockHash must be a SHA-256 value",
      );
    }
    if (type === "delete") return { type, targetBlockId, baseBlockHash };
    return {
      type,
      targetBlockId,
      baseBlockHash,
      content: requiredString(edit, "content", 1_000_000),
    };
  });
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function securityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-opener-policy", "same-origin");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  );
}

function bridgeCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]+$/u.test(error.message)) {
    return error.message;
  }
  return "BRIDGE_COMMAND_FAILED";
}

function assertGeneration(
  bridge: ClientBridge,
  body: Record<string, unknown>,
): void {
  const generation = requiredInteger(body, "generation");
  if (generation !== bridge.getSnapshot().generation) {
    throw new LocalWebRequestError(
      409,
      "STALE_CLIENT_GENERATION",
      "Client project generation is stale; refresh before retrying",
    );
  }
}

function waitForRevision(
  bridge: ClientBridge,
  afterRevision: number,
  timeoutMs: number,
): Promise<BridgeSnapshot> {
  const current = bridge.getSnapshot();
  if (current.revision > afterRevision || timeoutMs <= 0) {
    return Promise.resolve(current);
  }
  return new Promise((resolveSnapshot) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe = (): void => undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      unsubscribe();
      resolveSnapshot(bridge.getSnapshot());
    };
    unsubscribe = bridge.subscribe(finish);
    timeout = setTimeout(finish, timeoutMs);
  });
}

export async function startLocalWebHost(
  options: LocalWebHostOptions,
): Promise<RunningLocalWebHost> {
  const staticRoot = resolve(options.staticRoot);
  const now = options.now ?? Date.now;
  const bootstrapTtlMs = options.bootstrapTtlMs ?? 60_000;
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 60_000;
  const pollTimeoutMs = options.pollTimeoutMs ?? 1_000;
  const log = options.logger ?? (() => undefined);
  const bootstrapCapabilities = new Map<string, number>();
  const sessionCapabilities = new Map<string, SessionCapability>();
  let allowedHost = "";
  let allowedOrigin = "";

  const purgeExpired = (): void => {
    const timestamp = now();
    for (const [hash, expiresAt] of bootstrapCapabilities) {
      if (expiresAt <= timestamp) bootstrapCapabilities.delete(hash);
    }
    for (const [hash, session] of sessionCapabilities) {
      if (session.expiresAt <= timestamp) {
        session.bridge.dispose();
        sessionCapabilities.delete(hash);
      }
    }
  };

  const issueBootstrap = (): string => {
    const token = randomBytes(32).toString("base64url");
    bootstrapCapabilities.set(tokenHash(token), now() + bootstrapTtlMs);
    return token;
  };

  const issueSession = (bridge: ClientBridge): { token: string; expiresAt: number } => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now() + sessionTtlMs;
    sessionCapabilities.set(tokenHash(token), { bridge, expiresAt });
    return { token, expiresAt };
  };

  const validateNetworkBoundary = (request: IncomingMessage): void => {
    const host = requestHeader(request, "host");
    const origin = requestHeader(request, "origin");
    if (!safeEqual(host, allowedHost)) {
      throw new LocalWebRequestError(
        403,
        "HOST_REJECTED",
        "Request Host is not the active loopback listener",
      );
    }
    if (!safeEqual(origin, allowedOrigin)) {
      throw new LocalWebRequestError(
        403,
        "ORIGIN_REJECTED",
        "Request Origin is not the active local application origin",
      );
    }
    if (
      requestHeader(request, "x-writing-agent-protocol") !==
      String(UI_BRIDGE_PROTOCOL_VERSION)
    ) {
      throw new LocalWebRequestError(
        409,
        "PROTOCOL_VERSION_MISMATCH",
        "Client and local runtime protocol versions are incompatible",
      );
    }
  };

  const consumeBootstrap = (request: IncomingMessage): void => {
    const capability = requestHeader(request, "x-writing-agent-capability");
    const hash = tokenHash(capability);
    const expiresAt = bootstrapCapabilities.get(hash);
    if (expiresAt === undefined || expiresAt <= now()) {
      throw new LocalWebRequestError(
        401,
        "CAPABILITY_REJECTED",
        "Bootstrap capability is missing, expired, or already used",
      );
    }
    bootstrapCapabilities.delete(hash);
  };

  const requireSession = (request: IncomingMessage): SessionCapability => {
    const capability = requestHeader(request, "x-writing-agent-capability");
    const session = sessionCapabilities.get(tokenHash(capability));
    if (session === undefined || session.expiresAt <= now()) {
      throw new LocalWebRequestError(
        401,
        "CAPABILITY_REJECTED",
        "Session capability is missing or expired",
      );
    }
    return session;
  };

  const handleApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    route: string,
  ): Promise<void> => {
    if (request.method !== "POST") {
      throw new LocalWebRequestError(
        405,
        "METHOD_NOT_ALLOWED",
        "Local bridge endpoints accept POST only",
      );
    }
    validateNetworkBoundary(request);
    purgeExpired();
    const body = record(await readJsonBody(request));

    if (route === "/api/v6/handshake") {
      consumeBootstrap(request);
      if (requiredInteger(body, "protocolVersion") !== UI_BRIDGE_PROTOCOL_VERSION) {
        throw new LocalWebRequestError(
          409,
          "PROTOCOL_VERSION_MISMATCH",
          "Client and local runtime protocol versions are incompatible",
        );
      }
      const bridge = options.bridgeFactory();
      try {
        const handshake = await bridge.handshake();
        if (
          handshake.protocolVersion !== UI_BRIDGE_PROTOCOL_VERSION ||
          handshake.mock ||
          !handshake.persistsUserProjects
        ) {
          throw new LocalWebRequestError(
            503,
            "UNSAFE_APPLICATION_BRIDGE",
            "Local Web requires the persistent Application Service bridge",
          );
        }
        const capability = issueSession(bridge);
        json(response, 200, {
          handshake,
          capability: capability.token,
          capabilityExpiresAt: new Date(capability.expiresAt).toISOString(),
        });
        return;
      } catch (error) {
        bridge.dispose();
        throw error;
      }
    }

    const session = requireSession(request);
    const bridge = session.bridge;
    if (route === "/api/v6/snapshot") {
      await bridge.refresh();
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/events/poll") {
      assertGeneration(bridge, body);
      const afterRevision = requiredInteger(body, "afterRevision");
      await bridge.refresh();
      const snapshot = await waitForRevision(
        bridge,
        afterRevision,
        Math.min(pollTimeoutMs, 5_000),
      );
      json(response, 200, {
        changed: snapshot.revision > afterRevision,
        snapshot,
      });
      return;
    }

    assertGeneration(bridge, body);
    if (route === '/api/v6/trace/detail') {
      const result = await bridge.getRunTraceDetail({ projectId: requiredString(body, 'projectId', 512),
        sessionId: requiredString(body, 'sessionId', 512), runId: requiredString(body, 'runId', 512), stepId: requiredString(body, 'stepId', 512) });
      json(response, 200, { result });
      return;
    }
    if (route === "/api/v6/command/update-settings") {
      const theme = requiredString(body, "theme", 16);
      if (theme !== "light" && theme !== "dark" && theme !== "system") {
        throw new LocalWebRequestError(
          400,
          "INVALID_REQUEST",
          "theme must be light, dark, or system",
        );
      }
      await bridge.updateSettings({
        theme,
        contentFontSize: requiredInteger(body, "contentFontSize"),
      });
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/select-session") {
      await bridge.selectSession(
        requiredString(body, "projectId", 512),
        requiredString(body, "sessionId", 512),
      );
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/select-project") {
      await bridge.selectProject(requiredString(body, "projectId", 512));
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/create-project") {
      const mode = requiredString(body, "mode", 16);
      const genre = requiredString(body, "genre", 64);
      const interactionMode = requiredString(body, "interactionMode", 32);
      const styleDecision = requiredString(body, "styleDecision", 32);
      const directionDecision = requiredString(body, "directionDecision", 32);
      const publicationGoal = requiredString(body, "publicationGoal", 32);
      if (mode !== "quick" && mode !== "deep") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "mode must be quick or deep");
      }
      if (
        genre !== "argument_commentary" &&
        genre !== "explanatory_analysis" &&
        genre !== "narrative_observation" &&
        genre !== "practical_experience"
      ) {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "genre is invalid");
      }
      if (interactionMode !== "autonomous" && interactionMode !== "co_creation") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "interactionMode is invalid");
      }
      if (styleDecision !== "user_confirmed" && styleDecision !== "user_delegated" && styleDecision !== "unspecified") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "styleDecision is invalid");
      }
      if (directionDecision !== "user_confirmed" && directionDecision !== "user_delegated" && directionDecision !== "tentative") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "directionDecision is invalid");
      }
      if (publicationGoal !== "primary" && publicationGoal !== "secondary" && publicationGoal !== "not_applicable") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "publicationGoal is invalid");
      }
      const result = await bridge.createProject({
        name: requiredString(body, "name", 256),
        mode,
        topic: requiredString(body, "topic", 2_000),
        genre,
        audience: requiredString(body, "audience", 1_000),
        targetCharacters: requiredInteger(body, "targetCharacters"),
        constraints: optionalStringArray(body, "constraints"),
        interactionMode,
        authorVoice: nullableString(body, "authorVoice", 2_000),
        styleReference: nullableString(body, "styleReference", 2_000),
        styleDecision,
        directionDecision,
        platform: nullableString(body, "platform", 1_000),
        publicationGoal,
        materials: projectMaterials(body),
      }, {
        operationId: requiredString(body, "operationId", 512),
      });
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/rename-project") {
      if (bridge.renameProject === undefined) {
        throw new LocalWebRequestError(501, "PROJECT_RENAME_UNSUPPORTED", "Project rename is not supported by this runtime");
      }
      await bridge.renameProject(
        requiredString(body, "projectId", 512),
        requiredString(body, "name", 60),
        { operationId: requiredString(body, "operationId", 512) },
      );
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/update-brief") {
      const genre = requiredString(body, "genre", 64);
      const interactionMode = requiredString(body, "interactionMode", 32);
      const styleDecision = requiredString(body, "styleDecision", 32);
      const directionDecision = requiredString(body, "directionDecision", 32);
      const publicationGoal = requiredString(body, "publicationGoal", 32);
      if (
        genre !== "argument_commentary" &&
        genre !== "explanatory_analysis" &&
        genre !== "narrative_observation" &&
        genre !== "practical_experience"
      ) {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "genre is invalid");
      }
      if (interactionMode !== "autonomous" && interactionMode !== "co_creation") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "interactionMode is invalid");
      }
      if (styleDecision !== "user_confirmed" && styleDecision !== "user_delegated" && styleDecision !== "unspecified") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "styleDecision is invalid");
      }
      if (directionDecision !== "user_confirmed" && directionDecision !== "user_delegated" && directionDecision !== "tentative") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "directionDecision is invalid");
      }
      if (publicationGoal !== "primary" && publicationGoal !== "secondary" && publicationGoal !== "not_applicable") {
        throw new LocalWebRequestError(400, "INVALID_REQUEST", "publicationGoal is invalid");
      }
      await bridge.updateBrief({
        topic: requiredString(body, "topic", 2_000),
        genre,
        audience: requiredString(body, "audience", 1_000),
        targetCharacters: requiredInteger(body, "targetCharacters"),
        constraints: optionalStringArray(body, "constraints"),
        interactionMode,
        authorVoice: nullableString(body, "authorVoice", 2_000),
        styleReference: nullableString(body, "styleReference", 2_000),
        styleDecision,
        directionDecision,
        platform: nullableString(body, "platform", 1_000),
        publicationGoal,
      }, {
        operationId: requiredString(body, "operationId", 512),
      });
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/confirm-brief") {
      await bridge.confirmBrief({
        operationId: requiredString(body, "operationId", 512),
      });
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/start-run") {
      const operationId = requiredString(body, "operationId", 512);
      const result = await bridge.sendMessage(requiredString(body, "text"), {
        operationId,
      });
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/start-conversation" || route === "/api/v6/command/confirm-conversation") {
      const options = { operationId: requiredString(body, "operationId", 512) };
      const result = route.endsWith("/start-conversation")
        ? await bridge.startConversation(requiredString(body, "text", 20_000), options)
        : await bridge.confirmConversation(requiredString(body, "proposalVersionId", 512), options);
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/run-fact-check") {
      const result = await bridge.runFactCheck({
        operationId: requiredString(body, "operationId", 512),
      });
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/cancel-run") {
      const operationId = requiredString(body, "operationId", 512);
      await bridge.cancelRun(requiredString(body, "runId", 512), {
        operationId,
      });
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/resume-run") {
      const decision = requiredString(body, "decision", 32);
      if (decision !== "resume" && decision !== "retry_unknown") {
        throw new LocalWebRequestError(
          400,
          "INVALID_REQUEST",
          "decision must be resume or retry_unknown",
        );
      }
      const operationId = requiredString(body, "operationId", 512);
      const feedback = optionalString(body, "feedback", 4_000);
      const searchDecision = body.factSearchDecision as import('./protocol.js').ResumeRunOptions['factSearchDecision'];
      if (searchDecision !== undefined && (!searchDecision || typeof searchDecision !== 'object' ||
        typeof searchDecision.requestId !== 'string' || !searchDecision.requestId.trim() || searchDecision.requestId.length > 512 ||
        !['retry', 'extend', 'continue'].includes(searchDecision.action))) throw new LocalWebRequestError(400, 'INVALID_REQUEST', 'Invalid search decision');
      const approval = body.checkpointApproval as { eventSeq?: unknown; bodyVersionId?: unknown; briefVersionId?: unknown } | undefined;
      if (approval !== undefined && (!approval || typeof approval !== 'object' ||
          !Number.isSafeInteger(approval.eventSeq) || Number(approval.eventSeq) < 1 ||
          !(approval.bodyVersionId === null || typeof approval.bodyVersionId === 'string') ||
          !(approval.briefVersionId === null || typeof approval.briefVersionId === 'string'))) {
        throw new LocalWebRequestError(400, 'INVALID_REQUEST', 'Invalid checkpoint approval');
      }
      await bridge.resumeRun(
        requiredString(body, "runId", 512),
        decision,
        { operationId, ...(feedback === undefined ? {} : { feedback }),
          ...(searchDecision === undefined ? {} : { factSearchDecision: searchDecision }),
          ...(approval === undefined ? {} : { checkpointApproval: approval as import('./protocol.js').CheckpointApproval }) },
      );
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/propose-revision") {
      const result = await bridge.proposeRevision(
        {
          baseBodyVersionId: requiredString(body, "baseBodyVersionId", 512),
          instruction: requiredString(body, "instruction"),
          constraints: optionalStringArray(body, "constraints"),
          edits: requiredRevisionEdits(body),
        },
        { operationId: requiredString(body, "operationId", 512) },
      );
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/accept-revision") {
      const result = await bridge.acceptRevision(
        requiredString(body, "proposalId", 512),
        { operationId: requiredString(body, "operationId", 512) },
      );
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/reject-revision") {
      await bridge.rejectRevision(
        requiredString(body, "proposalId", 512),
        requiredString(body, "reason", 2_000),
        { operationId: requiredString(body, "operationId", 512) },
      );
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/save-body") {
      const result = await bridge.saveBody(
        requiredString(body, "baseBodyVersionId", 512),
        requiredString(body, "content", 1_000_000),
        requiredString(body, "reason", 2_000),
        { operationId: requiredString(body, "operationId", 512) },
      );
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/block-lock") {
      const action = requiredString(body, "action", 16);
      if (action !== "lock" && action !== "unlock") {
        throw new LocalWebRequestError(
          400,
          "INVALID_REQUEST",
          "action must be lock or unlock",
        );
      }
      await bridge.setBlockLock(
        requiredString(body, "baseBodyVersionId", 512),
        requiredString(body, "blockId", 512),
        requiredString(body, "blockHash", 64),
        action,
        { operationId: requiredString(body, "operationId", 512) },
      );
      json(response, 200, { snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/rollback-body") {
      const result = await bridge.rollbackBody(
        requiredString(body, "targetVersionId", 512),
        requiredString(body, "reason", 2_000),
        { operationId: requiredString(body, "operationId", 512) },
      );
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/save-working-copy") {
      const result = await bridge.saveWorkingCopy({
        operationId: requiredString(body, "operationId", 512),
      });
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    if (route === "/api/v6/command/export-publication") {
      const format = requiredString(body, "format", 16);
      if (format !== "txt" && format !== "html") {
        throw new LocalWebRequestError(
          400,
          "INVALID_REQUEST",
          "format must be txt or html",
        );
      }
      const layoutPreset = optionalString(body, "layoutPreset", 16) ?? "clean";
      if (
        layoutPreset !== "clean" &&
        layoutPreset !== "editorial" &&
        layoutPreset !== "compact"
      ) {
        throw new LocalWebRequestError(
          400,
          "INVALID_REQUEST",
          "layoutPreset must be clean, editorial, or compact",
        );
      }
      const result = await bridge.exportPublication(format, {
        operationId: requiredString(body, "operationId", 512),
        layoutPreset,
      });
      json(response, 200, { result, snapshot: bridge.getSnapshot() });
      return;
    }
    throw new LocalWebRequestError(404, "ROUTE_NOT_FOUND", "Route not found");
  };

  const handleStatic = async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      throw new LocalWebRequestError(405, "METHOD_NOT_ALLOWED", "Method not allowed");
    }
    if (!safeEqual(requestHeader(request, "host"), allowedHost)) {
      throw new LocalWebRequestError(403, "HOST_REJECTED", "Invalid Host");
    }
    const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
    if (relativePath.endsWith(".map") || relativePath.includes("\0")) {
      throw new LocalWebRequestError(404, "ASSET_NOT_FOUND", "Asset not found");
    }
    const path = resolve(staticRoot, relativePath);
    const pathRelative = relative(staticRoot, path);
    if (
      pathRelative.startsWith(`..${sep}`) ||
      pathRelative === ".." ||
      pathRelative.includes(`${sep}.${sep}`)
    ) {
      throw new LocalWebRequestError(404, "ASSET_NOT_FOUND", "Asset not found");
    }
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch {
      throw new LocalWebRequestError(404, "ASSET_NOT_FOUND", "Asset not found");
    }
    if (relativePath === "index.html") {
      const capability = issueBootstrap();
      const marker = `<meta name="writing-agent-bootstrap-capability" content="${capability}">`;
      data = Buffer.from(
        data.toString("utf8").replace("</head>", `    ${marker}\n  </head>`),
        "utf8",
      );
    }
    securityHeaders(response);
    response.writeHead(200, {
      "content-type": contentType(path),
      "content-length": data.byteLength,
      "cache-control": relativePath === "index.html" ? "no-store" : "public, max-age=31536000, immutable",
    });
    response.end(request.method === "HEAD" ? undefined : data);
  };

  const server = createServer((request, response) => {
    void (async () => {
      const route = new URL(request.url ?? "/", "http://local.invalid").pathname;
      try {
        if (route.startsWith("/api/")) {
          await handleApi(request, response, route);
        } else {
          await handleStatic(request, response, route);
        }
        log({
          code: "REQUEST_COMPLETED",
          ...(request.method === undefined ? {} : { method: request.method }),
          route,
          status: response.statusCode,
        });
      } catch (error) {
        const failure =
          error instanceof LocalWebRequestError
            ? error
            : new LocalWebRequestError(
                500,
                bridgeCode(error),
                "Local bridge request failed",
              );
        const body: JsonError = {
          error: { code: failure.code, message: failure.message },
        };
        if (!response.headersSent) json(response, failure.status, body);
        else response.destroy();
        log({
          code: failure.code,
          ...(request.method === undefined ? {} : { method: request.method }),
          route,
          status: failure.status,
        });
      }
    })();
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, LOOPBACK_HOST, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("LOCAL_WEB_LISTEN_FAILED");
  }
  allowedHost = `${LOOPBACK_HOST}:${address.port}`;
  allowedOrigin = `http://${allowedHost}`;
  log({ code: "LOCAL_WEB_READY" });

  return {
    origin: allowedOrigin,
    port: address.port,
    close: async () => {
      for (const session of sessionCapabilities.values()) {
        session.bridge.dispose();
      }
      sessionCapabilities.clear();
      bootstrapCapabilities.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error === undefined ? resolveClose() : rejectClose(error)));
      });
    },
  };
}
