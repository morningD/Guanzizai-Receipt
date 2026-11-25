#!/usr/bin/env python3
"""
每日财务状态轮询：查询旧系统（历史+在途）报销单，更新票据簿模型中已登记单号的状态。

设计：
- 只更新已登记 treasuryBillNo 的票据集（不自动新增匹配——对齐仍走 apply_alignment.py 人工确认）
- 状态变化写入模型；变化记录追加到 treasury_research/poll_log.jsonl
- 在途单出现新匹配候选时只提示，不写入
- 幂等：无变化不动模型文件

可定时调用（--cron 时静默跳过无变化）。
"""

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_bill_status import ensure_login, open_history_grid, open_inflight_grid, project_code_from_cells, query_history, query_inflight, MODEL_PATH, SESSION_PATH
from receipt_runtime import DATA_ROOT, launch_chromium

from playwright.async_api import async_playwright

POLL_LOG = DATA_ROOT / "treasury_research" / "poll_log.jsonl"

# YBX「全部报销单」状态列关键词（顺序即优先级）：含投递链路（投递成功是 YB6/物流语义）与
# 委托打印面的「支付完成」终态文案；无命中留空——整行盲截会把「国内差旅2026-09-05」（业务大类+日期）
# 错当状态。
ALLBILLS_STATUS_KEYWORDS = (
    "投递成功", "等待财务入账", "等待支付", "等待复核", "等待制单", "已预约",
    "协同", "审批中", "已退回", "报销完成", "支付完成", "草稿", "已入账",
)


def parse_amount_cny(raw: object) -> float | None:
    """报销单申请金额列文本（如 "3,157.09"、"3157.09元"）→ 元数值；解析失败返回 None。"""
    if isinstance(raw, (int, float)):
        return float(raw)
    text = str(raw or "").replace(",", "").replace("¥", "").replace("元", "").strip()
    try:
        value = float(text)
        return value if value >= 0 else None
    except ValueError:
        return None


def merge_status(entry: dict, bill: dict) -> dict | None:
    """把报销单最新状态合并进票据集；有实质变化时返回 {field: (old, new)}。

    单据维度数据存 entry.treasuryBills（billNo 为键，多单互不覆盖）；
    顶层 treasury* 字段只跟随主单（entry.treasuryBillNo），保持向后兼容。"""
    changes: dict[str, tuple] = {}
    bill_no = bill.get("billNo", "")
    amount = parse_amount_cny(bill.get("amount"))
    project_code = str(bill.get("projectCode") or "").strip()
    # 开单系统：YBX 全部报销单数据面命中 = 智能报销平台单；仅 YB6（报销单管理/历史）命中 = 老系统单。
    system = "YBX" if bill.get("source") == "allbills" else "YB6"
    # 单当前位置（随每次轮询刷新）：直达 open_bill 按此直取对应视图，不再逐个试错。
    view = {"allbills": "YBX-全部报销单", "inflight": "YB6-报销单管理", "history": "YB6-历史报销单"}.get(bill.get("source", ""), "")
    record = {
        "billNo": bill_no,
        "status": bill.get("status", ""),
        "appliedAt": bill.get("appliedAt", ""),
        "postedAt": bill.get("postedAt", ""),
        "voucherNo": bill.get("voucherNo", ""),
        "amountCny": amount,
        "projectCode": project_code if project_code not in ("无", "-", "--") else "",
        "view": view,
    }
    # 权威防线（2026-11-21 三单实证）：记录已带凭证号/入账日期 = 已入账铁证；allbills 数据面状态列停在
    # 「报销完成」且无凭证列——不得用它把已入账状态降级回「报销完成」或覆盖凭证面金额。
    # （YB6 历史/委托打印面自带凭证，任意覆盖均安全。）
    def _skip_keys(existing: dict) -> set:
        if not (existing.get("voucherNo") or existing.get("postedAt")):
            return set()
        if bill.get("source") == "history" or bill.get("voucherNo") or bill.get("postedAt"):
            return set()
        return {"status", "amountCny"}
    bills = list(entry.get("treasuryBills") or [])
    idx = next((i for i, b in enumerate(bills) if b.get("billNo") == bill_no), None)
    if idx is None:
        bills.append({**record, "system": system})
        changes[f"treasuryBills[{bill_no}]"] = ("", bill.get("status", ""))
    else:
        if not bills[idx].get("system"):
            bills[idx]["system"] = system
            changes[f"treasuryBills[{bill_no}].system"] = ("", system)
        if view and bills[idx].get("view") != view:
            changes[f"treasuryBills[{bill_no}].view"] = (bills[idx].get("view", ""), view)
            bills[idx]["view"] = view
        skip = _skip_keys(bills[idx])
        for key, value in record.items():
            if key in skip:
                continue
            if value and bills[idx].get(key) != value:
                changes[f"treasuryBills[{bill_no}].{key}"] = (bills[idx].get(key, ""), value)
                bills[idx][key] = value
    entry["treasuryBills"] = bills
    if entry.get("treasuryBillNo") == bill_no:
        new_status = bill.get("status", "")
        old_status = entry.get("treasuryStatus", "")
        # 状态清洗：新状态为空（YBX 行无关键词命中）而旧状态不在合法集合（如盲截产物「国内差旅2026」）→ 清除污染值。
        legal = {"投递成功", "等待财务入账", "等待支付", "等待复核", "等待制单", "已预约", "协同人", "协同", "审批中", "已退回", "报销完成", "草稿", "已入账", "投递成功", "财务已入账且已通过复核"}
        if not new_status and old_status and old_status not in legal:
            changes["treasuryStatus"] = (old_status, "")
            entry["treasuryStatus"] = ""
        updates = {
            "treasuryStatus": new_status,
            "treasuryStatusAt": bill.get("postedAt") or bill.get("appliedAt") or "",
        }
        if bill.get("voucherNo"):
            updates["treasuryVoucherNo"] = bill["voucherNo"]
        if bill.get("postedAt"):
            updates["treasuryPostedAt"] = bill["postedAt"]
        if amount is not None:
            updates["treasuryAmountCny"] = amount
        # 顶层同款权威防线：已入账镜像字段不被低权威数据面降级。
        if _skip_keys({"voucherNo": entry.get("treasuryVoucherNo"), "postedAt": entry.get("treasuryPostedAt")}):
            updates.pop("treasuryStatus", None)
            updates.pop("treasuryAmountCny", None)
        for key, value in updates.items():
            if value and entry.get(key) != value:
                changes[key] = (entry.get(key, ""), value)
                entry[key] = value
    return changes or None




async def query_allbills(context, page) -> list[dict]:
    """智能报销平台「我的业务——全部报销单」：全状态覆盖（含协同审批中等 YB6 报销单管理视图看不到的单）。
    必须经 home2 → 智能报销（navToPrj）导航：直接访问 YBX/main.jsp 无会话链会被踢到 login.html。"""
    import re as _re
    try:
        async with context.expect_page(timeout=15000) as pi:
            await page.evaluate("""() => { const a = Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === '智能报销' && (a.href || '').includes('navToPrj')); if (a) a.click(); }""")
        ybx = await pi.value
    except Exception as exc:
        print(f"[allbills] 智能报销 tab 打开失败: {exc}", flush=True)
        return []
    try:
        ybx.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
        await ybx.wait_for_timeout(9000)
        await ybx.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && x.innerText.includes('真实性')); if (d) { const b = Array.from(d.querySelectorAll('button')).find(e => e.textContent.trim() === '确认'); if (b) b.click(); } }""")
        await ybx.wait_for_timeout(2000)
        clicked = await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (!els.length) return 'nf'; els[0].click(); return 'ok'; }""")
        if clicked == "nf":
            print("[allbills] 全部报销单入口未找到", flush=True)
            return []
        await ybx.wait_for_timeout(6000)
        rows = await ybx.evaluate("""() => Array.from(document.querySelectorAll('tr[id]')).filter(tr => tr.offsetParent !== null).map(tr => ({
            cells: Array.from(tr.cells).map(td => (td.textContent || '').trim()),
            project: tr.querySelector('td[aria-describedby$="_uni_prj_code"], td[aria-describedby$="_prj_code"]')?.textContent?.trim() || '',
        }))""")
        bills = []
        for row in rows:
            cells = row["cells"]
            # 逐列解析（2026-11-21）：相邻 td 的 textContent 直接拼接会把序号粘进金额
            # （「23」+「1,391.06」→ 231,391.06），整行正则已三次实证出错——单号/状态/金额各取各自的单元格。
            no = next((c for c in cells if _re.fullmatch(r"4\d{6}", c)), "")
            if no:
                status = ""
                for c in cells:
                    if c == no:
                        continue
                    hit = next((kw for kw in ALLBILLS_STATUS_KEYWORDS if kw in c), "")
                    if hit:
                        status = hit
                        break
                amount = next((c for c in cells if _re.fullmatch(r"\d{1,3}(?:,\d{3})*\.\d{2}", c)), "")
            else:
                # 兜底：无单号独立列时退回整行文本匹配（列结构变化时不至于整面失明）。
                text = " ".join(cells)
                m = _re.search(r"4\d{6}", text)
                if not m:
                    continue
                no = m.group(0)
                after = text[m.end():]
                status = next((kw for kw in ALLBILLS_STATUS_KEYWORDS if kw in after), "")
                amount = ""
            project_code = project_code_from_cells([row["project"]]) or project_code_from_cells(cells)
            bills.append({"billNo": no, "status": status, "amount": amount, "projectCode": project_code, "appliedAt": "", "remark": "", "reimburser": "", "postedAt": "", "voucherNo": "", "inFlight": True, "source": "allbills"})
        return bills
    except Exception as exc:
        print(f"[allbills] 查询失败: {exc}", flush=True)
        return []
    finally:
        try:
            await ybx.close()
        except Exception:
            pass

async def poll(only_registered: bool = True) -> dict:
    async with async_playwright() as p:
        browser = await launch_chromium(p, channel="chrome", headless=True)
        context = await browser.new_context(storage_state=str(SESSION_PATH) if SESSION_PATH.exists() else None)
        page = await context.new_page()
        await ensure_login(context, page)
        frame = await open_history_grid(page)
        history_bills = await query_history(frame, page)
        inflight_frame = await open_inflight_grid(page)
        bills = await query_inflight(inflight_frame)
        # 第三个数据面：智能报销平台全部报销单（协同审批中等状态只在这里可见）；history 的凭证/入账字段优先
        allbills = await query_allbills(context, page)
        await browser.close()
        by_no: dict[str, dict] = {}
        for b in allbills:
            by_no[b["billNo"]] = {**b, "source": "allbills"}
        for b in bills:
            if b["billNo"] in by_no:
                by_no[b["billNo"]] = {**by_no[b["billNo"]], **{k: v for k, v in b.items() if v}}
            else:
                by_no[b["billNo"]] = {**b, "source": "inflight"}
        for b in history_bills:
            if b["billNo"] in by_no:
                by_no[b["billNo"]] = {**by_no[b["billNo"]], **{k: v for k, v in b.items() if v}}
            else:
                by_no[b["billNo"]] = {**b, "source": "history"}
        bills = list(by_no.values())

    by_no = {bill["billNo"]: bill for bill in bills}
    model = json.loads(MODEL_PATH.read_text())
    changed_sets, unregistered_hits = [], []
    for entry in model.get("sets", []):
        bill_nos = [entry.get("treasuryBillNo", "")] + list(entry.get("treasuryBillNos") or [])
        bill_nos = [no for no in bill_nos if no]
        if not bill_nos:
            # 未登记行：记录在途候选提示（不写入）
            if not only_registered:
                continue
            title = entry.get("title", "")
            for bill in bills:
                from fetch_bill_status import _remark_matches
                if bill.get("remark") and _remark_matches(title, bill["remark"]):
                    unregistered_hits.append({"title": title, "billNo": bill["billNo"], "status": bill.get("status"), "remark": bill.get("remark")})
            continue
        for no in bill_nos:
            bill = by_no.get(no)
            if not bill:
                continue
            changes = merge_status(entry, bill)
            if changes:
                changed_sets.append({"id": entry.get("id"), "title": entry.get("title"), "billNo": no, "changes": changes})

    if changed_sets:
        MODEL_PATH.write_text(json.dumps(model, ensure_ascii=False, indent=1) + "\n")
        POLL_LOG.parent.mkdir(exist_ok=True)
        with POLL_LOG.open("a") as log:
            log.write(json.dumps({"at": datetime.now().isoformat(timespec="seconds"), "changed": changed_sets}, ensure_ascii=False) + "\n")

    return {"totalBills": len(bills), "changedSets": changed_sets, "unregisteredHits": unregistered_hits}


def main() -> None:
    parser = argparse.ArgumentParser()
    output = parser.add_mutually_exclusive_group()
    output.add_argument("--cron", action="store_true", help="launchd 调用：静默模式，输出单行摘要")
    output.add_argument("--summary-json", action="store_true", help="供本地界面读取末行 JSON 摘要")
    args = parser.parse_args()
    result = asyncio.run(poll())
    if args.cron:
        print(f"[{datetime.now():%Y-%m-%d %H:%M}] bills={result['totalBills']} changed={len(result['changedSets'])} candidates={len(result['unregisteredHits'])}", flush=True)
        for hit in result["unregisteredHits"]:
            print(f"  候选: {hit['title']} <- {hit['billNo']} {hit['status']}", flush=True)
    elif args.summary_json:
        changed = {entry["billNo"] for entry in result["changedSets"]}
        print(json.dumps({"changedBills": len(changed)}), flush=True)
    else:
        print(json.dumps(result, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
