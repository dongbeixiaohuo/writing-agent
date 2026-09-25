export interface ModuleContext {
  getService<T>(name: string): T;
  registerService<T>(name: string, service: T): () => void;
}

export interface RuntimeModule {
  readonly id: string;
  readonly version: string;
  readonly requires: readonly string[];
  readonly activate: (
    context: ModuleContext,
  ) => Promise<() => Promise<void>>;
}

export class ModuleHostError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ModuleHostError";
  }
}

interface ActiveModule {
  readonly dispose: () => Promise<void>;
}

type HostState =
  | "created"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "failed";

const MODULE_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MODULE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function validateAndSortModules(
  modules: readonly RuntimeModule[],
): readonly RuntimeModule[] {
  const byId = new Map<string, RuntimeModule>();
  for (const module of modules) {
    if (!MODULE_ID.test(module.id)) {
      throw new ModuleHostError("MODULE_INVALID", "A bundled module ID is invalid");
    }
    if (!MODULE_VERSION.test(module.version)) {
      throw new ModuleHostError("MODULE_INVALID", "A bundled module version is invalid");
    }
    if (byId.has(module.id)) {
      throw new ModuleHostError("MODULE_DUPLICATE", "A bundled module ID is duplicated");
    }
    byId.set(module.id, module);
  }
  for (const module of modules) {
    for (const dependency of module.requires) {
      if (!byId.has(dependency)) {
        throw new ModuleHostError(
          "MODULE_DEPENDENCY_MISSING",
          "A bundled module dependency is missing",
        );
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: RuntimeModule[] = [];
  const visit = (module: RuntimeModule): void => {
    if (visited.has(module.id)) return;
    if (visiting.has(module.id)) {
      throw new ModuleHostError(
        "MODULE_DEPENDENCY_CYCLE",
        "Bundled module dependencies contain a cycle",
      );
    }
    visiting.add(module.id);
    for (const dependency of module.requires) {
      const required = byId.get(dependency);
      if (required === undefined) {
        throw new ModuleHostError(
          "MODULE_DEPENDENCY_MISSING",
          "A bundled module dependency is missing",
        );
      }
      visit(required);
    }
    visiting.delete(module.id);
    visited.add(module.id);
    ordered.push(module);
  };
  for (const module of modules) visit(module);
  return Object.freeze(ordered);
}

export class BundledModuleHost {
  readonly #modules: readonly RuntimeModule[];
  readonly #services = new Map<string, unknown>();
  readonly #active: ActiveModule[] = [];
  #state: HostState = "created";

  private constructor(modules: readonly RuntimeModule[]) {
    this.#modules = modules;
  }

  static create(modules: readonly RuntimeModule[]): BundledModuleHost {
    return new BundledModuleHost(validateAndSortModules(Object.freeze([...modules])));
  }

  getService<T>(name: string): T {
    if (!this.#services.has(name)) {
      throw new ModuleHostError("SERVICE_NOT_FOUND", "Service is not available");
    }
    return this.#services.get(name) as T;
  }

  async start(): Promise<void> {
    if (this.#state !== "created") {
      throw new ModuleHostError(
        "MODULE_HOST_STATE_INVALID",
        "Bundled modules can only be started once",
      );
    }
    this.#state = "starting";

    for (const module of this.#modules) {
      const registrations: Array<() => void> = [];
      let activationOpen = true;
      const context: ModuleContext = Object.freeze({
        getService: <T>(name: string): T => this.getService<T>(name),
        registerService: <T>(name: string, service: T): (() => void) => {
          if (!activationOpen) {
            throw new ModuleHostError(
              "MODULE_CONTEXT_CLOSED",
              "Module service registration is closed after activation",
            );
          }
          const normalizedName = name.trim();
          if (normalizedName.length === 0 || service === undefined) {
            throw new ModuleHostError("SERVICE_INVALID", "A registered service is invalid");
          }
          if (this.#services.has(normalizedName)) {
            throw new ModuleHostError(
              "SERVICE_DUPLICATE",
              "A service name is already registered",
            );
          }
          this.#services.set(normalizedName, service);
          let registered = true;
          const unregister = (): void => {
            if (!registered) return;
            registered = false;
            if (this.#services.get(normalizedName) === service) {
              this.#services.delete(normalizedName);
            }
          };
          registrations.push(unregister);
          return unregister;
        },
      });

      try {
        const moduleDispose = await module.activate(context);
        activationOpen = false;
        if (typeof moduleDispose !== "function") {
          throw new ModuleHostError(
            "MODULE_DISPOSER_INVALID",
            "A bundled module did not provide a disposer",
          );
        }
        let disposed = false;
        this.#active.push({
          dispose: async () => {
            if (disposed) return;
            disposed = true;
            try {
              await moduleDispose();
            } finally {
              for (const unregister of [...registrations].reverse()) unregister();
            }
          },
        });
      } catch {
        activationOpen = false;
        for (const unregister of [...registrations].reverse()) unregister();
        await this.#disposeActiveQuietly();
        this.#state = "failed";
        throw new ModuleHostError(
          "MODULE_ACTIVATION_FAILED",
          "A bundled module failed during activation",
        );
      }
    }
    this.#state = "running";
  }

  async stop(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "failed") return;
    if (this.#state === "created") {
      this.#state = "stopped";
      return;
    }
    if (this.#state !== "running") {
      throw new ModuleHostError(
        "MODULE_HOST_STATE_INVALID",
        "Bundled modules cannot be stopped in the current state",
      );
    }
    this.#state = "stopping";
    const errors: unknown[] = [];
    for (const active of [...this.#active].reverse()) {
      try {
        await active.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.#active.length = 0;
    this.#services.clear();
    this.#state = "stopped";
    if (errors.length > 0) {
      throw new ModuleHostError(
        "MODULE_DISPOSE_FAILED",
        "One or more bundled modules failed during disposal",
      );
    }
  }

  async #disposeActiveQuietly(): Promise<void> {
    for (const active of [...this.#active].reverse()) {
      try {
        await active.dispose();
      } catch {
        // Activation failure remains the primary public error.
      }
    }
    this.#active.length = 0;
    this.#services.clear();
  }
}
