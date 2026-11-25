#!/usr/bin/env python3
"""同步 elab HC 单状态：登录 → 普通查询列表 → 输出 {单号: 状态} JSON。

被观自在 /api/elab-hc-sync 调用（stdout JSON 进管线）。只读，不写 elab。
"""

import asyncio
import json
import subprocess
import sys
from pathlib import Path

from playwright.async_api import async_playwright

from receipt_runtime import DATA_ROOT, launch_chromium, school_session, windows_school_credentials

ROOT = DATA_ROOT
STORAGE_PATH = school_session("elab")
import argparse  # noqa: E402

_parser = argparse.ArgumentParser()
_parser.add_argument("--system", default="zcgl", choices=["zcgl", "wxzc"])
_args, _ = _parser.parse_known_args()

if _args.system == "wxzc":
    ENTRY_URL = "https://elab.ecnu.edu.cn/wxzc/index.jsp"
    LIST_URL = "/wxzc/bzgl/bzd/ListPage.jsp?zclx=CSF&role=ptyh&fromzclx=FUWU&sumZclx=CSMX&sqjsbh=03110"
    BILL_RE = "CSF\\d{7}"
    STAGE_RE = "经费负责人审批|实验室与装备处审批|装备处备案|科技处审核|科技处"
else:
    ENTRY_URL = "https://elab.ecnu.edu.cn/zcgl/index.jsp"
    LIST_URL = "/zcgl/bzgl/bzd/ListPage.jsp?zclx=PLHC&role=ptyh&sumZclx=HC&fromzclx=XM&sqjsbh=03110"
    BILL_RE = "HC\\d{7}"
    STAGE_RE = "经费负责人审批|实验室与装备处审批|装备处备案"


def get_credentials() -> tuple[str, str]:
    configured = windows_school_credentials()
    if configured is not None:
        return configured
    def kc(a, s):
        r = subprocess.run(["security", "find-generic-password", "-a", a, "-s", s, "-w"], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    username, password = kc("ecnu_sso", "ECNU SSO Login"), kc("ecnu_sso_pwd", "ECNU SSO Password")
    if not username or not password:
        raise RuntimeError("Keychain 无 ECNU 凭证")
    return username, password


async def main() -> int:
    import time
    username, password = get_credentials()
    async with async_playwright() as p:
        browser = await launch_chromium(p, channel="chrome", headless=True)
        ctx_args = {"locale": "zh-CN"}
        if STORAGE_PATH.exists():
            ctx_args["storage_state"] = str(STORAGE_PATH)
        ctx = await browser.new_context(**ctx_args)
        page = await ctx.new_page()

        await page.goto(ENTRY_URL, wait_until="domcontentloaded")
        ready = False
        for _ in range(15):
            m = next((f for f in page.frames if "left_new" in f.url), None)
            if m:
                try:
                    if await m.evaluate("() => document.readyState") == "complete":
                        ready = True
                        break
                except Exception:
                    pass
            await asyncio.sleep(0.5)
        if not ready:
            # SSO 重登
            await page.wait_for_selector("#nameInput", timeout=20000)
            await page.fill("#nameInput", username)
            await page.fill("input[type=password] >> visible=true", password)
            await page.click("#submitBtn")
            deadline = time.time() + 45
            while time.time() < deadline:
                if next((f for f in page.frames if "left_new" in f.url), None):
                    await asyncio.sleep(1)
                    break
                await asyncio.sleep(0.5)

        body = next((f for f in page.frames if f.name == "BodyFrame"), None)
        if body is None:
            raise RuntimeError("BodyFrame 不存在")
        await body.evaluate(f"() => location.href = '{LIST_URL}'")
        # 锚点 1：BodyFrame URL 真正到 ListPage（防止首页消息表被当成列表——防止消息竞态）
        deadline = time.time() + 25
        while time.time() < deadline:
            b = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if b is not None and "ListPage.jsp" in b.url:
                break
            await asyncio.sleep(0.4)
        # 锚点 2：列表表格渲染出 HC 单行
        rows = []
        while time.time() < deadline:
            b = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if b is not None:
                try:
                    rows = await b.evaluate("""(patterns) => {
                      const billRe = new RegExp(patterns.billRe);
                      const stageRe = new RegExp(patterns.stageRe);
                      const out = [];
                      for (const tr of document.querySelectorAll('table tr')) {
                        const m = tr.textContent.match(billRe);
                        if (!m) continue;
                        const tds = Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim());
                        const status = tds.find((t) => /填写中|待|审核|退回|通过/.test(t)) || '';
                        const stageRaw = tds.find((t) => stageRe.test(t)) || '';
                        const stage = (stageRaw.match(stageRe) || [''])[0];
                        const total = (tr.textContent.match(/[\\d,]+\\.\\d{2}/g) || []).slice(-1)[0] || '';
                        const link = tr.querySelector('a[href*="f_detail"]');
                        const wid = link ? ((link.getAttribute('href') || '').match(/\\d{15,}/) || [''])[0].trim() : '';
                        out.push([m[0], status, total, stage, wid]);
                      }
                      return out;
                    }""", {"billRe": BILL_RE, "stageRe": STAGE_RE})
                    if rows:
                        break
                except Exception:
                    pass
            await asyncio.sleep(0.6)
        if rows:
            STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
            await ctx.storage_state(path=str(STORAGE_PATH))
        print(json.dumps({no: {"status": status, "total": total.replace(",", ""), "stage": stage, "wid": wid} for no, status, total, stage, wid in rows}, ensure_ascii=False))
        await browser.close()
        return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as e:
        print(json.dumps({"error": str(e)[:200]}))
        sys.exit(1)
