// 音高変換とキー計算（docs/design.md 4.1・4.4）
// 閲覧ページと管理画面で共用する。

// 段：lowlow=−1, low=0, mid1=1, mid2=2, hi=3, hihi=4
const TIERS = ["lowlow", "low", "mid1", "mid2", "hi", "hihi"];
const TIER_BASE = -1;
// 音名：A=0, A#=1, B=2, C=3 … G#=11
const NAMES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"];

export const MIN_MIDI = 21; // lowlowA
export const MAX_MIDI = 92; // hihiG#

// 長い段名を先に試す（lowlow を low、hihi を hi と読まないため）
const NOTE_PATTERN = /^(lowlow|low|mid1|mid2|hihi|hi)([a-g]#?)$/;

/** "hiA" などの文字列を MIDI 番号にする。読み取れない入力はエラー。 */
export function noteToMidi(text) {
  if (typeof text !== "string") {
    throw new TypeError(`音高を読み取れません: ${JSON.stringify(text)}`);
  }
  const normalized = text
    .normalize("NFKC") // 全角英数字・＃・全角空白を半角に
    .replace(/♯/g, "#")
    .replace(/\s/g, "")
    .toLowerCase();
  const match = NOTE_PATTERN.exec(normalized);
  const nameIndex = match ? NAMES.indexOf(match[2].toUpperCase()) : -1;
  if (nameIndex < 0) {
    throw new Error(`音高を読み取れません: ${JSON.stringify(text)}`);
  }
  const tier = TIERS.indexOf(match[1]) + TIER_BASE;
  return 33 + tier * 12 + nameIndex;
}

/** MIDI 番号を "hiA" などの文字列にする。範囲外・整数でない値はエラー。 */
export function midiToNote(midi) {
  if (!Number.isInteger(midi) || midi < MIN_MIDI || midi > MAX_MIDI) {
    throw new RangeError(`音高の範囲外です（${MIN_MIDI}〜${MAX_MIDI}）: ${JSON.stringify(midi)}`);
  }
  const offset = midi - 33;
  const tier = Math.floor(offset / 12);
  const nameIndex = offset - tier * 12;
  return TIERS[tier - TIER_BASE] + NAMES[nameIndex];
}

/**
 * 原曲に対するキーを求める（4.4）。
 * 声の match_by が "min" なら最低音で、それ以外は最高音で合わせる（4.4.1）。
 * voice・song・settings はエクスポート形式（4.8）と同じ項目名で受け取る。
 * @returns {{ key: number|null, octaveDown: boolean, octaveUp: boolean, overridden: boolean, outOfRange: boolean }}
 *   key が null なら計算不能（画面では「?」と表示する）
 *   outOfRange は最終キーが ±key_range を超えているか（キーの値は変えず、画面で印を出す）
 */
export function calcKey(voice, song, settings) {
  // 1. キー指定があればそれを最終キーとする（微調整は無視）
  if (song.key_override != null) {
    const key = song.key_override;
    return { key, octaveDown: false, octaveUp: false, overridden: true, outOfRange: isOutOfRange(key, settings) };
  }
  // 2〜3. 合わせる音で、微調整の前のキーを決める（計算できなければ null）
  const base = voice.match_by === "min" ? matchMin(voice, song, settings) : matchMax(voice, song, settings);
  if (base == null) {
    return { key: null, octaveDown: false, octaveUp: false, overridden: false, outOfRange: false };
  }
  // 4. 微調整を加える
  const key = base.key + (song.key_adjust ?? 0);
  return { key, octaveDown: base.octaveDown, octaveUp: base.octaveUp, overridden: false, outOfRange: isOutOfRange(key, settings) };
}

/** 最高音で合わせる（4.4 の 2・3） */
function matchMax(voice, song, { key_range: keyRange, raise_if_room: raiseIfRoom }) {
  if (song.max_note == null || voice.max_note == null) {
    return null;
  }
  const d = voice.max_note - song.max_note;
  if (d >= 0) {
    return { key: raiseIfRoom ? Math.min(d, keyRange) : 0, octaveDown: false, octaveUp: false };
  }
  if (d >= -keyRange) {
    return { key: d, octaveDown: false, octaveUp: false };
  }
  return { key: d + 12, octaveDown: true, octaveUp: false };
}

/**
 * 最低音で合わせる声（4.4.1）：最高音が出ることを優先し、できれば最低音も出す。
 * オクターブ（そのまま・1つ上・1つ下）とキーの組み合わせから選ぶ。raise_if_room は使わない。
 */
function matchMin(voice, song, { key_range: keyRange }) {
  if (song.min_note == null || voice.min_note == null) {
    return null;
  }
  // 曲か声の最高音が分からなければ、最高音の条件は満たすものとして扱う
  const topKnown = song.max_note != null && voice.max_note != null;
  const fitsTop = (shift) => !topKnown || song.max_note + shift <= voice.max_note;
  const fitsLow = (shift) => song.min_note + shift >= voice.min_note;
  const result = (key, octave) => ({ key, octaveDown: octave < 0, octaveUp: octave > 0 });

  // a. 最高音も最低音も出るずらし方：オクターブはそのまま → 上 → 下、その中でキーは 0 に近い順
  const keys = [0];
  for (let k = 1; k <= keyRange; k += 1) {
    keys.push(-k, k);
  }
  for (const octave of [0, 1, -1]) {
    const key = keys.find((k) => fitsTop(octave * 12 + k) && fitsLow(octave * 12 + k));
    if (key !== undefined) {
      return result(key, octave);
    }
  }
  // b. 両方は無理：最高音を優先して、最高音にぴったり合わせる（届かなければ1オクターブ下、それでも届かなければ範囲外）
  if (!topKnown) {
    // 最低音が 1オクターブ＋key_range より下：最低音に合わせて1オクターブ上（範囲外）
    return result(voice.min_note - song.min_note - 12, 1);
  }
  const room = voice.max_note - song.max_note;
  if (room >= -keyRange) {
    return result(Math.min(room, keyRange), 0);
  }
  return result(room + 12, -1);
}

/** キーがカラオケで変えられる範囲（±key_range）を超えているか */
function isOutOfRange(key, settings) {
  return Math.abs(key) > settings.key_range;
}
