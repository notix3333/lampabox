(function (global) {
  'use strict'

  const PLUGIN_NAME = 'Letterboxd Watchlist'
  const PLUGIN_VERSION = '1.4.0'
  const STORAGE_USERNAME = 'letterboxd_watchlist_username'
  const STORAGE_LISTS = 'letterboxd_public_lists'
  const STORAGE_API_URL = 'letterboxd_watchlist_api_url'
  const API_BASE_URL = 'https://lampa-letterboxd-watchlist.lampabox.workers.dev'
  const LEGACY_API_BASE_URL = 'https://lampa-letterboxd-watchlist.rexikplay3.workers.dev'
  const MAX_TMDB_CONCURRENCY = 5
  const REQUEST_RETRY_DELAYS = [250, 500]
  const TMDB_RETRY_DELAYS = [200, 400]
  const TMDB_TIMEOUT_MS = 15000
  const WATCHED_PAGE_DELAY_MS = 2000
  const WATCHED_REQUEST_RETRY_DELAYS = [1500, 4000, 10000]
  const WATCHED_CACHE_POLL_MS = 5 * 60 * 1000 + 15 * 1000
  const CATALOG_COMPONENT = 'letterboxd_catalog'
  const FILTERS = [
    { value: 'all', title: 'Все' },
    { value: 'watched', title: 'Просмотрено' },
    { value: 'unwatched', title: 'Не просмотрено' },
  ]
  const BUILTIN_LIST_PRESETS = [
    {
      id: 'official-top-500',
      title: "Letterboxd's Top 500 Films",
      description: 'Официальный рейтинг полнометражных фильмов.',
      username: 'official',
      slug: 'letterboxds-top-500-films',
    },
    {
      id: 'watch-once',
      title: 'Movies Everyone Should Watch at Least Once',
      description: 'Одна из самых популярных подборок Letterboxd.',
      username: 'fcbarcelona',
      slug: 'movies-everyone-should-watch-at-least-once',
    },
    {
      id: 'feel-something',
      title: 'For When You Want to Feel Something',
      description: 'Популярная подборка эмоционального кино.',
      username: 'ellefnning',
      slug: 'for-when-you-want-to-feel-something',
    },
    {
      id: 'classic-beginners',
      title: 'Classic Movies for Beginners',
      description: 'Доступная точка входа в классическое кино.',
      username: 'hepburnluv',
      slug: 'classic-movies-for-beginners',
    },
    {
      id: '1001-movies',
      title: '1001 Movies You Must See Before You Die',
      description: 'Подборка из одноимённой книжной серии.',
      username: 'peterstanley',
      slug: '1001-movies-you-must-see-before-you-die',
    },
    {
      id: 'most-fans-250',
      title: 'Top 250 Films with the Most Fans',
      description: 'Официальный рейтинг фильмов по числу поклонников.',
      username: 'official',
      slug: 'top-250-films-with-the-most-fans',
    },
    {
      id: 'animated-250',
      title: 'Top 250 Animated Films',
      description: 'Официальный рейтинг полнометражной анимации.',
      username: 'official',
      slug: 'top-250-animated-films',
    },
  ]

  const sourceStates = Object.create(null)
  const watchedSlugs = Object.create(null)
  const watchedTitleYears = Object.create(null)
  const watchedTmdb = Object.create(null)
  const observedLines = []
  let errorShown = false
  let watchedPromise = null
  let watchedPollTimer = null

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

  function knownYear(item) {
    const explicit = Number(item && item.year)
    return Number.isInteger(explicit) && explicit > 1800 ? explicit : releaseYear(item)
  }

  function titleYearKeys(item) {
    const year = knownYear(item)
    if (!year) return []

    const titles = [item && item.title, item && item.name, originalTitle(item)]
    const seen = Object.create(null)

    return titles
      .map(normalizeTitle)
      .filter(function (title) {
        const key = `${title}|${year}`
        if (!title || seen[key]) return false
        seen[key] = true
        return true
      })
      .map(function (title) {
        return `${title}|${year}`
      })
  }

  function cloneCardData(movie) {
    const clone = Object.assign({}, movie)
    delete clone.ready
    return clone
  }

  function mediaType(item) {
    return item && (item.media_type === 'tv' || item.name || item.original_name || item.first_air_date)
      ? 'tv'
      : 'movie'
  }

  function tmdbKey(item) {
    return item && item.id ? `${mediaType(item)}:${item.id}` : ''
  }

  function rememberWatchedTmdb(movie) {
    const key = tmdbKey(movie)
    if (key) watchedTmdb[key] = true
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
      (movie.letterboxd_slug && watchedSlugs[movie.letterboxd_slug]) ||
        (tmdbKey(movie) && watchedTmdb[tmdbKey(movie)]) ||
        titleYearKeys(movie).some(function (key) {
          return watchedTitleYears[key]
        }),
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

        const bareUsernameEnteredAsList =
          !entry.includes('/') &&
          defaultUsername &&
          entry.toLowerCase() === String(defaultUsername).toLowerCase()
        if (bareUsernameEnteredAsList) return

        const key = `${username.toLowerCase()}/${slug.toLowerCase()}`
        if (seen[key]) return
        seen[key] = true
        result.push({ username: username, slug: slug, key: key })
      })

    return result
  }

  function normalizePresetCatalog(payload) {
    const usernamePattern = /^[a-z0-9][a-z0-9_-]{0,39}$/i
    const slugPattern = /^[a-z0-9][a-z0-9-]{0,119}$/i
    const source = payload && payload.version === 1 && Array.isArray(payload.lists)
      ? payload.lists
      : BUILTIN_LIST_PRESETS
    const seen = Object.create(null)
    const presets = source.filter(function (preset) {
      if (
        !preset ||
        typeof preset.title !== 'string' ||
        !usernamePattern.test(preset.username) ||
        !slugPattern.test(preset.slug)
      ) {
        return false
      }

      const key = `${preset.username.toLowerCase()}/${preset.slug.toLowerCase()}`
      if (seen[key]) return false
      seen[key] = true
      return true
    }).map(function (preset) {
      return {
        id: String(preset.id || `${preset.username}-${preset.slug}`),
        title: preset.title.trim(),
        description: String(preset.description || '').trim(),
        username: preset.username,
        slug: preset.slug,
      }
    })

    return presets.length ? presets : BUILTIN_LIST_PRESETS.slice()
  }

  function togglePresetList(value, preset, defaultUsername) {
    const entries = parseListEntries(value, defaultUsername)
    const wantedKey = `${preset.username.toLowerCase()}/${preset.slug.toLowerCase()}`
    const exists = entries.some(function (entry) {
      return entry.key === wantedKey
    })
    const next = exists
      ? entries.filter(function (entry) { return entry.key !== wantedKey })
      : entries.concat({
          username: preset.username,
          slug: preset.slug,
          key: wantedKey,
        })

    return {
      added: !exists,
      value: next.map(function (entry) {
        return `${entry.username}/list/${entry.slug}`
      }).join('\n'),
    }
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
    const configured = String(global.Lampa.Storage.get(STORAGE_API_URL, API_BASE_URL) || '')
      .trim()
      .replace(/\/+$/, '')

    if (!configured || configured === LEGACY_API_BASE_URL) {
      if (configured === LEGACY_API_BASE_URL) {
        global.Lampa.Storage.set(STORAGE_API_URL, API_BASE_URL)
      }
      return API_BASE_URL
    }

    return configured
  }

  function loadPresetCatalog(apiBaseUrl) {
    return retryWithBackoff(
      function () {
        return new Promise(function (resolve, reject) {
          const network = new global.Lampa.Reguest()
          network.timeout(15000)
          network.native(`${apiBaseUrl}/presets`, resolve, reject)
        })
      },
      REQUEST_RETRY_DELAYS,
      null,
      shouldRetryWorkerRequest,
    ).then(normalizePresetCatalog).catch(function (error) {
      log('Remote preset catalog is unavailable, using built-in presets', error)
      return normalizePresetCatalog(null)
    })
  }

  function openPresetCatalog() {
    const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
    const currentValue = global.Lampa.Storage.get(STORAGE_LISTS, '')

    loadPresetCatalog(configuredApiBaseUrl()).then(function (presets) {
      const selected = Object.create(null)
      parseListEntries(currentValue, username).forEach(function (entry) {
        selected[entry.key] = true
      })

      global.Lampa.Select.show({
        title: 'Популярные Letterboxd Lists',
        items: presets.map(function (preset) {
          const key = `${preset.username.toLowerCase()}/${preset.slug.toLowerCase()}`
          return {
            title: preset.title,
            subtitle: preset.description,
            selected: Boolean(selected[key]),
            preset: preset,
          }
        }),
        onSelect: function (item) {
          const latestValue = global.Lampa.Storage.get(STORAGE_LISTS, '')
          const result = togglePresetList(latestValue, item.preset, username)
          global.Lampa.Storage.set(STORAGE_LISTS, result.value)
          global.Lampa.Noty.show(
            result.added
              ? `Letterboxd list добавлен: ${item.preset.title}`
              : `Letterboxd list удалён: ${item.preset.title}`,
          )
          if (global.Lampa.Controller) global.Lampa.Controller.toggle('settings_component')
        },
        onBack: function () {
          if (global.Lampa.Controller) global.Lampa.Controller.toggle('settings_component')
        },
      })
    })
  }

  function requestCollection(config, apiBaseUrl) {
    const retryDelays = config.kind === 'watched'
      ? WATCHED_REQUEST_RETRY_DELAYS
      : REQUEST_RETRY_DELAYS

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
      retryDelays,
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

  function watchedPollDelay(cache, now) {
    const current = Number.isFinite(now) ? now : Date.now()
    const nextAttempt = Date.parse(cache && cache.nextAttemptAt)

    return Number.isFinite(nextAttempt)
      ? Math.max(WATCHED_CACHE_POLL_MS, nextAttempt - current + 30000)
      : WATCHED_CACHE_POLL_MS
  }

  function ensureWatched(username, apiBaseUrl, watchedState) {
    if (watchedPromise) return watchedPromise
    if (!username) return Promise.resolve(watchedSlugs)

    function refreshWatchedCards() {
      Object.keys(sourceStates).forEach(function (key) {
        const state = sourceStates[key]
        state.results.forEach(updateWatchedFlags)
        appendPendingCards(state)
        decorateStateCards(state)
      })
      decorateObservedCards()
    }

    function scheduleCachePoll(cache) {
      if (!cache || cache.status !== 'building' || watchedPollTimer) return

      watchedPollTimer = setTimeout(function () {
        watchedPollTimer = null
        loadPage(1).catch(function (error) {
          log('Letterboxd watched cache poll failed', error)
          scheduleCachePoll(cache)
        })
      }, watchedPollDelay(cache))
    }

    function loadPage(page) {
      return requestCollection(
        { kind: 'watched', username: username, page: page },
        apiBaseUrl,
      ).then(function (payload) {
        if (!payload || payload.version !== 1 || !Array.isArray(payload.films)) {
          throw new Error('Worker returned an invalid watched response')
        }

        payload.films.forEach(function (film) {
          if (!film) return
          if (film.slug) watchedSlugs[film.slug] = true
          titleYearKeys(film).forEach(function (key) {
            watchedTitleYears[key] = true
          })
        })

        const expectedTotal = Number(payload.total)
        if (watchedState && Number.isInteger(expectedTotal) && expectedTotal >= payload.films.length) {
          watchedState.expectedTotal = Math.max(watchedState.expectedTotal, expectedTotal)
        }

        if (watchedState) addFilmsToState(watchedState, payload.films)

        refreshWatchedCards()

        const nextPage = Number(payload.nextPage)
        if (Number.isInteger(nextPage) && nextPage > page && nextPage <= 100) {
          return new Promise(function (resolve) {
            setTimeout(resolve, WATCHED_PAGE_DELAY_MS)
          }).then(function () {
            return loadPage(nextPage)
          })
        }
        scheduleCachePoll(payload.cache)
        return watchedSlugs
      })
    }

    watchedPromise = loadPage(1)
      .then(function (slugs) {
        refreshWatchedCards()
        log(`Letterboxd watched received: ${Object.keys(slugs).length}`)
        return slugs
      })
      .catch(function (error) {
        log(`Letterboxd watched partially received: ${Object.keys(watchedSlugs).length}`, error)
        if (!Object.keys(watchedSlugs).length) notifyOnce(notificationFor(error))
        if (watchedState) {
          watchedState.completed = true
          watchedState.resolveReady()
          watchedState.resolveDone()
        }
        refreshWatchedCards()
        return watchedSlugs
      })

    return watchedPromise
  }

  function applyBadges(view, data, containerClass) {
    if (!view) return
    updateWatchedFlags(data)

    const className = containerClass || 'letterboxd-card-badges'
    const previous = view.querySelector(`.${className}`)
    if (previous) previous.remove()
    if (!data.letterboxd_watched && !data.lampa_watched) return

    const badges = document.createElement('div')
    badges.className = className

    if (data.letterboxd_watched) {
      const badge = document.createElement('div')
      badge.className = 'letterboxd-card-badge letterboxd-card-badge--letterboxd'
      badge.textContent = 'Letterboxd ✓'
      badges.appendChild(badge)
    }

    if (data.lampa_watched) {
      const badge = document.createElement('div')
      badge.className = 'letterboxd-card-badge letterboxd-card-badge--lampa'
      badge.textContent = 'Lampa ✓'
      badges.appendChild(badge)
    }

    view.appendChild(badges)
  }

  function decorateCard(card) {
    if (
      typeof document === 'undefined' ||
      !card ||
      !card.data ||
      typeof card.render !== 'function'
    ) return

    const html = card.render(true)
    const view = html && html.querySelector ? html.querySelector('.card__view') : null
    applyBadges(view, card.data)
  }

  function decorateCardElement(element) {
    if (!element || !element.querySelector || !element.card_data) return
    applyBadges(element.querySelector('.card__view'), element.card_data)
  }

  function decorateCardsIn(root) {
    if (!root || !root.querySelectorAll) return
    if (root.matches && root.matches('.card')) decorateCardElement(root)
    root.querySelectorAll('.card').forEach(decorateCardElement)
  }

  function decorateFull(event) {
    if (!event || event.type !== 'complite' || !event.data || !event.data.movie) return
    const body = event.body && event.body[0] ? event.body[0] : event.body
    const poster = body && body.querySelector
      ? body.querySelector('.full-start-new__poster, .full-start__poster')
      : null
    applyBadges(poster, event.data.movie, 'letterboxd-full-badges')
  }

  function registerCardObserver() {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return

    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        mutation.addedNodes.forEach(function (node) {
          if (node && node.nodeType === 1) decorateCardsIn(node)
        })
      })
    })
    observer.observe(document.body, { childList: true, subtree: true })
    decorateCardsIn(document)
  }

  function decorateStateCards(state) {
    state.lines.forEach(function (entry) {
      const items = Array.isArray(entry.items) ? entry.items : []
      items.forEach(decorateCard)
    })
  }

  function decorateObservedCards() {
    observedLines.forEach(function (entry) {
      entry.items.forEach(decorateCard)
    })
    if (typeof document !== 'undefined') decorateCardsIn(document)
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
      expectedTotal: 0,
      completed: false,
      started: false,
      readyResolved: false,
      doneResolved: false,
      lines: [],
      seen: Object.create(null),
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
      if (!line) return

      const visibleResults = filterCatalogMovies(state.results, entry.filter)
      const items = Array.isArray(entry.items) ? entry.items : []
      for (let index = items.length; index < visibleResults.length; index += 1) {
        const movie = cloneCardData(visibleResults[index])
        if (typeof line.append === 'function') line.append(movie)
        else if (typeof line.emit === 'function') line.emit('createAndAppend', movie)
      }
    })
  }

  function flushSettled(state) {
    while (state.settled[state.nextFlushIndex]) {
      const match = state.matches[state.nextFlushIndex]
      state.nextFlushIndex += 1

      if (match) {
        if (state.config.kind === 'watched') rememberWatchedTmdb(match)
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

  function addFilmsToState(state, films) {
    const fresh = (Array.isArray(films) ? films : []).filter(function (film) {
      if (!film || !film.slug || state.seen[film.slug]) return false
      state.seen[film.slug] = true
      return true
    })
    if (!fresh.length) return Promise.resolve([])

    const offset = state.total
    state.total += fresh.length
    state.completed = false

    return mapWithConcurrency(
      fresh,
      MAX_TMDB_CONCURRENCY,
      function (film) {
        return runTmdbTask(function () {
          return searchTmdb(film)
        })
      },
      function (match, index) {
        state.matches[offset + index] = match
        state.settled[offset + index] = true
        flushSettled(state)
      },
    )
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
        payload.films.forEach(function (film) {
          if (film && film.slug) state.seen[film.slug] = true
        })
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
        description: 'Только username профиля, например nikolaipopov. Watchlist подключается автоматически.',
      },
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        type: 'button',
      },
      field: {
        name: 'Популярные Letterboxd Lists',
        description: 'Добавить или удалить готовую подборку без ручного ввода URL.',
      },
      onChange: openPresetCatalog,
    })

    global.Lampa.SettingsApi.addParam({
      component: 'letterboxd',
      param: {
        name: STORAGE_LISTS,
        type: 'input',
        values: '',
        default: '',
        placeholder: 'owner/list/list-slug или оставьте пустым',
      },
      field: {
        name: 'Дополнительные public lists',
        description: 'Не повторяйте username. Укажите только дополнительные списки или оставьте поле пустым.',
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
      .letterboxd-card-badges,
      .letterboxd-full-badges {
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
      .full-start-new__poster,
      .full-start__poster {
        position: relative;
      }
      .letterboxd-full-badges {
        font-size: 1.05em;
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
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#101820"/><stop offset=".56" stop-color="#26343f"/><stop offset="1" stop-color="#0b6b45"/></linearGradient></defs><rect width="500" height="750" rx="32" fill="url(#g)"/><text x="40" y="76" fill="#fff" font-family="Arial,sans-serif" font-size="30" font-weight="700">LETTERBOXD</text><text x="40" y="145" fill="#fff" font-family="Arial,sans-serif" font-size="38" font-weight="700">${info.title}</text><text x="40" y="205" fill="#d8e2e8" font-family="Arial,sans-serif" font-size="22">Изменить фильтр</text><circle cx="160" cy="580" r="78" fill="#00e054" opacity=".92"/><circle cx="250" cy="580" r="78" fill="#40bcf4" opacity=".86"/><circle cx="340" cy="580" r="78" fill="#ff8000" opacity=".84"/></svg>`
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
  }

  function lampaViewedMovies() {
    try {
      if (!global.Lampa.Favorite || typeof global.Lampa.Favorite.get !== 'function') return []
      const items = global.Lampa.Favorite.get({ type: 'viewed' })
      return Array.isArray(items) ? items.map(updateWatchedFlags) : []
    } catch (error) {
      log('Lampa viewed catalog failed:', error && error.message ? error.message : error)
      return []
    }
  }

  function createCatalogLines(sources, filter, watchedState) {
    let total = 0
    let visible = 0
    const lines = []

    if (filter === 'watched') {
      const letterboxdResults = watchedState ? watchedState.results : []
      const lampaResults = lampaViewedMovies()
      total = (watchedState ? watchedState.expectedTotal || watchedState.total : 0) + lampaResults.length
      visible = letterboxdResults.length + lampaResults.length
    } else {
      sources.forEach(function (config) {
        const state = sourceStates[config.key]
        if (!state) return
        state.results.forEach(updateWatchedFlags)
        total += state.results.length
        visible += filterCatalogMovies(state.results, filter).length
      })
    }

    lines.push({
      title: 'Фильтр и статусы',
      results: [
        {
          title: `Фильтр: ${filterInfo(filter).title}`,
          overview: `Показано ${visible} из ${total}. Статус учитывает Letterboxd и Lampa.`,
          cover: filterArtwork(filter),
          poster: filterArtwork(filter),
          letterboxd_control: 'filter',
        },
      ],
      total_pages: 1,
      nomore: true,
    })

    if (filter === 'watched') {
      const letterboxdResults = watchedState
        ? watchedState.results.map(cloneCardData)
        : []
      lines.push({
        title: `Просмотрено в Letterboxd · ${letterboxdResults.length}/${watchedState ? watchedState.expectedTotal || watchedState.total : 0}`,
        results: letterboxdResults,
        total_pages: 1,
        nomore: true,
        letterboxd_source: watchedState ? watchedState.config.key : '',
        letterboxd_filter: 'all',
      })

      const lampaResults = lampaViewedMovies().map(cloneCardData)
      if (lampaResults.length) {
        lines.push({
          title: `Просмотрено в Lampa · ${lampaResults.length}`,
          results: lampaResults,
          total_pages: 1,
          nomore: true,
        })
      }

      return lines
    }

    sources.forEach(function (config) {
      const state = sourceStates[config.key]
      if (!state) return

      const results = filterCatalogMovies(state.results, filter).map(cloneCardData)
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

  function createCatalogComponent(sources, apiBaseUrl, watchedState) {
    return function (object) {
      const component = global.Lampa.Utils.createInstance(global.Lampa.InteractionMain, object)
      const filter = filterInfo(object.filter).value
      let stateListener = null
      let destroyed = false

      component.create = function () {
        const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
        const readiness = filter === 'watched'
          ? [watchedState ? watchedState.ready : Promise.resolve([])]
          : sources.map(function (config) {
              const state = sourceStates[config.key]
              return state ? loadSource(state, apiBaseUrl) : Promise.resolve([])
            })

        if (component.activity && typeof component.activity.loader === 'function') {
          component.activity.loader(true)
        }

        ensureWatched(username, apiBaseUrl, watchedState)

        stateListener = function (event) {
          if (!event || (event.target !== 'favorite' && event.target !== 'timeline')) return
          sources.forEach(function (config) {
            const state = sourceStates[config.key]
            if (!state) return
            state.results.forEach(updateWatchedFlags)
            decorateStateCards(state)
          })
          decorateObservedCards()
          if (filter !== 'all' && component.activity && typeof component.activity.refresh === 'function') {
            component.activity.refresh()
          }
        }
        global.Lampa.Listener.follow('state:changed', stateListener)

        Promise.all(readiness)
          .then(function () {
            if (destroyed) return
            component.build(createCatalogLines(sources, filter, watchedState))
          })
          .catch(function (error) {
            log('catalog error:', error)
            if (!destroyed) component.build(createCatalogLines(sources, filter, watchedState))
          })
      }

      component.onAppend = function (line) {
        line.onSelect = function (_target, data) {
          if (data.letterboxd_control === 'filter') openCatalogFilter(filter)
          else global.Lampa.Router.call('full', data)
        }
        line.onFocus = function (data) {
          global.Lampa.Background.change(global.Lampa.Utils.cardImgBackground(data))
        }
        line.onAppend = decorateCard
      }

      component.onDestroy = function () {
        destroyed = true
        if (stateListener) global.Lampa.Listener.remove('state:changed', stateListener)
      }

      return component
    }
  }

  function registerCatalog(sources, apiBaseUrl, watchedState) {
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
      createCatalogComponent(sources, apiBaseUrl, watchedState),
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

      if (event.type === 'create') {
        if (!observedLines.some(function (entry) { return entry.line === event.line })) {
          observedLines.push({
            line: event.line,
            items: Array.isArray(event.items) ? event.items : [],
          })
        }

        if (state && !state.lines.some(function (entry) { return entry.line === event.line })) {
          state.lines.push({
            line: event.line,
            items: Array.isArray(event.items) ? event.items : [],
            filter: event.data.letterboxd_filter || 'all',
          })
        }
        if (state && !state.completed) appendPendingCards(state)
        if (state) decorateStateCards(state)
        decorateObservedCards()
      } else if (event.type === 'append') {
        if (state) decorateStateCards(state)
        decorateObservedCards()
      } else if (event.type === 'destroy') {
        if (state) {
          state.lines = state.lines.filter(function (entry) {
            return entry.line !== event.line
          })
        }
        for (let index = observedLines.length - 1; index >= 0; index -= 1) {
          if (observedLines[index].line === event.line) observedLines.splice(index, 1)
        }
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
                results: state.results.map(cloneCardData),
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

    const username = String(global.Lampa.Storage.get(STORAGE_USERNAME, '') || '').trim()
    const watchedState = username
      ? createSourceState({
          kind: 'watched',
          username: username,
          key: `watched:${username.toLowerCase()}`,
          title: 'Просмотрено в Letterboxd',
        })
      : null

    registerCatalog(sources, apiBaseUrl, watchedState)
    registerCardObserver()
    global.Lampa.Listener.follow('full', decorateFull)
    if (username) ensureWatched(username, apiBaseUrl, watchedState)
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
      normalizePresetCatalog,
      configuredApiBaseUrl,
      rememberWatchedTmdb,
      retryWithBackoff,
      togglePresetList,
      updateWatchedFlags,
      watchedPollDelay,
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
