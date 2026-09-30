import {
  openWorkspaceStorage,
  type CommitFaultPoint,
} from "../../src/index.js";

const workspacePath = process.argv[2];
const faultPoint = process.argv[3] as CommitFaultPoint | undefined;

if (workspacePath === undefined || faultPoint === undefined) process.exit(90);

const storage = openWorkspaceStorage({
  workspacePath,
  faultInjector: (point) => {
    if (point === faultPoint) process.exit(91);
  },
});

storage.commitArtifactVersion({
  operationId: `process-crash-${faultPoint}`,
  projectId: "project-process-crash",
  expectedProjectRevision: 0,
  kind: "body",
  logicalKey: "main",
  baseVersionId: null,
  content: "这个版本不能提交",
  reason: "进程退出恢复验证",
  actor: { kind: "runtime", id: "crash-fixture" },
});

storage.close();
process.exit(92);
