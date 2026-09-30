const endpoint = process.argv[2];
if (typeof endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(endpoint)) {
  throw new Error("Usage: node tests/ux/desktop_conversation_follow_repro.mjs http://127.0.0.1:<port>");
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
async function command(method, params = {}) {
  requestId += 1;
  const id = requestId;
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("CDP_COMMAND_TIMEOUT")), 5_000);
    const onMessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      resolve(message);
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const response = await command("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return response.result?.result?.value;
}

await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
await new Promise((resolve) => setTimeout(resolve, 150));

await evaluate(`(() => {
  const home = [...document.querySelectorAll("button")]
    .find((button) => button.innerText.trim() === "写作首页");
  home?.click();
  return home === undefined ? "HOME_NOT_FOUND" : "HOME_OPENED";
})()`);
await new Promise((resolve) => setTimeout(resolve, 200));
await evaluate(`(() => {
  const session = [...document.querySelectorAll("button")]
    .find((button) => button.innerText.includes("写作草稿"));
  session?.click();
  return session === undefined ? "SESSION_NOT_FOUND" : "SESSION_OPENED";
})()`);
await new Promise((resolve) => setTimeout(resolve, 500));

const raw = await evaluate(`(() => {
  const body = document.body.innerText;
  const candidates = [...document.querySelectorAll("main, section, div")]
    .filter((element) => {
      const style = getComputedStyle(element);
      return (style.overflowY === "auto" || style.overflowY === "scroll") &&
        element.scrollHeight > element.clientHeight + 20 &&
        element.innerText.includes("草稿已经生成并保存在这台电脑上");
    })
    .map((element) => ({
      element,
      className: String(element.className),
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      distanceToBottom: element.scrollHeight - element.clientHeight - element.scrollTop,
    }))
    .sort((left, right) => left.clientHeight - right.clientHeight);
  const scroll = candidates[0];
  return JSON.stringify({
    legacyReply: /稿件已持久保存为版本 [0-9a-f-]{36}/u.test(body),
    hasActionableReply: body.includes("草稿已经生成并保存在这台电脑上") &&
      body.includes("点击右上角“稿件与版本”查看全文"),
    hasPlainProgress: body.includes("写作模型") && body.includes("读取参考材料"),
    hasTechnicalProgress: body.includes("结果已持久提交") ||
      body.includes("调用工具：read_material"),
    hasCompletion: body.includes("运行完成"),
    scroll: scroll === undefined ? null : {
      className: scroll.className,
      scrollTop: scroll.scrollTop,
      clientHeight: scroll.clientHeight,
      scrollHeight: scroll.scrollHeight,
      distanceToBottom: scroll.distanceToBottom,
    },
  });
})()`);
socket.close();

if (typeof raw !== "string") throw new Error("CONVERSATION_STATE_UNAVAILABLE");
const state = JSON.parse(raw);
const followsLatest = state.scroll !== null && state.scroll.distanceToBottom <= 32;
console.log(JSON.stringify({ ...state, followsLatest }, null, 2));

if (!state.hasCompletion) throw new Error("COMPLETED_CONVERSATION_NOT_VISIBLE");
if (
  !state.hasActionableReply ||
  !state.hasPlainProgress ||
  state.hasTechnicalProgress ||
  state.legacyReply ||
  !followsLatest
) {
  throw new Error("CONVERSATION_COMPLETION_UX_NOT_ACTIONABLE");
}
