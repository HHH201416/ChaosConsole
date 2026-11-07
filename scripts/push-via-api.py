# -*- coding: utf-8 -*-
"""当 git push 通道被代理打成 502 时，把一个本地提交搬到远端。

流程：blobs -> tree（base_tree 取远端父树）-> commit -> 更新 refs/heads/main。

安全边界（三道闸，缺一不可）：
  1. 只允许「远端与本地父提交内容一致」的情况 —— 即远端 sha 可以和本地不同
     （API 建的提交作者/时间戳不同），但两边的 tree 必须完全一样，否则说明
     远端有本地没有的提交，拒绝执行，避免覆盖别人的工作。
  2. 只搬 `git diff --name-only 父..HEAD` 涉及的文件，不是整棵树。
  3. 提交前比对 API 建出的 tree sha 与本地 `HEAD^{tree}`，不一致就中止。

用法：python scripts/push-via-api.py
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

REPO = "HHH201416/ChaosConsole"
BRANCH = "main"
API = "https://api.github.com"

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True,
                      text=True, check=True).stdout.strip()


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True, cwd=ROOT).stdout.strip()


def call(method, path, payload=None):
    token = sh("gh", "auth", "token")
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode("utf-8")[:600])
        raise


head = sh("git", "rev-parse", "HEAD")
parent = sh("git", "rev-parse", "HEAD~1")
local_tree = sh("git", "rev-parse", "HEAD^{tree}")
parent_tree = sh("git", "rev-parse", "HEAD~1^{tree}")
msg = sh("git", "log", "-1", "--pretty=%B")

remote = call("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")["object"]["sha"]
remote_tree = call("GET", f"/repos/{REPO}/git/commits/{remote}")["tree"]["sha"]

print("local HEAD   ", head[:7], "tree", local_tree[:10])
print("local parent ", parent[:7], "tree", parent_tree[:10])
print("remote main  ", remote[:7], "tree", remote_tree[:10])

if remote == head:
    print("远端已经是这个提交，无需操作")
    sys.exit(0)

base = parent
if remote != parent:
    # sha 不同没关系（API 建的提交时间戳不同），但内容必须一致
    if remote_tree != parent_tree:
        print("远端内容与本地父提交不一致 —— 远端有本地没有的改动，拒绝覆盖")
        print("先让 git fetch 能通，把远端提交取下来再推")
        sys.exit(1)
    print("远端 sha 与本地父提交不同但树一致 → 以远端为父提交继续")

changed = [p for p in sh("git", "diff", "--name-only", parent, head).splitlines() if p]
if not changed:
    print("没有改动文件，退出")
    sys.exit(1)

entries = []
for path in changed:
    # 一律取 HEAD 里的内容，不是工作区 —— 工作区可能还有没提交的改动，
    # 传上去就会和本地提交的树对不上（校验会拦下来，但白跑一趟）
    exists = subprocess.run(["git", "cat-file", "-e", f"HEAD:{path}"],
                            capture_output=True, cwd=ROOT).returncode == 0
    if not exists:
        entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
        print("del ", path)
        continue
    content = subprocess.run(["git", "cat-file", "blob", f"HEAD:{path}"],
                             capture_output=True, check=True, cwd=ROOT).stdout
    blob = call("POST", f"/repos/{REPO}/git/blobs",
                {"content": base64.b64encode(content).decode("ascii"), "encoding": "base64"})
    entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    print("blob", path, blob["sha"][:10])

tree = call("POST", f"/repos/{REPO}/git/trees", {"base_tree": remote_tree, "tree": entries})
if tree["sha"] != local_tree:
    print(f"树不一致：api={tree['sha'][:10]} local={local_tree[:10]} —— 中止，不更新引用")
    sys.exit(1)
print("tree 校验通过", tree["sha"][:10])

commit = call("POST", f"/repos/{REPO}/git/commits",
              {"message": msg, "tree": tree["sha"], "parents": [remote]})
print("new commit", commit["sha"][:7])

ref = call("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}",
           {"sha": commit["sha"], "force": False})
print(f"{BRANCH} ->", ref["object"]["sha"][:7])
print("\n本地对齐（代理恢复后）：git fetch origin && git reset --hard origin/%s" % BRANCH)
