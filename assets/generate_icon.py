"""
AxonDeck Icon Generator
來源：assets/logo.png（透明底 AD 標誌，1024×1024）
輸出：assets/ 與 build/ 的 icon.ico（16～256）＋ icon.png ＋ icon_<size>.png
"""
import os

from PIL import Image

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.join(SCRIPT_DIR, '..', 'build')
SIZES = [16, 32, 48, 64, 128, 256]


def main():
    logo = Image.open(os.path.join(SCRIPT_DIR, 'logo.png')).convert('RGBA')
    for out_dir in (SCRIPT_DIR, BUILD_DIR):
        frames = [logo.resize((size, size), Image.LANCZOS) for size in SIZES]
        for size, frame in zip(SIZES, frames):
            frame.save(os.path.join(out_dir, f'icon_{size}.png'), optimize=True)
        frames[-1].save(os.path.join(out_dir, 'icon.png'), optimize=True)
        frames[-1].save(os.path.join(out_dir, 'icon.ico'), sizes=[(s, s) for s in SIZES], append_images=frames[:-1])
    print('icons written')


if __name__ == '__main__':
    main()
