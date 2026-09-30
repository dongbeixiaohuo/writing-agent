/** One historical language stage, isolated SQLite backup, current MiniMax key.
 * No original writes; never executes subsequent experts or passes fact gates. */
import assert from 'node:assert/strict';
import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { assertCleanBodyStageContent } from '../../packages/application/src/workflow-tools.js';
const [source, runId] = process.argv.slice(2);
const root=mkdtempSync(join(tmpdir(),'wa-rc42-language-'));
mkdirSync(join(root,'.writing-agent'));
const original=new DatabaseSync(source!,{readOnly:true});
const before=original.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=(SELECT project_id FROM runs WHERE id=?)').get(runId!)!;
await backup(original,join(root,'.writing-agent/workspace.sqlite3')); original.close();
// Only the fixture copy is made recoverable; the user stopped the real run.
const fixture=new DatabaseSync(join(root,'.writing-agent/workspace.sqlite3'));
fixture.prepare("UPDATE runs SET status='waiting_user',stop_reason='STAGE_OUTPUT_NOT_SAVED' WHERE id=?").run(runId!); fixture.close();
const profile=loadDesktopProviderProfile(join(process.env.APPDATA!,'Writing Agent/provider.json'))!;
assert.equal(profile.model,'MiniMax-M3');
const provider=createConfiguredProvider(profile,createDefaultCredentialBroker());
const requests:{actor:string;ms:number;firstTextMs:number|null;chars:number}[]=[];
class LimitedProvider extends ModelProviderBase {
  constructor(){super(provider.id,provider.adapterVersion,provider.capabilitiesFor(profile.model));}
  protected async *providerStream(request:ModelRequest):AsyncIterable<ProviderStreamEvent>{
    const state=JSON.parse(request.messages.find(m=>m.content.includes('COLLABORATION_STATE='))!.content.split('COLLABORATION_STATE=')[1]!);
    if(!['director','language_review'].includes(state.actor)||state.nextStage!=='language_review'||requests.length>=8){yield {type:'error',error:{code:'REPLAY_BOUNDARY',message:'Isolated replay only permits language-stage recovery',retryable:false}};return;}
    if(state.actor==='language_review') {
      assert.equal(state.bodyOutputContract.output,'complete_article_only');
      assert.ok(state.bodyOutputContract.requiredHeadings.length);
    }
    const entry={actor:state.actor,ms:0,firstTextMs:null as number|null,chars:0}; requests.push(entry);
    const start=performance.now();
    for await(const event of provider.stream(request)){
      if(event.type==='text_delta'){entry.firstTextMs??=Math.round(performance.now()-start);entry.chars+=event.delta.length;}
      entry.ms=Math.round(performance.now()-start);
      yield event;
    }
    entry.ms=Math.round(performance.now()-start);
  }
}
const storage=openWorkspaceStorage({workspacePath:root});
const run=storage.getRun(runId!)!; const project=storage.inspectProject(run.projectId)!;
const oldBody=storage.getArtifactVersion(project.latestBodyVersionId!)!;
const app=new WritingApplicationService({storage,provider:new LimitedProvider()});
let report:any={root,requests,originalWrites:0,status:'FAIL'};
try {
  const result=await app.resumeDraft({projectId:run.projectId,runId:runId!,operationId:'rc42-language-replay',decision:'resume',
    expectedProjectRevision:project.revision,expectedBriefVersionId:project.currentBriefVersionId!,model:profile.model,parameters:{}}).result;
  const updated=storage.inspectProject(run.projectId)!;
  const body=storage.getArtifactVersion(updated.latestBodyVersionId!)!;
  report={...report,runStatus:storage.getRun(runId!)!.status,stopReason:storage.getRun(runId!)!.stopReason,
    saved:body.id!==oldBody.id,bodyCharacters:body.content.length,firstLine:body.content.split('\n')[0],resultOk:result.ok};
  assert.notEqual(body.id,oldBody.id,'Language output must actually be saved');
  assertCleanBodyStageContent('language_review',body.content,oldBody.content);
  const afterDb=new DatabaseSync(source!,{readOnly:true});
  const after=afterDb.prepare('SELECT latest_body_version_id,revision FROM projects WHERE id=?').get(run.projectId);afterDb.close();
  assert.deepEqual(after,before,'Original project must stay unchanged');
  report.status='PASS';
} finally {
  storage.close();mkdirSync(resolve('output/rc42'),{recursive:true});
  writeFileSync(resolve('output/rc42/language-replay.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
