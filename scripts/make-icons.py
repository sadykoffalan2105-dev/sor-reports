"""Иконки приложения (PWA и exe): зелёный квадрат со строками таблицы и микрофоном."""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
os.makedirs(OUT, exist_ok=True)

def icon(size: int, maskable: bool = False) -> Image.Image:
    s = size
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    pad = 0 if maskable else int(s * 0.06)
    d.rounded_rectangle([pad, pad, s - pad, s - pad], radius=int(s * (0 if maskable else 0.2)), fill=(29, 111, 66, 255))
    k = s / 512
    inset = 60 if maskable else 0
    def R(x0, y0, x1, y1, fill, r=10):
        d.rounded_rectangle([(x0 + inset * (256 - x0) / 256) * k, (y0 + inset * (256 - y0) / 256) * k, (x1 + inset * (256 - x1) / 256) * k, (y1 + inset * (256 - y1) / 256) * k], radius=int(r * k), fill=fill)
    white = (255, 255, 255, 255)
    R(110, 130, 300, 160, white)
    R(110, 200, 300, 230, white)
    R(110, 270, 240, 300, white)
    R(110, 340, 210, 370, white)
    # микрофон
    R(320, 170, 400, 320, (255, 214, 92, 255), 40)
    d.arc([(300 + inset * (256 - 300) / 256) * k, (230 + inset * (256 - 230) / 256) * k, (420 + inset * (256 - 420) / 256) * k, (350 + inset * (256 - 350) / 256) * k], 0, 180, fill=(255, 214, 92, 255), width=int(16 * k))
    R(352, 345, 368, 390, (255, 214, 92, 255), 4)
    R(320, 385, 400, 401, (255, 214, 92, 255), 6)
    return im

for size in (192, 512):
    icon(size).save(os.path.join(OUT, f'icon-{size}.png'))
icon(512, True).save(os.path.join(OUT, 'maskable-512.png'))
icon(256).save(os.path.join(OUT, 'app.ico'), sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print('icons ok')
