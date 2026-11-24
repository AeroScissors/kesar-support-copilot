"""Render media/motion.html to an MP4 and a GIF. Needs: pip install playwright, and ffmpeg on PATH.

  python media/render.py            full render
  python media/render.py 2.5 9 14   still frames at those seconds, for checking
"""
import base64
import pathlib
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
FPS = 30


def frame(page, t):
    url = page.evaluate("t => { render(t); return document.getElementById('c').toDataURL('image/png'); }", t)
    return base64.b64decode(url.split(",", 1)[1])


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto((HERE / "motion.html").as_uri() + "#still")
    page.evaluate("() => window.ready")
    assert page.evaluate("document.fonts.check('40px \"Rozha One\"')"), "fonts did not load, check the connection"
    if sys.argv[1:]:
        for t in sys.argv[1:]:
            (HERE / f"still_{t}.png").write_bytes(frame(page, float(t)))
    else:
        ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-i", "-",
                               "-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p",
                               "-movflags", "+faststart", str(HERE / "kesar-copilot.mp4")], stdin=subprocess.PIPE)
        for i in range(int(page.evaluate("DURATION") * FPS)):
            ff.stdin.write(frame(page, i / FPS))
        ff.stdin.close()
        assert ff.wait() == 0
        # GitHub autoplays GIFs in a README but not relative MP4s.
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(HERE / "kesar-copilot.mp4"), "-vf",
                        "fps=15,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=32:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle",
                        str(HERE / "kesar-copilot.gif")], check=True)
    browser.close()
