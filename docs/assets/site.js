/*!
 * ChaosConsole static download site — behaviour.
 *
 * The page must remain useful without JavaScript and must not depend on any
 * external service at runtime. Version data is read from ./releases.json;
 * external links are only opened when the data provides a real asset URL.
 */
(function () {
  'use strict'

  var i18n = window.ChaosI18n
  var STORAGE_KEY = 'chaosconsole.site.lang'
  var REPO_GITHUB = 'HHH201416/ChaosConsole'
  var REPO_GITEE = 'chaosconsole/ChaosConsole'

  var state = {
    lang: i18n.detect(),
    data: null,
    error: null,
  }

  function $(id) {
    return document.getElementById(id)
  }

  function t(key, vars) {
    return i18n.translate(state.lang, key, vars)
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function setText(id, value) {
    var el = $(id)
    if (el) el.textContent = value
  }

  function isHttpUrl(value) {
    if (!value) return false
    try {
      var url = new URL(String(value))
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch (_) {
      return false
    }
  }

  function sourceUrl(release, source) {
    if (!release || !release.sources) return ''
    var url = release.sources[source]
    if (!isHttpUrl(url)) return ''
    // A duplicate would make the UI lie about having two independent routes.
    if (source === 'gitee' && url === release.sources.github) return ''
    return url
  }

  function hasAnySource(release) {
    return Boolean(sourceUrl(release, 'github') || sourceUrl(release, 'gitee'))
  }

  function isPending(release) {
    return !release || release.pending === true || !hasAnySource(release)
  }

  /* Semver comparison ------------------------------------------------------ */
  function parseSemver(value) {
    var raw = String(value == null ? '' : value).trim().replace(/^[vV]/, '')
    var match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
    if (match) {
      return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        pre: match[4] || '',
      }
    }
    var numbers = raw.match(/\d+(?:\.\d+)*/)
    var parts = numbers ? numbers[0].split('.').map(Number) : [0]
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0,
      pre: raw,
    }
  }

  function compareVersions(a, b) {
    var pa = parseSemver(a)
    var pb = parseSemver(b)
    if (pa.major !== pb.major) return pa.major - pb.major
    if (pa.minor !== pb.minor) return pa.minor - pb.minor
    if (pa.patch !== pb.patch) return pa.patch - pb.patch
    if (!pa.pre && pb.pre) return 1
    if (pa.pre && !pb.pre) return -1
    if (pa.pre === pb.pre) return 0

    var aa = pa.pre.split('.')
    var bb = pb.pre.split('.')
    for (var i = 0; i < Math.max(aa.length, bb.length); i++) {
      if (aa[i] === undefined) return -1
      if (bb[i] === undefined) return 1
      var na = /^\d+$/.test(aa[i])
      var nb = /^\d+$/.test(bb[i])
      if (na && nb) {
        var diff = Number(aa[i]) - Number(bb[i])
        if (diff) return diff
      } else if (na) {
        return -1
      } else if (nb) {
        return 1
      } else {
        if (aa[i] < bb[i]) return -1
        if (aa[i] > bb[i]) return 1
      }
    }
    return 0
  }

  function releaseCompleteness(release) {
    var score = 0
    if (sourceUrl(release, 'github')) score += 4
    if (sourceUrl(release, 'gitee')) score += 2
    if (release.sha512 && release.sha512 !== 'pending') score += 2
    if (release.sha256 && release.sha256 !== 'pending') score += 1
    if (release.size > 0) score += 1
    return score
  }

  function sortedReleases(data) {
    var byVersion = Object.create(null)
    var source = []
    if (Array.isArray(data.releases)) source = source.concat(data.releases)
    if (data.latest) source.push(data.latest)

    source.forEach(function (release) {
      if (!release || !release.version) return
      var key = String(release.version).toLowerCase()
      var current = byVersion[key]
      if (!current || releaseCompleteness(release) > releaseCompleteness(current)) {
        byVersion[key] = release
      }
    })

    return Object.keys(byVersion)
      .map(function (key) { return byVersion[key] })
      .sort(function (a, b) { return compareVersions(b.version, a.version) })
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return ''
    var mb = bytes / 1048576
    return mb >= 10 ? mb.toFixed(1) + ' MB' : mb.toFixed(2) + ' MB'
  }

  function formatDate(iso) {
    if (!iso) return ''
    var date = new Date(iso)
    if (isNaN(date.getTime())) return String(iso).slice(0, 10)
    try {
      return new Intl.DateTimeFormat(state.lang === 'en' ? 'en-US' : 'zh-CN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }).format(date)
    } catch (_) {
      return String(iso).slice(0, 10)
    }
  }

  /* Static translation ----------------------------------------------------- */
  function translateStatic() {
    var nodes = document.querySelectorAll('[data-i18n]')
    Array.prototype.forEach.call(nodes, function (el) {
      el.textContent = t(el.getAttribute('data-i18n'))
    })

    nodes = document.querySelectorAll('[data-i18n-html]')
    Array.prototype.forEach.call(nodes, function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n-html'))
    })

    nodes = document.querySelectorAll('[data-i18n-aria-label]')
    Array.prototype.forEach.call(nodes, function (el) {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')))
    })

    nodes = document.querySelectorAll('[data-i18n-title]')
    Array.prototype.forEach.call(nodes, function (el) {
      el.setAttribute('title', t(el.getAttribute('data-i18n-title')))
    })
  }

  function updateLangButtons() {
    var buttons = document.querySelectorAll('.lang-btn')
    Array.prototype.forEach.call(buttons, function (btn) {
      var active = btn.getAttribute('data-lang') === state.lang
      btn.setAttribute('aria-pressed', active ? 'true' : 'false')
    })
  }

  function updateNavLabel() {
    var toggle = $('navToggle')
    if (!toggle) return
    var open = toggle.getAttribute('aria-expanded') === 'true'
    toggle.setAttribute('aria-label', t(open ? 'nav.menuClose' : 'nav.menu'))
  }

  function updateInstallCommand() {
    var code = $('verifyCmd')
    if (!code) return
    var latest = state.data && state.data.latest
    var asset = latest && latest.assetName
      ? latest.assetName
      : 'ChaosConsole-Setup-<version>.exe'
    code.textContent = t('install.verify.cmd', { asset: asset })
  }

  function applyLanguage() {
    document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN'
    document.title = t('meta.title')

    var description = document.querySelector('meta[name="description"]')
    if (description) description.setAttribute('content', t('meta.description'))

    translateStatic()
    updateLangButtons()
    updateNavLabel()
    updateInstallCommand()

    if (state.data) {
      renderLatest()
      renderVersions()
    } else if (state.error) {
      renderError()
    }
  }

  function setLanguage(lang, persist) {
    if (lang !== 'zh' && lang !== 'en') return
    state.lang = lang
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, lang)
      } catch (_) {}
    }
    applyLanguage()
  }

  /* Source buttons --------------------------------------------------------- */
  function wireSourceLink(el, url, labelKey, unavailableKey, source, release) {
    if (!el) return
    el.setAttribute('data-source', source)

    if (url) {
      el.setAttribute('href', url)
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
      el.setAttribute('aria-label', t(labelKey, { version: release ? release.tag : '' }))
      el.removeAttribute('aria-disabled')
      el.removeAttribute('tabindex')
      el.removeAttribute('title')
      el.classList.remove('is-disabled')
    } else {
      el.removeAttribute('href')
      el.removeAttribute('target')
      el.removeAttribute('rel')
      el.setAttribute('aria-disabled', 'true')
      el.setAttribute('tabindex', '-1')
      el.setAttribute('aria-label', t(unavailableKey))
      el.setAttribute('title', t(unavailableKey))
      el.classList.add('is-disabled')
    }
  }

  function renderHash(id, rawValue, copyLabelKey) {
    var code = $(id)
    var button = document.querySelector('[data-copy-target="' + id + '"]')
    var value = rawValue == null ? '' : String(rawValue)
    var missing = !value || value === 'pending'
    var pending = Boolean(state.data && state.data.latest && state.data.latest.pending)

    if (code) {
      code.textContent = missing
        ? t(pending ? 'download.hashPending' : 'download.hashUnavailable')
        : value
      code.classList.toggle('is-pending', missing)
      code.setAttribute('dir', 'ltr')
    }

    if (button) {
      button.disabled = missing
      button.textContent = t('download.copy')
      button.classList.remove('done')
      button.setAttribute('aria-label', t(copyLabelKey))
    }
  }

  function renderLatest() {
    var data = state.data
    if (!data || !data.latest) return
    var latest = data.latest
    var pending = isPending(latest)
    var published = !pending && latest.publishedAt ? latest.publishedAt : ''

    setText('pillText', pending
      ? t('hero.pillPending', { version: latest.version })
      : t('hero.pill', { version: latest.version }))
    setText('heroVersion', latest.tag || ('v' + latest.version))
    setText('heroSize', pending ? t('hero.sizePending') : (latest.sizeText || formatSize(latest.size) || t('common.unknown')))
    setText('heroDate', published ? t('hero.published', { date: formatDate(published) }) : t('hero.notPublished'))
    setText('metaAutoUpdate', pending ? t('hero.metaPending') : t('hero.metaAutoUpdate'))

    wireSourceLink($('heroGithub'), sourceUrl(latest, 'github'), 'hero.primaryGithub', 'hero.githubUnavailable', 'github', latest)
    wireSourceLink($('heroGitee'), sourceUrl(latest, 'gitee'), 'hero.primaryGitee', 'hero.giteeUnavailable', 'gitee', latest)
    wireSourceLink($('downloadGithub'), sourceUrl(latest, 'github'), 'download.githubBtn', 'download.githubUnavailable', 'github', latest)
    wireSourceLink($('downloadGitee'), sourceUrl(latest, 'gitee'), 'download.giteeBtn', 'download.giteeUnavailable', 'gitee', latest)

    var pendingBox = $('latestPending')
    if (pendingBox) {
      pendingBox.hidden = !pending
      if (pending) {
        var all = sortedReleases(data)
        var previous = null
        for (var i = 0; i < all.length; i++) {
          if (all[i].version !== latest.version && !isPending(all[i])) {
            previous = all[i]
            break
          }
        }
        setText('pendingTitle', t('download.pendingTitle', { version: latest.version }))
        var note = t('download.pendingDesc', { version: latest.version })
        if (previous) note += ' ' + t('hero.previousStable', { version: previous.tag || ('v' + previous.version) })
        setText('pendingText', note)
        setText('pendingVersionsLink', t('hero.viewVersions'))
      }
    }

    var errorBox = $('dataError')
    if (errorBox) errorBox.hidden = true

    renderHash('sha512', latest.sha512, 'download.copySha512')
    renderHash('sha256', latest.sha256, 'download.copySha256')

    var list = sortedReleases(data)
    var publishedCount = list.filter(function (release) { return !isPending(release) }).length
    var stat = $('statVersions')
    if (stat) {
      stat.setAttribute('data-count', String(publishedCount))
      if (stat.dataset.done === '1') stat.textContent = String(publishedCount)
    }
  }

  function renderVersions() {
    var tbody = $('versionRows')
    var table = $('versionsTable')
    if (!tbody) return
    if (table) table.setAttribute('aria-busy', 'false')

    if (!state.data) {
      var message = state.error ? t('versions.loadError') : t('common.loading')
      tbody.innerHTML = '<tr class="loading-row"><td colspan="4">' + esc(message) + '</td></tr>'
      return
    }

    var releases = sortedReleases(state.data)
    var latestVersion = state.data.latest ? String(state.data.latest.version) : ''

    if (!releases.length) {
      tbody.innerHTML = '<tr class="loading-row"><td colspan="4">' + esc(t('versions.noData')) + '</td></tr>'
      return
    }

    var html = releases.map(function (release) {
      var pending = isPending(release)
      var isLatest = String(release.version) === latestVersion
      var github = sourceUrl(release, 'github')
      var gitee = sourceUrl(release, 'gitee')
      var tag = release.tag || ('v' + release.version)
      var name = String(release.name || '').trim()
      var showName = name && name !== tag && name !== ('v' + release.version)
      var date = pending || !release.publishedAt
        ? t('versions.pendingDate')
        : formatDate(release.publishedAt)
      var size = pending
        ? t('versions.pendingSize')
        : (release.sizeText || formatSize(release.size) || t('common.unknown'))

      var sourceHtml = ''
      if (github) {
        sourceHtml += '<a class="src-btn src-github" href="' + esc(github) + '" target="_blank" rel="noopener noreferrer" data-source="github" aria-label="' +
          esc(t('versions.sourceGithubTitle', { version: tag })) + '">' + esc(t('versions.github')) + '</a>'
      } else {
        sourceHtml += '<button class="src-btn" type="button" disabled title="' + esc(t('versions.githubUnavailable')) +
          '" aria-label="' + esc(t('versions.githubUnavailable')) + '">' + esc(t('versions.github')) + '</button>'
      }
      if (gitee) {
        sourceHtml += '<a class="src-btn src-gitee" href="' + esc(gitee) + '" target="_blank" rel="noopener noreferrer" data-source="gitee" aria-label="' +
          esc(t('versions.sourceGiteeTitle', { version: tag })) + '">' + esc(t('versions.gitee')) + '</a>'
      } else {
        sourceHtml += '<button class="src-btn" type="button" disabled title="' + esc(t('versions.giteeUnavailable')) +
          '" aria-label="' + esc(t('versions.giteeUnavailable')) + '">' + esc(t('versions.gitee')) + '</button>'
      }

      var badge = ''
      if (isLatest) {
        badge = ' <span class="badge">' + esc(pending ? t('versions.pending') : t('versions.latest')) + '</span>'
      }

      return '<tr' + (pending ? ' class="is-pending"' : '') + '>' +
        '<th scope="row" data-label="' + esc(t('versions.thVersion')) + '">' +
          '<span class="ver-tag">' + esc(tag) + '</span>' + badge +
          (showName ? '<span class="ver-name">' + esc(name) + '</span>' : '') +
        '</th>' +
        '<td data-label="' + esc(t('versions.thDate')) + '">' + esc(date) + '</td>' +
        '<td data-label="' + esc(t('versions.thSize')) + '">' + esc(size) + '</td>' +
        '<td data-label="' + esc(t('versions.thSources')) + '"><div class="src-actions">' + sourceHtml + '</div></td>' +
        '</tr>'
    }).join('')

    tbody.innerHTML = html
  }

  function renderError() {
    setText('pillText', t('hero.loadError'))
    setText('heroVersion', '—')
    setText('heroSize', '—')
    setText('heroDate', '—')

    wireSourceLink($('heroGithub'), '', 'hero.primaryGithub', 'hero.githubUnavailable', 'github', null)
    wireSourceLink($('heroGitee'), '', 'hero.primaryGitee', 'hero.giteeUnavailable', 'gitee', null)
    wireSourceLink($('downloadGithub'), '', 'download.githubBtn', 'download.githubUnavailable', 'github', null)
    wireSourceLink($('downloadGitee'), '', 'download.giteeBtn', 'download.giteeUnavailable', 'gitee', null)

    var pendingBox = $('latestPending')
    if (pendingBox) pendingBox.hidden = true

    var errorBox = $('dataError')
    if (errorBox) errorBox.hidden = false

    renderHash('sha512', '', 'download.copySha512')
    renderHash('sha256', '', 'download.copySha256')

    var stat = $('statVersions')
    if (stat) {
      stat.removeAttribute('data-count')
      stat.dataset.done = '1'
      stat.textContent = '—'
    }

    renderVersions()
  }

  /* Data loading ----------------------------------------------------------- */
  function loadData() {
    var table = $('versionsTable')
    if (table) table.setAttribute('aria-busy', 'true')

    fetch('./releases.json', { cache: 'no-cache' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (data) {
        if (!data || data.schemaVersion !== 2 || !data.latest || !data.latest.version) {
          throw new Error('Unsupported releases.json schema')
        }
        state.data = data
        state.error = null
        applyLanguage()
      })
      .catch(function (error) {
        state.data = null
        state.error = error
        applyLanguage()
        renderError()
      })
  }

  /* Navigation ------------------------------------------------------------- */
  function initNav() {
    var toggle = $('navToggle')
    var menu = $('navMenu')
    var header = document.querySelector('.site-header')
    if (!toggle || !menu) return

    function setMenu(open, focusFirst) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
      menu.classList.toggle('is-open', open)
      updateNavLabel()
      if (open && focusFirst) {
        var first = menu.querySelector('a, button')
        if (first) first.focus()
      }
    }

    toggle.addEventListener('click', function () {
      setMenu(toggle.getAttribute('aria-expanded') !== 'true', true)
    })

    menu.addEventListener('click', function (event) {
      var link = event.target.closest ? event.target.closest('a') : null
      if (link) setMenu(false, false)
    })

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setMenu(false, false)
        toggle.focus()
      }
    })

    document.addEventListener('click', function (event) {
      if (toggle.getAttribute('aria-expanded') !== 'true') return
      if (header && header.contains(event.target)) return
      setMenu(false, false)
    })

    var wide = window.matchMedia('(min-width: 901px)')
    function onViewportChange() {
      if (wide.matches) setMenu(false, false)
    }
    if (wide.addEventListener) wide.addEventListener('change', onViewportChange)
    else if (wide.addListener) wide.addListener(onViewportChange)

    updateNavLabel()
  }

  /* Copy + toast ----------------------------------------------------------- */
  var toastTimer = null

  function say(text) {
    var toast = $('toast')
    if (!toast) return
    toast.textContent = text
    toast.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      toast.classList.remove('show')
    }, 2600)
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () {
        return true
      }, function () {
        return false
      })
    }
    try {
      var area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.className = 'sr-only'
      document.body.appendChild(area)
      area.select()
      var ok = document.execCommand('copy')
      document.body.removeChild(area)
      return Promise.resolve(ok)
    } catch (_) {
      return Promise.resolve(false)
    }
  }

  function initCopy() {
    document.addEventListener('click', function (event) {
      var button = event.target.closest ? event.target.closest('button[data-copy-target]') : null
      if (!button || button.disabled) return

      var code = document.getElementById(button.getAttribute('data-copy-target'))
      if (!code || code.classList.contains('is-pending')) {
        say(t('toast.copyFailed'))
        return
      }

      var value = code.textContent || ''
      copyText(value).then(function (ok) {
        if (!ok) {
          say(t('toast.copyFailed'))
          return
        }
        button.textContent = t('download.copied')
        button.classList.add('done')
        say(t('toast.copied'))
        setTimeout(function () {
          button.textContent = t('download.copy')
          button.classList.remove('done')
        }, 2000)
      })
    })
  }

  function initDownloadFeedback() {
    document.addEventListener('click', function (event) {
      var link = event.target.closest ? event.target.closest('a[data-source]') : null
      if (!link) return
      if (link.getAttribute('aria-disabled') === 'true' || !link.getAttribute('href')) {
        event.preventDefault()
        return
      }
      var source = link.getAttribute('data-source')
      say(t(source === 'gitee' ? 'download.startedGitee' : 'download.startedGithub'))
    })
  }

  function initLanguageButtons() {
    var buttons = document.querySelectorAll('.lang-btn')
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        setLanguage(button.getAttribute('data-lang'), true)
      })
    })
  }

  /* Visual effects --------------------------------------------------------- */
  function initScrollHeader() {
    var header = document.querySelector('.site-header')
    if (!header) return
    function update() {
      header.classList.toggle('is-stuck', window.scrollY > 8)
    }
    window.addEventListener('scroll', update, { passive: true })
    update()
  }

  function initSpotlight() {
    var spot = document.querySelector('.spot')
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!spot || reduce || !window.matchMedia('(pointer: fine)').matches) return

    var ticking = false
    var px = window.innerWidth / 2
    var py = window.innerHeight * 0.18
    window.addEventListener('mousemove', function (event) {
      px = event.clientX
      py = event.clientY
      if (ticking) return
      ticking = true
      requestAnimationFrame(function () {
        spot.style.setProperty('--mx', (px / window.innerWidth * 100).toFixed(2) + '%')
        spot.style.setProperty('--my', (py / window.innerHeight * 100).toFixed(2) + '%')
        ticking = false
      })
    }, { passive: true })
  }

  function initReveal() {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce || !('IntersectionObserver' in window)) return

    var items = document.querySelectorAll('.reveal')
    if (!items.length) return
    document.documentElement.classList.add('js-motion')
    Array.prototype.forEach.call(items, function (el) { el.classList.add('pre') })

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return
        entry.target.classList.remove('pre')
        entry.target.classList.add('in')
        observer.unobserve(entry.target)
      })
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })

    Array.prototype.forEach.call(items, function (el) { observer.observe(el) })

    // Safety net: never leave content hidden if the observer misbehaves.
    setTimeout(function () {
      Array.prototype.forEach.call(items, function (el) {
        el.classList.remove('pre')
        el.classList.add('in')
      })
    }, 4000)
  }

  function animateCount(el) {
    if (el.dataset.done === '1') return
    var target = parseInt(el.getAttribute('data-count'), 10)
    if (!isFinite(target)) {
      el.dataset.done = '1'
      return
    }
    el.dataset.done = '1'
    var started = null
    var duration = 900
    function frame(now) {
      if (started === null) started = now
      var progress = Math.min((now - started) / duration, 1)
      var eased = 1 - Math.pow(1 - progress, 3)
      el.textContent = String(Math.round(target * eased))
      if (progress < 1) requestAnimationFrame(frame)
      else el.textContent = String(target)
    }
    el.textContent = '0'
    requestAnimationFrame(frame)
  }

  function initCounts() {
    var items = document.querySelectorAll('[data-count]')
    if (!items.length) return
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduce || !('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (el) {
        if (!el.hasAttribute('data-count')) return
        el.dataset.done = '1'
        el.textContent = el.getAttribute('data-count')
      })
      return
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return
        animateCount(entry.target)
        observer.unobserve(entry.target)
      })
    }, { threshold: 0.5 })

    Array.prototype.forEach.call(items, function (el) { observer.observe(el) })
  }

  function initOSWarning() {
    var warning = $('osWarn')
    if (!warning) return
    var ua = navigator.userAgent || ''
    if (!/Windows/i.test(ua)) warning.hidden = false
  }

  function init() {
    applyLanguage()
    initLanguageButtons()
    initNav()
    initOSWarning()
    initCopy()
    initDownloadFeedback()
    initScrollHeader()
    initSpotlight()
    initReveal()
    initCounts()
    loadData()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
