#!/usr/bin/env python3
"""发票识别状态查询（只读，不删除任何条目）。
抓取：池提示条（识别中数量）→ 「点击查看明细」出错/状态明细表 → 全部条目（文件/时间/状态/错误信息）
→ 从错误信息解析占用预约单号（blockedBy）→ 草稿箱日常报销单（占用方）。
输出 JSON：invoice-queue-status。vite /api/invoice-queue-status 直接 spawn 本脚本。"""
import asyncio, json, os, re, sys, time

from receipt_runtime import DATA_ROOT, launch_chromium, school_session

ROOT = str(DATA_ROOT)
from playwright.async_api import async_playwright

SESSION = school_session("treasury")
CLOSE_JS = """() => { let n = 0; for (const d of document.querySelectorAll('.ui-dialog')) { if (d.offsetParent !== null) { const c = d.querySelector('.ui-dialog-titlebar-close'); if (c) { c.click(); n++; } } } return n; }"""


async def main():
    out = {"identifying": 0, "queue": [], "poolCount": None, "drafts": [], "error": None}
    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=True)
        ctx = await browser.new_context(storage_state=str(SESSION) if SESSION.exists() else None, viewport={'width': 1600, 'height': 1000})
        page = await ctx.new_page()
        page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
        await page.goto('https://treasury.ecnu.edu.cn/WFManager/home2.jsp', wait_until='domcontentloaded')
        await page.wait_for_timeout(5000)
        if '预约报销' not in (await page.evaluate('() => document.body.innerText')):
            out['error'] = '登录态失效'
            print(json.dumps(out, ensure_ascii=False))
            await browser.close()
            return
        async with ctx.expect_page(timeout=15000) as pi:
            await page.evaluate("""() => { const a = Array.from(document.querySelectorAll('a'))
                .find(a => a.textContent.trim() === '智能报销' && (a.href || '').includes('navToPrj')); if (a) a.click(); }""")
        ybx = await pi.value
        await ybx.wait_for_load_state('domcontentloaded')
        deadline = time.time() + 40
        while time.time() < deadline:
            inner = await ybx.evaluate('() => document.body.innerText')
            if any(k in inner for k in ('草稿', '申请报销', '我的发票')):
                break
            await ybx.wait_for_timeout(1500)
        for _ in range(8):
            if not await ybx.evaluate(CLOSE_JS):
                break
            await ybx.wait_for_timeout(500)

        # ① 进发票池视图（提示条「N张发票正在识别中」显示在这里；OCR 不过不进池——池行数是 OCR 通过数）
        r = await ybx.evaluate("""() => { let el = document.getElementById('resultBX_02_2__title'); if (!el) return 'nf'; const o = { bubbles: true, cancelable: true, view: window }; el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o)); return 'ok'; }""")
        await ybx.wait_for_timeout(5000)
        await ybx.evaluate(CLOSE_JS)
        tip = await ybx.evaluate("() => { const m = (document.body.innerText || '').match(/(\\d+)张发票正在识别中/); return m ? +m[1] : 0; }")
        out['identifying'] = tip
        out['poolCount'] = await ybx.evaluate("""() => { const g = document.getElementById('gridWF_YBX_53'); return g ? jQuery(g).jqGrid('getDataIDs').length : null; }""")

        # ② OCR 出错明细表：提示条存在时点「点击查看明细」；表格可能在任意 frame
        rows = []
        if tip:
            await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span')).filter(e => e.offsetParent !== null && (e.textContent || '').includes('点击查看明细')); if (els.length) els[els.length - 1].click(); }""")
            await ybx.wait_for_timeout(5000)
        if tip and '--clean' in sys.argv:
            # 清理模式：只批量删除「识别出错」条目（重复副本垃圾），不碰发票池合法发票
            cleaned_total = 0
            for _round in range(6):
                sel_n = 'no-rows'
                for f in ybx.frames:
                    try:
                        sel_n = await asyncio.wait_for(f.evaluate("""() => {
                            const tr = Array.from(document.querySelectorAll('tr')).find((t) => (t.innerText || '').includes('识别出错') && t.closest('.ui-jqgrid-btable'));
                            if (!tr) return 'no-rows';
                            const gid = tr.closest('.ui-jqgrid-btable').id;
                            const ids = jQuery('#' + gid).jqGrid('getDataIDs');
                            let n = 0;
                            for (const rid of ids) {
                                const trEl = document.getElementById(rid);
                                if (trEl && (trEl.innerText || '').includes('识别出错')) { jQuery('#' + gid).jqGrid('setSelection', rid); n += 1; }
                            }
                            return n;
                        }"""), 5)
                        if sel_n != 'no-rows' and sel_n != 0:
                            break
                    except Exception:
                        pass
                if sel_n == 'no-rows' or sel_n == 0:
                    break
                for f in ybx.frames:
                    try:
                        await asyncio.wait_for(f.evaluate("""() => {
                            const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '批量删除');
                            if (b) { b.click(); return 'ok'; }
                            return 'nf';
                        }"""), 5)
                        break
                    except Exception:
                        pass
                await ybx.wait_for_timeout(2000)
                await ybx.evaluate("""() => {
                    for (const d of document.querySelectorAll('.ui-dialog')) {
                        if (d.offsetParent === null) continue;
                        const btn = Array.from(d.querySelectorAll('button, a, input[type=button]')).find((e) => /^(继续|确定|确认|是)$/.test((e.textContent || e.value || '').replace(/\\s/g, '')));
                        if (btn) btn.click();
                    }
                }""")
                await ybx.wait_for_timeout(3000)
                await ybx.evaluate(CLOSE_JS)
                cleaned_total += int(sel_n or 0)
            out['cleaned'] = cleaned_total
            tip_after = await ybx.evaluate("() => { const m = (document.body.innerText || '').match(/(\\d+)张发票正在识别中/); return m ? +m[1] : 0; }")
            out['identifyingAfterClean'] = tip_after
        detail_js = """() => {
            const rows = [];
            for (const tr of document.querySelectorAll('tr')) {
                const t = (tr.innerText || '').replace(/\\s+/g, ' ').trim();
                if (!t || t.length < 12) continue;
                const isHeader = /序号.*图片名称|上传.*时间/.test(t) && t.length < 80;
                const hasFile = /\\.pdf|\\.jpe?g|\\.png/i.test(t);
                const hasState = /识别出错|识别中|识别成功|待识别/.test(t);
                if (hasFile || isHeader) rows.push(t.slice(0, 500));
            }
            return rows;
        }"""
        for f in ybx.frames:
            try:
                rr = await asyncio.wait_for(f.evaluate(detail_js), 5)
                if rr:
                    rows = rr
                    break
            except Exception:
                pass
        for t in rows:
            if re.match(r'^序号', t):
                continue
            entry = {"raw": t[:300], "file": None, "uploadedAt": None, "state": None, "blockedBy": None}
            fm = re.search(r'[\u4e00-\u9fa5A-Za-z0-9_\-/]*\.(?:pdf|jpe?g|png)', t, re.I)
            if fm:
                entry['file'] = fm.group(0).split(' ')[-1]
            tm = re.search(r'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|\d{2}-\d{2} : \d{2}', t)
            if tm:
                entry['uploadedAt'] = tm.group(0)
            sm = re.search(r'(识别出错|识别中|识别成功|待识别)', t)
            if sm:
                entry['state'] = sm.group(1)
            bm = re.search(r'预约单号[：:]\s*(\d{7})', t)
            if bm:
                entry['blockedBy'] = bm.group(1)
            out['queue'].append(entry)

        # ③ 草稿箱日常报销单（占用方）
        await ybx.evaluate("""() => { const b = Array.from(document.querySelectorAll('button, a')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '返回'); if (b) b.click(); }""")
        await ybx.wait_for_timeout(3000)
        await ybx.evaluate(CLOSE_JS)
        await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (els.length) els[0].click(); }""")
        await ybx.wait_for_timeout(6000)
        await ybx.evaluate(CLOSE_JS)
        out['drafts'] = await ybx.evaluate("""() => {
            const rows = [];
            for (const tr of document.querySelectorAll('tr[id]')) {
                const t = (tr.textContent || '').replace(/\\s+/g, ' ').trim();
                const m = t.match(/(\\d{7})日常报销/);
                if (m && /草稿/.test(t)) rows.push({ billNo: m[1], text: t.slice(0, 120) });
            }
            return rows;
        }""")
        await browser.close()
    print(json.dumps(out, ensure_ascii=False))


asyncio.run(main())
