import { spawn } from "node:child_process";

export type CredentialPersistence = "system" | "session";
export type CredentialFallbackReason =
  | "system_unavailable"
  | "system_write_failed"
  | null;

export interface CredentialMetadata {
  readonly reference: string;
  readonly configured: boolean;
  readonly persistence: CredentialPersistence | "environment" | "missing";
  readonly fallbackReason: CredentialFallbackReason;
}

export interface SystemCredentialBackend {
  isAvailable(): Promise<boolean>;
  read(id: string): Promise<string | null>;
  write(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export type CredentialCommandRequest =
  | { readonly operation: "probe" }
  | { readonly operation: "read" | "delete"; readonly target: string }
  | {
      readonly operation: "write";
      readonly target: string;
      readonly secretBase64: string;
    };

export type CredentialCommandResponse =
  | {
      readonly ok: true;
      readonly found?: boolean;
      readonly secretBase64?: string;
    }
  | { readonly ok: false; readonly errorCode?: number };

export type CredentialCommandInvoker = (
  request: CredentialCommandRequest,
) => Promise<CredentialCommandResponse>;

export class CredentialStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CredentialStoreError";
  }
}

const MANAGED_PREFIX = "managed:";
const ENV_PREFIX = "env:";
const TARGET_PREFIX = "WritingAgent/1.0/";
const MAX_SECRET_BYTES = 2_048;
const MAX_SUBPROCESS_OUTPUT_BYTES = 64 * 1024;

function validateCredentialId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
    throw new CredentialStoreError(
      "CREDENTIAL_ID_INVALID",
      "Credential identifier is invalid",
    );
  }
  return id;
}

function validateSecret(secret: string): string {
  if (
    secret.trim().length === 0 ||
    secret.includes("\0") ||
    Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES
  ) {
    throw new CredentialStoreError(
      "CREDENTIAL_VALUE_INVALID",
      "Credential value is empty or exceeds the supported size",
    );
  }
  return secret;
}

function managedReference(id: string): string {
  return `${MANAGED_PREFIX}${validateCredentialId(id)}`;
}

function parseReference(reference: string):
  | { readonly kind: "managed"; readonly id: string }
  | { readonly kind: "environment"; readonly name: string } {
  if (reference.startsWith(MANAGED_PREFIX)) {
    return {
      kind: "managed",
      id: validateCredentialId(reference.slice(MANAGED_PREFIX.length)),
    };
  }
  if (reference.startsWith(ENV_PREFIX)) {
    const name = reference.slice(ENV_PREFIX.length);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new CredentialStoreError(
        "CREDENTIAL_REFERENCE_INVALID",
        "Environment credential reference is invalid",
      );
    }
    return { kind: "environment", name };
  }
  throw new CredentialStoreError(
    "CREDENTIAL_REFERENCE_INVALID",
    "Credential reference must use managed: or env:",
  );
}

export interface CredentialBrokerOptions {
  readonly systemBackend?: SystemCredentialBackend;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export class CredentialBroker {
  readonly #systemBackend: SystemCredentialBackend | undefined;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #session = new Map<string, string>();
  // Backend availability cannot change during the process lifetime; probing
  // it spawns a shell on Windows, so it is memoized once.
  #availabilityProbe: Promise<boolean> | undefined;
  // Status metadata for UI display. A short TTL collapses the repeated
  // inspects in one configure/switch flow (each is a shell read on Windows)
  // without showing meaningfully stale status.
  readonly #inspectCache = new Map<string, { at: number; value: CredentialMetadata }>();
  static readonly #INSPECT_TTL_MS = 10_000;

  constructor(options: CredentialBrokerOptions = {}) {
    this.#systemBackend = options.systemBackend;
    this.#environment = options.environment ?? process.env;
  }

  async saveManaged(
    id: string,
    secret: string,
    persistence: CredentialPersistence,
  ): Promise<CredentialMetadata> {
    const normalizedId = validateCredentialId(id);
    const normalizedSecret = validateSecret(secret);
    const reference = managedReference(normalizedId);
    if (persistence === "session") {
      this.#session.set(normalizedId, normalizedSecret);
      this.#inspectCache.delete(reference);
      return {
        reference,
        configured: true,
        persistence: "session",
        fallbackReason: null,
      };
    }

    if (
      this.#systemBackend === undefined ||
      !(await this.#available(this.#systemBackend))
    ) {
      this.#session.set(normalizedId, normalizedSecret);
      this.#inspectCache.delete(reference);
      return {
        reference,
        configured: true,
        persistence: "session",
        fallbackReason: "system_unavailable",
      };
    }
    try {
      await this.#systemBackend.write(normalizedId, normalizedSecret);
      this.#session.delete(normalizedId);
      this.#inspectCache.delete(reference);
      return {
        reference,
        configured: true,
        persistence: "system",
        fallbackReason: null,
      };
    } catch {
      this.#session.set(normalizedId, normalizedSecret);
      this.#inspectCache.delete(reference);
      return {
        reference,
        configured: true,
        persistence: "session",
        fallbackReason: "system_write_failed",
      };
    }
  }

  async resolve(reference: string): Promise<string | undefined> {
    const parsed = parseReference(reference);
    if (parsed.kind === "environment") {
      return this.#environment[parsed.name];
    }
    const session = this.#session.get(parsed.id);
    if (session !== undefined) return session;
    if (
      this.#systemBackend === undefined ||
      !(await this.#available(this.#systemBackend))
    ) {
      return undefined;
    }
    return (await this.#systemBackend.read(parsed.id)) ?? undefined;
  }

  async inspect(reference: string): Promise<CredentialMetadata> {
    const cached = this.#inspectCache.get(reference);
    if (cached !== undefined && Date.now() - cached.at < CredentialBroker.#INSPECT_TTL_MS) return cached.value;
    const value = await this.#inspectUncached(reference);
    this.#inspectCache.set(reference, { at: Date.now(), value });
    return value;
  }

  async #inspectUncached(reference: string): Promise<CredentialMetadata> {
    const parsed = parseReference(reference);
    if (parsed.kind === "environment") {
      return {
        reference,
        configured: (this.#environment[parsed.name]?.length ?? 0) > 0,
        persistence: "environment",
        fallbackReason: null,
      };
    }
    if (this.#session.has(parsed.id)) {
      return {
        reference,
        configured: true,
        persistence: "session",
        fallbackReason: null,
      };
    }
    if (
      this.#systemBackend !== undefined &&
      (await this.#available(this.#systemBackend)) &&
      (await this.#systemBackend.read(parsed.id)) !== null
    ) {
      return {
        reference,
        configured: true,
        persistence: "system",
        fallbackReason: null,
      };
    }
    return {
      reference,
      configured: false,
      persistence: "missing",
      fallbackReason: null,
    };
  }

  async deleteManaged(id: string): Promise<void> {
    const normalizedId = validateCredentialId(id);
    this.#session.delete(normalizedId);
    this.#inspectCache.delete(managedReference(normalizedId));
    if (
      this.#systemBackend !== undefined &&
      (await this.#available(this.#systemBackend))
    ) {
      try {
        await this.#systemBackend.delete(normalizedId);
      } catch {
        throw new CredentialStoreError(
          "CREDENTIAL_DELETE_FAILED",
          "Credential could not be removed from secure storage",
        );
      }
    }
  }

  clearSession(): void {
    this.#session.clear();
    this.#inspectCache.clear();
  }

  async #available(backend: SystemCredentialBackend): Promise<boolean> {
    this.#availabilityProbe ??= (async () => {
      try {
        return await backend.isAvailable();
      } catch {
        return false;
      }
    })();
    return this.#availabilityProbe;
  }
}

export interface WindowsCredentialManagerBackendOptions {
  readonly platform?: NodeJS.Platform;
  readonly invoke?: CredentialCommandInvoker;
}

export class WindowsCredentialManagerBackend implements SystemCredentialBackend {
  readonly #platform: NodeJS.Platform;
  readonly #invoke: CredentialCommandInvoker;

  constructor(options: WindowsCredentialManagerBackendOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#invoke = options.invoke ?? createWindowsPowerShellInvoker();
  }

  async isAvailable(): Promise<boolean> {
    if (this.#platform !== "win32") return false;
    try {
      return (await this.#invoke({ operation: "probe" })).ok;
    } catch {
      return false;
    }
  }

  async read(id: string): Promise<string | null> {
    this.#assertWindows();
    const response = await this.#invoke({
      operation: "read",
      target: this.#target(id),
    });
    this.#assertOk(response);
    if (response.found !== true) return null;
    if (typeof response.secretBase64 !== "string") {
      throw new CredentialStoreError(
        "CREDENTIAL_STORE_INVALID_RESPONSE",
        "Secure credential storage returned an invalid response",
      );
    }
    try {
      return Buffer.from(response.secretBase64, "base64").toString("utf8");
    } catch {
      throw new CredentialStoreError(
        "CREDENTIAL_STORE_INVALID_RESPONSE",
        "Secure credential storage returned an invalid response",
      );
    }
  }

  async write(id: string, secret: string): Promise<void> {
    this.#assertWindows();
    const response = await this.#invoke({
      operation: "write",
      target: this.#target(id),
      secretBase64: Buffer.from(validateSecret(secret), "utf8").toString("base64"),
    });
    this.#assertOk(response);
  }

  async delete(id: string): Promise<void> {
    this.#assertWindows();
    const response = await this.#invoke({
      operation: "delete",
      target: this.#target(id),
    });
    this.#assertOk(response);
  }

  #target(id: string): string {
    return `${TARGET_PREFIX}${validateCredentialId(id)}`;
  }

  #assertWindows(): void {
    if (this.#platform !== "win32") {
      throw new CredentialStoreError(
        "CREDENTIAL_STORE_UNAVAILABLE",
        "Windows Credential Manager is unavailable on this platform",
      );
    }
  }

  #assertOk(response: CredentialCommandResponse): asserts response is Extract<
    CredentialCommandResponse,
    { readonly ok: true }
  > {
    if (!response.ok) {
      throw new CredentialStoreError(
        "CREDENTIAL_STORE_UNAVAILABLE",
        "Windows Credential Manager did not complete the operation",
      );
    }
  }
}

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;

public static class WritingAgentCredentialNative {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public Int64 LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("Advapi32.dll")]
  private static extern void CredFree(IntPtr buffer);

  public static int Write(string target, byte[] secret) {
    IntPtr blob = IntPtr.Zero;
    try {
      blob = Marshal.AllocCoTaskMem(secret.Length);
      Marshal.Copy(secret, 0, blob, secret.Length);
      CREDENTIAL credential = new CREDENTIAL {
        Type = 1,
        TargetName = target,
        CredentialBlobSize = (UInt32)secret.Length,
        CredentialBlob = blob,
        Persist = 2,
        UserName = "WritingAgent"
      };
      return CredWrite(ref credential, 0) ? 0 : Marshal.GetLastWin32Error();
    } finally {
      if (blob != IntPtr.Zero) {
        for (int i = 0; i < secret.Length; i++) Marshal.WriteByte(blob, i, 0);
        Marshal.FreeCoTaskMem(blob);
      }
      Array.Clear(secret, 0, secret.Length);
    }
  }

  public static string Read(string target, out int errorCode) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) {
      errorCode = Marshal.GetLastWin32Error();
      return null;
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] secret = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, secret, 0, secret.Length);
      errorCode = 0;
      try { return Convert.ToBase64String(secret); }
      finally { Array.Clear(secret, 0, secret.Length); }
    } finally {
      CredFree(pointer);
    }
  }

  public static int Delete(string target) {
    if (CredDelete(target, 1, 0)) return 0;
    int error = Marshal.GetLastWin32Error();
    return error == 1168 ? 0 : error;
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$request = ([Console]::In.ReadToEnd() | ConvertFrom-Json)
if ($request.operation -eq 'probe') {
  [Console]::Out.Write('{"ok":true}')
  exit 0
}
if ($request.operation -eq 'write') {
  $bytes = [Convert]::FromBase64String([string]$request.secretBase64)
  $code = [WritingAgentCredentialNative]::Write([string]$request.target, $bytes)
  if ($code -eq 0) { [Console]::Out.Write('{"ok":true}') }
  else { [Console]::Out.Write((@{ok=$false;errorCode=$code} | ConvertTo-Json -Compress)) }
  exit 0
}
if ($request.operation -eq 'read') {
  $code = 0
  $value = [WritingAgentCredentialNative]::Read([string]$request.target, [ref]$code)
  if ($code -eq 1168) { [Console]::Out.Write('{"ok":true,"found":false}'); exit 0 }
  if ($code -ne 0) { [Console]::Out.Write((@{ok=$false;errorCode=$code} | ConvertTo-Json -Compress)); exit 0 }
  [Console]::Out.Write((@{ok=$true;found=$true;secretBase64=$value} | ConvertTo-Json -Compress))
  exit 0
}
if ($request.operation -eq 'delete') {
  $code = [WritingAgentCredentialNative]::Delete([string]$request.target)
  if ($code -eq 0) { [Console]::Out.Write('{"ok":true}') }
  else { [Console]::Out.Write((@{ok=$false;errorCode=$code} | ConvertTo-Json -Compress)) }
  exit 0
}
[Console]::Out.Write('{"ok":false}')
`;

export interface WindowsPowerShellInvokerOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
}

export function createWindowsPowerShellInvoker(
  options: WindowsPowerShellInvokerOptions = {},
): CredentialCommandInvoker {
  const executable = options.executable ?? "powershell.exe";
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }
  const encodedScript = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString(
    "base64",
  );

  return async (request) =>
    new Promise<CredentialCommandResponse>((resolve, reject) => {
      const child = spawn(
        executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript],
        {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderrBytes = 0;
      let settled = false;
      const finish = (
        callback: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(() =>
          reject(
            new CredentialStoreError(
              "CREDENTIAL_STORE_TIMEOUT",
              "Secure credential storage did not respond",
            ),
          ),
        );
      }, timeoutMs);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_SUBPROCESS_OUTPUT_BYTES) {
          child.kill();
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes > MAX_SUBPROCESS_OUTPUT_BYTES) child.kill();
      });
      child.once("error", () => {
        finish(() =>
          reject(
            new CredentialStoreError(
              "CREDENTIAL_STORE_UNAVAILABLE",
              "Secure credential storage could not be started",
            ),
          ),
        );
      });
      child.once("close", (code) => {
        finish(() => {
          if (code !== 0 || Buffer.byteLength(stdout, "utf8") > MAX_SUBPROCESS_OUTPUT_BYTES) {
            reject(
              new CredentialStoreError(
                "CREDENTIAL_STORE_UNAVAILABLE",
                "Secure credential storage did not complete the operation",
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(stdout) as unknown;
            if (!isCredentialCommandResponse(parsed)) {
              throw new Error("invalid response");
            }
            resolve(parsed);
          } catch {
            reject(
              new CredentialStoreError(
                "CREDENTIAL_STORE_INVALID_RESPONSE",
                "Secure credential storage returned an invalid response",
              ),
            );
          }
        });
      });
      child.stdin.end(JSON.stringify(request), "utf8");
    });
}

function isCredentialCommandResponse(
  value: unknown,
): value is CredentialCommandResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const ok = (value as { readonly ok?: unknown }).ok;
  if (ok === false) return true;
  if (ok !== true) return false;
  const result = value as {
    readonly found?: unknown;
    readonly secretBase64?: unknown;
  };
  return (
    (result.found === undefined || typeof result.found === "boolean") &&
    (result.secretBase64 === undefined || typeof result.secretBase64 === "string")
  );
}
