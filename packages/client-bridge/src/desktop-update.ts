export type DesktopUpdateState =
  | { readonly phase: 'disabled' | 'idle' | 'checking' | 'current' }
  | { readonly phase: 'available'; readonly version: string; readonly installInApp: boolean; readonly deferred: boolean }
  | { readonly phase: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly phase: 'ready' | 'installing'; readonly version: string }
  | { readonly phase: 'error'; readonly operation: 'check' | 'download' | 'install'; readonly message: string };

export type DesktopUpdateAction = 'status' | 'check' | 'download' | 'install' | 'open-release' | 'defer';

export interface DesktopUpdateApi {
  request(action: DesktopUpdateAction): Promise<DesktopUpdateState>;
  subscribe(listener: (state: DesktopUpdateState) => void): () => void;
}
