/** Offline, read-only comparison. Never calls a model, changes the workspace,
 * or prints manuscript/source content. Usage:
 * node --import tsx scripts/measure_agent_context.ts <workspace.sqlite3> <snapshot-id> [...]
 */
import { DatabaseSync } from 'node:sqlite';
import { stageArtifactContext, deduplicateReviewDiscussion, projectInlineRead } from '../packages/application/src/agent-context.js';
import { requestInputBreakdown } from '../packages/client-bridge/src/request-input-breakdown.js';
import type { ModelRequest } from '../packages/runtime/llm/src/index.js';

const [path, ...ids] = process.argv.slice(2);
if (!path || !ids.length) throw new Error('Pass a workspace database path and one or more saved request snapshot IDs.');
const db = new DatabaseSync(path, { readOnly: true });
try {
  const results = ids.map(id => {
    const row = db.prepare('SELECT request_json FROM request_snapshots WHERE id=?').get(id) as { request_json: string } | undefined;
    if (!row) throw new Error(`Snapshot not found: ${id}`);
    const request = JSON.parse(row.request_json) as ModelRequest;
    const marker = '\nCOLLABORATION_STATE=';
    const message = request.messages[1]!;
    const offset = message.content.lastIndexOf(marker);
    if (offset < 0) throw new Error(`Not a collaboration request: ${id}`);
    const state = JSON.parse(message.content.slice(offset + marker.length));
    const artifacts = state.artifacts.map((a: { id: string }) => {
      const artifact = db.prepare('SELECT id,kind,content FROM artifact_versions WHERE id=?').get(a.id) as { id: string; kind: string; content: string } | undefined;
      if (!artifact) throw new Error(`Bound artifact not found: ${a.id}`);
      return artifact;
    });
    const projection = stageArtifactContext(state.actor, artifacts);
    const before = requestInputBreakdown(request);
    state.artifacts = projection.artifacts;
    if (state.authorReviewDiscussion) state.authorReviewDiscussion = deduplicateReviewDiscussion(
      state.authorReviewDiscussion, projection.completeArtifacts, state.materials, true);
    const projectedRequest = structuredClone(request);
    projectedRequest.messages = request.messages.map((m, i) => i === 1 ? {
      ...m, content: message.content.slice(0, offset + marker.length) + JSON.stringify(state),
    } : m.role !== 'tool' ? m : (() => {
      let original = m;
      // Old persisted request projections may point to inline content. Restore
      // that exact immutable version before applying the NEW projection; a
      // pointer must never silently refer to a newly omitted body or quotation.
      try {
        const envelope = JSON.parse(m.content);
        if (envelope.ok === true && envelope.result?.contentFrom && m.name === 'read_artifact_version') {
          const artifact = artifacts.find((a: { id: string }) => a.id === envelope.result.versionId);
          if (!artifact) throw new Error('Referenced version is not in this request');
          const { contentFrom: _ref, requestProjection: _oldProjection, ...result } = envelope.result;
          original = { ...m, content: JSON.stringify({ ...envelope, result: { ...result, content: artifact.content } }) };
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      return { ...original, content: projectInlineRead(original, projection.completeArtifacts, state.materials, artifacts) };
    })());
    const after = requestInputBreakdown(projectedRequest);
    return { snapshotId: id, actor: state.actor, before: before.totalCharacters, after: after.totalCharacters,
      savedCharacters: before.totalCharacters - after.totalCharacters,
      reductionPercent: Math.round((1 - after.totalCharacters / before.totalCharacters) * 1000) / 10,
      beforeParts: before.parts, afterParts: after.parts };
  });
  console.log(JSON.stringify({ mode: 'offline_projection_only',
    limitations: 'Original system prompts, tool schemas and conversation turns held constant. Artifact-read references restored and reprojected, never credited as full text when omitted. Measures projection savings, not a newly dispatched request, tokens, cost, latency or output quality.', results }, null, 2));
} finally { db.close(); }
