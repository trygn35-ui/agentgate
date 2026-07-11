"""从应用 SVG 生成 Windows 打包所需的 PNG 和 ICO 图标。"""

from pathlib import Path

from PIL import Image
from playwright.sync_api import sync_playwright


root = Path(__file__).resolve().parents[1]
svg = (root / "public" / "keydeck.svg").read_text(encoding="utf-8")
html = f"""
<!doctype html>
<style>
  html, body {{ width: 512px; height: 512px; margin: 0; overflow: hidden; }}
  svg {{ display: block; width: 512px; height: 512px; }}
</style>
{svg}
"""

with sync_playwright() as playwright:
    browser = playwright.chromium.launch(
        headless=True,
        executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    )
    page = browser.new_page(
        viewport={"width": 512, "height": 512},
        device_scale_factor=1,
    )
    page.set_content(html)
    page.screenshot(path=str(root / "assets" / "icon.png"), omit_background=True)
    browser.close()

image = Image.open(root / "assets" / "icon.png").convert("RGBA")
image.save(
    root / "assets" / "icon.ico",
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
