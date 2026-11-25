#!/usr/bin/env python3
"""ECNU 工资数据增量抓取，写入 data/df/salary-YYYY.json（观自在系统 DF 计算数据源）。

自原 DF/fetch_salary.py 移植（2026-09 DF 集成进系统，原目录已删除），登录复用 tools/ecnu_treasury.py。
增量语义：请求月份中已有数据的自动跳过（--force 重爬），每月爬到即写盘，中断不丢。

用法:
  python tools/fetch_salary.py --months 2026-07,2026-08,2026-09
  python tools/fetch_salary.py --since 2026-07        # 补齐 2026-07 → 当前月
  python tools/fetch_salary.py --since 2026-07 --force

stdout 输出 JSON 行进度（供观自在 /api/df-refresh 展示）:
  {"month":"2026-07","status":"skipped"|"fetched"|"empty"|"failed"|"future",...}
  {"done":true,"fetched":N,"skipped":N,"empty":N,"failed":N,"future":N}

未来发薪月（晚于当前月）一律跳过（status=future）：财务系统对未来月的查询
会残留当前工资单数据，照单全收会把假数据写盘（2026-10 曾把 10 月数据当成 11/12 月存入）。
"""

import argparse
import asyncio
import json
import time
from datetime import datetime
from pathlib import Path

from ecnu_treasury import (
    DEBUG_DIR,
    STORAGE_PATH,
    ensure_logged_in,
    get_credentials,
    sso_login,
)
from playwright.async_api import async_playwright

from receipt_runtime import DATA_ROOT, launch_chromium

ROOT = DATA_ROOT
DATA_DIR = ROOT / 'data' / 'df'

# 字段名映射（页面显示名 → 标准名）
FIELD_MAPPING = {
    '扣职业年金': '职业年金',
}


def salary_file(year: int) -> Path:
    return DATA_DIR / f'salary-{year}.json'


def load_year(year: int) -> dict:
    path = salary_file(year)
    if path.exists():
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except Exception:
            pass
    return {'year': year, 'months': {}}


def save_year(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data['updatedAt'] = datetime.now().isoformat(timespec='seconds')
    salary_file(data['year']).write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


async def wait_until(predicate, timeout_s: float = 15.0, interval_s: float = 0.25) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        result = predicate()
        if asyncio.iscoroutine(result):
            result = await result
        if result:
            return True
        await asyncio.sleep(interval_s)
    return False


def _find_content_frame(page):
    """在页面所有 frame 中找到 mainForManager 内容 frame"""
    for f in page.frames:
        if 'mainForManager' in f.url:
            return f
    return None


async def _navigate_to_salary_query(page):
    """导航到 财务查询 -> 我的收入查询 -> 个人工资查询，返回内容 frame。

    老系统菜单渲染/绑定慢：采用「点击+检查合并轮询」——
    子菜单「个人工资查询」已出现就点它，否则先点父菜单「我的收入查询」展开，
    直到查询表单（>=3 个 select）加载完成。
    """
    await page.evaluate('''() => {
        var links = document.querySelectorAll('a');
        for (var a of links) {
            if (a.textContent.trim() === '财务查询' && a.href && a.href.includes('navToPrj')) {
                a.click(); return;
            }
        }
    }''')

    frame_ready = await wait_until(lambda: _find_content_frame(page) is not None)
    if not frame_ready:
        raise RuntimeError('未找到内容 frame (mainForManager)')
    cf = _find_content_frame(page)
    assert cf is not None

    async def click_and_check() -> bool:
        try:
            await cf.evaluate('''() => {
                var links = document.querySelectorAll('a');
                for (var a of links) {
                    if (a.textContent.includes('个人工资查询')) { a.click(); return; }
                }
                for (var a of links) {
                    if (a.textContent.includes('我的收入查询')) { a.click(); return; }
                }
            }''')
        except Exception:
            pass
        return await _form_loaded(cf)
    if not await wait_until(click_and_check, timeout_s=25):
        raise RuntimeError('工资查询表单加载超时（我的收入查询 -> 个人工资查询）')

    return cf


async def _form_loaded(cf) -> bool:
    try:
        return await cf.locator('select').count() >= 3
    except Exception:
        return False


async def _query_salary(content_frame, page, year: int, month: int) -> None:
    """在工资查询表单中设置年月并点击汇总查询"""
    await content_frame.locator('select[name*="d-year"]').select_option(label=f'{year}年')
    await content_frame.locator('select[name*="d-month_1"]').select_option(label=f'{month}月')
    await content_frame.locator('select[name*="d-month_2"]').select_option(label=f'{month}月')

    await content_frame.evaluate('''() => {
        var candidates = document.querySelectorAll('a, button');
        for (var el of candidates) {
            if (el.textContent.trim() === '汇总查询' && el.offsetParent !== null) {
                el.click(); return;
            }
        }
    }''')


async def _extract_salary_data(content_frame) -> dict:
    """从 jqgrid 表格中提取工资数据"""
    return await content_frame.evaluate(r'''() => {
        var data = {};
        var tables = document.querySelectorAll('table.ui-jqgrid-btable');
        for (var t = 0; t < tables.length; t++) {
            var rows = tables[t].querySelectorAll('tbody tr[role="row"]');
            for (var r = 0; r < rows.length; r++) {
                var cells = rows[r].querySelectorAll('td[role="gridcell"]');
                if (cells.length < 2) continue;
                var key = cells[0].textContent.trim();
                var val = cells[1].textContent.trim();
                if (key && val) {
                    var num = parseFloat(val.replace(/,/g, ''));
                    if (!isNaN(num)) data[key] = num;
                }
            }
        }
        return data;
    }''')


async def fetch_months(months: list[tuple[int, int]], force: bool = False) -> None:
    username, password = get_credentials()

    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=True)
        context = await browser.new_context(
            storage_state=str(STORAGE_PATH) if STORAGE_PATH.exists() else None)
        page = await context.new_page()

        if not await ensure_logged_in(page):
            await browser.close()
            raise SystemExit(1)

        print('导航到个人工资查询...', flush=True)
        cf = await _navigate_to_salary_query(page)
        if not await wait_until(lambda: _form_loaded(cf)):
            debug_path = DEBUG_DIR / 'debug_form.png'
            await page.screenshot(path=str(debug_path), full_page=True)
            await browser.close()
            raise RuntimeError(f'工资查询表单未加载（调试截图: {debug_path}）')

        stats = {'fetched': 0, 'skipped': 0, 'empty': 0, 'failed': 0, 'future': 0}
        today = datetime.now()
        for year, month in months:
            month_key = f'{year}-{month:02d}'
            if (year, month) > (today.year, today.month):
                # 未来发薪月工资单不存在：财务系统对未来月的查询会残留当前数据，绝不能入库
                stats['future'] += 1
                emit({'month': month_key, 'status': 'future'})
                continue

            store = load_year(year)
            if not force and store['months'].get(str(month)):
                stats['skipped'] += 1
                emit({'month': month_key, 'status': 'skipped'})
                continue

            try:
                await _query_salary(cf, page, year, month)

                # 等待结果表格出现非空数据（老系统渲染慢；超时按空数据处理）
                async def has_data() -> bool:
                    try:
                        return bool(await _extract_salary_data(cf))
                    except Exception:
                        return False
                got = await wait_until(has_data, timeout_s=15)
                data = await _extract_salary_data(cf) if got else {}

                if not data:
                    # 未发工资的月份查询结果为空：记录但不算失败
                    stats['empty'] += 1
                    emit({'month': month_key, 'status': 'empty'})
                    continue

                mapped = {FIELD_MAPPING.get(k, k): v for k, v in data.items()}
                store['months'][str(month)] = mapped
                save_year(store)
                stats['fetched'] += 1
                emit({'month': month_key, 'status': 'fetched', 'fields': len(mapped)})
            except Exception as error:
                stats['failed'] += 1
                emit({'month': month_key, 'status': 'failed', 'error': str(error)[:200]})

        await context.storage_state(path=str(STORAGE_PATH))
        await browser.close()

    emit({'done': True, **stats})


def parse_month_key(key: str) -> tuple[int, int]:
    parts = key.strip().split('-')
    if len(parts) != 2:
        raise ValueError(f'月份格式应为 YYYY-MM: {key}')
    year, month = int(parts[0]), int(parts[1])
    if not 1 <= month <= 12:
        raise ValueError(f'月份越界: {key}')
    return year, month


def main():
    today = datetime.now()
    parser = argparse.ArgumentParser(description='ECNU 工资数据增量抓取')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--months', help='逗号分隔的月份列表，如 2026-07,2026-08')
    group.add_argument('--since', help='补齐起始月（含）到当前月，如 2026-07')
    parser.add_argument('--force', action='store_true', help='已有数据的月份也重新抓取')
    args = parser.parse_args()

    if args.months:
        months = [parse_month_key(part) for part in args.months.split(',') if part.strip()]
    else:
        start_year, start_month = parse_month_key(args.since)
        months = []
        year, month = start_year, start_month
        while (year, month) <= (today.year, today.month):
            months.append((year, month))
            month += 1
            if month > 12:
                year, month = year + 1, 1

    asyncio.run(fetch_months(months, force=args.force))


if __name__ == '__main__':
    main()
