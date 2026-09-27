import { contextBridge, ipcRenderer } from "electron";

import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeSnapshot,
} from "../../../packages/client-bridge/src/protocol.js";
import type {
  DesktopDiagnosticExportResultView,
  DesktopDiagnosticPreviewView,
  DesktopHostApi,
  DesktopLegacyMigrationPlanView,
  DesktopLegacyMigrationResultView,
  DesktopLegacySourceKind,
  DesktopWorkspaceBackupResultView,
  DesktopWorkspaceRestorePreviewView,
  DesktopWorkspaceRestoreResultView,
  DesktopProviderConnectionResultView,
  DesktopProviderSetupInput,
  DesktopProviderStatusView,
  DesktopSavedProviderView,
  DesktopRpcRequest,
  DesktopRpcResponse,
  DesktopPublicationSaveInput,
  DesktopPublicationSaveResult,
} from "../../../packages/client-bridge/src/desktop-bridge.js";
import {
  DESKTOP_BRIDGE_CHANNEL,
  DESKTOP_SNAPSHOT_CHANNEL,
} from "./channels.js";

const invoke = (request: DesktopRpcRequest): Promise<DesktopRpcResponse> =>
  ipcRenderer.invoke(DESKTOP_BRIDGE_CHANNEL, request) as Promise<DesktopRpcResponse>;

const api: DesktopHostApi = {
  invoke,
  async savePublicationAs(input: DesktopPublicationSaveInput): Promise<DesktopPublicationSaveResult> {
    const response = await invoke({ protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'savePublicationAs', args: [input] });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopPublicationSaveResult;
  },
  async revealPublication(receiptId: string): Promise<void> {
    const response = await invoke({ protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'revealPublication', args: [receiptId] });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  },
  async revealProviderConfig(): Promise<void> {
    const response = await invoke({ protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'revealProviderConfig', args: [] });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  },
  subscribe(listener: (snapshot: BridgeSnapshot) => void): () => void {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: BridgeSnapshot): void => {
      listener(snapshot);
    };
    ipcRenderer.on(DESKTOP_SNAPSHOT_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(DESKTOP_SNAPSHOT_CHANNEL, wrapped);
  },
  async providerStatus(mode?: 'summary'): Promise<DesktopProviderStatusView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "providerStatus",
      args: [mode],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopProviderStatusView;
  },
  async providerDetails(profileId: string): Promise<DesktopSavedProviderView> {
    const response = await invoke({ protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'providerDetails', args: [profileId] });
    if (!response.ok) throw new Error(response.error.code);
    return response.result as DesktopSavedProviderView;
  },
  async configureProvider(
    input: DesktopProviderSetupInput,
  ): Promise<DesktopProviderStatusView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "configureProvider",
      args: [input],
    });
    if (!response.ok) throw new Error(response.error.code);
    return response.result as DesktopProviderStatusView;
  },
  async selectProvider(profileId: string, model: string): Promise<DesktopProviderStatusView> {
    const response = await invoke({ protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'selectProvider', args: [profileId, model] });
    if (!response.ok) throw new Error(response.error.code);
    return response.result as DesktopProviderStatusView;
  },
  async listProviderModels(input: DesktopProviderSetupInput): Promise<readonly string[]> {
    const response = await invoke({ protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'listProviderModels', args: [input] });
    if (!response.ok) throw new Error(response.error.code);
    return response.result as readonly string[];
  },
  async testProviderConnection(): Promise<DesktopProviderConnectionResultView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "testProviderConnection",
      args: [],
    });
    if (!response.ok) throw new Error(response.error.code);
    return response.result as DesktopProviderConnectionResultView;
  },
  async previewDiagnostics(): Promise<DesktopDiagnosticPreviewView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "previewDiagnostics",
      args: [],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopDiagnosticPreviewView;
  },
  async exportDiagnostics(confirmationHash: string): Promise<DesktopDiagnosticExportResultView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "exportDiagnostics",
      args: [confirmationHash],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopDiagnosticExportResultView;
  },
  async selectLegacyMigrationSource(
    kind: DesktopLegacySourceKind,
  ): Promise<DesktopLegacyMigrationPlanView | null> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "selectLegacyMigrationSource",
      args: [kind],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopLegacyMigrationPlanView | null;
  },
  async applyLegacyMigration(planHash: string): Promise<DesktopLegacyMigrationResultView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "applyLegacyMigration",
      args: [planHash],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopLegacyMigrationResultView;
  },
  async backupWorkspace(): Promise<DesktopWorkspaceBackupResultView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "backupWorkspace",
      args: [],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopWorkspaceBackupResultView;
  },
  async selectWorkspaceRestoreBackup(): Promise<DesktopWorkspaceRestorePreviewView | null> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "selectWorkspaceRestoreBackup",
      args: [],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopWorkspaceRestorePreviewView | null;
  },
  async applyWorkspaceRestore(
    confirmationHash: string,
    confirmationPhrase: string,
  ): Promise<DesktopWorkspaceRestoreResultView> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "applyWorkspaceRestore",
      args: [confirmationHash, confirmationPhrase],
    });
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result as DesktopWorkspaceRestoreResultView;
  },
  async deleteProject(
    projectId: string,
    confirmedName: string,
  ): Promise<{ readonly projectId: string; readonly deleted: true }> {
    const response = await invoke({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "deleteProject",
      args: [projectId, confirmedName],
    });
    // Electron contextBridge drops custom Error properties. Preserve the safe
    // public code in the standard message so the renderer can explain it.
    if (!response.ok) throw new Error(response.error.code);
    return response.result as { readonly projectId: string; readonly deleted: true };
  },
};

contextBridge.exposeInMainWorld("writingAgentDesktop", api);
