// 曲の一覧の処理（閲覧ページと管理画面で共用。DOM に依存しないので node --test で確かめる）
// docs/design.md 4.9（検索）・4.16（閲覧ページ）・4.3.1（声の選択と調整）・4.16.1（曲の詳細）

import { MIN_MIDI, MAX_MIDI, midiToNote } from "./keycalc.js?v=b2a1ae28e8";

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

/** 開いたときに最初から選んでおくラベルの ID（表示順） */
export function preselectedLabelIds(labels) {
  return labels
    .filter((label) => label.preselected === true)
    .sort((a, b) => a.order - b.order)
    .map((label) => label.id);
}

// ---- 並び替え ----

const collator = new Intl.Collator("ja");

// ---- アーティストの絞り込み ----

/** 選んだアーティストのどれかの曲だけを返す（何も選ばなければすべて） */
export function filterByArtists(songs, artists) {
  return artists.length === 0 ? songs : songs.filter((song) => artists.includes(song.artist));
}

// アーティストの一覧の並び替えの項目と、最初にタップしたときの向き（Issue #14）。value が空のものは向きによらず最後
const ARTIST_SORTS = {
  count: { desc: true, value: (artist) => artist.count },
  artist: { desc: false, value: null },
  latest: { desc: true, value: (artist) => artist.latest_id },
  max_note: { desc: true, value: (artist) => artist.max_note },
};

export const DEFAULT_ARTIST_SORT = { key: "count", desc: true };

/** 読み順（読みがなければ名前。読みが同じなら名前） */
const compareArtistKana = (a, b) => collator.compare(a.kana || a.name, b.kana || b.name) || collator.compare(a.name, b.name);

/**
 * アーティストの一覧。曲数・一番高い最高音・一番新しい曲は counted（ラベルで絞り込んだ曲）で決め、
 * 0 曲のアーティストは出さない。genders を選ぶと、counted の中にその性別のどれかの曲があるアーティストだけにする
 * （曲数は性別では減らさない。null は未設定）。選んでいるアーティストはどちらでも残す（外せるように）。
 * 並びは sort（省略すると読み順）。同じ値なら読み順で、ここは向きによらない。
 */
export function artistOptions(songs, counted, selected, { genders = [], sort = { key: "artist", desc: false } } = {}) {
  const artists = new Map();
  for (const song of songs) {
    if (!song.artist) {
      continue;
    }
    const artist = artists.get(song.artist)
      ?? { name: song.artist, kana: "", count: 0, max_note: null, latest_id: null, latest_at: null, genders: new Set() };
    artist.kana ||= song.artist_kana || "";
    artists.set(song.artist, artist);
  }
  for (const song of counted) {
    const artist = artists.get(song.artist);
    if (!artist) {
      continue;
    }
    artist.count += 1;
    artist.genders.add(song.gender ?? null);
    if (song.max_note != null && (artist.max_note == null || song.max_note > artist.max_note)) {
      artist.max_note = song.max_note;
    }
    if (artist.latest_id == null || song.id > artist.latest_id) {
      artist.latest_id = song.id;
      artist.latest_at = song.created_at ?? null;
    }
  }
  const { value } = ARTIST_SORTS[sort.key];
  const direction = sort.desc ? -1 : 1;
  return [...artists.values()]
    .filter((artist) => selected.includes(artist.name)
      || (artist.count > 0 && (genders.length === 0 || genders.some((gender) => artist.genders.has(gender)))))
    .map(({ genders: _, ...artist }) => ({ ...artist, selected: selected.includes(artist.name) }))
    .sort((a, b) => {
      if (value == null) {
        return compareArtistKana(a, b) * direction;
      }
      const [va, vb] = [value(a), value(b)];
      if ((va == null) !== (vb == null)) {
        return va == null ? 1 : -1;
      }
      return (va == null ? 0 : (va - vb) * direction) || compareArtistKana(a, b);
    });
}

/** アーティストの一覧の並びを押したあと。同じ項目なら逆順、別の項目ならその項目の最初の向き */
export function nextArtistSort(current, key) {
  return current.key === key ? { key, desc: !current.desc } : { key, desc: ARTIST_SORTS[key].desc };
}

export function isArtistSortKey(key) {
  return Object.hasOwn(ARTIST_SORTS, key);
}

/** 並びの値として一覧に添える文字：登録順は「11/3 追加」、最高音は音名。ほかの並びと値が空なら "" */
export function artistSortValue(artist, key) {
  if (key === "latest" && artist.latest_at) {
    return `${Number(artist.latest_at.slice(5, 7))}/${Number(artist.latest_at.slice(8, 10))} 追加`;
  }
  if (key === "max_note" && artist.max_note != null) {
    return noteName(artist.max_note);
  }
  return "";
}

/** アーティストの一覧の検索：名前か読みに検索語が含まれるか（区別しないものは曲の検索と同じ） */
export function matchesArtistSearch(artist, query) {
  const q = normalizeForSearch(query);
  return q === "" || [artist.name, artist.kana].some((text) => text && normalizeForSearch(text).includes(q));
}

// ---- 性別の絞り込み ----

/** アーティストの性別（表示順）。songs.json の値と表示名 */
export const GENDERS = [
  { value: "male", name: "男性" },
  { value: "female", name: "女性" },
  { value: "other", name: "その他" },
];

/** 性別の表示名（未設定は null） */
export function genderName(value) {
  return GENDERS.find((gender) => gender.value === value)?.name ?? null;
}

/** 選んだ性別のどれかの曲だけを返す（何も選ばなければすべて）。null を選ぶと未設定の曲（管理画面） */
export function filterByGenders(songs, genders) {
  return genders.length === 0 ? songs : songs.filter((song) => genders.includes(song.gender ?? null));
}

/**
 * 検索語・ラベル・性別・アーティストをすべて満たす曲（ホーム画面の表示と、アーティストの「絞り込む」の曲数で使う）。
 * 性別の null は未設定の曲（管理画面）
 */
export function filterSongs(songs, { query = "", labelIds = [], genders = [], artists = [] } = {}) {
  const found = songs.filter((song) => matchesSearch(song, query));
  return filterByArtists(filterByGenders(filterByLabels(found, labelIds), genders), artists);
}

/** 読み直したデータにないアーティストは選択から外す */
export function keepKnownArtists(selected, songs) {
  return selected.filter((name) => songs.some((song) => song.artist === name));
}

// 並び替えの項目と、最初にタップしたときの向き
const SORTS = {
  id: { desc: false, compare: (a, b) => a.id - b.id },
  title: { desc: false, compare: (a, b) => collator.compare(a.title_kana || a.title, b.title_kana || b.title) },
  artist: {
    desc: false,
    compare: (a, b) => collator.compare(a.artist_kana || a.artist || "", b.artist_kana || b.artist || ""),
  },
  max_note: { desc: true, compare: (a, b) => a.max_note - b.max_note, missing: (song) => song.max_note == null },
};

export const DEFAULT_SORT = { key: "id", desc: false };

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

/** 調整したあとの声（最高音・最低音と、合わせる音・最高音の余裕・性別・女性の曲の余裕。選んでいなければ null） */
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
    top_margin: voice.top_margin ?? null,
    // 声の性別も元の声のまま（4.3.1。女性の声で女性の曲は引き上げない）
    gender: voice.gender ?? null,
    // 女性の曲の余裕も元の声のまま（4.4.2）
    female_margin: voice.female_margin ?? null,
  };
}

/** 調整の差の表示（"（+2）"、0 なら ""） */
export function formatOffset(offset) {
  if (offset === 0) {
    return "";
  }
  return offset > 0 ? `（+${offset}）` : `（−${-offset}）`;
}

// ---- 曲の詳細（4.16.1） ----

// 離れすぎの注記を出す基準（半音の数）
const LOW_WARN_GAP = 5;
const TOP_ROOM_GAP = 5;
const PITCH_FIELDS = ["max_note", "min_note", "max_chest", "max_falsetto"];

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : "0");
const keyText = (key) => (key === 0 ? "原キー" : signed(key));
const hasVoiceRange = (voice) => voice.max_note != null && voice.min_note != null;

/** 実際に歌う高さへのずらし（キーにオクターブのずらしを足す。計算不能なら null） */
export function keyShift({ key, octaveDown, octaveUp }) {
  if (key == null) {
    return null;
  }
  return key + (octaveDown ? -12 : octaveUp ? 12 : 0);
}

/** 曲の音（最高音・最低音・地声・裏声）を shift だけずらす。空の項目は空のまま */
export function shiftNotes(song, shift) {
  return Object.fromEntries(PITCH_FIELDS.map((field) => [field, song[field] == null ? null : song[field] + shift]));
}

/**
 * 音域 { max_note, min_note } のうち、声の範囲から外れる区間（図で赤く塗る）。
 * 片方の端が空なら、ある方の音1つで判定する。声の最高音か最低音が空なら判定しない。
 */
export function outsideVoice(range, voice) {
  if (!hasVoiceRange(voice)) {
    return [];
  }
  const low = range.min_note ?? range.max_note;
  const high = range.max_note ?? range.min_note;
  if (low == null) {
    return [];
  }
  const parts = [];
  if (low < voice.min_note) {
    parts.push({ side: "low", from: low, to: Math.min(high, voice.min_note - 1), count: voice.min_note - low });
  }
  if (high > voice.max_note) {
    parts.push({ side: "high", from: Math.max(low, voice.max_note + 1), to: high, count: high - voice.max_note });
  }
  return parts;
}

/** 離れすぎの注記（このキーで歌ったときの音域を声と比べる。声の最高音か最低音が空なら出さない） */
export function rangeWarnings(sung, voice) {
  if (!hasVoiceRange(voice)) {
    return [];
  }
  const warnings = [];
  if (sung.max_note != null && sung.max_note > voice.max_note) {
    warnings.push(`最高音が声より${sung.max_note - voice.max_note}高い`);
  }
  if (sung.min_note != null && voice.min_note - sung.min_note >= LOW_WARN_GAP) {
    warnings.push(`最低音が声より${voice.min_note - sung.min_note}低い`);
  }
  if (sung.max_note != null && voice.max_note - sung.max_note >= TOP_ROOM_GAP) {
    warnings.push(`最高音まで${voice.max_note - sung.max_note}余裕がある`);
  }
  return warnings;
}

/** 図の横の範囲（出す音の一番低い音の3つ下から、一番高い音の3つ上まで。音がなければ null） */
export function chartBounds(notes) {
  const known = notes.filter((note) => note != null);
  if (known.length === 0) {
    return null;
  }
  return { lo: Math.min(...known) - 3, hi: Math.max(...known) + 3 };
}

/** キーの内訳（"原キー・微調整 −1"）。微調整がない・計算不能・キー指定なら null */
export function keyBreakdown({ key, overridden }, keyAdjust) {
  if (key == null || overridden || !keyAdjust) {
    return null;
  }
  return `${keyText(key - keyAdjust)}・微調整 ${signed(keyAdjust)}`;
}

/** どの声で計算したか（"男性（最高音 +2）で計算"。調整している項目だけ添える） */
export function voiceUsedText(name, offsets) {
  const parts = [["最高音", offsets.max_note], ["最低音", offsets.min_note]]
    .filter(([, offset]) => offset !== 0)
    .map(([label, offset]) => `${label} ${signed(offset)}`);
  return parts.length === 0 ? `${name}で計算` : `${name}（${parts.join("・")}）で計算`;
}

/** 音名（キーでずらして音高の範囲 21〜92 の外に出た音は "?"） */
export function noteName(midi) {
  return midi >= MIN_MIDI && midi <= MAX_MIDI ? midiToNote(midi) : "?";
}

/** 音域の文字（"lowD〜hiA"。片方だけならどちらの音かを書く。両方空なら null） */
export function formatRange(min, max) {
  if (min != null && max != null) {
    return `${noteName(min)}〜${noteName(max)}`;
  }
  if (max != null) {
    return `最高音 ${noteName(max)}`;
  }
  if (min != null) {
    return `最低音 ${noteName(min)}`;
  }
  return null;
}

/** 日時（ISO 8601）の日付だけ */
export function formatDay(iso) {
  return iso.slice(0, 10);
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

// ---- 下から出るシートを、つまみを引いて閉じる（Issue #17） ----

// 閉じるのに下げる距離（px。シートの高さの 1/4 のほうが小さければそちら）と、払ったとみなす速さ（px/ms）と距離
const SHEET_CLOSE_DISTANCE = 120;
const SHEET_FLICK_VELOCITY = 0.5;
const SHEET_FLICK_DISTANCE = 24;

/** 引いている間にシートを下げる量（上には動かさない） */
export function sheetDragOffset(dy) {
  return Math.max(0, dy);
}

/** 指を離したときに閉じるか戻すか。dy は下げた距離、velocity は離す直前の下向きの速さ（px/ms） */
export function sheetDragResult({ dy, height, velocity }) {
  if (dy > 0 && dy >= Math.min(SHEET_CLOSE_DISTANCE, height / 4)) {
    return "close";
  }
  if (dy >= SHEET_FLICK_DISTANCE && velocity >= SHEET_FLICK_VELOCITY) {
    return "close";
  }
  return "back";
}

// ---- アーティストのシートを、つまみを上に引いて広げる（Issue #18） ----
// 位置はシートの上端の、画面の上からの距離（px）で表す。止まるのは「今の大きさ」「広げた大きさ」の2段

/** 引いている間のシートの上端。指について上下に動き、広げた大きさより上には動かさない */
export function stretchSheetTop({ startTop, dy, expandedTop }) {
  return Math.max(expandedTop, startTop + dy);
}

/**
 * 指を離したときに "expanded"（広げる）・"normal"（今の大きさ）・"close"（閉じる）のどれにするか。
 * from は引き始めの大きさ、top は離したときの上端、dy は指を動かした距離（下が正）、velocity は離す直前の速さ（px/ms。下が正）。
 * normalTop・expandedTop はそれぞれの大きさのときの上端、normalHeight は今の大きさのときの高さ。
 */
export function stretchSheetResult({ from, top, dy, velocity, normalTop, expandedTop, normalHeight }) {
  // 閉じる線は画面の上での位置で決める（広げていても同じ線。今の大きさから 120px か高さの 1/4 下げたところ）
  if (top >= normalTop + Math.min(SHEET_CLOSE_DISTANCE, normalHeight / 4)) {
    return "close";
  }
  // 下に速く払ったら1段下げる。今の大きさより 24px 以上下げていれば閉じる
  if (dy >= SHEET_FLICK_DISTANCE && velocity >= SHEET_FLICK_VELOCITY) {
    return top >= normalTop + SHEET_FLICK_DISTANCE ? "close" : "normal";
  }
  // 上に速く払ったら広げる（今の大きさより下から払ったときは、今の大きさに戻す）
  if (dy <= -SHEET_FLICK_DISTANCE && velocity <= -SHEET_FLICK_VELOCITY) {
    return top <= normalTop ? "expanded" : "normal";
  }
  if (top >= normalTop) {
    return "normal";
  }
  // 今の大きさからは差の 1/3 上げたら広げる。広げた状態からは近いほうに戻る
  const span = normalTop - expandedTop;
  const line = from === "expanded" ? expandedTop + span / 2 : normalTop - span / 3;
  return top <= line ? "expanded" : "normal";
}

// ---- 絞り込みを隠しているときの表示（Issue #15） ----

/** かかっている絞り込みを短く：性別（男性・女性・その他の順）、ラベル（表示順）、「アーティスト n」を「・」でつなぐ。なければ "" */
export function filterSummary({ genders, labelIds, artists }, labels) {
  const parts = [
    ...GENDERS.filter((gender) => genders.includes(gender.value)).map((gender) => gender.name),
    ...labels.filter((label) => labelIds.includes(label.id)).sort((a, b) => a.order - b.order).map((label) => label.name),
  ];
  if (artists.length > 0) {
    parts.push(`アーティスト ${artists.length}`);
  }
  return parts.join("・");
}

/** ボタンの丸に出す数：選んでいる性別・ラベル・アーティストの数の合計（並び替えは数えない） */
export function activeFilterCount({ genders, labelIds, artists }) {
  return genders.length + labelIds.length + artists.length;
}
