export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RoutePoint extends GeoPoint {
  timestamp: number; // Unix timestamp
}

// フィールド画像上のスポーン地点（GPS座標）
export interface SpawnPoint {
  id: string;     // 'spawn-a', 'spawn-b' など
  label: string;  // 'チームAスポーン' など
  lat: number;
  lng: number;
}

export interface Field {
  id?: string; // Firestore document ID
  name: string;
  boundary: GeoPoint[];      // フィールド外周（GPS座標列）
  spawnPoints?: SpawnPoint[];
}

// サバゲーイベント（1日の開催単位）
export interface GameEvent {
  id?: string;
  name: string;       // 例: "第1回〇〇サバゲー"
  date: number;       // 開催日 Unix timestamp
  fieldId: string;    // 関連 Field ドキュメント ID
  createdAt: number;
}

export type MatchStatus = 'waiting' | 'playing' | 'finished';

// ゲームモード
// elimination      : 死んだら終わり（デフォルト）
// unlimited_respawn: 何度でも復活
// timed_respawn    : 一定秒後に復活
export type GameMode = 'elimination' | 'unlimited_respawn' | 'timed_respawn';

export interface TeamConfig {
  id: string;   // 'A' 'B' 'C' ...
  name: string; // 表示名
}

export interface Match {
  id?: string;
  fieldId: string;
  eventId?: string;   // 属するイベント ID
  createdAt: number;
  status: MatchStatus;
  gameMode?: GameMode;
  teams?: TeamConfig[];
  respawnCooldownSec?: number; // timed_respawn の待機秒数
}

export interface HitEvent extends GeoPoint {
  timestamp: number;
}

export interface PlayerLog {
  id?: string;
  name: string;
  teamColor: string;
  team?: string;        // チームid ('A' 'B' 'C' ...)
  route: RoutePoint[];
  lastPosition?: RoutePoint;
  hitEvent?: HitEvent;  // 後方互換: 最後のヒット
  hitEvents?: HitEvent[]; // 複数ヒット（復活あり試合）
  spawnId?: string;
  lives?: number;       // 残機（elimination以外）
}
