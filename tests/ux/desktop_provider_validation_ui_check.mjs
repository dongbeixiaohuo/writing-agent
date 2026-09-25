const endpoint = process.argv[2];
if (typeof endpoint !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(endpoint)) {
  throw new Error("Usage: node tests/ux/desktop_provider_validation_ui_check.mjs http://127.0.0.1:<port>");
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
  return response.result?.result?.value;
}

await evaluate(`(() => {
  const settings = [...document.querySelectorAll("button")]
    .find((button) => button.innerText.trim() === "设置");
  settings?.click();
  return settings === undefined ? "SETTINGS_NOT_FOUND" : "SETTINGS_OPENED";
})()`);
await new Promise((resolve) => setTimeout(resolve, 200));
await evaluate(`(() => {
  const model = [...document.querySelectorAll("button")]
    .find((button) => button.innerText.trim() === "模型");
  model?.click();
  return model === undefined ? "MODEL_TAB_NOT_FOUND" : "MODEL_TAB_OPENED";
})()`);
const deadline = Date.now() + 5_000;
let body = "";
while (Date.now() < deadline) {
  body = await evaluate("document.body.innerText");
  if (body.includes("连接未验证") && body.includes("验证已保存配置")) break;
  await new Promise((resolve) => setTimeout(resolve, 100));
}
socket.close();

if (typeof body !== "string") throw new Error("BODY_TEXT_UNAVAILABLE");
const checks = {
  unverifiedStatus: body.includes("连接未验证"),
  verifySavedButton: body.includes("验证已保存配置"),
  saveAndVerifyButton: body.includes("保存并验证连接"),
  costNotice: body.includes("可能产生极少量模型费用"),
};
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((passed) => !passed)) {
  throw new Error("PROVIDER_VALIDATION_UI_INCOMPLETE");
}
