# Lampa Letterboxd

Displays a public Letterboxd watchlist and public lists as native content rows in Lampa.

Плагин для Lampa 3.0+: пользователь указывает публичный Letterboxd username и при желании несколько публичных lists. После перезапуска Lampa получает коллекции и показывает каждую отдельной строкой на главной странице. Фильмы и сериалы открываются как обычные карточки Lampa/TMDB.

## Архитектура

```text
Letterboxd → Cloudflare Worker → Lampa plugin → TMDB/Lampa
```

- Один stateless Cloudflare Worker загружает страницы публичного watchlist, list и раздела films, разбирает HTML и возвращает только `title`, `year`, `slug`. Этот же Worker раздает готовый JS-плагин — второй сервер не нужен.
- Lampa-плагин один раз за запуск получает настроенные коллекции и ищет одновременно в секциях TMDB Movie и TV через нативный `Lampa.Api.search`.
- Общая для всех строк очередь ограничивает TMDB concurrency значением `5`; карточки появляются постепенно, не дожидаясь завершения всей коллекции.
- В боковом меню Lampa появляется отдельный пункт `Letterboxd`. Экран показывает Watchlist и настроенные публичные lists с единым фильтром статуса.
- На постерах Letterboxd-экрана и обычных каталогов Lampa выводятся отдельные плашки `Letterboxd ✓` и `Lampa ✓`; если фильм просмотрен в обоих местах, видны обе.
- Временные сетевые ошибки, `429` и `5xx` повторяются до двух раз с коротким backoff. Постоянные ошибки и закрытые коллекции не ретраятся.
- База данных, авторизация, cookies, Letterboxd credentials и постоянный кеш отсутствуют.
- Worker принимает только фиксированные маршруты `GET /watchlist/:username`, `GET /list/:username/:slug` и `GET /watched/:username?page=N`, не принимает произвольные URL и не является HTTP-прокси.

Реализация Lampa API сверена с `yumata/lampa-source` 3.0+ на коммите `d2c3554` от 30 августа 2026 года: используются `SettingsApi`, `ContentRows`, `Api.search`, `Storage`, `Reguest` и `Noty`.

## Требования

- Lampa 3.0+;
- публичный Letterboxd watchlist и/или публичные lists;
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
npm run login
npm run deploy
```

`npm run login` запускает локальный Wrangler и сохраняет его конфигурацию внутри корневого `.cache/xdg-config`. Никакие npm-пакеты глобально не устанавливаются. Вместо браузерного входа можно передать `CLOUDFLARE_API_TOKEN` только процессу deploy.

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
curl http://localhost:8787/list/OWNER/LIST-SLUG
curl 'http://localhost:8787/watched/USERNAME?page=1'
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

Без `API_BASE_URL` сборка использует уже развернутый Worker проекта. Свой адрес Worker можно передать при сборке или ввести непосредственно в `Настройки → Letterboxd → Worker URL`.

Для ручного использования без build-шага можно изменить константу в `plugin/letterboxd-watchlist.js`:

```js
const API_BASE_URL = 'https://lampa-letterboxd-watchlist.<account>.workers.dev'
```

### 3. Установка в Lampa

Если репозиторий публичный, исходный standalone-файл можно подключить напрямую:

```text
https://raw.githubusercontent.com/notix3333/lampabox/main/plugin/letterboxd-watchlist.js
```

В приватном репозитории этот адрес без GitHub-авторизации вернет `404`. Для текущей развернутой версии используйте единый публичный адрес Worker:

```text
https://lampa-letterboxd-watchlist.rexikplay3.workers.dev/letterboxd-watchlist.js?v=1.2.1
```

В этом файле уже указан API того же Worker. Отдельный хостинг или ручная настройка Worker URL для первой проверки не нужны.

Опубликуйте `dist/letterboxd-watchlist.js` по HTTPS, например через GitHub Pages, и получите прямой URL:

```text
https://USERNAME.github.io/REPOSITORY/letterboxd-watchlist.js
```

Добавьте этот URL в Lampa как обычный URL плагина. Затем:

```text
Настройки → Letterboxd → Worker URL → Letterboxd username / Public lists → перезапуск Lampa
```

Поле `Public lists` принимает значения через запятую или с новой строки:

```text
my-favorites
other-user/tv-picks
https://letterboxd.com/official/list/letterboxds-top-500-films/
```

Короткий slug использует username из первого поля. Форматы `owner/slug`, `owner/list/slug` и полный публичный URL работают без основного username. Пустые и повторяющиеся значения игнорируются. Сам username не нужно повторять в `Public lists`: если он введён туда по ошибке, плагин его проигнорирует.

После перезапуска пункт `Letterboxd` появляется в боковом меню рядом с каталогом. На первом экране расположена широкая карточка текущего фильтра. Нажмите её, чтобы выбрать:

- `Все`;
- `Просмотрено` — Letterboxd или Lampa;
- `Не просмотрено` — ни в одном источнике;
- `Просмотрено в Letterboxd`;
- `Просмотрено в Lampa`.

Для статуса Letterboxd используется публичный раздел `https://letterboxd.com/USERNAME/films/`. Если профиль или films закрыты, каталог продолжает работать со статусами Lampa.

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
GET /list/:username/:slug
GET /watched/:username?page=1
```

Успешный ответ:

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

Ответ list дополнительно содержит `"kind": "list"`, `"slug"` и настоящее название списка из Letterboxd.

Watched endpoint возвращает одну страницу за запрос и поля `page`/`nextPage`. Плагин последовательно получает страницы до конца, максимум 100, и хранит набор slug только в памяти текущего запуска.

Ошибки имеют единый формат:

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "Letterboxd user was not found"
  }
}
```

Поддерживаются `INVALID_USERNAME`, `INVALID_LIST`, `INVALID_PAGE`, `USER_NOT_FOUND`, `WATCHLIST_UNAVAILABLE`, `LIST_UNAVAILABLE`, `WATCHED_UNAVAILABLE`, `LETTERBOXD_BLOCKED`, `LETTERBOXD_ERROR`, `PARSER_ERROR`, `INTERNAL_ERROR`. Все API-ответы содержат `Cache-Control: no-store`; CORS разрешает `GET` и `OPTIONS`.

## Поведение и ограничения MVP

- Каждая коллекция загружается один раз за текущий запуск Lampa и не сохраняется между запусками.
- Порядок Letterboxd сохраняется, случайные дубликаты удаляются по `slug`.
- Пагинация ограничена 100 страницами, размер одной HTML-страницы — 2 MiB.
- TMDB Movie и TV проверяются раздельно по `title`/`original_title` и `name`/`original_name`. Совпадение принимается только для точного нормализованного названия и совместимого года; сомнительные варианты пропускаются.
- Строка показывается после первого найденного элемента, а следующие карточки добавляются в нее по мере matching. Исходный порядок Letterboxd при этом сохраняется.
- Letterboxd-статус определяется по публичному films slug, а для обычных каталогов Lampa — по точной паре исходного названия и года. Lampa-статус учитывает явную отметку `Просмотрено`, не менее 90% фильма в Timeline или хотя бы один просмотренный эпизод сериала.
- Каждая полученная страница watched применяется сразу. Если Letterboxd временно блокирует следующую страницу, уже загруженные статусы продолжают работать, а Watchlist и каталог не скрываются.
- Изменение Favorite/Timeline обновляет плашки; при возвращении в каталог фильтр пересчитывается.
- Частичные результаты допустимы: ошибка поиска одного фильма не ломает всю строку.
- Worker не обходит приватность и защиту Letterboxd.

Letterboxd не предоставляет стабильный публичный HTML API для этого сценария, поэтому изменения разметки могут потребовать обновления `worker/src/parser.ts`. Fixture-тесты не обращаются к Letterboxd и остаются детерминированными.

## Нужен ли сервер

Да, между Lampa и Letterboxd нужен HTTP-компонент из-за CORS и необходимости разбирать HTML Letterboxd. Обычный VPS, Docker и постоянно работающий домашний компьютер не нужны: эту роль выполняет небольшой stateless Cloudflare Worker. Для небольших личных коллекций обычно достаточно [бесплатного тарифа Cloudflare Workers](https://developers.cloudflare.com/workers/platform/pricing/); для очень больших lists следует учитывать актуальные лимиты внешних запросов Cloudflare.

Без Worker плагин намеренно не обращается к Letterboxd напрямую и не использует сторонние публичные CORS-прокси.

## Как попробовать текущую версию

1. Удалите старый URL плагина, если он уже был добавлен.
2. Добавьте `https://lampa-letterboxd-watchlist.rexikplay3.workers.dev/letterboxd-watchlist.js?v=1.2.1` в список плагинов Lampa. Параметр версии помогает не использовать старую копию из кеша.
3. В разделе `Настройки → Letterboxd` укажите свой `Letterboxd username` и при желании `Public lists`.
4. Полностью перезапустите Lampa и откройте пункт `Letterboxd` в боковом меню.

Чтобы использовать собственный deployment, выполните `cd worker && npm run login && npm run deploy`; deploy автоматически соберет JS и опубликует его как static asset того же Worker.

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
- ручное обновление коллекций без перезапуска Lampa;
- локализацию настроек и уведомлений на языки Lampa;
- ограничение количества карточек и выбор позиции строки;
- более подробный диагностический лог несовпавших фильмов;
- настройку concurrency TMDB;
- поддержку нескольких Letterboxd usernames как отдельных строк.

Также можно сравнительно изолированно добавить кеширование в Cache API Worker, кнопку принудительного обновления, выбор включенных строк и лимит элементов для очень больших lists.

Авторизация Letterboxd, ratings/diary/watched sync и запись обратно в Letterboxd потребуют существенно другой архитектуры и не относятся к лёгким дополнениям.
