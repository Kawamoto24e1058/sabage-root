<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { db } from '$lib/firebase';
	import { collection, onSnapshot, doc, getDoc, getDocs, updateDoc } from 'firebase/firestore';
	import type { PlayerLog, Field, Match, MatchStatus, SpawnPoint, VirtualPoint, ObstacleLine, GameMode, TeamConfig } from 'shared-types';
	import { Play, Pause, RotateCcw, FastForward, ArrowLeft, Circle, QrCode, BarChart2, Flame } from 'lucide-svelte';

	// Leaflet types
	let L: any;
	let map: any;
	let mapElement: HTMLElement;
	let playerLayers: Record<string, { polyline: any; marker: any; hitMarker: any | null }> = {};
	let heatLayer: any = null;
	let fieldLayer: any;

	// Match / Replay state
	let matchId = page.params.matchId;
	let match = $state<Match | null>(null);
	let logs = $state<PlayerLog[]>([]);
	let field = $state<Field | null>(null);
	let noBoundary = $state(false);
	let startTime = $state(0);
	let endTime = $state(0);
	let currentTime = $state(0);
	let isPlaying = $state(false);
	let playbackSpeed = $state(1);
	let timer: number;
	let updatingStatus = $state(false);

	// Live / Replay モード
	let viewMode = $state<'live' | 'replay'>('live');

	// モーダル
	let showQR = $state(false);
	let showStats = $state(false);
	let showHeatmap = $state(false);
	let joinPanelDismissed = $state(false);

	// 待機中は参加パネルを表示（dismissするまで）
	$effect(() => {
		if (match?.status === 'waiting' && !joinPanelDismissed) {
			showQR = false; // QRモーダルは使わない（パネルで代替）
		}
	});

	// 仮想マップ
	let useVirtualMap = $state(false);
	let calibStatus = $state<'none' | 'no-spawns' | 'loading' | 'ready' | 'insufficient'>('none');
	let currentFieldId = $state('');
	// GPS(lat,lng) → Leaflet CRS.Simple の [y,x] ピクセル座標
	let gpsTransform: ((lat: number, lng: number) => [number, number]) | null = null;
	// スポーン地点（フォールバック表示用）
	let spawnPointsState = $state<SpawnPoint[]>([]);
	let virtualImgW = $state(1000);
	let virtualImgH = $state(1000);

	let unsubscribeLogs: () => void;
	let unsubscribeMatch: () => void;

	// ─── アフィン変換（2点以上のキャリブレーションから計算）───────────────
	interface CalibPair { lat: number; lng: number; px: number; py: number; }

	function buildGpsTransform(pairs: CalibPair[]): ((lat: number, lng: number) => [number, number]) | null {
		if (pairs.length < 2) return null;

		// 最も離れた2点ペアを選ぶ（精度最大化）
		let best = { i: 0, j: 1, dist: 0 };
		for (let i = 0; i < pairs.length; i++) {
			for (let j = i + 1; j < pairs.length; j++) {
				const dlat = pairs[j].lat - pairs[i].lat;
				const dlng = pairs[j].lng - pairs[i].lng;
				const d = dlat * dlat + dlng * dlng;
				if (d > best.dist) best = { i, j, dist: d };
			}
		}

		const p1 = pairs[best.i];
		const p2 = pairs[best.j];
		const dlat = p2.lat - p1.lat;
		const dlng = p2.lng - p1.lng;
		const dpx  = p2.px  - p1.px;
		const dpy  = p2.py  - p1.py;

		const denom = dlat * dlat + dlng * dlng;
		if (denom === 0) return null;

		// 相似変換: 回転 + スケール + 平行移動
		const a = (dpx * dlat + dpy * dlng) / denom;
		const b = (dpy * dlat - dpx * dlng) / denom;

		return (lat: number, lng: number): [number, number] => {
			const dl = lat - p1.lat;
			const dn = lng - p1.lng;
			const px = a * dl - b * dn + p1.px;
			const py = b * dl + a * dn + p1.py;
			return [py, px]; // Leaflet CRS.Simple: [lat=y, lng=x]
		};
	}

	// ─── 画像サイズをロード ──────────────────────────────────────────────
	function loadImageSize(url: string): Promise<{ w: number; h: number }> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
			img.onerror = reject;
			img.src = url;
		});
	}

	onMount(async () => {
		const leaflet = await import('leaflet');
		await import('leaflet/dist/leaflet.css');
		L = leaflet.default;

		// ① match ドキュメント取得
		const matchDoc = await getDoc(doc(db, 'matches', matchId));
		if (!matchDoc.exists()) return;
		match = { id: matchDoc.id, ...matchDoc.data() } as Match;

		const fieldId = match.fieldId;
		currentFieldId = fieldId ?? '';
		let spawnPoints: SpawnPoint[] = [];
		let mapImageUrl = '';

		if (fieldId) {
			const fieldDoc = await getDoc(doc(db, 'fields', fieldId));
			if (fieldDoc.exists()) {
				field = fieldDoc.data() as Field;
				spawnPoints = field.spawnPoints ?? [];
				spawnPointsState = spawnPoints; // $effect から参照できるよう保存
				mapImageUrl = field.mapImage?.url ?? '';
			}
		}

		// ② virtualBoundary または mapImage があれば仮想マップモード（CRS.Simple）を使う
		const vb = field?.virtualBoundary;
		const hasVirtualMap = (vb && vb.length >= 3) || mapImageUrl;

		if (hasVirtualMap) {
			// 座標系は virtualBoundary または mapImage のサイズから決める
			let imgW = 1000, imgH = 1000;
			if (mapImageUrl) {
				const size = await loadImageSize(mapImageUrl);
				imgW = size.w; imgH = size.h;
			} else if (vb && vb.length >= 3) {
				// virtualBoundary の正規化座標から仮の解像度を使う
				imgW = 1000; imgH = 1000;
			}
			useVirtualMap = true;
			virtualImgW = imgW;
			virtualImgH = imgH;

			map = L.map(mapElement, { crs: L.CRS.Simple, minZoom: -5, maxZoom: 5, attributionControl: false });

			// Leaflet CRS.Simple は y軸が反転（上=imgH, 下=0）なので (1-y)*imgH に変換
			const toL = (p: {x: number; y: number}): [number, number] => [(1 - p.y) * imgH, p.x * imgW];

			let fitTarget: any = null;

			if (vb && vb.length >= 3) {
				// フィールド外周：実線・塗りつぶし
				const poly = L.polygon(vb.map(toL), {
					color: '#4ade80',
					weight: 3,
					fillColor: '#4ade80',
					fillOpacity: 0.12,
				}).addTo(map);
				fitTarget = poly.getBounds();

				// 外周の外側に薄いグロー効果
				L.polygon(vb.map(toL), {
					color: '#4ade80',
					weight: 8,
					opacity: 0.08,
					fillOpacity: 0,
					interactive: false,
				}).addTo(map);
			} else {
				fitTarget = [[0, 0], [imgH, imgW]];
			}

			// 障害物は非表示（マップをシンプルに保つ）

			// スポーン地点マーカー
			spawnPoints.forEach((sp, i) => {
				const icon = L.divIcon({
					html: `<div style="
						width:30px;height:30px;border-radius:50%;
						background:rgba(10,10,10,0.9);
						border:2.5px solid #4ade80;
						color:#4ade80;font-size:13px;font-weight:700;
						display:flex;align-items:center;justify-content:center;
						box-shadow:0 0 0 4px rgba(74,222,128,0.15), 0 3px 10px rgba(0,0,0,0.7);
					">${i + 1}</div>`,
					iconSize: [30, 30], iconAnchor: [15, 15], className: '',
				});
				const m = L.marker(toL(sp), { icon }).addTo(map);
				m.bindTooltip(sp.label, {
					permanent: true, direction: 'top', offset: [0, -18],
					className: 'spawn-label-tip',
				});
			});

			if (fitTarget) map.fitBounds(fitTarget, { padding: [50, 50] });

			// GPS→ピクセル変換のキャリブレーションを試みる（スポーン地点が2点以上ある場合）
			if (spawnPoints.length < 2) {
				calibStatus = 'no-spawns';
			} else if (spawnPoints.length >= 2) {
				calibStatus = 'loading';
				try {
					const calibSnap = await getDocs(collection(db, 'matches', matchId, 'calibrations'));
					const calibDocs = calibSnap.docs.map(d => d.data() as { spawnId: string; lat: number; lng: number });

					const spawnGPS: Record<string, { lats: number[]; lngs: number[] }> = {};
					calibDocs.forEach(c => {
						if (!spawnGPS[c.spawnId]) spawnGPS[c.spawnId] = { lats: [], lngs: [] };
						spawnGPS[c.spawnId].lats.push(c.lat);
						spawnGPS[c.spawnId].lngs.push(c.lng);
					});

					const calibPairs: CalibPair[] = spawnPoints
						.filter(sp => spawnGPS[sp.id]?.lats.length > 0)
						.map(sp => {
							const lats = spawnGPS[sp.id].lats;
							const lngs = spawnGPS[sp.id].lngs;
							return {
								lat: lats.reduce((a, b) => a + b, 0) / lats.length,
								lng: lngs.reduce((a, b) => a + b, 0) / lngs.length,
								px: sp.x * imgW,
								py: (1 - sp.y) * imgH, // Leaflet y軸反転補正
							};
						});

					if (calibPairs.length >= 2) {
						gpsTransform = buildGpsTransform(calibPairs);
						calibStatus = 'ready';
					} else {
						calibStatus = 'insufficient';
					}
				} catch (e) {
					console.warn('Calibration load failed:', e);
					calibStatus = 'insufficient';
				}
			}
		}

		// キャリブレーション不足 or 仮想マップ不可 → 通常リアルマップ
		if (!useVirtualMap) {
			map = L.map(mapElement).setView([35.6812, 139.7671], 15);
			L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
				attribution: '&copy; OpenStreetMap &copy; CARTO'
			}).addTo(map);

			if (field?.boundary && field.boundary.length >= 3) {
				const latLngs = field.boundary.map(p => [p.lat, p.lng] as [number, number]);
				fieldLayer = L.polygon(latLngs, {
					color: '#4ade80',
					fillColor: '#4ade80',
					fillOpacity: 0.1,
					weight: 2,
					dashArray: '5, 5'
				}).addTo(map);
				map.fitBounds(fieldLayer.getBounds());
			} else {
				noBoundary = true;
			}

			if (mapImageUrl && field?.mapImage) {
				// フォールバック: 境界線に基づくオーバーレイ（旧方式）
				if (field.boundary && field.boundary.length >= 2) {
					const lats = field.boundary.map(p => p.lat);
					const lngs = field.boundary.map(p => p.lng);
					const imgBounds: [[number, number], [number, number]] = [
						[Math.min(...lats), Math.min(...lngs)],
						[Math.max(...lats), Math.max(...lngs)],
					];
					L.imageOverlay(mapImageUrl, imgBounds, { opacity: 0.6 }).addTo(map);
					if (!fieldLayer) map.fitBounds(imgBounds, { padding: [40, 40] });
				}
			}
		}

		// ③ match リアルタイム購読
		unsubscribeMatch = onSnapshot(doc(db, 'matches', matchId), (snap) => {
			if (snap.exists()) {
				match = { id: snap.id, ...snap.data() } as Match;
				// 試合終了ならReplayモードへ自動切替
				if (match.status === 'finished' && viewMode === 'live') {
					viewMode = 'replay';
					currentTime = startTime;
				}
			}
		});

		// ④ player_logs 購読
		const logsRef = collection(db, 'matches', matchId, 'player_logs');
		unsubscribeLogs = onSnapshot(logsRef, (snapshot) => {
			logs = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as PlayerLog));

			if (logs.length > 0) {
				const allTimestamps = logs.flatMap(l => l.route.map(p => p.timestamp));
				startTime = Math.min(...allTimestamps);
				endTime = Math.max(...allTimestamps);
				if (currentTime === 0) currentTime = startTime;

				// 実マップモードのみ: GPSで範囲フィット
				if (!useVirtualMap && map) {
					const allPoints = logs.flatMap(l => l.route.map(p => [p.lat, p.lng] as [number, number]));
					if (allPoints.length > 0) map.fitBounds(L.latLngBounds(allPoints));
				}
			}
		});
	});

	onDestroy(() => {
		if (unsubscribeLogs) unsubscribeLogs();
		if (unsubscribeMatch) unsubscribeMatch();
		stopPlayback();
	});

	// ─── 統計計算 ────────────────────────────────────────────────────────
	function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
		const R = 6371000;
		const dLat = (lat2 - lat1) * Math.PI / 180;
		const dLng = (lng2 - lng1) * Math.PI / 180;
		const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
		return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
	}

	function calcStats(player: PlayerLog) {
		const r = player.route;
		if (r.length < 2) return { distance: 0, duration: 0 };
		let dist = 0;
		for (let i = 1; i < r.length; i++) dist += haversineM(r[i-1].lat, r[i-1].lng, r[i].lat, r[i].lng);
		const hitTime = player.hitEvent?.timestamp;
		const end = hitTime ?? r[r.length - 1].timestamp;
		return { distance: Math.round(dist), duration: Math.round((end - r[0].timestamp) / 1000) };
	}

	// ─── ヒートマップ制御 ─────────────────────────────────────────────────
	async function toggleHeatmap() {
		if (!L || !map) return;
		if (heatLayer) {
			heatLayer.remove();
			heatLayer = null;
			showHeatmap = false;
			return;
		}
		// Leaflet.heat をCDNから動的ロード
		if (!(window as any).L?.heatLayer) {
			await new Promise<void>((resolve, reject) => {
				const s = document.createElement('script');
				s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.heat/0.2.0/leaflet-heat.js';
				s.onload = () => resolve();
				s.onerror = reject;
				document.head.appendChild(s);
			});
		}
		const points = logs.flatMap(p => p.route.map(r => {
			if (useVirtualMap && gpsTransform) {
				const [py, px] = gpsTransform(r.lat, r.lng);
				return [py, px, 1.0] as [number, number, number];
			}
			return [r.lat, r.lng, 1.0] as [number, number, number];
		}));
		heatLayer = (L as any).heatLayer(points, { radius: 22, blur: 15, maxZoom: 17 }).addTo(map);
		showHeatmap = true;
	}

	// ─── 座標変換ヘルパー ────────────────────────────────────────────────
	function toMapCoords(lat: number, lng: number): [number, number] {
		if (useVirtualMap && gpsTransform) return gpsTransform(lat, lng);
		return [lat, lng];
	}

	// プレイヤーマーカーDivIcon（名前ラベル付き）
	function makePlayerIcon(color: string, name: string, isHit = false) {
		return L.divIcon({
			html: `
				<div style="position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;">
					<div style="
						background:rgba(10,10,10,0.9);
						border:2.5px solid ${color};
						border-radius:50%;
						width:${isHit ? 20 : 24}px;height:${isHit ? 20 : 24}px;
						opacity:${isHit ? 0.45 : 1};
					"></div>
					<div style="
						background:rgba(10,10,10,0.82);
						border:1px solid ${color}88;
						color:${color};
						font-size:10px;font-weight:700;
						padding:1px 6px;border-radius:4px;
						white-space:nowrap;
					">${name}</div>
				</div>`,
			className: '',
			iconSize: [60, 44],
			iconAnchor: [30, 12],
		});
	}

	// レイヤーをすべてクリア（モード切替時）
	function clearPlayerLayers() {
		Object.values(playerLayers).forEach(l => {
			l.polyline?.remove();
			l.marker?.remove();
			l.hitMarker?.remove();
		});
		playerLayers = {};
	}

	// ─── Liveモード描画 $effect ──────────────────────────────────────────
	$effect(() => {
		if (!L || !map || viewMode !== 'live') return;

		logs.forEach(player => {
			const playerId = player.id;
			if (!playerId) return;

			const color = player.teamColor || '#ff0000';
			const name = player.name || playerId;
			const isHit = !!player.hitEvent;

			// Liveモードはマーカーのみ（軌跡はリプレイで見る）
			if (!playerLayers[playerId]) {
				playerLayers[playerId] = {
					polyline: null,   // Liveでは使わない
					marker: null,     // 位置が来てから追加
					hitMarker: null
				};
			}

			// 現在位置を決定
			// 優先順位: GPS変換済み座標 > スポーン位置フォールバック（キャリブ不足時）
			const pos = player.lastPosition ?? player.route[player.route.length - 1];
			let latLng: [number, number] | null = null;

			if (pos && (!useVirtualMap || gpsTransform)) {
				// 通常: GPS座標を変換
				latLng = toMapCoords(pos.lat, pos.lng);
			} else if (useVirtualMap && !gpsTransform && (player as any).spawnId) {
				// フォールバック: キャリブレーション不足のときはスポーン位置に表示
				const sp = spawnPointsState.find(s => s.id === (player as any).spawnId);
				if (sp) {
					latLng = [(1 - sp.y) * virtualImgH, sp.x * virtualImgW];
				}
			}

			if (latLng) {
				if (!playerLayers[playerId].marker) {
					playerLayers[playerId].marker = L.marker(latLng, {
						icon: makePlayerIcon(color, name, isHit),
						zIndexOffset: 100,
					}).addTo(map);
				} else {
					playerLayers[playerId].marker.setLatLng(latLng);
					playerLayers[playerId].marker.setIcon(makePlayerIcon(color, name, isHit));
				}
			}
		});
	});

	// ─── Replayモード描画 $effect ────────────────────────────────────────
	$effect(() => {
		if (!L || !map || viewMode !== 'replay' || !currentTime) return;

		logs.forEach(player => {
			const playerId = player.id;
			if (!playerId) return;

			const color = player.teamColor || '#ff0000';
			const name = player.name || playerId;
			const visibleRoute = player.route.filter(p => p.timestamp <= currentTime);
			const latestPoint = visibleRoute[visibleRoute.length - 1];

			if (!playerLayers[playerId]) {
				playerLayers[playerId] = {
					polyline: L.polyline([], {
						color,
						weight: 3,
						opacity: 0.7
					}).addTo(map),
					marker: L.marker([0, 0], {
						icon: makePlayerIcon(color, name),
						zIndexOffset: 100,
					}).addTo(map),
					hitMarker: null
				};
			}

			const mapLatLngs = visibleRoute.map(p => toMapCoords(p.lat, p.lng));
			playerLayers[playerId].polyline.setLatLngs(mapLatLngs);

			if (latestPoint) {
				playerLayers[playerId].marker.setLatLng(toMapCoords(latestPoint.lat, latestPoint.lng));
				playerLayers[playerId].marker.setOpacity(1);
			} else {
				playerLayers[playerId].marker.setOpacity(0);
			}

			// ヒットマーカー
			const hit = player.hitEvent;
			if (hit && currentTime >= hit.timestamp) {
				if (!playerLayers[playerId].hitMarker) {
					const hitIcon = L.divIcon({
						html: `<div style="font-size:20px;line-height:1;text-shadow:0 0 4px rgba(0,0,0,0.8)">💀</div>`,
						className: '',
						iconSize: [24, 24],
						iconAnchor: [12, 12],
					});
					playerLayers[playerId].hitMarker = L.marker(toMapCoords(hit.lat, hit.lng), { icon: hitIcon })
						.bindTooltip(`${name} ヒット`, { direction: 'top', offset: [0, -14] })
						.addTo(map);
				}
			} else if (playerLayers[playerId].hitMarker) {
				playerLayers[playerId].hitMarker.remove();
				playerLayers[playerId].hitMarker = null;
			}
		});
	});

	// モード切替時にレイヤーをリセット
	$effect(() => {
		void viewMode; // 依存として登録
		if (L && map) clearPlayerLayers();
	});

	// ─── ステータス管理 ──────────────────────────────────────────────────
	const STATUS_NEXT: Record<MatchStatus, MatchStatus | null> = {
		waiting:  'playing',
		playing:  'finished',
		finished: null
	};

	const STATUS_LABEL: Record<MatchStatus, string> = {
		waiting:  '待機中',
		playing:  '試合中',
		finished: '終了'
	};

	const STATUS_COLOR: Record<MatchStatus, string> = {
		waiting:  '#facc15',
		playing:  '#4ade80',
		finished: '#6b7280'
	};

	const STATUS_BTN_LABEL: Record<MatchStatus, string> = {
		waiting:  '試合開始',
		playing:  '試合終了',
		finished: ''
	};

	// ─── 試合設定 ────────────────────────────────────────────────────────
	const GAME_MODE_LABELS: Record<GameMode, string> = {
		elimination:       '殲滅戦（死んだら終わり）',
		unlimited_respawn: '無制限復活',
		timed_respawn:     '制限時間復活',
	};

	const DEFAULT_TEAM_NAMES = ['チームA','チームB','チームC','チームD'];

	let settingMode = $state<GameMode>('elimination');
	let settingTeamCount = $state(2);
	let settingTeamNames = $state<string[]>(['チームA','チームB','チームC','チームD']);
	let settingRespawnSec = $state(30);
	let savingSettings = $state(false);

	// matchが読み込まれたら設定を反映
	$effect(() => {
		if (!match) return;
		if (match.gameMode) settingMode = match.gameMode;
		if (match.teams) {
			settingTeamCount = match.teams.length;
			settingTeamNames = [
				...match.teams.map(t => t.name),
				...DEFAULT_TEAM_NAMES.slice(match.teams.length)
			];
		}
		if (match.respawnCooldownSec) settingRespawnSec = match.respawnCooldownSec;
	});

	async function saveMatchSettings() {
		savingSettings = true;
		const teams: TeamConfig[] = ['A','B','C','D']
			.slice(0, settingTeamCount)
			.map((id, i) => ({ id, name: settingTeamNames[i] || `チーム${id}` }));
		try {
			await updateDoc(doc(db, 'matches', matchId), {
				gameMode: settingMode,
				teams,
				respawnCooldownSec: settingRespawnSec,
			});
		} catch (e) { console.error(e); }
		savingSettings = false;
	}

	async function advanceStatus() {
		if (!match) return;
		const next = STATUS_NEXT[match.status];
		if (!next) return;
		joinPanelDismissed = true; // 試合開始/終了でパネルを閉じる
		updatingStatus = true;
		try {
			await updateDoc(doc(db, 'matches', matchId), { status: next });
		} catch (e) {
			console.error('Status update failed:', e);
		} finally {
			updatingStatus = false;
		}
	}

	// ─── 再生制御 ────────────────────────────────────────────────────────
	function togglePlayback() {
		isPlaying ? stopPlayback() : startPlayback();
	}

	function startPlayback() {
		if (currentTime >= endTime) currentTime = startTime;
		isPlaying = true;
		timer = window.setInterval(() => {
			currentTime += 1000 * playbackSpeed;
			if (currentTime >= endTime) {
				currentTime = endTime;
				stopPlayback();
			}
		}, 1000);
	}

	function stopPlayback() {
		isPlaying = false;
		clearInterval(timer);
	}

	function formatTime(ts: number) {
		if (!ts) return '--:--';
		return new Date(ts).toLocaleTimeString([], {
			hour: '2-digit', minute: '2-digit', second: '2-digit'
		});
	}

	function handleSeek(e: Event) {
		currentTime = Number((e.target as HTMLInputElement).value);
	}

	function cycleSpeed() {
		playbackSpeed = playbackSpeed >= 10 ? 1 : playbackSpeed + 2;
	}
</script>

<svelte:head>
	<title>Replay - {matchId}</title>
</svelte:head>

<div class="viewer-container">
	<div class="map-wrapper" bind:this={mapElement}></div>

	<!-- ステータスバッジ群（右上に小さく） -->
	<div class="status-badges">
		{#if calibStatus === 'ready'}
			<span class="badge badge-ok">✓ GPS連動中</span>
		{:else if calibStatus === 'no-spawns' && currentFieldId}
			<a href="/fields/{currentFieldId}/edit" class="badge badge-warn">
				📍 スポーン未設定 — タップして設定
			</a>
		{:else if calibStatus === 'insufficient' && currentFieldId}
			<a href="/fields/{currentFieldId}/edit" class="badge badge-warn">
				⚠ GPS未記録 — trackerで記録を
			</a>
		{:else if calibStatus === 'insufficient'}
			<span class="badge badge-warn">⚠ GPS記録が不足しています</span>
		{/if}

		{#if noBoundary && !useVirtualMap}
			<span class="badge badge-warn">⚠ 境界線未登録</span>
		{/if}
	</div>

	<!-- 待機中：参加者募集 + 試合設定パネル -->
	{#if match?.status === 'waiting' && !joinPanelDismissed}
		<div class="join-panel">
			<div class="join-panel-header">
				<span class="join-panel-title">📱 参加者を招待</span>
				<button class="join-panel-close" onclick={() => joinPanelDismissed = true}>✕</button>
			</div>
			<p class="join-panel-sub">スマホのカメラでQRをスキャン</p>
			<img
				src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&color=e5e5e5&bgcolor=0a0a0a&data={encodeURIComponent(typeof window !== 'undefined' ? `${window.location.origin}/track/${matchId}` : '')}"
				alt="QR Code"
				class="join-qr"
			/>
			<div class="join-url">/track/{matchId.slice(0,12)}…</div>

			<!-- 参加者リスト -->
			<div class="join-players">
				{#if logs.length === 0}
					<span class="join-players-none">まだ誰も参加していません</span>
				{:else}
					<span class="join-players-count">✅ {logs.length}人が参加済み</span>
					<div class="join-player-list">
						{#each logs as p}
							<div class="join-player-item">
								<span class="join-player-dot" style="background:{p.teamColor}"></span>
								<span>{p.name || p.id}</span>
								<span class="join-player-team">{p.team ?? '?'}</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<!-- 試合設定 -->
			<div class="settings-section">
				<div class="settings-title">⚙ 試合設定</div>

				<div class="settings-row">
					<span class="settings-label">ゲームモード</span>
					<select class="settings-select" bind:value={settingMode}>
						<option value="elimination">殲滅戦</option>
						<option value="unlimited_respawn">無制限復活</option>
						<option value="timed_respawn">制限時間復活</option>
					</select>
				</div>

				{#if settingMode === 'timed_respawn'}
					<div class="settings-row">
						<span class="settings-label">復活待機</span>
						<div class="settings-inline">
							<input class="settings-num" type="number" min="5" max="300" bind:value={settingRespawnSec} />
							<span class="settings-unit">秒</span>
						</div>
					</div>
				{/if}

				<div class="settings-row">
					<span class="settings-label">チーム数</span>
					<div class="settings-team-btns">
						{#each [2,3,4] as n}
							<button
								class="settings-team-btn {settingTeamCount === n ? 'active' : ''}"
								onclick={() => settingTeamCount = n}
							>{n}</button>
						{/each}
					</div>
				</div>

				<div class="settings-team-names">
					{#each Array(settingTeamCount) as _, i}
						<input
							class="settings-team-name-input"
							type="text"
							placeholder="チーム{['A','B','C','D'][i]}"
							bind:value={settingTeamNames[i]}
						/>
					{/each}
				</div>

				<button class="settings-save-btn" onclick={saveMatchSettings} disabled={savingSettings}>
					{savingSettings ? '保存中…' : '💾 設定を保存'}
				</button>
			</div>

			<button class="join-start-btn" onclick={advanceStatus} disabled={updatingStatus}>
				{updatingStatus ? '…' : '▶ 試合開始'}
			</button>
		</div>
	{/if}

	<!-- QRコードモーダル -->
	{#if showQR}
		<div class="modal-overlay" onclick={() => showQR = false} role="button" tabindex="-1">
			<div class="modal-box" onclick={(e) => e.stopPropagation()}>
				<h3 class="modal-title">📱 試合に参加</h3>
				<p class="modal-sub">スマホのカメラでスキャンしてブラウザで開く</p>
				<img
					src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&color=e5e5e5&bgcolor=0a0a0a&data={encodeURIComponent(typeof window !== 'undefined' ? `${window.location.origin}/track/${matchId}` : '')}"
					alt="QR Code"
					class="qr-img"
				/>
				<p class="modal-url">/track/{matchId}</p>
				<button class="modal-close" onclick={() => showQR = false}>閉じる</button>
			</div>
		</div>
	{/if}

	<!-- 統計モーダル -->
	{#if showStats}
		<div class="modal-overlay" onclick={() => showStats = false} role="button" tabindex="-1">
			<div class="modal-box modal-wide" onclick={(e) => e.stopPropagation()}>
				<h3 class="modal-title">📊 試合統計</h3>
				{#if logs.length === 0}
					<p class="modal-sub">データがありません</p>
				{:else}
					<div class="stats-table">
						<div class="stats-header">
							<span>プレイヤー</span>
							<span>チーム</span>
							<span>移動距離</span>
							<span>生存時間</span>
							<span>結果</span>
						</div>
						{#each logs.sort((a,b) => (a.team||'A').localeCompare(b.team||'A')) as player}
							{@const s = calcStats(player)}
							<div class="stats-row" style="--c: {player.teamColor || '#aaa'}">
								<span class="stats-name">
									<span class="stats-dot" style="background:{player.teamColor}"></span>
									{player.name || player.id}
								</span>
								<span class="stats-team">チーム{player.team ?? '?'}</span>
								<span class="stats-val">{s.distance >= 1000 ? (s.distance/1000).toFixed(1)+'km' : s.distance+'m'}</span>
								<span class="stats-val">{Math.floor(s.duration/60)}分{s.duration%60}秒</span>
								<span class="stats-result">{player.hitEvent ? '💀 ヒット' : '✅ 生存'}</span>
							</div>
						{/each}
					</div>
				{/if}
				<button class="modal-close" onclick={() => showStats = false}>閉じる</button>
			</div>
		</div>
	{/if}

	<!-- 下部：コンパクトコントロールバー -->
	<div class="bottom-bar">
		<!-- 上段：凡例（プレイヤーがいる時だけ） -->
		{#if logs.length > 0}
			<div class="legend-row">
				{#each ['A','B'] as team}
					{#if logs.some(p => (p.team ?? 'A') === team)}
						<span class="team-label">チーム{team}</span>
						{#each logs.filter(p => (p.team ?? 'A') === team) as player}
							<div class="legend-item">
								<span class="legend-dot" style="background: {player.teamColor || '#ff0000'}"></span>
								<span class="legend-name">{player.name || player.id}</span>
								{#if player.hitEvent}<span class="hit-badge">💀</span>{/if}
							</div>
						{/each}
					{/if}
				{/each}
			</div>
		{/if}

		<!-- 下段：操作行 -->
		<div class="control-row">
			<a href="/" class="back-btn" aria-label="一覧に戻る">
				<ArrowLeft size={16} />
			</a>

			{#if match}
				<div class="status-badge" style="--c: {STATUS_COLOR[match.status]}">
					<Circle size={6} fill="var(--c)" stroke="none" />
					{STATUS_LABEL[match.status]}
				</div>
				{#if STATUS_NEXT[match.status]}
					<button class="status-btn" onclick={advanceStatus} disabled={updatingStatus}>
						{updatingStatus ? '…' : STATUS_BTN_LABEL[match.status]}
					</button>
				{/if}
			{/if}

			<!-- Live / Replay トグル -->
			<div class="mode-toggle">
				<button
					class="mode-btn {viewMode === 'live' ? 'mode-active-live' : ''}"
					onclick={() => { viewMode = 'live'; stopPlayback(); }}
				>● LIVE</button>
				<button
					class="mode-btn {viewMode === 'replay' ? 'mode-active-replay' : ''}"
					onclick={() => { viewMode = 'replay'; if (currentTime === 0) currentTime = startTime; }}
				>▶ REPLAY</button>
			</div>

			<!-- Replayモード時のみシークバー表示 -->
			{#if viewMode === 'replay'}
				<div class="seek-group">
					<button class="icon-btn" onclick={() => { currentTime = startTime; stopPlayback(); }}>
						<RotateCcw size={15} />
					</button>
					<button class="play-btn" onclick={togglePlayback}>
						{#if isPlaying}<Pause size={18} fill="currentColor" />{:else}<Play size={18} fill="currentColor" />{/if}
					</button>
					<input type="range" min={startTime} max={endTime} value={currentTime} oninput={handleSeek} class="seekbar" />
					<span class="time-label">{formatTime(currentTime)}</span>
					<button class="speed-btn" onclick={cycleSpeed}>{playbackSpeed}x</button>
				</div>
			{/if}

			<!-- ツールボタン群 -->
			<div class="tool-btns">
				<button class="tool-btn" onclick={() => showQR = true} title="QRコード">
					<QrCode size={15} />
				</button>
				<button class="tool-btn" onclick={() => showStats = !showStats} title="統計">
					<BarChart2 size={15} />
				</button>
				<button class="tool-btn {showHeatmap ? 'tool-btn-active' : ''}" onclick={toggleHeatmap} title="ヒートマップ">
					<Flame size={15} />
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		overflow: hidden;
		background: #111;
		font-family: 'Inter', system-ui, -apple-system, sans-serif;
	}
	:global(.leaflet-container) { background: #111 !important; }
	:global(.spawn-label-tip) {
		background: rgba(0,0,0,0.8) !important;
		border: 1px solid rgba(74,222,128,0.5) !important;
		color: #4ade80 !important;
		font-size: 11px !important;
		font-weight: 600 !important;
		padding: 2px 7px !important;
		border-radius: 4px !important;
		box-shadow: none !important;
		white-space: nowrap !important;
	}
	:global(.spawn-label-tip::before) { display: none !important; }

	.viewer-container {
		position: relative;
		width: 100vw;
		height: 100vh;
		color: white;
	}

	.map-wrapper {
		width: 100%;
		height: 100%;
		z-index: 1;
	}

	.virtual-map-badge {
		background: rgba(74,222,128,0.12);
		border: 1px solid rgba(74,222,128,0.3);
		border-radius: 10px;
		padding: 6px 14px;
		color: #4ade80;
		font-size: 0.78rem;
		font-weight: 600;
		text-align: center;
	}

	/* ── 待機中参加パネル ── */
	.join-panel {
		position: absolute;
		top: 50%;
		left: 20px;
		transform: translateY(-50%);
		z-index: 800;
		background: rgba(10,10,10,0.94);
		backdrop-filter: blur(20px);
		border: 1px solid rgba(74,222,128,0.3);
		border-radius: 18px;
		padding: 18px 20px;
		width: 220px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		box-shadow: 0 8px 32px rgba(0,0,0,0.6);
	}
	.join-panel-header {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.join-panel-title {
		font-size: 0.88rem;
		font-weight: 800;
		color: #4ade80;
	}
	.join-panel-close {
		background: none;
		border: none;
		color: #6b7280;
		font-size: 0.85rem;
		cursor: pointer;
		padding: 2px 4px;
		line-height: 1;
	}
	.join-panel-close:hover { color: #e5e5e5; }
	.join-panel-sub {
		font-size: 0.7rem;
		color: #9ca3af;
		margin: 0;
		text-align: center;
	}
	.join-qr {
		width: 160px;
		height: 160px;
		border-radius: 10px;
		border: 1px solid rgba(255,255,255,0.08);
	}
	.join-url {
		font-size: 0.65rem;
		font-family: monospace;
		color: #6b7280;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.08);
		padding: 4px 8px;
		border-radius: 6px;
		width: 100%;
		text-align: center;
		box-sizing: border-box;
	}
	.join-players { width: 100%; }
	.join-players-none {
		font-size: 0.72rem;
		color: #4b5563;
		text-align: center;
		display: block;
	}
	.join-players-count {
		font-size: 0.75rem;
		color: #4ade80;
		font-weight: 700;
		display: block;
		text-align: center;
		margin-bottom: 6px;
	}
	.join-player-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
		max-height: 100px;
		overflow-y: auto;
	}
	.join-player-item {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.72rem;
		color: #d1d5db;
	}
	.join-player-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.join-player-team {
		margin-left: auto;
		color: #6b7280;
		font-size: 0.65rem;
	}
	.join-start-btn {
		width: 100%;
		padding: 12px;
		background: #4ade80;
		color: #000;
		border: none;
		border-radius: 10px;
		font-size: 0.9rem;
		font-weight: 800;
		cursor: pointer;
		margin-top: 2px;
	}
	.join-start-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.join-start-btn:hover:not(:disabled) { background: #22c55e; }

	/* ── 試合設定 ── */
	.settings-section {
		width: 100%;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 10px;
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.settings-title {
		font-size: 0.72rem;
		font-weight: 700;
		color: #6b7280;
		letter-spacing: 0.05em;
	}
	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.settings-label {
		font-size: 0.72rem;
		color: #9ca3af;
		white-space: nowrap;
	}
	.settings-select {
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 6px;
		color: #e5e5e5;
		font-size: 0.72rem;
		padding: 4px 6px;
		flex: 1;
	}
	.settings-inline {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.settings-num {
		width: 54px;
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 6px;
		color: #e5e5e5;
		font-size: 0.8rem;
		padding: 4px 6px;
		text-align: center;
	}
	.settings-unit { font-size: 0.72rem; color: #9ca3af; }
	.settings-team-btns { display: flex; gap: 4px; }
	.settings-team-btn {
		width: 30px;
		height: 24px;
		border-radius: 6px;
		border: 1px solid rgba(255,255,255,0.12);
		background: rgba(255,255,255,0.04);
		color: rgba(255,255,255,0.4);
		font-size: 0.8rem;
		font-weight: 700;
		cursor: pointer;
	}
	.settings-team-btn.active {
		border-color: #4ade80;
		background: rgba(74,222,128,0.15);
		color: #4ade80;
	}
	.settings-team-names {
		display: flex;
		gap: 4px;
		flex-wrap: wrap;
	}
	.settings-team-name-input {
		flex: 1;
		min-width: 60px;
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 6px;
		color: #e5e5e5;
		font-size: 0.72rem;
		padding: 4px 6px;
	}
	.settings-save-btn {
		width: 100%;
		padding: 7px;
		background: rgba(74,222,128,0.1);
		border: 1px solid rgba(74,222,128,0.3);
		border-radius: 8px;
		color: #4ade80;
		font-size: 0.75rem;
		font-weight: 700;
		cursor: pointer;
	}
	.settings-save-btn:hover:not(:disabled) { background: rgba(74,222,128,0.2); }
	.settings-save-btn:disabled { opacity: 0.5; }

	/* ── ステータスバッジ（右上） ── */
	.status-badges {
		position: absolute;
		top: 10px;
		right: 10px;
		z-index: 500;
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 5px;
		pointer-events: none;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 0.68rem;
		font-weight: 700;
		padding: 4px 10px;
		border-radius: 20px;
		white-space: nowrap;
		pointer-events: auto;
		text-decoration: none;
		backdrop-filter: blur(8px);
	}
	.badge-ok {
		color: #4ade80;
		background: rgba(74,222,128,0.12);
		border: 1px solid rgba(74,222,128,0.35);
	}
	.badge-warn {
		color: #fbbf24;
		background: rgba(251,191,36,0.12);
		border: 1px solid rgba(251,191,36,0.35);
		cursor: pointer;
	}
	.badge-warn:hover { background: rgba(251,191,36,0.22); }

	/* ── 下部バー ── */
	.bottom-bar {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 1000;
		background: rgba(14,14,14,0.92);
		backdrop-filter: blur(16px);
		border-top: 1px solid rgba(255,255,255,0.07);
		padding: 6px 12px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	/* 凡例行 */
	.legend-row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		padding: 2px 0;
	}
	.legend-item {
		display: flex;
		align-items: center;
		gap: 5px;
		font-size: 0.72rem;
		color: rgba(255,255,255,0.75);
	}
	.legend-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex-shrink: 0;
	}
	.legend-name { font-weight: 500; }
	.hit-badge { font-size: 0.65rem; opacity: 0.8; }

	/* Live/Replayトグル */
	.mode-toggle {
		display: flex;
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 8px;
		overflow: hidden;
		flex-shrink: 0;
	}
	.mode-btn {
		background: transparent;
		color: rgba(255,255,255,0.4);
		border: none;
		padding: 4px 10px;
		font-size: 0.66rem;
		font-weight: 700;
		cursor: pointer;
		letter-spacing: 0.03em;
		transition: all 0.15s;
		white-space: nowrap;
	}
	.mode-active-live {
		background: rgba(239,68,68,0.2);
		color: #f87171;
	}
	.mode-active-replay {
		background: rgba(74,222,128,0.15);
		color: #4ade80;
	}

	/* 操作行 */
	.control-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.back-btn {
		display: flex;
		align-items: center;
		color: rgba(255,255,255,0.35);
		text-decoration: none;
		transition: color 0.15s;
		flex-shrink: 0;
	}
	.back-btn:hover { color: #fff; }

	.status-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.68rem;
		font-weight: 600;
		color: var(--c);
		background: color-mix(in srgb, var(--c) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--c) 28%, transparent);
		padding: 3px 8px;
		border-radius: 20px;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.status-btn {
		background: rgba(255,255,255,0.08);
		color: #e5e5e5;
		border: 1px solid rgba(255,255,255,0.15);
		padding: 3px 10px;
		border-radius: 8px;
		font-size: 0.68rem;
		font-weight: 600;
		cursor: pointer;
		transition: background 0.15s;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.status-btn:hover:not(:disabled) { background: rgba(255,255,255,0.15); }
	.status-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	/* シークグループ（残りスペースを占有） */
	.seek-group {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
	}

	.icon-btn {
		background: transparent;
		color: rgba(255,255,255,0.5);
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		padding: 0;
		transition: color 0.15s;
		flex-shrink: 0;
	}
	.icon-btn:hover { color: #fff; }

	.play-btn {
		background: #fff;
		color: #000;
		border: none;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex-shrink: 0;
		transition: transform 0.12s;
	}
	.play-btn:hover { transform: scale(1.08); }

	.seekbar {
		flex: 1;
		min-width: 0;
		height: 4px;
		-webkit-appearance: none;
		appearance: none;
		background: rgba(255,255,255,0.15);
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}
	.seekbar::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 14px;
		height: 14px;
		background: #fff;
		border-radius: 50%;
		box-shadow: 0 0 6px rgba(0,0,0,0.5);
	}

	.time-label {
		font-size: 0.7rem;
		font-variant-numeric: tabular-nums;
		color: #4ade80;
		font-weight: 600;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.speed-btn {
		background: transparent;
		color: rgba(255,255,255,0.55);
		border: none;
		cursor: pointer;
		font-size: 0.7rem;
		font-weight: 700;
		padding: 0;
		white-space: nowrap;
		flex-shrink: 0;
		transition: color 0.15s;
	}
	.speed-btn:hover { color: #fff; }

	/* ── チームラベル ── */
	.team-label {
		font-size: 0.65rem;
		font-weight: 800;
		letter-spacing: 0.06em;
		color: rgba(255,255,255,0.3);
		padding-right: 4px;
		border-right: 1px solid rgba(255,255,255,0.1);
		margin-right: 2px;
	}

	/* ── ツールボタン ── */
	.tool-btns {
		display: flex;
		gap: 4px;
		margin-left: auto;
		flex-shrink: 0;
	}
	.tool-btn {
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.1);
		color: rgba(255,255,255,0.45);
		border-radius: 7px;
		width: 30px;
		height: 30px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: all 0.15s;
	}
	.tool-btn:hover { color: #fff; background: rgba(255,255,255,0.12); }
	.tool-btn-active { color: #f97316 !important; background: rgba(249,115,22,0.15) !important; border-color: rgba(249,115,22,0.4) !important; }

	/* ── モーダル共通 ── */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.75);
		z-index: 2000;
		display: flex;
		align-items: center;
		justify-content: center;
		backdrop-filter: blur(4px);
	}
	.modal-box {
		background: #141414;
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 18px;
		padding: 28px 24px 22px;
		min-width: 260px;
		max-width: 420px;
		width: 90vw;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
	}
	.modal-wide { max-width: 560px; align-items: stretch; }
	.modal-title { font-size: 1.1rem; font-weight: 700; margin: 0; }
	.modal-sub { font-size: 0.8rem; color: #6b7280; margin: -4px 0; text-align: center; }
	.modal-url { font-size: 0.7rem; font-family: monospace; color: #6b7280; word-break: break-all; text-align: center; }
	.modal-close {
		margin-top: 4px;
		background: rgba(255,255,255,0.07);
		border: 1px solid rgba(255,255,255,0.12);
		color: #e5e5e5;
		border-radius: 8px;
		padding: 7px 22px;
		cursor: pointer;
		font-size: 0.82rem;
		font-weight: 600;
		width: 100%;
	}
	.modal-close:hover { background: rgba(255,255,255,0.14); }
	.qr-img { border-radius: 12px; width: 200px; height: 200px; }

	/* ── 統計テーブル ── */
	.stats-table { width: 100%; display: flex; flex-direction: column; gap: 2px; }
	.stats-header {
		display: grid;
		grid-template-columns: 1.8fr 0.8fr 1fr 1fr 1fr;
		gap: 8px;
		font-size: 0.68rem;
		font-weight: 700;
		color: #6b7280;
		padding: 4px 8px;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}
	.stats-row {
		display: grid;
		grid-template-columns: 1.8fr 0.8fr 1fr 1fr 1fr;
		gap: 8px;
		font-size: 0.78rem;
		padding: 8px 8px;
		border-radius: 8px;
		background: rgba(255,255,255,0.03);
		align-items: center;
		border-left: 3px solid var(--c);
	}
	.stats-name { display: flex; align-items: center; gap: 7px; font-weight: 600; }
	.stats-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
	.stats-team { color: #9ca3af; font-size: 0.72rem; }
	.stats-val { font-variant-numeric: tabular-nums; color: #d1d5db; }
	.stats-result { font-size: 0.72rem; }
</style>
