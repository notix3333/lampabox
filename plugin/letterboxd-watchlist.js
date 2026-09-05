(function (global) {
  'use strict'

  const PLUGIN_NAME = 'Letterboxd Watchlist'
  const PLUGIN_VERSION = '1.2.0'
  const STORAGE_USERNAME = 'letterboxd_watchlist_username'
  const STORAGE_LISTS = 'letterboxd_public_lists'
  const STORAGE_API_URL = 'letterboxd_watchlist_api_url'
  const API_BASE_URL = 'https://lampa-letterboxd-watchlist.rexikplay3.workers.dev'
  const MAX_TMDB_CONCURRENCY = 5
  const REQUEST_RETRY_DELAYS = [250, 500]
  const TMDB_RETRY_DELAYS = [200, 400]
  const TMDB_TIMEOUT_MS = 15000
  const CATALOG_COMPONENT = 'letterboxd_catalog'
  const FILTERS = [
    { value: 'all', title: 'Все' },
    { value: 'watched', title: 'Просмотрено' },
    { value: 'unwatched', title: 'Не просмотрено' },
    { value: 'letterboxd', title: 'Просмотрено в Letterboxd' },
    { value: 'lampa', title: 'Просмотрено в Lampa' },
  ]

  const sourceStates = Object.create(null)
  const watchedSlugs = Object.create(null)
  let errorShown = false
  let watchedPromise = null

  function log() {
    const args = Array.prototype.slice.call(arguments)
    args.unshift(`[${PLUGIN_NAME}]`)
    console.log.apply(console, args)
  }

  function normalizeTitle(title) {
    return String(title || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
  }

  function releaseYear(item) {
    const value = item && (item.release_date || item.first_air_date)
    const match = typeof value === 'string' ? value.match(/^(\d{4})/) : null
    return match ? Number(match[1]) : null
  }

  function localizedTitle(item) {
    return item && (item.title || item.name)
  }

  function originalTitle(item) {
    return item && (item.original_title || item.original_name)
  }

  function isWatchedInLampa(movie, lampa) {
    if (!movie || !lampa) return false

    try {
      const favorite = lampa.Favorite && lampa.Favorite.check
        ? lampa.Favorite.check(movie)
        : null
      if (favorite && favorite.viewed) return true

      if (!lampa.Timeline || !lampa.Timeline.watched) return false
      const timeline = lampa.Timeline.watched(movie, true)

      if (Array.isArray(timeline)) return timeline.length > 0
      return Boolean(timeline && Number(timeline.percent) >= 90)
    } catch (error) {
      log('Lampa watched status failed:', error && error.message ? error.message : error)
      return false
    }
  }

  function updateWatchedFlags(movie) {
    if (!movie) return movie

    movie.letterboxd_watched = Boolean(
      movie.letterboxd_slug && watchedSlugs[movie.letterboxd_slug],
    )
    movie.lampa_watched = isWatchedInLampa(movie, global.Lampa)
    movie.letterboxd_any_watched = movie.letterboxd_watched || movie.lampa_watched
    return movie
  }

  function filterCatalogMovies(items, filter) {
    const movies = Array.isArray(items) ? items : []

    return movies.filter(function (movie) {
      if (filter === 'watched') return Boolean(movie.letterboxd_watched || movie.lampa_watched)
      if (filter === 'unwatched') return !movie.letterboxd_watched && !movie.lampa_watched
      if (filter === 'letterboxd') return Boolean(movie.letterboxd_watched)
      if (filter === 'lampa') return Boolean(movie.lampa_watched)
      return true
    })
  }

  function pickBestTmdbResult(film, movieResults, tvResults) {
    if (!film || !film.year) return null

    const movies = Array.isArray(movieResults) ? movieResults : []
    const shows = Array.isArray(tvResults) ? tvResults : []
    const wantedTitle = normalizeTitle(film.title)
    const candidates = movies
      .map(function (item) {
        return { item: item, mediaType: 'movie' }
      })
      .concat(
        shows.map(function (item) {
          return { item: item, mediaType: 'tv' }
        }),
      )
      .filter(function (candidate) {
        return candidate.item && candidate.item.id && releaseYear(candidate.item) !== null
      })

    const rules = [
      function (candidate) {
        return (
          normalizeTitle(localizedTitle(candidate.item)) === wantedTitle &&
          releaseYear(candidate.item) === film.year
        )
      },
      function (candidate) {
        return (
          normalizeTitle(originalTitle(candidate.item)) === wantedTitle &&
          releaseYear(candidate.item) === film.year
        )
      },
      function (candidate) {
        return (
          normalizeTitle(localizedTitle(candidate.item)) === wantedTitle &&
          Math.abs(releaseYear(candidate.item) - film.year) <= 1
        )
      },
      function (candidate) {
        return (
          normalizeTitle(originalTitle(candidate.item)) === wantedTitle &&
          Math.abs(releaseYear(candidate.item) - film.year) <= 1
        )
      },
    ]

    for (let index = 0; index < rules.length; index += 1) {
      const match = candidates.find(rules[index])
      if (match) {
        return Object.assign({}, match.item, {
          media_type: match.mediaType,
          source: 'tmdb',
        })
      }
    }

    return null
  }

  function mapWithConcurrency(items, limit, mapper, onSettled) {
    const results = new Array(items.length)
    let nextIndex = 0

    function worker() {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return Promise.resolve()

      return Promise.resolve(mapper(items[index], index))
        .then(function (value) {
          results[index] = value
        })
        .catch(function (error) {
          log('TMDB lookup failed:', error && error.message ? error.message : error)
          results[index] = null
        })
        .then(function () {
          if (onSettled) onSettled(results[index], index)
        })
        .then(worker)
    }

    const workers = []
    const workerCount = Math.min(Math.max(1, limit), items.length)
    for (let index = 0; index < workerCount; index += 1) workers.push(worker())

    return Promise.all(workers).then(function () {
      return results
    })
  }

  function createTaskLimiter(limit) {
    let active = 0
    const waiting = []

    function startNext() {
      if (active >= limit || !waiting.length) return

      const entry = waiting.shift()
      active += 1
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .then(
          function () {
            active -= 1
            startNext()
          },
          function () {
            active -= 1
            startNext()
          },
        )
    }

    return function (task) {
      return new Promise(function (resolve, reject) {
        waiting.push({ task: task, resolve: resolve, reject: reject })
        startNext()
      })
    }
  }

  function retryWithBackoff(operation, delays, sleeper, shouldRetry) {
    let attempt = 0
    const wait = sleeper || function (delay) {
      return new Promise(function (resolve) {
        setTimeout(resolve, delay)
      })
    }

    function run() {
      return Promise.resolve()
        .then(function () {
          return operation(attempt)
        })
        .catch(function (error) {
          if (attempt >= delays.length || (shouldRetry && !shouldRetry(error))) throw error
          const delay = delays[attempt]
          attempt += 1
          return wait(delay).then(run)
        })
    }

    return run()
  }

  function parseListEntries(value, defaultUsername) {
    const usernamePattern = /^[a-z0-9][a-z0-9_-]{0,39}$/i
    const slugPattern = /^[a-z0-9][a-z0-9-]{0,119}$/i
    const seen = Object.create(null)
    const result = []

    String(value || '')
      .split(/[\n,;]+/)
      .map(function (entry) {
        return entry.trim()
      })
      .filter(Boolean)
      .forEach(function (entry) {
        let username = ''
        let slug = ''
        const urlMatch = entry.match(
          /^https?:\/\/(?:www\.)?letterboxd\.com\/([^/]+)\/list\/([^/?#]+)\/?(?:[?#].*)?$/i,
        )

        if (urlMatch) {
          username = urlMatch[1]
          slug = urlMatch[2]
        } else {
          const path = entry.replace(/^\/+|\/+$/g, '')
          const longPath = path.match(/^([^/]+)\/list\/([^/]+)$/i)
          const shortPath = path.match(/^([^/]+)\/([^/]+)$/)

          if (longPath) {
            username = longPath[1]
            slug = longPath[2]
          } else if (shortPath) {
            username = shortPath[1]
            slug = shortPath[2]
          } else {
            username = defaultUsername
            slug = path
          }
        }

        if (!usernamePattern.test(username) || !slugPattern.test(slug)) return

        const key = `${username.toLowerCase()}/${slug.toLowerCase()}`
        if (seen[key]) return
        seen[key] = true
        result.push({ username: username, slug: slug, key: key })
      })

    return result
  }

  const runTmdbTask = createTaskLimiter(MAX_TMDB_CONCURRENCY)

  function searchTmdbOnce(film) {
    return new Promise(function (resolve, reject) {
      let settled = false
      const timeout = setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error('TMDB search timed out'))
      }, TMDB_TIMEOUT_MS)

      try {
        global.Lampa.Api.search({ query: film.title }, function (result) {
          if (settled) return
          settled = true
          clearTimeout(timeout)

          const hasMovieSection = Boolean(result && result.movie)
          const hasTvSection = Boolean(result && result.tv)
          if (!hasMovieSection && !hasTvSection) {
            reject(new Error('TMDB search returned no sections'))
            return
          }

          const movies = hasMovieSection && Array.isArray(result.movie.results)
            ? result.movie.results
            : []
          const shows = hasTvSection && Array.isArray(result.tv.results) ? result.tv.results : []
          const match = pickBestTmdbResult(film, movies, shows)
          if (match) match.letterboxd_slug = film.slug
          resolve(match)
        })
      } catch (error) {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    })
  }

  function searchTmdb(film) {
    return retryWithBackoff(function () {
      return searchTmdbOnce(film)
    }, TMDB_RETRY_DELAYS)
  }

  function workerError(error) {
    const payload = error && error.responseJSON && error.responseJSON.error
    return payload && payload.code ? payload : null
  }

  function shouldRetryWorkerRequest(error) {
    const details = workerError(error)
    if (!details) return true

    return details.code === 'LETTERBOXD_BLOCKED' || details.code === 'LETTERBOXD_ERROR'
  }

  function configuredApiBaseUrl() {
    return String(global.Lampa.Storage.get(STORAGE_API_URL, API_BASE_URL) || '')
      .trim()
      .replace(/\/+$/, '')
  }

  function requestCollection(config, apiBaseUrl) {
    return retryWithBackoff(
      function () {
        return new Promise(function (resolve, reject) {
          const network = new global.Lampa.Reguest()
          const path =
            config.kind === 'watchlist'
              ? `/watchlist/${encodeURIComponent(config.username)}`
              : config.kind === 'watched'
                ? `/watched/${encodeURIComponent(config.username)}?page=${config.page || 1}`
                : `/list/${encodeURIComponent(config.username)}/${encodeURIComponent(config.slug)}`

          network.timeout(30000)
          network.native(apiBaseUrl + path, resolve, reject)
        })
      },
      REQUEST_RETRY_DELAYS,
      null,
      shouldRetryWorkerRequest,
    )
  }

  function notificationFor(error) {
    const details = workerError(error)

    if (details && details.code === 'USER_NOT_FOUND') return 'Letterboxd: пользователь не найден'
    if (details && details.code === 'INVALID_USERNAME') return 'Letterboxd: некорректный username'
    if (details && details.code === 'INVALID_LIST') return 'Letterboxd: некорректный адрес списка'
    if (details && details.code === 'LETTERBOXD_BLOCKED') return 'Letterboxd временно блокирует запросы'
    if (details && details.code === 'LIST_UNAVAILABLE') {
      return 'Letterboxd list не найден или закрыт'
    }
    if (details && details.code === 'WATCHED_UNAVAILABLE') {
      return 'Список просмотренного Letterboxd закрыт; статусы Lampa продолжат работать'
    }
    if (details && details.code === 'WATCHLIST_UNAVAILABLE') {
      return 'Не удалось получить Letterboxd Watchlist. Проверьте username и доступность watchlist.'
    }

    return 'Letterboxd временно недоступен'
  }

  function notifyOnce(message) {
    if (errorShown) return
    errorShown = true
    global.Lampa.Noty.show(message)
  }

  function ensureWatched(username, apiBaseUrl) {
    if (watchedPromise) return watchedPromise
    if (!username) return Promise.resolve(watchedSlugs)

    function loadPage(page) {
      return requestCollection(
        { kind: 'watched', username: username, page: page },
        apiBaseUrl,
      ).then(function (payload) {
        if (!payload || payload.version !== 1 || !Array.isArray(payload.films)) {
          throw new Error('Worker returned an invalid watched response')
        }

        payload.films.forEach(function (film) {
          if (film && film.slug) watchedSlugs[film.slug] = true
        })

        const nextPage = Number(payload.nextPage)
        if (Number.isInteger(nextPage) && nextPage > page && nextPage <= 100) {
          return loadPage(nextPage)
        }
        return watchedSlugs
      })
    }

    watchedPromise = loadPage(1)
      .then(function (slugs) {
        Object.keys(sourceStates).forEach(function (key) {
          const state = sourceStates[key]
          state.results.forEach(updateWatchedFlags)
          decorateStateCards(state)
        })
        log(`Letterboxd watched received: ${Object.keys(slugs).length}`)
        return slugs
      })
      .catch(function (error) {
        log('Letterboxd watched error:', error)
        notifyOnce(notificationFor(error))
        return watchedSlugs
      })

    return watchedPromise
  }

  function decorateCard(card) {
    if (!card || !card.data || typeof card.render !== 'function') return
    updateWatchedFlags(card.data)

    const html = card.render(true)
    const view = html && html.querySelector ? html.querySelector('.card__view') : null
    if (!view) return

    const previous = view.querySelector('.letterboxd-card-badges')
    if (previous) previous.remove()
    if (!card.data.letterboxd_watched && !card.data.lampa_watched) return

    const badges = document.createElement('div')
    badges.className = 'letterboxd-card-badges'

    if (card.data.letterboxd_watched) {
      const badge = document.createElement('div')
      badge.className = 'letterboxd-card-badge letterboxd-card-badge--letterboxd'
      badge.textContent = 'Letterboxd ✓'
      badges.appendChild(badge)
    }

    if (card.data.lampa_watched) {
      const badge = document.createElement('div')
      badge.className = 'letterboxd-card-badge letterboxd-card-badge--lampa'
      badge.textContent = 'Lampa ✓'
      badges.appendChild(badge)
    }

    view.appendChild(badges)
  }

  function decorateStateCards(state) {
    state.lines.forEach(function (entry) {
      const items = entry.line && Array.isArray(entry.line.items) ? entry.line.items : []
      items.forEach(decorateCard)
    })
  }

  function createSourceState(config) {
    let resolveReady
    let resolveDone
    const state = {
      config: config,
      title: config.title,
      results: [],
      matches: [],
      settled: [],
      nextFlushIndex: 0,
      total: 0,
      completed: false,
      started: false,
      readyResolved: false,
      doneResolved: false,
      lines: [],
      ready: new Promise(function (resolve) {
        resolveReady = resolve
      }),
      resolveReady: function () {
        if (state.readyResolved) return
        state.readyResolved = true
        resolveReady(state.results)
      },
      done: new Promise(function (resolve) {
        resolveDone = resolve
      }),
      resolveDone: function () {
        if (state.doneResolved) return
        state.doneResolved = true
        resolveDone(state.results)
      },
    }

    sourceStates[config.key] = state
    return state
  }

  function appendPendingCards(state) {
    state.lines.forEach(function (entry) {
      const line = entry.line
      if (!line || typeof line.emit !== 'function') return

      const visibleResults = filterCatalogMovies(state.results, entry.filter)
      const items = Array.isArray(line.items) ? line.items : []
      for (let index = items.length; index < visibleResults.length; index += 1) {
        line.emit('createAndAppend', visibleResults[index])
      }
    })
  }

  function flushSettled(state) {
    while (state.settled[state.nextFlushIndex]) {
      const match = state.matches[state.nextFlushIndex]
      state.nextFlushIndex += 1

      if (match) {
        state.results.push(updateWatchedFlags(match))
        appendPendingCards(state)
      }
    }

    if (state.results.length) state.resolveReady()

    if (state.nextFlushIndex >= state.total) {
      state.completed = true
      state.resolveReady()
      state.resolveDone()
      log(`${state.title}: TMDB matched ${state.results.length}/${state.total}`)
    }
  }

  function loadSource(state, apiBaseUrl) {
    if (state.started) return state.ready
    state.started = true

    requestCollection(state.config, apiBaseUrl)
      .then(function (payload) {
        if (!payload || payload.version !== 1 || !Array.isArray(payload.films)) {
          throw new Error('Worker returned an invalid response')
        }

        state.title = String(payload.title || state.title)
        state.total = payload.films.length
        log(`${state.title}: received ${state.total}`)

        if (!state.total) {
          state.completed = true
          state.resolveReady()
          state.resolveDone()
          return
        }

        return mapWithConcurrency(
          payload.films,
          MAX_TMDB_CONCURRENCY,
          function (film) {
            return runTmdbTask(function () {
              return searchTmdb(film)
            })
          },
          function (match, index) {
            state.matches[index] = match
            state.settled[index] = true
            flushSettled(state)
          },
        )
      })
      .catch(function (error) {
        state.completed = true
        state.resolveReady()
        state.resolveDone()
        log(`${state.title}: error`, error)
        notifyOnce(notificationFor(error))
      })

    return state.ready
  }

  function configuredSources() {
    const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
    const listValue = global.Lampa.Storage.get(STORAGE_LISTS, '')
    const sources = []

    if (username) {
      sources.push({
        kind: 'watchlist',
        username: username,
        key: `watchlist:${username.toLowerCase()}`,
        title: PLUGIN_NAME,
      })
    }

    parseListEntries(listValue, username).forEach(function (list) {
      sources.push({
        kind: 'list',
        username: list.username,
        slug: list.slug,
        key: `list:${list.key}`,
        title: `Letterboxd: ${list.slug.replace(/-/g, ' ')}`,
      })
    })

    return sources
  }

  function registerSettings() {
    global.Lampa.SettingsApi.addComponent({
      component: 'letterboxd',
      name: 'Letterboxd',
      icon: '<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="16" cy="32" r="12" fill="#00e054"/><circle cx="32" cy="32" r="12" fill="#40bcf4"/><circle cx="48" cy="32" r="12" fill="#ff8000"/></svg>',
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        name: STORAGE_USERNAME,
        type: 'input',
        values: '',
        default: '',
        placeholder: 'username',
      },
      field: {
        name: 'Letterboxd username',
        description: 'Публичный username для Watchlist и коротких адресов lists.',
      },
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        name: STORAGE_LISTS,
        type: 'input',
        values: '',
        default: '',
        placeholder: 'owner/list-slug, another-list',
      },
      field: {
        name: 'Public lists',
        description: 'Через запятую: owner/list-slug, полный Letterboxd URL или slug текущего username.',
      },
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        name: STORAGE_API_URL,
        type: 'input',
        values: '',
        default: API_BASE_URL,
        placeholder: 'https://name.workers.dev',
      },
      field: {
        name: 'Worker URL',
        description: 'Адрес единственного Cloudflare Worker. Изменения применятся после перезапуска.',
      },
    })
  }

  function injectStyles() {
    if (typeof document === 'undefined') return
    if (document.getElementById('letterboxd-plugin-styles')) return

    const style = document.createElement('style')
    style.id = 'letterboxd-plugin-styles'
    style.textContent = `
      .letterboxd-card-badges {
        position: absolute;
        z-index: 4;
        top: .55em;
        left: .55em;
        display: flex;
        max-width: calc(100% - 1.1em);
        flex-direction: column;
        align-items: flex-start;
        gap: .28em;
        pointer-events: none;
      }
      .letterboxd-card-badge {
        padding: .28em .55em;
        border: 1px solid rgba(255,255,255,.28);
        border-radius: .45em;
        color: #fff;
        font-size: .68em;
        font-weight: 700;
        line-height: 1.15;
        letter-spacing: .015em;
        text-shadow: 0 1px 2px rgba(0,0,0,.45);
        box-shadow: 0 .18em .5em rgba(0,0,0,.3);
        backdrop-filter: blur(7px);
      }
      .letterboxd-card-badge--letterboxd {
        background: rgba(0, 179, 63, .9);
      }
      .letterboxd-card-badge--lampa {
        background: rgba(32, 104, 210, .9);
      }
      .letterboxd-menu-icon circle {
        stroke: rgba(255,255,255,.3);
        stroke-width: 1.5;
      }
    `
    document.head.appendChild(style)
  }

  function filterInfo(value) {
    return FILTERS.find(function (item) {
      return item.value === value
    }) || FILTERS[0]
  }

  function filterArtwork(filter) {
    const info = filterInfo(filter)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="780" height="439" viewBox="0 0 780 439"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101820"/><stop offset=".52" stop-color="#26343f"/><stop offset="1" stop-color="#0b6b45"/></linearGradient></defs><rect width="780" height="439" rx="28" fill="url(#g)"/><circle cx="590" cy="220" r="86" fill="#00e054" opacity=".92"/><circle cx="652" cy="220" r="86" fill="#40bcf4" opacity=".86"/><circle cx="714" cy="220" r="86" fill="#ff8000" opacity=".84"/><text x="48" y="84" fill="#fff" font-family="Arial,sans-serif" font-size="30" font-weight="700">LETTERBOXD</text><text x="48" y="150" fill="#fff" font-family="Arial,sans-serif" font-size="42" font-weight="700">${info.title}</text><text x="48" y="204" fill="#d8e2e8" font-family="Arial,sans-serif" font-size="24">Нажмите, чтобы изменить фильтр</text></svg>`
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
  }

  function createCatalogLines(sources, filter) {
    let total = 0
    let visible = 0
    const lines = []

    sources.forEach(function (config) {
      const state = sourceStates[config.key]
      if (!state) return
      state.results.forEach(updateWatchedFlags)
      total += state.results.length
      visible += filterCatalogMovies(state.results, filter).length
    })

    lines.push({
      title: 'Фильтр и статусы',
      results: [
        {
          title: `Фильтр: ${filterInfo(filter).title}`,
          overview: `Показано ${visible} из ${total}. Статус учитывает Letterboxd и Lampa.`,
          cover: filterArtwork(filter),
          poster: filterArtwork(filter),
          letterboxd_control: 'filter',
          params: { style: { name: 'wide' } },
        },
      ],
      total_pages: 1,
      nomore: true,
    })

    sources.forEach(function (config) {
      const state = sourceStates[config.key]
      if (!state) return

      const results = filterCatalogMovies(state.results, filter)
      if (!results.length) return

      lines.push({
        title: `${state.title} · ${results.length}/${state.results.length}`,
        results: results,
        total_pages: 1,
        nomore: true,
        letterboxd_source: config.key,
        letterboxd_filter: filter,
      })
    })

    return lines
  }

  function openCatalogFilter(currentFilter) {
    global.Lampa.Select.show({
      title: 'Фильтр Letterboxd',
      items: FILTERS.map(function (item) {
        return {
          title: item.title,
          value: item.value,
          selected: item.value === currentFilter,
        }
      }),
      onSelect: function (item) {
        global.Lampa.Activity.replace({ filter: item.value })
      },
      onBack: function () {
        global.Lampa.Controller.toggle('content')
      },
    })
  }

  function createCatalogComponent(sources, apiBaseUrl) {
    return function (object) {
      const component = global.Lampa.Utils.createInstance(global.Lampa.InteractionMain, object)
      const filter = filterInfo(object.filter).value
      let stateListener = null

      component.use({
        onCreate: function () {
          const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
          const readiness = sources.map(function (config) {
            const state = sourceStates[config.key]
            return state ? loadSource(state, apiBaseUrl) : Promise.resolve([])
          })

          readiness.push(ensureWatched(username, apiBaseUrl))

          stateListener = function (event) {
            if (!event || (event.target !== 'favorite' && event.target !== 'timeline')) return
            sources.forEach(function (config) {
              const state = sourceStates[config.key]
              if (!state) return
              state.results.forEach(updateWatchedFlags)
              decorateStateCards(state)
            })
            if (component.activity && typeof component.activity.refresh === 'function') {
              component.activity.refresh()
            }
          }
          global.Lampa.Listener.follow('state:changed', stateListener)

          Promise.all(readiness)
            .then(function () {
              if (component.destroyed) return
              component.build(createCatalogLines(sources, filter))
            })
            .catch(function (error) {
              log('catalog error:', error)
              if (!component.destroyed) component.empty()
            })
        },
        onInstance: function (line) {
          line.use({
            onInstance: function (card, data) {
              card.use({
                onCreate: function () {
                  if (!data.letterboxd_control) decorateCard(card)
                },
                onUpdate: function () {
                  if (!data.letterboxd_control) decorateCard(card)
                },
                onFavorite: function () {
                  if (!data.letterboxd_control) decorateCard(card)
                },
                onEnter: function () {
                  if (data.letterboxd_control === 'filter') openCatalogFilter(filter)
                  else global.Lampa.Router.call('full', data)
                },
                onFocus: function () {
                  global.Lampa.Background.change(global.Lampa.Utils.cardImgBackground(data))
                },
              })
            },
          })
        },
        onDestroy: function () {
          if (stateListener) global.Lampa.Listener.remove('state:changed', stateListener)
        },
      })

      return component
    }
  }

  function registerCatalog(sources, apiBaseUrl) {
    if (
      !global.Lampa.Component ||
      !global.Lampa.Menu ||
      !global.Lampa.Activity ||
      !global.Lampa.InteractionMain
    ) {
      log('catalog APIs are unavailable in this Lampa build')
      return
    }

    global.Lampa.Component.add(
      CATALOG_COMPONENT,
      createCatalogComponent(sources, apiBaseUrl),
    )

    const icon = '<svg class="letterboxd-menu-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="17" cy="32" r="11" fill="#00e054"/><circle cx="32" cy="32" r="11" fill="#40bcf4"/><circle cx="47" cy="32" r="11" fill="#ff8000"/></svg>'
    const button = global.Lampa.Menu.addButton(icon, 'Letterboxd', function () {
      if (!sources.length) {
        global.Lampa.Noty.show('Letterboxd: укажите username или public list в настройках')
        return
      }

      global.Lampa.Activity.push({
        component: CATALOG_COMPONENT,
        title: 'Letterboxd',
        filter: 'all',
        page: 1,
      })
    })

    if (button && typeof button.attr === 'function') button.attr('data-action', CATALOG_COMPONENT)

    const node = button && button[0] ? button[0] : button
    const catalog = typeof document !== 'undefined'
      ? document.querySelector('.menu__item[data-action="catalog"]')
      : null
    if (node && catalog && catalog.parentNode) catalog.parentNode.insertBefore(node, catalog.nextSibling)
  }

  function registerLineListener() {
    global.Lampa.Listener.follow('line', function (event) {
      const key = event && event.data && event.data.letterboxd_source
      const state = key && sourceStates[key]
      if (!state) return

      if (event.type === 'create') {
        if (!state.lines.some(function (entry) { return entry.line === event.line })) {
          state.lines.push({
            line: event.line,
            filter: event.data.letterboxd_filter || 'all',
          })
        }
        if (!state.completed) appendPendingCards(state)
        decorateStateCards(state)
      } else if (event.type === 'append') {
        decorateStateCards(state)
      } else if (event.type === 'destroy') {
        state.lines = state.lines.filter(function (entry) {
          return entry.line !== event.line
        })
      }
    })
  }

  function registerContentRows(sources, apiBaseUrl) {
    sources.forEach(function (config, index) {
      const state = createSourceState(config)

      global.Lampa.ContentRows.add({
        name: `letterboxd_collection_${index}`,
        title: config.title,
        screen: ['main'],
        call: function () {
          return function (call) {
            loadSource(state, apiBaseUrl).then(function () {
              call({
                title: state.title,
                results: state.results,
                total_pages: 1,
                nomore: true,
                letterboxd_source: config.key,
              })
            })
          }
        },
      })

      loadSource(state, apiBaseUrl)
    })
  }

  function init() {
    if (global.plugin_letterboxd_watchlist_ready) return
    global.plugin_letterboxd_watchlist_ready = true

    registerSettings()
    injectStyles()
    const sources = configuredSources()
    const apiBaseUrl = configuredApiBaseUrl()
    if (!/^https?:\/\/[^\s]+$/i.test(apiBaseUrl)) {
      notifyOnce('Letterboxd: указан некорректный адрес Worker')
      return
    }
    registerLineListener()
    if (sources.length) registerContentRows(sources, apiBaseUrl)
    registerCatalog(sources, apiBaseUrl)

    const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
    if (username) ensureWatched(username, apiBaseUrl)
    log('plugin initialized', PLUGIN_VERSION)
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createTaskLimiter,
      filterCatalogMovies,
      isWatchedInLampa,
      mapWithConcurrency,
      normalizeTitle,
      parseListEntries,
      pickBestTmdbResult,
      retryWithBackoff,
    }
  }

  if (global.Lampa) {
    if (global.appready) init()
    else {
      global.Lampa.Listener.follow('app', function (event) {
        if (event.type === 'ready') init()
      })
    }
  }
})(typeof window !== 'undefined' ? window : globalThis)
