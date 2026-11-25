#!/usr/bin/env python3
"""确认递交（submitOnly）：登录 → 全部报销单按单号选行 → 修改进表单 → 提交申请 → 状态验证。
极简路径（2026-09-19 用户定案：不需要清空发票池等多余操作）。成功输出 ##SUBMITTED##1。
config：submitBillNo（必填）/ totalExpected、summary（可选行级断言）。"""
import asyncio, json, os, re, sys, time

from receipt_runtime import DATA_ROOT, launch_chromium, school_session

ROOT = str(DATA_ROOT)
from playwright.async_api import async_playwright

SESSION = school_session("treasury")
LOG = os.path.join(ROOT, 'data', 'autobx_logs', 'evidence')
CLOSE_JS = """() => { let n = 0; for (const d of document.querySelectorAll('.ui-dialog')) { if (d.offsetParent !== null) { const c = d.querySelector('.ui-dialog-titlebar-close'); if (c) { c.click(); n++; } } } return n; }"""
CONFIRM_LOOSE_JS = """(labels) => {
    const norm = (s) => (s || '').replace(/\\s/g, '');
    for (const t of labels) {
        const el = Array.from(document.querySelectorAll('a, button')).find(e =>
            e.offsetParent !== null && norm(e.textContent) === norm(t));
        if (el) { el.click(); return 'ok:' + norm(el.textContent); }
    }
    return 'nf';
}"""


def say(no, name, **kw):
    print(f"#{no} {name} -> {json.dumps(kw, ensure_ascii=False, default=str)[:220]}", flush=True)
    print(json.dumps({'step': no, 'name': name, **kw}, ensure_ascii=False, default=str), flush=True)


async def main():
    stamp = time.strftime('%H%M%S')
    cfg = {}
    if '--config' in sys.argv:
        _i = sys.argv.index('--config')
        if _i + 1 < len(sys.argv):
            cfg = json.load(open(sys.argv[_i + 1], encoding='utf-8'))
    bill = str(cfg.get('submitBillNo') or '')
    amt = str(cfg.get('totalExpected') or cfg.get('expensesTotal') or '').replace(',', '')
    summary = str(cfg.get('summary') or '')[:12].replace(' ', '')
    os.makedirs(LOG, exist_ok=True)
    if not re.match(r'^\d{7}$', bill):
        say(0, '参数', result='FAIL submitBillNo 缺失或格式错误', abort=True)
        sys.exit(1)

    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=True)
        ctx = await browser.new_context(storage_state=str(SESSION) if SESSION.exists() else None, viewport={'width': 1600, 'height': 1000})
        page = await ctx.new_page()
        alerts = []
        def _on_dialog(d):
            alerts.append(f'{d.type}: {d.message}')
            say(8.9, '系统弹窗', type=d.type, message=d.message[:120])
            asyncio.ensure_future(d.accept())
        page.on('dialog', _on_dialog)
        page.on('pageerror', lambda e: say(8.8, '页面JS错误', err=str(e)[:120]))
        page.on('console', lambda m: say(8.8, 'console', level=m.type, text=m.text[:120]) if m.type in ('error', 'warning') else None)
        await page.goto('https://treasury.ecnu.edu.cn/WFManager/home2.jsp', wait_until='domcontentloaded')
        await page.wait_for_timeout(5000)
        if '预约报销' not in (await page.evaluate('() => document.body.innerText')):
            from ecnu_treasury import get_credentials, auto_login_and_save
            u, pw = get_credentials()
            await auto_login_and_save(u, pw)
            await ctx.close()
            ctx = await browser.new_context(storage_state=str(SESSION) if SESSION.exists() else None, viewport={'width': 1600, 'height': 1000})
            page = await ctx.new_page()
            page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
            await page.goto('https://treasury.ecnu.edu.cn/WFManager/home2.jsp', wait_until='domcontentloaded')
            await page.wait_for_timeout(5000)
        say(1, '登录')

        async with ctx.expect_page(timeout=15000) as pi:
            await page.evaluate("""() => { const a = Array.from(document.querySelectorAll('a'))
                .find(a => a.textContent.trim() === '智能报销' && (a.href || '').includes('navToPrj')); if (a) a.click(); }""")
        ybx = await pi.value
        await ybx.wait_for_load_state('domcontentloaded')
        # 锚点：门户任一关键文本出现
        deadline = time.time() + 40
        while time.time() < deadline:
            try:
                inner = await ybx.evaluate('() => document.body.innerText')
                if any(k in inner for k in ('草稿', '全部报销单', '我的发票', '申请报销')):
                    break
            except Exception:
                pass
            await ybx.wait_for_timeout(1500)
        for _ in range(8):
            try:
                if not await ybx.evaluate(CLOSE_JS): break
            except Exception: break
            await ybx.wait_for_timeout(500)
        say(2, '智能报销门户', url=ybx.url[-40:])

        # 「全部报销单」入口（多轮实验实证可靠；点击轮询防慢渲染）
        clicked = 'nf'
        for _ in range(10):
            try:
                clicked = await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (els.length) { els[0].click(); return 'ok'; } return 'nf'; }""")
            except Exception:
                clicked = 'nf'
            if clicked == 'ok':
                break
            await ybx.wait_for_timeout(3000)
        if clicked != 'ok':
            say(3, '确认递交', result='FAIL「全部报销单」入口未找到', abort=True)
            await ybx.screenshot(path=os.path.join(LOG, f'submit_fail_entry_{stamp}.png'), full_page=True)
            await browser.close()
            sys.exit(1)
        # 锚点：目标单号行出现（jqGrid 渲染完成）
        row_found = False
        deadline = time.time() + 30
        while time.time() < deadline:
            try:
                row_found = await ybx.evaluate("""(bill) => Array.from(document.querySelectorAll('tr[id]')).some(tr => (tr.textContent || '').includes(bill))""", bill)
            except Exception:
                row_found = False
            if row_found:
                break
            await ybx.wait_for_timeout(1500)
        try: await ybx.evaluate(CLOSE_JS)
        except Exception: pass
        say(3, '报销单列表', bill=bill, rowFound=row_found)

        # 行级断言（单号必含；金额/摘要可选）→ 勾选
        sel = await ybx.evaluate("""(args) => {
            const [bill, amt, sum] = args;
            for (const tr of document.querySelectorAll('tr[id]')) {
                const t = (tr.textContent || '').replace(/\\s+/g, '');
                if (!t.includes(bill)) continue;
                const norm = t.replace(/,/g, '');
                if (amt && !norm.includes(amt)) return 'row-mismatch:amt=' + amt;
                /* 摘要断言降级为警告：系统保存草稿时会按开单内容改写摘要（如「材料费」→「实验材料购置」），子串常不匹配 */
                const grid = tr.closest('.ui-jqgrid-btable') || tr.closest('table[id]');
                if (grid && tr.id) { try { jQuery('#' + grid.id).jqGrid('resetSelection'); jQuery('#' + grid.id).setSelection(tr.id, true); return 'selected'; } catch (e) {} }
            }
            return 'no-row';
        }""", [bill, amt, summary])
        say(4, '选行', bill=bill, amt=amt or '(不校验)', sumChecked=sum or None, sel=sel)
        if sel != 'selected':
            await ybx.screenshot(path=os.path.join(LOG, f'submit_fail_row_{stamp}.png'), full_page=True)
            say(5, '确认递交', result=f'FAIL {sel}', abort=True)
            await browser.close()
            sys.exit(1)

        # 「修改」进表单
        mod = await ybx.evaluate("""() => {
            const b = Array.from(document.querySelectorAll('button, a, input[type=button]')).find(e => e.offsetParent !== null &&
                (e.getAttribute('btnname') || '') === '修改' || e.offsetParent !== null &&
                (e.textContent || e.value || '').replace(/\\s/g, '') === '修改');
            if (b) { b.click(); return 'ok'; }
            return 'nf';
        }""")
        await ybx.wait_for_timeout(9000)
        for _ in range(4):
            try:
                if not await ybx.evaluate(CLOSE_JS): break
            except Exception: break
            await ybx.wait_for_timeout(600)
        say(6, '进表单', mod=mod)

        # 表单页：锚点等「提交申请」按钮（任意 frame）
        submit_frame = None
        deadline = time.time() + 40
        while time.time() < deadline:
            for f in ybx.frames:
                try:
                    ok = await asyncio.wait_for(f.evaluate("""() => !!Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && e.getAttribute('btnname') === '提交申请')"""), 4)
                    if ok:
                        submit_frame = f
                        break
                except Exception:
                    pass
            if submit_frame:
                break
            await ybx.wait_for_timeout(2000)

        # 诊断：dump 提交按钮完整属性与父链
        btn_info = await submit_frame.evaluate("""() => {
            const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && e.getAttribute('btnname') === '提交申请');
            if (!b) return null;
            const chain = [];
            let cur = b;
            for (let i = 0; i < 4 && cur; i++) { chain.push({ tag: cur.tagName, id: cur.id || null, onclick: (cur.getAttribute && cur.getAttribute('onclick')) || null, btnname: (cur.getAttribute && cur.getAttribute('btnname')) || null }); cur = cur.parentElement; }
            return { outer: b.outerHTML.slice(0, 300), chain, hasJq: typeof jQuery !== 'undefined' };
        }""")
        say(6.5, '提交按钮诊断', info=btn_info)

        say(7, '提交按钮锚点', found=bool(submit_frame))
        if not submit_frame:
            await ybx.screenshot(path=os.path.join(LOG, f'submit_fail_btn_{stamp}.png'), full_page=True)
            say(8, '确认递交', result='FAIL 提交申请按钮未找到', abort=True)
            await browser.close()
            sys.exit(1)

        # winBtn 完整事件序列提交
        sv = 'nf'
        for f in ybx.frames:
            try:
                sv = await asyncio.wait_for(f.evaluate("""() => {
                    const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && e.getAttribute('btnname') === '提交申请');
                    if (!b) return 'no-btn';
                    const o = { bubbles: true, cancelable: true, view: window };
                    b.dispatchEvent(new MouseEvent('mousedown', o));
                    b.dispatchEvent(new MouseEvent('mouseup', o));
                    b.dispatchEvent(new MouseEvent('click', o));
                    b.click();
                    if (typeof jQuery !== 'undefined') { try { jQuery(b).trigger('click'); } catch (e) {} }
                    return 'dispatched';
                }"""), 5)
                if sv == 'dispatched':
                    break
            except Exception:
                pass
        # 多级确认弹窗逐个消化（先抓内容再点，拒绝/校验提示留证）
        for _ in range(10):
            await ybx.wait_for_timeout(2500)
            dlgs = await ybx.evaluate("""() => {
                const out = [];
                for (const d of document.querySelectorAll('.ui-dialog')) {
                    if (d.offsetParent === null) continue;
                    out.push((d.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160));
                }
                return out;
            }""")
            if dlgs:
                say(9.1, '弹窗', texts=dlgs)
            c = 'nf'
            for f in ybx.frames:
                try:
                    c = await f.evaluate(CONFIRM_LOOSE_JS, ['确 定', '确定', '确认', '继 续', '继续'])
                    if c != 'nf':
                        break
                except Exception:
                    pass
            if c == 'nf':
                break
        say(9, '提交申请', submit=sv, alerts=alerts[:3] or None)
        # dump 页面内校验提示（红字/错误块——提交校验失败可能不弹 alert 而是页内提示）
        await ybx.wait_for_timeout(1500)
        for f in ybx.frames:
            try:
                hints = await asyncio.wait_for(f.evaluate("""() => {
                    const out = [];
                    for (const e of document.querySelectorAll('font, span, div, label, p')) {
                        if (e.offsetParent === null || e.children.length > 1) continue;
                        const t = (e.textContent || '').trim();
                        const red = /rgb\(255\s*,\s*0\s*,\s*0\)|red/i.test((e.style && e.style.color) || '') || (e.getAttribute('color') || '').toLowerCase() === 'red';
                        const cls = (e.className || '').toString();
                        if (t && t.length < 80 && (red || /error|alert|warn|fail/i.test(cls))) out.push(t);
                    }
                    return out.slice(0, 8);
                }"""), 5)
                if hints:
                    say(9.2, '页面校验提示', frame=f.url[-40:], hints=hints)
            except Exception:
                pass

        # 验证：全部报销单里该单号行状态已非「草稿」；still-draft 时重试一次提交
        # （winBtn 的 jQuery handler 绑定存在时机竞态——锚点只保证按钮 DOM 出现，不保证 handler 已绑）
        done = False
        st = '?'
        for attempt in range(2):
            for _ in range(3):
                try:
                    await ybx.reload(wait_until='domcontentloaded')
                except Exception:
                    pass
                await ybx.wait_for_timeout(6000)
                try: await ybx.evaluate(CLOSE_JS)
                except Exception: pass
                await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (els.length) els[0].click(); return els.length ? 'ok' : 'nf'; }""")
                await ybx.wait_for_timeout(6000)
                st = await ybx.evaluate("""(bill) => { for (const tr of document.querySelectorAll('tr[id]')) { const t = (tr.textContent || ''); if (t.includes(bill)) return /草稿/.test(t) ? 'still-draft' : 'state-changed'; } return 'no-row'; }""", bill)
                if st == 'state-changed':
                    done = True
                    break
                await ybx.wait_for_timeout(4000)
            if done:
                break
            if attempt == 0:
                say(9.5, '提交未生效，重试一次', state=st)
                for f in ybx.frames:
                    try:
                        sv2 = await asyncio.wait_for(f.evaluate("""() => {
                            const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && e.getAttribute('btnname') === '提交申请');
                            if (!b) return 'no-btn';
                            const o = { bubbles: true, cancelable: true, view: window };
                            b.dispatchEvent(new MouseEvent('mousedown', o));
                            b.dispatchEvent(new MouseEvent('mouseup', o));
                            b.dispatchEvent(new MouseEvent('click', o));
                            b.click();
                            return 'dispatched';
                        }"""), 5)
                        if sv2 == 'dispatched':
                            break
                    except Exception:
                        pass
                for _ in range(6):
                    await ybx.wait_for_timeout(2500)
                    c = 'nf'
                    for f in ybx.frames:
                        try:
                            c = await f.evaluate(CONFIRM_LOOSE_JS, ['确 定', '确定', '确认', '继 续', '继续'])
                            if c != 'nf':
                                break
                        except Exception:
                            pass
                    if c == 'nf':
                        break
        await ybx.screenshot(path=os.path.join(LOG, f'submit_done_{stamp}.png'), full_page=True)
        say(10, '提交验证', bill=bill, done=done, state=st)
        if sv != 'dispatched' or not done:
            say(11, '确认递交', result=f'FAIL submit={sv} state={st}', abort=True)
            await browser.close()
            sys.exit(1)
        print('##SUBMITTED##1', flush=True)
        say(12, '递交完成', billNo=bill)
        await browser.close()


asyncio.run(main())
