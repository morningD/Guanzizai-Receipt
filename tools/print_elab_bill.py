#!/usr/bin/env python3
"""打印 elab 报账单 PDF：GET bzdxx_printNewBzdExcel.jsp（服务端生成 PDF）→ 存入票据集文件夹。

用法：python3 print_elab_bill.py --wid <wid> --billno HCxxxxxxx --folder <票据集目录> --amount <金额> [--system zcgl|wxzc]
输出：zcgl → <folder>/<当天日期>_elab_<billno>_资产入账单_CNY<amount>.pdf
      wxzc → <folder>/<当天日期>_elab_<billno>_报账单_CNY<amount>.pdf
"""

import argparse
import asyncio
import datetime
import sys
from urllib.parse import parse_qs, urlencode, urlsplit

from receipt_runtime import DATA_ROOT, launch_chromium, school_session

ROOT = DATA_ROOT
STORAGE_PATH = school_session("elab")

_parser = argparse.ArgumentParser()
_parser.add_argument("--wid", required=True)
_parser.add_argument("--billno", required=True)
_parser.add_argument("--folder", required=True)
_parser.add_argument("--amount", default="")
_parser.add_argument("--system", default="zcgl", choices=["zcgl", "wxzc"])
args = _parser.parse_args()

ORIGIN = "https://elab.ecnu.edu.cn"


def print_url(system, wid, authenticated_urls=()):
    params = {"systemid": "ZCXT2", "action": "addExcel",
              "ZCLXBH": "CSF" if system == "wxzc" else "PLHC", "hidWWID": wid}
    for url in authenticated_urls:
        parsed = urlsplit(url)
        if parsed.scheme != "https" or parsed.netloc != "elab.ecnu.edu.cn":
            continue
        query = parse_qs(parsed.query)
        if query.get("token") and query.get("userId"):
            params["token"] = query["token"][0]
            params["userId"] = query["userId"][0]
            break
    return f"{ORIGIN}/{system}/bzgl/bzd/bzdxx_printNewBzdExcel.jsp?{urlencode(params)}"


async def main() -> int:
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        browser = await launch_chromium(p, channel="chrome", headless=True)
        ctx = await browser.new_context(locale="zh-CN", storage_state=str(STORAGE_PATH) if STORAGE_PATH.exists() else None)
        response = await ctx.request.get(print_url(args.system, args.wid.strip()))
        body = await response.body()
        if not body.startswith(b"%PDF"):
            page = await ctx.new_page()
            await page.goto(f"{ORIGIN}/{args.system}/index.jsp", wait_until="domcontentloaded")
            urls = [frame.url for frame in page.frames]
            url = print_url(args.system, args.wid.strip(), urls)
            if url != print_url(args.system, args.wid.strip()):
                response = await ctx.request.get(url)
                body = await response.body()
        await browser.close()
    if not body.startswith(b"%PDF"):
        print(f"FAIL: 打印接口未返回 PDF（{len(body)} 字节，可能单据状态不允许打印）", file=sys.stderr)
        return 1
    folder = ROOT / args.folder.strip("/")
    folder.mkdir(parents=True, exist_ok=True)
    today = datetime.date.today().isoformat()
    amount_part = f"_CNY{args.amount}" if args.amount else ""
    kind = "报账单" if args.system == "wxzc" else "资产入账单"
    out = folder / f"{today}_elab_{args.billno}_{kind}{amount_part}.pdf"
    out.write_bytes(body)
    print(f"OK: {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
