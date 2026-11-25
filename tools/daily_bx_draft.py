#!/usr/bin/env python3
"""市内交通「日常报销」e2e（v1：到开单页 dump 表单结构，不保存）。
流程：登录 → 上传市内交通发票 → 等识别 → 勾选 → 前往报销 → dump 开单页表单 + 截图。
经验来源：差旅 e2e（auto_bx_e2e_full）+ 池探索（explore_daily_bx）。"""
import asyncio
import json
import os
import re
import sys
import time

from receipt_runtime import DATA_ROOT, launch_chromium, school_session

ROOT = str(DATA_ROOT)
sys.path.insert(0, os.path.join(ROOT, 'DF'))

from playwright.async_api import async_playwright

SESSION = school_session("treasury")
LOG = os.path.join(ROOT, 'data', 'autobx_logs', 'explore')
# 财务系统附件数上限（2026-10-16 页面校验实证：「发票及附件总数最多为80张」）——上限可能随财务调整，统一改这里
FINANCE_ATTACHMENT_LIMIT = 80
CURRENT_PAGE = None  # 异常兜底截图用（main 里赋值）
os.makedirs(LOG, exist_ok=True)

def current_folder(title_hint: str = ''):
    """从权威源（receipt-lines）取票据集当前 folder（撤回/移动后路径会变）。
    优先按 title 精确匹配（9 月集/拆分集各有目录），回退历史硬编码 id。"""
    import urllib.request
    with urllib.request.urlopen('http://127.0.0.1:8030/api/receipt-lines', timeout=10) as r:
        doc = json.load(r)
    hint = (title_hint or '').strip()
    if hint:
        for line in doc.get('lines', []):
            if line.get('title') == hint:
                return os.path.join(ROOT, line['folder'])
    for line in doc.get('lines', []):
        if line.get('id') == 'daily-2026-07':
            return os.path.join(ROOT, line['folder'])
    raise SystemExit('票据集不存在')
CLOSE_JS = """() => { let n = 0; for (const d of document.querySelectorAll('.ui-dialog')) { if (d.offsetParent !== null) { const c = d.querySelector('.ui-dialog-titlebar-close'); if (c) { c.click(); n++; } } } return n; }"""
CLICK_TEXT_JS = """(t) => {
    const norm = (s) => (s || '').replace(/\\s/g, '');
    let best = null;
    for (const e of document.querySelectorAll('*')) {
        if (e.offsetParent === null) continue;
        const c = norm(e.textContent);
        if (!c.includes(t) || c.length > t.length + 8) continue;
        if (best === null || (best.contains(e) && e !== best)) best = e;
    }
    if (!best) return 'nf';
    const o = { bubbles: true, cancelable: true, view: window };
    best.dispatchEvent(new MouseEvent('mousedown', o));
    best.dispatchEvent(new MouseEvent('mouseup', o));
    best.dispatchEvent(new MouseEvent('click', o));
    return 'dispatched:' + best.tagName + ':' + norm(best.textContent).slice(0, 14);
}"""
CONFIRM_LOOSE_JS = """(labels) => {
    const norm = (s) => (s || '').replace(/\\s/g, '');
    for (const t of labels) {
        const el = Array.from(document.querySelectorAll('a, button')).find(e =>
            e.offsetParent !== null && norm(e.textContent) === norm(t));
        if (el) { el.click(); return 'ok:' + norm(el.textContent); }
    }
    return 'nf';
}"""
DISPATCH_POOL_JS = """() => { let el = document.getElementById('resultBX_02_2__title'); if (!el) return 'nf'; const o = { bubbles: true, cancelable: true, view: window }; el.dispatchEvent(new MouseEvent('mousedown', o)); el.dispatchEvent(new MouseEvent('mouseup', o)); el.dispatchEvent(new MouseEvent('click', o)); return 'dispatched'; }"""

# 市内交通 14 张发票（金额关键词用于池内勾选匹配）
# 识别/勾选的目标金额：从 config 发票文件名提取（规范命名 CNYxxx），不再硬编码单一组（2026-09-19 低耗组实证教训）
TARGETS = []  # main() 里按 config.invoicePaths 填充


def say(no, name, **kw):
    detail = '; '.join(f"{k}={v}" for k, v in kw.items())
    print(f"#{no} {name} -> {detail[:100]}", flush=True)
    print(json.dumps({'step': no, 'name': name, **kw}, ensure_ascii=False), flush=True)


async def wait_anchor(page, texts, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            inner = await page.evaluate('() => document.body.innerText')
            for t in texts:
                if t in inner:
                    return t
        except Exception:
            pass
        await page.wait_for_timeout(1000)
    return None


def invoice_files(config=None):
    """组递交发票清单：config.invoicePaths 优先（观自在按组下发）；无 config 回退市内交通文件名过滤（探索期行为）。"""
    if config and config.get('invoicePaths'):
        out = []
        for p in config['invoicePaths']:
            ap = p if os.path.isabs(p) else os.path.join(ROOT, p)
            if os.path.exists(ap):
                out.append(ap)
        return sorted(out)
    files = []
    for root_dir, dirs, fs in os.walk(FOLDER):
        for name in fs:
            if ('网约车发票' in name or '出租车发票' in name) and name.endswith('.pdf'):
                files.append(os.path.join(root_dir, name))
    return sorted(files)


async def main():
    stamp = time.strftime('%H%M%S')
    mode = sys.argv[1] if len(sys.argv) > 1 else 'dump'  # dump | save | resume
    cfg = {}
    # 修复（2026-09-19）：spawn 参数为 [script, '--config', path]，旧判断 sys.argv[2]=='--config' 永远 False，
    # 导致 cfg 恒为空——撤旧/组过滤/金额校验/autoSubmit/travelerSno 全部从未生效。
    if '--config' in sys.argv:
        _i = sys.argv.index('--config')
        if mode == '--config':
            mode = 'save'
        if _i + 1 < len(sys.argv):
            with open(sys.argv[_i + 1], encoding='utf-8') as f:
                cfg = json.load(f)
    global FOLDER
    FOLDER = current_folder(str(cfg.get('title') or cfg.get('summary') or ''))
    say(0, '票据集目录', folder=os.path.relpath(FOLDER, ROOT), mode=mode)
    # TARGETS（识别/勾选目标金额）从 config 发票文件名提取：规范命名 CNY\d+\.\d{2}
    import re as _re
    for p in cfg.get('invoicePaths', []):
        m_amt = _re.search(r'CNY(\d+\.\d{2})', p)
        if m_amt:
            TARGETS.append(m_amt.group(1))
    TARGETS.sort()
    say(0.05, '目标金额', count=len(TARGETS), amounts=TARGETS[:6])
    files = invoice_files(cfg)
    # 组精确过滤：config.invoicePaths 优先（观自在按组下发的发票清单）。
    # 路径归一化后比对（config 相对 ROOT / 本地绝对路径混用——2026-09-19 实证 count=0 假过滤）
    if cfg.get('invoicePaths'):
        _norm = lambda p: os.path.abspath(p if os.path.isabs(p) else os.path.join(ROOT, p))
        wanted = {_norm(p) for p in cfg['invoicePaths']}
        files = [f for f in files if _norm(f) in wanted]
        say(0.1, '组过滤', count=len(files))
    say(0, '发票清单', count=len(files))
    if TARGETS and len(files) != len(TARGETS):
        say(0.1, '警告', detail=f'目标金额 {len(TARGETS)} 个，实际发票 {len(files)} 张')

    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=True)
        ctx = await browser.new_context(storage_state=str(SESSION) if SESSION.exists() else None, viewport={'width': 1600, 'height': 1000})
        page = await ctx.new_page()
        page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))

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
        global CURRENT_PAGE
        CURRENT_PAGE = ybx
        await ybx.wait_for_load_state('domcontentloaded')
        await wait_anchor(ybx, ['草稿', '我的发票'])
        for _ in range(8):
            if not await ybx.evaluate(CLOSE_JS):
                break
            await ybx.wait_for_timeout(500)

        # ===== A. 撤销旧草稿（防重复递交竞态：优先单号，无单号按摘要匹配；草稿箱空则直接通过）=====
        if mode != 'resume' and (cfg.get('revokeBillNo') or cfg.get('revokeSummary')):
            REVOKE_MATCH = str(cfg.get('revokeBillNo') or cfg.get('revokeSummary', ''))
            # 入口点击轮询重试：页面慢渲染时单次 click 会假 nf（2026-09-18 差旅引擎实证），60s 内每 3s 重试。
            clk = 'nf'
            for _ in range(20):
                clk = await ybx.evaluate(CLICK_TEXT_JS, '草稿')
                if clk != 'nf':
                    break
                await ybx.wait_for_timeout(3000)
            await ybx.wait_for_timeout(5000)
            await ybx.evaluate(CLOSE_JS)
            if clk == 'nf':
                say(2, '撤销旧草稿', result='FAIL 页面无「草稿」入口（渲染失败）', abort=True)
                await ybx.screenshot(path=os.path.join(LOG, f'daily_revoke_fail_{stamp}.png'), full_page=True)
                await browser.close()
                return
            REVOKE_AMT = str(cfg.get('expensesTotal') or '')
            revoked = False
            # 循环撤销：同摘要旧草稿可能有多张（失败重试遗留），每轮撤一张，最多 3 轮
            for _revoke_round in range(3):
                sel = await ybx.evaluate(f"""() => {{
                    const norm = (s) => (s || '').replace(/\\s+/g, '');
                    const today = '{time.strftime("%Y-%m-%d")}';
                    const amt = '{REVOKE_AMT}';
                    for (const tr of document.querySelectorAll('tr[id]')) {{
                        const nt = norm(tr.textContent);
                        const hit = nt.includes('{REVOKE_MATCH}') || (amt && nt.includes(today) && nt.replace(/,/g, '').includes(amt));
                        if (!hit) continue;
                        const grid = tr.closest('table[id]');
                        if (!grid) continue;
                        jQuery('#' + grid.id).jqGrid('resetSelection');
                        jQuery('#' + grid.id).setSelection(tr.id, true);
                        return 'selected';
                    }}
                    return 'no-row';
                }}""")
                await ybx.wait_for_timeout(2000)
                if sel != 'selected':
                    break
                rv = await ybx.evaluate("""() => {
                    const b = Array.from(document.querySelectorAll('button, a, input')).find(e =>
                        e.offsetParent !== null && ((e.getAttribute('btnname') || '').includes('撤销') ||
                        (e.textContent || e.value || '').replace(/\\s/g, '') === '撤销报销单'));
                    if (b) { b.click(); return 'native-clicked'; }
                    return 'nf';
                }""")
                await ybx.wait_for_timeout(2500)
                c = 'nf'
                for label in ('继 续', '继续', '确 定', '确定', '确认'):
                    c = await ybx.evaluate(CONFIRM_LOOSE_JS, [label])
                    if c != 'nf':
                        break
                    await ybx.wait_for_timeout(400)
                await ybx.wait_for_timeout(4000)
                if rv != 'native-clicked':
                    break
                revoked = True
            if revoked:
                await ybx.reload(wait_until='domcontentloaded')
                await ybx.wait_for_timeout(6000)
                await ybx.evaluate(CLOSE_JS)
                for _ in range(10):
                    if await ybx.evaluate(CLICK_TEXT_JS, '草稿') != 'nf':
                        break
                    await ybx.wait_for_timeout(2000)
                await ybx.wait_for_timeout(4000)
            gone = await ybx.evaluate(f"() => !((document.body.innerText || '').replace(/\\s+/g, '')).includes('{REVOKE_MATCH}')")
            say(2, '撤销旧草稿', revoked=revoked, gone=gone)
            if not gone:
                say(2, '撤销旧草稿', result='FAIL 草稿仍在', abort=True)
                await ybx.screenshot(path=os.path.join(LOG, f'daily_revoke_stuck_{stamp}.png'), full_page=True)
                await browser.close()
                return
            # 回首页视图（点过草稿入口后停在草稿箱，池入口在主页）
            await ybx.reload(wait_until='domcontentloaded')
            await ybx.wait_for_timeout(6000)
            await ybx.evaluate(CLOSE_JS)

        if mode == 'resume':
            # 直接打开已有草稿单补填（发票已被该单占用，不可重传）
            if len(sys.argv) <= 2 or sys.argv[2].startswith('--'):
                raise ValueError('恢复草稿时请指定报销单号')
            bill = sys.argv[2]
            await ybx.evaluate("""() => {
                const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单');
                if (els.length) els[0].click();
            }""")
            await ybx.wait_for_timeout(6000)
            await ybx.evaluate(CLOSE_JS)
            sel = await ybx.evaluate("""(bill) => {
                for (const tr of document.querySelectorAll('tr[id]')) {
                    if (!(tr.textContent || '').includes(bill)) continue;
                    const grid = tr.closest('.ui-jqgrid-btable');
                    if (grid && tr.id) { try { jQuery('#' + grid.id).jqGrid('setSelection', tr.id); return 'selected'; } catch (e) {} }
                }
                return 'nf';
            }""", bill)
            await ybx.wait_for_timeout(1000)
            say(2.5, '草稿勾选', bill=bill, sel=sel)
            # 勾选后点「修改」（底部按钮条）或行内链接，打开单据表单
            mod = await ybx.evaluate("""(bill) => {
                const b = Array.from(document.querySelectorAll('button, a, input[type=button]')).find(e => e.offsetParent !== null &&
                    (e.textContent || e.value || '').replace(/\\s/g, '') === '修改');
                if (b) { b.click(); return 'bottom-modify'; }
                for (const tr of document.querySelectorAll('tr[id]')) {
                    if (!(tr.textContent || '').includes(bill)) continue;
                    const link = Array.from(tr.querySelectorAll('a')).find((a) => /修改|查看明细/.test(a.textContent || ''));
                    if (link) { link.click(); return 'row-link'; }
                }
                return 'nf';
            }""", bill)
            await ybx.wait_for_timeout(8000)
            for _ in range(4):
                if not await ybx.evaluate(CLOSE_JS):
                    break
                await ybx.wait_for_timeout(600)
            say(2.7, '打开修改', mod=mod, url=ybx.url[-60:])
            form_anchor = True

        await ybx.evaluate(DISPATCH_POOL_JS)
        await ybx.wait_for_timeout(4000)
        # 报销类型 →「日常报销」（决定单据大类：日常报销业务，非国内差旅）
        if mode != 'resume':
            bt = await ybx.evaluate("""() => {
                const a = Array.from(document.querySelectorAll('a')).find(e => e.offsetParent !== null &&
                    (e.textContent || '').trim() === '日常报销' && (e.getAttribute('onclick') || '').includes('changeBxType'));
                if (a) { a.click(); return 'clicked'; }
                return 'nf';
            }""")
            await ybx.wait_for_timeout(4000)
            say(1.8, '报销类型切换', daily=bt)
        say(2, '池视图')



        if mode != 'resume':
            async def snap(tag):
                # 逐步状态快照（2026-10-16 用户要求：每执行一步记录系统状态，失败可定位）：
                # URL 尾部 / 可见弹窗数 / 文件选择器数 / 池行数——一行一打
                try:
                    s = await ybx.evaluate("""() => ({
                        url: location.href.slice(-55),
                        dialogs: Array.from(document.querySelectorAll('.ui-dialog')).filter(d => d.offsetParent !== null).length,
                        fileInputs: document.querySelectorAll('input[type=file]').length,
                        poolRows: (document.getElementById('gridWF_YBX_53') || { querySelectorAll: () => [] }).querySelectorAll('tr[id]').length,
                        dialogText: (Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null) || { textContent: '' }).textContent.replace(/\\s+/g, ' ').slice(0, 60)
                    })""")
                    say(tag, '状态', **s)
                except Exception as e:
                    say(tag, '状态采集失败', err=f'{type(e).__name__}: {str(e)[:60]}')

            # ===== 池探测 → 分批上传 → 确认入池 → 缺口重传循环（2026-10-16 重构）=====
            # 根因（2026-10-15/16 两轮实证 25/47、17/47）：旧流程点「保存发票」后 1.5s 即走；
            # 识别等待退出条件 identifying==0 在「上传未被服务端受理」时也成立（32s 即退）；
            # 随后「前往报销」跳转中断仍在排队的上传请求 → 只入池一部分，张数随机。
            # 新流程四步（用户定案口径）：
            #   ① 池状态探测：行级金额计数（multiset，支持重复金额），rowNum 拉满防分页漏数
            #   ② 分批上传（10 张/批），点保存后等 file input 消失 = 服务端已受理，才关弹窗
            #   ③ 识别稳定判定：命中张数仍在增长或 identifying>0 继续等；连续 ~90s 无增长且无识别中 = 稳定
            #   ④ 缺口循环重传：只传缺失金额对应文件；连续一轮重传无新票入池即停；最终缺口 ≠ 0 则 FAIL 中止
            from collections import Counter as _Ctr
            need_ctr = _Ctr(TARGETS)
            amt2files = {}
            for f in files:
                m_amt = _re.search(r'CNY(\d+\.\d{2})', os.path.basename(f))
                if m_amt:
                    amt2files.setdefault(m_amt.group(1), []).append(f)

            async def pool_state():
                # reload + rowNum 拉满：行级计数依赖全量行（分页只数当前页会假缺口）
                await ybx.evaluate("""() => {
                    const g = document.getElementById('gridWF_YBX_53');
                    if (g) { try { jQuery(g).jqGrid('setGridParam', { rowNum: 200 }); jQuery(g).trigger('reloadGrid'); } catch (e) {} }
                }""")
                await ybx.wait_for_timeout(2500)
                return await ybx.evaluate("""(targets) => {
                    const grid = document.getElementById('gridWF_YBX_53');
                    if (!grid) return { counts: {}, rows: -1, identifying: -1 };
                    const uq = Array.from(new Set(targets));
                    const counts = {};
                    for (const tr of grid.querySelectorAll('tr[id]')) {
                        const t = tr.textContent || '';
                        for (const amt of uq) {
                            if (t.includes(amt)) { counts[amt] = (counts[amt] || 0) + 1; break; }
                        }
                    }
                    const m = (document.body.innerText || '').match(/(\\d+)张发票正在识别中/);
                    return { counts, rows: grid.querySelectorAll('tr[id]').length, identifying: m ? +m[1] : 0 };
                }""", TARGETS)

            def hit_of(state):
                if not state or state.get('rows', -1) < 0:
                    return 0
                c = state.get('counts') or {}
                return sum(min(n, c.get(a, 0)) for a, n in need_ctr.items())

            def missing_files_of(state):
                c = state.get('counts') or {}
                out = []
                for a, n in need_ctr.items():
                    short = n - min(n, c.get(a, 0))
                    if short > 0:
                        out.extend(amt2files.get(a, [])[:short])
                return out

            def gap_of(state):
                c = state.get('counts') or {}
                g = {}
                for a, n in need_ctr.items():
                    d = n - min(n, c.get(a, 0))
                    if d > 0:
                        g[a] = d
                return g

            async def do_upload(batch):
                # 一批完整链路：开弹窗 → 选文件 → 保存 → 等受理（file input 消失）
                btn = 'nf'
                for _ in range(12):
                    btn = await ybx.evaluate("""() => {
                        const b = Array.from(document.querySelectorAll('button, a, input')).find(e =>
                            e.offsetParent !== null && ((e.getAttribute('btnname') || '').includes('上传') ||
                            (e.textContent || e.value || '').replace(/\\s/g, '') === '上传发票'));
                        if (b) { b.click(); return 'ok'; }
                        return 'nf';
                    }""")
                    if btn != 'nf':
                        break
                    await ybx.wait_for_timeout(1000)
                    await ybx.evaluate(CLOSE_JS)
                fi = False
                for _ in range(20):
                    await ybx.wait_for_timeout(1000)
                    fi = await ybx.evaluate("() => document.querySelectorAll('input[type=file]').length > 0")
                    if fi:
                        break
                if not fi:
                    await snap('4.1')
                    return f'fail: file input 未出现 btn={btn}'
                await snap('4.2')
                await ybx.evaluate("() => { document.querySelectorAll('input[type=file]')[0].id = '__daily_up__'; }")
                await ybx.locator('#__daily_up__').set_input_files(batch)
                await ybx.wait_for_timeout(1500)
                await ybx.evaluate("""() => {
                    const b = Array.from(document.querySelectorAll('button, a, input')).find(e => e.offsetParent !== null &&
                        (e.textContent || e.value || '').replace(/\\s/g, '') === '保存发票');
                    if (b) b.click();
                }""")
                # 受理确认：file input 消失（保存请求已被服务端接收、弹窗关闭）——最长 120s
                for _ in range(60):
                    await ybx.wait_for_timeout(2000)
                    if not await ybx.evaluate("() => document.querySelectorAll('input[type=file]').length > 0"):
                        await snap('4.3')
                        return 'ok'
                await snap('4.4')
                await ybx.evaluate(CLOSE_JS)
                return 'saved-but-dialog-open'

            async def wait_pool_stable():
                # 命中张数增长中 或 identifying>0 → 继续等；连续 ~90s 无增长且无识别中 → 稳定
                last, idle, state = -1, 0, None
                for i in range(60):
                    state = await pool_state()
                    h = hit_of(state)
                    if h > last:
                        last, idle = h, 0
                    else:
                        idle += 1
                    if i % 3 == 0:
                        say(5, '识别观察', hit=f"{h}/{len(TARGETS)}", identifying=state['identifying'])
                    if idle >= 9 and state['identifying'] == 0:
                        break
                return state

            state = await pool_state()
            say(3, '池内现状', hit=f"{hit_of(state)}/{len(TARGETS)}", gap=gap_of(state))
            last_hit = -1
            for rnd in range(4):
                state = await pool_state()
                miss = missing_files_of(state)
                h = hit_of(state)
                if not miss:
                    break
                if h == last_hit:
                    say(4, '重传无新票入池（停止循环）', hit=f"{h}/{len(TARGETS)}", gap=gap_of(state))
                    break
                last_hit = h
                await snap(f'4.{rnd + 1}0')
                say(4, f'上传发票（第{rnd + 1}轮）', missing=len(miss))
                for bi in range(0, len(miss), 10):
                    r = await do_upload(miss[bi:bi + 10])
                    if str(r).startswith('fail'):
                        say(4, '上传失败', result=str(r))
                        break
                    say(4, '批次已受理', batch=len(miss[bi:bi + 10]), result=str(r))
                state = await wait_pool_stable()
                say(5, f'识别阶段结束（第{rnd + 1}轮）', hit=f"{hit_of(state)}/{len(TARGETS)}", identifying=state['identifying'])
            # 最终断言：全部入池才允许开单（勾选张数断言的前置防线）
            state = await pool_state()
            h = hit_of(state)
            if h < len(TARGETS):
                say(5, '发票未全部入池', hit=f"{h}/{len(TARGETS)}", gap=gap_of(state),
                    result='FAIL 重传循环后仍有缺口（见 gap，金额×张数）——中止开单，请人工检查发票池', abort=True)
                await ybx.screenshot(path=os.path.join(LOG, f'daily_pool_gap_{stamp}.png'), full_page=True)
                await browser.close()
                return

            # 勾选发票 → 前往报销（先拉大每页行数：池列表分页时 getDataIDs 只返回当前页，
            # 2026-10-13 九月集 47 张实证只勾到当前页 13 张，其余 34 张留在池里）
            await ybx.evaluate("""() => {
                const grid = document.getElementById('gridWF_YBX_53');
                if (!grid) return;
                try { jQuery(grid).jqGrid('setGridParam', { rowNum: 200 }); jQuery(grid).trigger('reloadGrid'); } catch (e) {}
            }""")
            await ybx.wait_for_timeout(4000)
            await ybx.evaluate("""(targets) => {
                const grid = document.getElementById('gridWF_YBX_53');
                if (!grid) return;
                for (const rid of jQuery(grid).jqGrid('getDataIDs')) {
                    const tr = document.getElementById(rid);
                    const t = tr ? (tr.textContent || '') : '';
                    if (targets.some((x) => t.includes(x))) {
                        const cb = tr.querySelector('input[type=checkbox]');
                        if (cb && !cb.checked) cb.click();
                    }
                }
            }""", TARGETS)
            await ybx.wait_for_timeout(2000)
            sel = await ybx.evaluate("() => { const m = (document.body.innerText || '').match(/已选 (\\d+) 张/); return m ? +m[1] : 0; }")
            say(6, '勾选', selected=sel)
            await snap('6.1')
            # 勾选张数断言（2026-10-15 实证：池识别部分失败时只勾到 25/47 仍继续开单——错误单据必须当场拦截）
            if sel and sel != len(files):
                say(6, '勾选张数不符', selected=sel, expected=len(files), result=f'FAIL 池中可勾发票不足（{sel}/{len(files)}），中止开单——请检查发票池识别状态', abort=True)
                await ybx.screenshot(path=os.path.join(LOG, f'daily_sel_mismatch_{stamp}.png'), full_page=True)
                await browser.close()
                return
            await ybx.evaluate("""() => {
                const b = Array.from(document.querySelectorAll('button, a, span')).find(e => e.offsetParent !== null &&
                    (e.textContent || '').replace(/\\s/g, '') === '前往报销');
                if (b) b.click();
            }""")
            form_anchor = None
            for _ in range(15):
                await ybx.wait_for_timeout(2500)
                await ybx.evaluate(CLOSE_JS)
                t = await ybx.evaluate('() => document.body.innerText')
                if '提交申请' in t or '保存草稿' in t:
                    form_anchor = True
                    break
            say(7, '开单页', reached=form_anchor)
            if not form_anchor:
                await ybx.screenshot(path=os.path.join(LOG, f'daily_noform_{stamp}.png'))
                await browser.close()
                return


        # 表单在 iframe：等渲染 → 找到 → dump 全字段 + 截图
        form_frame = None
        for _ in range(15):
            for f in ybx.frames:
                try:
                    txt = await asyncio.wait_for(f.evaluate("() => document.body ? document.body.innerText : ''"), 3)
                    if ('摘要' in txt or '经费' in txt or '报销' in txt) and len(txt) > 100 and 'gridWF_YBX' not in txt:
                        form_frame = f
                        break
                except Exception:
                    pass
            if form_frame:
                break
            await asyncio.sleep(2)
        if not form_frame:
            say(8, '表单 frame', result='未命中', frames=[f.url[-60:] for f in ybx.frames])
            await ybx.screenshot(path=os.path.join(LOG, f'daily_form_nf_{stamp}.png'), full_page=True)
            await browser.close()
            return
        say(7.5, '表单 frame', url=form_frame.url[-70:])
        form = await form_frame.evaluate("""() => {
            const fields = [];
            for (const el of document.querySelectorAll('input, select, textarea')) {
                if (['hidden', 'button', 'submit'].includes(el.type)) continue;
                const label = (el.closest('td')?.previousElementSibling?.textContent || el.closest('tr')?.querySelector('td, th')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 20);
                const v = el.tagName === 'SELECT' ? (el.selectedOptions[0]?.textContent || '').trim() : (el.value || '');
                fields.push({ tag: el.tagName, type: el.type || '', name: el.name || el.id || '', label, value: v.slice(0, 50) });
            }
            const buttons = Array.from(document.querySelectorAll('button, a, input[type=button]')).filter((e) => e.offsetParent !== null).map((e) => (e.textContent || e.value || '').trim()).filter((t) => t && t.length <= 12);
            const text = (document.body.innerText || '').replace(/\\s+/g, ' ');
            return { fields, buttons: [...new Set(buttons)].slice(0, 25), textHead: text.slice(0, 1000) };
        }""")
        say(8, '开单页字段', count=len(form['fields']))
        for f in form['fields'][:40]:
            print('   ', json.dumps(f, ensure_ascii=False))
        say(8.1, '按钮', buttons=form['buttons'])
        say(8.2, '正文', text=form['textHead'])
        # 开单页正文是单号/摘要/项目的可靠校验基准——保存后页面跳转，之后采集可能读到空白
        form_text_snapshot = (form.get('textHead') or '')
        await ybx.screenshot(path=os.path.join(LOG, f'daily_form_{stamp}.png'), full_page=True)
        if mode == 'dump':
            say(9, 'v1 完成', note='dump 模式：不保存，浏览器丢弃')
            await browser.close()
            return

        # ===== v2 save：委托打印=是 → 支付信息 → 保存草稿 =====
        # 验证：协同审批人当前值（「请选择」=未选）
        appr_check = await form_frame.evaluate("""() => {
            const i = document.body.innerText.indexOf('协同审批人');
            return i >= 0 ? document.body.innerText.slice(i, i + 120).replace(/\\s+/g, ' ') : 'nf';
        }""")
        say(8.5, '协同审批人现状', text=appr_check)
        r_radio = await form_frame.evaluate("""() => {
            const y = document.querySelector('input[name="form_grantcwprint"][value="Y"]');
            if (!y) return 'nf';
            y.click();
            y.dispatchEvent(new Event('change', { bubbles: true }));
            return y.checked ? 'checked-Y' : 'click-no-effect';
        }""")
        await form_frame.wait_for_timeout(1000)
        say(9, '委托财务打印', result=r_radio)

        # ===== N. 支付方式：一键【支付到报销人】（2026-09-19 实证正道）=====
        # 该按钮触发表单刷新（frame detached 属预期）：系统自动生成报销人本人转卡行
        # （工号/姓名/账号/开户行/金额全部带出，蓝字「转卡信息完整」）。
        # 弃用「修改支付信息」弹窗方案——弹窗里跨段字段误匹配 + 分字段异步回填重置 + 掩码卡号校验三连坑。
        pay_btn = None
        for _ in range(10):
            for f in ybx.frames:
                try:
                    pay_btn = await asyncio.wait_for(f.evaluate("""() => {
                        const b = Array.from(document.querySelectorAll('span, a, button, div')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '【支付到报销人】');
                        if (!b) return null;
                        const o = { bubbles: true, cancelable: true, view: window };
                        b.dispatchEvent(new MouseEvent('mousedown', o));
                        b.dispatchEvent(new MouseEvent('mouseup', o));
                        b.dispatchEvent(new MouseEvent('click', o));
                        return 'dispatched';
                    }"""), 4)
                    if pay_btn:
                        break
                except Exception:
                    pass
            if pay_btn:
                break
            await ybx.wait_for_timeout(4000)
        say(10, '支付到报销人', click=pay_btn)
        if not pay_btn:
            await ybx.screenshot(path=os.path.join(LOG, f'daily_pay_btn_missing_{stamp}.png'), full_page=True)
        else:
            # 页面刷新后轮询校验：支付方式已设置（正向校验）。
            # 「转卡信息完整/共填写N条」是弹窗文案且点按钮后已消失；表单页可靠信号 =「转卡信息完整」
            # 或「共填写N条支付信息」仍在正文。
            pay_ok = False
            pay_text = None
            for _ in range(20):
                await ybx.wait_for_timeout(3000)
                for f in ybx.frames:
                    try:
                        r = await asyncio.wait_for(f.evaluate("""() => {
                            const t = document.body.innerText || '';
                            const full = t.includes('转卡信息完整');
                            const m = t.match(/共填写(\\d+)条支付信息[^\\n]*/);
                            if (!full && !m) return null;
                            return { full, summary: m ? m[0] : null };
                        }"""), 4)
                        if r:
                            pay_ok = r['full']
                            pay_text = r['summary']
                            break
                    except Exception:
                        pass
                if pay_ok:
                    break
            say(10, '支付方式校验', complete=pay_ok, detail=pay_text)
            if not pay_ok:
                await ybx.screenshot(path=os.path.join(LOG, f'daily_payway_fail_{stamp}.png'), full_page=True)
                say(10, '支付方式校验', note='提示：complete=False 不代表失败——请以草稿实际状态为准')
        await ybx.wait_for_timeout(3000)
        await ybx.evaluate(CLOSE_JS)

        # 协同审批人来自单据投递配置。
        approver_id, _, approver_name = str(cfg.get('approver') or '').partition('/')
        approver_id, approver_name = approver_id.strip(), approver_name.strip()
        ff2 = None
        for f in ybx.frames:
            try:
                if await asyncio.wait_for(f.evaluate("() => document.body && document.body.innerText.includes('协同审批人')"), 4):
                    ff2 = f
                    break
            except Exception:
                pass
        if ff2 and approver_id.isdigit():
            r = await ff2.evaluate("""() => {
                const td = Array.from(document.querySelectorAll('td')).find(td => td.offsetParent !== null &&
                    (td.textContent || '').trim() === '请选择');
                if (!td) return 'nf';
                td.click();
                return 'clicked';
            }""")
            await ybx.wait_for_timeout(4000)
            dlg = None
            for f in ybx.frames:
                try:
                    ok = await asyncio.wait_for(f.evaluate("() => !!Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('工号'))"), 4)
                    if ok:
                        dlg = f
                        break
                except Exception:
                    pass
            if dlg:
                # xm-select 组件：真实键击输入工号 → 等下拉 → 点选中人
                inp = dlg.locator("input[placeholder*='工号']")
                await inp.click()
                await inp.press_sequentially(approver_id, delay=120)
                await ybx.wait_for_timeout(2500)
                pick = await dlg.evaluate("""([employeeId, name]) => {
                    const matches = (text) => text.includes(employeeId) || (name && text.includes(name));
                    const cands = Array.from(document.querySelectorAll('li, div, p, span')).filter(e => e.offsetParent !== null &&
                        matches((e.textContent || '').trim()) && e.children.length <= 2 && (e.textContent || '').trim().length < 40);
                    if (cands.length) { cands[cands.length - 1].click(); return 'picked:' + (cands[cands.length - 1].textContent || '').trim(); }
                    return 'no-option';
                }""", [approver_id, approver_name])
                await ybx.wait_for_timeout(1500)
                say(10.4, '工号搜索选择', pick=pick)
                r3 = await dlg.evaluate("""() => {
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    const scope = dlgEl || document;
                    const cb = scope.querySelector('input[type=checkbox]');
                    if (cb && !cb.checked) cb.click();
                    const b = Array.from(scope.querySelectorAll('a, button')).find(e =>
                        e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '保存');
                    if (b) { b.click(); return 'saved'; }
                    return 'no-save-btn';
                }""")
                await ybx.wait_for_timeout(3000)
                say(10.5, '协同审批人', open=r, save=r3)
            else:
                say(10.5, '协同审批人', open=r, result='工号弹窗未找到（人工处理）')
        else:
            say(10.5, '协同审批人', result='scope 未找到（人工处理）')
        await ybx.wait_for_timeout(2500)
        try:
            await asyncio.wait_for(ybx.evaluate(CLOSE_JS), 8)
        except Exception:
            pass  # 协同审批人保存会触发 frame 重载，evaluate 可能因 context 销毁挂起——弹窗关闭失败不致命

        # ===== N. 附件上传（2026-09-19 实证：日常单开单页「附件上传」入口 pageOpen_v1('特殊事项','32&32')
        # →「补充说明」弹窗（事项描述 textarea + file input + 保存）。差旅是 31&31「差旅附件上传」，日常是 32&32。
        # config.attachmentPaths 由观自在 plan 生成（非凭证材料：购买截图/支付记录/费目清单/elab 资产入账单 PDF）。
        # 列表页「附件补录」只对财务退回单开放，必须开单时传。失败 WARN 不阻塞（附件可事后财务退回补录）。
        att_paths = [p if os.path.isabs(p) else os.path.join(ROOT, p) for p in cfg.get('attachmentPaths', [])]
        att_paths = [p for p in att_paths if os.path.exists(p)]
        # 附件合并（2026-10-16 财务限制实证：发票+附件总数 ≤ 80，九月集 47+47=94 被页面校验拦下
        # 「附件数或图片数过多,请合并转成pdf或分批次报销」）。超限时全部附件按序合并为 1 个 PDF 再传。
        # 仅市内交通大批量场景会触发（用户定案：其他报销类型通常不超 80，暂不处理）。
        merged_path = None  # 临时合并件：仅供本次上传，传完即删；本地存档始终用原始行程单
        merged_done = False  # 实际是否触发合并成功（True=附件按 1 份传；False=按原 N 份传）
        orig_att_count = len(att_paths)  # 合并前原始附件数（回写备注口径用）
        if att_paths and len(files) + len(att_paths) > FINANCE_ATTACHMENT_LIMIT:
            if len(files) + 1 > FINANCE_ATTACHMENT_LIMIT:
                # 发票不能合并缩减（2026-10-16 用户定案）：附件全合并为 1 份后发票+1 仍超限 → 合并救不了，必须拆单
                say(10.8, '发票数超限（须拆单）', invoices=len(files), merged_att=1, limit=FINANCE_ATTACHMENT_LIMIT,
                    result=f'FAIL 发票 {len(files)} 份 + 合并附件 1 份 = {len(files) + 1} 仍超财务上限 {FINANCE_ATTACHMENT_LIMIT}——发票不能合并缩减，请拆成多张报销单递交', abort=True)
                try:
                    await ybx.screenshot(path=os.path.join(LOG, f'daily_split_required_{stamp}.png'), full_page=True)
                except Exception:
                    pass
                await browser.close()
                return
            try:
                from pypdf import PdfWriter
                import tempfile
                writer = PdfWriter()
                for ap in att_paths:
                    writer.append(ap)
                merged_fd, merged_path = tempfile.mkstemp(prefix='merged_att_', suffix='.pdf')
                os.close(merged_fd)
                with open(merged_path, 'wb') as fh:
                    writer.write(fh)
                say(10.8, '附件合并', reason=f'发票{len(files)}+附件{len(att_paths)}>上限{FINANCE_ATTACHMENT_LIMIT}', merged_to=1,
                    merged_path=merged_path, total_mb=round(os.path.getsize(merged_path) / 1048576, 1))
                att_paths = [merged_path]
                merged_done = True
            except Exception as e:
                say(10.8, '附件合并失败', err=f'{type(e).__name__}: {str(e)[:100]}', result='按原清单继续上传（可能被财务校验拦下）')
        # 静默降级防线（2026-10-15 九月集空附件实证）：config 无附件字段，但发票同目录存在行程单/支付记录等
        # 附件类材料 → 大概率是手工 config 漏了 attachmentPaths，WARN 显式提示而非静默跳过。
        if not att_paths and 'attachmentPaths' not in cfg:
            probe_dir = os.path.dirname(files[0]) if files else ''
            itin_count = sum(1 for f in os.listdir(probe_dir) if '行程单' in f) if probe_dir and os.path.isdir(probe_dir) else 0
            if itin_count:
                say(10.8, '附件上传', result=f'WARN config 缺 attachmentPaths 字段（同目录有 {itin_count} 份行程单未上传）——请走观自在 UI 递交重新生成 config')
        if not att_paths:
            say(10.8, '附件上传', result='无附件（跳过）')
        else:
            att_ok = False
            for attempt in (1, 2):
                opened = False
                for f in ybx.frames:
                    try:
                        has = await asyncio.wait_for(f.evaluate("""() => {
                            if (typeof pageOpen_v1 === 'function' && document.body.innerText.includes('附件上传')) {
                                window.confirm = function() { return true; };
                                pageOpen_v1('特殊事项','32&32');
                                return true;
                            }
                            return false;
                        }"""), 4)
                        if has:
                            opened = True
                            break
                    except Exception:
                        pass
                if not opened:
                    say(10.8, '附件上传', attempt=attempt, result='入口未找到（人工处理）')
                    continue
                await ybx.wait_for_timeout(4000)
                dlg_frame = None
                for f in ybx.frames:
                    try:
                        ok = await asyncio.wait_for(f.evaluate("""() => {
                            const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                            return !!(dlg && dlg.querySelector('input[type=file]'));
                        }"""), 4)
                        if ok:
                            dlg_frame = f
                            break
                    except Exception:
                        pass
                if not dlg_frame:
                    say(10.8, '附件上传', attempt=attempt, result='弹窗/file input 未找到（人工处理）')
                    continue
                n_set = await dlg_frame.evaluate("""() => {
                    const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    const fi = dlg && dlg.querySelector('input[type=file]');
                    if (!fi) return 0;
                    fi.id = '__e2e_att__';
                    return 1;
                }""")
                say(10.8, '附件上传', attempt=attempt, fileInputMarked=n_set)
                # page 级 locator 穿透 iframe 搜索（dlg_frame 与弹窗实际 frame 可能不一致——2026-09-19 超时实证）
                await ybx.locator('#__e2e_att__').set_input_files(att_paths)
                await ybx.wait_for_timeout(8000)
                n_del = await dlg_frame.evaluate("""() => {
                    const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    return dlg ? dlg.querySelectorAll('a.del').length : -1;
                }""")
                if n_del == len(att_paths):
                    desc = cfg.get('attachmentDesc', '')
                    # 补充说明数字跟随实际（2026-10-16 用户定案：触发了合并才写 1 份）：
                    # plan 预写的是「预期」（>80 → 1 份（N 份材料合并 PDF））；若运行时合并失败
                    # 按原 N 份传，必须把预写的合并口径回写为真实 N 份，否则财务对不上。
                    if desc and not merged_done and orig_att_count > 0:
                        fixed = desc.replace(f'1 份（{orig_att_count} 份材料合并 PDF）', f'{orig_att_count} 份')
                        if fixed != desc:
                            say(10.8, '补充说明口径回写', reason='合并未触发，按原 N 份上传', desc_tail=fixed[-40:])
                            desc = fixed
                    if desc:
                        await dlg_frame.evaluate("""(d) => {
                            const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null);
                            const ta = Array.from(dlg.querySelectorAll('textarea')).find(t => t.offsetParent !== null);
                            if (ta) { ta.value = d; ta.dispatchEvent(new Event('change', { bubbles: true })); }
                        }""", desc)
                        await ybx.wait_for_timeout(500)
                    r_save_att = await dlg_frame.evaluate("""() => {
                        const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                        const b = Array.from(dlg.querySelectorAll('a, button, input[type=button]')).find(e => e.offsetParent !== null && (e.textContent || e.value || '').replace(/\\s/g, '') === '保存');
                        if (b) { b.click(); return 'ok'; }
                        return 'nf';
                    }""")
                    await ybx.wait_for_timeout(4000)
                    for _ in range(3):
                        if not await ybx.evaluate(CLOSE_JS):
                            break
                        await ybx.wait_for_timeout(500)
                    say(10.8, '附件上传', count=len(att_paths), save=r_save_att)
                    att_ok = True
                    break
                say(10.8, '附件上传', attempt=attempt, expect=len(att_paths), actual=n_del, result='数量不符重试')
            if not att_ok:
                try:
                    await ybx.screenshot(path=os.path.join(LOG, f'daily_att_fail_{stamp}.png'), full_page=True)
                except Exception:
                    pass
                say(10.8, '附件上传', result='WARN 附件未上传成功（可财务退回后补录），继续递交')
            # 临时合并件清理（用户定案：合并 PDF 无保存价值，仅上传用；本地存档用原始行程单）
            if merged_path and os.path.exists(merged_path):
                os.unlink(merged_path)
                say(10.8, '临时合并件已清理', path=merged_path)

        r_save = await ybx.evaluate("""() => {
            const norm = (s) => (s || '').replace(/\\s/g, '');
            let best = null;
            for (const e of document.querySelectorAll('*')) {
                if (e.offsetParent === null) continue;
                if (norm(e.textContent) !== '保存草稿') continue;
                if (best === null || (best.contains(e) && e !== best)) best = e;
            }
            if (!best) return 'nf';
            const o = { bubbles: true, cancelable: true, view: window };
            best.dispatchEvent(new MouseEvent('mousedown', o));
            best.dispatchEvent(new MouseEvent('mouseup', o));
            best.dispatchEvent(new MouseEvent('click', o));
            return 'dispatched:' + best.tagName;
        }""")
        await ybx.wait_for_timeout(6000)
        for _ in range(3):
            if not await ybx.evaluate(CLOSE_JS):
                break
            await ybx.wait_for_timeout(600)
        say(11, '保存草稿', click=r_save)
        # 全 frame 拼接文本：单号/摘要都在表单 iframe（bx_dtl）里，主 frame innerText 读不到——
        # 2026-09-19 实证 billNo=None + summary=False 全因主 frame 读取（单号在 iframe 正文）。
        # 保存会触发页面跳转/刷新——立即采集会读到空白页。
        # 轮询等单号出现（最长 60s），采集稳定后再校验。
        all_text = ''
        m_bill = None
        for _ in range(20):
            all_text = ''
            for f in ybx.frames:
                try:
                    all_text += (await f.evaluate("() => document.body.innerText || ''")) + '\n'
                except Exception:
                    pass
            m_bill = re.search(r'报销单号[：:]\s*(4\d{6})', all_text) or re.search(r'4\d{6}', all_text)
            if m_bill:
                break
            await ybx.wait_for_timeout(3000)
        if m_bill is None:
            m_bill = re.search(r'报销单号[：:]\s*(4\d{6})', all_text) or re.search(r'4\d{6}', all_text)
        bill_no = m_bill.group(1) if m_bill and m_bill.groups else (m_bill.group(0) if m_bill else None)
        expected = cfg.get('totalExpected') or cfg.get('expensesTotal')
        amount_ok = True
        if expected and bill_no:
            # 金额校验加固（2026-10-15 实证：25/47 张的错误单据 787.03 竟通过 amount=True——
            # 旧逻辑页面解析不到金额时静默通过 + 只查主 frame。改为全 frame 解析、解析不到=FAIL、金额不符=FAIL）
            page_amt = None
            for _fr in ybx.frames:
                try:
                    _v = await _fr.evaluate("() => { const m = (document.body.innerText || '').replace(/,/g, '').match(/金额总计[:：]\\s*([0-9.]+)/); return m ? parseFloat(m[1]) : null; }")
                    if _v is not None:
                        page_amt = _v
                        break
                except Exception:
                    pass
            if page_amt is None:
                say(13, '金额校验失败', expected=expected, actual='页面未解析到金额总计', result='FAIL', abort=True)
                await browser.close()
                return
            if abs(page_amt - float(expected)) > 0.02:
                say(13, '金额校验失败', expected=expected, actual=page_amt)
                await ybx.screenshot(path=os.path.join(LOG, f'daily_amt_fail_{stamp}.png'))
                await browser.close()
                return
            amount_ok = True
        print(f"##BILL##{bill_no or ''}", flush=True)

        # ===== N. 自动提交申请（autoSubmit：观自在全自动递交）=====
        # 四重校验（单号/金额/摘要/项目）全过才点「提交申请」；任一不过或未开 autoSubmit → 停在草稿（人工确认）。
        if not cfg.get('autoSubmit'):
            say(13, '草稿已保存（停在草稿阶段）', billNo=bill_no, expected=expected, autoSubmit=False)
        else:
            check_base = f"{form_text_snapshot}\n{all_text}"
            bill_from_form = re.search(r'报销单号[：:]\s*(4\d{6})', form_text_snapshot)
            if bill_from_form and not bill_no:
                bill_no = bill_from_form.group(1)
            summary_ok = not cfg.get('summary') or str(cfg['summary']) in check_base
            project_ok = not cfg.get('projectId') or str(cfg['projectId']) in check_base
            bill_ok = bool(bill_no) and bool(re.match(r'4\d{6}', str(bill_no)))
            checks = {'bill': bill_ok, 'amount': amount_ok, 'summary': summary_ok, 'project': project_ok}
            if not all(checks.values()):
                say(13, '四重校验未全过，停在草稿', billNo=bill_no, **checks)
                await ybx.screenshot(path=os.path.join(LOG, f'daily_autosubmit_blocked_{stamp}.png'), full_page=True)
                await browser.close()
                return
            say(13, '草稿已保存（四重校验通过，继续提交）', billNo=bill_no, expected=expected, **checks)
            # 提交协议（auto_bx_e2e_full 金标准）：草稿箱选行 → 点工具栏「修改」进编辑页 → 主 frame 的「提交申请」（按钮只在编辑页出现）
            # 保存后页面停在单据确认视图——先 reload 回智能报销首页才有「草稿」入口
            await ybx.reload(wait_until='domcontentloaded')
            await ybx.wait_for_timeout(6000)
            await ybx.evaluate(CLOSE_JS)
            await ybx.evaluate(CLICK_TEXT_JS, '草稿')
            await ybx.wait_for_timeout(6000)
            sel = 'nf'
            for _ in range(8):
                sel = await ybx.evaluate("""(bill) => {
                    for (const tr of document.querySelectorAll('tr[id]')) {
                        if ((tr.textContent || '').includes(bill)) {
                            const chk = tr.querySelector('input[type=radio], input[type=checkbox]');
                            if (chk) { chk.click(); return 'selected'; }
                        }
                    }
                    return 'no-row';
                }""", str(bill_no))
                if sel == 'selected':
                    break
                await ybx.wait_for_timeout(2500)
            mod = 'nf'
            for _ in range(10):
                mod = await ybx.evaluate("""() => { const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && e.getAttribute('btnname') === '修改'); if (b) { b.click(); return 'clicked'; } return 'nf'; }""")
                if mod == 'clicked':
                    break
                await ybx.wait_for_timeout(2500)
            say(16, '进单据修改', mod=mod)
            say(16, '进单据修改', mod=mod)
            # 等表单 iframe（bx_dtl）出现（轮询 25s）
            for _ in range(50):
                if any('bx_dtl' in f.url for f in ybx.frames):
                    break
                await ybx.wait_for_timeout(500)
            await ybx.wait_for_timeout(3000)
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
            # 提交可能触发多级弹窗（确认/提交辅助信息），逐个消化
            for _ in range(10):
                await ybx.wait_for_timeout(2500)
                c = await ybx.evaluate(CONFIRM_LOOSE_JS, ['确 定', '确定', '确认', '继 续', '继续'])
                if c == 'nf':
                    break
            # 提交成功判定：全部报销单里该单号行状态已非「草稿」
            done = False
            st = '?'
            for _ in range(3):
                await ybx.reload(wait_until='domcontentloaded')
                await ybx.wait_for_timeout(6000)
                await ybx.evaluate(CLOSE_JS)
                await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (!els.length) return 'nf'; els[0].click(); return 'ok'; }""")
                await ybx.wait_for_timeout(6000)
                st = await ybx.evaluate("""(bill) => { for (const tr of document.querySelectorAll('tr[id]')) { const t = (tr.textContent || ''); if (t.includes(bill)) return /草稿/.test(t) ? 'still-draft' : 'state-changed'; } return 'no-row'; }""", str(bill_no))
                if st == 'state-changed':
                    done = True
                    break
                await ybx.wait_for_timeout(4000)
            say(16, '提交申请', bill=bill_no, submit=sv, done=done, state=st)
            await ybx.screenshot(path=os.path.join(LOG, f'daily_submitted_{stamp}.png'), full_page=True)
            if sv != 'dispatched' or not done:
                say(16, '提交申请失败（单据停留在草稿，请人工提交）', submit=sv, state=st)
                await browser.close()
                return
            print('##SUBMITTED##1', flush=True)
            say(17, '日常报销已自动提交申请', billNo=bill_no)
            await browser.close()


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except BaseException:
        # 崩溃兜底（2026-10-16 用户要求：log 全面性——异常时也要在观自在日志里看到原因+现场截图）
        import traceback
        err = traceback.format_exc()
        print(f"#! 脚本异常 -> {err.splitlines()[-1][:200]}", flush=True)
        print(json.dumps({'step': '!', 'name': '脚本异常', 'err': err[-800:]}, ensure_ascii=False), flush=True)
        try:
            asyncio.run(CURRENT_PAGE.screenshot(path=os.path.join(LOG, f'daily_crash_{time.strftime("%H%M%S")}.png'), full_page=True))
        except Exception:
            pass
        raise
