// 曲の一覧の処理（閲覧ページと管理画面で共用。DOM に依存しないので node --test で確かめる）
// docs/design.md 4.9（検索）・4.16（閲覧ページ）

// ---- キーの表示 ----

/** calcKey の結果を、キーの文字（"+4"、0 は "原キー"、計算不能は "?"）と注記（"1オクターブ下" など）に分ける */
export function keyParts({ key, octaveDown, overridden, outOfRange }) {
  if (key == null) {
    return { text: "?", notes: [], outOfRange: false };
  }
  const text = key > 0 ? `+${key}` : key < 0 ? `−${-key}` : "原キー";
  const notes = [];
  if (octaveDown) {
    notes.push("1オクターブ下");
  }
  if (overridden) {
    notes.push("指定");
  }
  if (outOfRange) {
    notes.push("範囲外");
  }
  return { text, notes, outOfRange: Boolean(outOfRange) };
}

/** calcKey の結果を1行の文字列にする（例："+4（1オクターブ下）"） */
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

// ---- ラベルの色 ----

/** 背景色（#rrggbb）の上で読みやすい文字の色（黒か白） */
export function textColorFor(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  // 相対輝度（WCAG）
  const linear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  // 白・黒それぞれとのコントラストが高いほうを選ぶ
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#000000" : "#ffffff";
}
