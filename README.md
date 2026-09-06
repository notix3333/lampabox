<p align="center">
  <img src="logo.png" alt="LampaBox" width="300">
</p>

Плагин для Lampa 3.0+, который добавляет публичные коллекции Letterboxd в интерфейс Lampa и сопоставляет фильмы и сериалы с TMDB.

## Demo 

<p align="center">
  <img src="demo.gif" alt="Demo" width="800">
</p>

## Возможности

- отдельный раздел `Letterboxd` в боковом меню Lampa;
- публичный Watchlist пользователя;
- подключение нескольких публичных Letterboxd Lists;
- каталог просмотренных фильмов Letterboxd;
- поддержка фильмов и сериалов через TMDB Movie/TV Search;
- фильтры `Все`, `Просмотрено` и `Не просмотрено`;
- плашки `Letterboxd ✓` и `Lampa ✓` на карточках;
- сохранение плашек в строках, полном каталоге и на странице фильма;
- прогрессивное появление карточек во время TMDB-сопоставления;
- фоновое накопление просмотренных фильмов в Cloudflare KV;
- retry, exponential backoff и jitter для временных ошибок Letterboxd/TMDB.

## Установка

Добавьте этот URL в список плагинов Lampa:

```text
https://lampa-letterboxd-watchlist.rexikplay3.workers.dev/letterboxd-watchlist.js?v=1.3.0
```

Затем:

1. Полностью перезапустите Lampa.
2. Откройте `Настройки → Letterboxd`.
3. Укажите публичный Letterboxd username.
4. При необходимости добавьте публичные списки.
5. Откройте пункт `Letterboxd` в боковом меню.

Плагин и API обслуживаются одним Cloudflare Worker. Отдельный сервер, VPS, Docker-контейнер или постоянно работающий компьютер не нужны.

## Настройка публичных списков

Поле `Public lists` принимает значения через запятую или с новой строки:

```text
my-favorites
other-user/tv-picks
https://letterboxd.com/official/list/letterboxds-top-500-films/
```

Поддерживаемые форматы:

- `slug` — список текущего пользователя;
- `owner/slug`;
- `owner/list/slug`;
- полный URL публичного списка Letterboxd.

Пустые и повторяющиеся значения игнорируются. Закрытые профили, Watchlist и Lists получить невозможно.

## Как работает плагин

```text
Letterboxd HTML
      ↓
Cloudflare Worker ── Cloudflare KV
      ↓
Lampa plugin
      ↓
TMDB Movie / TV Search
```

Worker принимает только фиксированные маршруты, загружает публичный HTML Letterboxd и возвращает нормализованные данные `title`, `year` и `slug`. Он не является универсальным HTTP-прокси и не принимает произвольные URL.

Плагин сопоставляет результаты с TMDB через нативный `Lampa.Api.search`. Movie и TV проверяются отдельно, а совпадение принимается только при совместимых названии и годе. Общая очередь ограничивает количество параллельных запросов к TMDB.

Статус просмотра определяется по нескольким идентификаторам:

- Letterboxd slug;
- нормализованные название и год;
- тип медиа и TMDB ID после сопоставления;
- локальные Favorite/Timeline Lampa.

Фильм считается просмотренным в Lampa при явной отметке `Просмотрено`, прогрессе фильма не менее 90% или наличии просмотренного эпизода сериала.

## Фоновый сбор просмотренных фильмов

Страницы `https://letterboxd.com/USERNAME/films/` собираются постепенно:

1. Первый запрос регистрирует профиль и сохраняет доступную первую страницу.
2. Cron Worker запускается каждые пять минут.
3. Один запуск загружает не более одной исходной HTML-страницы.
4. Успешные страницы сохраняются в KV.
5. Lampa периодически проверяет растущий снимок и добавляет новые карточки.

При временной ошибке Worker не удаляет уже сохранённые данные. Следующая попытка назначается с экспоненциальным backoff от 5 минут до 6 часов и случайным jitter до 2 минут.

Во время повторного обхода продолжает использоваться последний полный снимок. Новый снимок заменяет его только после успешного завершения всех страниц, поэтому `403`, `429`, `5xx`, сетевые ошибки и Cloudflare challenge не могут обнулить каталог.

> [!IMPORTANT]
> Letterboxd не предоставляет стабильный публичный API для этого сценария. Фоновый сбор повышает надёжность, но не гарантирует получение всех страниц: Letterboxd может временно или постоянно блокировать HTML-пагинацию.

## Самостоятельное развёртывание

### Требования

- Node.js 22+;
- npm;
- Cloudflare Workers account;
- публичный Letterboxd профиль или публичные списки.

Глобальная установка Wrangler не требуется. Все зависимости находятся в `worker/node_modules`, локальная конфигурация Wrangler — в `.cache/xdg-config`, сборочные файлы — в `dist` и `worker/dist`.

### Развёртывание Worker

```bash
git clone https://github.com/notix3333/lampabox.git
cd lampabox
npm ci --prefix worker
npm test
npm run typecheck

cd worker
npm run login
./node_modules/.bin/wrangler kv namespace create lampabox-watched-cache \
  --binding WATCHED_CACHE \
  --update-config
npm run deploy
```

Wrangler создаст KV namespace, запишет его ID в `worker/wrangler.jsonc` и опубликует Worker вместе с cron-триггером. ID из репозитория относится к production deployment проекта; при развёртывании в другом Cloudflare-аккаунте его необходимо заменить собственным через команду выше.

Для неинтерактивного deployment передайте `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID` только процессу Wrangler или настройте GitHub Actions secrets.

### Сборка плагина для своего Worker

Из корня репозитория:

```bash
API_BASE_URL='https://YOUR-WORKER.workers.dev' npm run build:plugin
```

Готовый файл:

```text
dist/letterboxd-watchlist.js
```

Опубликуйте его по HTTPS и добавьте прямой URL в Lampa. Адрес Worker также можно изменить без пересборки через `Настройки → Letterboxd → Worker URL`.

## Сборка и публикация через GitHub

В репозитории настроены три workflow:

- `CI` — тесты, typecheck, dry-run Worker и сборочный artifact плагина;
- `Deploy Cloudflare Worker` — ручное развёртывание Worker;
- `Publish plugin to GitHub Pages` — публикация standalone-плагина.

Для GitHub Pages:

1. Создайте repository variable `LETTERBOXD_API_BASE_URL` с HTTPS-адресом Worker.
2. В `Settings → Pages → Build and deployment` выберите `GitHub Actions`.
3. Запустите `Publish plugin to GitHub Pages` или отправьте изменение в `main`.

Для deployment Worker добавьте GitHub Actions secrets:

- `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID`.

Перед первым запуском workflow привяжите собственный KV namespace в `worker/wrangler.jsonc`.

## API Worker

### Маршруты

```http
GET /watchlist/:username
GET /list/:username/:slug
GET /watched/:username?page=1
```

### Пример ответа Watchlist

```json
{
  "version": 1,
  "kind": "watchlist",
  "username": "nikolai123",
  "title": "Letterboxd Watchlist",
  "fetchedAt": "2026-09-05T11:30:00.000Z",
  "films": [
    {
      "title": "Dune: Part Two",
      "year": 2024,
      "slug": "dune-part-two"
    }
  ]
}
```

### Пример состояния watched-кеша

```json
{
  "version": 1,
  "kind": "watched",
  "username": "nikolai123",
  "title": "Letterboxd Watched",
  "page": 1,
  "nextPage": null,
  "total": 355,
  "fetchedAt": "2026-09-05T11:30:00.000Z",
  "films": [
    {
      "title": "Dune: Part Two",
      "year": 2024,
      "slug": "dune-part-two"
    }
  ],
  "cache": {
    "status": "building",
    "collectedFilms": 1,
    "sourcePages": 1,
    "nextSourcePage": 2,
    "nextAttemptAt": "2026-09-05T11:35:00.000Z",
    "lastSuccessAt": "2026-09-05T11:30:00.000Z",
    "lastFailureAt": null
  }
}
```

`nextPage` относится к пагинации готового API-снимка, а `cache.nextSourcePage` — к следующей HTML-странице Letterboxd, которую должен собрать cron.

Ошибки возвращаются в едином формате:

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "Letterboxd user was not found"
  }
}
```

Все ответы API содержат CORS-заголовки и `Cache-Control: no-store`.

## Разработка

```bash
npm test                 # Worker и plugin tests
npm run typecheck        # TypeScript
npm run build            # Worker dry-run + standalone plugin
npm run build:worker     # Worker dry-run
npm run build:plugin     # dist/letterboxd-watchlist.js
npm run dev:worker:lan   # локальный Worker в LAN
npm run serve:plugin     # локальная раздача плагина
```

Локальная проверка API:

```bash
curl http://localhost:8787/watchlist/USERNAME
curl http://localhost:8787/list/OWNER/LIST-SLUG
curl 'http://localhost:8787/watched/USERNAME?page=1'
```

## Структура проекта

```text
plugin/                  исходный standalone-плагин Lampa
plugin/test/             тесты клиентской логики
worker/src/              Cloudflare Worker, парсер и KV-сборщик
worker/test/             unit-тесты и HTML fixtures
scripts/                 локальная сборка и раздача плагина
.github/workflows/       CI, Worker deploy и GitHub Pages
```

## Ограничения

- поддерживаются только публичные данные Letterboxd;
- HTML-разметка Letterboxd может измениться и потребовать обновления парсера;
- защита Letterboxd может блокировать отдельные страницы;
- исходная HTML-пагинация ограничена 100 страницами;
- размер одной HTML-страницы ограничен 2 MiB;
- неоднозначные результаты TMDB намеренно пропускаются;
- плагин не изменяет данные Letterboxd и не выполняет авторизацию от имени пользователя.

Worker не обходит приватность, авторизацию или защитные механизмы Letterboxd.
