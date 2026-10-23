// 閲覧ページ（docs/design.md 4.16）：songs.json を読み、検索・ラベルの絞り込み・並び替えをして表示する

import { calcKey, midiToNote } from "./keycalc.js?v=4be12f2cba";
import {
  DEFAULT_SORT, filterByLabels, isSortKey, keyParts, matchesSearch, nextSort, sortSongs, textColorFor,
  adjustVoice, adjustedVoice, canAdjust, formatOffset, isAdjusted, resetAdjust, restoreVoiceChoice, selectVoice,
} from "./list.js?v=4be12f2cba";

const SORT_STORAGE_KEY = "keybook.sort";
const VOICE_STORAGE_KEY = "keybook.voice";

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  query: "",
  labelIds: [],
  sort: loadSort(),
  // 選んだ声と調整（4.3.1）。songs.json を読むまでは覚えていた値をそのまま持つ
  voice: loadVoiceChoice(),
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
    const res = await fetch("songs.json?v=4be12f2cba", { cache: "no-cache" });
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
  state.data = data;
  // 覚えていた声がなくなっていたら、選んでいない状態にする
  state.voice = restoreVoiceChoice(state.voice, data.voices);
  // 読み直したときに消えたラベルは、絞り込みからも外す
  state.labelIds = state.labelIds.filter((id) => data.labels.some((label) => label.id === id));
  $("updated").textContent = `${formatDate(data.generated_at)} 更新`;
  // 読み直して描き直しても、見ていた位置から動かさない
  const scrollY = window.scrollY;
  renderVoice();
  renderLabels();
  render();
  window.scrollTo(0, scrollY);
}

function formatDate(iso) {
  // "2026-10-23T12:34:56+09:00" → "2026-10-23 12:34"
  return iso.slice(0, 16).replace("T", " ");
}

// ---- 表示 ----

function labelStyle(label) {
  return label.color ? `background: ${label.color}; color: ${textColorFor(label.color)}; border-color: ${label.color}` : "";
}

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
  // キーの計算に使う方に「（基準）」を添える（4.4.1）
  const basis = voice.match_by === "min" ? "min_note" : "max_note";
  const label = (field, name) => (field === basis ? `${name}（基準）` : name);
  $("voice-adjust").replaceChildren(
    pitchControl("max_note", label("max_note", "最高音"), voice),
    pitchControl("min_note", label("min_note", "最低音"), voice),
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
  for (const button of document.querySelectorAll(".sort button")) {
    const active = button.dataset.sort === state.sort.key;
    button.setAttribute("aria-pressed", String(active));
    button.dataset.arrow = active ? (state.sort.desc ? "▼" : "▲") : "";
  }
}

function render() {
  const { data } = state;
  const labels = new Map(data.labels.map((label) => [label.id, label]));
  const found = data.songs.filter((song) => matchesSearch(song, state.query));
  const songs = sortSongs(filterByLabels(found, state.labelIds), state.sort);

  renderSortButtons();
  $("count").textContent = songs.length === data.songs.length
    ? `${songs.length} 曲`
    : `${songs.length} 曲（全 ${data.songs.length} 曲）`;
  // 声を選んでいなければキーはすべて「?」（4.16）
  const voice = adjustedVoice(state.voice, data.voices) ?? { max_note: null };
  $("songs").replaceChildren(...songs.map((song) => renderSong(song, labels, voice)));
  if (songs.length === 0) {
    $("songs").append(el("li", { className: "empty" }, data.songs.length === 0 ? "曲はまだありません" : "該当する曲はありません"));
  }
}

function renderSong(song, labels, voice) {
  const key = keyParts(calcKey(voice, song, state.data.settings));
  const songLabels = song.label_ids.map((id) => labels.get(id)).filter(Boolean).sort((a, b) => a.order - b.order);
  // 縦を短くするため、1行目に曲名、2行目にアーティスト・最高音・ラベルを並べ、キーは右に2行分で出す
  return el(
    "li",
    { className: "song" },
    el("p", { className: "title" }, song.title),
    el(
      "div",
      {
        className: ["key", key.text === "?" && "unknown", key.outOfRange && "out-of-range"].filter(Boolean).join(" "),
        "aria-label": `キー ${key.text}${key.notes.map((note) => `、${note}`).join("")}`,
      },
      el("span", { className: "key-text" }, key.text),
      ...key.notes.map((note) => el("span", { className: "key-note" }, note)),
    ),
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

// ---- 操作 ----

$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  if (state.data) {
    render();
  }
});

for (const button of document.querySelectorAll(".sort button")) {
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
}

load();
