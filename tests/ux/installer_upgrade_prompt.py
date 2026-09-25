from __future__ import annotations

import argparse
import ctypes
import json
import subprocess
import time
import winreg
from ctypes import wintypes
from pathlib import Path

from PIL import ImageGrab


ctypes.windll.user32.SetProcessDPIAware()


UNINSTALL_KEY = (
    r"Software\Microsoft\Windows\CurrentVersion\Uninstall"
    r"\c03d2689-78a4-57b7-813e-a5d1cf38cbb8"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture the visible Writing Agent upgrade notice")
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--previous-version", required=True)
    parser.add_argument("--current-version", required=True)
    parser.add_argument("--existing-orphan", action="store_true")
    parser.add_argument("--screenshot", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=20)
    return parser.parse_args()


def window_text(hwnd: int) -> str:
    user32 = ctypes.windll.user32
    length = user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value


def child_texts(hwnd: int) -> list[str]:
    values: list[str] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def callback(child: int, _parameter: int) -> bool:
        text = window_text(child).strip()
        if text:
            values.append(text)
        return True

    ctypes.windll.user32.EnumChildWindows(hwnd, callback, 0)
    return values


def process_windows(process_id: int) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def callback(hwnd: int, _parameter: int) -> bool:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == process_id and user32.IsWindowVisible(hwnd):
            title = window_text(hwnd).strip()
            children = child_texts(hwnd)
            values.append({"handle": hwnd, "title": title, "children": children})
        return True

    user32.EnumWindows(callback, 0)
    return values


def capture_window(hwnd: int, target: Path) -> tuple[int, int, int, int]:
    ctypes.windll.user32.ShowWindow(hwnd, 5)
    ctypes.windll.user32.SetForegroundWindow(hwnd)
    ctypes.windll.user32.UpdateWindow(hwnd)
    time.sleep(0.4)
    rect = wintypes.RECT()
    if not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("INSTALLER_WINDOW_RECT_UNAVAILABLE")
    bounds = (rect.left, rect.top, rect.right, rect.bottom)
    target.parent.mkdir(parents=True, exist_ok=True)
    ImageGrab.grab(window=hwnd, include_layered_windows=True).save(target)
    return bounds


def main() -> int:
    args = parse_args()
    installer = args.installer.resolve(strict=True)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)

    try:
        existing = winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
    except FileNotFoundError:
        existing = None
    if existing is not None:
        existing.close()
        raise RuntimeError("REAL_WRITING_AGENT_REGISTRATION_EXISTS")

    key_created = False
    process: subprocess.Popen[bytes] | None = None
    evidence: dict[str, object] = {
        "installer": str(installer),
        "mode": "existing-orphan" if args.existing_orphan else "registered-upgrade",
        "previousVersion": args.previous_version,
        "currentVersion": args.current_version,
    }
    try:
        if not args.existing_orphan:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY, access=winreg.KEY_WRITE) as key:
                winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, args.previous_version)
            key_created = True

        process = subprocess.Popen([str(installer)])
        deadline = time.monotonic() + args.timeout_seconds
        expected = (
            [
                "检测到这个电脑上已有 Writing Agent，但旧安装记录不完整",
                f"安装程序将从原位置升级到 {args.current_version}",
                "保留项目、设置和模型凭据",
                "无需手工卸载旧版本",
            ]
            if args.existing_orphan
            else [
                f"检测到已安装 Writing Agent {args.previous_version}",
                f"安装程序将升级到 {args.current_version}",
                "保留项目、设置和模型凭据",
                "无需手工卸载旧版本",
            ]
        )
        matched: dict[str, object] | None = None
        while time.monotonic() < deadline:
            for candidate in process_windows(process.pid):
                text = "\n".join([str(candidate["title"]), *map(str, candidate["children"])])
                if all(fragment in text for fragment in expected):
                    matched = {**candidate, "text": text}
                    break
            if matched is not None:
                break
            if process.poll() is not None:
                raise RuntimeError(f"INSTALLER_EXITED_EARLY_{process.returncode}")
            time.sleep(0.1)
        if matched is None:
            raise RuntimeError("UPGRADE_NOTICE_NOT_FOUND")

        bounds = capture_window(int(matched["handle"]), args.screenshot.resolve())
        evidence.update({
            "status": "PASS",
            "windowTitle": matched["title"],
            "dialogText": matched["text"],
            "windowBounds": bounds,
            "screenshot": str(args.screenshot.resolve()),
        })
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                subprocess.run(
                    ["taskkill.exe", "/PID", str(process.pid), "/T", "/F"],
                    check=False,
                    capture_output=True,
                )
        if key_created:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
        evidence["testRegistrationRemoved"] = not key_created or _key_missing()
        args.evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0


def _key_missing() -> bool:
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY)
    except FileNotFoundError:
        return True
    key.close()
    return False


if __name__ == "__main__":
    raise SystemExit(main())
