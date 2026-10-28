// 閲覧ページ（docs/design.md 4.16）：songs.json を読み、検索・ラベルの絞り込み・並び替えをして表示する。
// カードを押すと曲の詳細を出す（4.16.1）

import { calcKey, midiToNote } from "./keycalc.js?v=8486b68304";
import {
  DEFAULT_SORT, filterByLabels, isSortKey, keyParts, labelStyle, matchesSearch, nextSort, preselectedLabelIds, sortSongs,
  adjustVoice, adjustedVoice, canAdjust, formatOffset, isAdjusted, resetAdjust, restoreVoiceChoice, selectVoice,
  chartBounds, formatDay, formatRange, keyBreakdown, keyShift, noteName, outsideVoice, rangeWarnings, shiftNotes,
  voiceUsedText,
} from "./list.js?v=8486b68304";

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
    const res = await fetch("songs.json?v=8486b68304", { cache: "no-cache" });
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
  $("updated").textContent = `${formatDate(data.generated_at)} 更新`;
  // 読み直して描き直しても、見ていた位置から動かさない
  const scrollY = window.scrollY;
  renderVoice();
  renderLabels();
  render();
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
  document.querySelector(`#songs [data-id="${id}"]`)?.focus();
});

// シートの外側（暗い部分）を押したら閉じる。シートの中を押したときは対象が中の要素になる
detail.addEventListener("click", (event) => {
  if (event.target === detail) {
    closeDetail();
  }
});

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
        ...(song.artist ? [el("p", { className: "detail-artist" }, song.artist)] : []),
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
