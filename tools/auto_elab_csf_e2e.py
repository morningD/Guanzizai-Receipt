#!/usr/bin/env python3
"""elab wxzc 软件服务费报账单（CSF）自动填报 e2e——云服务/AI 订阅前置报账。

安全策略：默认到**保存草稿**为止；config autoSubmit=true 时保存后自动点「提交审核」
（点原生 #btnPutAuditing + dialog 全自动应答 + 列表状态回验，失败重试一次）——
提交后进入科技处审核（人工），无自动同意环节。

用法:
  python tools/auto_elab_csf_e2e.py --config /tmp/opencode/elab_csf_cfg.json
config:
  {
    "jfly": "<经费卡号>",          // 经费卡（JFLY 直写兜底格式 卡号:0.00;）
    "bills": [                              // 明细行（名称按历史单惯例「软件服务费」）
      {"name": "软件服务费", "zj": "729.23", "sl": "1", "fph": "", "bz": "ChatGPT Pro 订阅 2026-07"}
    ],
    "attachments": [                        // 发票/收据扫描件（可空；用户定案 2026-09-20：
      {"path": "data/.../账单.pdf",          //   wxzc 只要 invoice/receipt/发票（账单/收据），
       "category": "发票扫描件",              //   支付记录可选；价格截图/产品页面截图/费用清单类辅助材料不传）
       "description": "..."}]
    "dumpDir": "data/autobx_logs/elab_dumps"
  }
stdout 进度逐行输出（PIPE 进 trace）。绝不 submit。
"""

import asyncio
import json
import re
import subprocess
import sys
import time
import traceback
from pathlib import Path

from playwright.async_api import async_playwright

from receipt_runtime import DATA_ROOT, launch_chromium, school_session, windows_school_credentials

ROOT = DATA_ROOT
ELAB_DIR = ROOT / "elab_research"
STORAGE_PATH = school_session("elab")
ENTRY_URL = "https://elab.ecnu.edu.cn/wxzc/index.jsp"
DUMP_DIR = ROOT / "data/autobx_logs/elab_dumps"

CFG = json.loads(Path(sys.argv[sys.argv.index("--config") + 1]).read_text(encoding="utf-8")) if "--config" in sys.argv else {}


def log(msg):
    print(f"[elab-csf] {msg}", flush=True)


def get_credentials():
    configured = windows_school_credentials()
    if configured is not None:
        return configured
    def kc(a, s):
        r = subprocess.run(["security", "find-generic-password", "-a", a, "-s", s, "-w"], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    u, p = kc("ecnu_sso", "ECNU SSO Login"), kc("ecnu_sso_pwd", "ECNU SSO Password")
    if not u or not p:
        raise RuntimeError("Keychain 无 ECNU 凭证")
    return u, p


async def menu_frame(page):
    """wxzc 菜单 frame：名字 MenuFrame，按 URL left_new.jsp 匹配最稳。"""
    return next((f for f in page.frames if "left_new.jsp" in f.url), None)


async def body_frame(page):
    return next((f for f in page.frames if f.name == "BodyFrame"), None)


async def wait_menu(page, timeout=25):
    deadline = time.time() + timeout
    while time.time() < deadline:
        m = await menu_frame(page)
        if m is not None:
            try:
                if await m.evaluate("() => !!document.getElementById('zklb_no16') || !!document.body"):
                    return m
            except Exception:
                pass
        await asyncio.sleep(0.4)
    raise TimeoutError("wxzc 菜单 frame 未就绪")


async def wait_body(page, anchor_js, timeout=30.0):
    """BodyFrame 就绪且锚点为真；中途 reload 自动重找。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        b = await body_frame(page)
        if b is not None:
            try:
                if await b.evaluate(f"() => document.readyState !== 'loading' && !!({anchor_js})"):
                    return b
            except Exception:
                pass
        await asyncio.sleep(0.4)
    raise TimeoutError(f"BodyFrame 锚点未就绪: {anchor_js[:70]}")


class Dump:
    def __init__(self, page):
        self.page = page

    async def dump(self, tag):
        try:
            out = DUMP_DIR / f"csf_{time.strftime('%H%M%S')}_{tag}"
            out.mkdir(parents=True, exist_ok=True)
            frames = []
            for f in self.page.frames:
                try:
                    html = await f.evaluate("() => document.documentElement.outerHTML")
                    name = re.sub(r"[^\w]", "_", f.name or "anon")[:20]
                    (out / f"{name}.html").write_text(html, encoding="utf-8")
                    frames.append({"name": f.name, "url": f.url[:120]})
                except Exception:
                    pass
            (out / "frames.json").write_text(json.dumps(frames, ensure_ascii=False, indent=2), encoding="utf-8")
            await self.page.screenshot(path=str(out / "shot.png"), full_page=True)
            log(f"dump 现场: {out}")
        except Exception as e:
            log(f"dump 失败: {e}")


async def sso_login(page, username, password):
    for _ in range(10):
        if "sso.ecnu.edu.cn" in page.url:
            break
        await asyncio.sleep(1.0)
    user_input = page.get_by_role("textbox", name="username")
    await user_input.wait_for(timeout=15000)
    await user_input.fill(username)
    await page.get_by_role("textbox", name="password").fill(password)
    for _ in range(24):
        cls = await page.evaluate("() => document.querySelector('#submitBtn')?.className || ''")
        if "disable" not in cls:
            break
        await asyncio.sleep(0.5)
    await page.evaluate("() => document.querySelector('#submitBtn')?.click()")
    await wait_menu(page)


async def nav_to_add_form(st, page):
    """登录后：顶栏报账管理 → zklb_no16 展开 → 个人新增 → 告知页 → AddPage。"""
    top = next((f for f in page.frames if "top_new.jsp" in f.url), None)
    menu = await menu_frame(page)
    old_menu_url = menu.url
    await top.evaluate("""() => { for (const el of document.querySelectorAll('a')) {
      if ((el.textContent || '').trim() === '报账管理') { el.click(); return; } } }""")
    deadline = time.time() + 20
    menu = None
    while time.time() < deadline:
        f = await menu_frame(page)
        if f and f.url != old_menu_url:
            try:
                if await f.evaluate("() => !!document.getElementById('zklb_no16')"):
                    menu = f
                    break
            except Exception:
                pass
        await asyncio.sleep(0.4)
    if menu is None:
        await st.dump("menu_switch")
        raise RuntimeError("顶栏切换失败")
    log("已切到报账管理")

    if not await wait_menu_anchor(menu, "document.getElementById('zklb_no16')"):
        await st.dump("zklb_no16_missing")
        raise RuntimeError("菜单 zklb_no16 不存在")
    await menu.evaluate("() => document.getElementById('zklb_no16').click()")
    if not await wait_menu_anchor(menu, "(() => { const li = document.getElementById('followTDno16'); return !!li && li.querySelectorAll('td[title]').length > 0; })()"):
        await st.dump("followTDno16_missing")
        raise RuntimeError("no16 子菜单未展开")
    clicked = await menu.evaluate("""() => { const li = document.getElementById('followTDno16');
      for (const td of li.querySelectorAll('td[title]')) {
        if ((td.getAttribute('title') || '').includes('个人新增')) { td.click(); return true; } }
      return false; }""")
    if not clicked:
        await st.dump("add_item_missing")
        raise RuntimeError("「个人新增」菜单项未找到")
    log("已点个人新增（软件服务报账）")

    body = None
    deadline = time.time() + 30
    while time.time() < deadline:
        b = await body_frame(page)
        if b is not None:
            try:
                kind = await b.evaluate(
                    "() => document.readyState !== 'loading' ? (!!document.querySelector('#ifread') ? 'notice' : (typeof addMXQD === 'function' ? 'form' : 'loading')) : 'loading'")
                if kind == "form":
                    body = b
                    break
                if kind == "notice":
                    await b.evaluate("() => { document.querySelector('#ifread').checked = true; if (typeof txbzd === 'function') txbzd(); else document.querySelector('form').submit(); }")
                    log("告知页已读提交")
            except Exception:
                pass
        await asyncio.sleep(0.4)
    if body is None:
        await st.dump("addpage_timeout")
        raise TimeoutError("AddPage 未就绪")
    log("表单页就绪")
    return body


async def wait_menu_anchor(menu, anchor_js, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if await menu.evaluate(f"() => !!({anchor_js})"):
                return True
        except Exception:
            pass
        await asyncio.sleep(0.4)
    return False


async def set_jfly(st, body, card):
    """CSF（wxzc）无经费来源字段：AddPage/EditPage 均无 JFLY/dgjfbxz 元素，
    已审核历史单也可能为空——经费信息在财务系统端填报，此处整体跳过。
    保留函数签名以兼容 config（jfly 字段被忽略）。"""
    log("JFLY 跳过（CSF 单无经费来源字段，历史单实证）")


async def fill_detail(st, body, idx, bill):
    """注入并填写一行明细（addMXQD('CSMX') 直接注入，id 规律 CSMX_<字段>_<idx>）。"""
    before = await body.evaluate("() => document.querySelectorAll('input').length")
    await body.evaluate(f"() => addMXQD('CSMX')")
    for _ in range(15):
        n = await body.evaluate("() => document.querySelectorAll('input').length")
        if n > before:
            break
        await asyncio.sleep(0.4)
    else:
        raise RuntimeError(f"明细 {idx} 注入失败")

    fields = {"MC": bill["name"], "SL": bill.get("sl", "1"), "ZJ": bill["zj"], "FPH": bill.get("fph", ""), "BZ": bill.get("bz", "")}
    for suf, val in fields.items():
        el_id = f"CSMX_{suf}_{idx}"
        if not val:
            continue
        await body.fill(f"#{el_id}", str(val))
        live = await body.evaluate(f"() => document.getElementById({json.dumps(el_id)})?.value || ''")
        if live.strip() != str(val).strip():
            raise AssertionError(f"{el_id} 填值未生效: {live!r} != {val!r}")
    log(f"明细 {idx}: {bill['name']} ZJ={bill['zj']} 已填并回读校验")


async def upload_attachments(st, body, page, context, paths):
    """附件上传：fileManagerRefresh 开「文件管理」popup 新窗口（非 iframe）→
    ywxxFrame：set_input_files + 文件类别（发票扫描件）+ 文件描述 + #uploadBtn → 列表记录数核对。
    失败 WARN 不阻塞（草稿可后补）。
    附件规则（用户定案）：wxzc 只要 invoice/receipt/发票（账单/收据），支付记录可选；
    价格截图/产品页面截图/费用清单类辅助材料不传。"""
    ok = 0
    for item in paths:
        if isinstance(item, dict):
            p, cat, desc = item["path"], item.get("category", "发票扫描件"), item.get("description", "")
        else:
            p, cat, desc = item, "发票扫描件", ""
        fp = (ROOT / p) if not Path(p).is_absolute() else Path(p)
        if not fp.exists():
            log(f"WARN: 附件不存在 {p}")
            continue
        try:
            await body.evaluate("() => { document.querySelector('[onclick*=fileManagerRefresh]').click(); }")
            popup = None
            for _ in range(20):
                await asyncio.sleep(0.5)
                for pg in context.pages:
                    if "fileManager.jsp" in pg.url and pg != page:
                        popup = pg
                if popup and any(f.name == "ywxxFrame" for f in popup.frames):
                    break
            if popup is None:
                raise RuntimeError("文件管理 popup 未出现")
            fj = next(f for f in popup.frames if f.name == "ywxxFrame")
            await asyncio.sleep(2)
            await fj.set_input_files("input[type=file]", str(fp))
            await asyncio.sleep(1.5)
            await fj.evaluate("(cat) => { const s = document.querySelector('select'); const o = Array.from(s.options).find(o => o.text.trim() === cat); if (o) { s.value = o.value; s.dispatchEvent(new Event('change')); } }", cat)
            if desc:
                await fj.evaluate("(d) => { const t = document.querySelector('textarea, input[name*=ms], input[id*=ms]'); if (t) t.value = d; }", desc)
            await fj.evaluate("() => { const b = document.getElementById('uploadBtn'); if (b) b.click(); }")
            await asyncio.sleep(4)
            records = await fj.evaluate(r"() => (document.body.innerText.match(/(\d+)\s*条记录/) || [])[1] || '?'")
            ok += 1
            log(f"附件已传: {fp.name[:44]}（列表 {records} 条）")
            await popup.close()
        except Exception as e:
            log(f"WARN: 附件 {fp.name} 上传失败: {str(e)[:80]}（继续）")
    log(f"附件完成 {ok} 份")


async def submit_bill(st, page, context, bill_no: str) -> bool:
    """提交审核：编辑页点原生 #btnPutAuditing（myaudit 校验链 → putAuditing 表单提交）。
    dialog 全自动应答（alert accept / confirm accept）；成功判定 = 列表状态含「审核」；失败重试一次。"""
    dialog_log: list[str] = []

    def handler(dialog):
        dialog_log.append(f"{dialog.type}:{dialog.message[:60]}")
        asyncio.ensure_future(dialog.accept())

    async def attempt() -> bool:
        dialog_log.clear()
        page.on("dialog", handler)
        try:
            body = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if body is None:
                return False
            # 先确保在列表页（从首页/其他页直接反查会找不到）
            await body.evaluate("() => location.href = '/wxzc/bzgl/bzd/ListPage.jsp?zclx=CSF&role=ptyh&fromzclx=FUWU&sumZclx=CSMX&sqjsbh=03110'")
            await asyncio.sleep(6)
            body = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if body is None:
                return False
            wid = await body.evaluate("(no) => { for (const a of document.querySelectorAll('a')) { if ((a.textContent || '').includes(no)) { const m = (a.getAttribute('href') || '').match(/\\d{12,}/); return m ? m[0] : ''; } } return ''; }", bill_no)
            if not wid:
                log("FAIL: 列表未找到该单，无法提交")
                return False
            # 编辑页必须带 zclxbh/sumZclx（HC 协议 v2 同款：缺参页面字段不齐，提交流程异常）
            await body.evaluate("(w) => location.href = '/wxzc/bzgl/bzd/bzdxx_EditPage.jsp?wid=' + w + '&zclxbh=CSF&sumZclx=CSMX'", wid)
            body = await wait_body(page, "document.getElementById('btnPutAuditing') && typeof myaudit === 'function'")
            await asyncio.sleep(4)  # settle：老系统按钮绑定晚于 DOM（HC RC1 教训）
            await body.click("#btnPutAuditing")
            log("已点提交审核，等待回执 …")
            await page.wait_for_timeout(12000)
            # 回验：列表状态含「审核」即推进成功
            body = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if body is not None:
                await body.evaluate("() => location.href = '/wxzc/bzgl/bzd/ListPage.jsp?zclx=CSF&role=ptyh&fromzclx=FUWU&sumZclx=CSMX&sqjsbh=03110'")
                await asyncio.sleep(6)
                body = next((f for f in page.frames if f.name == "BodyFrame"), None)
                status = await body.evaluate("(no) => { for (const tr of document.querySelectorAll('table tr')) { if ((tr.textContent || '').includes(no)) return tr.innerText.split(/[\\n\\s]+/).filter(Boolean).join(' ').trim(); } return ''; }", bill_no)
                log(f"列表行: {status[:110]}")
                if "审核" in status and "填写中" not in status:
                    return True
            return False
        finally:
            try:
                page.remove_listener("dialog", handler)
            except Exception:
                pass

    for round_no in (1, 2):
        if await attempt():
            log(f"提交成功（弹窗回执: {' | '.join(dialog_log[-3:]) or '无'}）")
            log("##ELABSUBMITTED##")
            return True
        log(f"WARN: 第 {round_no} 次提交未确认成功（弹窗: {' | '.join(dialog_log[-3:]) or '无'}）")
        await page.wait_for_timeout(5000)
    await st.dump("submit_failed")
    return False


async def main():
    bills = CFG["bills"]
    jfly = CFG.get("jfly", "")
    attachments = CFG.get("attachments", [])
    auto_submit = bool(CFG.get("autoSubmit"))
    for i, b in enumerate(bills):
        if not b.get("name") or not b.get("zj"):
            raise RuntimeError(f"明细 {i} 缺 name/zj")
        fph = str(b.get("fph", ""))
        if fph and not re.fullmatch(r"\d{8,25}", fph):
            raise RuntimeError(f"明细 {i} 发票号格式非法: {fph!r}")
    DUMP_DIR.mkdir(parents=True, exist_ok=True)

    username, password = get_credentials()
    async with async_playwright() as p:
        browser = await launch_chromium(p, channel="chrome", headless=True)
        ctx_args = {"locale": "zh-CN"}
        if STORAGE_PATH.exists():
            ctx_args["storage_state"] = str(STORAGE_PATH)
        context = await browser.new_context(**ctx_args)
        page = await context.new_page()
        st = Dump(page)

        await page.goto(ENTRY_URL, wait_until="domcontentloaded")
        try:
            await wait_menu(page, timeout=12)
            log("session 复用成功")
        except TimeoutError:
            log("session 失效，SSO 重登 …")
            await sso_login(page, username, password)
        STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        await context.storage_state(path=str(STORAGE_PATH))

        body = await nav_to_add_form(st, page)

        # 经费来源：CSF 单无此字段（历史单实证），config 的 jfly 被忽略
        await set_jfly(st, body, jfly)

        # 明细逐行注入填写（live 读回断言）
        for i, b in enumerate(bills):
            await fill_detail(st, body, i, b)

        # 合计回读：所有 ZJ 求和
        total = await body.evaluate("""() => {
          let s = 0;
          document.querySelectorAll('input[id^=CSMX_ZJ_]').forEach((el) => { s += parseFloat(el.value) || 0; });
          return s.toFixed(2);
        }""")
        expect = sum(float(b["zj"]) for b in bills)
        if abs(float(total) - expect) > 0.01:
            await st.dump("total_mismatch")
            raise AssertionError(f"明细合计 {total} != 预期 {expect:.2f}")
        log(f"明细合计校验通过: {total}")

        # 附件（失败不阻塞）
        if attachments:
            await upload_attachments(st, body, page, context, attachments)

        # 保存草稿（绝不提交：只点「保 存」btnNewEditSave，不碰任何提交/审核按钮）
        await body.click("#btnNewEditSave")
        log("已点保存，等待回执 …")
        await page.wait_for_timeout(4000)

        # 单号回读：表单 BZDBH 或 alert 弹窗（保存成功通常提示）
        dialog_note = []
        page.on("dialog", lambda d: (dialog_note.append(d.message), asyncio.ensure_future(d.dismiss())))
        bill_no = ""
        deadline = time.time() + 15
        while time.time() < deadline and not bill_no:
            b = await body_frame(page)
            if b is not None:
                try:
                    bill_no = await b.evaluate("() => document.getElementById('BZDBH')?.value || ''")
                except Exception:
                    pass
            await asyncio.sleep(0.5)
        if bill_no:
            log(f"##BILL##{bill_no}")
            if auto_submit:
                log("autoSubmit 开启：继续提交审核 …")
                if await submit_bill(st, page, context, bill_no):
                    STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
                    await context.storage_state(path=str(STORAGE_PATH))
                    await browser.close()
                    return 0
                log("FAIL: 自动提交未成功——草稿仍在，请人工在 elab 提交或重试")
                await browser.close()
                return 3
            log(f"保存草稿成功：{bill_no}（未提交，科技处审核由用户人工发起）")
        else:
            await st.dump("save_no_billno")
            log(f"WARN: 未回读到报账单号（弹窗回执: {dialog_note}）——请人工核对新单列表")
            return 2
        await browser.close()
        return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception as e:
        log(f"FAIL: {e}")
        traceback.print_exc()
        sys.exit(1)
