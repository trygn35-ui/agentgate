"""在隔离浏览器预览中验证 Key Core 主要页面、返回交互与紧凑布局。"""

import json
import sys
from pathlib import Path

from playwright.sync_api import ConsoleMessage, sync_playwright


OUTPUT_DIR = Path(__file__).resolve().parents[1] / "output" / "playwright"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
console_errors: list[str] = []


def record_console_error(message: ConsoleMessage) -> None:
    if message.type == "error":
        console_errors.append(message.text)


def assert_layout(page, width: int, height: int, name: str) -> dict:
    page.set_viewport_size({"width": width, "height": height})
    page.wait_for_timeout(100)
    layout = page.evaluate(
        """
        () => {
          const shell = document.querySelector('.app-shell').getBoundingClientRect();
          const topbar = document.querySelector('.topbar').getBoundingClientRect();
          const footer = document.querySelector('.status-footer').getBoundingClientRect();
          return {
            body: [document.body.scrollWidth, document.body.scrollHeight],
            viewport: [innerWidth, innerHeight],
            shell: [shell.left, shell.right, shell.bottom],
            topbar: [topbar.left, topbar.right, topbar.bottom],
            footer: [footer.left, footer.right, footer.top, footer.bottom],
          };
        }
        """
    )
    assert layout["body"] == layout["viewport"]
    assert layout["shell"] == [0, width, height]
    assert layout["topbar"][1] == width
    assert layout["topbar"][2] == 56
    assert layout["footer"][1:] == [width, height - 28, height]
    page.screenshot(path=str(OUTPUT_DIR / f"{name}.png"), full_page=False)
    return layout


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    )
    page = browser.new_page(viewport={"width": 1280, "height": 800}, device_scale_factor=1)
    page.on("console", record_console_error)
    page.goto("http://127.0.0.1:5173", wait_until="networkidle")

    # 概览：hero 标题 + 四张客户端卡片
    page.locator(".hero h1").wait_for()
    assert page.locator(".socket-card").count() == 4

    # 密钥页：三个方案行，展开首行
    page.get_by_role("button", name="密钥", exact=True).click()
    page.get_by_role("heading", name="密钥", exact=True).wait_for()
    assert page.locator(".keyring-row").count() == 3
    page.locator(".keyring-head").first.click()
    page.locator(".keyring-expand.open").wait_for()
    page.keyboard.press("Escape")
    assert page.locator(".keyring-expand.open").count() == 0

    # 新建方案弹窗开合
    page.get_by_role("button", name="新建方案", exact=True).first.click()
    page.get_by_role("dialog", name="新建方案").wait_for()
    page.keyboard.press("Escape")
    page.get_by_role("heading", name="密钥", exact=True).wait_for()

    # 动态：实时请求与切换记录（活跃请求徽标会并入按钮可访问名，不能精确匹配）
    page.get_by_role("button", name="动态").click()
    page.get_by_role("heading", name="动态", exact=True).wait_for()
    assert page.locator(".request-row").count() == 3
    page.get_by_role("radio", name="切换记录", exact=True).click()
    assert page.locator(".event-row.with-undo").count() == 1

    # 设置
    page.get_by_role("button", name="设置", exact=True).click()
    page.get_by_role("heading", name="设置", exact=True).wait_for()
    assert page.get_by_text("Codex 工具兼容模式").is_visible()

    page.get_by_role("button", name="概览", exact=True).click()
    layouts = {
        "wide": assert_layout(page, 1280, 800, "overview-1280x800"),
        "compact": assert_layout(page, 1000, 620, "overview-1000x620"),
    }

    sys.stdout.write(json.dumps({"layouts": layouts, "console_errors": console_errors}, ensure_ascii=False) + "\n")
    assert not console_errors
    browser.close()
