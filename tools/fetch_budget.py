#!/usr/bin/env python3
"""从 ECNU 财务系统拉取项目预算表，存本地 JSON。

路径: 财务系统 -> 项目管理 -> 项目查询 -> 选中项目 -> 预算表（含子项目）
数据: data/budgets/<项目号>.json（预算项代码/名称/控制方式/预算数/支出数/冻结数/余额/执行率）

用法:
  python tools/fetch_budget.py                  # 抓所有非间接费项目
  python tools/fetch_budget.py --project 示例项目 # 只抓项目号含该关键字的项目
"""

import argparse
import asyncio
import json
import re
from datetime import datetime
from pathlib import Path

from receipt_runtime import DATA_ROOT, launch_chromium

ROOT = DATA_ROOT
from ecnu_treasury import STORAGE_PATH, get_credentials, auto_login_and_save  # noqa: E402

from playwright.async_api import async_playwright  # noqa: E402

TREASURY = 'https://treasury.ecnu.edu.cn/WFManager/home2.jsp'
OUTPUT_DIR = ROOT / 'data' / 'budgets'

# 智能等待：条件满足立即继续，仅保留超时上限（老系统 frame 加载慢但不该盲等）
import time

async def wait_until(predicate, timeout_s: float = 15.0, interval_s: float = 0.25) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if await predicate():
            return True
        await asyncio.sleep(interval_s)
    return False


async def wait_for_module_frame(page):
    # 「项目管理」navToPrj 是 window.open 弹新窗口——WF_CA_NEW 在 popup page 里，必须跨 context 全部 pages 找
    async def has_frame():
        return any('WF_CA_NEW' in f.url for pg in page.context.pages for f in pg.frames)
    await wait_until(has_frame)
    for pg in page.context.pages:
        for f in pg.frames:
            if 'WF_CA_NEW' in f.url:
                return f
    raise RuntimeError('未找到项目管理模块 frame (WF_CA_NEW)')


def parse_amount(text: str) -> float | None:
    """'300,000.00' -> 300000.0；'-' 或空 -> None"""
    text = text.strip().replace(',', '')
    if not text or text in {'-', '--'}:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def parse_rate(text: str) -> float | None:
    """'55.37%' -> 0.5537"""
    text = text.strip()
    if text.endswith('%'):
        try:
            return round(float(text[:-1]) / 100, 6)
        except ValueError:
            return None
    return None


async def login(page):
    """确保已登录（session 失效则用 Keychain 凭证重登）。"""
    await page.goto(TREASURY, wait_until='domcontentloaded')
    if 'login' in page.url or 'sso' in page.url.lower():
        user, pwd = get_credentials()
        await auto_login_and_save(user, pwd)
        return True  # context 需要重建
    return False


async def budget_grid_ready(frame) -> bool:
    try:
        return await frame.evaluate(r"""() => {
            for (const t of document.querySelectorAll('table')) {
                if (t.rows.length >= 2 && /^[A-Z]\d{2,}$/.test((t.rows[1].cells[0]?.textContent || '').trim())) return true;
            }
            return false;
        }""")
    except Exception:
        return False


async def list_projects_ready(frame) -> bool:
    try:
        return await frame.evaluate(r"""() => {
            for (const t of document.querySelectorAll('table')) {
                if (t.rows.length >= 2 && /^\d{5}-\d{6}-\d{5}/.test((t.rows[1].cells[0]?.textContent || '').trim())) return true;
            }
            return false;
        }""")
    except Exception:
        return False


async def open_project_list(page):
    """导航到 项目管理 -> 项目查询，返回内容 frame。"""
    await page.evaluate("""() => { const a = Array.from(document.querySelectorAll('a'))
        .find(a => a.textContent.trim() === '项目管理' && (a.href || '').includes('navToPrj'));
        if (a) a.click(); }""")
    frame = await wait_for_module_frame(page)
    # frame 就绪时机不稳定：点击与检测合并轮询，直到列表出现
    async def click_and_check():
        try:
            await frame.evaluate("""() => { const a = Array.from(document.querySelectorAll('a'))
                .find(a => a.textContent.trim() === '项目查询');
                if (a) a.click(); }""")
        except Exception:
            pass
        return await list_projects_ready(frame)
    if not await wait_until(click_and_check):
        raise RuntimeError('项目列表加载超时')
    return frame


async def list_project_rows(frame):
    """读取项目列表：[{projectId, projectName, isIndirect, fields}]，fields 为项目列表页全部表头字段。"""
    raw = await frame.evaluate(r"""() => {
        const tables = Array.from(document.querySelectorAll('table'));
        let head = [], headTable = null, dataTable = null;
        for (const t of tables) {
            if (!t.rows.length) continue;
            const h = Array.from(t.rows[0].cells).map(c => c.textContent.trim());
            if (h.includes('项目号') && h.includes('负责人')) { headTable = t; head = h; }
            if (t.rows.length >= 2 && /^\d{5}-\d{6}-\d{5}/.test((t.rows[1].cells[0]?.textContent || '').trim())) dataTable = t;
        }
        const rows = dataTable ? Array.from(dataTable.rows).map(r => Array.from(r.cells).map(c => c.textContent.trim())) : [];
        return { head, rows };
    }""")
    projects = []
    for cells in raw['rows']:
        fields = {}
        for key, value in zip(raw['head'], cells):
            value = value.strip()
            if value and not fields.get(key):
                fields[key] = value
        project_id = fields.get('项目号', '').strip()
        if not project_id:
            continue
        name = fields.get('项目名称', '')
        info = {k: fields[k].strip() for k in ('负责人', '负责人工号', '所属部门', '项目类别', '科研类型', '经费类型', '项目来源', '归口管理部门', '有效期') if fields.get(k, '').strip()}
        projects.append({'projectId': project_id, 'projectName': name, 'isIndirect': name.startswith('间接费'), 'fields': info})
    return projects


async def select_project(frame, project_id: str):
    """点击项目行单元格选中。

    列表刚渲染时行点击 handler 可能尚未绑定（老系统 jQuery 延迟绑定），
    先缓冲再点击，否则会出现"请先选择记录"弹窗且后续流程全部卡死。
    """
    await page_wait(frame, 2000)
    ok = await frame.evaluate(r"""(pid) => {
        for (const td of document.querySelectorAll('td')) {
            if (td.children.length === 0 && td.textContent.trim() === pid) { td.click(); return true; }
        }
        return false;
    }""", project_id)
    if not ok:
        raise RuntimeError(f'未找到项目行: {project_id}')
    await page_wait(frame, 500)


async def page_wait(frame, ms: int):
    await frame.page.wait_for_timeout(ms)


async def open_budget_table(frame, project_id: str):
    """点击 预算表（含子项目）并等待表格渲染。

    老系统坑：列表刚渲染时行点击 handler 可能未绑定，选中失败会弹"请先选择记录"。
    轮询中若发现该弹窗则点确认关闭，重新选中行后再点按钮。
    """
    async def click_and_check():
        # 关闭可能的"请先选择记录"弹窗
        try:
            await frame.evaluate("""() => { const b = Array.from(document.querySelectorAll('button'))
                .find(b => b.textContent.trim() === '确认');
                if (b) b.click(); }""")
        except Exception:
            pass
        # 重新选中项目行（handler 可能首轮未绑定）
        try:
            await frame.evaluate("""(pid) => { for (const td of document.querySelectorAll('td')) {
                if (td.children.length === 0 && td.textContent.trim() === pid) { td.click(); break; } } }""", project_id)
        except Exception:
            pass
        await asyncio.sleep(0.2)
        try:
            await frame.evaluate(r"""() => { const b = Array.from(document.querySelectorAll('button'))
                .find(b => b.textContent.includes('预算表（含子项目）'));
                if (b) b.click(); }""")
        except Exception:
            pass
        return await budget_grid_ready(frame)
    if not await wait_until(click_and_check):
        raise RuntimeError('预算表加载超时（含选中重试）')


async def scrape_budget_table(frame) -> dict:
    """在当前 frame 树中找预算表并解析。"""
    page = frame.page
    for f in page.frames:
        try:
            data = await f.evaluate(r"""() => {
                const tables = Array.from(document.querySelectorAll('table'));
                // 老系统 grid 拆两张表：纯表头表 + 纯数据表，列序一致
                const headTable = tables.find(t => t.rows.length && Array.from(t.rows[0].cells).some(c => c.textContent.trim() === '预算项代码'));
                const dataTable = tables.find(t => t.rows.length >= 2 && /^[A-Z]\d+$/.test((t.rows[1].cells[0]?.textContent || '').trim()));
                if (!headTable && !dataTable) return null;
                const head = headTable ? Array.from(headTable.rows[0].cells).map(c => c.textContent.trim()) : [];
                const bodyRows = dataTable ? Array.from(dataTable.rows).map(r => Array.from(r.cells).map(c => c.textContent.trim())) : [];
                const idx = (label) => head.findIndex(h => h.includes(label));
                return {
                    head,
                    iCode: idx('预算项代码'), iName: idx('预算项名称'), iCtrl: idx('控制方式'),
                    iBudget: idx('预算/收入数'), iSpent: idx('支出数'), iFrozen: idx('冻结数'),
                    iBalance: idx('余额'), iRate: idx('执行率'),
                    title: (document.body.innerText.match(/项目【([^】]+)】/) || [])[1] || '',
                    rows: bodyRows,
                };
            }""")
            if data:
                return data
        except Exception:
            continue
    raise RuntimeError('未找到预算表')


def normalize_budget(raw: dict, project_id: str, project_info: dict | None = None) -> dict:
    name_part = raw.get('title', '')
    # 系统标题形如 "项目【<经费卡号>-项目名称】"：剥掉完整项目号前缀得到纯项目名
    prefix = f"{project_id}-"
    project_name = name_part[len(prefix):].strip() if name_part.startswith(prefix) else name_part
    rows = []
    for cells in raw['rows']:
        def cell(i):
            return cells[i].strip() if 0 <= i < len(cells) else ''
        code = cell(raw['iCode'])
        if not re.fullmatch(r'[A-Z]\d{2,}', code):
            continue
        rows.append({
            'code': code,
            'name': cell(raw['iName']),
            'control': cell(raw['iCtrl']),
            'budget': parse_amount(cell(raw['iBudget'])),
            'spent': parse_amount(cell(raw['iSpent'])),
            'frozen': parse_amount(cell(raw['iFrozen'])),
            'balance': parse_amount(cell(raw['iBalance'])),
            'executionRate': parse_rate(cell(raw['iRate'])),
        })
    delivery_config_path = OUTPUT_DIR / f"{project_id}.json"
    preserved_cfg = {}
    try:
        if delivery_config_path.exists():
            preserved_cfg = json.loads(delivery_config_path.read_text(encoding='utf-8')).get('deliveryConfig', {})
    except Exception:
        preserved_cfg = {}
    return {
        'projectId': project_id,
        'projectName': project_name,
        'projectInfo': project_info or {},
        'deliveryConfig': preserved_cfg or {
            '投递校区': '普陀校区',
            '委托财务打印': True,
            '协同审批人': None,
        },
        'fetchedAt': datetime.now().isoformat(timespec='seconds'),
        'rows': rows,
    }


async def fetch_all(only_keyword: str = '') -> list[dict]:
    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=True)
        ctx = await browser.new_context(storage_state=str(STORAGE_PATH) if STORAGE_PATH.exists() else None)
        page = await ctx.new_page()
        if await login(page):
            await browser.close()
            browser = await launch_chromium(p, headless=True)
            ctx = await browser.new_context(storage_state=str(STORAGE_PATH))
            page = await ctx.new_page()
            await page.goto(TREASURY, wait_until='domcontentloaded')

        frame = await open_project_list(page)
        projects = await list_project_rows(frame)
        print(f'项目列表 {len(projects)} 条')
        targets = [pr for pr in projects
                   if (not only_keyword or only_keyword in pr['projectId'])
                   and not pr['isIndirect']]
        if not targets:
            print('没有匹配的项目（间接费项目自动跳过）')
            await browser.close()
            return []

        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        results = []
        for pr in targets:
            print(f"抓取 {pr['projectId']} {pr['projectName']} …")
            await select_project(frame, pr['projectId'])
            await open_budget_table(frame, pr['projectId'])
            raw = await scrape_budget_table(frame)
            budget = normalize_budget(raw, pr['projectId'], pr.get('fields', {}))
            out = OUTPUT_DIR / f"{pr['projectId']}.json"
            out.write_text(json.dumps(budget, ensure_ascii=False, indent=2) + '\n')
            print(f"  -> {out} ({len(budget['rows'])} 个预算项)")
            results.append(budget)
            if len(targets) > 1:
                await back_to_list(frame)
        await browser.close()
        return results


def friendly_error(err: BaseException) -> str:
    """playwright 堆栈转人话——面板/trace 里可读，能自己判断要不要重试。"""
    text = str(err)
    if 'Timeout 30000ms' in text or 'TimeoutError' in type(err).__name__:
        return '财务系统页面加载超时（老系统偶发缓慢或维护中）——已自动重试一次，仍失败请稍后再试'
    if 'sso' in text.lower() or 'login' in text.lower():
        return '财务系统登录失败——SSO 凭证或登录流程异常，请检查 Keychain 凭证'
    if '未找到项目管理模块' in text:
        return '财务系统页面结构变化（未找到项目管理模块）——需要更新脚本适配'
    if '项目列表加载超时' in text:
        return '项目列表加载超时（老系统偶发缓慢）——已自动重试一次，仍失败请稍后再试'
    return f'预算拉取失败：{text[:120]}'


def main():
    parser = argparse.ArgumentParser(description='拉取 ECNU 项目预算表')
    parser.add_argument('--project', default='', help='项目号关键字过滤')
    args = parser.parse_args()
    last_err: BaseException | None = None
    for attempt in (1, 2):
        try:
            asyncio.run(fetch_all(args.project))
            return
        except Exception as err:  # noqa: BLE001 —— 顶层兜底：转人话 + 自动重试
            last_err = err
            if attempt == 1:
                print(f'[budget] 第 1 次拉取失败（{str(err)[:80]}），自动重试 …', flush=True)
    print(f'[budget] FAIL: {friendly_error(last_err)}', file=__import__('sys').stderr, flush=True)
    raise SystemExit(1)


if __name__ == '__main__':
    main()
