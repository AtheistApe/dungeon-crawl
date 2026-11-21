#!/usr/bin/env python3
"""Build the playable page.

Combines src/index.template.html + src/style.css + src/game.js into a single self-contained
docs/index.html (no dependencies, no bundler). GitHub Pages serves the docs/ folder directly.

Usage:  python3 build.py
"""
from pathlib import Path

root = Path(__file__).parent
src = root / 'src'
tpl = (src / 'index.template.html').read_text(encoding='utf-8')
css = (src / 'style.css').read_text(encoding='utf-8')
js = (src / 'game.js').read_text(encoding='utf-8')

# The game runs inside a block so its constants don't leak into the page's global scope.
page = tpl.replace('/*@@CSS@@*/', css).replace('/*@@JS@@*/', '{\n' + js + '\n}')

out = root / 'docs' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(page, encoding='utf-8')
print(f'Built {out.relative_to(root)} ({len(page):,} bytes)')
