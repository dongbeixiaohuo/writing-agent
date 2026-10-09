# Windows 复制粘贴异常现场采集

用途：Writing Agent 打开时其他软件偶发 Ctrl+C / Ctrl+V 失效，记录异常现场。**这是诊断工具，不是修复程序；没有复现时的正常日志不能确认或排除根因。**

## 用户操作

1. 异常发生后，先不要退出 Writing Agent，也不要清空剪贴板。
2. 双击仓库中的 `apps/desktop/scripts/collect_clipboard_diagnostics.cmd`，不用管理员权限或安装依赖。`.cmd` 和同目录的 `.ps1` 必须放在一起。
3. 采集约 30 秒期间，在受影响的软件用普通测试文字尝试复制、粘贴。记录异常时间、软件名称，以及右键菜单复制/粘贴是否也失败。不需要粘贴密码或业务资料。
4. 窗口显示 `ZIP:` 路径。日志在 `%LOCALAPPDATA%\Writing Agent\diagnostics\clipboard`。检查后把 ZIP 发给排查人员，并说明退出 Writing Agent 后是否恢复。可再采集一份恢复后的日志对照。

仅本次启动使用 `-ExecutionPolicy Bypass`，不修改系统执行策略；不请求管理员权限。若企业安全策略阻止运行，保留错误提示，不关闭安全软件或绕过企业策略。

## PowerShell 运行方式

从仓库根目录执行（或把 `-File` 替换为 `.ps1` 的完整路径）：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\apps\desktop\scripts\collect_clipboard_diagnostics.ps1" -ProbeClipboardAccess
```

可追加 `-DurationSeconds 60` 延长采集，或 `-OutputDirectory "D:\临时诊断"` 改变输出位置。默认 30 秒、50 毫秒采样；最长 300 秒，最短采样间隔 20 毫秒。

如果担心采集影响现场，省略 `-ProbeClipboardAccess`：只查询系统元数据，不打开剪贴板，但无法识别某些使用 NULL 窗口句柄的占用。双击入口默认开启访问探测，探测时只短暂打开并立即关闭，不读取内容。

## 采集范围和解释边界

- `samples.csv`：带日期和时区的采样时间、剪贴板序号、当前占用窗口进程、数据所有者进程、前台进程，以及可选访问探测结果。没有窗口标题或普通按键记录。
- `report.json`：Windows / PowerShell 版本、是否管理员和会话类型、Writing Agent 与常见剪贴板/输入辅助进程的前后快照、占用计数和采集限制。只为 Writing Agent 保存安装路径与版本；不保存启动参数或配置文件。
- `README.txt`：日志解释和反馈事项。
- ZIP 只包含以上三个文件；不会收集用户文章、素材、数据库、密钥、剪贴板文字或图片。不会联网、清空剪贴板、结束进程、安装服务或修改设置。路径及进程名仍可能含个人信息，分享前请检查。

“所有者”通常是最后提供剪贴板数据的窗口，**不等于占用者**。占用窗口缺失不证明没有锁；NULL 句柄占用和短暂竞争可能无法定位到 PID。访问探测成功只表示此刻能打开剪贴板，不代表实际粘贴、延迟渲染或快捷键一定正常；该脚本不能枚举其他软件注册的所有全局快捷键或键盘钩子。

采集源文件保持 ASCII，兼容 Windows PowerShell 5.1。异常现场尚未实测时，不得把采集工具验证通过写成复制粘贴问题已修复。
