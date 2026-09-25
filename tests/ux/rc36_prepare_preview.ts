/** Fresh local-only workspace paused before research, no original workspace access. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
const port = process.argv[2];
assert.match(port!, /^\d+$/);
const id = `rc36-${randomUUID()}`;
const root = join(tmpdir(), `writing-agent-desktop-test-${id}`);
mkdirSync(join(root, 'user-data'), { recursive: true });
writeFileSync(join(root, 'user-data/provider.json'), JSON.stringify({ schemaVersion:2, kind:'anthropic_compatible', providerId:'offline-fixture', baseURL:`http://127.0.0.1:${port}/v1`, credentialRef:'env:WRITING_AGENT_RC36_KEY', model:'offline-preview', tools:'supported', usage:'reported', allowInsecureHttp:true }));
class Seed extends ModelProviderBase {
  constructor() { super('seed','1',{ protocol:'mock',streaming:'supported',tools:'supported',usage:'reported' }); }
  protected async *providerStream(request:ModelRequest):AsyncIterable<ProviderStreamEvent> {
    const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=')[1]!);
    if (state.actor === 'research') { yield {type:'error',error:{code:'TIMEOUT',message:'fixture pause',retryable:true}}; return; }
    const ready = state.ready || request.messages.some(m=>m.role==='tool' && m.name==='assess_writing_readiness' && JSON.parse(m.content).ok);
    const name = ready ? 'director_decide' : 'assess_writing_readiness';
    const args = ready ? {action:'dispatch',stage:'research',reason:'核对个人感受，不编造经历',questions:[]} : {status:'ready',reason:'纯观察，明确不写具体亲历',questions:[]};
    yield {type:'tool_call_delta',index:0,id:'t'+request.requestId,name,argumentsDelta:JSON.stringify(args)};
    yield {type:'completed',finishReason:'tool_calls'};
  }
}
const storage = openWorkspaceStorage({workspacePath:join(root,'workspace')});
const app = new WritingApplicationService({storage,provider:new Seed()});
const actor={kind:'user',id:'fixture'} as const;
app.createProject({projectId:'preview',operationId:'create',name:'临时素材与流式验收',mode:'deep',actor});
const brief=app.saveWritingBrief({projectId:'preview',operationId:'brief',expectedProjectRevision:0,baseVersionId:null,actor,
  brief:{schemaVersion:1,topic:'安静的节日',genre:'narrative_observation',audience:'自己',lengthTarget:{targetCharacters:400},materialIds:[],constraints:['只写主观感受，不编造亲历'],interactionMode:'co_creation',authorAuthorization:{voice:'安静',styleReference:null,styleDecision:'user_confirmed',directionDecision:'user_confirmed',firsthandMaterialIds:[]},platform:null,publicationGoal:'not_applicable',confirmationStatus:'confirmed'}});
assert.ok(brief.ok);
const project=storage.inspectProject('preview')!;
const run=await app.runDraft({projectId:'preview',expectedProjectRevision:project.revision,expectedBriefVersionId:project.currentBriefVersionId!,model:'fixture',parameters:{},userInstruction:'按刚才确认的方向继续：### 写作方向\n\n- **主题**：安静的节日',budget:{maxModelRequests:16,maxToolCalls:24,maxRetriesPerRequest:0,maxMajorRevisions:1}});
assert.equal(run.ok,false); storage.close();
console.log(JSON.stringify({id,root,projectId:'preview',sessionId:run.sessionId,runId:run.runId}));
