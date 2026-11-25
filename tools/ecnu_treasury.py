#!/usr/bin/env python3
"""ECNU 财务系统（treasury）SSO 接入：Keychain 凭证 + Playwright session 缓存。

自原 DF/fetch_salary.py 提取（2026-09 DF 集成进观自在系统，原目录已删除），
tools/fetch_budget.py 与 tools/fetch_salary.py 共用本模块。

凭证存 macOS Keychain（服务名不变，老 session 可直接迁移）:
  security add-generic-password -a ecnu_sso -s "ECNU SSO Login" -w <账号> -U
  security add-generic-password -a ecnu_sso_pwd -s "ECNU SSO Password" -w <密码> -U
"""

import subprocess
import sys
from pathlib import Path

try:
    from playwright.async_api import async_playwright
except ImportError:
    print("请先安装 playwright: pip install playwright && playwright install chromium")
    sys.exit(1)

from receipt_runtime import DATA_ROOT, launch_chromium, school_session, windows_school_credentials

ROOT = DATA_ROOT
TREASURY_URL = 'https://treasury.ecnu.edu.cn/WFManager/home2.jsp'
DATA_DIR = ROOT / 'data' / 'df'
STORAGE_PATH = school_session("treasury")
DEBUG_DIR = DATA_DIR


def get_keychain_value(account: str, service: str) -> str:
    """从 macOS Keychain 读取密码"""
    try:
        result = subprocess.run(
            ['security', 'find-generic-password', '-a', account, '-s', service, '-w'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ''


def get_credentials() -> tuple[str, str]:
    """从 Keychain 获取 ECNU SSO 凭证"""
    configured = windows_school_credentials()
    if configured is not None:
        return configured
    username = get_keychain_value('ecnu_sso', 'ECNU SSO Login')
    password = get_keychain_value('ecnu_sso_pwd', 'ECNU SSO Password')

    if not username or not password:
        print("错误: 未在 Keychain 中找到 ECNU 凭证")
        print("请运行以下命令存入:")
        print('  security add-generic-password -a ecnu_sso -s "ECNU SSO Login" -w <账号> -U')
        print('  security add-generic-password -a ecnu_sso_pwd -s "ECNU SSO Password" -w <密码> -U')
        sys.exit(1)

    return username, password


async def sso_login(page, username: str, password: str):
    """在 SSO 页面自动登录"""
    username_input = page.get_by_role('textbox', name='username')
    await username_input.wait_for(timeout=15000)
    await username_input.fill(username)

    password_input = page.get_by_role('textbox', name='password')
    await password_input.fill(password)

    login_btn = page.get_by_role('button', name='Sign In')
    await login_btn.click()
    await page.wait_for_timeout(5000)


async def auto_login_and_save(username: str, password: str, headless: bool = True):
    """自动登录并保存 session"""
    STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)

    async with async_playwright() as p:
        browser = await launch_chromium(p, headless=headless)
        context = await browser.new_context()
        page = await context.new_page()

        await page.goto(TREASURY_URL, wait_until='domcontentloaded')
        await page.wait_for_timeout(5000)

        await sso_login(page, username, password)
        await page.wait_for_timeout(3000)

        # 验证登录成功：只检查是否还停留在 SSO 页面
        if 'sso.ecnu.edu.cn' in page.url:
            debug_path = DEBUG_DIR / 'debug_login.png'
            await page.screenshot(path=str(debug_path), full_page=True)
            print(f"登录失败，当前URL: {page.url}")
            print(f"调试截图: {debug_path}")
            await browser.close()
            return False

        await context.storage_state(path=str(STORAGE_PATH))
        await browser.close()
        print("登录成功，session 已保存")
        return True


async def ensure_logged_in(page, headless: bool = True) -> bool:
    """打开财务系统首页，session 失效则用 Keychain 凭证重登并保存。返回是否仍停留在首页。"""
    await page.goto(TREASURY_URL, wait_until='domcontentloaded')
    await page.wait_for_timeout(5000)
    if 'sso.ecnu.edu.cn' not in page.url:
        return True
    print("需要登录 SSO...")
    username, password = get_credentials()
    await sso_login(page, username, password)
    await page.wait_for_timeout(3000)
    if 'sso.ecnu.edu.cn' in page.url:
        print("登录失败")
        return False
    STORAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
    await page.context.storage_state(path=str(STORAGE_PATH))
    print("登录成功，session 已更新")
    return True
