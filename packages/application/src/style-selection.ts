import type { StoragePort } from '../../writing-core/src/index.js';
import { StyleSelectionSnapshotSchema, type StyleSelectionSnapshot } from '../../writing-core/src/style-package.js';

export const PROJECT_STYLE_KEY = 'project-style-selection-v2';
export function projectStyleSelection(storage: StoragePort, projectId: string): StyleSelectionSnapshot | null | undefined {
  const artifact = storage.listArtifactVersions(projectId, 'report', PROJECT_STYLE_KEY).at(-1);
  if (!artifact) return undefined;
  const data = JSON.parse(artifact.content) as { selection: unknown };
  return StyleSelectionSnapshotSchema.nullable().parse(data.selection);
}
export function saveProjectStyleSelection(storage: StoragePort, projectId: string, selected: StyleSelectionSnapshot | null, operationId: string): void {
  const project = storage.inspectProject(projectId);
  if (!project) throw new Error('PROJECT_NOT_FOUND');
  const selection = StyleSelectionSnapshotSchema.nullable().parse(selected);
  const previous = storage.listArtifactVersions(projectId, 'report', PROJECT_STYLE_KEY).at(-1);
  const content = JSON.stringify({ selection });
  if (previous?.content === content) return;
  const result = storage.commitArtifactVersion({ projectId, operationId, expectedProjectRevision: project.revision,
    kind: 'report', logicalKey: PROJECT_STYLE_KEY, baseVersionId: previous?.id ?? null, content,
    reason: selection ? `选择写作风格：${selection.name}` : '不指定写作风格', requestSnapshotId: null,
    actor: { kind: 'user', id: 'style-picker' } });
  if (!result.ok) throw new Error(result.code);
}
