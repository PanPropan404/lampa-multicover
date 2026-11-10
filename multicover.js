/*
 * MultiCover — плагин для Lampa
 * Собирает обложки, фоны и рейтинги из нескольких источников:
 *   TMDB, Fanart.tv, Kinopoisk (unofficial API), OMDb, TVMaze
 * Подключение: Настройки → Расширения → добавить URL до этого файла.
 */
(function () {
  'use strict';

  var ID = 'multicover';
  if (window['plugin_' + ID + '_ready']) return;
  window['plugin_' + ID + '_ready'] = true;

  var TIMEOUT = 8000;
  var CACHE_KEY = 'mc_cache_v1';
  var CACHE_TTL = 3 * 24 * 3600 * 1000;
  var CACHE_LIMIT = 60;
  var DEFAULT_ORDER = 'fanart,kinopoisk,tmdb,omdb,tvmaze';

  /* ---------- утилиты ---------- */

  function opt(name, def) {
    var v = Lampa.Storage.get('mc_' + name, def);
    return v === undefined || v === null ? def : v;
  }

  function getJSON(url, headers) {
    return new Promise(function (resolve, reject) {
      var net = new Lampa.Reguest();
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { net.clear(); } catch (e) {}
        reject(new Error('timeout'));
      }, TIMEOUT);

      net.silent(url, function (json) {
        if (done) return;
        done = true; clearTimeout(timer);
        resolve(json);
      }, function () {
        if (done) return;
        done = true; clearTimeout(timer);
        reject(new Error('http'));
      }, false, { headers: headers || {}, timeout: TIMEOUT });
    });
  }

  function tmdbApi(path) {
    return Lampa.TMDB.api(path);
  }

  function tmdbImg(path, size) {
    return 'https://image.tmdb.org/t/p/' + size + path;
  }

  function loadCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch (e) { return {}; }
  }

  function saveCache(cache) {
    try {
      var keys = Object.keys(cache);
      if (keys.length > CACHE_LIMIT) {
        keys.sort(function (a, b) { return cache[a].t - cache[b].t; });
        keys.slice(0, keys.length - CACHE_LIMIT).forEach(function (k) { delete cache[k]; });
      }
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
  }

  function langRank(l) {
    return l === 'ru' ? 0 : l === 'en' ? 1 : 2;
  }

  /* ---------- контекст: определяем id во всех базах ---------- */

  function buildContext(movie) {
    var isTv = !!(movie.name || movie.number_of_seasons || movie.first_air_date);
    var type = isTv ? 'tv' : 'movie';
    var ctx = {
      movie: movie,
      type: type,
      tmdbId: movie.id,
      imdbId: movie.imdb_id || (movie.external_ids && movie.external_ids.imdb_id) || '',
      tvdbId: (movie.external_ids && movie.external_ids.tvdb_id) || ''
    };

    if (ctx.imdbId && (!isTv || ctx.tvdbId)) return Promise.resolve(ctx);

    return getJSON(tmdbApi(type + '/' + movie.id + '/external_ids')).then(function (ext) {
      ctx.imdbId = ctx.imdbId || ext.imdb_id || '';
      ctx.tvdbId = ctx.tvdbId || ext.tvdb_id || '';
      return ctx;
    }).catch(function () { return ctx; });
  }

  /* ---------- провайдеры ----------
   * Каждый возвращает {posters:[], backdrops:[], ratings:[]} или null.
   * poster/backdrop: { src, preview, lang, w, h, score }
   */

  var providers = {

    tmdb: {
      title: 'TMDB',
      run: function (ctx) {
        var url = tmdbApi(ctx.type + '/' + ctx.tmdbId + '/images?include_image_language=ru,en,null');
        return getJSON(url).then(function (j) {
          function map(arr, big, small) {
            return (arr || []).map(function (i) {
              return {
                src: tmdbImg(i.file_path, big), preview: tmdbImg(i.file_path, small),
                lang: i.iso_639_1 || 'xx', w: i.width, h: i.height, score: i.vote_average || 0
              };
            });
          }
          var m = ctx.movie;
          var ratings = [];
          if (m.vote_average) ratings.push({ source: 'TMDB', value: Number(m.vote_average).toFixed(1) });
          return { posters: map(j.posters, 'w780', 'w185'), backdrops: map(j.backdrops, 'w1280', 'w300'), ratings: ratings };
        });
      }
    },

    fanart: {
      title: 'Fanart.tv',
      run: function (ctx) {
        var key = opt('fanart_key', '');
        if (!key) return Promise.resolve(null);
        var id = ctx.type === 'tv' ? ctx.tvdbId : ctx.tmdbId;
        if (!id) return Promise.resolve(null);
        var url = 'https://webservice.fanart.tv/v3/' + ctx.type + '/' + id + '?api_key=' + encodeURIComponent(key);
        return getJSON(url).then(function (j) {
          function map(arr) {
            return (arr || []).map(function (i) {
              return {
                src: i.url, preview: i.url.replace('/fanart/', '/preview/'),
                lang: i.lang || 'xx', score: parseInt(i.likes, 10) || 0
              };
            });
          }
          return {
            posters: map(ctx.type === 'tv' ? j.tvposter : j.movieposter),
            backdrops: map(ctx.type === 'tv' ? j.showbackground : j.moviebackground),
            ratings: []
          };
        });
      }
    },

    kinopoisk: {
      title: 'Кинопоиск',
      run: function (ctx) {
        var key = opt('kp_key', '');
        if (!key || !ctx.imdbId) return Promise.resolve(null);
        var h = { 'X-API-KEY': key };
        var base = 'https://kinopoiskapiunofficial.tech/api/v2.2/';
        return getJSON(base + 'films?imdbId=' + ctx.imdbId, h).then(function (s) {
          var f = s && s.items && s.items[0];
          if (!f) return null;
          var out = { posters: [], backdrops: [], ratings: [] };
          if (f.ratingKinopoisk) out.ratings.push({ source: 'KP', value: Number(f.ratingKinopoisk).toFixed(1) });
          if (f.posterUrl) out.posters.push({ src: f.posterUrl, preview: f.posterUrlPreview || f.posterUrl, lang: 'ru', score: 5 });

          function imgs(kind, bucket) {
            return getJSON(base + 'films/' + f.kinopoiskId + '/images?type=' + kind + '&page=1', h).then(function (r) {
              (r.items || []).forEach(function (i) {
                out[bucket].push({ src: i.imageUrl, preview: i.previewUrl, lang: 'ru', score: 0 });
              });
            }).catch(function () {});
          }
          if (ctx.light) return out; // для карточек в каталоге хватает основного постера
          return Promise.all([imgs('POSTER', 'posters'), imgs('STILL', 'backdrops')]).then(function () { return out; });
        });
      }
    },

    omdb: {
      title: 'OMDb',
      run: function (ctx) {
        var key = opt('omdb_key', '');
        if (!key || !ctx.imdbId) return Promise.resolve(null);
        return getJSON('https://www.omdbapi.com/?i=' + ctx.imdbId + '&apikey=' + encodeURIComponent(key)).then(function (j) {
          if (!j || j.Response === 'False') return null;
          var out = { posters: [], backdrops: [], ratings: [] };
          if (j.Poster && j.Poster !== 'N/A') out.posters.push({ src: j.Poster, preview: j.Poster, lang: 'en', score: 1 });
          if (j.imdbRating && j.imdbRating !== 'N/A') out.ratings.push({ source: 'IMDb', value: j.imdbRating });
          (j.Ratings || []).forEach(function (r) {
            if (r.Source === 'Rotten Tomatoes') out.ratings.push({ source: 'RT', value: r.Value });
            if (r.Source === 'Metacritic') out.ratings.push({ source: 'MC', value: r.Value.split('/')[0] });
          });
          return out;
        });
      }
    },

    tvmaze: {
      title: 'TVMaze',
      run: function (ctx) {
        if (ctx.type !== 'tv' || !ctx.imdbId) return Promise.resolve(null);
        return getJSON('https://api.tvmaze.com/lookup/shows?imdb=' + ctx.imdbId).then(function (j) {
          if (!j) return null;
          var out = { posters: [], backdrops: [], ratings: [] };
          if (j.image && j.image.original) out.posters.push({ src: j.image.original, preview: j.image.medium || j.image.original, lang: 'en', score: 1 });
          if (j.rating && j.rating.average) out.ratings.push({ source: 'TVMaze', value: Number(j.rating.average).toFixed(1) });
          return out;
        });
      }
    }
  };

  /* ---------- агрегатор ---------- */

  function collect(movie) {
    var ckey = (movie.name ? 'tv' : 'movie') + '_' + movie.id;
    var cache = loadCache();
    if (cache[ckey] && Date.now() - cache[ckey].t < CACHE_TTL) return Promise.resolve(cache[ckey].d);

    var order = String(opt('order', DEFAULT_ORDER)).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return providers[s]; });
    if (!order.length) order = DEFAULT_ORDER.split(',');

    return buildContext(movie).then(function (ctx) {
      return Promise.all(order.map(function (name) {
        if (opt('use_' + name, true) === false) return Promise.resolve(null);
        return providers[name].run(ctx).then(function (r) { return { name: name, data: r }; }).catch(function () { return null; });
      }));
    }).then(function (results) {
      var res = { posters: [], backdrops: [], ratings: [] };

      results.forEach(function (r, idx) {
        if (!r || !r.data) return;
        var title = providers[r.name].title;
        ['posters', 'backdrops'].forEach(function (k) {
          (r.data[k] || []).forEach(function (i) {
            if (!i.src) return;
            i.source = title; i.prio = idx;
            res[k].push(i);
          });
        });
        (r.data.ratings || []).forEach(function (x) { res.ratings.push(x); });
      });

      ['posters', 'backdrops'].forEach(function (k) {
        // порядок источников → язык (ru, en, без текста) → оценка
        res[k].sort(function (a, b) {
          return a.prio - b.prio || langRank(a.lang) - langRank(b.lang) || b.score - a.score;
        });
      });

      cache[ckey] = { t: Date.now(), d: res };
      saveCache(cache);
      return res;
    });
  }

  /* ---------- интерфейс ---------- */

  function pickKey(movie) { return 'mc_pick_' + (movie.name ? 'tv' : 'movie') + '_' + movie.id; }

  function setPoster(render, src) {
    var img = render.find('.full-start-new__poster img, .full-start__poster img, .full--poster');
    if (img.length) img.attr('src', src);
  }

  function addRatings(render, ratings) {
    var line = render.find('.full-start-new__rate-line, .full-start__rate-line').first();
    if (!line.length) return;
    ratings.forEach(function (r) {
      var cls = 'rate--mc-' + r.source.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (line.find('.' + cls).length) return;
      // если Lampa уже вывела такой же рейтинг — не дублируем
      if (r.source === 'TMDB' || r.source === 'IMDb') {
        if (line.find('.rate--' + r.source.toLowerCase()).length) return;
      }
      line.append('<div class="full-start__rate ' + cls + '"><div>' + r.value + '</div><div>' + r.source + '</div></div>');
    });
  }

  function openPicker(render, movie, res) {
    var items = res.posters.map(function (p, i) {
      var size = p.w ? ' · ' + p.w + '×' + p.h : '';
      return { title: p.source + size + ' · ' + p.lang, index: i };
    });
    if (!items.length) return Lampa.Noty.show('Обложки не найдены');

    var back = Lampa.Controller.enabled().name;
    Lampa.Select.show({
      title: 'Обложки (' + items.length + ')',
      items: items,
      onSelect: function (a) {
        var p = res.posters[a.index];
        Lampa.Storage.set(pickKey(movie), p.src);
        setPoster(render, p.src);
        Lampa.Controller.toggle(back);
      },
      onBack: function () { Lampa.Controller.toggle(back); }
    });
  }

  function addButton(render, movie, res) {
    if (render.find('.view--multicover').length) return;
    var btn = $('<div class="full-start__button selector view--multicover"><span>Обложки</span></div>');
    btn.on('hover:enter', function () { openPicker(render, movie, res); });
    var box = render.find('.full-start-new__buttons, .full-start__buttons').first();
    if (box.length) box.append(btn);
  }

  function apply(render, movie, res) {
    var saved = Lampa.Storage.get(pickKey(movie), '');
    var best = saved || (res.posters[0] && res.posters[0].src);
    if (best && opt('replace_poster', true)) setPoster(render, best);

    if (res.backdrops[0] && opt('replace_bg', false)) {
      try { Lampa.Background.change(res.backdrops[0].src); } catch (e) {}
    }

    addRatings(render, res.ratings);
    addButton(render, movie, res);
  }

  /* ---------- каталог и ленты ----------
   * Карточки подхватываются через MutationObserver, обрабатываются только когда
   * попадают в зону видимости, через очередь (макс. 3 одновременных запроса).
   * В лёгком режиме источники опрашиваются по очереди и останавливаемся на первом
   * найденном постере — так запросов на карточку минимум.
   */

  function parseOrder(str, fallback) {
    var list = String(str || fallback).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return providers[s]; });
    return list.length ? list : fallback.split(',');
  }

  var cardCache = (function () {
    try { return JSON.parse(localStorage.getItem('mc_cards_v1') || '{}'); } catch (e) { return {}; }
  })();
  var cardSaveTimer;

  function saveCards() {
    clearTimeout(cardSaveTimer);
    cardSaveTimer = setTimeout(function () {
      try {
        var keys = Object.keys(cardCache);
        if (keys.length > 500) {
          keys.sort(function (a, b) { return cardCache[a].t - cardCache[b].t; });
          keys.slice(0, keys.length - 500).forEach(function (k) { delete cardCache[k]; });
        }
        localStorage.setItem('mc_cards_v1', JSON.stringify(cardCache));
      } catch (e) {}
    }, 2000);
  }

  function lightContext(movie, order) {
    var isTv = !!(movie.name || movie.number_of_seasons || movie.first_air_date);
    var needIds = order.some(function (n) {
      return n === 'kinopoisk' || n === 'omdb' || n === 'tvmaze' || (n === 'fanart' && isTv);
    });
    if (needIds) {
      return buildContext(movie).then(function (c) { c.light = true; return c; });
    }
    return Promise.resolve({
      movie: movie, type: isTv ? 'tv' : 'movie', tmdbId: movie.id,
      imdbId: movie.imdb_id || '', tvdbId: '', light: true
    });
  }

  function collectLight(movie) {
    var picked = Lampa.Storage.get(pickKey(movie), '');
    if (picked) return Promise.resolve(picked);

    var ck = (movie.name ? 'tv' : 'movie') + '_' + movie.id;
    var hit = cardCache[ck];
    if (hit && Date.now() - hit.t < CACHE_TTL) return Promise.resolve(hit.s);

    var order = parseOrder(opt('card_order', 'fanart,tmdb'), 'fanart,tmdb');

    return lightContext(movie, order).then(function (ctx) {
      var i = 0;
      function next() {
        if (i >= order.length) return null;
        var name = order[i++];
        if (opt('use_' + name, true) === false) return next();
        return providers[name].run(ctx).then(function (r) {
          var list = (r && r.posters) || [];
          if (!list.length) return next();
          list.sort(function (a, b) { return langRank(a.lang) - langRank(b.lang) || b.score - a.score; });
          return list[0].src;
        }).catch(function () { return next(); });
      }
      return next();
    }).then(function (src) {
      // пустой результат помним только ~1 час, чтобы потом попробовать снова
      cardCache[ck] = { t: src ? Date.now() : Date.now() - CACHE_TTL + 3600 * 1000, s: src || '' };
      saveCards();
      return src;
    });
  }

  // простая очередь: не более 3 одновременных задач
  var queue = [], active = 0, MAX_ACTIVE = 3;
  function enqueue(job) {
    queue.push(job);
    pump();
  }
  function pump() {
    while (active < MAX_ACTIVE && queue.length) {
      active++;
      queue.shift()().then(release, release);
    }
  }
  function release() { active--; pump(); }

  function cardData(el) {
    var d = el.card_data || null;
    if (!d && window.$) {
      var $el = $(el);
      d = $el.data('card') || $el.data('item') || $el.data('data') || null;
    }
    return d;
  }

  function isMedia(d) {
    return !!(d && d.id && (d.title || d.name) && !d.known_for_department && !d.cast &&
      (d.release_date || d.first_air_date || d.poster_path));
  }

  function swapImg(img, src) {
    if (img.getAttribute('data-mc-src') === src) return;
    var pre = new Image();
    pre.onload = function () {
      img.setAttribute('data-mc-src', src);
      img.setAttribute('src', src);
      if (!img.__mcGuard) {
        img.__mcGuard = true;
        // если Lampa потом сама перезапишет src (ленивая загрузка) — возвращаем нашу обложку
        img.addEventListener('load', function () {
          var want = img.getAttribute('data-mc-src');
          if (want && img.getAttribute('src') !== want) img.setAttribute('src', want);
        });
      }
    };
    pre.src = src; // если не загрузилась — остаётся оригинальная обложка
  }

  var warned = false;

  function processCard(el) {
    var data = cardData(el);
    if (!data) {
      if (!warned) { warned = true; try { console.log('[MultiCover] не найдены данные карточки', el); } catch (e) {} }
      return;
    }
    if (!isMedia(data)) return;

    var img = el.querySelector('.card__img');
    if (!img) return;

    enqueue(function () {
      if (!document.body.contains(el)) return Promise.resolve(); // карточку уже убрали
      return collectLight(data).then(function (src) {
        if (src) swapImg(img, src);
      }).catch(function () {});
    });
  }

  function initCards() {
    var io = ('IntersectionObserver' in window)
      ? new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) { io.unobserve(en.target); processCard(en.target); }
          });
        }, { rootMargin: '400px' })
      : null;

    function handle(el) {
      if (el.getAttribute('data-mc')) return;
      el.setAttribute('data-mc', '1');
      if (io) io.observe(el); else processCard(el);
    }

    function scan(root) {
      if (root.matches && root.matches('.card')) handle(root);
      if (root.querySelectorAll) {
        var list = root.querySelectorAll('.card:not([data-mc])');
        for (var i = 0; i < list.length; i++) handle(list[i]);
      }
    }

    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        for (var i = 0; i < m.addedNodes.length; i++) {
          if (m.addedNodes[i].nodeType === 1) scan(m.addedNodes[i]);
        }
      });
    }).observe(document.body, { childList: true, subtree: true });

    scan(document.body);
  }

  /* ---------- настройки ---------- */

  function initSettings() {
    Lampa.SettingsApi.addComponent({
      component: ID,
      name: 'MultiCover',
      icon: '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
    });

    function input(name, title, descr) {
      Lampa.SettingsApi.addParam({
        component: ID,
        param: { name: 'mc_' + name, type: 'input', values: '', default: '' },
        field: { name: title, description: descr || '' }
      });
    }

    function trigger(name, title, def) {
      Lampa.SettingsApi.addParam({
        component: ID,
        param: { name: 'mc_' + name, type: 'trigger', default: def },
        field: { name: title }
      });
    }

    trigger('replace_poster', 'Заменять постер лучшим найденным', true);
    trigger('replace_bg', 'Заменять фон лучшим найденным', false);
    trigger('cards', 'Заменять обложки в каталоге и лентах (нужен перезапуск)', true);
    input('card_order', 'Источники для каталога', 'Через запятую, по умолчанию: fanart,tmdb. Чем меньше — тем быстрее');
    input('order', 'Приоритет источников в карточке', 'Через запятую: ' + DEFAULT_ORDER);
    input('fanart_key', 'Fanart.tv API key', 'fanart.tv → Personal API Key');
    input('kp_key', 'Kinopoisk API key', 'kinopoiskapiunofficial.tech');
    input('omdb_key', 'OMDb API key', 'omdbapi.com/apikey.aspx');
    Object.keys(providers).forEach(function (n) { trigger('use_' + n, 'Источник: ' + providers[n].title, true); });
  }

  /* ---------- старт ---------- */

  function start() {
    initSettings();
    if (opt('cards', true)) initCards();

    Lampa.Listener.follow('full', function (e) {
      if (e.type !== 'complite' && e.type !== 'complete') return;
      var movie = e.data && e.data.movie;
      if (!movie || !movie.id) return;
      var render = e.object.activity.render();

      collect(movie).then(function (res) {
        apply(render, movie, res);
      }).catch(function () {});
    });
  }

  if (window.appready) start();
  else Lampa.Listener.follow('app', function (e) { if (e.type === 'ready') start(); });
})();
