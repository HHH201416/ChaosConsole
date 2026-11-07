# Pages 部署模板（未启用）

`pages.yml` 原本在 `.github/workflows/`，2026-11-07 移到这里，原因：

`gh` 的 OAuth token 只有 `gist / read:org / repo` 三个 scope，缺 `workflow`。
只要待推送的提交里出现 `.github/workflows/` 下的文件，GitHub 会整批拒绝：

```
refusing to allow an OAuth App to create or update workflow
`.github/workflows/pages.yml` without `workflow` scope
```

下载站当前走的是仓库自带的 legacy `pages-build-deployment`（分支部署），
本来就不需要这个工作流，所以移出后功能无损失。

## 什么时候需要拿回去

想让下载站改走 Actions 部署时：

1. 授权：`gh auth refresh -h github.com -s workflow`
2. 把本文件复制回 `.github/workflows/pages.yml`
3. 仓库 Settings → Pages → Source 改成 GitHub Actions
