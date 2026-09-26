// Read-only historical feedback loop; does not open an application or make requests.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { assertCleanBodyStageContent } from '../../packages/application/src/workflow-tools.js';
const [source, runId] = process.argv.slice(2);
const db = new DatabaseSync(source!, { readOnly: true });
try {
  const row = db.prepare('SELECT request_json FROM request_snapshots WHERE run_id=? ORDER BY created_at DESC LIMIT 1').get(runId!)!;
  const request = JSON.parse(String(row.request_json));
  const state = JSON.parse(request.messages.find((m:any)=>m.content.includes('COLLABORATION_STATE=')).content.split('COLLABORATION_STATE=')[1]);
  const bound = state.artifacts.find((a:any)=>a.kind==='body').content;
  const output = request.messages.filter((m:any)=>m.role==='assistant').at(-1).content;
  const failures = db.prepare("SELECT count(*) n FROM events WHERE run_id=? AND type='tool.failed' AND payload_json LIKE '%BODY_STAGE_CONTAINS_PROCESS_NOTES%'").get(runId!)!.n;
  console.log(JSON.stringify({stage:state.stage,boundLength:bound.length,outputLength:output.length,failures}));
  // The earlier revision accepted an explicit postscript; that contaminates
  // length comparisons and wrongly asks the language expert to keep it.
  assert.throws(()=>assertCleanBodyStageContent('central_revision',bound), 'Must reject process notes after an article, not store them in the body');
  // Returning a clean article WITH the existing heading should be accepted.
  const title=bound.split('\n')[0];
  assert.doesNotThrow(()=>assertCleanBodyStageContent('language_review',title+'\n\n'+output,bound));
  console.log('PASS historical contaminated-baseline regression');
} finally { db.close(); }
