#!/usr/bin/env python3
"""elab zcgl 材料易耗品低值品报账单（HC）自动填报 e2e。

安全策略（与财务递交一致）：自动开单到**保存草稿**为止，绝不点提交——
审批流（<1万经费负责人自批）由用户在系统里人工确认发起。

用法（观自在管线注入）:
  python tools/auto_elab_hc_e2e.py --config /tmp/opencode/elab_hc_cfg.json
config:
  {
    "jfly": "<经费卡号>",            // 经费来源卡（dgjfbxz 下拉 value）
    "byzd30": "",                             // 合同盖章部门（可空）
    "bz": "",                                 // 报账单备注（可空）
    "bills": [                                // 明细行（名称按惯例「分类目录*商品名」）
      {"name": "计算机外部设备*USB-C多功能扩展坞", "dj": "124.00", "sl": "1", "fph": "26112...", "bz": ""}
    ],
    "attachments": ["data/.../发票.pdf"],     // 发票扫描件（绝对/相对 ROOT）
    "dumpDir": "data/autobx_logs/elab_dumps"  // 失败现场
  }
stdout 进度逐行输出（PIPE 进 trace）。绝不 submit。
"""

import asyncio
import json
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
ENTRY_URL = "https://elab.ecnu.edu.cn/zcgl/index.jsp"

_parser = __import__("argparse").ArgumentParser()
_parser.add_argument("--config", default="")
_parser.add_argument("--delete-billno", default="")
_args, _ = _parser.parse_known_args()
CFG = json.loads(Path(_args.config).read_text(encoding="utf-8")) if _args.config else {}

DUMP_DIR = ROOT / CFG.get("dumpDir", "data/autobx_logs/elab_dumps")


def log(msg: str):
    print(f"[elab-hc] {msg}", flush=True)


def get_credentials() -> tuple[str, str]:
    configured = windows_school_credentials()
    if configured is not None:
        return configured
    def kc(a, s):
        r = subprocess.run(["security", "find-generic-password", "-a", a, "-s", s, "-w"], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() if r.returncode == 0 else ""
    username, password = kc("ecnu_sso", "ECNU SSO Login"), kc("ecnu_sso_pwd", "ECNU SSO Password")
    if not username or not password:
        raise RuntimeError("Keychain 无 ECNU 凭证")
    return username, password


class Stepper:
    """CDP 锚点轮询步进器：每次操作前重新解析 frame，任何未知状态落 dump。"""

    def __init__(self, page, dump_dir: Path):
        self.page = page
        self.dump_dir = dump_dir
        self.dump_dir.mkdir(parents=True, exist_ok=True)

    async def frame(self, pattern: str, timeout: float = 30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            f = next((f for f in self.page.frames if pattern in f.url), None)
            if f is not None:
                try:
                    if await f.evaluate("() => document.readyState") == "complete":
                        return f
                except Exception:
                    pass
            await asyncio.sleep(0.4)
        await self.dump(f"frame_{pattern.replace('/', '_').replace('?', '_')[:40]}")
        raise TimeoutError(f"frame '{pattern}' 未就绪（{timeout}s）")

    async def body(self, anchor_js: str, timeout: float = 30):
        """BodyFrame 就绪且锚点为真；中途 reload 自动重找。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            b = next((f for f in self.page.frames if f.name == "BodyFrame"), None)
            if b is not None:
                try:
                    if await b.evaluate(f"() => document.readyState === 'complete' && !!({anchor_js})"):
                        return b
                except Exception:
                    pass
            await asyncio.sleep(0.4)
        await self.dump(f"body_{abs(hash(anchor_js)) % 9999}")
        raise TimeoutError(f"BodyFrame 锚点未就绪: {anchor_js[:70]}")

    async def poll(self, frame, js: str, timeout: float = 15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                if await frame.evaluate(f"() => !!({js})"):
                    return True
            except Exception:
                return False
            await asyncio.sleep(0.4)
        return False

    async def fill_js(self, frame, selector: str, value: str):
        """老系统表单：赋值 + input/change 事件都补发（radio 不同步的教训）。"""
        await frame.evaluate(
            """([sel, val]) => {
              const el = document.querySelector(sel);
              if (!el) throw new Error('无元素 ' + sel);
              el.value = val;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }""",
            [selector, value],
        )

    async def dump(self, tag: str):
        try:
            d = self.dump_dir / tag
            d.mkdir(parents=True, exist_ok=True)
            (d / "url.txt").write_text(self.page.url, encoding="utf-8")
            await self.page.screenshot(path=str(d / "page.png"), full_page=True)
            frames = []
            for f in self.page.frames:
                try:
                    html = await f.evaluate("() => document.documentElement.outerHTML.slice(0, 300000)")
                    name = (f.name or "frame") + "_" + re.sub(r"[^a-z0-9]", "_", f.url.split("/")[-1].split("?")[0] or "doc")[:40]
                    (d / f"{name}.html").write_text(html, encoding="utf-8")
                    frames.append({"name": f.name, "url": f.url[:120]})
                except Exception:
                    frames.append({"name": f.name, "url": f.url[:120], "error": "detached"})
            (d / "frames.json").write_text(json.dumps(frames, ensure_ascii=False, indent=1), encoding="utf-8")
            log(f"FAIL 现场: {d}")
        except Exception as e:
            log(f"dump 失败: {e}")


import re  # noqa: E402  （dump 用）


async def nav_to_add_form(st, page, username: str, password: str):
    """登录 → 顶栏报账管理 → 展开菜单 → 新增表单就绪（BodyFrame 返回）。"""
    top = await st.frame("top_new")
    old_menu_url = (await st.frame("left_new")).url
    await top.evaluate("""() => { for (const el of document.querySelectorAll('a')) {
      if ((el.textContent || '').trim() === '报账管理') { el.click(); return; } } }""")
    menu = None
    deadline = time.time() + 20
    while time.time() < deadline:
        f = next((f for f in page.frames if "left_new" in f.url), None)
        if f and f.url != old_menu_url:
            try:
                if await f.evaluate("() => document.readyState") == "complete":
                    menu = f
                    break
            except Exception:
                pass
        await asyncio.sleep(0.4)
    if menu is None:
        await st.dump("menu_switch")
        raise RuntimeError("顶栏切换失败")
    log("已切到报账管理")

    # ③ 展开 no14 → 点「个人新增」（锚点：followTDno14）
    if not await st.poll(menu, "document.getElementById('zklb_no14')", timeout=10):
        await st.dump("zklb_no14_missing")
        raise RuntimeError("菜单 zklb_no14 不存在")
    await menu.evaluate("() => document.getElementById('zklb_no14').click()")
    if not await st.poll(menu, "(() => { const li = document.getElementById('followTDno14'); return !!li && li.querySelectorAll('td[title]').length > 0; })()", timeout=15):
        await st.dump("followTDno14_missing")
        raise RuntimeError("子菜单未展开")
    clicked = await menu.evaluate("""() => { const li = document.getElementById('followTDno14');
      for (const td of li.querySelectorAll('td[title]')) {
        if (td.getAttribute('title') === '个人新增材料、易耗品、低值品报账单') { td.click(); return true; } }
      return false; }""")
    if not clicked:
        await st.dump("add_item_missing")
        raise RuntimeError("「个人新增」菜单项未找到")
    log("已点个人新增")

    # ④ 告知页 → 表单（锚点：#ifread / addMXQD 函数）
    deadline = time.time() + 30
    body = None
    while time.time() < deadline:
        b = next((f for f in page.frames if f.name == "BodyFrame"), None)
        if b is not None:
            try:
                kind = await b.evaluate(
                    "() => document.readyState === 'complete' ? (!!document.querySelector('#ifread') ? 'notice' : (typeof addMXQD === 'function' ? 'form' : 'loading')) : 'loading'")
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


async def set_jfly(st, body, card: str):
    """选经费卡：fill 触发原生 tianxiejfb() 联动（JFLY 自动成『卡号:0.00;』格式，勿直写覆盖）。"""
    await st.fill_js(body, "#dgjfbxz", card)


APPROVE_OPINION = "本人承诺本报账单所购材料、易耗品、低值品等，均用于本校教学、科研及行政活动，所发生的经济业务均真实有效，且网上提交审核的内容与实际一致。"


async def delete_bill(page, wid: str) -> str:
    """删除报账单：GET bzdxx_DeletePage.jsp?wid=X 直接执行（无表单无确认）。
    回执在 sucClose('...') 里：'删除成功' 或 '不允许删除'（状态限制，文案里的编号可能为空的系统 bug）。"""
    resp = await page.request.get(f"https://elab.ecnu.edu.cn/zcgl/bzgl/bzd/bzdxx_DeletePage.jsp?wid={wid.strip()}")
    html = await resp.text()
    m = re.search(r"sucClose\('([^']*)'\)", html)
    if not m:
        return "回执未解析（页面结构变化？）"
    return m.group(1).replace("\\n", " ").strip()


async def auto_approve(st, page, ctx, bill_no: str) -> None:
    """自动同意：首页消息区找「<bill_no> 需要您审核」→「审 核」→ 审批工作台（ywcl_index popup）
    → ywcl_zhengWen frame 填意见+选同意 → f_submit 提交 → 流程表校验出现「通过」。"""
    log("开始自动同意（经费负责人审批环节，审批人=本人）…")
    await page.goto(ENTRY_URL, wait_until="domcontentloaded")
    for _ in range(20):
        if next((f for f in page.frames if "left_new" in f.url), None):
            await asyncio.sleep(1)
            break
        await asyncio.sleep(0.5)
    body = next((f for f in page.frames if f.name == "BodyFrame"), None)
    if body is None:
        await st.dump("approve_no_bodyframe")
        raise RuntimeError("自动同意：首页 BodyFrame 不存在")
    # 先确认消息在，再在 expect_page 语境里点击（popup 事件必须先注册后触发）
    entry = await body.evaluate(
        """(billNo) => {
          const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(billNo) && tr.textContent.includes('需要您审核'));
          if (!row) return '审核消息未找到';
          const link = Array.from(row.querySelectorAll('a, input, button')).find((el) => /^审\\s*核$/.test((el.textContent || el.value || '').trim()));
          return link ? '消息与审核按钮在位' : '审核按钮未找到';
        }""",
        bill_no,
    )
    log(f"消息入口：{entry}")
    if "在位" not in entry:
        await st.dump("approve_no_message")
        raise RuntimeError(f"自动同意失败：{entry}")
    async with ctx.expect_page(timeout=15000) as pop:
        await body.evaluate(
            """(billNo) => {
              const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(billNo) && tr.textContent.includes('需要您审核'));
              const link = Array.from(row.querySelectorAll('a, input, button')).find((el) => /^审\\s*核$/.test((el.textContent || el.value || '').trim()));
              link.click();
            }""",
            bill_no,
        )
    ap = await pop.value
    await ap.wait_for_load_state("domcontentloaded")
    await asyncio.sleep(4)
    log(f"审批工作台已打开：{ap.url[:90]}")
    submitted = False
    for f in ap.frames:
        if "ywcl_zhengWen" not in f.url:
            continue
        r = await f.evaluate(
            """(opinion) => {
              const clyj = document.getElementById('clyj');
              if (!clyj) return '意见框未找到';
              clyj.value = opinion;
              const agree = Array.from(document.querySelectorAll('input[name=cljl]')).find((r) => r.value === '1');
              if (!agree) return '决策 radio 未找到';
              agree.checked = true;
              agree.click();
              document.getElementById('submButton').click();
              return '已填意见、选同意并提交审批';
            }""",
            APPROVE_OPINION,
        )
        log(f"审批动作：{r}")
        submitted = "提交" in r
        break
    if not submitted:
        await st.dump("approve_no_zhengwen")
        raise RuntimeError("自动同意失败：未找到审批操作 frame")
    await asyncio.sleep(8)


async def main() -> int:
    username, password = get_credentials()
    # 只删模式：--delete-billno HC26xxxxxx（或 config deleteBillNo / deleteWid）——按状态直接删，删完退出
    delete_target = CLI_DELETE or CFG.get("deleteBillNo", "")
    delete_wid = CFG.get("deleteWid", "")
    if delete_target or delete_wid:
        async with async_playwright() as p:
            browser = await launch_chromium(p, channel="chrome", headless=True)
            ctx_args = {"locale": "zh-CN"}
            if STORAGE_PATH.exists():
                ctx_args["storage_state"] = str(STORAGE_PATH)
            ctx = await browser.new_context(**ctx_args)
            page = await ctx.new_page()
            await page.goto(ENTRY_URL, wait_until="domcontentloaded")
            for _ in range(20):
                if next((f for f in page.frames if "left_new" in f.url), None):
                    await asyncio.sleep(1)
                    break
                await asyncio.sleep(0.5)
            body = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if not delete_wid:
                await body.evaluate("() => location.href = '/zcgl/bzgl/bzd/ListPage.jsp?zclx=PLHC&role=ptyh&sumZclx=HC&fromzclx=XM&sqjsbh=03110'")
                await asyncio.sleep(4)
                body = next((f for f in page.frames if f.name == "BodyFrame"), None)
                delete_wid = await body.evaluate(
                    """(billNo) => {
                      const a = Array.from(document.querySelectorAll('a')).find((el) => (el.textContent || '').includes(billNo));
                      return a ? (a.getAttribute('href').match(/\\d{15,}/) || [''])[0].trim() : '';
                    }""",
                    delete_target,
                )
                if not delete_wid:
                    print(f"[elab-hc] FAIL: 列表未找到 {delete_target}")
                    await browser.close()
                    return 1
            receipt = await delete_bill(page, delete_wid)
            print(f"[elab-hc] 删除回执：{receipt}")
            await browser.close()
            return 0 if "成功" in receipt else 1
    bills = CFG["bills"]
    jfly = CFG.get("jfly", "")
    bill_no_holder: dict = {}
    # 发票号格式防线：纯数字 8~25 位（数电票 20 位）——双源视觉验证一致性由 plan 阶段保证
    for i, bill in enumerate(bills):
        fph = str(bill.get("fph", ""))
        if fph and not re.fullmatch(r"\d{8,25}", fph):
            raise RuntimeError(f"明细 {i} 发票号格式非法: {fph!r}（应为纯数字；图片发票需系统模型+zai MCP 双源一致后才入 plan）")
    async with async_playwright() as p:
        browser = await launch_chromium(p, channel="chrome", headless=True)
        ctx_args = {"locale": "zh-CN"}
        if STORAGE_PATH.exists():
            ctx_args["storage_state"] = str(STORAGE_PATH)
        ctx = await browser.new_context(**ctx_args)
        page = await ctx.new_page()
        popups: list = []
        ctx.on("page", lambda pw: popups.append(pw))
        st = Stepper(page, DUMP_DIR / time.strftime("%Y%m%d_%H%M%S"))

        # ① 登录（锚点：left_new frame）
        await page.goto(ENTRY_URL, wait_until="domcontentloaded")
        try:
            await st.frame("left_new", timeout=12)
            log("登录态复用成功")
        except TimeoutError:
            log("session 失效，SSO 重登")
            await page.wait_for_selector("#nameInput", timeout=20000)
            await page.fill("#nameInput", username)
            await page.fill("input[type=password] >> visible=true", password)
            deadline = time.time() + 10
            while time.time() < deadline:
                cls = await page.evaluate("() => document.querySelector('#submitBtn')?.className || ''")
                if "disabled" not in cls:
                    break
                await asyncio.sleep(0.4)
            else:
                await st.dump("sso_btn_disabled")
                raise RuntimeError("登录按钮未解锁")
            await page.click("#submitBtn")
            await st.frame("left_new", timeout=45)
            log("SSO 登录成功")
        STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        await ctx.storage_state(path=str(STORAGE_PATH))

        resume_wid = CFG.get("resumeWid", "")
        baseline_bills: set = set()
        if resume_wid:
            # 续作模式：直接在 BodyFrame 打开已有单编辑页补附件（不新建）
            await st.frame("left_new", timeout=20)
            body0 = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if body0 is None:
                await st.dump("resume_no_bodyframe")
                raise RuntimeError("BodyFrame 不存在")
            await body0.evaluate(f"() => location.href = '/zcgl/bzgl/bzd/bzdxx_EditPage.jsp?wid={resume_wid}'")
            body = await st.body("typeof fileManagerRefresh === 'function'", timeout=30)
            wid_value = await body.evaluate("() => document.getElementById('wid')?.value || ''")
            log(f"续作单已打开: wid={wid_value} 单号={await body.evaluate('() => document.getElementById(\'BZDBH\')?.value || \'?\'')}")
            # 经费来源缺失自动补填（EditPage 回显可能为空，保存前必须确保经费卡在位）
            if jfly:
                current = await body.evaluate("() => document.getElementById('dgjfbxz')?.value || ''")
                if not current:
                    await set_jfly(st, body, jfly)
                    log(f"续作补填经费来源: {jfly}")
                    # EditPage 缺 commonCheck 依赖的元数据 input（field/fieldname/type）——从 AddPage 字段清单注入修复保存链
                    await body.evaluate("""() => {
                      const mk = (id, val) => {
                        if (!document.getElementById(id)) {
                          const el = document.createElement('input');
                          el.type = 'hidden'; el.id = id; el.name = id; el.value = val;
                          document.body.appendChild(el);
                        }
                      };
                      mk('field', 'BZDBH,BMBH,YDDH,BYZD1,BYZD30,ZSHTBH,BZ,JFLY,');
                      mk('fieldname', '报帐单编号,部门,手机号码,联系电话,合同盖章部门,合同号,备注,经费来源,');
                      mk('type', '1,1,1,1,1,1,1,1,');
                    }""")
                    if not CFG.get("dryRun"):
                        await body.evaluate("() => check1()")
                        await asyncio.sleep(2.5)
                        log("续作保存完成")
        else:
            # 基线单号集合：BZDBH 锚点偶发失效时用列表差集回退定位新草稿单号
            await st.frame("left_new", timeout=20)
            b0 = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if b0 is not None:
                await b0.evaluate("() => location.href = '/zcgl/bzgl/bzd/ListPage.jsp?zclx=PLHC&role=ptyh&sumZclx=HC&fromzclx=XM&sqjsbh=03110'")
                await asyncio.sleep(4)
                b0 = next((f for f in page.frames if f.name == "BodyFrame"), None)
                if b0 is not None:
                    try:
                        baseline_bills = set(await b0.evaluate("() => (document.body.innerText.match(/HC\\d{7}/g) || [])"))
                    except Exception:
                        baseline_bills = set()
            body = await nav_to_add_form(st, page, username, password)

        if not resume_wid:
            # ⑤ 经费来源交叉验证：必须命中项目预算表（直接经费），间接经费拒跑
            if jfly:
                budget_file = ROOT / "data" / "budgets" / f"{jfly}.json"
                if not budget_file.exists():
                    await st.dump("jfly_not_in_budgets")
                    raise RuntimeError(
                        f"经费卡 {jfly} 不在项目预算表（data/budgets/）——疑似间接经费项目，拒绝填报；"
                        f"请改用预算表内的直接经费卡")
                budget = json.loads(budget_file.read_text(encoding="utf-8"))
                log(f"经费来源已验证: {jfly} = {budget.get('projectName', '?')[:30]}")

            # ⑥ 填表头：经费来源（必填）+ 合同盖章部门 + 备注
            if jfly:
                await set_jfly(st, body, jfly)
                log(f"经费来源: {jfly}")
            if CFG.get("byzd30"):
                await st.fill_js(body, "#BYZD30", CFG["byzd30"])
            if CFG.get("bz"):
                await st.fill_js(body, "#BZ", CFG["bz"])

            # ⑦ 明细行注入（每条 addMXQD('HC')，锚点：HC_MC_<i> 出现）
            for i, bill in enumerate(bills):
                ok = await st.poll(body, f"typeof addMXQD === 'function'", timeout=10)
                if not ok:
                    await st.dump(f"addMXQD_missing_{i}")
                    raise RuntimeError("addMXQD 函数丢失（页面被刷新？）")
                await body.evaluate("() => addMXQD('HC')")
                if not await st.poll(body, f"document.getElementById('HC_MC_{i}')", timeout=12):
                    await st.dump(f"mx_row_{i}")
                    raise RuntimeError(f"明细行 {i} 注入失败")
                await st.fill_js(body, f"#HC_MC_{i}", bill["name"])
                await st.fill_js(body, f"#HC_DJ_{i}", str(bill["dj"]))
                await st.fill_js(body, f"#HC_SL_{i}", str(bill.get("sl", "1")))
                if bill.get("fph"):
                    await st.fill_js(body, f"#HC_FPH_{i}", str(bill["fph"]))
                # 非常规材料（低值品/易耗品）提交校验要求备注购买理由——缺省用通用模板
                await st.fill_js(body, f"#HC_BZ_{i}", str(bill.get("bz") or "用于实验室建设"))
                log(f"明细 {i}: {bill['name']} x{bill.get('sl', 1)} @ {bill['dj']}")

            # ⑦b 填值读回断言（老系统表单必须 live CDP 确认，dump HTML 看不到 property）
            body = await st.body("typeof check1 === 'function'", timeout=10)
            checks = [("#dgjfbxz", jfly), ("#JFLYJF", jfly)] if jfly else []
            for i, bill in enumerate(bills):
                checks += [(f"#HC_MC_{i}", bill["name"]), (f"#HC_DJ_{i}", str(bill["dj"])), (f"#HC_SL_{i}", str(bill.get("sl", "1")))]
                if bill.get("fph"):
                    checks.append((f"#HC_FPH_{i}", str(bill["fph"])))
            mismatch = await body.evaluate(
                """(checks) => checks.filter(([sel, val]) => (document.querySelector(sel)?.value || '').trim() !== String(val).trim()).map(([sel]) => sel)""",
                checks,
            )
            if mismatch:
                await st.dump("fill_verify_fail")
                raise RuntimeError(f"填值未生效: {mismatch}")
            if jfly:
                # JFLY 是『卡号:0.00;』联动生成格式（非裸卡号），只校验前缀
                jfly_val = await body.evaluate("() => document.getElementById('JFLY')?.value || ''")
                if not jfly_val.startswith(jfly):
                    await st.dump("jfly_format_fail")
                    raise RuntimeError(f"JFLY 格式异常: {jfly_val[:40]!r}（应以经费卡号开头）")
            total = sum(float(b["dj"]) * float(b.get("sl", 1)) for b in bills)
            log(f"填值断言通过: {len(checks)} 项全对，明细合计 {total:.2f}")

        # ⑦ 附件上传（发票扫描件）：fileManagerRefresh 界面形态未实证——先 dump 再操作
        attachments = [] if CFG.get("dryRun") else [str((ROOT / a) if not Path(a).is_absolute() else Path(a)) for a in CFG.get("attachments", [])]
        if attachments:
            body = await st.body("typeof fileManagerRefresh === 'function'", timeout=10)
            wid = await body.evaluate("() => document.getElementById('wid')?.value || ''")
            # fileManagerRefresh = window.open 独立弹窗（pub/fileManager.jsp），popup 是独立 page
            await body.evaluate(f"() => fileManagerRefresh({json.dumps(wid)})")
            upload_page = None
            deadline = time.time() + 15
            while time.time() < deadline:
                for pw in popups:
                    try:
                        if "fileManager" in pw.url and await pw.evaluate("() => document.readyState") == "complete":
                            upload_page = pw
                            break
                    except Exception:
                        pass
                if upload_page:
                    break
                await asyncio.sleep(0.4)
            if upload_page is None:
                await st.dump("upload_popup_missing")
                raise TimeoutError("fileManager 弹窗未出现")
            log("已打开附件管理窗口")
            # 上传控件在弹窗二层 frame（ywxxFrame → fjgl_index.jsp），轮询等其就绪
            fj_frame = None
            deadline = time.time() + 20
            while time.time() < deadline:
                for f in upload_page.frames:
                    try:
                        if "fjgl_index" in f.url and await f.evaluate("() => document.readyState === 'complete' && !!document.getElementById('ywfjfl')"):
                            fj_frame = f
                            break
                    except Exception:
                        pass
                if fj_frame:
                    break
                await asyncio.sleep(0.4)
            if fj_frame is None:
                await st.dump("fj_frame_missing")
                raise TimeoutError("附件管理 frame 未就绪")
            # 发票扫描件分类 + 附件上限（读运行时值）
            ywfjfl = await fj_frame.evaluate("() => document.getElementById('ywfjfl')?.value || 'FPSMWJ'")
            maxsize_mb = await fj_frame.evaluate("() => document.getElementById('fileSizeLimit')?.value || '5'")
            log(f"附件分类：发票扫描件（单文件上限 {maxsize_mb}MB）")
            # 绕过 layui UI：逐文件 POST multipart 到 fjgl_FileUploadDispose.jsp（file 字段）
            import base64 as _b64
            import urllib.parse as _up
            base_url = upload_page.url.split("/zcgl/")[0]
            post_url = f"{base_url}/zcgl/ywsp/lcpz/fjgl_FileUploadDispose.jsp?maxsize={int(float(maxsize_mb) * 1024 * 1024)}"
            uploaded, failed = [], []
            for path in attachments:
                fname = Path(path).name
                b64 = _b64.b64encode(Path(path).read_bytes()).decode()
                try:
                    result = await fj_frame.evaluate(
                        """async ([url, fname, b64, ywfjfl, opWid]) => {
                          const bin = atob(b64);
                          const bytes = new Uint8Array(bin.length);
                          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                          const fd = new FormData();
                          fd.append("file", new Blob([bytes]), fname);
                          fd.append("Operation_Code", "ZC_BZD");
                          fd.append("Operation_Wid", opWid);
                          fd.append("ywfjfl", ywfjfl);
                          for (const k of ["role", "CanEdit", "zclxbh", "lzh", "jdh", "dxcs", "dscs", "BYZD1", "BYZD2", "BYZD3", "filetype", "wjlx_column", "wjdx_column", "sfblob", "sfjm", "refresh"]) fd.append(k, "");
                          const resp = await fetch(url, { method: "POST", body: fd, credentials: "include" });
                          return { status: resp.status, text: (await resp.text()).slice(0, 200) };
                        }""",
                        [post_url, fname, b64, ywfjfl, wid],
                    )
                    ok = result["status"] == 200 and "error" not in result["text"].lower() or result["status"] == 200
                    (uploaded if result["status"] == 200 else failed).append(fname)
                    log(f"  ✓ 发票已上传：{fname[:44]}")
                except Exception as e:
                    failed.append(fname)
                    log(f"  上传 {fname} 异常: {str(e)[:80]}")
            # 锚点验证：刷新列表后记录数
            await fj_frame.evaluate("() => location.reload()")
            await asyncio.sleep(2.5)
            for f in upload_page.frames:
                if "fjgl_index" in f.url:
                    try:
                        rows = await f.evaluate("() => (document.body.innerText.match(/\\d{4}-\\d{2}-\\d{2}/g) || []).length")
                        log(f"  附件清单核验：{rows} 条记录")
                    except Exception:
                        pass
            if failed:
                await st.dump("upload_failed")
                raise RuntimeError(f"{len(failed)} 个附件上传失败: {failed}")
            try:
                await upload_page.close()
            except Exception:
                pass
            log("附件上传完成")

        if CFG.get("dryRun"):
            await st.dump("dry_run_final")
            log("dryRun：导航/填表验证完成，跳过附件与保存（现场已 dump）")
            await browser.close()
            return 0

        # ⑧ 保存草稿（check1）——绝不提交。锚点：BZDBH 获值；URL 已跳转时继续等值（302 落地后回填有延迟）
        body = await st.body("typeof check1 === 'function'", timeout=10)
        pre_url = body.url
        await body.evaluate("() => check1()")
        ok = False
        deadline = time.time() + 25
        while time.time() < deadline:
            b = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if b is not None:
                try:
                    state = await b.evaluate("""() => ({
                      bzbh: document.getElementById('BZDBH')?.value || '',
                      success: document.getElementById('success')?.value || '',
                      url: location.href,
                    })""")
                    if state["bzbh"]:
                        bill_no_holder["bzbh"] = state["bzbh"]
                        print(f"BZDBH={state['bzbh']}")
                        ok = True
                        break
                    if state["url"] == pre_url and state["success"]:
                        ok = True
                        break
                except Exception:
                    pass
            await asyncio.sleep(0.5)
        if not ok and not resume_wid:
            # 回退：列表差集定位新草稿单号（BZDBH 回填偶发失效，保存本身大概率成功）
            b = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if b is not None:
                await b.evaluate("() => location.href = '/zcgl/bzgl/bzd/ListPage.jsp?zclx=PLHC&role=ptyh&sumZclx=HC&fromzclx=XM&sqjsbh=03110'")
                await asyncio.sleep(4)
                b = next((f for f in page.frames if f.name == "BodyFrame"), None)
                if b is not None:
                    try:
                        current = set(await b.evaluate("() => (document.body.innerText.match(/HC\\d{7}/g) || [])"))
                        added = current - baseline_bills
                        if len(added) == 1:
                            bill_no_holder["bzbh"] = added.pop()
                            print(f"BZDBH={bill_no_holder['bzbh']}（列表差集回退）")
                            ok = True
                    except Exception:
                        pass
        if not ok:
            await st.dump("save_unverified")
            log("WARN: 保存结果未确认（BZDBH 未取到），现场已 dump——请人工核对列表页")
        else:
            log(f"✓ 草稿已保存：{bill_no_holder.get('bzbh', '')}（共 {len(bills)} 笔明细）")

        # ⑨ 自动提交审批（autoSubmit）：草稿保存后在编辑页找提交入口，confirm 全部接受
        if CFG.get("autoSubmit") and bill_no_holder.get("bzbh"):
            log("开始提交审批 …")
            # 关键：myaudit 是「保存 submit → confirm → 提交 submit」连发——headless 里 confirm
            # 阻塞期间第一次保存的 302 落地卸载页面，第二次提交 submit 被杀（真实用户页面 idle 无此竞态）。
            # 绕开：等保存 302 落地页面重载后，直接以 saveandaudit=1 调 btnNewEditSaveData 单次提交
            #（等价于 putAuditing 确认后的动作，无 confirm 无竞态）。
            await asyncio.sleep(3)
            body = await st.body("typeof myaudit === 'function'", timeout=25)
            # 带参重开（必须）：保存 302 落地的编辑页缺 zclxbh 字段——在其上提交服务端只保存不提交
            # （success=保存成功、流程无节点，实测）。重导航后必须等 URL 真正变化再取 frame
            #（跳转中 st.body 会抓到 detached 旧文档，操作全部落空——231545/232006 两轮失败根因）。
            wid_for_url = await body.evaluate("() => document.getElementById('wid')?.value || ''")
            if wid_for_url and "zclxbh=" not in (body.url or ""):
                await body.evaluate(f"() => location.href = '/zcgl/bzgl/bzd/bzdxx_EditPage.jsp?wid={wid_for_url}&zclxbh=PLHC&sumZclx=HC'")
                nav_deadline = time.time() + 20
                while time.time() < nav_deadline:
                    b = next((f for f in page.frames if f.name == "BodyFrame"), None)
                    if b is not None and "zclxbh=PLHC" in b.url:
                        try:
                            if await b.evaluate("() => typeof myaudit === 'function' && !!document.getElementById('btnPutAuditing')"):
                                body = b
                                break
                        except Exception:
                            pass
                    await asyncio.sleep(0.5)
                else:
                    await st.dump("renav_timeout")
                    raise RuntimeError("带参重开编辑页超时（BodyFrame 未就绪）")
                log("已按带参 URL 重开编辑页（zclxbh=PLHC&sumZclx=HC）")
            # 2026-09-10 定案：参数直写两度翻车（operator=putAuditing → 状态审核中但流程未启动无处理人；
            # saveandaudit+refresh=2 → 后端纯保存）。最终方案 = 零猜测：dialog 全自动应答 + 点击原生
            # 「提交审核」按钮，让页面自己的 myaudit→confirm→putAuditing 链全权处理——与人工操作完全同路径。
            # 所有弹窗文本记录为证据（「提交成功」「提交失败！原因是…」「修改数据后尚未保存」等）。
            dialog_log: list[str] = []

            async def on_dialog(dialog) -> None:
                dialog_log.append(f"[{dialog.type}] {dialog.message.strip()[:200]}")
                try:
                    await dialog.accept()
                except Exception:
                    pass

            page.on("dialog", on_dialog)
            try:
                pre = await body.evaluate("""() => ({
                  modified: window.modified,
                  jfly: document.getElementById('JFLY')?.value || '',
                  zclxbh: (document.getElementById('zclxbh') || {}).value || '(缺)',
                })""")
                log(f"提交前检查：{pre}")
                if pre.get("modified") == 1:
                    await st.dump("submit_modified_unsaved")
                    raise RuntimeError("提交前 modified=1（带参重导航后仍有未保存改动，异常态）")
                if pre.get("zclxbh") == "(缺)":
                    await st.dump("submit_no_zclxbh")
                    raise RuntimeError("编辑页缺 zclxbh 字段（带参重开未生效）——在此页提交服务端只保存")
                if not pre.get("jfly") and jfly:
                    await body.evaluate("""(card) => {
                      const jflyEl = document.getElementById('JFLY');
                      jflyEl.readOnly = false;
                      jflyEl.value = card + ':0.00;';
                    }""", jfly)
                    log("JFLY 直写兜底完成")
                # 提交偶发竞态（dialog accept 竞态/302 时序），失败自动重试一次：重开带参页再点
                async def nav_edit_page(wid: str) -> None:
                    """带参重导航到编辑页并等 BodyFrame 就绪；全程 try，detached/网络错误不炸任务。"""
                    target = next((f for f in page.frames if f.name == "BodyFrame"), None)
                    if target is None:
                        return
                    try:
                        await target.evaluate(f"() => location.href = '/zcgl/bzgl/bzd/bzdxx_EditPage.jsp?wid={wid}&zclxbh=PLHC&sumZclx=HC'")
                    except Exception:
                        pass
                    deadline = time.time() + 20
                    while time.time() < deadline:
                        b2 = next((f for f in page.frames if f.name == "BodyFrame"), None)
                        if b2 is not None and "zclxbh=PLHC" in b2.url and "chromewebdata" not in b2.url:
                            try:
                                if await b2.evaluate("() => typeof myaudit === 'function' && !!document.getElementById('btnPutAuditing') && document.readyState === 'complete'"):
                                    body = b2
                                    return
                            except Exception:
                                pass
                        await asyncio.sleep(0.5)

                for attempt in (1, 2, 3):
                    if attempt >= 2:
                        log(f"提交第 {attempt - 1} 次未确认生效，自动重试 …")
                    # 页面 settle：302 落地后 bzd.js 的事件绑定需要时间（手工 4s 成功/0s 失败对照）
                    await asyncio.sleep(4)
                    # 网络错误页兜底（chrome-error）：重新导航编辑页
                    b_now = next((f for f in page.frames if f.name == "BodyFrame"), None)
                    if b_now is not None and "chromewebdata" in b_now.url:
                        log("检测到页面加载错误（chrome-error），重新导航编辑页 …")
                        await nav_edit_page(wid_for_url)
                    clicked = await body.evaluate("""() => {
                      const btn = document.getElementById('btnPutAuditing');
                      if (!btn) return '提交按钮不存在';
                      btn.click();
                      return '已点击「提交审核」';
                    }""")
                    log(f"提交入口（第 {attempt} 次）：{clicked}")
                    # 原生链：confirm 接受 → 表单 submit → 页面流转 → 回执 alert 自动关闭
                    await asyncio.sleep(12)
                    for entry in dialog_log:
                        log(f"弹窗回执 {entry}")
                    # 校验类拦截（无需重试，直接失败分类）
                    if any(("尚未保存" in e or "提交失败" in e or "备注购买理由" in e or "请备注" in e) for e in dialog_log):
                        break
                    # 第 1 次后准备重试：重开带参编辑页保证干净起点（现抓 frame + 全 try，detached 不炸）
                    if attempt == 1:
                        log("提交第一次未确认生效，自动重试一次 …")
                        try:
                            await nav_edit_page(wid_for_url)
                        except Exception as e:
                            log(f"重试导航失败：{str(e)[:80]}")
                        dialog_log.clear()
                # 提交后遥测：确认表单 submit 是否真的发生（页面应已 302 跳转并带回执）
                b = next((f for f in page.frames if f.name == "BodyFrame"), None)
                if b is not None:
                    try:
                        post = await b.evaluate("""() => ({
                          url: location.href.slice(-70),
                          saveandaudit: document.getElementById('saveandaudit')?.value ?? null,
                          success: document.getElementById('success')?.value ?? null,
                          operator: document.getElementById('operator')?.value ?? null,
                          refresh: document.getElementById('refresh')?.value ?? null,
                          zclxbh: document.getElementById('zclxbh')?.value ?? null,
                        })""")
                        log(f"提交后遥测：{post}")
                    except Exception as e:
                        log(f"提交后遥测失败：{str(e)[:80]}")
                if any("尚未保存" in entry for entry in dialog_log):
                    await st.dump("submit_modified_blocked")
                    raise RuntimeError("提交被拦：数据修改后未保存（原生 myaudit 拦截）")
                if any("提交失败" in entry for entry in dialog_log):
                    await st.dump("submit_failed_alert")
                    raise RuntimeError("提交失败（原生弹窗回执，原因见日志）")
                if any("备注购买理由" in entry or "请备注" in entry for entry in dialog_log):
                    await st.dump("submit_need_reason")
                    raise RuntimeError("提交被拦：明细缺购买理由备注（应在填报时自动补齐——检查 plan 的 bz 字段）")
            finally:
                pass
            # 权威核对：跳列表页读该单「状态」列——弹窗文本不可信（『单击确定继续』曾致误判）
            await asyncio.sleep(1.5)
            body = next((f for f in page.frames if f.name == "BodyFrame"), None)
            if body is None:
                await st.dump("submit_verify_noframe")
                raise RuntimeError("提交核对时 BodyFrame 丢失")
            await body.evaluate("() => location.href = '/zcgl/bzgl/bzd/ListPage.jsp?zclx=PLHC&role=ptyh&sumZclx=HC&fromzclx=XM&sqjsbh=03110'")
            bill_status = ""
            deadline = time.time() + 25
            while time.time() < deadline:
                b = next((f for f in page.frames if f.name == "BodyFrame"), None)
                if b is not None:
                    try:
                        # 双条件：必须已在 ListPage（EditPage 表单里也有「报帐单编号」字样会误判）
                        # 且数据行已渲染（HC\d{7} 出现）——表头先到、数据行异步，未出现则继续轮询
                        if "ListPage" in b.url and await b.evaluate("() => document.readyState === 'complete' && /HC\\d{7}/.test(document.body.innerText)"):
                            bill_status = await b.evaluate(
                                """(bzbh) => {
                                  const row = Array.from(document.querySelectorAll('tr')).find((tr) => tr.textContent.includes(bzbh));
                                  if (!row) return '(列表未找到)';
                                  return row.textContent.replace(/\\s+/g, ' ').trim().slice(-80);
                                }""",
                                bill_no_holder["bzbh"],
                            )
                            break
                    except Exception:
                        pass
                await asyncio.sleep(0.5)
            log(f"列表核对：{bill_no_holder['bzbh']} 状态 = {bill_status or '(未读到)'}")
            # 实证：提交完整推进 = 行尾出现「审核中 + 处理人 + 审批环节」（经费负责人审批=自批链；
            # 实验室与装备处审批=含非常规品目/特殊品类被路由到装备处人工审——部分辅助用品实测）；
            # 仅「审核中」无处理人/环节 = 流程只建「提交审批」节点的假阳性
            full_advance = (bill_status and "审核中" in bill_status and "未找到" not in bill_status
                            and ("经费负责人审批" in bill_status or "实验室与装备处" in bill_status))
            if bill_status and "填写中" not in bill_status and "未找到" not in bill_status:
                print("##ELABSUBMITTED##")
                bill_no_holder["submitted"] = True
                if full_advance:
                    log(f"✓ 已提交审批且流程推进：{bill_no_holder['bzbh']}（{bill_status}）")
                else:
                    log(f"△ 状态已变「审核中」但未见完整推进三要素：{bill_status}")
            else:
                await st.dump("submit_not_effective")
                raise RuntimeError(
                    f"提交未生效：单据状态为「{bill_status or '未知'}」——请人工在 elab 提交（现场已留存）")
            # ⑩ 自动同意（autoApprove）：经费负责人审批环节审批人=本人——首页消息进审批工作台，填意见选同意
            if CFG.get("autoApprove") and full_advance:
                await auto_approve(st, page, ctx, bill_no_holder["bzbh"])
        elif bill_no_holder.get("bzbh"):
            log("（按配置仅保存草稿，未提交审批）")

        await browser.close()
        return 0


if __name__ == "__main__":
    CLI_DELETE = _args.delete_billno
    try:
        sys.exit(asyncio.run(main()))
    except Exception as e:
        log(f"FAIL: {e}")
        traceback.print_exc()
        sys.exit(1)
