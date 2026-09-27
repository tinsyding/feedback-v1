import glob, sys

out = []
for f in glob.glob(r'E:/JF/Code/NEW/feedback/feedback-v1/api/**/*.php', recursive=True):
    data = open(f, 'rb').read()
    enc = 'utf-8'
    try:
        data.decode('utf-8')
    except UnicodeDecodeError:
        try:
            data.decode('gbk')
            enc = 'gbk'
        except Exception:
            enc = 'unknown'
    out.append(f'{enc:8s} {len(data):8d}  {f}')

sys.stdout.buffer.write(('\n'.join(out) + '\n').encode('utf-8'))
