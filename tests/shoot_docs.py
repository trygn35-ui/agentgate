"""为 README 拍摄界面截图（浅色与深色主题各一组）。"""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUTPUT_DIR = Path(__file__).resolve().parents[1] / "docs" / "images"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5241"

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    )
    page = browser.new_page(viewport={"width": 1180, "height": 720}, device_scale_factor=2)
    page.goto(URL, wait_until="networkidle")
    page.locator(".hero h1").wait_for()

    def shoot(name: str) -> None:
        page.wait_for_timeout(700)  # 等入场动画结束
        page.screenshot(path=str(OUTPUT_DIR / f"{name}.png"))
        print("shot", name)

    for theme, suffix in (("β FIELD", "-dark"), ("α FIELD", "")):
        page.get_by_role("button", name="CONFIG", exact=True).click()
        page.get_by_role("radio", name=theme, exact=True).click()
        page.wait_for_timeout(4600)  # 等「设置已保存」提示条自动消失

        page.get_by_role("button", name="OVERVIEW", exact=True).click()
        shoot(f"overview{suffix}")

        page.get_by_role("button", name="KEYS", exact=True).click()
        page.locator(".keyring-head").first.click()
        shoot(f"keyring{suffix}")
        page.keyboard.press("Escape")

        page.get_by_role("button", name="STREAM").click()
        shoot(f"activity{suffix}")

        page.get_by_role("button", name="CONFIG", exact=True).click()
        shoot(f"settings{suffix}")

    browser.close()
