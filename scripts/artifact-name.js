'use strict'

/**
 * 校验 package.json 里 build.win.artifactName。
 *
 * 为什么值得单独拦一道：这个名字写错**不会当场报错**，而是等用户点「检查更新」
 * 才以 404 的形式暴露 —— 那时包已经发到 GitHub Releases 上了，只能删了重发。
 * 所以把三条硬性约束（详见 README「关于安装包文件名」）变成一句构建期的报错，
 * 在 electron-builder 开跑之前就拦下来（那要跑三分多钟）。
 *
 * 返回问题清单；合法时是空数组。
 */
function artifactNameProblems(name) {
  const raw = typeof name === 'string' ? name : ''
  const problems = []

  if (!raw) {
    return ['没配 artifactName —— electron-builder 会用它自己的默认名，latest.yml 会对不上']
  }

  // ① 空格：唯一一条有确凿证据的坑。electron-updater 拼下载地址时会把空格换成
  //    连字符（GitHubProvider.resolveFiles 里的 p.replace(/ /g, '-')），而 GitHub
  //    上的资源名里是空格 —— 必然 404。
  if (raw.includes(' ')) {
    problems.push(
      '含空格 —— electron-updater 会把空格换成 "-"，请求的 URL 与 GitHub 上的资源名对不上，自动更新 404',
    )
  }

  // ② 非 ASCII：中文本身能过（URL 会百分号编码），但下载 URL、杀软扫描、
  //    别人的机器上解压都可能出意外，而这里没有任何收益。本项目约定纯 ASCII。
  if (/[^\x20-\x7e]/.test(raw)) {
    problems.push('含非 ASCII 字符 —— 本项目约定纯 ASCII（中文名解决不了任何问题，只会多一个变量）')
  }

  // ③ 版本号：release/ 里会同时留着多个版本的安装包，名字一样就互相覆盖，
  //    手动从 Releases 页下载的人也分不清哪个是哪个。
  if (!raw.includes('${version}')) {
    problems.push('没有 ${version} —— 多个版本的安装包会重名，回退时无法共存')
  }

  return problems
}

module.exports = { artifactNameProblems }
