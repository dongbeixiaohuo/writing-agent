import {
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export type AuthorizedPathScope = "workspace" | "explicit_import";

export interface AuthorizedReadableFile {
  readonly path: string;
  readonly scope: AuthorizedPathScope;
}

export interface AuthorizedPathPolicyOptions {
  readonly workspaceRoot: string;
  readonly importedPaths?: readonly string[];
}

interface PathGrant {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly kind: "directory" | "file";
  readonly scope: AuthorizedPathScope;
}

export class PathPolicyError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

const SENSITIVE_COMPONENTS = new Set([
  ".aws",
  ".azure",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
  ".writing-agent",
]);
const SENSITIVE_FILES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials",
  "credentials.json",
  "id_ed25519",
  "id_rsa",
]);

function pathKey(path: string): string {
  return process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path;
}

function isWithin(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate);
  return relation === "" || (
    !relation.startsWith(`..${sep}`) &&
    relation !== ".." &&
    !isAbsolute(relation)
  );
}

function isSensitive(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean).map((part) => part.toLowerCase());
  if (parts.some((part) => SENSITIVE_COMPONENTS.has(part))) return true;
  const name = basename(normalized).toLowerCase();
  return (
    SENSITIVE_FILES.has(name) ||
    name === ".env" ||
    name.startsWith(".env.") ||
    name.startsWith("secrets.")
  );
}

function pathGrant(
  input: string,
  scope: AuthorizedPathScope,
): PathGrant {
  const lexicalPath = resolve(input);
  let metadata;
  try {
    metadata = lstatSync(lexicalPath);
  } catch {
    throw new PathPolicyError(
      "PATH_AUTHORIZATION_INVALID",
      "An authorized path does not exist",
    );
  }
  if (metadata.isSymbolicLink()) {
    throw new PathPolicyError(
      "PATH_SYMBOLIC_LINK_DENIED",
      "Symbolic links are not accepted as authorization roots",
    );
  }
  if (!metadata.isDirectory() && !metadata.isFile()) {
    throw new PathPolicyError(
      "PATH_AUTHORIZATION_INVALID",
      "An authorized path must be a file or directory",
    );
  }
  if (isSensitive(lexicalPath)) {
    throw new PathPolicyError(
      "PATH_SENSITIVE_DENIED",
      "Sensitive credential and application-internal paths are not readable",
    );
  }
  return {
    lexicalPath,
    canonicalPath: realpathSync.native(lexicalPath),
    kind: metadata.isDirectory() ? "directory" : "file",
    scope,
  };
}

function grantMatchesLexically(grant: PathGrant, candidate: string): boolean {
  if (grant.kind === "file") {
    return pathKey(grant.lexicalPath) === pathKey(candidate);
  }
  return isWithin(grant.lexicalPath, candidate);
}

function grantMatchesCanonically(grant: PathGrant, candidate: string): boolean {
  if (grant.kind === "file") {
    return pathKey(grant.canonicalPath) === pathKey(candidate);
  }
  return isWithin(grant.canonicalPath, candidate);
}

function assertNoSymbolicLinks(grant: PathGrant, candidate: string): void {
  if (grant.kind === "file") return;
  const relation = relative(grant.lexicalPath, candidate);
  let cursor = grant.lexicalPath;
  for (const part of relation.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    let metadata;
    try {
      metadata = lstatSync(cursor);
    } catch {
      throw new PathPolicyError("PATH_NOT_FOUND", "The requested file does not exist");
    }
    if (metadata.isSymbolicLink()) {
      throw new PathPolicyError(
        "PATH_SYMBOLIC_LINK_DENIED",
        "Symbolic links are not readable through tool access",
      );
    }
  }
}

export class AuthorizedPathPolicy {
  readonly #workspaceRoot: string;
  readonly #grants: readonly PathGrant[];

  private constructor(workspaceRoot: string, grants: readonly PathGrant[]) {
    this.#workspaceRoot = workspaceRoot;
    this.#grants = grants;
  }

  static create(options: AuthorizedPathPolicyOptions): AuthorizedPathPolicy {
    const workspace = pathGrant(options.workspaceRoot, "workspace");
    if (workspace.kind !== "directory") {
      throw new PathPolicyError(
        "PATH_AUTHORIZATION_INVALID",
        "The workspace authorization root must be a directory",
      );
    }
    const imported = (options.importedPaths ?? []).map((path) =>
      pathGrant(path, "explicit_import"),
    );
    return new AuthorizedPathPolicy(
      workspace.lexicalPath,
      Object.freeze([workspace, ...imported]),
    );
  }

  resolveReadableFile(candidateInput: string): AuthorizedReadableFile {
    if (candidateInput.includes("\0")) {
      throw new PathPolicyError("PATH_INVALID", "The requested path is invalid");
    }
    const candidate = isAbsolute(candidateInput)
      ? resolve(candidateInput)
      : resolve(this.#workspaceRoot, candidateInput);
    if (isSensitive(candidate)) {
      throw new PathPolicyError(
        "PATH_SENSITIVE_DENIED",
        "Sensitive credential and application-internal paths are not readable",
      );
    }
    const grant = this.#grants.find((entry) => grantMatchesLexically(entry, candidate));
    if (grant === undefined) {
      throw new PathPolicyError(
        "PATH_OUTSIDE_AUTHORIZED_SCOPE",
        "The requested path is outside the authorized scope",
      );
    }
    assertNoSymbolicLinks(grant, candidate);

    let canonical: string;
    try {
      canonical = realpathSync.native(candidate);
    } catch {
      throw new PathPolicyError("PATH_NOT_FOUND", "The requested file does not exist");
    }
    if (!grantMatchesCanonically(grant, canonical)) {
      throw new PathPolicyError(
        "PATH_OUTSIDE_AUTHORIZED_SCOPE",
        "The requested path is outside the authorized scope",
      );
    }
    let metadata;
    try {
      metadata = statSync(canonical);
    } catch {
      throw new PathPolicyError("PATH_NOT_FOUND", "The requested file does not exist");
    }
    if (!metadata.isFile()) {
      throw new PathPolicyError("PATH_NOT_FILE", "The requested path is not a file");
    }
    return Object.freeze({ path: canonical, scope: grant.scope });
  }
}
