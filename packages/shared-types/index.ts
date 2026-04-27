export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RoutePoint extends GeoPoint {
  timestamp: number; // Unix timestamp
}

export interface MapImage {
  url: string;
}

// 画像上の正規化座標点（左上=0,0 / 右下=1,1）
export interface VirtualPoint {
  x: number;
  y: number;
}

// AI検出された障害物（線分）
export interface ObstacleLine {
  points: VirtualPoint[];
}

// フィールド画像上のスポーン地点（正規化座標 0-1）
export interface SpawnPoint {
  id: string;     // 'spawn-a', 'spawn-b' など
  label: string;  // 'チームAスポーン' など
  x: number;      // 画像左端=0, 右端=1
  y: number;      // 画像上端=0, 下端=1
}

// 当日プレイヤーがスポーンで記録したGPS（Firestoreサブコレクション）
export interface CalibrationPoint {
  id?: string;
  spawnId: string;   // SpawnPoint.id に対応
  lat: number;
  lng: number;
  recordedAt: number;
  playerUid: string;
}

export interface Field {
  id?: string; // Firestore document ID
  name: string;
  boundary: GeoPoint[];
  mapImage?: MapImage;
  spawnPoints?: SpawnPoint[];
  virtualBoundary?: VirtualPoint[];
  obstacles?: ObstacleLine[];
  fieldWidthMeters?: number; // フィールドの実際の横幅(m) — 1点キャリブレーション用
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
