// 曲の一覧の処理（閲覧ページと管理画面で共用。DOM に依存しないので node --test で確かめる）
// docs/design.md 4.9（検索）・4.16（閲覧ページ）・4.3.1（声の選択と調整）

import { MIN_MIDI, MAX_MIDI } from "./keycalc.js?v=45f8aa1430";

// ---- キーの表示 ----

/**
 * calcKey の結果を、キーの文字（"+4"、0 は "原キー"、計算不能は "?"）、注記（"指定"・"範囲外"）、
 * オクターブ（画面ではキーの右に矢印の印を出す。4.4.1）に分ける
 */
export function keyParts({ key, octaveDown, octaveUp, overridden, outOfRange }) {
  if (key == null) {
    return { text: "?", notes: [], octave: null, outOfRange: false };
  }
  const text = key > 0 ? `+${key}` : key < 0 ? `−${-key}` : "原キー";
  const octave = octaveDown
    ? { direction: "down", label: "1オクターブ下" }
    : octaveUp
      ? { direction: "up", label: "1オクターブ上" }
      : null;
  const notes = [];
  if (overridden) {
    notes.push("指定");
  }
  if (outOfRange) {
    notes.push("範囲外");
  }
  return { text, notes, octave, outOfRange: Boolean(outOfRange) };
}

/** calcKey の結果を1行の文字列にする（例："−8（範囲外）"。オクターブは含めない：画面で印を出す） */
export function formatKey(result) {
  const { text, notes } = keyParts(result);
  return text + notes.map((note) => `（${note}）`).join("");
}

// ---- 検索 ----

/** ひらがな／カタカナ、全角／半角、大文字／小文字、空白を区別しない形にする */
export function normalizeForSearch(text) {
  return text
    .normalize("NFKC") // 全角英数字・半角カタカナをそろえる
    .toLowerCase()
    .replace(/\s/g, "")
    .replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60)); // カタカナ → ひらがな
}

const SEARCH_FIELDS = ["title", "title_kana", "artist", "artist_kana"];

/** 曲名・アーティスト・それぞれの読みのどれかに検索語が含まれるか */
export function matchesSearch(song, query) {
  const q = normalizeForSearch(query);
  return q === "" || SEARCH_FIELDS.some((name) => song[name] && normalizeForSearch(song[name]).includes(q));
}

// ---- ラベルの絞り込み ----

/** 選んだラベルがすべて付いている曲だけを返す（何も選ばなければすべて） */
export function filterByLabels(songs, labelIds) {
  return songs.filter((song) => labelIds.every((id) => song.label_ids.includes(id)));
}

// ---- 並び替え ----

const collator = new Intl.Collator("ja");

// 並び替えの項目と、最初にタップしたときの向き
const SORTS = {
  id: { desc: true, compare: (a, b) => a.id - b.id },
  title: { desc: false, compare: (a, b) => collator.compare(a.title_kana || a.title, b.title_kana || b.title) },
  artist: {
    desc: false,
    compare: (a, b) => collator.compare(a.artist_kana || a.artist || "", b.artist_kana || b.artist || ""),
  },
  max_note: { desc: true, compare: (a, b) => a.max_note - b.max_note, missing: (song) => song.max_note == null },
};

export const DEFAULT_SORT = { key: "id", desc: true };

/** 並び替えた新しい配列を返す。値が空の曲は向きによらず最後、同じ値なら新しい順。 */
export function sortSongs(songs, { key, desc }) {
  const { compare, missing = () => false } = SORTS[key];
  return [...songs].sort((a, b) => {
    if (missing(a) !== missing(b)) {
      return missing(a) ? 1 : -1;
    }
    const order = missing(a) ? 0 : compare(a, b) * (desc ? -1 : 1);
    return order || b.id - a.id;
  });
}

/** ボタンを押したあとの並び順。同じ項目なら逆順、別の項目ならその項目の最初の向き。 */
export function nextSort(current, key) {
  if (current.key === key) {
    return { key, desc: !current.desc };
  }
  return { key, desc: SORTS[key].desc };
}

export function isSortKey(key) {
  return Object.hasOwn(SORTS, key);
}

// ---- 声の選択と調整（4.3.1） ----
// 選択は { voiceId, offsets: { max_note, min_note } }（選んでいなければ null）。ブラウザに覚えさせる形と同じ。

export const VOICE_ADJUST_LIMIT = 6;
const ADJUST_FIELDS = ["max_note", "min_note"];

const noOffsets = () => Object.fromEntries(ADJUST_FIELDS.map((field) => [field, 0]));
const findVoice = (voices, choice) => (choice ? voices.find((voice) => voice.id === choice.voiceId) : undefined);

/** 覚えていた選択を、今の声の一覧に合わせて読み込む（声がなくなっていれば null、変な調整は 0） */
export function restoreVoiceChoice(saved, voices) {
  if (!saved || typeof saved !== "object" || !saved.offsets || typeof saved.offsets !== "object") {
    return null;
  }
  if (!findVoice(voices, saved)) {
    return null;
  }
  const offsets = noOffsets();
  for (const field of ADJUST_FIELDS) {
    const value = saved.offsets[field];
    if (Number.isInteger(value) && Math.abs(value) <= VOICE_ADJUST_LIMIT) {
      offsets[field] = value;
    }
  }
  return { voiceId: saved.voiceId, offsets };
}

/** 声を選ぶ。別の声に切り替えたら調整は 0 に戻す */
export function selectVoice(choice, voiceId) {
  if (choice && choice.voiceId === voiceId) {
    return choice;
  }
  return { voiceId, offsets: noOffsets() };
}

/** field（max_note・min_note）を delta だけ動かせるか（±6 まで、音高の範囲内、声の値が空なら不可） */
export function canAdjust(choice, voices, field, delta) {
  const base = findVoice(voices, choice)?.[field];
  if (base == null) {
    return false;
  }
  const offset = choice.offsets[field] + delta;
  return Math.abs(offset) <= VOICE_ADJUST_LIMIT && base + offset >= MIN_MIDI && base + offset <= MAX_MIDI;
}

/** field を delta だけ動かした新しい選択（動かせなければそのまま） */
export function adjustVoice(choice, voices, field, delta) {
  if (!canAdjust(choice, voices, field, delta)) {
    return choice;
  }
  return { ...choice, offsets: { ...choice.offsets, [field]: choice.offsets[field] + delta } };
}

export function isAdjusted(choice) {
  return Boolean(choice) && ADJUST_FIELDS.some((field) => choice.offsets[field] !== 0);
}

/** 調整を 0 に戻す（声は残す） */
export function resetAdjust(choice) {
  return { ...choice, offsets: noOffsets() };
}

/** 調整したあとの声（最高音・最低音と、合わせる音。選んでいなければ null） */
export function adjustedVoice(choice, voices) {
  const voice = findVoice(voices, choice);
  if (!voice) {
    return null;
  }
  return {
    ...Object.fromEntries(
      ADJUST_FIELDS.map((field) => [field, voice[field] == null ? null : voice[field] + choice.offsets[field]]),
    ),
    match_by: voice.match_by,
  };
}

/** 調整の差の表示（"（+2）"、0 なら ""） */
export function formatOffset(offset) {
  if (offset === 0) {
    return "";
  }
  return offset > 0 ? `（+${offset}）` : `（−${-offset}）`;
}

// ---- ラベルの色 ----

/** ラベルの札の色（色付きはその色で塗り、文字は読みやすい色に。色がなければ ""） */
export function labelStyle(label) {
  return label.color ? `background: ${label.color}; color: ${textColorFor(label.color)}; border-color: ${label.color}` : "";
}

/** 背景色（#rrggbb）の上で読みやすい文字の色（黒か白） */
export function textColorFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  // 相対輝度（WCAG）
  const linear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  // 白・黒それぞれとのコントラストが高いほうを選ぶ
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
