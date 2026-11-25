#!/usr/bin/env python3
"""在财务系统中打开指定报销单（headed，窗口留给用户）。

按单号自动选择视图：
  1. YBX 智能报销「全部报销单」：勾选行 → 行内「查看明细」
  2. WF_YB6 老系统「报销单管理」（在途单）→「历史报销单」（已入账单）：勾选行 → 页面级「查看报销单明细信息」

全部等待均为锚点轮询（老系统时序不稳，固定 sleep 会 flaky）；日志落盘 /tmp/guanzizai_open_bill.log。
所有视图都找不到单号时保持窗口打开（不关浏览器），留给用户人工查看。

用法：python3 tools/open_bill.py --bill 4000000
"""

import argparse
import asyncio
import datetime
import json
import signal
import sys
from pathlib import Path

from playwright.async_api import async_playwright, Error as PlaywrightError

from receipt_runtime import APP_ROOT, DATA_ROOT, launch_chromium

ROOT = DATA_ROOT
sys.path.insert(0, str(APP_ROOT / "treasury_research"))
from fetch_bill_status import HOME_URL, SESSION_PATH, ensure_login, open_history_grid, open_inflight_grid  # noqa: E402

LOG_PATH = Path("/tmp/guanzizai_open_bill.log")


def log(message: str) -> None:
    line = f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {message}"
    print(line, flush=True)
    try:
        with LOG_PATH.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


async def wait_anchor(page, description: str, js: str, arg=None, timeout_s: int = 30, interval_ms: int = 1500):
    """轮询 evaluate(js) 直到返回真值；超时返回 None。"""
    deadline = asyncio.get_event_loop().time() + timeout_s
    last = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            last = await page.evaluate(js, arg) if arg is not None else await page.evaluate(js)
        except PlaywrightError as exc:
            last = f"eval-error: {str(exc)[:80]}"
        if last:
            return last
        await page.wait_for_timeout(interval_ms)
    log(f"[bill-open] 等待超时: {description}（最后: {last}）")
    return None


async def dismiss_truth_dialog(page) -> None:
    """真实性确认弹窗（出现时机不稳，循环点直到消失）。"""
    for _ in range(15):
        hit = await page.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && x.innerText.includes('真实性')); if (d) { const b = Array.from(d.querySelectorAll('button')).find(e => e.textContent.trim() === '确认'); if (b) { b.click(); return 'ok'; } } return ''; }""")
        if hit:
            log("[bill-open] 真实性确认已点")
            return
        await page.wait_for_timeout(2000)


async def dismiss_continue_dialog(page, marker: str = "查看报销单") -> None:
    """「仅供查看…继续」类提示框，循环点「继续」。"""
    for _ in range(10):
        hit = await page.evaluate("""(marker) => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && x.innerText.includes(marker)); if (d) { const b = Array.from(d.querySelectorAll('button')).find(e => e.textContent.trim() === '继续'); if (b) { b.click(); return 'ok'; } } return ''; }""", marker)
        if hit:
            log("[bill-open] 「继续」已点")
            return
        await page.wait_for_timeout(1500)


async def open_in_ybx(context, page, bill: str) -> bool:
    """智能报销平台「全部报销单」勾选并查看明细。成功返回 True。"""
    opened = await wait_anchor(page, "智能报销入口链接", """() => {
        const a = Array.from(document.querySelectorAll('a')).find(a => a.textContent.trim() === '智能报销' && (a.href || '').includes('navToPrj'));
        if (!a) return '';
        a.click();
        return 'clicked';
    }""", timeout_s=20)
    if not opened:
        return False
    ybx = await context.wait_for_event("page", timeout=20000)
    ybx.on("dialog", lambda d: asyncio.ensure_future(d.accept()))
    await ybx.wait_for_timeout(6000)
    await dismiss_truth_dialog(ybx)
    clicked = await wait_anchor(ybx, "全部报销单入口", """() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (!els.length) return ''; els[0].click(); return 'ok'; }""", timeout_s=25)
    if not clicked:
        return False
    if not await wait_anchor(ybx, "报销单列表行", "() => document.querySelectorAll('tr.jqgrow').length ? 'ok' : ''", timeout_s=30):
        return False
    selected = ""
    for attempt in range(2):
        selected = await ybx.evaluate("""(bill) => {
            const td = [...document.querySelectorAll('td')].find(e => e.offsetParent !== null && e.textContent.trim() === bill);
            if (!td) return 'no-row';
            const grid = td.closest('table')?.id || td.closest('.ui-jqgrid-btable')?.id || '';
            if (!grid) return 'no-grid';
            jQuery('#' + grid).jqGrid('resetSelection');
            jQuery('#' + grid).setSelection(td.closest('tr').id, true);
            return 'ok';
        }""", bill)
        if selected == "ok":
            break
        log(f"[bill-open] YBX 勾选第 {attempt + 1} 次失败: {selected}")
        await ybx.wait_for_timeout(3000)
    if selected != "ok":
        log(f"[bill-open] 单号 {bill} 不在 YBX 全部报销单（智能报销平台单才在此列表）")
        return False
    await ybx.wait_for_timeout(1000)
    view = await ybx.evaluate("""(bill) => {
        const td = [...document.querySelectorAll('td')].find(e => e.offsetParent !== null && e.textContent.trim() === bill);
        if (!td) return 'no-row';
        const btn = [...td.closest('tr').querySelectorAll('button')].find(b => b.textContent.trim() === '查看明细');
        if (!btn) return 'no-btn';
        btn.click();
        return 'ok';
    }""", bill)
    if view != "ok":
        log(f"[bill-open] YBX 查看明细失败: {view}")
        return False
    await dismiss_continue_dialog(ybx)
    log(f"[bill-open] 单据 {bill} 已打开（YBX 全部报销单）；关闭窗口即回收")
    return True


async def open_yb6_inflight(page, bill: str) -> bool:
    """老系统「报销单管理」（在途单）：勾选 → 页面级「查看报销单明细信息」。"""
    try:
        frame = await open_inflight_grid(page)
    except Exception as exc:
        log(f"[bill-open] 打开报销单管理失败: {str(exc)[:80]}")
        return False
    return await select_and_open_yb6(page, frame, "报销单管理", bill, with_query=False)


async def open_yb6_history(page, bill: str) -> bool:
    """老系统「历史报销单」（已入账单）：查询 → 勾选 → 明细。"""
    try:
        frame = await open_history_grid(page)
    except Exception as exc:
        log(f"[bill-open] 打开历史报销单失败: {str(exc)[:80]}")
        return False
    return await select_and_open_yb6(page, frame, "历史报销单", bill, with_query=True)


async def select_and_open_yb6(page, frame, label: str, bill: str, with_query: bool) -> bool:
    if with_query:
        await frame.evaluate("""(endDate) => {
            const set = (id, v) => { const el = document.getElementById(id); el.readOnly = false; el.value = v; el.dispatchEvent(new Event('change', {bubbles:true})); };
            set('formWF_YB6_4351_t-start_date', '2000-01-01');
            set('formWF_YB6_4351_t-end_date', endDate);
        }""", f"{datetime.date.today().year + 1}-12-31")
        await page.wait_for_timeout(400)
        await frame.evaluate("""() => { for (const b of document.querySelectorAll('input[type=button], button, a')) { const v = (b.value || b.textContent || '').replace(/\\s+/g, ''); if (v.includes('查询')) { b.click(); return; } } }""")
        await page.wait_for_timeout(5000)
    selected = await wait_anchor(frame, f"{label}勾选 {bill}", """(bill) => {
        const grids = Array.from(document.querySelectorAll('table[id^="gridWF_YB6"]'));
        for (const grid of grids) {
            const td = [...grid.querySelectorAll('td')].find(e => e.textContent.trim() === bill);
            if (!td) continue;
            jQuery('#' + grid.id).jqGrid('resetSelection');
            jQuery('#' + grid.id).setSelection(td.closest('tr').id, true);
            return 'ok:' + grid.id;
        }
        return '';
    }""", arg=bill, timeout_s=20)
    if not selected:
        log(f"[bill-open] 单号 {bill} 不在{label}")
        return False
    await page.wait_for_timeout(800)
    detail = await frame.evaluate("""() => {
        for (const b of document.querySelectorAll('button, input[type=button], a')) {
            const v = (b.textContent || b.value || '').replace(/\\s+/g, '');
            if (v.includes('查看报销单明细')) { b.click(); return 'ok'; }
        }
        return 'no-btn';
    }""")
    if detail != "ok":
        log(f"[bill-open] {label}无「查看报销单明细信息」按钮: {detail}")
        return False
    await dismiss_continue_dialog(page)
    log(f"[bill-open] 单据 {bill} 已打开（{label}）；关闭窗口即回收")
    return True


async def open_in_yb6(page, bill: str, preferred: str = "") -> bool:
    """老系统 WF_YB6：按映射视图直取（preferred），未命中再试另一个视图。"""
    order = []
    if preferred == "YB6-报销单管理":
        order = [("报销单管理", open_yb6_inflight), ("历史报销单", open_yb6_history)]
    elif preferred == "YB6-历史报销单":
        order = [("历史报销单", open_yb6_history), ("报销单管理", open_yb6_inflight)]
    else:
        order = [("报销单管理", open_yb6_inflight), ("历史报销单", open_yb6_history)]
    for label, opener in order:
        if await opener(page, bill):
            return True
    return False


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bill", required=True, help="7 位报销单号")
    bill = parser.parse_args().bill
    log(f"[bill-open] 开始打开报销单 {bill}")

    # 开单系统与当前位置来自票据簿模型（登记时写入 / 轮询按命中数据面刷新）；无记录时 YBX→YB6 顺序试错。
    system = ""
    view = ""
    try:
        model = json.loads((ROOT / "data" / "reimbursement-model.json").read_text())
        for entry in model.get("sets", []):
            for record in entry.get("treasuryBills") or []:
                if record.get("billNo") == bill:
                    system = record.get("system") or system
                    view = record.get("view") or view
                    if system and view:
                        break
            if system and view:
                break
    except (OSError, ValueError) as exc:
        log(f"[bill-open] 读取模型失败（将按 YBX→YB6 试错）: {str(exc)[:80]}")
    log(f"[bill-open] 开单系统: {system or '未知（试错）'} | 当前视图: {view or '未知'}")

    browser = None
    try:
        async with async_playwright() as p:
            browser = await launch_chromium(p, channel="chrome", headless=False)
            context = await browser.new_context(storage_state=str(SESSION_PATH) if SESSION_PATH.exists() else None)
            page = await context.new_page()
            await page.goto(HOME_URL, wait_until="domcontentloaded")
            await page.wait_for_timeout(3000)
            if "sso.ecnu.edu.cn" in page.url:
                try:
                    await ensure_login(context, page)
                    log("[bill-open] SSO 自动登录成功")
                except SystemExit:
                    log("[bill-open] SSO 自动登录失败，等待人工在窗口内登录（最多 120s）")
                    for _ in range(60):
                        await page.wait_for_timeout(2000)
                        if "sso.ecnu.edu.cn" not in page.url:
                            break
                    else:
                        log("[bill-open] 人工登录超时，退出")
                        return
            if view and view != "YBX-全部报销单":
                # 映射直取：YB6 视图按当前所在视图优先。
                opened = await open_in_yb6(page, bill, preferred=view)
                if not opened:
                    opened = await open_in_ybx(context, page, bill)
            else:
                opened = await open_in_ybx(context, page, bill)
                if not opened and (view == "YB6-报销单管理" or view == "YB6-历史报销单" or system == "YB6"):
                    log("[bill-open] 回退 WF_YB6 老系统视图...")
                    opened = await open_in_yb6(page, bill, preferred=view)
            if not opened:
                log(f"[bill-open] 所有视图均未找到单号 {bill}；窗口保持打开（5 分钟超时），请人工查看")
            # 窗口关闭即回收：macOS 关窗不退进程，轮询 context.pages 直到用户关掉所有窗口。
            # 另有 5 分钟无操作兜底；脚本被 SIGTERM（新单顶掉旧窗）时走 finally 关闭。
            terminated = asyncio.Event()
            loop = asyncio.get_event_loop()
            for sig in ("SIGTERM", "SIGINT"):
                try:
                    loop.add_signal_handler(getattr(signal, sig), terminated.set)
                except (NotImplementedError, AttributeError):
                    pass
            idle_seconds = 0
            while browser.is_connected() and context.pages:
                if terminated.is_set():
                    log("[bill-open] 收到终止信号（新单顶掉旧窗口），关闭")
                    return
                await asyncio.sleep(2)
                idle_seconds += 2
                if idle_seconds >= 300:
                    log("[bill-open] 5 分钟无操作超时，自动关闭")
                    return
            log("[bill-open] 窗口已由用户关闭，回收浏览器")
    finally:
        # 任何路径退出都关闭浏览器，杜绝 Dock 残留图标。
        if browser is not None and browser.is_connected():
            try:
                await browser.close()
            except Exception:
                pass
        log("[bill-open] 浏览器已关闭，脚本退出")


if __name__ == "__main__":
    asyncio.run(main())
