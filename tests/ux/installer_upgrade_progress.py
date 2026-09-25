from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
import winreg
from ctypes import wintypes
from pathlib import Path

from PIL import ImageGrab


ctypes.windll.user32.SetProcessDPIAware()


APP_GUID = "c03d2689-78a4-57b7-813e-a5d1cf38cbb8"
INSTALL_KEY = rf"Software\{APP_GUID}"
UNINSTALL_KEY = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_GUID}"
WM_CLOSE = 0x0010
BM_CLICK = 0x00F5


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture both visible phases of a Writing Agent in-place upgrade",
    )
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--previous-version", required=True)
    parser.add_argument("--current-version", required=True)
    parser.add_argument("--screenshot-dir", type=Path, required=True)
    parser.add_argument("--evidence", type=Path, required=True)
    parser.add_argument("--timeout-seconds", type=float, default=90)
    return parser.parse_args()


def window_text(hwnd: int) -> str:
    length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
    buffer = ctypes.create_unicode_buffer(length + 1)
    ctypes.windll.user32.GetWindowTextW(hwnd, buffer, len(buffer))
    return buffer.value


def class_name(hwnd: int) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetClassNameW(hwnd, buffer, len(buffer))
    return buffer.value


def child_controls(hwnd: int) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def callback(child: int, _parameter: int) -> bool:
        values.append({
            "handle": child,
            "className": class_name(child),
            "controlId": ctypes.windll.user32.GetDlgCtrlID(child),
            "text": window_text(child).strip(),
            "visible": bool(ctypes.windll.user32.IsWindowVisible(child)),
            "enabled": bool(ctypes.windll.user32.IsWindowEnabled(child)),
        })
        return True

    ctypes.windll.user32.EnumChildWindows(hwnd, callback, 0)
    return values


def installer_windows(process_id: int) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    @callback_type
    def callback(hwnd: int, _parameter: int) -> bool:
        owner = wintypes.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        title = window_text(hwnd).strip()
        if owner.value == process_id and ctypes.windll.user32.IsWindowVisible(hwnd):
            controls = child_controls(hwnd)
            values.append({
                "handle": hwnd,
                "title": title,
                "controls": controls,
                "text": "\n".join([title, *[str(item["text"]) for item in controls if item["text"]]]),
            })
        return True

    ctypes.windll.user32.EnumWindows(callback, 0)
    return values


def capture_window(hwnd: int, target: Path) -> tuple[int, int, int, int]:
    ctypes.windll.user32.ShowWindow(hwnd, 5)
    ctypes.windll.user32.SetForegroundWindow(hwnd)
    ctypes.windll.user32.UpdateWindow(hwnd)
    time.sleep(0.12)
    rect = wintypes.RECT()
    if not ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        raise RuntimeError("INSTALLER_WINDOW_RECT_UNAVAILABLE")
    target.parent.mkdir(parents=True, exist_ok=True)
    ImageGrab.grab(window=hwnd, include_layered_windows=True).save(target)
    return (rect.left, rect.top, rect.right, rect.bottom)


def click_first_button(window: dict[str, object], labels: tuple[str, ...]) -> bool:
    for control in window["controls"]:  # type: ignore[index]
        text = str(control["text"])
        if (
            control["className"] == "Button"
            and control["visible"]
            and control["enabled"]
            and any(label in text for label in labels)
        ):
            ctypes.windll.user32.SendMessageW(int(control["handle"]), BM_CLICK, 0, 0)
            return True
    return False


def key_exists(root: int, key_path: str) -> bool:
    try:
        key = winreg.OpenKey(root, key_path)
    except FileNotFoundError:
        return False
    winreg.CloseKey(key)
    return True


def read_registry_string(key_path: str, name: str) -> str:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            return str(winreg.QueryValueEx(key, name)[0])
    except FileNotFoundError:
        return ""


def remove_test_key(key_path: str, expected_install_root: Path) -> None:
    if not key_exists(winreg.HKEY_CURRENT_USER, key_path):
        return
    if key_path == INSTALL_KEY:
        recorded = read_registry_string(INSTALL_KEY, "InstallLocation")
    else:
        recorded = read_registry_string(UNINSTALL_KEY, "InstallLocation")
    if recorded and Path(recorded).resolve() != expected_install_root.resolve():
        raise RuntimeError(f"REFUSING_TO_REMOVE_NON_TEST_REGISTRATION:{recorded}")
    winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key_path)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def find_makensis() -> Path:
    cache = Path(os.environ["LOCALAPPDATA"]) / "electron-builder" / "Cache"
    candidates = sorted(cache.glob("nsis-*/*/makensis.exe"), reverse=True)
    if not candidates:
        raise RuntimeError("MAKENSIS_NOT_FOUND")
    return candidates[0]


def build_slow_test_uninstaller(test_root: Path) -> Path:
    executable = test_root / "mock-old-uninstaller.exe"
    source = test_root / "mock-old-uninstaller.nsi"
    escaped_output = str(executable).replace("$", "$$")
    source.write_text(
        "\n".join([
            "Unicode True",
            "SilentInstall silent",
            "RequestExecutionLevel user",
            'Name "Writing Agent previous-version test double"',
            f'OutFile "{escaped_output}"',
            "Section",
            "  Sleep 1800",
            "SectionEnd",
            "",
        ]),
        encoding="utf-8",
    )
    subprocess.run([str(find_makensis()), "/V2", str(source)], check=True, capture_output=True)
    return executable


def install_test_registration(test_root: Path, uninstaller: Path, previous_version: str) -> None:
    app = test_root / "Writing Agent.exe"
    app.write_bytes(b"previous-version-test-double")
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, INSTALL_KEY, access=winreg.KEY_WRITE) as key:
        winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, str(test_root))
        winreg.SetValueEx(key, "KeepShortcuts", 0, winreg.REG_SZ, "true")
        winreg.SetValueEx(key, "ShortcutName", 0, winreg.REG_SZ, "Writing Agent")
    with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY, access=winreg.KEY_WRITE) as key:
        winreg.SetValueEx(key, "DisplayName", 0, winreg.REG_SZ, "Writing Agent")
        winreg.SetValueEx(key, "DisplayVersion", 0, winreg.REG_SZ, previous_version)
        winreg.SetValueEx(key, "InstallLocation", 0, winreg.REG_SZ, str(test_root))
        winreg.SetValueEx(key, "UninstallString", 0, winreg.REG_SZ, f'"{uninstaller}" /currentuser')


def shortcut_snapshots() -> dict[str, bytes | None]:
    def known_folder(csidl: int) -> Path:
        buffer = ctypes.create_unicode_buffer(32768)
        result = ctypes.windll.shell32.SHGetFolderPathW(None, csidl, None, 0, buffer)
        if result != 0:
            raise RuntimeError(f"KNOWN_FOLDER_LOOKUP_FAILED:{csidl}:{result}")
        return Path(buffer.value)

    paths = [
        known_folder(0x10) / "Writing Agent.lnk",  # CSIDL_DESKTOPDIRECTORY
        known_folder(0x02) / "Writing Agent.lnk",  # CSIDL_PROGRAMS
    ]
    return {str(path): path.read_bytes() if path.exists() else None for path in paths}


def shortcut_hashes(snapshots: dict[str, bytes | None]) -> dict[str, str | None]:
    return {
        path: hashlib.sha256(content).hexdigest() if content is not None else None
        for path, content in snapshots.items()
    }


def restore_shortcuts(snapshots: dict[str, bytes | None]) -> None:
    for path_text, content in snapshots.items():
        path = Path(path_text)
        if content is None:
            if path.exists():
                path.unlink()
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)


def main() -> int:
    args = parse_args()
    installer = args.installer.resolve(strict=True)
    if key_exists(winreg.HKEY_CURRENT_USER, INSTALL_KEY) or key_exists(winreg.HKEY_CURRENT_USER, UNINSTALL_KEY):
        raise RuntimeError("REAL_WRITING_AGENT_REGISTRATION_EXISTS")

    test_container = Path(tempfile.gettempdir()) / f"writing-agent-visible-upgrade-{uuid.uuid4().hex[:12]}"
    test_root = test_container / "Writing Agent"
    if test_container.exists():
        raise RuntimeError(f"REFUSING_TO_REUSE_TEST_ROOT:{test_container}")
    test_root.mkdir(parents=True)
    before_shortcuts = shortcut_snapshots()
    process: subprocess.Popen[bytes] | None = None
    screenshots = {
        "remove": args.screenshot_dir.resolve() / "installer-upgrade-step-1-remove.png",
        "install": args.screenshot_dir.resolve() / "installer-upgrade-step-2-install.png",
    }
    evidence: dict[str, object] = {
        "installer": str(installer),
        "installerSha256": sha256(installer),
        "previousVersion": args.previous_version,
        "currentVersion": args.current_version,
        "testRoot": str(test_root),
        "shortcutsBefore": shortcut_hashes(before_shortcuts),
    }

    try:
        old_uninstaller = build_slow_test_uninstaller(test_root)
        install_test_registration(test_root, old_uninstaller, args.previous_version)
        process = subprocess.Popen([str(installer), "--updated", "/currentuser"])
        deadline = time.monotonic() + args.timeout_seconds
        phase_evidence: dict[str, object] = {}
        evidence["phases"] = phase_evidence
        last_click = 0.0

        while time.monotonic() < deadline:
            if process.poll() is not None and len(phase_evidence) < 2:
                raise RuntimeError(f"INSTALLER_EXITED_BEFORE_BOTH_PHASES:{process.returncode}")
            windows = installer_windows(process.pid)
            for window in windows:
                text = str(window["text"])
                if "步骤 1/2：正在移除旧版本" in text and "remove" not in phase_evidence:
                    bounds = capture_window(int(window["handle"]), screenshots["remove"])
                    phase_evidence["remove"] = {
                        "text": text,
                        "windowBounds": bounds,
                        "screenshot": str(screenshots["remove"]),
                    }
                if f"步骤 2/2：正在安装 Writing Agent {args.current_version}" in text and "install" not in phase_evidence:
                    bounds = capture_window(int(window["handle"]), screenshots["install"])
                    phase_evidence["install"] = {
                        "text": text,
                        "windowBounds": bounds,
                        "screenshot": str(screenshots["install"]),
                    }

                now = time.monotonic()
                if len(phase_evidence) < 1 and now - last_click > 0.35:
                    if click_first_button(window, ("确定", "OK", "下一步", "安装")):
                        last_click = now

            if len(phase_evidence) == 2:
                break
            time.sleep(0.025)

        if len(phase_evidence) != 2:
            raise RuntimeError(f"VISIBLE_UPGRADE_PHASES_MISSING:{sorted(phase_evidence)}")

        install_deadline = time.monotonic() + args.timeout_seconds
        while time.monotonic() < install_deadline:
            if (
                read_registry_string(UNINSTALL_KEY, "DisplayVersion") == args.current_version
                and (test_root / "Uninstall Writing Agent.exe").exists()
            ):
                break
            if process.poll() is not None:
                raise RuntimeError(f"INSTALLER_EXITED_BEFORE_REGISTRATION:{process.returncode}")
            time.sleep(0.1)
        else:
            raise RuntimeError("CURRENT_VERSION_REGISTRATION_NOT_WRITTEN")

        evidence.update({
            "status": "PASS",
            "visibleSequence": ["remove-old-version", "install-new-version"],
            "registeredVersion": read_registry_string(UNINSTALL_KEY, "DisplayVersion"),
            "shortcutsUnchanged": shortcut_snapshots() == before_shortcuts,
        })
        if not evidence["shortcutsUnchanged"]:
            raise RuntimeError("VISIBLE_PROGRESS_TEST_CHANGED_USER_SHORTCUTS")
    finally:
        if process is not None and process.poll() is None:
            for window in installer_windows(process.pid):
                ctypes.windll.user32.PostMessageW(int(window["handle"]), WM_CLOSE, 0, 0)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)

        before_restore = shortcut_snapshots()
        evidence["shortcutsUnchangedBeforeRestore"] = before_restore == before_shortcuts
        if before_restore != before_shortcuts:
            restore_shortcuts(before_shortcuts)
        after_shortcuts = shortcut_snapshots()
        evidence["shortcutsRestored"] = after_shortcuts == before_shortcuts
        try:
            remove_test_key(UNINSTALL_KEY, test_root)
            remove_test_key(INSTALL_KEY, test_root)
            evidence["testRegistrationRemoved"] = True
        except Exception as error:  # retain cleanup evidence before re-raising
            evidence["testRegistrationRemoved"] = False
            evidence["cleanupError"] = str(error)
        if test_container.exists():
            shutil.rmtree(test_container)
        evidence["testRootRemoved"] = not test_container.exists()
        args.evidence.resolve().parent.mkdir(parents=True, exist_ok=True)
        args.evidence.resolve().write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
