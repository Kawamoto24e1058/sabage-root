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
  spawnPoints?: SpawnPoint[];       // 仮想マップのキャリブレーション用スポーン地点
  virtualBoundary?: VirtualPoint[]; // AI検出フィールド外周（画像座標 0-1）
  obstacles?: ObstacleLine[];        // AI検出障害物（画像座標 0-1）
}

export type MatchStatus = 'waiting' | 'playing' | 'finished';

export interface Match {
  id?: string; // Firestore document ID
  fieldId: string;
  createdAt: number; // Unix timestamp
  status: MatchStatus;
}

export interface HitEvent extends GeoPoint {
  timestamp: number; // ヒットした瞬間の Unix timestamp
}

export interface PlayerLog {
  id?: string; // Firestore document ID (playerId / UID)
  name: string;
  teamColor: string; // hex or color name
  team?: 'A' | 'B';  // チーム分け
  route: RoutePoint[];
  lastPosition?: RoutePoint; // リアルタイムライブ表示用の最新位置
  hitEvent?: HitEvent; // ヒット（死亡）した場合のみ存在
  spawnId?: string;
}
