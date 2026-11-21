#!/usr/bin/env python3
"""Headless smoke test: loads docs/index.html, plays a few thousand random inputs (including
dialogs and the Floor 3 race/class screens) and fails if the page throws any JavaScript error.

Requires:  pip install playwright && playwright install chromium
Usage:     python3 tests/smoke_test.py [moves]
"""
import asyncio
import random
import sys
from pathlib import Path

from playwright.async_api import async_playwright

PAGE = (Path(__file__).resolve().parent.parent / 'docs' / 'index.html').as_uri()
KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'y', 'u', 'b', 'n', 't', 'c', 'f', 'q', '.', 'm', 'o', 'r']


async def main(moves: int) -> int:
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width': 1280, 'height': 900})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(PAGE)
        await page.wait_for_timeout(500)
        for _ in range(moves):
            if not await page.is_hidden('#modal'):
                option = await page.query_selector('.opt:not([disabled])')  # race/class selection cards
                if option:
                    await option.click()
                else:
                    await page.keyboard.press('Enter')
                continue
            await page.keyboard.press(random.choice(KEYS))
        await browser.close()
    if errors:
        print('FAILED:', *errors, sep='\n  ')
        return 1
    print(f'OK: {moves} random inputs, no JavaScript errors')
    return 0


if __name__ == '__main__':
    sys.exit(asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 2000)))
