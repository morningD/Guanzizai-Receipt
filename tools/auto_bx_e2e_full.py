#!/usr/bin/env python3
"""ECNU 智能报销无头一键端到端（最终版）：
清空指定草稿和发票池 → 上传发票 → 识别检验 → 前往报销
→ radio逐个验证 → 金额轮询 → 摘要/校区 → 支付 → 协同 → 附件6件 → 保存 → 验证。
绝不提交。
"""

import asyncio
import json
import os
import re
import time
from pathlib import Path

from playwright.async_api import async_playwright

from receipt_runtime import DATA_ROOT, launch_chromium, school_session

ROOT = DATA_ROOT
LOG_DIR = ROOT / 'data' / 'autobx_logs'

# ---- 参数化：从 --config JSON 读取（观自在线上递交管线注入）----
import argparse
_parser = argparse.ArgumentParser()
_parser.add_argument('--config', required=True)
_args, _ = _parser.parse_known_args()
CFG = json.loads(Path(_args.config).read_text(encoding='utf-8'))

def _abs(p):
    path = ROOT / p
    return path if path.exists() else ROOT / p.split('01_报销材料/')[-1].join(['01_报销材料/']) if False else path

FOLDER = ROOT  # 文件路径已绝对化/相对 ROOT，folder 仅用于断言存在
INVOICES = CFG.get('invoicePaths', [])      # 相对 ROOT 或绝对路径（submitOnly/listDrafts/cleanupOnly 模式不需要）
ATTACHMENTS = CFG.get('attachmentPaths', [])
DESC = CFG.get('attachmentDesc', '')
OLD_DRAFT = CFG.get('revokeBillNo', '')     # 可选：先撤销指定旧草稿
AMOUNT = CFG.get('totalExpected', '')       # 金额断言值（可空＝信系统显示值）
SUMMARY = CFG.get('summary', '')
PAY_REMARK = CFG.get('payRemark', '')
PAY_AMOUNT = CFG.get('payAmount', '')       # 支付金额（可空＝脚本读金额总计）
CAMPUS = CFG.get('campus', '普陀校区')
APPROVER = CFG.get('approver', '')          # 格式 工号/姓名
TRAVELER_NAME = CFG.get('travelerName') or ''
TRAVELER_SNO = CFG.get('travelerSno') or ''

def resolve_material(p):
    """配置里的材料路径：绝对路径直用，相对路径按 ROOT 解析。"""
    path = Path(p)
    return str(path if path.is_absolute() else ROOT / p)

CLOSE_JS = """() => {
    const clicked = [];
    for (const x of document.querySelectorAll('.ui-dialog-titlebar-close, .layui-layer-close')) {
        if (x.offsetParent !== null) { x.click(); clicked.push('×'); }
    }
    for (const el of document.querySelectorAll('button, a')) {
        if (el.offsetParent === null) continue;
        const t = (el.textContent || '').replace(/\\s/g, '');
        if ((t === '确定' || t === '确认' || t === '继续') && el.offsetWidth > 0) {
            if (el.closest('.ui-dialog, .layui-layer') || el.className.includes('ui-button')) { el.click(); clicked.push(t); }
        }
    }
    return clicked;
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

DISPATCH_POOL_JS = """() => {
    let el = document.getElementById('resultBX_02_2__title');
    if (!el) return 'nf';
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
    return 'dispatched';
}"""

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

POOL_COUNT_JS = """() => {
    const g = document.getElementById('gridWF_YBX_53');
    return g ? jQuery(g).jqGrid('getDataIDs').length : 0;
}"""

RADIO_CHECK_JS = """() => {
    const out = {};
    for (const n of ['o_isaphs_1', 'o_isapjt_1', 'o_isapzs_1']) {
        const no = document.querySelector(`input[name='${n}'][value='N']`);
        const yes = document.querySelector(`input[name='${n}'][value='Y']`);
        out[n] = !!(no && no.checked);
    }
    return out;
}"""

RADIO_CLICK_ONE_JS = """(n) => {
    const no = document.querySelector(`input[name='${n}'][value='N']`);
    const yes = document.querySelector(`input[name='${n}'][value='Y']`);
    if (!no) return 'nf';
    if (yes && yes.checked) { yes.click(); }
    no.click();
    // 老系统 radio 由自有 JS 管理：仅 click 改 DOM 勾选可能不触发内部同步（后端仍记"是"→补贴不发），补发事件强制同步
    for (const el of [no, yes]) {
        if (el) {
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    return 'clicked';
}"""

entries = []
shot_dir = None


EVIDENCE_DIR = LOG_DIR / 'evidence'


def log(no, name, **kw):
    e = {'ts': time.strftime('%H:%M:%S'), 'no': no, 'name': name, **kw}
    entries.append(e)
    line = f"[{e['ts']}] #{no} {name} -> {json.dumps({k: str(v)[:140] for k, v in kw.items()}, ensure_ascii=False)}"
    print(line)
    try:
        with open(EVIDENCE_DIR / 'run.log', 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except OSError:
        pass


async def ensure_pool(ybx, timeout=60):
    """确保处于发票池视图且 gridWF_YBX_53 已渲染（DISPATCH 偶发未就绪，必须重试而非单发）。"""
    for _ in range(max(1, timeout // 2)):
        if await ybx.evaluate("() => !!document.getElementById('gridWF_YBX_53')"):
            return True
        await ybx.evaluate(DISPATCH_POOL_JS)
        await ybx.wait_for_timeout(2000)
        await ybx.evaluate(CLOSE_JS)
    return False


async def annotate_failed_invoices(ybx):
    """对未识别列表中「识别出错」的项自动手工标注：config.invoiceMeta 提供票面字段
    （PDF 文本层/图片视觉模型提取），系统表单填 invoice_no/date/sale/buyer/total 后保存入池。"""
    meta = CFG.get('invoiceMeta') or {}
    if not meta:
        return 0
    r = await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span')).filter(e => e.offsetParent !== null && (e.textContent || '').includes('点击查看明细')); if (!els.length) return 'nf'; els[els.length - 1].click(); return 'ok'; }""")
    await ybx.wait_for_timeout(5000)
    if r != 'ok':
        return 0
    fixed = 0
    for fname, fields in meta.items():
        picked = await ybx.evaluate("""(name) => {
            const g = document.getElementById('gridWF_YBX_113');
            if (!g) return 'no-grid';
            const want = String(name).replace(/\\s+/g, '');
            for (const rid of jQuery(g).jqGrid('getDataIDs')) {
                const tr = document.getElementById(rid);
                if (tr && (tr.textContent || '').replace(/\\s+/g, '').includes(want)) {
                    jQuery(g).jqGrid('resetSelection');
                    jQuery(g).setSelection(rid, true);
                    return 'selected:' + rid;
                }
            }
            return 'no-row';
        }""", fname[:16])
        if not str(picked).startswith('selected'):
            log(5, '手工标注跳过（列表无此行）', name=fname, pick=picked)
            continue
        await ybx.wait_for_timeout(1000)
        await ybx.evaluate("""() => { const b = Array.from(document.querySelectorAll('button, a')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '手工标注'); if (b) b.click(); }""")
        await ybx.wait_for_timeout(4000)
        for f in ybx.frames:
            try:
                await asyncio.wait_for(f.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && Array.from(x.querySelectorAll('button')).some(b => (b.textContent || '').replace(/\\s/g, '') === '继续')); if (d) { const b = Array.from(d.querySelectorAll('button')).find(e => (e.textContent || '').replace(/\\s/g, '') === '继续'); if (b) b.click(); } }"""), 5)
                break
            except Exception:
                pass
        await ybx.wait_for_timeout(5000)
        filled = None
        for f in ybx.frames:
            try:
                filled = await asyncio.wait_for(f.evaluate("""(fields) => {
                    const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && x.querySelector('[name$="inv_type"], [id*="inv_type"]'));
                    if (!d) return 'no-dialog';
                    const sel = d.querySelector('[name$="inv_type"], [id*="inv_type"]');
                    const want = fields.invoiceType || '增值税普通发票';
                    const opt = Array.from(sel.options).find(o => o.textContent.includes(want)) || Array.from(sel.options).find(o => o.textContent.includes('增值税普通发票'));
                    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event('change', { bubbles: true })); if (window.jQuery) window.jQuery(sel).val(opt.value).trigger('change'); }
                    const set = (suffix, val) => { if (!val) return; const el = d.querySelector(`[name$='${suffix}']`); if (!el) return; el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
                    set('invoice_no', fields.invoiceNo); set('invoice_date', fields.invoiceDate);
                    set('invoice_salename', fields.saleName); set('invoice_buyname', fields.buyerName);
                    set('invoice_total', fields.total);
                    const rb = {};
                    for (const k of ['invoice_no', 'invoice_date', 'invoice_total']) { const el = d.querySelector(`[name$='${k}']`); rb[k] = el ? el.value : null; }
                    return rb;
                }""", fields), 8)
                if filled:
                    break
            except Exception:
                pass
        await ybx.wait_for_timeout(1000)
        saved = None
        for f in ybx.frames:
            try:
                saved = await asyncio.wait_for(f.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && x.querySelector('[name$="inv_type"], [id*="inv_type"]')); if (!d) return 'no-dialog'; const b = Array.from(d.querySelectorAll('button')).find(e => e.getAttribute('btnname') === '保存' || (e.textContent || '').trim() === '保存'); if (b) { b.click(); return 'clicked'; } return 'no-btn'; }"""), 5)
                if saved:
                    break
            except Exception:
                pass
        await ybx.wait_for_timeout(6000)
        # 保存后检测服务端错误（YBX_MAP_TKTYPE 映射表异常会报「更新票据数据模型字段失败」）
        err_box = await ybx.evaluate("""() => {
            const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && (x.innerText || '').includes('更新票据数据模型字段失败'));
            return d ? (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 90) : '';
        }""")
        if err_box:
            await ybx.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null && (x.innerText || '').includes('更新票据数据模型字段失败')); if (d) { const b = Array.from(d.querySelectorAll('button')).find(e => (e.textContent || '').trim() === '确认'); if (b) b.click(); } }""")
            log(5, f'手工标注 {fname} 保存失败（服务端）', err=err_box)
            continue
        log(5, f'手工标注 {fname}', fill=filled, save=saved)
        fixed += 1
    r2 = await ybx.evaluate("""() => { const b = Array.from(document.querySelectorAll('button, a')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '返回'); if (b) { b.click(); return 'ok'; } return 'nf'; }""")
    await ybx.wait_for_timeout(4000)
    if r2 != 'ok':
        await ybx.reload(wait_until='domcontentloaded')
        await ybx.wait_for_timeout(6000)
        await ybx.evaluate(CLOSE_JS)
    await ensure_pool(ybx)
    return fixed


async def diagnose_identify_queue(ybx):
    """识别检验失败时读未识别列表的出错原因并分类（只读，不清除）。
    分类：数据异常=系统拒绝解析（常见于同票号重复上传/已被草稿占用）；重复/已报销=勿重复报销。"""
    tip = await ybx.evaluate("() => { const m = (document.body.innerText || '').match(/(\\d+)张发票正在识别中/); return m ? +m[1] : 0; }")
    if not tip:
        return '队列无积压（票可能已被占用或未上传成功）'
    r = await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span')).filter(e => e.offsetParent !== null && (e.textContent || '').includes('点击查看明细')); if (!els.length) return 'nf'; els[els.length - 1].click(); return 'ok'; }""")
    await ybx.wait_for_timeout(5000)
    if r != 'ok':
        await ybx.reload(wait_until='domcontentloaded')
        await ybx.wait_for_timeout(6000)
        await ybx.evaluate(CLOSE_JS)
        await ensure_pool(ybx)
        return '未识别列表入口未找到'
    rows = await ybx.evaluate("""() => Array.from(document.querySelectorAll('tr')).map(tr => (tr.innerText || '').replace(/\\s+/g, ' ').trim()).filter(t => t.includes('识别出错') || t.includes('识别中')).slice(0, 12)""")
    # 回池
    r2 = await ybx.evaluate("""() => { const b = Array.from(document.querySelectorAll('button, a')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '返回'); if (b) { b.click(); return 'ok'; } return 'nf'; }""")
    await ybx.wait_for_timeout(3000)
    if r2 != 'ok':
        await ybx.reload(wait_until='domcontentloaded')
        await ybx.wait_for_timeout(6000)
        await ybx.evaluate(CLOSE_JS)
    await ensure_pool(ybx)
    parse_err = sum(1 for t in rows if '数据异常' in t or '无法解析' in t)
    dup = sum(1 for t in rows if '重复' in t or '已报销' in t)
    pending = sum(1 for t in rows if '识别中' in t and '出错' not in t)
    parts = []
    if parse_err:
        parts.append(f'识别出错 {parse_err} 项（数据异常无法解析——常见于同票号发票已被占用/重复上传；可在网页未识别列表「手工标注」录入票面信息，或改日重试）')
    if dup:
        parts.append(f'重复 {dup} 项（发票已报销过，勿重复报销）')
    if pending:
        parts.append(f'仍在识别中 {pending} 项')
    return '；'.join(parts) if parts else f'队列 {tip} 项（原因未分类）'


# ⚠ 已移除 purge_identify_queue：批量删除识别队列会打断 OCR 管道（经验总结三B.7），
# 识别队列积压只诊断（diagnose_identify_queue）或等系统自然消化，绝不批量删除。


async def wait_anchor(ybx, texts, timeout=60):
    """等页面渲染出任一锚点文本（老系统内容异步渲染，固定 sleep 会撞上空白页）。返回命中的锚点。"""
    for _ in range(max(1, timeout // 2)):
        body = await ybx.evaluate('() => document.body.innerText')
        for t in texts:
            if t in body:
                return t
        await ybx.wait_for_timeout(2000)
    return None


async def snapshot_state(ybx, label):
    """抓财务系统侧状态快照（草稿箱行 + 发票池行明细）落证据包；失败不阻塞主流程。"""
    data = {'label': label, 'ts': time.strftime('%H:%M:%S'), 'drafts': None, 'pool': None, 'error': None}
    try:
        await wait_anchor(ybx, ['草稿'], timeout=30)
        await ybx.evaluate(CLICK_TEXT_JS, '草稿')
        await ybx.wait_for_timeout(4000)
        await ybx.evaluate(CLOSE_JS)
        data['drafts'] = await ybx.evaluate("""() => Array.from(document.querySelectorAll('tr[id]'))
            .filter(tr => tr.closest('table[id]') && tr.offsetParent !== null)
            .map(tr => (tr.innerText || '').replace(/\\s+/g, ' ').trim()).filter(t => t && /\\d{6,}/.test(t))""")
    except Exception as exc:
        data['error'] = f'drafts: {exc}'
    try:
        await ybx.reload(wait_until='domcontentloaded')
        await ybx.wait_for_timeout(5000)
        await ybx.evaluate(CLOSE_JS)
        await ensure_pool(ybx)
        data['pool'] = await ybx.evaluate("""() => {
            const g = document.getElementById('gridWF_YBX_53');
            const out = [];
            if (g) for (const rid of jQuery(g).jqGrid('getDataIDs')) {
                const tr = document.getElementById(rid);
                if (tr) out.push((tr.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 110));
            }
            return out;
        }""")
    except Exception as exc:
        data['error'] = f'{data["error"] or ""} pool: {exc}'.strip()
    (EVIDENCE_DIR / f'state-{label}.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'[EVIDENCE] state-{label}: drafts={len(data["drafts"] or [])} pool={len(data["pool"] or [])}')
    # 回首页默认视图：快照把视图切到草稿/发票池会让后续段找不到自己的锚点
    try:
        await ybx.reload(wait_until='domcontentloaded')
        await ybx.wait_for_timeout(4000)
        await ybx.evaluate(CLOSE_JS)
    except Exception:
        pass


def finish_evidence(mode, status, bill=None):
    """一页纸诊断卡：模式/config/步骤时间线/终态。始终输出 ##EVIDENCE## 供后端捕获。"""
    summary = {
        'ts': time.strftime('%Y-%m-%d %H:%M:%S'), 'mode': mode, 'status': status, 'billNo': bill,
        'config': CFG, 'steps': entries,
        'files': sorted(p.name for p in EVIDENCE_DIR.iterdir()) if EVIDENCE_DIR.exists() else [],
    }
    try:
        (EVIDENCE_DIR / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    except OSError:
        pass
    print(f'##EVIDENCE##{EVIDENCE_DIR}')


async def shot(page, no, name):
    try:
        await page.screenshot(path=str(shot_dir / f'{no:02d}_{name[:12]}.png'))
    except Exception:
        pass


# ---- 失败诊断：统一 abort 出口，自动留 失败瞬间截图 + 全帧 DOM + 帧树（纯离线文件，无头，无常驻） ----
async def dump_page_state(ybx, dump_dir):
    dump_dir.mkdir(parents=True, exist_ok=True)
    meta = {'url': ybx.url, 'frames': []}
    for i, f in enumerate(ybx.frames):
        meta['frames'].append({'index': i, 'name': f.name, 'url': f.url})
        try:
            html = await asyncio.wait_for(f.content(), 8)
        except Exception:
            html = '<!-- content() 超时/失败 -->'
        tail = f.url.rstrip('/').split('/')[-1][:40] or f'frame{i}'
        safe = re.sub(r'[^A-Za-z0-9_-]', '_', tail)
        (dump_dir / f'frame{i:02d}_{safe}.html').write_text(html, encoding='utf-8')
    (dump_dir / 'frames.json').write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding='utf-8')
    return dump_dir


async def abort_exit(ybx, no, name, reason):
    """统一失败出口：FAIL 日志 + 失败瞬间截图 + 全帧 DOM dump，供事后离线诊断（Agent 看 dump 文件分析）。"""
    log(no, name, result=f'FAIL {reason}', abort=True)
    await shot(ybx, no, f'{name[:10]}-fail')
    try:
        await snapshot_state(ybx, f'{no:02d}-abort')
    except Exception:
        pass
    finish_evidence(MODE, f'FAIL #{no} {name}: {reason}')
    dump_dir = LOG_DIR / 'dumps' / f"{time.strftime('%Y%m%d_%H%M%S')}_{no:02d}_{name[:12]}"
    try:
        await dump_page_state(ybx, dump_dir)
        print(f'[DIAG] dump={dump_dir}')
    except Exception as dump_err:
        print(f'[DIAG] dump 失败: {dump_err}')
    await ybx.context.browser.close()
    raise SystemExit(1)


async def wait_form_frame(ybx, tries=10):
    for _ in range(tries):
        for f in ybx.frames:
            try:
                if await asyncio.wait_for(f.evaluate("() => document.body && document.body.innerText.includes('点击修改信息')"), 3):
                    return f
            except Exception:
                pass
        c = await ybx.evaluate(CLOSE_JS)
        if c:
            await ybx.wait_for_timeout(500)
        await asyncio.sleep(1)
    return None


async def main():
    global shot_dir, MODE, EVIDENCE_DIR
    stamp = time.strftime('%Y%m%d_%H%M%S')
    MODE = 'submitOnly' if CFG.get('submitOnly') else 'listDrafts' if CFG.get('listDrafts') else 'cleanupOnly' if CFG.get('cleanupOnly') else 'full'
    shot_dir = LOG_DIR / 'shots' / f'e2e_{stamp}'
    shot_dir.mkdir(parents=True, exist_ok=True)
    EVIDENCE_DIR = LOG_DIR / 'evidence' / f'{stamp}_{MODE}'
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    for f in INVOICES + ATTACHMENTS:
        assert os.path.exists(resolve_material(f)), f'不存在: {f}'

    session = school_session("treasury")
    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=True)
        ctx = await browser.new_context(storage_state=str(session) if session.exists() else None,
                                        viewport={'width': 1600, 'height': 1000})
        page = await ctx.new_page()
        page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))

        await page.goto('https://treasury.ecnu.edu.cn/WFManager/home2.jsp', wait_until='domcontentloaded')
        await page.wait_for_timeout(5000)
        if '预约报销' not in (await page.evaluate('() => document.body.innerText')):
            from ecnu_treasury import get_credentials, auto_login_and_save
            u, pw = get_credentials()
            await auto_login_and_save(u, pw)
            await ctx.close()
            ctx = await browser.new_context(storage_state=str(session) if session.exists() else None,
                                            viewport={'width': 1600, 'height': 1000})
            page = await ctx.new_page()
            page.on('dialog', lambda d: asyncio.ensure_future(d.accept()))
            await page.goto('https://treasury.ecnu.edu.cn/WFManager/home2.jsp', wait_until='domcontentloaded')
            await page.wait_for_timeout(5000)
        log(0, '登录', result='OK')

        async with ctx.expect_page(timeout=15000) as pi:
            await page.evaluate("""() => { const a = Array.from(document.querySelectorAll('a'))
                .find(a => a.textContent.trim() === '智能报销' && (a.href || '').includes('navToPrj')); if (a) a.click(); }""")
        ybx = await pi.value
        await ybx.wait_for_load_state('domcontentloaded')
        # 老系统内容异步渲染（实测最长 10s+ 才出锚点），固定 sleep 会撞上空白页
        anchor = await wait_anchor(ybx, ['草稿', '申请报销', '我的发票'])
        for _ in range(10):
            if not await ybx.evaluate(CLOSE_JS):
                break
            await ybx.wait_for_timeout(500)
        if not anchor:
            anchor = await wait_anchor(ybx, ['草稿', '申请报销', '我的发票'], timeout=20)
        log(1, '智能报销tab', url=ybx.url[:50], anchor=anchor)
        if not anchor:
            await abort_exit(ybx, 1, '智能报销tab', '页面渲染超时（无锚点）')
            return
        await snapshot_state(ybx, '1-before')

        # ===== A0. 清空识别出错队列（每次递交前的固定前置）——出错票（如票据重复性检查失败）永不成功，
        # 占着「N张发票正在识别中」提示且可能干扰池状态；只删「识别出错」行，识别中/正常票不受影响。
        # 历史教训修正：旧规「绝不批量删除识别队列」针对的是把正常识别票一并删掉打断 OCR 管道；
        # 出错行按行文本精确过滤 + jqGrid setSelection + 确认按钮「继续」，实测安全（2026-09-12 清 6 条）。
        async def clear_failed_identify_queue():
            try:
                tip = await ybx.evaluate("() => { const m = (document.body.innerText || '').match(/(\\d+)张发票正在识别中/); return m ? +m[1] : 0; }")
                if not tip:
                    return '队列空'
                r = await ybx.evaluate("""() => { const els = Array.from(document.querySelectorAll('span')).filter(e => e.offsetParent !== null && (e.textContent || '').includes('点击查看明细')); if (!els.length) return 'nf'; els[els.length - 1].click(); return 'ok'; }""")
                await ybx.wait_for_timeout(5000)
                if r != 'ok':
                    return '明细入口未找到'
                for _ in range(4):
                    sel = await ybx.evaluate("""() => {
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
                    }""")
                    if sel == 'no-rows':
                        break
                    await ybx.wait_for_timeout(800)
                    await ybx.evaluate("""() => {
                        const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '批量删除');
                        if (b) b.click();
                    }""")
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
                # 回池
                await ybx.evaluate("""() => { const b = Array.from(document.querySelectorAll('button, a')).find(e => e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '返回'); if (b) b.click(); }""")
                await ybx.wait_for_timeout(3000)
                await ybx.evaluate(CLOSE_JS)
                if not await ensure_pool(ybx):
                    return '回池失败（不影响开单，继续）'
                tip2 = await ybx.evaluate("() => { const m = (document.body.innerText || '').match(/(\\d+)张发票正在识别中/); return m ? +m[1] : 0; }")
                return f'清空完成，提示条 {tip} -> {tip2}'
            except Exception as e:
                return f'清理异常（不阻塞递交）: {str(e)[:80]}'

        clear_q = await clear_failed_identify_queue()
        log(1.2, '清识别出错队列', result=clear_q)
        await ensure_pool(ybx)

        # ===== A--. fixTripsOnly：只修行程（单测模式）——进池→扫描缺行程→逐行修复→打印结果退出。不开单不撤旧不清池 =====
        if CFG.get('fixTripsOnly'):
            net_log = []
            ybx.on('response', lambda r: net_log.append(f'{r.status} {r.request.method} {r.url[-80:]}') if r.request.method == 'POST' else None)
            await ybx.reload(wait_until='domcontentloaded')
            await ybx.wait_for_timeout(6000)
            await ybx.evaluate(CLOSE_JS)
            if not await ensure_pool(ybx):
                await abort_exit(ybx, 3, 'fixTripsOnly', '发票池视图丢失')
                return
            async def ft_close_dialogs():
                for _ in range(6):
                    if not await ybx.evaluate(CLOSE_JS):
                        break
                    await ybx.wait_for_timeout(400)
            total_fixed = 0
            for round_i in range(3):
                bad = await ybx.evaluate("""() => {
                    const g = document.getElementById('gridWF_YBX_53');
                    const out = [];
                    if (g) for (const rid of jQuery(g).jqGrid('getDataIDs')) {
                        const tr = document.getElementById(rid);
                        if (tr && tr.querySelector('td.cont_tipword_ERROR')) {
                            const m = (tr.textContent || '').match(/(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})/);
                            out.push({ rid, date: m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null });
                        }
                    }
                    return out;
                }""")
                log(4, f'fixTripsOnly 缺行程扫描(轮{round_i + 1})', rows=[b['rid'] for b in bad])
                if not bad:
                    break
                for row in bad:
                    if not row['date']:
                        raise ValueError('行程日期解析失败，请核对原始票据')
                    date = row['date']
                    opened = False
                    for f in ybx.frames:
                        try:
                            await asyncio.wait_for(f.evaluate(f"() => {{ const td = document.querySelector('[id=\"{row['rid']}\"] td.cont_tipword_ERROR'); if (td) td.click(); }}"), 5)
                            break
                        except Exception:
                            pass
                    await ybx.wait_for_timeout(5000)
                    for f in ybx.frames:
                        try:
                            await asyncio.wait_for(f.evaluate("""() => {
                                const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                                if (!dlgEl) return;
                                const b = Array.from(dlgEl.querySelectorAll('button.winBtn')).find(e => (e.textContent || '').replace(/\\s/g, '') === '修改行程');
                                if (b) b.click();
                            }"""), 5)
                            break
                        except Exception:
                            pass
                    for _ in range(16):
                        alive = False
                        for f in ybx.frames:
                            try:
                                if await asyncio.wait_for(f.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null && d.innerText.includes('乘坐人')); return d ? 1 : 0; }"""), 2):
                                    alive = True
                                    break
                            except Exception:
                                pass
                        if alive:
                            opened = True
                            break
                        await asyncio.sleep(0.5)
                    log(5, f"{row['rid']} 行程弹窗", opened=opened)
                    if not opened:
                        await ft_close_dialogs()
                        continue
                    filled = None
                    for f in ybx.frames:
                        try:
                            filled = await asyncio.wait_for(f.evaluate(f"""() => {{
                                const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null && d.innerText.includes('乘坐人'));
                                if (!dlgEl) return null;
                                const set = (suffix, val) => {{
                                    const el = dlgEl.querySelector(`[name$='${{suffix}}']`);
                                    if (!el) return 'nf';
                                    el.value = val;
                                    el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                                    el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                                    if (window.jQuery) {{ window.jQuery(el).val(val).trigger('change'); }}
                                    return el.value === val ? 'ok' : 'mm:' + el.value;
                                }};
                                const seat = dlgEl.querySelector("[name$='t-tour_seatclass_0']");
                                let seatR = 'nf';
                                if (seat) {{
                                    const opt = Array.from(seat.options).find(o => o.textContent.includes('经济舱'));
                                    if (opt) {{
                                        seat.value = opt.value;
                                        seat.dispatchEvent(new Event('change', {{ bubbles: true }}));
                                        if (window.jQuery) {{ window.jQuery(seat).val(opt.value).trigger('change'); }}
                                        seatR = seat.value === opt.value ? 'ok' : 'fail';
                                    }}
                                }}
                                return {{ who: set('t-passenger_sname_0', '{TRAVELER_NAME}'), sno: set('t-passenger_sno_0', '{TRAVELER_SNO}'),
                                    start: set('t-tour_startdate_0', '{date}'), end: set('t-tour_enddate_0', '{date}'),
                                    startT: set('t-tour_starttime_0', '10:00'), endT: set('t-tour_endtime_0', '12:00'), seat: seatR }};
                            }}"""), 6)
                            if filled:
                                break
                        except Exception:
                            pass
                    await ybx.wait_for_timeout(1000)
                    closed = None
                    saved = None
                    for attempt in range(3):
                        for f in ybx.frames:
                            try:
                                saved = await asyncio.wait_for(f.evaluate("""() => {
                                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                                        d.offsetParent !== null && d.innerText.includes('乘坐人'));
                                    if (!dlgEl) return 'no-dialog';
                                    const b = Array.from(dlgEl.querySelectorAll('button')).find(e =>
                                        e.getAttribute('btnname') === '保存');
                                    if (!b) return 'no-btn';
                                    const o = { bubbles: true, cancelable: true, view: window };
                                    b.dispatchEvent(new MouseEvent('mousedown', o));
                                    b.dispatchEvent(new MouseEvent('mouseup', o));
                                    b.dispatchEvent(new MouseEvent('click', o));
                                    b.click();
                                    return 'dispatched';
                                }"""), 5)
                                if saved:
                                    break
                            except Exception:
                                pass
                        for i in range(6):
                            await asyncio.sleep(0.5)
                            alive = False
                            for f in ybx.frames:
                                try:
                                    if await asyncio.wait_for(f.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null && d.innerText.includes('乘坐人')); return d ? 1 : 0; }"""), 2):
                                        alive = True
                                        break
                                except Exception:
                                    pass
                            if not alive:
                                closed = round((i + 1) * 0.5, 1)
                                break
                        if closed is not None:
                            break
                        log(5, f"{row['rid']} 保存未关窗，重试", attempt=attempt + 1, save=saved, net=net_log[-4:])
                        await ybx.wait_for_timeout(1500)
                    if closed is not None:
                        total_fixed += 1
                        log(5, f"{row['rid']} 行程保存", save=saved, closed=closed, fill=filled)
                    else:
                        log(5, f"{row['rid']} 行程保存失败", save=saved, fill=filled, net=net_log[-8:])
                    await ft_close_dialogs()
                    await ybx.wait_for_timeout(1000)
                if bad:
                    await ybx.reload(wait_until='domcontentloaded')
                    await ybx.wait_for_timeout(6000)
                    await ft_close_dialogs()
                    await ensure_pool(ybx)
            remaining = await ybx.evaluate("""() => { const g = document.getElementById('gridWF_YBX_53'); if (!g) return -1; let n = 0; for (const rid of jQuery(g).jqGrid('getDataIDs')) { const tr = document.getElementById(rid); if (tr && tr.querySelector('td.cont_tipword_ERROR')) n++; } return n; }""")
            await shot(ybx, 5, 'fixtrips-only-done')
            log(9, 'fixTripsOnly 完成', fixed=total_fixed, remaining=remaining)
            await browser.close()
            print(f'\n== fixTripsOnly：修复 {total_fixed} 张，剩缺行程 {remaining} 张（net POST {len(net_log)} 条）==')
            return


        # ===== A-. 仅列草稿模式：抓草稿箱清单（摘要重复检查），输出 ##DRAFTS## JSON 后退出 =====
        if CFG.get('listDrafts'):
            if '草稿' not in (await ybx.evaluate('() => document.body.innerText')):
                await wait_anchor(ybx, ['草稿'], timeout=30)
            if await ybx.evaluate(CLICK_TEXT_JS, '草稿') == 'nf':
                print('##DRAFTS##[]')
                finish_evidence(MODE, 'FAIL no-draft-entry')
                await browser.close()
                return
            await ybx.wait_for_timeout(5000)
            await ybx.evaluate(CLOSE_JS)
            # 概览卡的「您有 N 笔报销单待完成」是权威总数——rows 抓取失败但 N>0 = 解析失败（非真空箱）
            draft_count = 0
            for _ in range(6):
                rows = await ybx.evaluate("""() => Array.from(document.querySelectorAll('tr[id]'))
                    .filter(tr => tr.closest('table[id]') && tr.offsetParent !== null)
                    .map(tr => ({ id: tr.id, text: (tr.innerText || '').replace(/\\s+/g, ' ').trim() }))
                    .filter(r => r.text && /\\d{6,}/.test(r.text))""")
                if rows:
                    break
                m_count = re.search(r'您有(\d+)笔报销单待完成', (await ybx.evaluate('() => document.body.innerText')) or '')
                draft_count = int(m_count.group(1)) if m_count else 0
                if not draft_count:
                    break
                await ybx.wait_for_timeout(3000)
                await ybx.evaluate(CLOSE_JS)
            print('##DRAFTCOUNT##' + str(max(len(rows), draft_count if not rows else 0)))
            print('##DRAFTS##' + json.dumps(rows, ensure_ascii=False))
            await browser.close()
            print('== 草稿清单抓取完成 ==')
            return

        # ===== A0. 仅提交模式：按单号进草稿箱提交申请（「确认递交」动作）=====
        # 与 N 段同款：进草稿箱带锚点验证 + 行级三断言（单号+金额+摘要同行才选中）
        if CFG.get('submitOnly'):
            SUBMIT_BILL = str(CFG.get('submitBillNo', ''))
            SUB_ROW_AMT = str(AMOUNT or CFG.get('expensesTotal') or '').replace(',', '')
            SUB_ROW_SUM = (SUMMARY or '')[:12].replace(' ', '')
            sel = 'nf'
            for a0_attempt in range(3):
                if '草稿' not in (await ybx.evaluate('() => document.body.innerText')):
                    await wait_anchor(ybx, ['草稿'], timeout=30)
                # 入口点击轮询重试（同 A 段教训：慢渲染时单次 click 会假 nf）
                clk0 = 'nf'
                for _ in range(8):
                    clk0 = await ybx.evaluate(CLICK_TEXT_JS, '草稿')
                    if clk0 != 'nf':
                        break
                    await ybx.wait_for_timeout(3000)
                if clk0 == 'nf':
                    await abort_exit(ybx, 0, '确认递交', '页面无「草稿」入口（渲染失败）')
                    return
                await ybx.wait_for_timeout(5000)
                await ybx.evaluate(CLOSE_JS)
                sel = await ybx.evaluate("""(args) => {
                    const amt = String(args[1]);
                    const sum = String(args[2]);
                    for (const tr of document.querySelectorAll('tr[id]')) {
                        const t = (tr.textContent || '').replace(/\\s+/g, '');
                        if (!t.includes(args[0])) continue;
                        const norm = t.replace(/,/g, '');
                        const amtOk = !amt || norm.includes(amt);
                        const sumOk = !sum || norm.includes(sum);
                        if (!amtOk || !sumOk) return 'row-mismatch:amt=[' + amt + ']sum=[' + sum + ']amtOk=' + amtOk + ' sumOk=' + sumOk + ' bill=[' + args[0] + ']';
                        const grid = tr.closest('table[id]');
                        jQuery('#' + grid.id).jqGrid('resetSelection');
                        jQuery('#' + grid.id).setSelection(tr.id, true);
                        return 'selected';
                    }
                    return 'no-row';
                }""", [SUBMIT_BILL, SUB_ROW_AMT, SUB_ROW_SUM])
                if sel == 'selected':
                    break
                log(0, '草稿箱选行未中，重试', attempt=a0_attempt + 1, sel=sel)
                await ybx.reload(wait_until='domcontentloaded')
                await ybx.wait_for_timeout(6000)
            await ybx.wait_for_timeout(1500)
            sv = 'nf'
            if sel == 'selected':
                # 草稿箱无提交按钮：点「修改」进单据编辑页，再点主 frame 的 btnname=提交申请（winBtn）
                mod = await ybx.evaluate("""() => { const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && e.getAttribute('btnname') === '修改'); if (b) { b.click(); return 'clicked'; } return 'nf'; }""")
                log(9, '进单据修改', mod=mod)
                ff = await wait_form_frame(ybx, 25)
                if not ff:
                    await abort_exit(ybx, 9, '确认递交', '修改后表单 iframe 未出现')
                    return
                await ybx.wait_for_timeout(3000)
                sv = await ybx.evaluate("""() => {
                    const b = Array.from(document.querySelectorAll('button')).find(e => e.offsetParent !== null && e.getAttribute('btnname') === '提交申请');
                    if (!b) return 'no-btn';
                    const o = { bubbles: true, cancelable: true, view: window };
                    b.dispatchEvent(new MouseEvent('mousedown', o));
                    b.dispatchEvent(new MouseEvent('mouseup', o));
                    b.dispatchEvent(new MouseEvent('click', o));
                    b.click();
                    return 'dispatched';
                }""")
                # 提交可能触发多级弹窗（确认/提交辅助信息），逐个消化
                for _ in range(8):
                    await ybx.wait_for_timeout(2500)
                    c = await ybx.evaluate(CONFIRM_LOOSE_JS, ['确 定', '确定', '确认', '继 续', '继续'])
                    if c == 'nf':
                        break
            # 提交成功判定：全部报销单里该单号行状态已非「草稿」（实证：变为「协同人」+流程实例号）
            done = False
            st = '?'
            for _ in range(3):
                await ybx.reload(wait_until='domcontentloaded')
                await ybx.wait_for_timeout(6000)
                await ybx.evaluate(CLOSE_JS)
                await ybx.evaluate("() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (!els.length) return 'nf'; els[0].click(); return 'ok'; }")
                await ybx.wait_for_timeout(6000)
                st = await ybx.evaluate(f"""(bill) => {{ for (const tr of document.querySelectorAll('tr[id]')) {{ const t = (tr.textContent || ''); if (t.includes(bill)) return /草稿/.test(t) ? 'still-draft' : 'state-changed'; }} return 'no-row'; }}""", SUBMIT_BILL)
                if st == 'state-changed':
                    done = True
                    break
                await ybx.wait_for_timeout(4000)
            log(9, '提交草稿', select=sel, submit=sv, done=done, state=st)

            if sel != 'selected' or sv != 'dispatched' or not done:
                await abort_exit(ybx, 9, '提交草稿', f'sel={sel} submit={sv} done={done}')
                return
            await shot(ybx, 9, 'submitted')
            await browser.close()
            print('\n== 草稿已提交申请 ==')
            return

        # ===== A. 撤销旧草稿（配置了才执行）：优先按单号，未给单号时按摘要匹配（防重交竞态——查重未就绪也能撤旧）=====
        if OLD_DRAFT or CFG.get('revokeSummary'):
            REVOKE_MATCH = str(OLD_DRAFT or CFG.get('revokeSummary', ''))
    # ===== A. 撤销旧草稿 =====
            # 入口点击轮询重试：页面慢渲染/中途 reload 时单次 click 会假 nf（2026-09-18 实证），60s 内每 3s 重试。
            clk = 'nf'
            for _ in range(20):
                clk = await ybx.evaluate(CLICK_TEXT_JS, '草稿')
                if clk != 'nf':
                    break
                await ybx.wait_for_timeout(3000)
            await ybx.wait_for_timeout(5000)
            await ybx.evaluate(CLOSE_JS)
            if clk == 'nf':
                await abort_exit(ybx, 2, '撤销旧草稿', '页面无「草稿」入口（渲染失败）')
                return
            REVOKE_AMT = str(CFG.get('expensesTotal') or '')
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
            rv = 'skipped'
            if sel == 'selected':
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
            revoked = sel == 'selected' and rv == 'native-clicked'
            if revoked:
                # 撤销发生才 reload 复核；no-row 时当前就在草稿箱视图，直接判 gone（省 ~20s）
                await ybx.reload(wait_until='domcontentloaded')
                await ybx.wait_for_timeout(6000)
                await ybx.evaluate(CLOSE_JS)
                if '草稿' not in (await ybx.evaluate('() => document.body.innerText')):
                    await wait_anchor(ybx, ['草稿'], timeout=20)
                for _ in range(10):
                    if await ybx.evaluate(CLICK_TEXT_JS, '草稿') != 'nf':
                        break
                    await ybx.wait_for_timeout(2000)
                await ybx.wait_for_timeout(4000)
            gone = await ybx.evaluate(f"() => !((document.body.innerText || '').replace(/\\s+/g, '')).includes('{REVOKE_MATCH}')")
            await snapshot_state(ybx, '2-after-revoke')
            log(2, '撤销旧草稿', select=sel, revoke=rv, gone=gone)
            if not gone:
                await abort_exit(ybx, 2, '撤销旧草稿', '草稿仍在')
                return

        # ===== B. 清空发票池 =====
        # 回首页视图（草稿视图下 dispatch 开池不稳定）
        await ybx.reload(wait_until='domcontentloaded')
        await ybx.wait_for_timeout(6000)
        await ybx.evaluate(CLOSE_JS)
        await ensure_pool(ybx)
        await ybx.wait_for_timeout(2000)
        n0 = await ybx.evaluate(POOL_COUNT_JS)
        # 撤销草稿后发票释放有延迟 → 仅在撤销实际发生时轮询等待回池
        if not revoked:
            log(3, '进发票池', rows=n0, note='无撤销，跳过回池等待')
        else:
            for _ in range(12):
                if n0 >= 4:
                    break
                await ybx.wait_for_timeout(5000)
                await ybx.evaluate(DISPATCH_POOL_JS)
                await ybx.wait_for_timeout(8000)
                n0 = await ybx.evaluate(POOL_COUNT_JS)
            log(3, '进发票池', rows=n0)
        if n0 > 0:
            await ybx.evaluate("""() => {
                const g = document.getElementById('gridWF_YBX_53');
                let n = 0;
                for (const cb of g.querySelectorAll('input[type=checkbox]')) {
                    if (!cb.checked) { cb.click(); n++; }
                }
            }""")
            await ybx.wait_for_timeout(1500)
            r = await ybx.evaluate("""() => {
                const b = Array.from(document.querySelectorAll('button, a, input')).find(e =>
                    e.offsetParent !== null && ((e.getAttribute('btnname') || '').includes('删除') ||
                    (e.textContent || e.value || '').replace(/\\s/g, '') === '批量删除'));
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
            await ybx.wait_for_timeout(5000)
            await ybx.evaluate(CLOSE_JS)
            await ybx.reload(wait_until='domcontentloaded')
            await ybx.wait_for_timeout(6000)
            await ybx.evaluate(CLOSE_JS)
            await ybx.evaluate(DISPATCH_POOL_JS)
            await ybx.wait_for_timeout(6000)
            await ybx.evaluate(CLOSE_JS)
            n1 = await ybx.evaluate(POOL_COUNT_JS)
            log(4, '清空发票池', before=n0, click=r, confirm=c, after=n1)
            if n1 != 0:
                await abort_exit(ybx, 4, '清空发票池', f'池仍有 {n1} 行')
                return

        # ===== B2. 仅清理模式：撤销旧草稿+清空发票池后退出（不重新开单）=====
        if CFG.get('cleanupOnly'):
            log(4, '清理完成', mode='cleanup-only')
            await shot(ybx, 4, 'cleanup-done')
            await browser.close()
            print('\n== 清理完成（已撤销旧草稿并清空发票池）==')
            return

        # ===== C. 上传 4 张发票 =====
        btn = 'nf'
        for _ in range(12):
            btn = await ybx.evaluate("""() => {
                const b = Array.from(document.querySelectorAll('button, a, input')).find(e =>
                    e.offsetParent !== null && ((e.getAttribute('btnname') || '').includes('上传') ||
                    (e.textContent || e.value || '').replace(/\\s/g, '') === '上传发票'));
                if (b) { b.click(); return 'native:' + b.tagName; }
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
            await abort_exit(ybx, 5, '上传发票', f'file input 未出现 btn={btn}')
            return
        await ybx.evaluate("""() => { document.querySelectorAll('input[type=file]')[0].id = '__e2e_up__'; }""")
        paths = [resolve_material(f) for f in INVOICES]
        await ybx.locator('#__e2e_up__').set_input_files(paths)
        await ybx.wait_for_timeout(1500)
        r = await ybx.evaluate(CLICK_TEXT_JS, '保存发票')
        # 轮询识别：发票 OCR 异步完成，识别中的票不在列表里——检测提示条并 reloadGrid 重查（不能 reload 页面，会跳出发票池视图）；窗口 ~3 分钟。
        IDENTIFY_JS = """() => {
            const identifying = ((document.body.innerText || '').match(/(\\d+)张发票正在识别中/) || [])[1];
            const rows = [];
            const grid = document.getElementById('gridWF_YBX_53');
            if (grid) {
                for (const rid of jQuery(grid).jqGrid('getDataIDs')) {
                    const tr = document.getElementById(rid);
                    if (tr) rows.push((tr.textContent || ''));
                }
            }
            if (rows.length >= 4) return 'OK:' + rows.filter(t => t.includes('正常')).length + '/' + rows.length;
            return 'wait:' + rows.length + (identifying ? '+识别中' + identifying : '');
        }"""
        check = {}
        # 识别检验两轮：第一轮失败且诊断为「识别出错」时，用 config.invoiceMeta 自动手工标注后重检。
        # 窗口 8 分钟/轮：「识别中N」是系统级 OCR 队列计数，以池行数=4 为准；wait:0 且无计数连续 5 次快速失败。
        for attempt in range(2):
            stale = 0
            for i in range(60):
                await ybx.wait_for_timeout(8000)
                await ybx.evaluate(CLOSE_JS)
                check = await ybx.evaluate(IDENTIFY_JS)
                if str(check).startswith('OK'):
                    break
                if str(check) == 'wait:0':
                    stale += 1
                    if stale >= 5:
                        break
                else:
                    stale = 0
                if i and i % 4 == 3:
                    await ybx.evaluate("() => { try { jQuery('#gridWF_YBX_53').trigger('reloadGrid'); } catch (e) {} }")
            if str(check).startswith('OK:4'):
                break
            try:
                diag = await diagnose_identify_queue(ybx)
            except Exception as diag_err:
                diag = f'诊断失败: {str(diag_err)[:60]}'
            log(5, '识别诊断', diag=str(diag)[:120], attempt=attempt + 1)
            if attempt == 0 and ('识别出错' in str(diag) or '数据异常' in str(diag)) and CFG.get('invoiceMeta'):
                try:
                    fixed = await annotate_failed_invoices(ybx)
                    if fixed:
                        continue
                except Exception as anno_err:
                    log(5, '自动手工标注失败', err=str(anno_err)[:80])
            await abort_exit(ybx, 5, '识别检验', f'{check}；{diag}')
            return
        await snapshot_state(ybx, '5-after-upload')

        # ===== C2. 修复缺行程的机票（新上传机票默认"出行人不能为空"）=====
        # CDP 实证（2026-09-02）：①行程缺失判定用 td.cont_tipword_ERROR class（reload 后仍可靠，
        #   行文本"出行人不能为空"在 reload 后会消失→假成功）；②部分票保存行程时框架
        #   btnClickFunc 抛 "reading 'func'"、请求未发出且弹窗假关闭——保存后必须复查，
        #   仍开则走「非行程票确认→继续」（系统接受该票为非行程票，前往报销校验可过）；
        # ③终验以「前往报销」系统校验为准（跳转开单页=全好，弹"行程存在错误信息"则回修）。
        async def trip_error_rows():
            return await ybx.evaluate("""() => {
                const g = document.getElementById('gridWF_YBX_53');
                const out = [];
                if (g) for (const rid of jQuery(g).jqGrid('getDataIDs')) {
                    const tr = document.getElementById(rid);
                    if (tr && tr.querySelector('td.cont_tipword_ERROR')) {
                        const m = (tr.textContent || '').match(/(\\d{4})\\/(\\d{1,2})\\/(\\d{1,2})/);
                        out.push({ rid, date: m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null });
                    }
                }
                return out;
            }""")

        async def close_all_dialogs():
            for _ in range(6):
                if not await ybx.evaluate(CLOSE_JS):
                    break
                await ybx.wait_for_timeout(400)

        async def fix_one_trip(row):
            """修一张票的行程：填表保存；弹窗仍开（func 异常假关闭路径）则非行程票确认。"""
            if not row['date']:
                raise ValueError('行程日期解析失败，请核对原始票据')
            date = row['date']
            for f in ybx.frames:
                try:
                    await asyncio.wait_for(f.evaluate(f"() => {{ const td = document.querySelector('[id=\"{row['rid']}\"] td.cont_tipword_ERROR'); if (td) td.click(); }}"), 5)
                    break
                except Exception:
                    pass
            await ybx.wait_for_timeout(5000)
            for f in ybx.frames:
                try:
                    await asyncio.wait_for(f.evaluate("""() => {
                        const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                        if (!dlgEl) return;
                        const b = Array.from(dlgEl.querySelectorAll('button.winBtn')).find(e =>
                            (e.textContent || '').replace(/\\s/g, '') === '修改行程');
                        if (b) b.click();
                    }"""), 5)
                    break
                except Exception:
                    pass
            opened = False
            for _ in range(16):
                alive = False
                for f in ybx.frames:
                    try:
                        n = await asyncio.wait_for(f.evaluate("""() => {
                            const d = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                                d.offsetParent !== null && d.innerText.includes('乘坐人'));
                            return d ? 1 : 0;
                        }"""), 2)
                        if n:
                            alive = True
                            break
                    except Exception:
                        pass
                if alive:
                    opened = True
                    break
                await asyncio.sleep(0.5)
            if not opened:
                log(5, '行程弹窗打开失败', row=row['rid'])
                await close_all_dialogs()
                return 'no-dialog'
            filled = None
            for f in ybx.frames:
                try:
                    filled = await asyncio.wait_for(f.evaluate(f"""() => {{
                        const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null &&
                            d.innerText.includes('乘坐人'));
                        if (!dlgEl) return null;
                        const set = (suffix, val) => {{
                            const el = dlgEl.querySelector(`[name$='${{suffix}}']`);
                            if (!el) return 'nf';
                            if (val === '' || val == null) return 'empty';
                            el.value = val;
                            el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                            el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                            if (window.jQuery) {{ window.jQuery(el).val(val).trigger('change'); }}
                            return el.value === val ? 'ok' : 'mm:' + el.value;
                        }};
                        const seat = dlgEl.querySelector("[name$='t-tour_seatclass_0']");
                        let seatR = 'nf';
                        if (seat) {{
                            const opt = Array.from(seat.options).find(o => o.textContent.includes('经济舱'));
                            if (opt) {{
                                seat.value = opt.value;
                                seat.dispatchEvent(new Event('change', {{ bubbles: true }}));
                                if (window.jQuery) {{ window.jQuery(seat).val(opt.value).trigger('change'); }}
                                seatR = seat.value === opt.value ? 'ok' : 'fail:' + (seat.getAttribute('aria-invalid') || 'empty');
                            }}
                        }}
                        const readback = {{}};
                        for (const el of dlgEl.querySelectorAll('[name$="_0"]')) {{
                            const n = (el.name || '').split('-').pop();
                            if (n) readback[n] = el.tagName === 'SELECT' ? el.value : (el.value || '').slice(0, 20);
                        }}
                        return {{ who: set('t-passenger_sname_0', '{TRAVELER_NAME}'), sno: set('t-passenger_sno_0', '{TRAVELER_SNO}'),
                            start: set('t-tour_startdate_0', '{date}'), end: set('t-tour_enddate_0', '{date}'),
                            startT: set('t-tour_starttime_0', '10:00'), endT: set('t-tour_endtime_0', '12:00'), seat: seatR }};
                    }}"""), 6)
                    if filled:
                        break
                except Exception:
                    pass
            # 保存：func 异常（框架 btnClickFunc 瞬时未就绪）会致点了没反应——未关窗则重试保存，最多 3 次
            # 点击用完整鼠标事件序列（mousedown/mouseup/click）：保存类按钮框架逻辑挂内联 onmousedown/onmouseup，裸 click() 会静默失败（经验总结 §一/§〇）
            closed = None
            saved = None
            for attempt in range(3):
                for f in ybx.frames:
                    try:
                        saved = await asyncio.wait_for(f.evaluate("""() => {
                            const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                                d.offsetParent !== null && d.innerText.includes('乘坐人'));
                            if (!dlgEl) return 'no-dialog';
                            const b = Array.from(dlgEl.querySelectorAll('button')).find(e =>
                                e.getAttribute('btnname') === '保存');
                            if (!b) return 'no-btn';
                            const o = { bubbles: true, cancelable: true, view: window };
                            b.dispatchEvent(new MouseEvent('mousedown', o));
                            b.dispatchEvent(new MouseEvent('mouseup', o));
                            b.dispatchEvent(new MouseEvent('click', o));
                            b.click();
                            return 'dispatched';
                        }"""), 5)
                        if saved:
                            break
                    except Exception:
                        pass
                for i in range(6):
                    await asyncio.sleep(0.5)
                    alive = False
                    for f in ybx.frames:
                        try:
                            n = await asyncio.wait_for(f.evaluate("""() => {
                                const d = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                                    d.offsetParent !== null && d.innerText.includes('乘坐人'));
                                return d ? 1 : 0;
                            }"""), 2)
                            if n:
                                alive = True
                                break
                        except Exception:
                            pass
                    if not alive:
                        closed = round((i + 1) * 0.5, 1)
                        break
                if closed is not None:
                    break
                # 未关窗：先复查红字——保存可能已生效（假关闭形态，2026-09-04 实证），reloadGrid 后红字消了即成功
                await ybx.evaluate("() => { try { jQuery('#gridWF_YBX_53').trigger('reloadGrid'); } catch (e) {} }")
                await ybx.wait_for_timeout(3000)
                still = await ybx.evaluate(f"() => {{ const tr = document.querySelector('[id=\"{row['rid']}\"]'); return tr ? !!tr.querySelector('td.cont_tipword_ERROR') : null; }}")
                if still is False:
                    log(5, f"{row['rid']} 行程保存已生效（弹窗未关）", attempt=attempt + 1, save=saved)
                    await close_all_dialogs()
                    return 'saved'
                log(5, f"{row['rid']} 行程保存未关窗未生效，重试", attempt=attempt + 1, save=saved, still_err=still)
                await ybx.wait_for_timeout(1500)
            if closed is not None:
                log(5, f"{row['rid']} 行程保存", save=saved, closed=closed, fill=filled)
                return 'saved'
            # 重试仍不关：非行程票确认兜底
            log(5, f"{row['rid']} 行程保存 3 次未提交，走非行程票确认", save=saved)
            await close_all_dialogs()
            for f in ybx.frames:
                try:
                    await asyncio.wait_for(f.evaluate(f"() => {{ const td = document.querySelector('[id=\"{row['rid']}\"] td.cont_tipword_ERROR'); if (td) td.click(); }}"), 5)
                    break
                except Exception:
                    pass
            await ybx.wait_for_timeout(5000)
            for f in ybx.frames:
                try:
                    await asyncio.wait_for(f.evaluate("""() => {
                        const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                        if (!dlgEl) return;
                        const b = Array.from(dlgEl.querySelectorAll('button.winBtn')).find(e =>
                            (e.textContent || '').replace(/\\s/g, '') === '修改行程');
                        if (b) b.click();
                    }"""), 5)
                    break
                except Exception:
                    pass
            await ybx.wait_for_timeout(4000)
            ok_btn = None
            for f in ybx.frames:
                try:
                    ok_btn = await asyncio.wait_for(f.evaluate("""() => {
                        const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null && d.innerText.includes('乘坐人'));
                        if (!dlgEl) return 'no-dialog';
                        const b = Array.from(dlgEl.querySelectorAll('button')).find(e => e.getAttribute('btnname') === '非行程票确认');
                        if (b) { b.click(); return 'clicked'; }
                        return 'no-btn';
                    }"""), 5)
                    if ok_btn:
                        break
                except Exception:
                    pass
            await ybx.wait_for_timeout(2500)
            confirmed = None
            for f in ybx.frames:
                try:
                    confirmed = await asyncio.wait_for(f.evaluate("""() => {
                        const c = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null && d.innerText.includes('非行程票'));
                        if (!c) return 'no-confirm';
                        const b = Array.from(c.querySelectorAll('button')).find(e => (e.textContent || '').replace(/\\s/g, '') === '继续');
                        if (b) { b.click(); return 'confirmed'; }
                        return 'no-btn';
                    }"""), 5)
                    if confirmed:
                        break
                except Exception:
                    pass
            await ybx.wait_for_timeout(3000)
            log(5, f"{row['rid']} 非行程票确认", btn=ok_btn, confirm=confirmed)
            return 'non-trip'

        async def goto_reimburse():
            """全选 + 前往报销；返回 proceeded（跳转开单页）/ trip-error（弹行程错误）/ unknown。"""
            r = await ybx.evaluate("""() => {
                const g = document.getElementById('gridWF_YBX_53');
                if (!g) return 'no-grid';
                let n = 0;
                for (const cb of g.querySelectorAll('input[type=checkbox]')) {
                    if (!cb.checked) { cb.click(); n++; }
                }
                return 'checked:' + n;
            }""")
            await ybx.wait_for_timeout(1500)
            r2 = await ybx.evaluate("""() => {
                const b = Array.from(document.querySelectorAll('button, a, span')).find(e => e.offsetParent !== null &&
                    (e.textContent || '').replace(/\\s/g, '') === '前往报销');
                if (b) { b.click(); return 'clicked'; }
                return 'nf';
            }""")
            log(5, '前往报销', select=r, click=r2)
            for _ in range(6):
                await ybx.wait_for_timeout(2500)
                state = await ybx.evaluate("""() => {
                    const t = document.body.innerText || '';
                    const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    return { page: (t.includes('提交申请') || t.includes('保存草稿')) ? 'form' : 'pool', err: dlg ? dlg.innerText.includes('行程存在错误') : false, dlgText: dlg ? dlg.innerText.replace(/\\s+/g, ' ').slice(0, 200) : '' };
                }""")
                if state['page'] == 'form':
                    return 'proceeded'
                if state['err']:
                    log(5, '行程错误弹窗', text=state['dlgText'][:120])
                    await close_all_dialogs()
                    return 'trip-error'
            return 'unknown'

        async def fix_trips():
            for round_i in range(4):
                # 每轮都 reload：行程修复必须在干净页面会话进行——上传后同会话保存会静默失效（2026-09-04 实证），reload 后与 fixTripsOnly 环境一致
                await ybx.reload(wait_until='domcontentloaded')
                await ybx.wait_for_timeout(6000)
                await close_all_dialogs()
                await ensure_pool(ybx)
                bad = await trip_error_rows()
                log(5, f'缺行程扫描(轮{round_i + 1})', rows=[b['rid'] for b in bad])
                if bad:
                    for row in bad:
                        await fix_one_trip(row)
                    continue
                result = await goto_reimburse()
                if result == 'proceeded':
                    return 'proceeded'
                if result == 'trip-error':
                    continue
                log(5, '前往报销无响应', retry=round_i + 1)
            return 'failed'

        trip_state = await fix_trips()
        log(5, '行程修复', state=trip_state)
        await shot(ybx, 5, 'trips-fixed')
        if trip_state == 'failed':
            await abort_exit(ybx, 5, '行程修复', '前往报销未跳转')
            return

        # ===== D. checkbox 全选 → 前往报销 =====
        if trip_state != 'proceeded':
            if not await ensure_pool(ybx):
                await abort_exit(ybx, 6, '全选发票', '发票池视图丢失（grid 未渲染）')
                return
            r = await ybx.evaluate("""() => {
                const g = document.getElementById('gridWF_YBX_53');
                if (!g) return 'no-grid';
                let n = 0;
                for (const cb of g.querySelectorAll('input[type=checkbox]')) {
                    if (!cb.checked) { cb.click(); n++; }
                }
                return 'checked:' + n;
            }""")
            await ybx.wait_for_timeout(1500)
            sel_n = await ybx.evaluate("""() => {
                const m = document.body.innerText.replace(/\\s+/g, ' ').match(/已选\\s*(\\d+)\\s*张/);
                return m ? m[1] : '?';
            }""")
            log(6, 'checkbox全选', click=r, 已选=sel_n)
            if sel_n != '4':
                await abort_exit(ybx, 6, '已选数', f'{sel_n}/4')
                return
            r = await ybx.evaluate(CLICK_TEXT_JS, '前往报销')
            await ybx.wait_for_timeout(9000)
            await ybx.evaluate(CLOSE_JS)
            log(7, '前往报销', click=r)
        # ===== E. 单据 iframe =====
        ff = await wait_form_frame(ybx, 15)
        if not ff:
            await abort_exit(ybx, 8, '单据iframe', '表单 frame 未出现')
            return
        form_no = await ff.evaluate("() => (document.body.innerText.match(/报销单号[:：]\\s*(\\d+)/) || ['', '?'])[1]")
        log(8, '单据生成', 单号=form_no)
        await shot(ybx, 8, 'form')

        # ===== E2. 选经费项目（递交清单确认的 projectId）=====
        # 判定基准 = 开单页项目 td 文本（读回）是否含目标编号——系统常自动带出正确项目（选择弹窗或无"保存"按钮），
        # 带出正确则无需操作；不对才走 td → 选行 → 保存并复验。自动提交模式下读回不匹配即 abort（走错账不可逆）。
        if CFG.get('projectId', ''):
            pid = CFG['projectId']

            async def read_project_td():
                for f in ybx.frames:
                    try:
                        r = await asyncio.wait_for(f.evaluate("""() => {
                            const td = Array.from(document.querySelectorAll('td')).find(td => td.offsetParent !== null &&
                                /单项目修改/.test(td.getAttribute('onclick') || ''));
                            return td ? (td.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) : null;
                        }"""), 4)
                        if r:
                            return r
                    except Exception:
                        pass
                return None

            back = await read_project_td()
            log(85, '项目读回（开单页当前值）', text=back, target=pid)
            if back and pid.replace('-', '') in back.replace('-', ''):
                log(85, f'选项目 {pid}', result='系统已带出正确项目，无需选择')
                await shot(ybx, 85, 'project')
            else:
                opened = 'nf'
                for f in ybx.frames:
                    try:
                        has = await asyncio.wait_for(f.evaluate("""() => {
                            const td = Array.from(document.querySelectorAll('td')).find(td => td.offsetParent !== null &&
                                /单项目修改/.test(td.getAttribute('onclick') || ''));
                            if (!td) return false;
                            td.click();
                            return true;
                        }"""), 4)
                        if has:
                            opened = 'clicked'
                            break
                    except Exception:
                        pass
                await ybx.wait_for_timeout(4000)
                sel = 'nf'
                for _ in range(8):
                    for f in ybx.frames:
                        try:
                            r = await asyncio.wait_for(f.evaluate("""(pid) => {
                                const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                                const scope = dlg || document;
                                const norm = (s) => (s || '').replace(/\\s/g, '');
                                for (const g of scope.querySelectorAll('table[id]')) {
                                    try {
                                        for (const id of jQuery(g).jqGrid('getDataIDs')) {
                                            const tr = document.getElementById(id);
                                            if (tr && norm(tr.textContent).includes(pid)) {
                                                jQuery(g).jqGrid('setSelection', id, true);
                                                return 'grid-selected';
                                            }
                                        }
                                    } catch (e) {}
                                }
                                for (const tr of scope.querySelectorAll('tr')) {
                                    if (tr.offsetParent !== null && norm(tr.textContent).includes(pid) && norm(tr.textContent).length < 200) {
                                        tr.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                                        return 'row-clicked';
                                    }
                                }
                                return 'nf';
                            }""", pid), 4)
                            if r and r != 'nf':
                                sel = r
                                break
                        except Exception:
                            pass
                    if sel != 'nf':
                        break
                    await ybx.wait_for_timeout(1500)
                saved = 'nf'
                if sel != 'nf':
                    await ybx.wait_for_timeout(1000)
                    for f in ybx.frames:
                        try:
                            r = await asyncio.wait_for(f.evaluate("""() => {
                                const dlg = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                                const scope = dlg || document;
                                const b = Array.from(scope.querySelectorAll('a, button')).find(e =>
                                    e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '保存');
                                if (!b) return 'no-btn';
                                const o = { bubbles: true, cancelable: true, view: window };
                                b.dispatchEvent(new MouseEvent('mousedown', o));
                                b.dispatchEvent(new MouseEvent('mouseup', o));
                                b.dispatchEvent(new MouseEvent('click', o));
                                b.click();
                                return 'dispatched';
                            }"""), 4)
                            if r and r != 'nf':
                                saved = r
                                break
                        except Exception:
                            pass
                    await ybx.wait_for_timeout(3000)
                    await ybx.evaluate(CLOSE_JS)
                else:
                    btns = await ybx.evaluate("""() => { const d = Array.from(document.querySelectorAll('.ui-dialog')).find(x => x.offsetParent !== null); return d ? Array.from(d.querySelectorAll('a, button')).filter(b => b.offsetParent !== null).map(b => (b.getAttribute('btnname') || '') + ':' + (b.textContent || '').trim()).slice(0, 10) : null; }""")
                    log(85, '项目弹窗按钮', btns=btns)
                back = await read_project_td()
                log(85, '选项目读回（选择后）', text=back)
                log(85, f'选项目 {pid}', open=opened, select=sel, save=saved, back=back)
                await shot(ybx, 85, 'project')
                if not (back and pid.replace('-', '') in back.replace('-', '')):
                    if CFG.get('autoSubmit'):
                        await abort_exit(ybx, 85, '选项目', f'自动提交模式要求项目匹配：open={opened} select={sel} save={saved} back={back}')
                        return
                    log(85, '选项目', result='WARN 未完成，请在财务系统人工确认经费项目')

        # ===== F. radio 逐个验证 =====
        radio_state = {}
        for name, cn in (('o_isaphs_1', '伙食'), ('o_isapjt_1', '交通'), ('o_isapzs_1', '住宿')):
            ok = False
            for attempt in range(5):
                ff = await wait_form_frame(ybx, 5) or ff
                try:
                    state = await asyncio.wait_for(ff.evaluate(RADIO_CHECK_JS), 8)
                    if state.get(name):
                        radio_state[cn] = f'N(验证{attempt + 1})'
                        ok = True
                        break
                    await asyncio.wait_for(ff.evaluate(RADIO_CLICK_ONE_JS, name), 8)
                except Exception:
                    pass
                for _ in range(8):
                    await ybx.wait_for_timeout(1000)
                    ff2 = await wait_form_frame(ybx, 3)
                    if ff2:
                        ff = ff2
                        try:
                            state = await asyncio.wait_for(ff.evaluate(RADIO_CHECK_JS), 8)
                            if state.get(name):
                                radio_state[cn] = f'N(尝试{attempt + 1}后确认)'
                                ok = True
                                break
                        except Exception:
                            pass
                if ok:
                    break
            radio_state[cn] = radio_state.get(cn, 'FAIL')
        log(9, 'radio×3=否', **radio_state)
        await shot(ybx, 9, 'radio')
        if any('FAIL' in str(v) for v in radio_state.values()):
            await abort_exit(ybx, 9, 'radio', f'{radio_state}')
            return

        # ===== G. 金额轮询 =====
        total = None
        verified_total = ''
        expect_norm = str(AMOUNT).replace(',', '') if AMOUNT else ''
        for i in range(20):
            ff = await wait_form_frame(ybx, 3) or ff
            try:
                total = await asyncio.wait_for(ff.evaluate("""() => {
                    const t = document.body.innerText.replace(/\\s+/g, ' ');
                    const m = t.match(/金额总计[:：]\\s*([\\d.,]+)/);
                    return m ? m[1] : '?';
                }"""), 8)
                # 归一化比较：系统带千分位逗号/尾逗号（如 "3,847.54,"），裸数字直判永不匹配
                total_norm = str(total).replace(',', '').rstrip('.')
                if not expect_norm or total_norm == expect_norm:
                    break
            except Exception:
                pass
            await ybx.wait_for_timeout(2000)
        verified_total = str(total or '').replace(',', '').rstrip('.')
        amount_ok = (not expect_norm) or expect_norm == verified_total
        log(10, '金额核实', total=total, expect=AMOUNT or '(信系统)', ok=amount_ok)
        await shot(ybx, 10, 'amount')
        if not amount_ok:
            await abort_exit(ybx, 10, '金额核实', f'系统 {total} ≠ 预期 {AMOUNT}')
            return

        # ===== H. 摘要 + 校区（老系统会中途 reload 导致 Frame detached，整段重试）=====
        h_done = None
        for h_attempt in range(3):
            try:
                ff = await wait_form_frame(ybx, 10) or ff
                r = await ff.evaluate(CLICK_TEXT_JS, '点击修改信息')
                await ybx.wait_for_timeout(4000)
                dlg_scope = None
                for f in ybx.frames:
                    try:
                        ok = await asyncio.wait_for(f.evaluate("() => !!Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null)"), 4)
                        if ok:
                            dlg_scope = f
                            break
                    except Exception:
                        pass
                dlg_scope = dlg_scope or ff
                r2 = await dlg_scope.evaluate("""(cfg) => {
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    const scope = dlgEl || document;
                    const zy = Array.from(scope.querySelectorAll('input')).find(i => (i.value || '').length > 6);
                    if (zy) { zy.value = cfg.summary; zy.dispatchEvent(new Event('input', { bubbles: true })); }
                    const sel = Array.from(scope.querySelectorAll('select')).find(s => Array.from(s.options).some(o => /普陀|闵行/.test(o.textContent)));
                    if (sel) { const opt = Array.from(sel.options).find(o => o.textContent.includes(cfg.campus)); if (opt) sel.value = opt.value; }
                    return { zy: !!zy, sel: !!sel };
                }""", { 'summary': SUMMARY, 'campus': CAMPUS.replace('校区', '') })
                await ybx.wait_for_timeout(800)
                await dlg_scope.evaluate("""() => {
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    const scope = dlgEl || document;
                    const b = Array.from(scope.querySelectorAll('a, button')).find(e =>
                        e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '保存');
                    if (b) b.click();
                }""")
                await ybx.wait_for_timeout(4000)
                await ybx.evaluate(CLOSE_JS)
                log(11, f'摘要+校区{CAMPUS}(尝试{h_attempt + 1})', click=r, fields=r2)
                await shot(ybx, 11, 'basicinfo')
                h_done = r2
                break
            except Exception as h_err:
                log(11, f'摘要+校区重试{h_attempt + 1}', error=str(h_err)[:80])
                await ybx.evaluate(CLOSE_JS)
                await ybx.wait_for_timeout(2000)
        if h_done is None:
            await abort_exit(ybx, 11, '摘要+校区', '三次重试均失败')
            return

        # ===== I. 支付信息 =====
        oc, pay_frame = None, None
        # 轮询探测（同 daily 引擎 2026-09-18 教训）：表单区段未渲染完时单次探测会假阴性，40s 内每 4s 重扫。
        for _ in range(10):
            for f in ybx.frames:
                try:
                    has = await asyncio.wait_for(f.evaluate("() => typeof pageOpen === 'function' && document.body.innerText.includes('修改支付信息')"), 4)
                    if has:
                        pay_frame = f
                        oc = await f.evaluate("""() => {
                            const hits = Array.from(document.querySelectorAll('*')).filter(e =>
                                e.offsetParent !== null &&
                                (e.textContent || '').replace(/\\s/g, '').includes('修改支付信息') &&
                                e.children.length <= 2);
                            for (const e of hits) {
                                let cur = e;
                                for (let i = 0; i < 4 && cur; i++) {
                                    if (cur.getAttribute && cur.getAttribute('onclick')) return cur.getAttribute('onclick');
                                    cur = cur.parentElement;
                                }
                            }
                            return null;
                        }""")
                        break
                except Exception:
                    pass
            if oc and pay_frame:
                break
            await ybx.wait_for_timeout(4000)
        if oc and pay_frame:
            await pay_frame.evaluate(f"() => {oc.replace('&amp;', '&')}")
            await ybx.wait_for_timeout(5000)
            pf = None
            for f in ybx.frames:
                try:
                    ok = await asyncio.wait_for(f.evaluate("() => !!document.querySelector(\"[name$='t-amount_0']\")"), 4)
                    if ok:
                        pf = f
                        break
                except Exception:
                    pass
            if pf:
                r = await pf.evaluate("""(cfg) => {
                    const set = (suffix, val) => { const el = document.querySelector(`[name$='${suffix}']`); if (!el) return `${suffix}: nf`;
                        el.value = val; el.dispatchEvent(new Event('change', { bubbles: true })); return `${suffix}: ok`; };
                    return [set('t-amount_0', cfg.amount), set('t-remark_0', cfg.remark)];
                }""", { 'amount': PAY_AMOUNT or (AMOUNT.replace(',', '') if AMOUNT else verified_total), 'remark': PAY_REMARK or SUMMARY })
                await ybx.wait_for_timeout(1000)
                r2 = await pf.evaluate("""() => {
                    const b = Array.from(document.querySelectorAll('a, button, input[type=button]'))
                        .find(e => e.offsetParent !== null && (e.textContent || e.value || '').replace(/\\s/g, '') === '保存');
                    if (b) { b.click(); return 'ok'; }
                    return 'nf';
                }""")
                await ybx.wait_for_timeout(6000)
                log(12, '支付信息', set=r, save=r2)
            else:
                log(12, '支付信息', result='t-amount 未找到（人工处理）')
        else:
            log(12, '支付信息', result='onclick 未获取（人工处理）')
        await ybx.wait_for_timeout(3000)
        await ybx.evaluate(CLOSE_JS)

        # ===== J. 协同审批人 =====
        ff2 = None
        for f in ybx.frames:
            try:
                if await asyncio.wait_for(f.evaluate("() => document.body && document.body.innerText.includes('协同审批人')"), 4):
                    ff2 = f
                    break
            except Exception:
                pass
        if ff2:
            r = await ff2.evaluate("""() => {
                const td = Array.from(document.querySelectorAll('td')).find(td => td.offsetParent !== null &&
                    (td.textContent || '').trim() === '请选择');
                if (!td) return 'nf';
                td.click();
                return 'native-clicked';
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
                r2 = await dlg.evaluate("""(approver) => {
                    const input = Array.from(document.querySelectorAll('input')).find(i => (i.placeholder || '').includes('工号'));
                    input.value = approver;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    return 'ok';
                }""", APPROVER)
                await ybx.wait_for_timeout(800)
                r3 = await dlg.evaluate("""() => {
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    const scope = dlgEl || document;
                    const b = Array.from(scope.querySelectorAll('a, button')).find(e =>
                        e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '保存');
                    if (b) { b.click(); return 'ok'; }
                    return 'nf';
                }""")
                await ybx.wait_for_timeout(3000)
                log(13, '协同审批人', open=r, fill=r2, save=r3)
            else:
                log(13, '协同审批人', open=r, result='弹窗未找到（人工处理）')
        else:
            log(13, '协同审批人', result='scope 未找到（人工处理）')
        await shot(ybx, 13, 'approver')

        # ===== K. 附件 6 件 =====
        opened = False
        for f in ybx.frames:
            try:
                has = await asyncio.wait_for(f.evaluate("""() => {
                    if (typeof pageOpen_v1 === 'function' && document.body.innerText.includes('差旅附件上传')) {
                        window.confirm = function() { return true; };
                        pageOpen_v1('特殊事项','31&31');
                        return true;
                    }
                    return false;
                }"""), 4)
                if has:
                    opened = True
                    break
            except Exception:
                pass
        await ybx.wait_for_timeout(4000)
        adlg = None
        for f in ybx.frames:
            try:
                ok = await asyncio.wait_for(f.evaluate("""() => !!Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                    d.offsetParent !== null && (d.querySelectorAll('a.del').length > 0 || d.querySelector('input[type=file]')))"""), 4)
                if ok:
                    adlg = f
                    break
            except Exception:
                pass
        if adlg and opened:
            n_del = await adlg.evaluate("""() => {
                const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                    d.offsetParent !== null && d.querySelectorAll('a.del').length > 0);
                return dlgEl ? dlgEl.querySelectorAll('a.del').length : 0;
            }""")
            log(14, '附件弹窗', opened=opened, existing=n_del)
            if n_del != 0:
                await abort_exit(ybx, 14, '附件弹窗', f'弹窗已有 {n_del} 文件')
                return
            fi_frame = None
            for f in ybx.frames:
                try:
                    ok = await asyncio.wait_for(f.evaluate("""() => {
                        const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                            d.offsetParent !== null && d.querySelector('input[type=file]'));
                        return !!dlgEl;
                    }"""), 4)
                    if ok:
                        fi_frame = f
                        break
                except Exception:
                    pass
            if fi_frame:
                await fi_frame.evaluate("""() => {
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d => d.offsetParent !== null);
                    dlgEl.querySelector('input[type=file]').id = '__e2e_att__';
                }""")
                paths = [resolve_material(f) for f in ATTACHMENTS]
                await fi_frame.locator('#__e2e_att__').set_input_files(paths)
                await ybx.wait_for_timeout(8000)
                n_del2 = await adlg.evaluate("""() => {
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                        d.offsetParent !== null && d.querySelectorAll('a.del').length > 0);
                    return dlgEl ? dlgEl.querySelectorAll('a.del').length : 0;
                }""")
                log(14, '附件上传', expect=6, actual=n_del2)
                if n_del2 != 6:
                    await abort_exit(ybx, 14, '附件核对', f'{n_del2}/6')
                    return
                r = await adlg.evaluate(f"""() => {{
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                        d.offsetParent !== null && d.querySelectorAll('a.del').length > 0);
                    const ta = dlgEl.querySelector('textarea');
                    if (!ta) return 'no-textarea';
                    ta.value = {json.dumps(DESC)};
                    ta.dispatchEvent(new Event('change', {{ bubbles: true }}));
                    return 'ok';
                }}""")
                await ybx.wait_for_timeout(500)
                r2 = await adlg.evaluate("""() => {
                    const dlgEl = Array.from(document.querySelectorAll('.ui-dialog')).find(d =>
                        d.offsetParent !== null && d.querySelectorAll('a.del').length > 0);
                    const b = Array.from(dlgEl.querySelectorAll('a, button')).find(e =>
                        e.offsetParent !== null && (e.textContent || '').replace(/\\s/g, '') === '保存');
                    if (b) { b.click(); return 'ok'; }
                    return 'nf';
                }""")
                await ybx.wait_for_timeout(4000)
                log(14, '附件描述+保存', desc=r, save=r2)
            else:
                log(14, '附件上传', result='file input 未找到（人工处理）')
        else:
            log(14, '附件弹窗', opened=opened, result='未打开（人工处理）')
        await shot(ybx, 14, 'attachments')

        # ===== L. 保存草稿 =====
        r = await ybx.evaluate("""() => {
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
        await shot(ybx, 15, 'saved')
        log(15, '保存草稿（未提交）', click=r)

        # ===== M. 验证 =====
        await ybx.reload(wait_until='domcontentloaded')
        await ybx.wait_for_timeout(6000)
        await ybx.evaluate(CLOSE_JS)
        await ybx.evaluate(CLICK_TEXT_JS, '草稿')
        await ybx.wait_for_timeout(5000)
        await ybx.evaluate(CLOSE_JS)
        v = await ybx.evaluate("""() => {
            const t = document.body.innerText.replace(/\\s+/g, '');
            const m = t.match(/(4\\d{6})国内差旅/);
            return { no: m ? m[1] : '?', text: t.slice(0, 3000) };
        }""")
        # 金额/摘要核验放 Python 侧：JS 上下文没有 AMOUNT/SUMMARY 变量（参数化后曾是 ReferenceError）
        text = v.get('text', '')
        norm_amount = str(AMOUNT).replace(',', '')
        has_amount = (not AMOUNT) or (bool(norm_amount) and norm_amount in text.replace(',', ''))
        probe = (SUMMARY or PAY_REMARK or '差旅').replace(' ', '')[:6]
        log(16, '最终验证', 单号=v.get('no'), hasAmount=has_amount, hasSummary=probe in text)
        await shot(ybx, 16, 'verify')
        await snapshot_state(ybx, '16-final')
        # 不清理识别队列！实证（2026-09-02）：批量删除未识别列表会打断 OCR 管道，
        # 之后上传的新票全部卡队列不入池（19:16/20:21 两轮失败均发生在清理后）；
        # 队列自然消化约 20 分钟且期间新票秒入池（14:45 成功轮队列即自然空）。

        # ===== N. 自动提交申请（autoSubmit：观自在全自动递交）=====
        # 保存草稿后仍停在单据页——直接点主 frame 的 btnname=提交申请（winBtn 完整事件序列）。
        # 前置断言（单号格式/金额/摘要在开单页文本）不过 → abort 不提交。
        if CFG.get('autoSubmit'):
            bill_no = str(form_no)
            if not re.match(r'4\d{6}', bill_no) or not has_amount or not (probe in text):
                await abort_exit(ybx, 16, '自动提交前置断言', f'单号={bill_no} hasAmount={has_amount} hasSummary={probe in text}')
                return
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
            # 提交成功判定：全部报销单里该单号行状态已非「草稿」（实证：变为「协同人」+流程实例号）
            done = False
            st = '?'
            for _ in range(3):
                await ybx.reload(wait_until='domcontentloaded')
                await ybx.wait_for_timeout(6000)
                await ybx.evaluate(CLOSE_JS)
                await ybx.evaluate("() => { const els = Array.from(document.querySelectorAll('span, a, div')).filter(e => e.offsetParent !== null && (e.textContent || '').trim() === '全部报销单'); if (!els.length) return 'nf'; els[0].click(); return 'ok'; }")
                await ybx.wait_for_timeout(6000)
                st = await ybx.evaluate(f"""(bill) => {{ for (const tr of document.querySelectorAll('tr[id]')) {{ const t = (tr.textContent || ''); if (t.includes(bill)) return /草稿/.test(t) ? 'still-draft' : 'state-changed'; }} return 'no-row'; }}""", bill_no)
                if st == 'state-changed':
                    done = True
                    break
                await ybx.wait_for_timeout(4000)
            log(16, '提交申请', bill=bill_no, submit=sv, done=done, state=st)

            await shot(ybx, 16, 'auto-submitted')
            if sv != 'dispatched' or not done:
                await abort_exit(ybx, 16, '提交申请', f'submit={sv} done={done}')
                return
            finish_evidence(MODE, 'SUBMITTED', bill=bill_no)
            print('##SUBMITTED##1')
            await browser.close()
            print(f'\n== 端到端完成：单据 {bill_no} 已自动提交申请 ==')
            return

        finish_evidence(MODE, 'DRAFT-READY', bill=v.get('no'))

        await browser.close()
        print(f'\n== 端到端完成：草稿 {v.get("no")}（未提交，请人工核对后提交）==')


if __name__ == '__main__':
    asyncio.run(main())
