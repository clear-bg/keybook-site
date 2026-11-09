// 閲覧ページ（docs/design.md 4.16）：songs.json を読み、検索・ラベル・性別・アーティストの絞り込み・並び替えをして表示する。
// カードを押すと曲の詳細を出す（4.16.1）

import { calcKey, midiToNote } from "./keycalc.js?v=a5a869de65";
import {
  DEFAULT_SORT, filterByLabels, isSortKey, keyParts, labelStyle, nextSort, preselectedLabelIds, sortSongs,
  artistOptions, keepKnownArtists, matchesArtistSearch, GENDERS, genderName,
  adjustVoice, adjustedVoice, canAdjust, formatOffset, isAdjusted, resetAdjust, restoreVoiceChoice, selectVoice,
  chartBounds, formatDay, formatRange, keyBreakdown, keyShift, noteName, outsideVoice, rangeWarnings, shiftNotes,
  voiceUsedText, filterSongs, sheetDragOffset, sheetDragResult, stretchSheetTop, stretchSheetResult, filterSummary, activeFilterCount, DEFAULT_ARTIST_SORT, nextArtistSort, isArtistSortKey, artistSortValue,
} from "./list.js?v=a5a869de65";

const SORT_STORAGE_KEY = "keybook.sort";
const ARTIST_SORT_STORAGE_KEY = "keybook.artistSort";
const VOICE_STORAGE_KEY = "keybook.voice";

const $ = (id) => document.getElementById(id);

// 最後の操作がキーボードか（指・マウスなら false）。シートを閉じたあとに開いたボタンへフォーカスを戻すのは、
// キーボードで操作しているときだけにする（指で閉じたときに、戻したボタンの周りに枠が出ないように。Issue #17）
// ページ全体にも印（html の keyboard-input）を付け、指で開いたシートの × に枠を出さないのに使う（style.css）
let lastInputWasKeyboard = false;
function setKeyboardInput(value) {
  lastInputWasKeyboard = value;
  document.documentElement.classList.toggle("keyboard-input", value);
}
document.addEventListener("keydown", () => setKeyboardInput(true), true);
document.addEventListener("pointerdown", () => setKeyboardInput(false), true);

/**
 * シートを閉じたあとのフォーカス。キーボードなら target（開いたボタンなど）に移す。
 * 指・マウスなら、ブラウザが閉じるときに自動で戻したフォーカスを外す（戻されたボタンの周りに枠が出るため）
 */
function settleFocusAfterSheet(target) {
  if (lastInputWasKeyboard) {
    target?.focus();
  } else if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
}

const state = {
  data: null,
  query: "",
  labelIds: [],
  // 選んだ性別とアーティストの名前（ラベルと同じく覚えさせず、開くたびに選んでいない状態から始める）
  genders: [],
  artists: [],
  sort: loadSort(),
  // アーティストの一覧の性別・ラベル（一覧だけを絞る。開くたびにホーム画面の選択から始める）と並び順（覚えさせる）
  artistGenders: [],
  artistLabelIds: [],
  // シートで選んでいるアーティスト（下書き。「絞り込む」で state.artists にする）
  artistDraft: [],
  // 絞り込みと並び替えを表示しているか、シートの条件を表示しているか（覚えさせず、開くたびに表示から始める。Issue #15）
  controlsOpen: true,
  artistCondOpen: true,
  artistSort: loadArtistSort(),
  // 選んだ声と調整（4.3.1）。songs.json を読むまでは覚えていた値をそのまま持つ
  voice: loadVoiceChoice(),
  // 詳細を開いている曲の ID（開いていなければ null）
  detailId: null,
};

/** 要素を作る。文字列の子は textContent として入れる。 */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith("on")) {
      node.addEventListener(key.slice(2), value);
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, value);
    }
  }
  node.append(...children);
  return node;
}

// ---- 並び順を覚える（そのブラウザだけ。使えなければ初期値） ----

function loadSort() {
  try {
    const sort = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY));
    if (sort && isSortKey(sort.key) && typeof sort.desc === "boolean") {
      return sort;
    }
  } catch {
    // プライベートブラウズなどで使えないときは初期値
  }
  return DEFAULT_SORT;
}

function loadArtistSort() {
  try {
    const sort = JSON.parse(localStorage.getItem(ARTIST_SORT_STORAGE_KEY));
    if (sort && isArtistSortKey(sort.key) && typeof sort.desc === "boolean") {
      return sort;
    }
  } catch {
    // 使えないときは初期値
  }
  return DEFAULT_ARTIST_SORT;
}

function saveArtistSort() {
  try {
    localStorage.setItem(ARTIST_SORT_STORAGE_KEY, JSON.stringify(state.artistSort));
  } catch {
    // 覚えられなくても表示には困らない
  }
}

function saveSort() {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(state.sort));
  } catch {
    // 覚えられなくても表示には困らない
  }
}

// ---- 選んだ声と調整を覚える（そのブラウザだけ。使えなければ毎回選ぶ） ----

function loadVoiceChoice() {
  try {
    return JSON.parse(localStorage.getItem(VOICE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveVoiceChoice() {
  try {
    localStorage.setItem(VOICE_STORAGE_KEY, JSON.stringify(state.voice));
  } catch {
    // 覚えられなくても表示には困らない
  }
}

// ---- 読み込み ----

async function load() {
  let data;
  try {
    // HTML がキャッシュされていても、毎回最新の songs.json を確かめる（4.14）
    const res = await fetch("songs.json?v=a5a869de65", { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`${res.status}`);
    }
    data = await res.json();
  } catch {
    // 読み直しに失敗したときは、表示中の一覧をそのまま残す
    if (!state.data) {
      $("count").textContent = "曲の一覧を読み込めませんでした。電波のよいところで再読み込みしてください。";
    }
    return;
  }
  // 開いたときだけ、最初から選ぶラベルを選ぶ（読み直したときは見る人の選択を残す。4.16）
  if (!state.data) {
    state.labelIds = preselectedLabelIds(data.labels);
  }
  state.data = data;
  // 覚えていた声がなくなっていたら、選んでいない状態にする
  state.voice = restoreVoiceChoice(state.voice, data.voices);
  // 読み直したときに消えたラベルは、絞り込みからも外す
  state.labelIds = state.labelIds.filter((id) => data.labels.some((label) => label.id === id));
  state.artistLabelIds = state.artistLabelIds.filter((id) => data.labels.some((label) => label.id === id));
  state.artists = keepKnownArtists(state.artists, data.songs);
  state.artistDraft = keepKnownArtists(state.artistDraft, data.songs);
  $("updated").textContent = `${formatDate(data.generated_at)} 更新`;
  // 読み直して描き直しても、見ていた位置から動かさない
  const scrollY = window.scrollY;
  renderVoice();
  renderGenders();
  renderLabels();
  renderArtists();
  render();
  if (artistSheet.open) {
    renderArtistLabels();
    renderArtistList();
  }
  window.scrollTo(0, scrollY);
  // 詳細を開いていれば新しいデータで描き直す（曲がなくなっていれば閉じる。4.16.1）
  if (state.detailId != null) {
    renderDetail();
  }
}

function formatDate(iso) {
  // "2026-10-23T12:34:56+09:00" → "2026-10-23 12:34"
  return iso.slice(0, 16).replace("T", " ");
}

// ---- 表示 ----

function renderLabels() {
  const labels = [...state.data.labels].sort((a, b) => a.order - b.order);
  $("labels").hidden = labels.length === 0;
  $("labels").replaceChildren(
    ...labels.map((label) => {
      const pressed = state.labelIds.includes(label.id);
      return el(
        "button",
        {
          type: "button",
          className: "filter",
          "aria-pressed": String(pressed),
          style: pressed ? labelStyle(label) : "",
          onclick: () => {
            state.labelIds = pressed ? state.labelIds.filter((id) => id !== label.id) : [...state.labelIds, label.id];
            renderLabels();
            render();
          },
        },
        el("span", { className: "dot", style: label.color ? `background: ${label.color}` : "" }),
        label.name,
      );
    }),
  );
}

/** 性別の絞り込み：性別のボタンを並べる（4.16） */
function renderGenders() {
  $("genders").replaceChildren(
    ...GENDERS.map((gender) => {
      const pressed = state.genders.includes(gender.value);
      return el(
        "button",
        {
          type: "button",
          className: "filter gender",
          "aria-pressed": String(pressed),
          onclick: () => {
            state.genders = pressed ? state.genders.filter((g) => g !== gender.value) : [...state.genders, gender.value];
            renderGenders();
            render();
          },
        },
        gender.name,
      );
    }),
  );
}

/** アーティストの絞り込み：一覧を開くボタンと、選んだアーティスト（押すと外す）を並べる（4.16） */
function renderArtists() {
  $("artists").replaceChildren(
    el(
      "button",
      { type: "button", className: "artist-open", "aria-haspopup": "dialog", onclick: openArtistSheet },
      "アーティストで絞り込み",
      ...(state.artists.length > 0 ? [el("span", { className: "badge" }, String(state.artists.length))] : []),
    ),
    ...state.artists.map((name) =>
      el(
        "button",
        { type: "button", className: "filter", "aria-pressed": "true", "aria-label": `${name} を外す`, onclick: () => toggleArtist(name) },
        name,
        el("span", { className: "remove", "aria-hidden": "true" }, "×"),
      ),
    ),
  );
}

function toggleArtist(name) {
  state.artists = state.artists.includes(name) ? state.artists.filter((a) => a !== name) : [...state.artists, name];
  renderArtists();
  render();
}

// ---- アーティストの一覧（下から出るシート。4.16） ----

const artistSheet = $("artist-sheet");

function openArtistSheet() {
  $("artist-search").value = "";
  $("artist-search-clear").hidden = true;
  state.artistGenders = [...state.genders];
  state.artistLabelIds = [...state.labelIds];
  state.artistDraft = [...state.artists];
  state.artistCondOpen = true;
  $("artist-reflect").checked = false;
  renderArtistCond();
  renderArtistGenders();
  renderArtistLabels();
  renderArtistSort();
  renderArtistList();
  artistSheet.showModal();
  document.documentElement.classList.add("detail-open");
  $("artist-list").scrollTop = 0;
}

/** シートの性別：一覧だけを絞る（Issue #14） */
function renderArtistGenders() {
  $("artist-genders").replaceChildren(
    ...GENDERS.map((gender) => {
      const pressed = state.artistGenders.includes(gender.value);
      return el(
        "button",
        {
          type: "button",
          "aria-pressed": String(pressed),
          onclick: () => {
            state.artistGenders = pressed
              ? state.artistGenders.filter((g) => g !== gender.value)
              : [...state.artistGenders, gender.value];
            renderArtistGenders();
            renderArtistList();
          },
        },
        gender.name,
      );
    }),
  );
}

/** シートのラベル：一覧だけを絞る（選んだラベルがすべて付いている曲。Issue #14） */
function renderArtistLabels() {
  const labels = [...state.data.labels].sort((a, b) => a.order - b.order);
  $("artist-labels").hidden = labels.length === 0;
  $("artist-labels").replaceChildren(
    ...labels.map((label) => {
      const pressed = state.artistLabelIds.includes(label.id);
      return el(
        "button",
        {
          type: "button",
          className: "filter",
          "aria-pressed": String(pressed),
          style: pressed ? labelStyle(label) : "",
          onclick: () => {
            state.artistLabelIds = pressed
              ? state.artistLabelIds.filter((id) => id !== label.id)
              : [...state.artistLabelIds, label.id];
            renderArtistLabels();
            renderArtistList();
          },
        },
        el("span", { className: "dot", style: label.color ? `background: ${label.color}` : "" }),
        label.name,
      );
    }),
  );
}

/** シートの条件（性別・ラベル・チェック・並び替え）を隠す・表示。隠しているときは性別の行に条件を短く出す */
function renderArtistCond() {
  const open = state.artistCondOpen;
  $("artist-genders").hidden = !open;
  $("artist-cond-more").hidden = !open;
  $("artist-cond-summary").hidden = open;
  $("artist-cond-toggle").setAttribute("aria-expanded", String(open));
  $("artist-cond-toggle").textContent = open ? "条件を隠す ▲" : "条件を表示 ▼";
  if (!open) {
    const conditions = filterSummary({ genders: state.artistGenders, labelIds: state.artistLabelIds, artists: [] }, state.data.labels);
    const sort = `${ARTIST_SORT_NAMES[state.artistSort.key]} ${state.artistSort.desc ? "▼" : "▲"}`;
    $("artist-cond-summary").textContent = `条件：${conditions || "なし"} · ${sort}`;
  }
}

$("artist-cond-toggle").addEventListener("click", () => {
  state.artistCondOpen = !state.artistCondOpen;
  renderArtistCond();
});

const ARTIST_SORT_NAMES = { count: "曲数", artist: "アーティスト名", latest: "登録順", max_note: "最高音" };

/** シートの並び替え（曲の並び替えと同じ見た目。Issue #14） */
function renderArtistSort() {
  $("artist-sort").replaceChildren(
    ...Object.entries(ARTIST_SORT_NAMES).map(([key, name]) => {
      const active = state.artistSort.key === key;
      const button = el(
        "button",
        {
          type: "button",
          "aria-pressed": String(active),
          onclick: () => {
            state.artistSort = nextArtistSort(state.artistSort, key);
            saveArtistSort();
            renderArtistSort();
            renderArtistList();
            $("artist-list").scrollTop = 0;
          },
        },
        name,
      );
      button.dataset.arrow = active ? (state.artistSort.desc ? "▼" : "▲") : "";
      return button;
    }),
  );
}

/** シートで選んでいるアーティスト（下書き）を切り替える */
function toggleArtistDraft(name) {
  state.artistDraft = state.artistDraft.includes(name)
    ? state.artistDraft.filter((a) => a !== name)
    : [...state.artistDraft, name];
}

/** 「絞り込む」を押したあとにホーム画面に出る曲（チェックが入っていれば、ラベル・性別もシートのものにする） */
function appliedFilters() {
  const reflect = $("artist-reflect").checked;
  return {
    query: state.query,
    labelIds: reflect ? state.artistLabelIds : state.labelIds,
    genders: reflect ? state.artistGenders : state.genders,
    artists: state.artistDraft,
  };
}

function renderArtistApply() {
  $("artist-apply-count").textContent = `（${filterSongs(state.data.songs, appliedFilters()).length} 曲）`;
}

/** 選んでいるアーティスト（シートの一番下）。押すと外す。一覧は描き直さず、そのアーティストの行の状態だけ変える */
function renderArtistPicked() {
  $("artist-clear").disabled = state.artistDraft.length === 0;
  renderArtistApply();
  if (state.artistDraft.length === 0) {
    $("artist-picked").replaceChildren(el("span", { className: "artist-picked-empty" }, "選んでいるアーティストはありません"));
    return;
  }
  $("artist-picked").replaceChildren(
    ...state.artistDraft.map((name) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": "true",
          "aria-label": `${name} を外す`,
          onclick: () => {
            toggleArtistDraft(name);
            for (const option of $("artist-list").querySelectorAll(".artist-option")) {
              if (option.dataset.name === name) {
                option.setAttribute("aria-pressed", "false");
              }
            }
            renderArtistPicked();
          },
        },
        name,
        el("span", { className: "remove", "aria-hidden": "true" }, "×"),
      ),
    ),
  );
}

/**
 * 一覧を描く。曲数・並びの値はシートのラベルで絞り込んだ曲で決め、0 曲のアーティストは出さない（選んでいるものは残す）。
 * シートの性別は、その性別の曲があるアーティストだけにする（曲数は減らさない。Issue #14）
 */
function renderArtistList() {
  const { songs } = state.data;
  const counted = filterByLabels(songs, state.artistLabelIds);
  const options = artistOptions(songs, counted, state.artistDraft, { genders: state.artistGenders, sort: state.artistSort })
    .filter((artist) => matchesArtistSearch(artist, $("artist-search").value));
  $("artist-list").replaceChildren(
    ...options.map((artist) =>
      el(
        "li",
        {},
        el(
          "button",
          {
            type: "button",
            className: "artist-option",
            "aria-pressed": String(artist.selected),
            onclick: (event) => {
              toggleArtistDraft(artist.name);
              // 一覧は描き直さず、押したものの状態だけ変える（スクロール位置を動かさない）
              event.currentTarget.setAttribute("aria-pressed", String(state.artistDraft.includes(artist.name)));
              renderArtistPicked();
            },
            "data-name": artist.name,
          },
          el("span", { className: "check", "aria-hidden": "true" }),
          el("span", { className: "artist-name" }, artist.name),
          ...(artistSortValue(artist, state.artistSort.key)
            ? [el("span", { className: "artist-value" }, artistSortValue(artist, state.artistSort.key))]
            : []),
          el("span", { className: "artist-count" }, `${artist.count} 曲`),
        ),
      ),
    ),
  );
  if (options.length === 0) {
    $("artist-list").append(el("li", { className: "empty" }, "該当するアーティストはありません"));
  }
  renderArtistPicked();
}

// × とキャンセル：何も反映せずに閉じる（外側・Esc も同じ）
$("artist-close").addEventListener("click", () => artistSheet.close());
$("artist-cancel").addEventListener("click", () => artistSheet.close());

// 絞り込む：選んだアーティスト（チェックが入っていればラベル・性別も）をホーム画面に反映して閉じる
$("artist-apply").addEventListener("click", () => {
  const applied = appliedFilters();
  state.artists = [...applied.artists];
  state.labelIds = [...applied.labelIds];
  state.genders = [...applied.genders];
  renderGenders();
  renderLabels();
  renderArtists();
  render();
  artistSheet.close();
});

$("artist-reflect").addEventListener("change", renderArtistApply);

// すべて解除：シートの中の選択（下書き）を外すだけ。反映するのは「絞り込む」を押したとき
$("artist-clear").addEventListener("click", () => {
  state.artistDraft = [];
  renderArtistList();
});

$("artist-search").addEventListener("input", (event) => {
  $("artist-search-clear").hidden = event.target.value === "";
  renderArtistList();
});

artistSheet.addEventListener("close", () => {
  document.documentElement.classList.remove("detail-open");
  settleFocusAfterSheet(document.querySelector("#artists .artist-open"));
});

// シートの外側（暗い部分）を押したら閉じる
artistSheet.addEventListener("click", (event) => {
  if (event.target === artistSheet) {
    artistSheet.close();
  }
});

/** 声の選択と調整（4.16） */
function renderVoice() {
  const { voices } = state.data;
  $("voice").hidden = voices.length === 0;
  $("voice-buttons").replaceChildren(
    ...voices.map((voice) =>
      el(
        "button",
        {
          type: "button",
          "aria-pressed": String(state.voice?.voiceId === voice.id),
          onclick: () => changeVoice(selectVoice(state.voice, voice.id)),
        },
        voice.name,
      ),
    ),
  );
  if (!state.voice) {
    $("voice-adjust").replaceChildren(el("p", { className: "voice-hint" }, "声を選ぶとキーが出ます"));
    return;
  }
  const voice = voices.find((v) => v.id === state.voice.voiceId);
  $("voice-adjust").replaceChildren(
    pitchControl("max_note", "最高音", voice),
    pitchControl("min_note", "最低音", voice),
    ...(isAdjusted(state.voice)
      ? [el("button", { type: "button", className: "voice-reset", onclick: () => changeVoice(resetAdjust(state.voice)) }, "元に戻す")]
      : []),
  );
}

/** 「最高音 [−] mid2A（+2）[＋]」 */
function pitchControl(field, label, voice) {
  const offset = state.voice.offsets[field];
  const step = (delta, text, name) =>
    el(
      "button",
      {
        type: "button",
        className: "step",
        disabled: !canAdjust(state.voice, state.data.voices, field, delta),
        "aria-label": `${label}を半音${name}`,
        onclick: () => changeVoice(adjustVoice(state.voice, state.data.voices, field, delta)),
      },
      text,
    );
  const value = voice[field] == null ? "未登録" : midiToNote(voice[field] + offset) + formatOffset(offset);
  return el(
    "div",
    { className: "pitch-control" },
    el("span", { className: "pitch-label" }, label),
    step(-1, "−", "下げる"),
    el("span", { className: offset === 0 ? "pitch-value" : "pitch-value adjusted", "aria-live": "polite" }, value),
    step(1, "＋", "上げる"),
  );
}

function changeVoice(choice) {
  state.voice = choice;
  saveVoiceChoice();
  renderVoice();
  render();
}

function renderSortButtons() {
  for (const button of document.querySelectorAll("#sort button")) {
    const active = button.dataset.sort === state.sort.key;
    button.setAttribute("aria-pressed", String(active));
    button.dataset.arrow = active ? (state.sort.desc ? "▼" : "▲") : "";
  }
}

// 並び替えの名前（隠しているときに曲数の後ろに出す）
const SORT_NAMES = { id: "登録順", title: "曲名", artist: "アーティスト名", max_note: "最高音" };

/** 絞り込みと並び替えを隠す・表示（Issue #15）。隠しているときは、ボタンに絞り込みの数、曲数の後ろに絞り込みと並び順を出す */
function renderControlsToggle() {
  const open = state.controlsOpen;
  const filters = { genders: state.genders, labelIds: state.labelIds, artists: state.artists };
  $("controls-more").hidden = !open;
  $("controls-toggle").setAttribute("aria-expanded", String(open));
  $("controls-toggle").setAttribute("aria-label", open ? "絞り込みと並び替えを隠す" : "絞り込みと並び替えを表示");
  const active = activeFilterCount(filters);
  $("controls-badge").hidden = open || active === 0;
  $("controls-badge").textContent = String(active);
  $("count-summary").hidden = open;
  if (!open) {
    const sort = `${SORT_NAMES[state.sort.key]} ${state.sort.desc ? "▼" : "▲"}`;
    $("count-summary").textContent = ` · ${[filterSummary(filters, state.data.labels), sort].filter(Boolean).join(" · ")}`;
  }
}

$("controls-toggle").addEventListener("click", () => {
  state.controlsOpen = !state.controlsOpen;
  if (state.data) {
    renderControlsToggle();
  }
});

function render() {
  const { data } = state;
  const labels = new Map(data.labels.map((label) => [label.id, label]));
  const filtered = filterSongs(data.songs, { query: state.query, labelIds: state.labelIds, genders: state.genders, artists: state.artists });
  const songs = sortSongs(filtered, state.sort);

  renderSortButtons();
  $("count").textContent = songs.length === data.songs.length
    ? `${songs.length} 曲`
    : `${songs.length} 曲（全 ${data.songs.length} 曲）`;
  renderControlsToggle();
  // 声を選んでいなければキーはすべて「?」（4.16）
  const voice = adjustedVoice(state.voice, data.voices) ?? { max_note: null };
  $("songs").replaceChildren(...songs.map((song) => renderSong(song, labels, voice)));
  if (songs.length === 0) {
    $("songs").append(el("li", { className: "empty" }, data.songs.length === 0 ? "曲はまだありません" : "該当する曲はありません"));
  }
}

/** オクターブの印（下に歌う＝↓、上に歌う＝↑。4.4.1） */
function octaveMark(octave) {
  return el(
    "span",
    { className: `octave ${octave.direction}`, title: octave.label, "aria-hidden": "true" },
    octave.direction === "down" ? "↓" : "↑",
  );
}

/** キー（大きい数字、オクターブの印、範囲外などの注記）。カードと詳細で共用する */
function keyBlock(key, ...extra) {
  return el(
    "div",
    {
      className: ["key", key.text === "?" && "unknown", key.outOfRange && "out-of-range"].filter(Boolean).join(" "),
      "aria-label": `キー ${key.text}${[key.octave?.label, ...key.notes].filter(Boolean).map((note) => `、${note}`).join("")}`,
    },
    el(
      "span",
      { className: "key-main" },
      // オクターブをずらすときは、キーの右に矢印の印（4.4.1）
      el("span", { className: "key-text" }, key.text),
      ...(key.octave ? [octaveMark(key.octave)] : []),
    ),
    ...key.notes.map((note) => el("span", { className: "key-note" }, note)),
    ...extra,
  );
}

const songLabelsOf = (song, labels) =>
  song.label_ids.map((id) => labels.get(id)).filter(Boolean).sort((a, b) => a.order - b.order);

function renderSong(song, labels, voice) {
  const key = keyParts(calcKey(voice, song, state.data.settings));
  const songLabels = songLabelsOf(song, labels);
  // 縦を短くするため、1行目に曲名、2行目にアーティスト・最高音・ラベルを並べ、キーは右に2行分で出す
  return el(
    "li",
    {
      className: "song",
      tabIndex: 0,
      "aria-haspopup": "dialog",
      "data-id": song.id,
      onclick: () => openDetail(song.id),
      onkeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openDetail(song.id);
        }
      },
    },
    el("p", { className: "title" }, song.title),
    keyBlock(key),
    el(
      "p",
      { className: "sub" },
      ...(song.artist ? [el("span", { className: "artist" }, song.artist)] : []),
      el("span", { className: "pitch" }, `最高音 ${song.max_note == null ? "未入力" : midiToNote(song.max_note)}`),
      ...songLabels.map((label) => el("span", { className: "chip", style: labelStyle(label) }, label.name)),
    ),
    ...(song.memo ? [el("p", { className: "memo" }, song.memo)] : []),
  );
}

// ---- 曲の詳細（4.16.1） ----

const detail = $("detail");

function openDetail(songId) {
  state.detailId = songId;
  renderDetail();
  if (!detail.open) {
    detail.showModal();
    // 後ろの一覧はスクロールさせない
    document.documentElement.classList.add("detail-open");
  }
}

function closeDetail() {
  if (detail.open) {
    detail.close();
  }
}

// ×・Esc・外側のどれで閉じても、ここで後片付けをして元のカードにフォーカスを戻す
detail.addEventListener("close", () => {
  document.documentElement.classList.remove("detail-open");
  const id = state.detailId;
  state.detailId = null;
  settleFocusAfterSheet(document.querySelector(`#songs [data-id="${id}"]`));
});

// シートの外側（暗い部分）を押したら閉じる。シートの中を押したときは対象が中の要素になる
detail.addEventListener("click", (event) => {
  if (event.target === detail) {
    closeDetail();
  }
});

// ---- シートのつまみを下に引いて閉じる（Issue #17） ----

// 引っ張れる場所：つまみと見出しの行。ボタン・入力欄の上から始めたときは引っ張らない（押せるように）
enableSheetDrag(detail, ".grab, .detail-head");
// アーティストのシートは、引いて閉じたときも何も反映しない（キャンセルと同じ。#14）。上に引くと広げられる（#18）
enableSheetDrag(artistSheet, ".grab, .artist-sheet-bar", { stretchable: true });

const SHEET_SLIDE_MS = 180;

/**
 * 引いている間はシートを指について動かし、離したときに閉じるか元に戻すかを決める。
 * stretchable なら上にも引けて、離したときに「今の大きさ」「広げた大きさ」（.expanded）のどちらかで止める（Issue #18）
 */
function enableSheetDrag(sheet, handleSelector, { stretchable = false } = {}) {
  let drag = null;
  sheet.addEventListener("pointerdown", (event) => {
    const handle = event.target.closest(handleSelector);
    if (event.button !== 0 || !handle || event.target.closest("button, input, select, textarea, a, label")) {
      return;
    }
    drag = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, velocity: 0 };
    if (stretchable) {
      drag.sizes = measureStretchSheet(sheet);
    }
    try {
      // 指がつまみの外に出ても動きを受け取り続ける
      handle.setPointerCapture(event.pointerId);
    } catch {
      // 受け取れなくても、シートの中で動かしている間は動く
    }
    sheet.classList.add("dragging");
    sheet.style.transition = "none";
  });
  sheet.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    const elapsed = event.timeStamp - drag.lastTime;
    if (elapsed > 0) {
      drag.velocity = (event.clientY - drag.lastY) / elapsed;
    }
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
    const dy = event.clientY - drag.startY;
    if (!stretchable) {
      sheet.style.transform = `translateY(${sheetDragOffset(dy)}px)`;
      return;
    }
    // 今の大きさより上では高さを変え（下端は画面の下に付けたまま）、下ではシートごと下げる
    const { bottom, startTop, normalTop, expandedTop, normalHeight } = drag.sizes;
    const top = stretchSheetTop({ startTop, dy, expandedTop });
    if (top < normalTop) {
      sheet.style.height = `${bottom - top}px`;
      sheet.style.transform = "";
    } else {
      sheet.style.height = `${normalHeight}px`;
      sheet.style.transform = `translateY(${top - normalTop}px)`;
    }
  });
  const end = (event) => {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    // 止めてから離したときは払ったことにしない
    const velocity = event.timeStamp - drag.lastTime > 100 ? 0 : drag.velocity;
    const dy = drag.lastY - drag.startY;
    let result;
    if (!stretchable) {
      result = event.type === "pointercancel" ? "back" : sheetDragResult({ dy, height: sheet.offsetHeight, velocity });
    } else {
      const { from, startTop, normalTop, expandedTop, normalHeight } = drag.sizes;
      result = event.type === "pointercancel"
        ? from
        : stretchSheetResult({ from, top: stretchSheetTop({ startTop, dy, expandedTop }), dy, velocity, normalTop, expandedTop, normalHeight });
    }
    drag = null;
    sheet.classList.remove("dragging");
    if (result === "close") {
      slideSheetOut(sheet);
      return;
    }
    // 止まる大きさへ動かす。高さは .expanded の有無で決まるので、引いている間の高さは外す
    sheet.classList.toggle("expanded", result === "expanded");
    sheet.style.transition = `transform ${SHEET_SLIDE_MS}ms ease-out, height ${SHEET_SLIDE_MS}ms ease-out`;
    sheet.style.transform = "";
    sheet.style.height = "";
    setTimeout(() => { sheet.style.transition = ""; }, SHEET_SLIDE_MS);
  };
  sheet.addEventListener("pointerup", end);
  sheet.addEventListener("pointercancel", end);
  // 閉じたら、次に開いたときのために位置と大きさを戻す（開くたびに今の大きさから始める）
  sheet.addEventListener("close", () => {
    sheet.classList.remove("expanded");
    sheet.style.transform = "";
    sheet.style.height = "";
    sheet.style.transition = "";
  });
}

/** 引き始めに、今の大きさと広げた大きさのときの上端を測る（高さは CSS で決めているので、.expanded を付け外しして測る） */
function measureStretchSheet(sheet) {
  const rect = sheet.getBoundingClientRect();
  const from = sheet.classList.contains("expanded") ? "expanded" : "normal";
  sheet.classList.toggle("expanded");
  const otherHeight = sheet.offsetHeight;
  sheet.classList.toggle("expanded");
  const normalHeight = from === "normal" ? rect.height : otherHeight;
  const expandedHeight = from === "expanded" ? rect.height : otherHeight;
  return {
    from,
    bottom: rect.bottom,
    startTop: rect.top,
    normalTop: rect.bottom - normalHeight,
    expandedTop: rect.bottom - expandedHeight,
    normalHeight,
  };
}

/** 下に抜けてから閉じる（動きを減らす設定ならすぐ閉じる） */
function slideSheetOut(sheet) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    sheet.close();
    return;
  }
  sheet.style.transition = `transform ${SHEET_SLIDE_MS}ms ease-in`;
  sheet.style.transform = "translateY(100%)";
  setTimeout(() => {
    if (sheet.open) {
      sheet.close();
    }
  }, SHEET_SLIDE_MS);
}

function renderDetail() {
  const { data } = state;
  const song = data.songs.find((s) => s.id === state.detailId);
  if (!song) {
    closeDetail();
    return;
  }
  const labels = new Map(data.labels.map((label) => [label.id, label]));
  const songLabels = songLabelsOf(song, labels);
  const voice = adjustedVoice(state.voice, data.voices);
  const result = calcKey(voice ?? { max_note: null }, song, data.settings);
  const key = keyParts(result);
  const breakdown = keyBreakdown(result, song.key_adjust);
  const shift = voice ? keyShift(result) : null;
  const sung = shift == null ? null : shiftNotes(song, shift);

  $("detail-body").replaceChildren(
    el("div", { className: "grab", "aria-hidden": "true" }),
    el(
      "div",
      { className: "detail-head" },
      el(
        "div",
        { className: "detail-names" },
        el("h2", { id: "detail-title", className: "detail-title" }, song.title),
        ...(song.artist
          ? [el(
              "p",
              { className: "detail-artist" },
              song.artist,
              // アーティストの性別（未設定なら出さない）
              ...(genderName(song.gender) ? [el("span", { className: "detail-gender" }, genderName(song.gender))] : []),
            )]
          : []),
        ...(songLabels.length > 0
          ? [el("p", { className: "detail-chips" },
            ...songLabels.map((label) => el("span", { className: "chip", style: labelStyle(label) }, label.name)))]
          : []),
      ),
      keyBlock(key, ...(breakdown ? [el("span", { className: "key-breakdown" }, breakdown)] : [])),
      el("button", { type: "button", className: "detail-close", "aria-label": "閉じる", onclick: closeDetail }, "×"),
    ),
    rangeSection(song, voice, result, sung),
    ...(song.memo
      ? [el("section", { className: "detail-group" }, el("h3", {}, "メモ"), el("p", { className: "detail-memo" }, song.memo))]
      : []),
    el("p", { className: "detail-dates" }, `登録 ${formatDay(song.created_at)}・更新 ${formatDay(song.updated_at)}`),
  );
}

/** 見出し「音域」：どの声で計算したか・離れすぎの注記、図、原曲とこのキーの音域 */
function rangeSection(song, voice, result, sung) {
  const lines = [];
  if (voice) {
    const name = state.data.voices.find((v) => v.id === state.voice.voiceId).name;
    const used = voiceUsedText(name, state.voice.offsets);
    lines.push(el(
      "p",
      { className: "detail-voice" },
      el("span", {}, el("b", {}, name), used.slice(name.length)),
      ...(sung ? rangeWarnings(sung, voice) : []).map((text) => el("span", { className: "detail-warn" }, text)),
    ));
  } else {
    lines.push(el("p", { className: "detail-voice" }, "声を選ぶと、キーとこのキーの音域が出ます"));
  }
  const original = formatRange(song.min_note, song.max_note);
  if (original == null) {
    lines.push(el("p", { className: "detail-none" }, "音域は未登録"));
  } else {
    lines.push(rangeChart(song, voice, result, sung));
  }
  const rows = [["原曲", song]];
  if (sung) {
    rows.push(["このキー", sung]);
  }
  const pitches = rows
    .map(([label, notes]) => [label, formatRange(notes.min_note, notes.max_note), chestFalsetto(notes)])
    .filter(([, range, extra]) => range != null || extra != null);
  if (pitches.length > 0) {
    lines.push(el(
      "dl",
      { className: "detail-pitches" },
      ...pitches.flatMap(([label, range, extra]) => [
        el("dt", {}, label),
        el("dd", {}, range ?? "", ...(extra ? [el("span", { className: "detail-extra" }, extra)] : [])),
      ]),
    ));
  }
  return el("section", { className: "detail-group" }, el("h3", {}, "音域"), ...lines);
}

/** "地声 mid2G#・裏声 hiA"（登録してあるものだけ。どちらもなければ null） */
function chestFalsetto(notes) {
  const parts = [["地声", notes.max_chest], ["裏声", notes.max_falsetto]]
    .filter(([, note]) => note != null)
    .map(([label, note]) => `${label} ${noteName(note)}`);
  return parts.length > 0 ? parts.join("・") : null;
}

// ---- 音域の図（4.16.1）：鍵盤を敷いたピアノロールに、原曲とこのキーの横の帯 ----

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  if (text != null) {
    node.textContent = text;
  }
  return node;
}

// 黒鍵（A=0 として A#・C#・D#・F#・G#）
const isBlack = (midi) => [1, 4, 6, 9, 11].includes((((midi - 33) % 12) + 12) % 12);

const CHART = {
  width: 360, plotLeft: 52, plotRight: 356,
  top: 18, row1: 32, row2: 88, barHeight: 14, keyHeight: 38,
};

function rangeChart(song, voice, result, sung) {
  const showVoice = voice != null && voice.max_note != null && voice.min_note != null;
  const notes = [song.max_note, song.min_note];
  if (sung) {
    notes.push(sung.max_note, sung.min_note);
  }
  if (showVoice) {
    notes.push(voice.max_note, voice.min_note);
  }
  const { lo, hi } = chartBounds(notes);
  const { width, plotLeft, plotRight, top, row1, row2, barHeight, keyHeight } = CHART;
  const cell = (plotRight - plotLeft) / (hi - lo + 1);
  const left = (midi) => plotLeft + (midi - lo) * cell;
  const center = (midi) => left(midi) + cell / 2;
  // 「このキー」の行がなければ、その分だけ図の背を詰める
  const keyTop = sung ? 134 : 78;
  const svg = svgEl("svg", {
    class: "chart", viewBox: `0 0 ${width} ${keyTop + keyHeight + 4}`, role: "img", "aria-label": chartLabel(song, voice, sung),
  });

  // ピアノロール：黒鍵の列だけ薄く塗る
  for (let m = lo; m <= hi; m++) {
    if (isBlack(m)) {
      svg.append(svgEl("rect", { class: "roll-black", x: left(m), y: top, width: cell, height: keyTop - top }));
    }
  }
  // 声の範囲：列を青く塗り、両端に縦線。上に両端の音名を鍵の真ん中に揃えて置く
  const inVoice = (m) => showVoice && m >= voice.min_note && m <= voice.max_note;
  if (showVoice) {
    const x1 = left(voice.min_note);
    const x2 = left(voice.max_note) + cell;
    svg.append(svgEl("rect", { class: "voice-range", x: x1, y: top, width: x2 - x1, height: keyTop - top }));
    for (const [x, m] of [[x1, voice.min_note], [x2, voice.max_note]]) {
      svg.append(svgEl("line", { class: "voice-edge", x1: x, x2: x, y1: top, y2: keyTop + keyHeight }));
      svg.append(svgEl("line", { class: "voice-edge", x1: center(m), x2: center(m), y1: top - 5, y2: top + 2 }));
      svg.append(svgEl("text", { class: "voice-text", x: center(m), y: top - 7, "text-anchor": "middle" }, noteName(m)));
    }
    svg.append(svgEl("text", { class: "voice-text", x: 0, y: top - 6 }, "声"));
  }
  // 鍵盤（半音ごとに同じ幅。白鍵は隣の黒鍵の下まで伸ばす）
  for (let m = lo; m <= hi; m++) {
    if (isBlack(m)) {
      continue;
    }
    const x1 = isBlack(m - 1) && m - 1 >= lo ? left(m) - cell / 2 : left(m);
    const x2 = isBlack(m + 1) && m + 1 <= hi ? left(m) + cell * 1.5 : left(m) + cell;
    svg.append(svgEl("rect", { class: inVoice(m) ? "key-white in-voice" : "key-white", x: x1, y: keyTop, width: x2 - x1, height: keyHeight }));
  }
  for (let m = lo; m <= hi; m++) {
    if (isBlack(m)) {
      svg.append(svgEl("rect", {
        class: inVoice(m) ? "key-black in-voice" : "key-black",
        x: left(m) + cell * 0.08, y: keyTop, width: cell * 0.84, height: keyHeight * 0.6, rx: 1,
      }));
    }
  }
  // 原曲とこのキーの帯。声の範囲から外れる部分は赤く塗り、帯の下に量を書く
  const rows = [{ label: "原曲", notes: song, className: "bar-original", y: row1 }];
  if (sung) {
    rows.push({ label: chartKeyLabel(result), notes: sung, className: "bar-sung", y: row2 });
  }
  for (const row of rows) {
    const low = row.notes.min_note ?? row.notes.max_note;
    const high = row.notes.max_note ?? row.notes.min_note;
    if (low == null) {
      continue;
    }
    const y = row.y;
    svg.append(svgEl("text", { class: "row-label", x: 0, y: y + 11 }, row.label));
    svg.append(svgEl("rect", { class: row.className, x: left(low), y, width: left(high) + cell - left(low), height: barHeight, rx: 4 }));
    for (const part of showVoice ? outsideVoice(row.notes, voice) : []) {
      const x1 = left(part.from);
      const x2 = left(part.to) + cell;
      svg.append(svgEl("rect", { class: "bar-outside", x: x1, y, width: x2 - x1, height: barHeight }));
      const isHigh = part.side === "high";
      svg.append(svgEl("text", {
        class: "outside-text", x: isHigh ? Math.min(x2, plotRight) : Math.max(x1, plotLeft), y: y + barHeight + 23,
        "text-anchor": isHigh ? "end" : "start",
      }, `${part.count}${isHigh ? "高い" : "低い"}`));
    }
    for (const m of low === high ? [low] : [low, high]) {
      svg.append(svgEl("text", { x: center(m), y: y + barHeight + 11, "text-anchor": "middle" }, noteName(m)));
    }
  }
  return el("div", { className: "detail-chart" }, svg);
}

/** 図の「このキー」の行の名前（"キー −1"、"原キー"。オクターブをずらすときは矢印を添える） */
function chartKeyLabel(result) {
  const { text, octave } = keyParts(result);
  const name = text === "原キー" ? text : `キー ${text}`;
  return octave ? `${name}${octave.direction === "down" ? "↓" : "↑"}` : name;
}

/** 図の読み上げ用の説明 */
function chartLabel(song, voice, sung) {
  const parts = [`原曲 ${formatRange(song.min_note, song.max_note)}`];
  if (sung) {
    parts.push(`このキー ${formatRange(sung.min_note, sung.max_note)}`);
  }
  if (voice?.max_note != null && voice?.min_note != null) {
    parts.push(`声 ${formatRange(voice.min_note, voice.max_note)}`);
  }
  return `音域の図：${parts.join("、")}`;
}

// ---- 操作 ----

$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  $("search-clear").hidden = state.query === "";
  if (state.data) {
    render();
  }
});

// バツボタン：検索語を消し、続けて入力できるよう検索欄にフォーカスを戻す
for (const [inputId, buttonId] of [["search", "search-clear"], ["artist-search", "artist-search-clear"]]) {
  $(buttonId).addEventListener("click", () => {
    const input = $(inputId);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    input.focus();
  });
}

// 検索欄の外をタップしたら、フォーカスを外してキーボードを閉じる（4.16）。
// スクロールでは閉じないよう、指をほとんど動かさずに離したとき（タップ）だけにする。
// スクロールが始まると pointercancel が来るので、そのときは何もしない。
// フォーカスを外すのは click より前なので、カードならそのまま詳細も開く。
const TAP_SLOP = 10; // px。これ以上動いたらタップとみなさない
let tapStart = null;
document.addEventListener("pointerdown", (event) => {
  tapStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
});
document.addEventListener("pointercancel", () => {
  tapStart = null;
});
document.addEventListener("pointerup", (event) => {
  const start = tapStart;
  tapStart = null;
  const active = document.activeElement;
  if (!start || start.id !== event.pointerId || !active?.matches('input[type="search"]')) {
    return;
  }
  if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP) {
    return;
  }
  // 同じ検索欄（とバツボタン）や、別の入力欄を押したときは、フォーカスの行き先をブラウザに任せる
  const target = event.target instanceof Element ? event.target : null;
  if (target && (target.closest(".search-box") === active.closest(".search-box") || target.closest("input, textarea, select"))) {
    return;
  }
  active.blur();
});

for (const button of document.querySelectorAll("#sort button")) {
  button.addEventListener("click", () => {
    state.sort = nextSort(state.sort, button.dataset.sort);
    saveSort();
    if (state.data) {
      render();
    }
  });
}

// ---- オフライン表示（4.14） ----

// 管理アプリの確認用ページでは使わない（開発中に古い画面が出ないように）
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

if ("serviceWorker" in navigator && !LOCAL_HOSTS.includes(location.hostname)) {
  navigator.serviceWorker.register("sw.js").catch(() => {
    // 登録できなくても、オンラインなら今までどおり見られる
  });
  // Service Worker が新しい songs.json を受け取ったら、読み直して描き直す
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "songs-updated") {
      load();
    }
  });
  // 新しいバージョンの Service Worker に切り替わったら、ページを読み直して新しい画面にする
  // （古い画面のまま新しい形式の songs.json を受け取ると描き直せないため）。
  // 初めて入ったとき（開いた時点で Service Worker がなかった）は、もう新しい画面なので読み直さない
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (hadController && !reloading) {
      reloading = true;
      location.reload();
    }
  });
}

load();
