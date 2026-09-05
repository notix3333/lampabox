# Lampa Letterboxd Watchlist

Необходимо разработать минимальный, аккуратный и production-like MVP плагина для Lampa, который отображает публичный Letterboxd Watchlist пользователя отдельной строкой на главной странице Lampa.

Проект должен быть максимально простым.

Главный принцип:

**Letterboxd является источником watchlist, Lampa отвечает за отображение фильмов и их открытие через существующую TMDB-интеграцию.**

---

# 1. Цель проекта

Пользователь устанавливает плагин в Lampa, вводит свой Letterboxd username и после этого видит на главной странице Lampa строку:

`Letterboxd Watchlist`

с фильмами из:

`https://letterboxd.com/{username}/watchlist/`

При каждом новом запуске приложения Lampa watchlist необходимо получать заново.

Не требуется синхронизация в обратную сторону.

---

# 2. Scope MVP

Необходимо реализовать только:

1. Настройку `Letterboxd username` в Lampa.
2. Получение публичного watchlist Letterboxd.
3. Поддержку пагинации Letterboxd.
4. Преобразование элементов watchlist в фильмы TMDB.
5. Строку `Letterboxd Watchlist` на главной странице Lampa.
6. Возможность открыть фильм как обычный фильм Lampa.
7. Повторное получение актуального watchlist при каждом запуске Lampa.
8. Нормальную обработку ошибок.

---

# 3. Что НЕ входит в MVP

Не реализовывать:

- Letterboxd login;
- Letterboxd OAuth;
- запись данных в Letterboxd;
- watched sync;
- ratings sync;
- diary;
- likes;
- Letterboxd lists;
- рекомендации;
- AI;
- пользовательские аккаунты;
- PostgreSQL;
- SQLite;
- Redis;
- Docker;
- VPS;
- постоянное хранение watchlist;
- cron;
- background sync;
- аналитику;
- административную панель.

Не усложнять архитектуру без необходимости.

---

# 4. Архитектура

Использовать два независимых компонента:

```text
┌────────────────────┐
│       Lampa        │
│                    │
│   plugin.js        │
└─────────┬──────────┘
          │
          │ GET
          ▼
┌────────────────────┐
│ Cloudflare Worker  │
│                    │
│ Letterboxd parser  │
└─────────┬──────────┘
          │
          │ HTTP
          ▼
┌────────────────────┐
│    Letterboxd      │
│                    │
│ /user/watchlist/   │
└────────────────────┘
```

TMDB matching происходит на стороне Lampa:

```text
Letterboxd
    ↓
Worker
    ↓
title + year
    ↓
Lampa plugin
    ↓
Lampa TMDB search
    ↓
native Lampa movie object
    ↓
Lampa card
```

---

# 5. Почему нужен Worker

Lampa не должна напрямую парсить Letterboxd.

Worker нужен для:

- обхода CORS-ограничений;
- получения HTML Letterboxd;
- парсинга watchlist;
- обработки пагинации;
- возврата простого JSON.

Worker должен быть stateless.

Не использовать БД.

---

# 6. Структура проекта

Создать примерно такую структуру:

```text
lampa-letterboxd-watchlist/
│
├── README.md
├── .gitignore
│
├── plugin/
│   └── letterboxd-watchlist.js
│
└── worker/
    ├── package.json
    ├── tsconfig.json
    ├── wrangler.jsonc
    │
    ├── src/
    │   ├── index.ts
    │   ├── letterboxd.ts
    │   ├── parser.ts
    │   └── types.ts
    │
    └── test/
        ├── parser.test.ts
        └── fixtures/
            ├── watchlist-page.html
            └── empty-watchlist.html
```

Не создавать лишние abstraction layers.

---

# 7. Cloudflare Worker

Worker должен предоставить endpoint:

```http
GET /watchlist/:username
```

Пример:

```http
GET /watchlist/nikolai123
```

Ответ:

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
    },
    {
      "title": "Anora",
      "year": 2024,
      "slug": "anora"
    }
  ]
}
```

---

# 8. Letterboxd URL

Worker сам формирует URL.

Первоначальный запрос:

```text
https://letterboxd.com/{username}/watchlist/
```

Следующие страницы:

```text
https://letterboxd.com/{username}/watchlist/page/2/
https://letterboxd.com/{username}/watchlist/page/3/
...
```

Не принимать произвольный Letterboxd URL через API.

Endpoint должен принимать только username.

Это важно, чтобы Worker случайно не превратился в публичный HTTP proxy.

---

# 9. Парсинг Letterboxd

Парсер должен извлекать минимум:

```ts
interface LetterboxdFilm {
    title: string
    year: number | null
    slug: string
}
```

Не завязываться сильнее необходимого на конкретную HTML-разметку.

Приоритет для получения данных:

1. semantic/data attributes;
2. ссылки на `/film/.../`;
3. title/alt metadata;
4. CSS-классы — только когда другого варианта нет.

Функцию парсинга держать отдельно:

```text
parser.ts
```

Она должна принимать HTML как строку и возвращать:

```ts
LetterboxdFilm[]
```

Парсер не должен сам делать HTTP-запросы.

---

# 10. Pagination

Необходимо загрузить весь watchlist, а не только первую страницу.

Алгоритм:

```text
page = 1

while page exists:
    fetch page
    parse films
    append films

    if next page doesn't exist:
        break

    page += 1
```

Добавить защитный предел, например:

```text
MAX_PAGES = 100
```

чтобы ошибка HTML-парсинга не вызвала бесконечный цикл.

Сохранять исходный порядок Letterboxd.

Удалять случайные дубликаты по `slug`.

---

# 11. Worker caching

Watchlist должен быть свежим при каждом новом запуске Lampa.

Поэтому API Worker не должен отдавать долговременно закешированный результат.

Ответ:

```http
Cache-Control: no-store
```

Никакой собственной persistent cache в MVP не делать.

---

# 12. CORS Worker

Worker должен разрешать запросы от Lampa.

Минимально:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, OPTIONS
```

Поддержать `OPTIONS`.

Другие HTTP-методы не требуются.

---

# 13. Error API

Ошибки возвращать в едином формате:

```json
{
  "error": {
    "code": "USER_NOT_FOUND",
    "message": "Letterboxd user was not found"
  }
}
```

Поддержать как минимум:

```text
INVALID_USERNAME
USER_NOT_FOUND
WATCHLIST_UNAVAILABLE
LETTERBOXD_BLOCKED
LETTERBOXD_ERROR
PARSER_ERROR
INTERNAL_ERROR
```

HTTP status должны быть адекватными:

```text
400 — invalid username
404 — user/watchlist not found
502 — Letterboxd upstream problem
500 — unexpected internal error
```

---

# 14. Private watchlist

Если watchlist пользователя приватный и Worker не может его получить:

не пытаться обходить приватность.

Вернуть:

```text
WATCHLIST_UNAVAILABLE
```

Плагин Lampa должен показать понятное уведомление:

```text
Не удалось получить Letterboxd Watchlist.
Проверьте username и доступность watchlist.
```

---

# 15. Cloudflare protection Letterboxd

Letterboxd может блокировать автоматические запросы.

Архитектура должна учитывать это.

Всю сетевую работу с Letterboxd держать внутри:

```ts
fetchLetterboxdPage(...)
```

Нельзя смешивать HTTP-запросы с HTML parsing.

Таким образом транспорт позже можно будет заменить без переписывания приложения.

Для MVP:

- использовать обычный `fetch`;
- корректный User-Agent;
- Accept headers;
- redirect handling;
- определить HTTP 403/429;
- вернуть `LETTERBOXD_BLOCKED`.

Не добавлять FlareSolverr, browser automation и другие тяжёлые обходные решения в MVP.

---

# 16. Lampa plugin

Файл:

```text
plugin/letterboxd-watchlist.js
```

В production это должен быть самостоятельный JS-файл, который можно подключить в Lampa как обычный plugin URL.

Не использовать React/Vue.

Использовать native Lampa API.

Целевая версия:

```text
Lampa 3.0+
```

---

# 17. Настройки Lampa

Добавить отдельный компонент настроек:

```text
Letterboxd
```

Внутри:

```text
Letterboxd username
[________________]
```

Хранить username через:

```text
Lampa.Storage
```

Например ключ:

```text
letterboxd_watchlist_username
```

Не хранить пароль, cookie или Letterboxd session.

---

# 18. Поведение без username

Если username отсутствует:

- не отправлять запрос к Worker;
- не показывать пустую строку на главной;
- никаких ошибок при запуске.

Пользователь просто может открыть:

```text
Настройки → Letterboxd
```

и ввести username.

---

# 19. Загрузка при запуске

При старте приложения:

```text
Lampa ready
    ↓
read username
    ↓
fetch Worker
    ↓
receive Letterboxd films
    ↓
resolve TMDB
    ↓
prepare row
```

Очень важно:

watchlist должен загружаться **один раз на один запуск приложения**.

Если Lampa несколько раз вызывает callback главного экрана, нельзя заново обращаться к Letterboxd каждый раз.

Использовать in-memory Promise/state:

```text
sessionWatchlistPromise
```

То есть:

```text
новый запуск Lampa
→ новый HTTP request

переход главная → фильм → главная
→ использовать результат текущей сессии
```

Никакого persistent cache.

После полного перезапуска Lampa всё загружается заново.

---

# 20. Добавление строки

Для Lampa 3.0+ использовать:

```text
Lampa.ContentRows.add(...)
```

Строка:

```text
Letterboxd Watchlist
```

Показывается только:

```text
screen: main
```

Не внедрять её во все категории.

---

# 21. TMDB matching

Worker не должен знать ничего про TMDB.

Worker возвращает:

```text
title
year
slug
```

Плагин Lampa использует native TMDB/search API Lampa.

Перед реализацией Codex должен проверить актуальную сигнатуру:

```text
Lampa.Api.search
```

в текущем исходном коде Lampa 3.0+.

Не придумывать сигнатуру API по памяти.

---

# 22. Matching algorithm

Для каждого Letterboxd фильма:

```text
title + year
    ↓
TMDB search
    ↓
best matching movie
```

Приоритет:

```text
1. exact normalized title + exact year
2. original_title exact + exact year
3. exact title + year difference <= 1
```

Если надёжного match нет:

```text
skip movie
```

Лучше пропустить фильм, чем открыть неправильный.

---

# 23. Title normalization

Сделать маленькую функцию:

```text
normalizeTitle()
```

Она может:

- trim;
- lowercase;
- схлопывать повторные пробелы;
- Unicode normalize.

Не делать fuzzy matching со сложными библиотеками.

Не добавлять Levenshtein dependency.

---

# 24. TMDB concurrency

Не отправлять сотни TMDB запросов одновременно.

Использовать ограничение concurrency:

```text
4–6 requests
```

Например:

```text
MAX_TMDB_CONCURRENCY = 5
```

При этом результат должен сохранить порядок Letterboxd watchlist.

---

# 25. Результаты TMDB

После matching необходимо получить native объекты, которые Lampa уже умеет отображать.

Каждый результат должен иметь корректный:

```text
source: "tmdb"
```

Не создавать собственный экран фильма.

При выборе карточки должен открываться стандартный экран фильма Lampa.

Это ключевой принцип:

**плагин добавляет только источник списка, но не заменяет интерфейс Lampa.**

---

# 26. UX

В идеальном состоянии пользователь видит:

```text
Главная

Продолжить просмотр
...

Letterboxd Watchlist

[poster]
Dune: Part Two

[poster]
Anora

[poster]
Aftersun
```

Карточки должны выглядеть как обычные карточки Lampa.

Никакого отдельного дизайна Letterboxd для MVP не требуется.

---

# 27. Loading state

Плагин не должен блокировать запуск Lampa.

Если watchlist ещё загружается:

- Lampa продолжает работать;
- строка появляется после получения данных или callback возвращает результат, когда данные готовы;
- глобального fullscreen loader не требуется.

---

# 28. Error handling Lampa

Ошибки не должны ломать главную страницу.

Использовать:

```text
Lampa.Noty
```

Но не спамить уведомлениями.

Максимум одно уведомление за запуск при ошибке Letterboxd.

Например:

```text
Letterboxd: пользователь не найден
```

или:

```text
Letterboxd Watchlist временно недоступен
```

---

# 29. Logging

Добавить минимальный лог helper:

```js
log(...)
```

Prefix:

```text
[Letterboxd Watchlist]
```

Логировать:

```text
plugin initialized
username
watchlist received: N
TMDB matched: X/N
errors
```

Не логировать HTML целиком.

---

# 30. Worker tests

Минимальные unit tests обязательны.

Проверить:

### parser

HTML с несколькими фильмами:

```text
→ правильный title
→ year
→ slug
```

### empty watchlist

```text
→ []
```

### duplicates

```text
→ один фильм
```

### invalid HTML

```text
→ controlled parser error
```

Не делать end-to-end тесты самого Letterboxd, которые зависят от сети.

Использовать HTML fixtures.

---

# 31. Plugin automated testing

Для MVP полноценный UI test framework для Lampa не нужен.

Но чистые функции писать так, чтобы их можно было проверить отдельно:

```text
normalizeTitle()
pickBestTmdbResult()
```

Основную Lampa-интеграцию оставить небольшой.

---

# 32. README

README должен содержать:

## Что делает проект

```text
Displays a public Letterboxd watchlist as a native content row in Lampa.
```

## Architecture

```text
Letterboxd → Cloudflare Worker → Lampa plugin → TMDB/Lampa
```

## Requirements

```text
Lampa 3.0+
public Letterboxd watchlist
Cloudflare Worker
```

## Worker deployment

```bash
cd worker
npm install
npm test
npx wrangler deploy
```

## Plugin configuration

Указать:

```js
const API_BASE_URL = 'https://...workers.dev'
```

## Installation

Объяснить, как получить URL:

```text
https://example.com/letterboxd-watchlist.js
```

и установить его как Lampa plugin.

## Usage

```text
Settings
→ Letterboxd
→ Letterboxd username
→ restart Lampa
```

---

# 33. Constants

Не разбрасывать magic values.

Например:

```text
PLUGIN_NAME
PLUGIN_VERSION
STORAGE_USERNAME
API_BASE_URL
MAX_LETTERBOXD_PAGES
MAX_TMDB_CONCURRENCY
```

---

# 34. Coding style

Worker:

```text
TypeScript
```

Plugin:

```text
Vanilla JavaScript
```

Требования:

- небольшие функции;
- понятные имена;
- минимум side effects;
- early return;
- никаких огромных функций на 300 строк;
- никаких ненужных classes;
- никаких dependencies ради простых операций.

Для HTML parsing Worker можно использовать небольшую подходящую библиотеку, если стандартных средств Cloudflare Workers недостаточно.

Не использовать полноценный browser engine.

---

# 35. Security

Worker:

- принимает только username;
- не принимает URL;
- не проксирует произвольные домены;
- URL Letterboxd формирует самостоятельно;
- encode username;
- запрещает path traversal;
- ограничивает количество страниц;
- ограничивает размер обрабатываемого ответа, если это разумно;
- не хранит пользовательские данные.

---

# 36. Privacy

Никаких credentials Letterboxd.

Никаких cookies пользователя.

Никакой авторизации.

Используются только данные публичного watchlist.

---

# 37. Performance

Основные ограничения:

Letterboxd pages:

```text
последовательно
```

TMDB matching:

```text
parallel with concurrency limit
```

Нельзя:

```text
Promise.all(500 TMDB requests)
```

Использовать очередь / worker pool.

---

# 38. Graceful partial results

Например watchlist содержит:

```text
100 фильмов
```

а TMDB удалось определить:

```text
96
```

Показываем 96.

Не считать весь запрос ошибкой из-за четырёх unmatched фильмов.

В console:

```text
TMDB matched 96/100
```

---

# 39. Empty watchlist

Если Letterboxd watchlist действительно пуст:

```text
films: []
```

Это не ошибка.

На главной строку можно:

- не отображать вообще.

Не показывать пользователю error notification.

---

# 40. Definition of Done

MVP считается готовым, если работает следующий сценарий.

### Scenario 1

Пользователь устанавливает plugin.

Заходит:

```text
Настройки → Letterboxd
```

Вводит:

```text
myusername
```

Перезапускает Lampa.

Получает:

```text
Letterboxd Watchlist
```

на главной.

---

### Scenario 2

В watchlist Letterboxd:

```text
Dune: Part Two
Anora
Aftersun
```

В Lampa появляются эти фильмы.

Нажатие:

```text
Anora
```

открывает стандартную карточку Anora в Lampa.

---

### Scenario 3

Пользователь добавляет новый фильм в Letterboxd.

Во время текущей сессии ничего делать не требуется.

После полного нового запуска Lampa:

```text
Worker запрашивается заново
```

и новый фильм появляется.

---

### Scenario 4

Пользователь удаляет фильм из Letterboxd.

После следующего запуска Lampa фильм исчезает из строки.

---

### Scenario 5

Letterboxd недоступен.

Lampa продолжает нормально работать.

Плагин просто не показывает строку и сообщает одну понятную ошибку.

---

# 41. Главный data flow

Финальный поток должен быть таким:

```text
Lampa App Ready
       │
       ▼
Lampa.Storage
       │
       ▼
Letterboxd username
       │
       ▼
GET Worker /watchlist/{username}
       │
       ▼
Worker
       │
       ├── fetch page 1
       ├── fetch page 2
       ├── ...
       │
       ▼
LetterboxdFilm[]
       │
       ▼
JSON response
       │
       ▼
Lampa plugin
       │
       ▼
TMDB search
       │
       ▼
native TMDB movie objects
       │
       ▼
Lampa.ContentRows
       │
       ▼
"Letterboxd Watchlist"
```

---

# 42. Implementation order

Codex должен реализовывать проект в таком порядке.

## Step 1

Создать структуру проекта.

## Step 2

Реализовать Letterboxd HTML parser.

## Step 3

Написать parser unit tests.

Убедиться, что они проходят.

## Step 4

Реализовать pagination/fetch layer.

## Step 5

Реализовать Worker endpoint.

## Step 6

Проверить Worker локально через Wrangler.

## Step 7

Создать минимальный Lampa plugin.

## Step 8

Добавить Letterboxd settings.

## Step 9

Добавить `Lampa.ContentRows`.

## Step 10

Интегрировать Worker.

## Step 11

Интегрировать native TMDB search Lampa.

## Step 12

Добавить matching + concurrency limit.

## Step 13

Добавить error handling.

## Step 14

Написать README.

---

# 43. Очень важные ограничения для Codex

Перед использованием Lampa API изучить текущий исходный код Lampa 3.0+.

Особенно проверить:

```text
Lampa.ContentRows.add
Lampa.Api.search
Lampa.SettingsApi.addComponent
Lampa.SettingsApi.addParam
Lampa.Storage
Lampa.Noty
Lampa.Activity / native card navigation
```

Не выдумывать сигнатуры.

Не использовать устаревшие API, если в Lampa 3.0 существует актуальная замена.

---

# 44. Архитектурный принцип

Не пытаться сделать универсальный Letterboxd SDK.

Не пытаться сделать полноценную синхронизацию.

Нам нужен только:

```text
public username
       ↓
public watchlist
       ↓
Lampa row
```

Всё остальное находится вне scope.

---

# 45. Итоговый MVP

После завершения должно существовать всего два runtime-компонента:

```text
letterboxd-watchlist.js
```

и

```text
Cloudflare Worker
```

При этом отсутствуют:

```text
database
authentication
persistent backend state
Letterboxd credentials
TMDB credentials пользователя
background jobs
```

Проект должен оставаться достаточно простым, чтобы его архитектуру можно было понять за несколько минут.

Сначала реализовать рабочий MVP согласно этому документу.

После завершения MVP не добавлять новые функции без отдельного требования.