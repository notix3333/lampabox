# Lampa Letterboxd Watchlist

Displays a public Letterboxd watchlist as a native content row in Lampa.

Минимальный плагин для Lampa 3.0+: пользователь указывает публичный Letterboxd username, после перезапуска Lampa получает свежий watchlist и показывает найденные фильмы отдельной строкой `Letterboxd Watchlist` на главной странице. При выборе фильма открывается обычная карточка Lampa/TMDB.

## Архитектура

```text
Letterboxd → Cloudflare Worker → Lampa plugin → TMDB/Lampa
```

- Stateless Cloudflare Worker последовательно загружает все страницы публичного watchlist, разбирает HTML и возвращает только `title`, `year`, `slug`.
- Lampa-плагин один раз за запуск получает watchlist и с concurrency `5` ищет фильмы через нативный `Lampa.Api.search`.
- База данных, авторизация, cookies, Letterboxd credentials и постоянный кеш отсутствуют.
- Worker принимает только `GET /watchlist/:username`, не принимает произвольные URL и не является HTTP-прокси.

Реализация Lampa API сверена с `yumata/lampa-source` 3.0+ на коммите `d2c3554` от 30 августа 2026 года: используются `SettingsApi`, `ContentRows`, `Api.search`, `Storage`, `Reguest` и `Noty`.

## Требования

- Lampa 3.0+;
- публичный Letterboxd watchlist;
- Cloudflare Workers account;
- Node.js 22+ и npm только для разработки/сборки.

Все локальные зависимости устанавливаются в `worker/node_modules`, npm-кеш и конфигурация инструментов хранятся в `.cache`, а артефакты — в `dist` и `worker/dist`. Эти каталоги исключены из Git. Глобальная установка пакетов не нужна.

## Быстрый старт

### 1. Worker

```bash
cd worker
npm install
npm test
npm run typecheck
npm run deploy
```

Для полностью безынтерактивного deploy можно передать Cloudflare API token через переменную окружения `CLOUDFLARE_API_TOKEN`. После deploy Wrangler напечатает адрес вида:

```text
https://lampa-letterboxd-watchlist.<account>.workers.dev
```

Локальная разработка:

```bash
cd worker
npm run dev
```

Проверка endpoint:

```bash
curl http://localhost:8787/watchlist/USERNAME
```

### 2. Сборка standalone-плагина

Из корня репозитория:

```bash
API_BASE_URL='https://lampa-letterboxd-watchlist.<account>.workers.dev' npm run build:plugin
```

Готовый файл появится в:

```text
dist/letterboxd-watchlist.js
```

Без `API_BASE_URL` сборка использует безопасную заглушку `https://example.workers.dev`; такой плагин покажет уведомление о необходимости настроить Worker и не отправит запрос на этот адрес. Адрес Worker также можно ввести непосредственно в `Настройки → Letterboxd → Worker URL`, поэтому для первой проверки пересборка плагина не обязательна.

Для ручного использования без build-шага можно изменить константу в `plugin/letterboxd-watchlist.js`:

```js
const API_BASE_URL = 'https://lampa-letterboxd-watchlist.<account>.workers.dev'
```

### 3. Установка в Lampa

Если репозиторий публичный, исходный standalone-файл можно подключить напрямую:

```text
https://raw.githubusercontent.com/notix3333/lampabox/main/plugin/letterboxd-watchlist.js
```

В приватном репозитории этот адрес без GitHub-авторизации вернет `404`; в таком случае используйте GitHub Pages, другой HTTPS-хостинг либо описанный ниже локальный режим. Файл не содержит чужого Worker URL: после установки укажите адрес собственного Worker в настройках плагина.

Опубликуйте `dist/letterboxd-watchlist.js` по HTTPS, например через GitHub Pages, и получите прямой URL:

```text
https://USERNAME.github.io/REPOSITORY/letterboxd-watchlist.js
```

Добавьте этот URL в Lampa как обычный URL плагина. Затем:

```text
Настройки → Letterboxd → Worker URL → Letterboxd username → перезапуск Lampa
```

Без username плагин не делает запросов и не показывает пустую строку.

## Сборка прямо из Git/GitHub

Локально из чистого clone:

```bash
git clone https://github.com/notix3333/lampabox.git
cd lampabox
npm ci --prefix worker
npm test
API_BASE_URL='https://YOUR-WORKER.workers.dev' npm run build
```

Репозиторий содержит три GitHub Actions workflow:

- `CI` устанавливает зависимости через lockfile, запускает Worker/plugin tests, typecheck, dry-run сборку Worker и загружает standalone JS как artifact;
- `Deploy Cloudflare Worker` вручную публикует Worker с помощью GitHub secrets `CLOUDFLARE_API_TOKEN` и `CLOUDFLARE_ACCOUNT_ID`;
- `Publish plugin to GitHub Pages` собирает и публикует плагин, если в GitHub repository variable `LETTERBOXD_API_BASE_URL` указан HTTPS-адрес Worker.

Чтобы получить стабильный URL плагина из GitHub:

1. В `Settings → Secrets and variables → Actions → Variables` создайте `LETTERBOXD_API_BASE_URL`.
2. В `Settings → Pages → Build and deployment` выберите `GitHub Actions`.
3. Запустите workflow `Publish plugin to GitHub Pages` или отправьте изменение в `main`.

## Команды проекта

```bash
npm test             # Worker unit tests + тесты чистых функций плагина
npm run typecheck    # строгая проверка TypeScript
npm run build:worker # локальная dry-run сборка Wrangler
npm run build:plugin # standalone JS в dist/
npm run build        # обе сборки
npm run serve:plugin # локально раздать JS на порту 8080
npm run dev:worker:lan # локальный Worker, доступный в LAN
```

## API Worker

```http
GET /watchlist/:username
```

Успешный ответ:

```json
{
  "version": 1,
  "username": "nikolai123",
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

Ошибки имеют единый формат:

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "Letterboxd user was not found"
  }
}
```

Поддерживаются `INVALID_USERNAME`, `USER_NOT_FOUND`, `WATCHLIST_UNAVAILABLE`, `LETTERBOXD_BLOCKED`, `LETTERBOXD_ERROR`, `PARSER_ERROR`, `INTERNAL_ERROR`. Все ответы содержат `Cache-Control: no-store`; CORS разрешает `GET` и `OPTIONS`.

## Поведение и ограничения MVP

- Watchlist загружается один раз за текущий запуск Lampa и не сохраняется между запусками.
- Порядок Letterboxd сохраняется, случайные дубликаты удаляются по `slug`.
- Пагинация ограничена 100 страницами, размер одной HTML-страницы — 2 MiB.
- Совпадение TMDB принимается только для точного нормализованного title/original title и совместимого года; сомнительные совпадения пропускаются.
- Частичные результаты допустимы: ошибка поиска одного фильма не ломает всю строку.
- Worker не обходит приватность и защиту Letterboxd.

Letterboxd не предоставляет стабильный публичный HTML API для этого сценария, поэтому изменения разметки могут потребовать обновления `worker/src/parser.ts`. Fixture-тесты не обращаются к Letterboxd и остаются детерминированными.

## Нужен ли сервер

Да, между Lampa и Letterboxd нужен HTTP-компонент из-за CORS и необходимости разбирать HTML Letterboxd. Обычный VPS, Docker и постоянно работающий домашний компьютер не нужны: эту роль выполняет небольшой stateless Cloudflare Worker. Для небольшого личного watchlist обычно достаточно [бесплатного тарифа Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/). На Free plan действует лимит 50 внешних subrequests за один вызов Worker; одна страница watchlist использует один такой запрос, поэтому очень большие watchlists могут потребовать платного тарифа или отдельной доработки архитектуры.

Без Worker плагин намеренно не обращается к Letterboxd напрямую и не использует сторонние публичные CORS-прокси.

## Как попробовать текущую версию

1. Разверните Worker командой `cd worker && npm run deploy` либо запустите workflow `Deploy Cloudflare Worker` после добавления двух Cloudflare secrets.
2. Опубликуйте `dist/letterboxd-watchlist.js` по HTTPS или включите workflow GitHub Pages.
3. Добавьте URL JS-файла в список плагинов Lampa.
4. В разделе `Настройки → Letterboxd` укажите полученный `Worker URL` и свой `Letterboxd username`.
5. Полностью перезапустите Lampa.

Для теста в одной локальной сети можно выполнить `cd worker && npm run dev -- --ip 0.0.0.0`, указать в Lampa адрес компьютера вида `http://192.168.1.10:8787` и открыть плагин с локального HTTPS/HTTP-хостинга. На браузерных сборках Lampa HTTPS может блокировать HTTP Worker как mixed content, поэтому Cloudflare deploy является рекомендуемым вариантом.

Готовый изолированный локальный сценарий из корня репозитория:

```bash
# Терминал 1 — Worker
npm run dev:worker:lan

# Терминал 2 — раздача standalone-плагина
npm run serve:plugin
```

Узнайте локальный IP компьютера в настройках сети. В Lampa используйте:

```text
Plugin URL: http://<LAN-IP>:8080/letterboxd-watchlist.js
Worker URL: http://<LAN-IP>:8787
```

Обе команды работают только пока открыты терминалы и ничего не устанавливают глобально.

## Что можно легко добавить дальше

Небольшие доработки без смены архитектуры:

- кнопку «Проверить соединение» и статус Worker в настройках;
- ручное обновление watchlist без перезапуска Lampa;
- локализацию настроек и уведомлений на языки Lampa;
- ограничение количества карточек и выбор позиции строки;
- более подробный диагностический лог несовпавших фильмов;
- настройку concurrency TMDB;
- поддержку нескольких Letterboxd usernames как отдельных строк.

Средние по объёму доработки:

- отображение публичных Letterboxd lists;
- отдельная поддержка сериалов через TMDB TV search;
- прогрессивное появление карточек во время TMDB matching;
- повторные запросы с коротким backoff при временных ошибках Letterboxd/TMDB.

Авторизация Letterboxd, ratings/diary/watched sync и запись обратно в Letterboxd потребуют существенно другой архитектуры и не относятся к лёгким дополнениям.
