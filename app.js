// 閲覧ページ（docs/design.md 4.16）：songs.json を読み、検索・ラベルの絞り込み・並び替えをして表示する

import { calcKey, midiToNote } from "./keycalc.js?v=e0e4d92730";
import {
  DEFAULT_SORT, filterByLabels, isSortKey, keyParts, matchesSearch, nextSort, sortSongs, textColorFor,
} from "./list.js?v=e0e4d92730";

const SORT_STORAGE_KEY = "keybook.sort";

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  query: "",
  labelIds: [],
  sort: loadSort(),
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

// ---- 読み込み ----

async function load() {
  try {
    // HTML がキャッシュされていても、毎回最新の songs.json を確かめる（4.14）
    const res = await fetch("songs.json?v=e0e4d92730", { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`${res.status}`);
    }
    state.data = await res.json();
  } catch {
    $("count").textContent = "曲の一覧を読み込めませんでした。電波のよいところで再読み込みしてください。";
    return;
  }
  $("updated").textContent = `${formatDate(state.data.generated_at)} 更新`;
  renderLabels();
  render();
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
  $("songs").replaceChildren(...songs.map((song) => renderSong(song, labels)));
  if (songs.length === 0) {
    $("songs").append(el("li", { className: "empty" }, data.songs.length === 0 ? "曲はまだありません" : "該当する曲はありません"));
  }
}

function renderSong(song, labels) {
  const key = keyParts(calcKey(state.data.voice, song, state.data.settings));
  const songLabels = song.label_ids.map((id) => labels.get(id)).filter(Boolean).sort((a, b) => a.order - b.order);
  // 縦を短くするため、1行目に曲名、2行目にアーティスト・最高音・ラベルを並べ、キーは右に2行分で出す
  return el(
    "li",
    { className: "song" },
    el("p", { className: "title" }, song.title),
    el(
      "div",
      { className: key.text === "?" ? "key unknown" : "key", "aria-label": `キー ${key.text}` },
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

load();
