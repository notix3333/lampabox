<p align="center">
  <img src="logo.png" alt="LampaBox" width="300">
</p>

Плагин для Lampa 3.0+, который добавляет публичные коллекции Letterboxd в интерфейс Lampa и сопоставляет фильмы и сериалы с TMDB.

## Demo 

![Demo](demo.gif)

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
3. Укажите **публичный** Letterboxd username.
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
