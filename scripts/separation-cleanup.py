#!/usr/bin/env python3
"""剥离清理（A 类）：把指向个人账号的 H2Z 仓库地址改到 GitHub 组织 H2ZTech。
幂等，可重复执行。默认只预览；加 --apply 才写入。
用法：python3 scripts/separation-cleanup.py <仓库路径> [--apply] [--allow-dirty 相对路径 ...]
规则：只做精确替换；不改 ghcr / 旧仓库 镜像地址（运行时契约，另行迁移）；
     不碰有未提交改动的文件（除非 --allow-dirty 指明）；写回前核对 mtime。
"""
import os, re, subprocess, sys

RULES = [
    (re.compile(r'github\.com/jimmyfreecoding/h2z\.ai\.server'), 'github.com/H2ZTech/h2z-ai-server'),
    (re.compile(r'github\.com/jimmyfreecoding/(h2z[._-][A-Za-z0-9._-]*[A-Za-z0-9])'), r'github.com/H2ZTech/\1'),
    (re.compile(r'(?<![\w./-])jimmyfreecoding/h2z\.ai\.server'), 'H2ZTech/h2z-ai-server'),
    (re.compile(r'(?<![\w./-])jimmyfreecoding/(h2z[._-][A-Za-z0-9._-]*[A-Za-z0-9])'), r'H2ZTech/\1'),
]
SKIP_DIRS = ('node_modules/', 'vendor/', '_to_delete/', 'frontend/html/', 'dist/', '.git/')
SKIP_SUFFIX = ('.lock', 'lock.json', '.min.js', '.map', '.svg', '.png', '.jpg', '.glb', '.h2zmap')

def git(repo, *a):
    return subprocess.run(['git', '-C', repo, *a], capture_output=True, timeout=120).stdout

def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__); sys.exit(2)
    repo = args[0]; apply = '--apply' in args
    allow = set()
    if '--allow-dirty' in args:
        allow = set(args[args.index('--allow-dirty') + 1:])
    dirty = set()
    for ent in git(repo, 'status', '--porcelain', '-z').decode('utf-8', 'replace').split('\0'):
        if len(ent) > 3: dirty.add(ent[3:])
    files = [f for f in git(repo, 'ls-files', '-z').decode('utf-8', 'replace').split('\0') if f]
    changed = skipped_dirty = hits = 0
    for rel in files:
        if rel.startswith(SKIP_DIRS) or any('/' + d in '/' + rel for d in SKIP_DIRS) or rel.endswith(SKIP_SUFFIX):
            continue
        p = os.path.join(repo, rel)
        try:
            st = os.stat(p)
            if st.st_size > 2_000_000: continue
            with open(p, 'r', encoding='utf-8', newline='') as fh: s = fh.read()
        except (OSError, UnicodeDecodeError):
            continue
        if 'jimmyfreecoding' not in s: continue
        new = s; n = 0
        for rx, rep in RULES:
            new, k = rx.subn(rep, new); n += k
        if n == 0: continue
        if rel in dirty and rel not in allow:
            skipped_dirty += 1; print(f'SKIP 有未提交改动  {rel} ({n})'); continue
        hits += n; changed += 1
        if apply:
            if os.stat(p).st_mtime_ns != st.st_mtime_ns:
                print(f'SKIP 读取后被改动  {rel}'); changed -= 1; hits -= n; continue
            with open(p, 'w', encoding='utf-8', newline='') as fh: fh.write(new)
    print(f'{"已写入" if apply else "预览"}: {repo}  文件 {changed}  替换 {hits}  因未提交改动跳过 {skipped_dirty}')

if __name__ == '__main__':
    main()
