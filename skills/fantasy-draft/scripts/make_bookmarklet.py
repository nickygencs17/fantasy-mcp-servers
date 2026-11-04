"""Build the "Draft Bridge" bookmarklet from draftroom.js.

    python3 <skill>/scripts/make_bookmarklet.py   # writes bookmarklet.txt and bookmarklet.html

ESPN allows one draft-room connection per person, so the reader has to run in
the tab the user drafts in. The user drags the link from bookmarklet.html to
the bookmarks bar once, then clicks it in their draft tab each draft.
"""

import html
import re
import urllib.parse
from pathlib import Path

here = Path(__file__).resolve().parent
src = (here / "draftroom.js").read_text()
code = "\n".join(line for line in src.splitlines() if not line.strip().startswith("//"))
code = re.sub(r"\n\s*", "\n", code).strip()
# The script returns a status string; show it to the user as an alert-free toast
code = code.rstrip(";")
wrapped = (
    "(()=>{const r=" + code + ";"
    "const d=document.createElement('div');d.textContent='Draft Bridge: '+r;"
    "Object.assign(d.style,{position:'fixed',bottom:'12px',right:'12px',zIndex:99999,background:'#111',color:'#fff',"
    "padding:'8px 12px',borderRadius:'8px',font:'12px system-ui',maxWidth:'420px'});"
    "document.body.appendChild(d);setTimeout(()=>d.remove(),6000);})()"
)
bookmarklet = "javascript:" + urllib.parse.quote(wrapped, safe="()=>{}[];,.:'/*+-!?&|$_")
(here / "bookmarklet.txt").write_text(bookmarklet + "\n")
(here / "bookmarklet.html").write_text(f"""<!doctype html><meta charset="utf-8"><title>Draft Bridge</title>
<body style="font:16px system-ui;max-width:640px;margin:40px auto;padding:0 16px">
<h1>Draft Bridge bookmarklet</h1>
<p>Drag this link to your Chrome bookmarks bar:</p>
<p style="font-size:22px"><a href="{html.escape(bookmarklet, quote=True)}" style="padding:8px 14px;background:#0a7;color:#fff;border-radius:8px;text-decoration:none">Draft Bridge</a></p>
<ol>
<li>Before the draft, Claude starts <code>room_bridge.py</code> on your Mac.</li>
<li>In <b>your</b> ESPN draft-room tab, click <b>Draft Bridge</b> once. A note at the bottom right confirms it's sending.</li>
<li>If Chrome asks to let the page access devices on your local network, allow it.</li>
<li>Click it again any time to check status (it won't install twice). Reloading the draft tab means clicking it again.</li>
</ol>
</body>""")
print(f"bookmarklet: {len(bookmarklet)} chars -> {here / 'bookmarklet.txt'}, {here / 'bookmarklet.html'}")
