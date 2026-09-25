import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
if (process.argv[2]) {
  const storage = openWorkspaceStorage({workspacePath:join(process.argv[2],'workspace')});
  storage.startRun({projectId:'executing',sessionId:'s-executing',runId:'r-executing',planVersion:'test'});
  storage.close(); process.exit(0);
}
const root = mkdtempSync(join(tmpdir(), 'writing-agent-desktop-test-delete-'));
const id = root.split('writing-agent-desktop-test-')[1]!;
const storage = openWorkspaceStorage({workspacePath:join(root,'workspace')});
for(const [projectId,name] of [['waiting','待删除确认项目'],['other','保留项目'],['executing','正在写作项目']]) {
  storage.createProject({operationId:`create-${projectId}`,projectId:projectId!,name:name!,mode:'deep',actor:{kind:'user',id:'fixture'}});
  storage.createSession({projectId:projectId!,sessionId:`s-${projectId}`,purpose:'draft'});
  if(projectId!=='executing') {
    storage.startRun({projectId:projectId!,sessionId:`s-${projectId}`,runId:`r-${projectId}`,planVersion:'test'});
    storage.pauseRun({projectId:projectId!,runId:`r-${projectId}`,operationId:`pause-${projectId}`,reason:'CO_CREATION_CHECKPOINT',payload:{stage:'review_editor'}});
  }
}
storage.close(); console.log(JSON.stringify({root,id}));
