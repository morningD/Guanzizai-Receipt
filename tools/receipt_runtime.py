"""Resolve packaged school code, user-local data and the configured browser."""
import json
import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
DATA_ROOT = Path(os.environ.get("RECEIPT_DATA_ROOT") or APP_ROOT).resolve()


async def launch_chromium(playwright, **options):
    executable = os.environ.get("RECEIPT_BROWSER_EXECUTABLE")
    if not executable:
        try:
            config = json.loads((DATA_ROOT / ".guanzizai" / "browser-runtime.json").read_text(encoding="utf-8"))
            executable = config.get("executablePath")
        except (OSError, ValueError, AttributeError):
            pass
    if not executable and os.name == "nt":
        runtime = DATA_ROOT / ".guanzizai" / "browser-runtime"
        installed = sorted(runtime.glob("chromium-*/chrome-win*/chrome.exe"), reverse=True)
        if installed:
            executable = str(installed[0])
    if isinstance(executable, str) and Path(executable).is_file():
        options.pop("channel", None)
        options["executable_path"] = executable
        return await playwright.chromium.launch(**options)
    if os.environ.get("RECEIPT_RUNTIME") != "portable":
        return await playwright.chromium.launch(**options)
    from playwright.async_api import Error

    for channel in ("chrome", "msedge"):
        try:
            return await playwright.chromium.launch(**{**options, "channel": channel})
        except Error as error:
            if "not found" not in str(error).lower() and "doesn't exist" not in str(error).lower():
                raise
    raise RuntimeError("校内功能需要 Chrome 或 Microsoft Edge。请安装其中一个浏览器后重试。")


def _school_profile():
    """Find the single configured Windows school profile without guessing an identity."""
    import hashlib
    import re

    profile_root = DATA_ROOT / ".guanzizai" / "user-profiles"
    try:
        records = json.loads((profile_root / "profiles.json").read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    profiles = []
    for record in records:
        profile_id = record.get("id", "")
        if not re.fullmatch(r"(?:user-[a-z0-9-]+|profile-default)", profile_id):
            continue
        account = str(record.get("profile", {}).get("schoolSsoAccount") or "").strip()
        service = f"guanzizai-receipt-school-sso-password-{profile_id}"
        digest = hashlib.sha256(service.encode()).hexdigest()
        file = DATA_ROOT / ".guanzizai" / "credentials" / f"{digest}.dpapi"
        if account and file.is_file():
            profiles.append((profile_id, account, service, file))
    if len(profiles) > 1:
        raise RuntimeError("当前数据目录配置了多个学校账号，请用独立数据目录运行校内自动化。")
    return profiles[0] if profiles else None


def windows_school_credentials():
    if os.name != "nt":
        return None

    profile = _school_profile()
    if profile is None:
        raise RuntimeError("请先在用户资料中保存学校 SSO 账号和密码。")
    return _decrypt_school_profile(profile)


def _decrypt_school_profile(profile):
    import base64
    import subprocess

    _, account, service, file = profile
    secret = file.read_bytes()
    script = (APP_ROOT / "tools" / "credential-dpapi.ps1").read_text(encoding="utf-8")
    exe = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    command = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    payload = b"\n".join((b"unprotect", base64.b64encode(service.encode()), base64.b64encode(secret), b""))
    try:
        result = subprocess.run([str(exe), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", command],
                                input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                check=True, timeout=8, creationflags=subprocess.CREATE_NO_WINDOW)
        record = json.loads(base64.b64decode(result.stdout.strip(), validate=True).decode("utf-8"))
        if record.get("account") != account or not record.get("password"):
            raise ValueError("Credential account mismatch")
        return account, record["password"]
    except (ValueError, subprocess.SubprocessError, OSError):
        raise RuntimeError("无法读取此学校账号的凭据，请重新保存账号和密码。") from None


def school_session(kind):
    if os.name != "nt":
        return DATA_ROOT / ("data/df/session.json" if kind == "treasury" else "elab_research/.auth/session.json")

    import hashlib

    profile = _school_profile()
    if profile is None:
        raise RuntimeError("请先在用户资料中保存学校 SSO 账号和密码。")
    profile_id, account, _, _ = profile
    _decrypt_school_profile(profile)
    account_key = hashlib.sha256(account.encode()).hexdigest()
    return DATA_ROOT / ".guanzizai" / "user-profiles" / profile_id / "school" / account_key / f"{kind}.json"
