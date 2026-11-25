#!/usr/bin/env python3
"""
ECNU 财务系统报销单状态查询（复用 DF 的 SSO 凭证与 session）

用途：
  1. 查询历史报销单列表（含状态/入账日期/财务凭证号）
  2. 查询单张报销单的预约物流（投递→制单→复核→支付 时间线）
  3. --align：与票据簿模型对齐，输出已入账票据集的凭证号/入账日期 JSON

用法：
  python fetch_bill_status.py                     # 全部历史报销单列表
  python fetch_bill_status.py --bill 4000000      # 指定单号（含物流）
  python fetch_bill_status.py --align             # 对齐票据簿（读 ../data/reimbursement-model.json）

凭证：macOS Keychain（ECNU SSO Login / ECNU SSO Password），session 缓存 data/df/session.json。
输出：stdout JSON。节制使用：每次运行一个会话、顺序操作。
"""

import argparse
import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path

from playwright.async_api import async_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from receipt_runtime import DATA_ROOT, launch_chromium, school_session, windows_school_credentials

HOME_URL = "https://treasury.ecnu.edu.cn/WFManager/home2.jsp"
SESSION_PATH = school_session("treasury")
MODEL_PATH = DATA_ROOT / "data" / "reimbursement-model.json"

# 报销单状态 → 票据簿观察期语义
STATUS_MEANING = {
    "财务已入账且已通过复核": "已入账（观察期可结束）",
    "报销完成": "支付完成，等待入账",
    "已复核, 等待支付": "待支付",
    "已制单, 等待复核": "复核中",
    "已分配, 等待制单": "制单中",
    "投递成功": "已投递",
    "已预约": "已递交，待投递",
    "已退回": "财务退回，需处理",
}


def keychain(account: str, service: str) -> str:
    result = subprocess.run(
        ["security", "find-generic-password", "-a", account, "-s", service, "-w"],
        capture_output=True, text=True, timeout=5,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


_GENERIC_GRAMS = {"差旅", "报销", "日常", "业务", "会议", "交通", "住宿", "机票", "高铁"}


def _remark_matches(title: str, remark: str) -> bool:
    """与 src/treasury-sync.ts billMatchesLine 同语义：双向包含 + 分词 + 中文 2~4 字滑窗（排除通用词）。"""
    if not remark or not title:
        return False
    if title in remark or remark in title:
        return True
    for word in re.split(r"[\s ·,，、;；/]+", remark):
        if len(word) >= 2 and word in title and word not in _GENERIC_GRAMS:
            return True
    for size in range(2, 5):
        for i in range(len(remark) - size + 1):
            gram = remark[i:i + size]
            if gram in _GENERIC_GRAMS:
                continue
            if re.search(r"[\u4e00-\u9fa5]{2}", gram) and gram in title:
                return True
    return False


def credentials() -> tuple[str, str]:
    configured = windows_school_credentials()
    if configured is not None:
        return configured
    user = keychain("ecnu_sso", "ECNU SSO Login")
    password = keychain("ecnu_sso_pwd", "ECNU SSO Password")
    if not user or not password:
        sys.exit("Keychain 缺少 ECNU SSO 凭证")
    return user, password


async def ensure_login(context, page) -> None:
    await page.goto(HOME_URL, wait_until="domcontentloaded", timeout=30000)
    await page.wait_for_timeout(3000)
    if "sso.ecnu.edu.cn" not in page.url:
        return
    user, password = credentials()
    await page.get_by_role("textbox", name="username").wait_for(timeout=15000)
    await page.get_by_role("textbox", name="username").fill(user)
    await page.get_by_role("textbox", name="password").fill(password)
    await page.get_by_role("button", name="Sign In").click()
    await page.wait_for_timeout(5000)
    if "sso.ecnu.edu.cn" in page.url:
        sys.exit("SSO 登录失败（可能需要验证码），请人工登录后重试")
    SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
    await context.storage_state(path=str(SESSION_PATH))


async def open_grid(page, node: str, title: str, form_marker: str):
    """导航到 预约报销 → 指定功能页，返回内容 frame。
    openExternal 偶发静默失败（子系统未初始化完），失败时回退到点击左侧菜单。"""
    await page.evaluate("navToPrj('WF_YB6')")
    await page.wait_for_timeout(6000)
    main2 = next(f for f in page.frames if "main2.jsp" in f.url)
    for attempt in range(3):
        try:
            await main2.evaluate(f"$.page.openExternal('WF_YB6','{node}','{title}')")
        except Exception:
            pass
        await page.wait_for_timeout(5000)
        for frame in page.frames:
            try:
                if form_marker in (await frame.content())[:120000]:
                    return frame
            except Exception:
                continue
        # 回退：模拟点击左侧菜单项（菜单 li 的 onclick 里最终也调 openExternal，但经过初始化）
        await main2.evaluate(f"""() => {{
            for (const el of document.querySelectorAll('a, span')) {{
                if ((el.textContent || '').trim() === '{title}') {{ el.click(); return; }}
            }}
        }}""")
        await page.wait_for_timeout(5000)
        for frame in page.frames:
            try:
                if form_marker in (await frame.content())[:120000]:
                    return frame
            except Exception:
                continue
    raise RuntimeError(f"未找到{title} frame")


async def read_grid(frame) -> list[list[str]]:
    """读取当前 frame 的 jqGrid 数据行（保留单元格原始位置，含空列）。"""
    return await frame.evaluate("""() => {
        const grids = Array.from(document.querySelectorAll('table[id^="gridWF_YB6"]'));
        for (const grid of grids) {
            const rows = Array.from(grid.querySelectorAll('tr.jqgrow'));
            if (rows.length) return rows.map(tr => Array.from(tr.cells).map(td => (td.textContent || '').trim()));
        }
        return [];
    }""")


async def open_history_grid(page):
    """历史报销单（仅含已入账/完成单）。"""
    return await open_grid(page, "181", "历史报销单", "formWF_YB6_4351")


async def open_inflight_grid(page):
    """报销单管理（当前报销申请，含已预约/在途未入账单）。"""
    return await open_grid(page, "5215", "报销单管理", "gridWF_YB6_110")


def project_code_from_cells(cells: list[str]) -> str:
    """按完整经费卡号取值。行中出现多个不同卡号时留空，避免错挂项目。"""
    codes = set(re.findall(r"(?<!\d)(?<!\d-)\d{5}-\d{6}-\d{5}(?!\d|-\d)", " ".join(cells)))
    return next(iter(codes)) if len(codes) == 1 else ""


async def query_inflight(frame) -> list[dict]:
    """在途单（报销单管理）。列布局不固定（含隐藏空列），按内容特征定位：
    报销单号=7位数字，其后依次为 业务大类/项目号/填写日期/摘要/总金额/状态/实际报销人。"""
    rows = await read_grid(frame)
    bills = []
    for cells in rows:
        idx = next((i for i, c in enumerate(cells) if c.isdigit() and len(c) == 7), None)
        if idx is None or idx + 7 >= len(cells):
            continue
        bills.append({
            "billNo": cells[idx],
            "category": cells[idx + 1],
            "projectCode": project_code_from_cells([cells[idx + 2]]) or project_code_from_cells(cells),
            "appliedAt": cells[idx + 3],
            "remark": cells[idx + 4],
            "amount": cells[idx + 5],
            "status": cells[idx + 6],
            "reimburser": cells[idx + 7],
            "postedAt": "",
            "voucherNo": "",
            "inFlight": True,
        })
    return bills


async def query_history(frame, page, start="2020-01-01", end="2099-12-31") -> list[dict]:
    await frame.evaluate("""() => {
        const set = (id, v) => { const el = document.getElementById(id); el.readOnly = false; el.value = v; el.dispatchEvent(new Event('change', {bubbles:true})); };
        set('formWF_YB6_4351_t-start_date', '%s');
        set('formWF_YB6_4351_t-end_date', '%s');
    }""" % (start, end))
    await page.wait_for_timeout(400)
    await frame.evaluate("""() => {
        for (const b of document.querySelectorAll('input[type=button], button, a')) {
            const v = (b.value || b.textContent || '').replace(/\\s+/g, '');
            if (v.includes('查询')) { b.click(); return; }
        }
    }""")
    await page.wait_for_timeout(5000)
    rows = await frame.evaluate("""() => {
        const grid = document.getElementById('gridWF_YB6_175');
        if (!grid) return [];
        return Array.from(grid.querySelectorAll('tr.jqgrow')).map(tr => ({
            rowId: tr.id,
            cells: Array.from(tr.cells).map(td => (td.textContent || '').trim()).filter(Boolean),
        }));
    }""")
    bills = []
    for row in rows:
        cells = row["cells"]
        # 布局：行号 | 报销单号 | 项目号 | 申请日期 | 实际报销人 | 状态 | 备注 | 入账日期 | 财务凭证号 | 申请金额 | 业务大类
        if len(cells) >= 10 and cells[1].isdigit():
            bills.append({
                "billNo": cells[1],
                "projectCode": project_code_from_cells([cells[2]]) or project_code_from_cells(cells),
                "appliedAt": cells[3],
                "reimburser": cells[4],
                "status": cells[5],
                "remark": cells[6],
                "postedAt": cells[7] if cells[7] not in ("", "无") else "",
                "voucherNo": cells[8] if cells[8] not in ("", "无") else "",
                "amount": cells[9],
                "category": cells[10] if len(cells) > 10 else "",
            })
    return bills


async def fetch_logistics(frame, page, bill_no: str) -> list[dict]:
    selected = await frame.evaluate(f"""() => {{
        const grid = document.getElementById('gridWF_YB6_175');
        const hit = grid ? Array.from(grid.querySelectorAll('tr.jqgrow')).find(tr => tr.textContent.includes('{bill_no}')) : null;
        if (!hit) return false;
        jQuery('#gridWF_YB6_175').jqGrid('setSelection', hit.id);
        return true;
    }}""")
    if not selected:
        return []
    await page.wait_for_timeout(700)
    await frame.evaluate("""() => {
        for (const b of document.querySelectorAll('input[type=button], button, a')) {
            const v = (b.value || b.textContent || '').replace(/\\s+/g, '');
            if (v.includes('预约物流')) { b.click(); return; }
        }
    }""")
    await page.wait_for_timeout(4000)
    html = await frame.content()
    await frame.evaluate("""() => {
        for (const b of document.querySelectorAll('input[type=button], button, a')) {
            const v = (b.value || b.textContent || '').replace(/\\s+/g, '');
            if (v === '返回' || v === '关闭') { b.click(); return; }
        }
    }""")
    await page.wait_for_timeout(2000)
    text = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", html)
    text = re.sub(r"<[^>]+>", "\n", text)
    lines = [line.strip() for line in text.split("\n") if line.strip() and line.strip() != "&nbsp;"]
    start = next((i for i, line in enumerate(lines) if "预约物流" in line), None)
    if start is None:
        return []
    events = []
    i = start
    while i < len(lines):
        if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$", lines[i]):
            events.append({
                "time": lines[i],
                "status": lines[i + 1] if i + 1 < len(lines) else "",
                "operator": lines[i + 2] if i + 2 < len(lines) and not re.match(r"^\d{4}-", lines[i + 2]) else "",
            })
            i += 3
            continue
        if lines[i].startswith("共") or re.match(r"^\d+ - \d+", lines[i]):
            break
        i += 1
    return events


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bill", help="指定报销单号（查询其物流）")
    parser.add_argument("--align", action="store_true", help="与票据簿模型对齐，输出可导入的 JSON")
    args = parser.parse_args()

    async with async_playwright() as p:
        browser = await launch_chromium(p, channel="chrome", headless=True)
        context = await browser.new_context(storage_state=str(SESSION_PATH))
        page = await context.new_page()
        await ensure_login(context, page)
        frame = await open_history_grid(page)
        bills = await query_history(frame, page)
        # 在途单（报销单管理）：历史表只有已入账单；未完成的必须查这里。
        inflight_frame = await open_inflight_grid(page)
        inflight = await query_inflight(inflight_frame)
        known = {bill["billNo"] for bill in bills}
        bills = bills + [bill for bill in inflight if bill["billNo"] not in known]

        result = {"fetchedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"), "bills": bills}
        if args.bill:
            result["logistics"] = await fetch_logistics(frame, page, args.bill)
        if args.align:
            model = json.loads(MODEL_PATH.read_text()) if MODEL_PATH.exists() else {"sets": []}
            lines = model.get("sets", []) if isinstance(model.get("sets"), list) else []
            matches = []
            for entry in lines:
                title = entry.get("title", "")
                if not title:
                    continue
                candidates = [bill for bill in bills if bill.get("remark") and _remark_matches(title, bill["remark"])]
                if not candidates:
                    continue
                # 一行可能分多张单报销（如日常+差旅拆开）：全部输出，apply 取尚未登记的第一张。
                # 时间闸门：报销单申请月早于票据集创建月的候选不参与（防跨年同城市误配）。
                eligible = [b for b in candidates if not (b.get("appliedAt") and entry.get("createdAt") and b["appliedAt"][:7] < entry["createdAt"][:7])] or candidates
                for bill in candidates:
                    matches.append({
                        "setId": entry.get("id"),
                        "title": title,
                        "billNo": bill["billNo"],
                        "status": bill.get("status"),
                        "postedAt": bill.get("postedAt"),
                        "voucherNo": bill.get("voucherNo"),
                        "appliedAt": bill.get("appliedAt"),
                        "remark": bill.get("remark"),
                        "amount": bill.get("amount"),
                        "currentBillNo": entry.get("treasuryBillNo", ""),
                        "apply": (not entry.get("treasuryBillNo") and eligible and bill is eligible[0]),
                        "ambiguous": len(candidates) > 1,
                    })
            result["alignment"] = {
                "hint": "执行 python apply_alignment.py <alignment.json> 可把匹配结果写回票据簿模型；ambiguous=true 时需人工确认多单归属",
                "matches": matches,
            }
        print(json.dumps(result, ensure_ascii=False, indent=1))
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
