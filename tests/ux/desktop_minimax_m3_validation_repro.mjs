const endpoint = process.argv[2];
if (typeof endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(endpoint)) {
  throw new Error("Usage: node tests/ux/desktop_minimax_m3_validation_repro.mjs http://127.0.0.1:<port>");
}

const targets = await fetch(`${endpoint}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url.startsWith("writing-agent://"));
if (page === undefined) throw new Error("WRITING_AGENT_PAGE_NOT_FOUND");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let requestId = 0;
async function evaluate(expression) {
  requestId += 1;
  const id = requestId;
  const response = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP_EVALUATION_TIMEOUT")), 5_000);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: { expression, returnByValue: true, awaitPromise: true },
    }));
  });
  return response.result?.result?.value;
}

await evaluate(`(() => {
  const settings = [...document.querySelectorAll("button")]
    .find((button) => button.innerText.trim() === "设置");
  settings?.click();
  return "done";
})()`);
await new Promise((resolve) => setTimeout(resolve, 150));
await evaluate(`(() => {
  const modelTab = [...document.querySelectorAll("button")]
    .find((button) => button.innerText.trim() === "模型");
  modelTab?.click();
  return "done";
})()`);
await new Promise((resolve) => setTimeout(resolve, 300));

let raw = "";
const deadline = Date.now() + 5_000;
while (Date.now() < deadline) {
  raw = await evaluate(`(() => {
    const modelLabel = [...document.querySelectorAll("label")]
      .find((label) => label.querySelector("span")?.innerText.trim() === "模型名称");
    const modelInput = modelLabel?.querySelector("input");
    const status = [...document.querySelectorAll("span")]
      .map((element) => element.innerText.trim())
      .find((text) => text.startsWith("连接验证")) ?? "";
    const alert = document.querySelector('[role="alert"]')?.innerText.trim() ?? "";
    return JSON.stringify({ model: modelInput?.value ?? "", status, alert });
  })()`);
  if (typeof raw === "string" && JSON.parse(raw).model !== "") break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const rawProviderStatus = await evaluate(`(async () => {
  const value = await window.writingAgentDesktop.providerStatus();
  return JSON.stringify({
    configured: value.configured,
    kind: value.kind,
    baseURL: value.baseURL,
    model: value.model,
    connectionTest: value.connectionTest,
  });
})()`);
socket.close();

if (typeof raw !== "string") throw new Error("VALIDATION_STATE_UNAVAILABLE");
if (typeof rawProviderStatus !== "string") throw new Error("PROVIDER_STATUS_UNAVAILABLE");
const state = JSON.parse(raw);
const providerStatus = JSON.parse(rawProviderStatus);
const effectiveModel = state.model || providerStatus.model || "";
const normalizedEndpoint = providerStatus.baseURL === "https://api.minimaxi.com/anthropic/v1";
const exactSymptom =
  effectiveModel === "MiniMax-M3" &&
  state.status.startsWith("连接验证失败") &&
  state.alert.includes("模型名称不可用");

console.log(JSON.stringify({
  model: state.model,
  status: state.status,
  message: state.alert,
  provider: providerStatus,
  normalizedEndpoint,
  exactSymptom,
}, null, 2));

if (exactSymptom) throw new Error("MINIMAX_M3_MISCLASSIFIED_AS_MODEL_UNSUPPORTED");
if (effectiveModel !== "MiniMax-M3") throw new Error("MINIMAX_M3_NOT_CURRENTLY_CONFIGURED");
if (!normalizedEndpoint) throw new Error("MINIMAX_ANTHROPIC_V1_NOT_NORMALIZED");
if (providerStatus.connectionTest?.errorCode === "MODEL_UNSUPPORTED") {
  throw new Error("MINIMAX_M3_STILL_REPORTED_AS_MODEL_UNSUPPORTED");
}
