import { openWorkspaceStorage } from "../../../../storage/src/index.js";

const workspacePath = process.argv[2];
if (workspacePath === undefined) process.exit(90);

const storage = openWorkspaceStorage({ workspacePath });
const actor = { kind: "runtime", id: "crash-fixture" } as const;
const created = storage.createProject({
  operationId: "create-project",
  projectId: "project-1",
  name: "process crash fixture",
  mode: "deep",
  actor,
});
if (!created.ok) process.exit(92);
const committed = storage.commitArtifactVersion({
  operationId: "commit-body",
  projectId: "project-1",
  expectedProjectRevision: 0,
  kind: "body",
  logicalKey: "main",
  baseVersionId: null,
  content: "committed before crash",
  reason: "crash recovery fixture",
  actor,
});
if (!committed.ok) process.exit(93);
storage.createSession({
  sessionId: "session-1",
  projectId: "project-1",
  purpose: "draft",
});
storage.startRun({
  runId: "run-1",
  sessionId: "session-1",
  projectId: "project-1",
  planVersion: "crash-fixture-v1",
});

process.exit(91);
