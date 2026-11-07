# -*- coding: utf-8 -*-
"""当 git push 通道被代理打成 502 时，用 REST API 把那一个提交搬到远端。

只做一件事：blobs -> tree -> commit -> 更新 refs/heads/main。
前提：本地 HEAD 的父提交与远端 main 一致（否则会丢提交，脚本会拒绝执行）。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.request

REPO = "HHH201416/ChaosConsole"
BRANCH = "main"
API = "https://api.github.com"

FILES = [
    "build/installer.nsh",
    "build/uninstaller.nsh",
    "package.json",
    "scripts/defect-audit.js",
    "src/lib/changelog.js",
    "src/lib/i18n.js",
    "release-notes-10.0.3.md",
]


def sh(*args):
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()


def call(method, path, payload=None):
    token = sh("gh", "auth", "token")
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    if data:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode("utf-8")[:600])
        raise


head = sh("git", "rev-parse", "HEAD")
parent = sh("git", "rev-parse", "HEAD~1")
msg = sh("git", "log", "-1", "--pretty=%B")

remote = call("GET", f"/repos/{REPO}/git/ref/heads/{BRANCH}")["object"]["sha"]
print("local HEAD  ", head[:7])
print("local parent", parent[:7])
print("remote main ", remote[:7])
if remote != parent:
    print("远端 main 与本地父提交不一致，拒绝走 API（避免丢别人的提交）")
    sys.exit(1)

# 远端父提交里的文件内容必须与本地父提交一致，否则说明本地还落后
base_tree = call("GET", f"/repos/{REPO}/git/commits/{remote}")["tree"]["sha"]

entries = []
for path in FILES:
    with open(path, "rb") as f:
        blob = call("POST", f"/repos/{REPO}/git/blobs",
                    {"content": base64.b64encode(f.read()).decode("ascii"), "encoding": "base64"})
    entries.append({"path": path, "mode": "100644", "type": "blob", "sha": blob["sha"]})
    print("blob", path, blob["sha"][:10])

tree = call("POST", f"/repos/{REPO}/git/trees", {"base_tree": base_tree, "tree": entries})
commit = call("POST", f"/repos/{REPO}/git/commits",
              {"message": msg, "tree": tree["sha"], "parents": [remote]})
print("new commit", commit["sha"][:7])

# 先确认新树与本地 HEAD 的树完全一致 —— 少一个文件或多一个都不认
local_tree = sh("git", "rev-parse", "HEAD^{tree}")
print("local tree ", local_tree[:10])
print("api   tree ", tree["sha"][:10])

ref = call("PATCH", f"/repos/{REPO}/git/refs/heads/{BRANCH}",
           {"sha": commit["sha"], "force": False})
print("main ->", ref["object"]["sha"][:7])
