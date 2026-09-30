const endpoint = process.argv[2];
if (typeof endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(endpoint)) {
  throw new Error("Usage: node tests/ux/desktop_failure_detail_check.mjs http://127.0.0.1:<port>");
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
      params: { expression, returnByValue: true },
    }));
  });
  const value = response.result?.result?.value;
  if (typeof value !== "string") throw new Error("EVALUATION_RESULT_UNAVAILABLE");
  return value;
}

let body = await evaluate("document.body.innerText");
if (!body.includes("运行失败")) {
  await evaluate(`(() => {
    const session = [...document.querySelectorAll("button")]
      .find((button) => button.innerText.includes("写作草稿"));
    session?.click();
    return session === undefined ? "SESSION_NOT_FOUND" : "SESSION_OPENED";
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 350));
  body = await evaluate("document.body.innerText");
}
socket.close();

const genericFailure = body.includes("请求失败，未更新正式稿件") && body.includes("状态来自持久事件");
const failureVisible = body.includes("运行失败");
const actionableHints = [
  "API Key",
  "API 地址",
  "模型名称",
  "模型 ID",
  "请求超时",
  "网络连接",
  "账户额度",
  "服务暂不可用",
];
const visibleHints = actionableHints.filter((hint) => body.includes(hint));
console.log(JSON.stringify({
  failureVisible,
  genericFailure,
  visibleHints,
}, null, 2));

if (!failureVisible) throw new Error("PERSISTED_MODEL_FAILURE_NOT_VISIBLE");
if (genericFailure || visibleHints.length === 0) {
  throw new Error("MODEL_FAILURE_DETAIL_NOT_ACTIONABLE");
}
