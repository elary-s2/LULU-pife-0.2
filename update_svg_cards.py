import re
from pathlib import Path

base = Path('assets/cards')
files = list(base.glob('**/*.svg'))
if not files:
    raise SystemExit('Nenhum arquivo SVG encontrado')

font_re = re.compile(r'font-size:32px;')
mat_re = re.compile(r'transform="matrix\((-?[0-9]+\.?[0-9]*),0,0,(-?[0-9]+\.?[0-9]*),(-?[0-9]+\.?[0-9]*),(-?[0-9]+\.?[0-9]*)\)"')

changed = 0
processed = 0
for path in files:
    if 'assets/cards/back' in str(path).replace('\\', '/'):
        continue
    text = path.read_text(encoding='utf-8')
    original = text
    text = font_re.sub('font-size:36px;', text)
    if '</defs>' in text:
        head, tail = text.split('</defs>', 1)
        head = head + '</defs>'
    else:
        head = text
        tail = ''

    def repl(m):
        a = float(m.group(1))
        d = float(m.group(2))
        e = m.group(3)
        f = m.group(4)
        if abs(a) >= 1.2 and abs(a) <= 3.5 and abs(d) >= 1.2 and abs(d) <= 3.5:
            na = round(a * 0.78, 10)
            nd = round(d * 0.78, 10)
            def fmt(v):
                s = ('%.10f' % v).rstrip('0').rstrip('.')
                return s
            return f'transform="matrix({fmt(na)},0,0,{fmt(nd)},{e},{f})"'
        return m.group(0)

    tail_new = mat_re.sub(repl, tail)
    text = head + tail_new
    if text != original:
        path.write_text(text, encoding='utf-8')
        changed += 1
    processed += 1

print(f'Processed={processed} changed={changed}')
