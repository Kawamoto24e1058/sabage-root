<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { db } from '$lib/firebase';
	import { collection, onSnapshot, doc, getDoc, updateDoc } from 'firebase/firestore';
	import type { PlayerLog, Field, Match, MatchStatus, GameMode, TeamConfig } from 'shared-types';
	import { Play, Pause, RotateCcw, ArrowLeft, Circle, QrCode, BarChart2, Flame, Radar } from 'lucide-svelte';

	// Leaflet
	let L: any;
	let map: any;
	let mapElement: HTMLElement;
	let playerLayers: Record<string, { polyline: any; marker: any; hitMarker: any | null }> = {};
	let heatLayer: any = null;
	let fieldPolygon: any = null;

	// Match / Replay state
	const matchId: string = page.params.matchId ?? '';
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

	// レーダースキャンライン（デフォルト無効）
	let showScanLine = $state(false);

	// モーダル
	let showQR = $state(false);
	let showStats = $state(false);
	let showHeatmap = $state(false);
	let joinPanelDismissed = $state(false);

	$effect(() => {
		if (match?.status === 'waiting' && !joinPanelDismissed) {
			showQR = false;
		}
	});

	let unsubscribeLogs: () => void;
	let unsubscribeMatch: () => void;

	onMount(async () => {
		const leaflet = await import('leaflet');
		await import('leaflet/dist/leaflet.css');
		L = leaflet.default;

		// ① match ドキュメント取得
		const matchDoc = await getDoc(doc(db, 'matches', matchId));
		if (!matchDoc.exists()) return;
		match = { id: matchDoc.id, ...matchDoc.data() } as Match;

		const fieldId = match.fieldId;

		if (fieldId) {
			const fieldDoc = await getDoc(doc(db, 'fields', fieldId));
			if (fieldDoc.exists()) {
				field = { id: fieldDoc.id, ...fieldDoc.data() } as Field;
			}
		}

		// ② MGSレーダーマップ初期化（タイル無し・暗い背景）
		map = L.map(mapElement, {
			zoomControl: false,
			dragging: false,
			scrollWheelZoom: false,
			doubleClickZoom: false,
			boxZoom: false,
			touchZoom: false,
			keyboard: false,
			attributionControl: false,
		});

		// フィールド外周ポリゴン
		if (field?.boundary && field.boundary.length >= 3) {
			const latLngs = field.boundary.map(p => [p.lat, p.lng] as [number, number]);

			// 外側グロー（太い半透明）
			L.polygon(latLngs, {
				color: '#4ade80',
				weight: 14,
				opacity: 0.06,
				fillOpacity: 0,
				interactive: false,
			}).addTo(map);

			// 中グロー
			L.polygon(latLngs, {
				color: '#4ade80',
				weight: 6,
				opacity: 0.2,
				fillOpacity: 0,
				interactive: false,
			}).addTo(map);

			// メインライン + 塗りつぶし
			fieldPolygon = L.polygon(latLngs, {
				color: '#4ade80',
				weight: 2,
				opacity: 0.9,
				fillColor: '#0d1f0d',
				fillOpacity: 0.55,
				interactive: false,
			}).addTo(map);

			map.fitBounds(fieldPolygon.getBounds(), { padding: [60, 60] });
		} else {
			noBoundary = true;
			map.setView([35.6812, 139.7671], 16);
		}

		// スポーン地点マーカー（GPS座標から直接描画）
		const spawnPoints = field?.spawnPoints ?? [];
		spawnPoints.forEach((sp, i) => {
			const icon = L.divIcon({
				html: `<div style="
					width:28px;height:28px;border-radius:50%;
					background:rgba(5,10,5,0.92);
					border:2px solid #4ade80;
					color:#4ade80;font-size:11px;font-weight:800;
					display:flex;align-items:center;justify-content:center;
					box-shadow:0 0 0 4px rgba(74,222,128,0.1), 0 0 12px rgba(74,222,128,0.3);
					font-family:monospace;
				">${i + 1}</div>`,
				iconSize: [28, 28], iconAnchor: [14, 14], className: '',
			});
			const m = L.marker([sp.lat, sp.lng], { icon }).addTo(map);
			m.bindTooltip(sp.label, {
				permanent: true, direction: 'top', offset: [0, -18],
				className: 'spawn-label-tip',
			});
		});

		// ③ match リアルタイム購読
		unsubscribeMatch = onSnapshot(doc(db, 'matches', matchId), (snap) => {
			if (snap.exists()) {
				match = { id: snap.id, ...snap.data() } as Match;
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

				// 境界線がない場合は全プレイヤーGPS範囲にフィット
				if (noBoundary) {
					const allPoints = logs.flatMap(l => l.route.map(p => [p.lat, p.lng] as [number, number]));
					if (allPoints.length > 0) map.fitBounds(L.latLngBounds(allPoints), { padding: [60, 60] });
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
		if (!(window as any).L?.heatLayer) {
			await new Promise<void>((resolve, reject) => {
				const s = document.createElement('script');
				s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.heat/0.2.0/leaflet-heat.js';
				s.onload = () => resolve();
				s.onerror = reject;
				document.head.appendChild(s);
			});
		}
		const points = logs.flatMap(p => p.route.map(r => [r.lat, r.lng, 1.0] as [number, number, number]));
		heatLayer = (L as any).heatLayer(points, { radius: 22, blur: 15, maxZoom: 17 }).addTo(map);
		showHeatmap = true;
	}

	// ─── MGS スタイル プレイヤーアイコン ─────────────────────────────────
	function makePlayerIcon(color: string, name: string, isHit = false) {
		const size = isHit ? 8 : 11;
		const glow = isHit ? '' : `0 0 6px ${color}, 0 0 14px ${color}66`;
		const opacity = isHit ? 0.35 : 1;
		return L.divIcon({
			html: `
				<div style="position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none;">
					<div style="
						position:absolute;
						bottom:${size + 4}px;
						left:50%;
						transform:translateX(-50%);
						white-space:nowrap;
						font-size:9px;
						font-family:monospace;
						font-weight:700;
						color:${color};
						text-shadow:0 0 5px ${color}99;
						letter-spacing:0.06em;
						opacity:${opacity};
					">${name}</div>
					<div style="
						width:${size}px;height:${size}px;
						border-radius:50%;
						background:${color};
						box-shadow:${glow};
						opacity:${opacity};
					"></div>
				</div>`,
			className: '',
			iconSize: [size, size],
			iconAnchor: [size / 2, size / 2],
		});
	}

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

			const color = player.teamColor || '#4ade80';
			const name = player.name || playerId.slice(0, 6);
			const isHit = !!player.hitEvent;

			if (!playerLayers[playerId]) {
				playerLayers[playerId] = { polyline: null, marker: null, hitMarker: null };
			}

			// 最新位置
			const pos = player.lastPosition ?? player.route[player.route.length - 1];
			if (!pos) return;

			const latLng: [number, number] = [pos.lat, pos.lng];

			if (!playerLayers[playerId].marker) {
				playerLayers[playerId].marker = L.marker(latLng, {
					icon: makePlayerIcon(color, name, isHit),
					zIndexOffset: 100,
				}).addTo(map);
			} else {
				playerLayers[playerId].marker.setLatLng(latLng);
				playerLayers[playerId].marker.setIcon(makePlayerIcon(color, name, isHit));
			}
		});
	});

	// ─── Replayモード描画 $effect ────────────────────────────────────────
	$effect(() => {
		if (!L || !map || viewMode !== 'replay' || !currentTime) return;

		logs.forEach(player => {
			const playerId = player.id;
			if (!playerId) return;

			const color = player.teamColor || '#4ade80';
			const name = player.name || playerId.slice(0, 6);
			const visibleRoute = player.route.filter(p => p.timestamp <= currentTime);
			const latestPoint = visibleRoute[visibleRoute.length - 1];

			if (!playerLayers[playerId]) {
				playerLayers[playerId] = {
					polyline: L.polyline([], {
						color,
						weight: 2,
						opacity: 0.6,
					}).addTo(map),
					marker: L.marker([0, 0], {
						icon: makePlayerIcon(color, name),
						zIndexOffset: 100,
					}).addTo(map),
					hitMarker: null,
				};
			}

			const mapLatLngs = visibleRoute.map(p => [p.lat, p.lng] as [number, number]);
			playerLayers[playerId].polyline.setLatLngs(mapLatLngs);

			if (latestPoint) {
				playerLayers[playerId].marker.setLatLng([latestPoint.lat, latestPoint.lng]);
				playerLayers[playerId].marker.setOpacity(1);
			} else {
				playerLayers[playerId].marker.setOpacity(0);
			}

			// ヒットマーカー
			const hit = player.hitEvent;
			if (hit && currentTime >= hit.timestamp) {
				if (!playerLayers[playerId].hitMarker) {
					const hitIcon = L.divIcon({
						html: `<div style="font-size:16px;line-height:1;filter:drop-shadow(0 0 3px rgba(255,0,0,0.6))">💀</div>`,
						className: '',
						iconSize: [20, 20],
						iconAnchor: [10, 10],
					});
					playerLayers[playerId].hitMarker = L.marker([hit.lat, hit.lng], { icon: hitIcon })
						.bindTooltip(`${name} ヒット`, { direction: 'top', offset: [0, -12] })
						.addTo(map);
				}
			} else if (playerLayers[playerId].hitMarker) {
				playerLayers[playerId].hitMarker.remove();
				playerLayers[playerId].hitMarker = null;
			}
		});
	});

	// モード切替時にレイヤーリセット
	$effect(() => {
		void viewMode;
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
	const DEFAULT_TEAM_NAMES = ['チームA','チームB','チームC','チームD'];
	let settingMode = $state<GameMode>('elimination');
	let settingTeamCount = $state(2);
	let settingTeamNames = $state<string[]>(['チームA','チームB','チームC','チームD']);
	let settingRespawnSec = $state(30);
	let savingSettings = $state(false);

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
		joinPanelDismissed = true;
		updatingStatus = true;
		try {
			await updateDoc(doc(db, 'matches', matchId), { status: next });
		} catch (e) { console.error('Status update failed:', e); }
		finally { updatingStatus = false; }
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
			if (currentTime >= endTime) { currentTime = endTime; stopPlayback(); }
		}, 1000);
	}
	function stopPlayback() {
		isPlaying = false;
		clearInterval(timer);
	}
	function formatTime(ts: number) {
		if (!ts) return '--:--';
		return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	}
	function handleSeek(e: Event) {
		currentTime = Number((e.target as HTMLInputElement).value);
	}
	function cycleSpeed() {
		playbackSpeed = playbackSpeed >= 10 ? 1 : playbackSpeed + 2;
	}
</script>

<svelte:head>
	<title>RADAR - {matchId.slice(0, 8)}</title>
</svelte:head>

<div class="viewer-container">
	<!-- MGSレーダーマップ -->
	<div class="map-wrapper" bind:this={mapElement}></div>

	<!-- スキャンラインオーバーレイ -->
	{#if showScanLine}
		<div class="scanline-overlay" aria-hidden="true">
			<div class="scanline-sweep"></div>
		</div>
	{/if}

	<!-- CRTスキャンライン（常時微弱） -->
	<div class="crt-overlay" aria-hidden="true"></div>

	<!-- ── 生存者オーバーレイ（試合中 / Live のみ） ── -->
	{#if match?.status === 'playing' && viewMode === 'live' && logs.length > 0}
		{@const teamIds = [...new Set(logs.map(p => p.team ?? 'A'))].sort()}
		<div class="alive-overlay">
			{#each teamIds as team}
				{@const teamLogs = logs.filter(p => (p.team ?? 'A') === team)}
				{@const alive = teamLogs.filter(p => !p.hitEvent).length}
				{@const total = teamLogs.length}
				{@const teamName = match?.teams?.find(t => t.id === team)?.name ?? `チーム${team}`}
				{@const repColor = teamLogs[0]?.teamColor ?? '#4ade80'}
				<div class="alive-team">
					<span class="alive-dot" style="background:{repColor};box-shadow:0 0 5px {repColor}"></span>
					<span class="alive-name">{teamName}</span>
					<span class="alive-count" style="color:{repColor};text-shadow:0 0 8px {repColor}66">
						{alive}<span class="alive-total">/{total}</span>
					</span>
				</div>
			{/each}
		</div>
	{/if}

	<!-- ── デバッグパネル ── -->
	{#if logs.length === 0 && match?.status !== 'waiting'}
		<div class="debug-panel">
			<div class="debug-title">📡 プレイヤー未接続</div>
			<div class="debug-row">スマホで <code>/track/{matchId}</code> を開いてください</div>
		</div>
	{:else if logs.length > 0}
		<div class="debug-panel">
			<div class="debug-title">👥 {logs.length}人接続中</div>
			{#each logs as p}
				<div class="debug-row">
					<span class="debug-dot" style="background:{p.teamColor};box-shadow:0 0 4px {p.teamColor}"></span>
					<span>{p.name || p.id?.slice(0,6)}</span>
					<span class="muted">{p.lastPosition ? '📍GPS' : '⌛待機'}</span>
				</div>
			{/each}
		</div>
	{/if}

	<!-- 境界線なし警告 -->
	{#if noBoundary}
		<div class="no-boundary-badge">
			⚠ 外周未登録 — <a href="/fields/{match?.fieldId}/edit">フィールド設定</a>
		</div>
	{/if}

	<!-- 待機中：参加者募集 + 試合設定パネル -->
	{#if match?.status === 'waiting' && !joinPanelDismissed}
		<div class="join-panel">
			<div class="join-panel-header">
				<span class="join-panel-title">📱 参加者を招待</span>
				<button class="join-panel-close" onclick={() => joinPanelDismissed = true}>✕</button>
			</div>
			<p class="join-panel-sub">スマホのカメラでQRをスキャン</p>
			<img
				src="https://api.qrserver.com/v1/create-qr-code/?size=160x160&color=4ade80&bgcolor=050f05&data={encodeURIComponent(typeof window !== 'undefined' ? `${window.location.origin}/track/${matchId}` : '')}"
				alt="QR Code"
				class="join-qr"
			/>
			<div class="join-url">/track/{matchId.slice(0,12)}…</div>

			<div class="join-players">
				{#if logs.length === 0}
					<span class="join-players-none">まだ誰も参加していません</span>
				{:else}
					<span class="join-players-count">✅ {logs.length}人が参加済み</span>
					<div class="join-player-list">
						{#each logs as p}
							<div class="join-player-item">
								<span class="join-player-dot" style="background:{p.teamColor};box-shadow:0 0 4px {p.teamColor}"></span>
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
				<p class="modal-sub">スマホのカメラでスキャン</p>
				<img
					src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&color=4ade80&bgcolor=050f05&data={encodeURIComponent(typeof window !== 'undefined' ? `${window.location.origin}/track/${matchId}` : '')}"
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
							<div class="stats-row" style="--c: {player.teamColor || '#4ade80'}">
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

	<!-- 下部コントロールバー -->
	<div class="bottom-bar">
		<!-- 凡例行 -->
		{#if logs.length > 0}
			{@const teamIds = [...new Set(logs.map(p => p.team ?? 'A'))].sort()}
			<div class="legend-row">
				{#each teamIds as team}
					{@const teamLogs = logs.filter(p => (p.team ?? 'A') === team)}
					{@const teamName = match?.teams?.find(t => t.id === team)?.name ?? `チーム${team}`}
					<span class="team-label">{teamName}</span>
					{#each teamLogs as player}
						<div class="legend-item">
							<span class="legend-dot" style="background:{player.teamColor || '#4ade80'};box-shadow:0 0 4px {player.teamColor};opacity:{player.hitEvent ? 0.3 : 1}"></span>
							<span class="legend-name" style="opacity:{player.hitEvent ? 0.35 : 1}">{player.name || player.id}</span>
							{#if player.hitEvent}<span class="hit-badge">💀</span>{/if}
						</div>
					{/each}
				{/each}
			</div>
		{/if}

		<!-- 操作行 -->
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
				<!-- スキャンライントグル -->
				<button
					class="tool-btn {showScanLine ? 'tool-btn-active-green' : ''}"
					onclick={() => showScanLine = !showScanLine}
					title="レーダースキャン"
				>
					<Radar size={15} />
				</button>
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
		background: #050f05;
		font-family: 'Inter', system-ui, -apple-system, sans-serif;
	}

	/* タイルなし・暗い背景のLeafletマップ */
	:global(.leaflet-container) {
		background: #050f05 !important;
	}
	:global(.leaflet-tile-pane) { display: none; }

	:global(.spawn-label-tip) {
		background: rgba(5,15,5,0.92) !important;
		border: 1px solid rgba(74,222,128,0.4) !important;
		color: #4ade80 !important;
		font-size: 10px !important;
		font-weight: 700 !important;
		font-family: monospace !important;
		padding: 2px 6px !important;
		border-radius: 4px !important;
		box-shadow: 0 0 8px rgba(74,222,128,0.2) !important;
		letter-spacing: 0.05em !important;
		white-space: nowrap !important;
	}
	:global(.spawn-label-tip::before) { display: none !important; }

	.viewer-container {
		position: relative;
		width: 100vw;
		height: 100vh;
		color: #4ade80;
		overflow: hidden;
	}

	.map-wrapper {
		position: absolute;
		inset: 0;
		z-index: 1;
	}

	/* ─── スキャンラインオーバーレイ（MGSレーダー風） ─── */
	.scanline-overlay {
		position: absolute;
		inset: 0;
		z-index: 5;
		pointer-events: none;
		overflow: hidden;
	}
	.scanline-sweep {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 300%;
		height: 300%;
		transform: translate(-50%, -50%);
		background: conic-gradient(
			from 0deg,
			transparent 0deg,
			transparent 340deg,
			rgba(74, 222, 128, 0.07) 350deg,
			rgba(74, 222, 128, 0.18) 360deg
		);
		animation: radar-sweep 4s linear infinite;
	}
	@keyframes radar-sweep {
		from { transform: translate(-50%, -50%) rotate(0deg); }
		to   { transform: translate(-50%, -50%) rotate(360deg); }
	}

	/* CRTスキャンライン（常時微弱） */
	.crt-overlay {
		position: absolute;
		inset: 0;
		z-index: 6;
		pointer-events: none;
		background: repeating-linear-gradient(
			0deg,
			transparent,
			transparent 3px,
			rgba(0, 0, 0, 0.04) 3px,
			rgba(0, 0, 0, 0.04) 4px
		);
	}

	/* ── 生存者オーバーレイ ── */
	.alive-overlay {
		position: absolute;
		top: 12px;
		left: 12px;
		z-index: 500;
		display: flex;
		flex-direction: column;
		gap: 6px;
		pointer-events: none;
	}
	.alive-team {
		display: flex;
		align-items: center;
		gap: 8px;
		background: rgba(5,15,5,0.88);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(74,222,128,0.2);
		border-radius: 10px;
		padding: 7px 12px;
		min-width: 110px;
	}
	.alive-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
	.alive-name { flex: 1; font-size: 0.75rem; font-weight: 600; color: rgba(74,222,128,0.65); font-family: monospace; }
	.alive-count { font-size: 1.05rem; font-weight: 800; font-variant-numeric: tabular-nums; font-family: monospace; }
	.alive-total { font-size: 0.68rem; opacity: 0.4; font-weight: 600; }

	/* ── デバッグパネル ── */
	.debug-panel {
		position: absolute;
		top: 12px;
		right: 12px;
		z-index: 500;
		background: rgba(5,15,5,0.88);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(74,222,128,0.15);
		border-radius: 10px;
		padding: 10px 14px;
		min-width: 160px;
		max-width: 240px;
		display: flex;
		flex-direction: column;
		gap: 5px;
		pointer-events: none;
	}
	.debug-title {
		font-size: 0.72rem;
		font-weight: 700;
		color: rgba(74,222,128,0.5);
		margin-bottom: 2px;
		font-family: monospace;
		letter-spacing: 0.05em;
	}
	.debug-row {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.68rem;
		color: rgba(74,222,128,0.65);
		font-family: monospace;
	}
	.debug-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.debug-row code {
		font-size: 0.62rem;
		background: rgba(74,222,128,0.08);
		padding: 1px 4px;
		border-radius: 3px;
	}
	.muted { color: rgba(74,222,128,0.3) !important; font-size: 0.63rem; }

	/* ── 境界線なし ── */
	.no-boundary-badge {
		position: absolute;
		bottom: 80px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 500;
		background: rgba(251,191,36,0.1);
		border: 1px solid rgba(251,191,36,0.35);
		color: #fbbf24;
		font-size: 0.72rem;
		font-weight: 600;
		padding: 5px 14px;
		border-radius: 20px;
		white-space: nowrap;
		pointer-events: auto;
	}
	.no-boundary-badge a { color: #fbbf24; text-decoration: underline; }

	/* ── 待機中参加パネル ── */
	.join-panel {
		position: absolute;
		top: 50%;
		left: 20px;
		transform: translateY(-50%);
		z-index: 800;
		background: rgba(5,15,5,0.96);
		backdrop-filter: blur(20px);
		border: 1px solid rgba(74,222,128,0.3);
		border-radius: 16px;
		padding: 16px 18px;
		width: 218px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		box-shadow: 0 0 30px rgba(74,222,128,0.08), 0 8px 32px rgba(0,0,0,0.6);
	}
	.join-panel-header { width: 100%; display: flex; align-items: center; justify-content: space-between; }
	.join-panel-title { font-size: 0.85rem; font-weight: 800; color: #4ade80; text-shadow: 0 0 8px rgba(74,222,128,0.5); }
	.join-panel-close { background: none; border: none; color: rgba(74,222,128,0.35); font-size: 0.85rem; cursor: pointer; padding: 2px 4px; }
	.join-panel-close:hover { color: #4ade80; }
	.join-panel-sub { font-size: 0.68rem; color: rgba(74,222,128,0.45); margin: 0; text-align: center; }
	.join-qr { width: 160px; height: 160px; border-radius: 10px; border: 1px solid rgba(74,222,128,0.2); }
	.join-url {
		font-size: 0.62rem;
		font-family: monospace;
		color: rgba(74,222,128,0.4);
		background: rgba(74,222,128,0.04);
		border: 1px solid rgba(74,222,128,0.1);
		padding: 3px 8px;
		border-radius: 5px;
		width: 100%;
		text-align: center;
		box-sizing: border-box;
	}
	.join-players { width: 100%; }
	.join-players-none { font-size: 0.7rem; color: rgba(74,222,128,0.25); text-align: center; display: block; }
	.join-players-count { font-size: 0.72rem; color: #4ade80; font-weight: 700; display: block; text-align: center; margin-bottom: 6px; }
	.join-player-list { display: flex; flex-direction: column; gap: 4px; max-height: 90px; overflow-y: auto; }
	.join-player-item { display: flex; align-items: center; gap: 6px; font-size: 0.7rem; color: rgba(74,222,128,0.7); font-family: monospace; }
	.join-player-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.join-player-team { margin-left: auto; color: rgba(74,222,128,0.35); font-size: 0.62rem; }
	.join-start-btn {
		width: 100%;
		padding: 11px;
		background: #4ade80;
		color: #020c02;
		border: none;
		border-radius: 10px;
		font-size: 0.88rem;
		font-weight: 800;
		cursor: pointer;
		letter-spacing: 0.04em;
		box-shadow: 0 0 16px rgba(74,222,128,0.4);
	}
	.join-start-btn:hover:not(:disabled) { background: #22c55e; box-shadow: 0 0 24px rgba(74,222,128,0.6); }
	.join-start-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	/* ── 試合設定 ── */
	.settings-section {
		width: 100%;
		background: rgba(74,222,128,0.03);
		border: 1px solid rgba(74,222,128,0.1);
		border-radius: 10px;
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.settings-title { font-size: 0.68rem; font-weight: 700; color: rgba(74,222,128,0.4); letter-spacing: 0.05em; }
	.settings-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.settings-label { font-size: 0.68rem; color: rgba(74,222,128,0.55); white-space: nowrap; }
	.settings-select {
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.15);
		border-radius: 5px;
		color: #4ade80;
		font-size: 0.68rem;
		padding: 3px 5px;
		flex: 1;
	}
	.settings-inline { display: flex; align-items: center; gap: 4px; }
	.settings-num {
		width: 52px;
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.15);
		border-radius: 5px;
		color: #4ade80;
		font-size: 0.78rem;
		padding: 3px 5px;
		text-align: center;
	}
	.settings-unit { font-size: 0.68rem; color: rgba(74,222,128,0.45); }
	.settings-team-btns { display: flex; gap: 4px; }
	.settings-team-btn {
		width: 28px; height: 22px;
		border-radius: 5px;
		border: 1px solid rgba(74,222,128,0.15);
		background: rgba(74,222,128,0.04);
		color: rgba(74,222,128,0.35);
		font-size: 0.75rem; font-weight: 700;
		cursor: pointer;
	}
	.settings-team-btn.active { border-color: #4ade80; background: rgba(74,222,128,0.15); color: #4ade80; }
	.settings-team-names { display: flex; gap: 4px; flex-wrap: wrap; }
	.settings-team-name-input {
		flex: 1; min-width: 55px;
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.15);
		border-radius: 5px;
		color: #4ade80;
		font-size: 0.68rem;
		padding: 3px 5px;
	}
	.settings-save-btn {
		width: 100%;
		padding: 6px;
		background: rgba(74,222,128,0.08);
		border: 1px solid rgba(74,222,128,0.25);
		border-radius: 7px;
		color: #4ade80;
		font-size: 0.72rem;
		font-weight: 700;
		cursor: pointer;
	}
	.settings-save-btn:hover:not(:disabled) { background: rgba(74,222,128,0.16); }
	.settings-save-btn:disabled { opacity: 0.4; }

	/* ── 下部バー ── */
	.bottom-bar {
		position: absolute;
		bottom: 0;
		left: 0;
		right: 0;
		z-index: 1000;
		background: rgba(5,15,5,0.94);
		backdrop-filter: blur(16px);
		border-top: 1px solid rgba(74,222,128,0.12);
		padding: 5px 12px 8px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.legend-row {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		padding: 2px 0;
	}
	.legend-item { display: flex; align-items: center; gap: 5px; font-size: 0.68rem; color: rgba(74,222,128,0.7); }
	.legend-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.legend-name { font-weight: 500; font-family: monospace; }
	.hit-badge { font-size: 0.62rem; opacity: 0.7; }
	.team-label {
		font-size: 0.62rem;
		font-weight: 800;
		letter-spacing: 0.06em;
		color: rgba(74,222,128,0.3);
		padding-right: 4px;
		border-right: 1px solid rgba(74,222,128,0.12);
		margin-right: 2px;
	}

	.control-row { display: flex; align-items: center; gap: 8px; }

	.back-btn {
		display: flex;
		align-items: center;
		color: rgba(74,222,128,0.3);
		text-decoration: none;
		transition: color 0.15s;
		flex-shrink: 0;
	}
	.back-btn:hover { color: #4ade80; }

	.status-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.66rem;
		font-weight: 700;
		color: var(--c);
		background: color-mix(in srgb, var(--c) 10%, transparent);
		border: 1px solid color-mix(in srgb, var(--c) 28%, transparent);
		padding: 3px 8px;
		border-radius: 20px;
		white-space: nowrap;
		flex-shrink: 0;
		font-family: monospace;
		letter-spacing: 0.04em;
	}

	.status-btn {
		background: rgba(74,222,128,0.07);
		color: #4ade80;
		border: 1px solid rgba(74,222,128,0.2);
		padding: 3px 10px;
		border-radius: 7px;
		font-size: 0.66rem;
		font-weight: 700;
		cursor: pointer;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.status-btn:hover:not(:disabled) { background: rgba(74,222,128,0.14); }
	.status-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	.mode-toggle {
		display: flex;
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.12);
		border-radius: 7px;
		overflow: hidden;
		flex-shrink: 0;
	}
	.mode-btn {
		background: transparent;
		color: rgba(74,222,128,0.3);
		border: none;
		padding: 4px 10px;
		font-size: 0.63rem;
		font-weight: 800;
		cursor: pointer;
		letter-spacing: 0.04em;
		transition: all 0.15s;
		white-space: nowrap;
		font-family: monospace;
	}
	.mode-active-live { background: rgba(239,68,68,0.15); color: #f87171; }
	.mode-active-replay { background: rgba(74,222,128,0.12); color: #4ade80; }

	.seek-group {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 1;
		min-width: 0;
	}
	.icon-btn {
		background: transparent;
		color: rgba(74,222,128,0.35);
		border: none;
		cursor: pointer;
		display: flex;
		align-items: center;
		padding: 0;
		transition: color 0.15s;
		flex-shrink: 0;
	}
	.icon-btn:hover { color: #4ade80; }
	.play-btn {
		background: #4ade80;
		color: #020c02;
		border: none;
		width: 30px;
		height: 30px;
		border-radius: 50%;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex-shrink: 0;
		box-shadow: 0 0 10px rgba(74,222,128,0.4);
	}
	.play-btn:hover { box-shadow: 0 0 18px rgba(74,222,128,0.6); }
	.seekbar {
		flex: 1;
		min-width: 0;
		height: 3px;
		-webkit-appearance: none;
		appearance: none;
		background: rgba(74,222,128,0.15);
		border-radius: 2px;
		outline: none;
		cursor: pointer;
	}
	.seekbar::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 12px;
		height: 12px;
		background: #4ade80;
		border-radius: 50%;
		box-shadow: 0 0 6px rgba(74,222,128,0.6);
	}
	.time-label {
		font-size: 0.67rem;
		font-variant-numeric: tabular-nums;
		color: #4ade80;
		font-weight: 700;
		white-space: nowrap;
		flex-shrink: 0;
		font-family: monospace;
	}
	.speed-btn {
		background: transparent;
		color: rgba(74,222,128,0.4);
		border: none;
		cursor: pointer;
		font-size: 0.67rem;
		font-weight: 800;
		padding: 0;
		white-space: nowrap;
		flex-shrink: 0;
		font-family: monospace;
	}
	.speed-btn:hover { color: #4ade80; }

	.tool-btns { display: flex; gap: 4px; margin-left: auto; flex-shrink: 0; }
	.tool-btn {
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.12);
		color: rgba(74,222,128,0.35);
		border-radius: 6px;
		width: 29px;
		height: 29px;
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		transition: all 0.15s;
	}
	.tool-btn:hover { color: #4ade80; background: rgba(74,222,128,0.12); }
	.tool-btn-active-green { color: #4ade80 !important; background: rgba(74,222,128,0.18) !important; border-color: rgba(74,222,128,0.45) !important; box-shadow: 0 0 8px rgba(74,222,128,0.3); }
	.tool-btn-active { color: #f97316 !important; background: rgba(249,115,22,0.15) !important; border-color: rgba(249,115,22,0.4) !important; }

	/* ── モーダル ── */
	.modal-overlay {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.82);
		z-index: 2000;
		display: flex;
		align-items: center;
		justify-content: center;
		backdrop-filter: blur(4px);
	}
	.modal-box {
		background: #050f05;
		border: 1px solid rgba(74,222,128,0.2);
		border-radius: 16px;
		padding: 26px 22px 20px;
		min-width: 260px;
		max-width: 420px;
		width: 90vw;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 12px;
		box-shadow: 0 0 30px rgba(74,222,128,0.1);
	}
	.modal-wide { max-width: 560px; align-items: stretch; }
	.modal-title { font-size: 1.05rem; font-weight: 700; margin: 0; color: #4ade80; }
	.modal-sub { font-size: 0.75rem; color: rgba(74,222,128,0.4); margin: -4px 0; text-align: center; }
	.modal-url { font-size: 0.68rem; font-family: monospace; color: rgba(74,222,128,0.35); word-break: break-all; text-align: center; }
	.modal-close {
		margin-top: 4px;
		background: rgba(74,222,128,0.07);
		border: 1px solid rgba(74,222,128,0.2);
		color: #4ade80;
		border-radius: 7px;
		padding: 7px 22px;
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		width: 100%;
	}
	.modal-close:hover { background: rgba(74,222,128,0.14); }
	.qr-img { border-radius: 10px; width: 200px; height: 200px; }

	/* ── 統計テーブル ── */
	.stats-table { width: 100%; display: flex; flex-direction: column; gap: 2px; }
	.stats-header {
		display: grid;
		grid-template-columns: 1.8fr 0.8fr 1fr 1fr 1fr;
		gap: 8px;
		font-size: 0.65rem;
		font-weight: 700;
		color: rgba(74,222,128,0.35);
		padding: 4px 8px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-family: monospace;
	}
	.stats-row {
		display: grid;
		grid-template-columns: 1.8fr 0.8fr 1fr 1fr 1fr;
		gap: 8px;
		font-size: 0.76rem;
		padding: 7px 8px;
		border-radius: 7px;
		background: rgba(74,222,128,0.03);
		align-items: center;
		border-left: 2px solid var(--c);
	}
	.stats-name { display: flex; align-items: center; gap: 7px; font-weight: 600; color: rgba(74,222,128,0.8); }
	.stats-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
	.stats-team { color: rgba(74,222,128,0.4); font-size: 0.68rem; }
	.stats-val { font-variant-numeric: tabular-nums; color: rgba(74,222,128,0.65); font-family: monospace; }
	.stats-result { font-size: 0.7rem; }
</style>
