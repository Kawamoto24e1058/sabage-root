<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { db, auth } from '$lib/firebase';
	import { signInAnonymously } from 'firebase/auth';
	import { doc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
	import type { RoutePoint } from 'shared-types';

	const matchId = page.params.matchId;

	const TEAM_COLORS = [
		{ label: 'レッド',   value: '#ef4444' },
		{ label: 'ブルー',   value: '#3b82f6' },
		{ label: 'グリーン', value: '#22c55e' },
		{ label: 'イエロー', value: '#eab308' },
		{ label: 'パープル', value: '#a855f7' },
		{ label: 'オレンジ', value: '#f97316' },
	];

	type Screen = 'setup' | 'tracking' | 'done';
	let screen = $state<Screen>('setup');

	// Setup
	let playerName = $state('');
	let selectedTeam = $state<'A' | 'B'>('A');
	let selectedColor = $state(TEAM_COLORS[0].value);

	// Tracking
	let routeDisplay = $state<RoutePoint[]>([]);
	let lastAccuracy = $state<number | null>(null);
	let isHit = $state(false);
	let elapsed = $state(0);
	let wakeLock = $state<any>(null);
	let wakeLockActive = $state(false);
	let gpsStatus = $state<'waiting' | 'ok' | 'error'>('waiting');

	// Auth
	let uid = $state<string | null>(null);
	let authError = $state(false);

	// Refs (outside reactive state to avoid stale closures)
	let routeRef: RoutePoint[] = [];
	let lastRoutePoint: RoutePoint | null = null;
	let watchId: number | null = null;
	let syncInterval: ReturnType<typeof setInterval> | null = null;
	let timerInterval: ReturnType<typeof setInterval> | null = null;

	const MAX_JUMP_METERS = 50;

	function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
		const R = 6371000;
		const dLat = (lat2 - lat1) * Math.PI / 180;
		const dLng = (lng2 - lng1) * Math.PI / 180;
		const a = Math.sin(dLat / 2) ** 2 +
			Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
		return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
	}

	function formatTime(s: number) {
		return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
	}

	onMount(async () => {
		try {
			const cred = await signInAnonymously(auth);
			uid = cred.user.uid;
		} catch (e) {
			authError = true;
		}
	});

	onDestroy(() => {
		cleanup();
	});

	function cleanup() {
		if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
		if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
		if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
		if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; wakeLockActive = false; }
	}

	async function requestWakeLock() {
		if (!('wakeLock' in navigator)) return;
		try {
			wakeLock = await (navigator as any).wakeLock.request('screen');
			wakeLockActive = true;
			wakeLock.addEventListener('release', () => { wakeLockActive = false; });
		} catch (e) {
			console.warn('Wake Lock failed:', e);
		}
	}

	async function startTracking() {
		if (!uid) return;
		screen = 'tracking';
		routeRef = [];
		lastRoutePoint = null;
		elapsed = 0;
		gpsStatus = 'waiting';

		await requestWakeLock();

		// Firestoreドキュメント初期化
		const logRef = doc(db, 'matches', matchId, 'player_logs', uid);
		await setDoc(logRef, {
			name: playerName.trim() || `Player_${uid.slice(0, 4).toUpperCase()}`,
			teamColor: selectedColor,
			team: selectedTeam,
			route: [],
			lastPosition: null,
			startedAt: serverTimestamp(),
			updatedAt: serverTimestamp(),
		});

		// GPS追跡開始
		watchId = navigator.geolocation.watchPosition(
			(pos) => {
				gpsStatus = 'ok';
				lastAccuracy = Math.round(pos.coords.accuracy);
				const newPoint: RoutePoint = {
					lat: pos.coords.latitude,
					lng: pos.coords.longitude,
					timestamp: pos.timestamp,
				};
				if (lastRoutePoint) {
					const d = haversineM(lastRoutePoint.lat, lastRoutePoint.lng, newPoint.lat, newPoint.lng);
					if (d > MAX_JUMP_METERS) return;
				}
				lastRoutePoint = newPoint;
				routeRef = [...routeRef, newPoint];
				routeDisplay = routeRef;
			},
			(err) => {
				gpsStatus = 'error';
				console.warn('GPS error:', err);
			},
			{ enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
		);

		// 5秒ごとにFirestoreへ同期
		syncInterval = setInterval(async () => {
			if (routeRef.length === 0) return;
			const lastPoint = routeRef[routeRef.length - 1];
			try {
				await updateDoc(logRef, {
					route: routeRef,
					lastPosition: lastPoint,
					updatedAt: serverTimestamp(),
				});
			} catch (e) {
				console.warn('Sync failed:', e);
			}
		}, 5000);

		// タイマー
		timerInterval = setInterval(() => { elapsed++; }, 1000);
	}

	async function finishTracking(hitPosition?: { lat: number; lng: number }) {
		if (!uid) return;
		cleanup();

		const logRef = doc(db, 'matches', matchId, 'player_logs', uid);
		const lastPoint = routeRef[routeRef.length - 1];
		const hitEvent = hitPosition
			? { lat: hitPosition.lat, lng: hitPosition.lng, timestamp: Date.now() }
			: undefined;

		try {
			await setDoc(logRef, {
				name: playerName.trim() || `Player_${uid.slice(0, 4).toUpperCase()}`,
				teamColor: selectedColor,
				team: selectedTeam,
				route: routeRef,
				lastPosition: lastPoint ?? null,
				...(hitEvent ? { hitEvent } : {}),
				finishedAt: serverTimestamp(),
				updatedAt: serverTimestamp(),
			});
		} catch (e) {
			console.error('Final upload failed:', e);
		}
		screen = 'done';
	}

	function handleHit() {
		isHit = true;
		const last = routeRef[routeRef.length - 1];
		finishTracking(last ? { lat: last.lat, lng: last.lng } : undefined);
	}

	function handleStop() {
		finishTracking();
	}
</script>

<svelte:head>
	<title>sabage tracker</title>
	<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
	<meta name="theme-color" content="#0a0a0a" />
	<meta name="mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-capable" content="yes" />
	<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
</svelte:head>

<!-- ══════════════════════════════════════════ -->
<!-- Setup Screen                               -->
<!-- ══════════════════════════════════════════ -->
{#if screen === 'setup'}
<div class="screen setup-screen">
	<div class="setup-header">
		<div class="app-title">🎯 sabage tracker</div>
		<div class="match-chip">試合 {matchId.slice(0, 8)}…</div>
	</div>

	{#if authError}
		<div class="error-banner">⚠ Firebase接続エラー。ネットワークを確認してください。</div>
	{/if}

	<div class="form-group">
		<label class="form-label">プレイヤー名</label>
		<input
			class="form-input"
			type="text"
			placeholder="例: ハルくん"
			maxlength="20"
			bind:value={playerName}
		/>
	</div>

	<div class="form-group">
		<label class="form-label">チーム</label>
		<div class="team-row">
			{#each (['A', 'B'] as const) as t}
				<button
					class="team-btn {selectedTeam === t ? 'team-btn-active' : ''}"
					onclick={() => selectedTeam = t}
				>チーム {t}</button>
			{/each}
		</div>
	</div>

	<div class="form-group">
		<label class="form-label">カラー</label>
		<div class="color-grid">
			{#each TEAM_COLORS as c}
				<button
					class="color-btn {selectedColor === c.value ? 'color-btn-selected' : ''}"
					style="background: {c.value}"
					onclick={() => selectedColor = c.value}
					title={c.label}
				>
					{#if selectedColor === c.value}<span class="color-check">✓</span>{/if}
				</button>
			{/each}
		</div>
	</div>

	<button
		class="start-btn"
		style="--color: {selectedColor}"
		onclick={startTracking}
		disabled={!uid}
	>
		{uid ? 'トラッキング開始' : '接続中…'}
	</button>

	<p class="wake-note">📱 画面は自動的にオフになりません<br>ポケットに入れても記録されます</p>
</div>

<!-- ══════════════════════════════════════════ -->
<!-- Tracking Screen                            -->
<!-- ══════════════════════════════════════════ -->
{:else if screen === 'tracking'}
<div class="screen tracking-screen">

	<!-- ステータスバー -->
	<div class="status-bar">
		<div class="timer">{formatTime(elapsed)}</div>
		<div class="gps-status">
			{#if gpsStatus === 'waiting'}
				<span class="gps-dot gps-waiting"></span> GPS取得中…
			{:else if gpsStatus === 'ok'}
				<span class="gps-dot gps-ok"></span> ±{lastAccuracy}m
			{:else}
				<span class="gps-dot gps-error"></span> GPSエラー
			{/if}
		</div>
		<div class="point-count">{routeDisplay.length}点</div>
	</div>

	<!-- Wake Lock状態 -->
	{#if !wakeLockActive}
		<div class="wake-warn">⚠ 画面が消えるとGPSが止まります</div>
	{/if}

	<!-- プレイヤー情報 -->
	<div class="player-info">
		<div class="player-dot" style="background: {selectedColor}"></div>
		<div class="player-name">{playerName || 'プレイヤー'}</div>
		<div class="player-team">チーム {selectedTeam}</div>
	</div>

	<!-- ヒットボタン -->
	<button class="hit-btn" onclick={handleHit}>
		<span class="hit-icon">💀</span>
		<span class="hit-label">ヒット</span>
	</button>

	<!-- 停止ボタン -->
	<button class="stop-btn" onclick={handleStop}>
		試合終了・データ送信
	</button>
</div>

<!-- ══════════════════════════════════════════ -->
<!-- Done Screen                               -->
<!-- ══════════════════════════════════════════ -->
{:else}
<div class="screen done-screen">
	<div class="done-icon">{isHit ? '💀' : '🏁'}</div>
	<div class="done-title">{isHit ? 'ヒット記録完了' : '試合終了'}</div>
	<div class="done-stats">
		<div class="done-stat">
			<span class="done-stat-label">記録時間</span>
			<span class="done-stat-value">{formatTime(elapsed)}</span>
		</div>
		<div class="done-stat">
			<span class="done-stat-label">記録ポイント</span>
			<span class="done-stat-value">{routeDisplay.length}点</span>
		</div>
	</div>
	<p class="done-note">データはPCのviewerに送信されました</p>
	<button class="retry-btn" onclick={() => { screen = 'setup'; routeDisplay = []; elapsed = 0; isHit = false; }}>
		もう一度参加する
	</button>
</div>
{/if}

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background: #0a0a0a;
		font-family: -apple-system, 'Hiragino Sans', system-ui, sans-serif;
		color: #e5e5e5;
		overscroll-behavior: none;
	}

	.screen {
		min-height: 100svh;
		display: flex;
		flex-direction: column;
		padding: env(safe-area-inset-top, 20px) 24px env(safe-area-inset-bottom, 24px);
		box-sizing: border-box;
	}

	/* ── Setup ── */
	.setup-screen { gap: 24px; padding-top: max(env(safe-area-inset-top), 48px); }

	.setup-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.app-title { font-size: 1.3rem; font-weight: 800; letter-spacing: -0.02em; }
	.match-chip {
		font-size: 0.7rem;
		font-family: monospace;
		color: #6b7280;
		background: rgba(255,255,255,0.05);
		border: 1px solid rgba(255,255,255,0.1);
		padding: 3px 8px;
		border-radius: 6px;
	}

	.error-banner {
		background: rgba(239,68,68,0.15);
		border: 1px solid rgba(239,68,68,0.3);
		color: #f87171;
		border-radius: 10px;
		padding: 10px 14px;
		font-size: 0.85rem;
	}

	.form-group { display: flex; flex-direction: column; gap: 10px; }
	.form-label { font-size: 0.75rem; font-weight: 700; color: #6b7280; letter-spacing: 0.06em; text-transform: uppercase; }

	.form-input {
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 12px;
		padding: 14px 16px;
		font-size: 1rem;
		color: #e5e5e5;
		outline: none;
		width: 100%;
		box-sizing: border-box;
	}
	.form-input:focus { border-color: rgba(255,255,255,0.3); }
	.form-input::placeholder { color: rgba(255,255,255,0.2); }

	.team-row { display: flex; gap: 12px; }
	.team-btn {
		flex: 1;
		padding: 14px;
		border-radius: 12px;
		border: 1.5px solid rgba(255,255,255,0.12);
		background: rgba(255,255,255,0.04);
		color: rgba(255,255,255,0.4);
		font-size: 1rem;
		font-weight: 700;
		cursor: pointer;
	}
	.team-btn-active {
		border-color: #4ade80;
		background: rgba(74,222,128,0.1);
		color: #4ade80;
	}

	.color-grid {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.color-btn {
		width: 48px;
		height: 48px;
		border-radius: 12px;
		border: 2.5px solid transparent;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.color-btn-selected { border-color: #fff; }
	.color-check { color: #fff; font-size: 1.2rem; font-weight: 900; text-shadow: 0 0 6px rgba(0,0,0,0.5); }

	.start-btn {
		margin-top: auto;
		padding: 18px;
		border-radius: 16px;
		border: none;
		background: var(--color, #4ade80);
		color: #000;
		font-size: 1.1rem;
		font-weight: 800;
		cursor: pointer;
		letter-spacing: -0.01em;
	}
	.start-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	.wake-note {
		text-align: center;
		font-size: 0.72rem;
		color: #4b5563;
		line-height: 1.5;
		margin: 0;
	}

	/* ── Tracking ── */
	.tracking-screen {
		padding-top: max(env(safe-area-inset-top), 20px);
		gap: 0;
		justify-content: space-between;
	}

	.status-bar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		background: rgba(255,255,255,0.05);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 14px;
		padding: 12px 18px;
	}
	.timer {
		font-size: 1.4rem;
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.02em;
	}
	.gps-status {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.8rem;
		color: #9ca3af;
	}
	.gps-dot {
		width: 8px; height: 8px;
		border-radius: 50%;
		display: inline-block;
	}
	.gps-waiting { background: #eab308; animation: pulse 1.5s infinite; }
	.gps-ok { background: #4ade80; }
	.gps-error { background: #ef4444; }
	@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }

	.point-count { font-size: 0.8rem; color: #6b7280; }

	.wake-warn {
		background: rgba(234,179,8,0.1);
		border: 1px solid rgba(234,179,8,0.25);
		color: #eab308;
		border-radius: 10px;
		padding: 10px 14px;
		font-size: 0.8rem;
		text-align: center;
		margin-top: 12px;
	}

	.player-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
	}
	.player-dot {
		width: 56px; height: 56px;
		border-radius: 50%;
		border: 3px solid rgba(255,255,255,0.2);
	}
	.player-name { font-size: 1.4rem; font-weight: 700; }
	.player-team { font-size: 0.85rem; color: #6b7280; }

	.hit-btn {
		background: #ef4444;
		border: none;
		border-radius: 20px;
		padding: 28px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		cursor: pointer;
		width: 100%;
		box-shadow: 0 0 40px rgba(239,68,68,0.3);
		transition: transform 0.1s;
	}
	.hit-btn:active { transform: scale(0.97); }
	.hit-icon { font-size: 3rem; line-height: 1; }
	.hit-label { font-size: 1.3rem; font-weight: 900; color: #fff; letter-spacing: 0.05em; }

	.stop-btn {
		margin-top: 14px;
		background: transparent;
		border: 1px solid rgba(255,255,255,0.15);
		border-radius: 12px;
		padding: 14px;
		color: rgba(255,255,255,0.4);
		font-size: 0.9rem;
		font-weight: 600;
		cursor: pointer;
	}
	.stop-btn:active { background: rgba(255,255,255,0.06); }

	/* ── Done ── */
	.done-screen {
		align-items: center;
		justify-content: center;
		gap: 20px;
		text-align: center;
	}
	.done-icon { font-size: 4rem; }
	.done-title { font-size: 1.6rem; font-weight: 800; }
	.done-stats {
		display: flex;
		gap: 24px;
		background: rgba(255,255,255,0.05);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 14px;
		padding: 18px 28px;
	}
	.done-stat { display: flex; flex-direction: column; gap: 4px; }
	.done-stat-label { font-size: 0.7rem; color: #6b7280; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
	.done-stat-value { font-size: 1.4rem; font-weight: 800; font-variant-numeric: tabular-nums; }
	.done-note { font-size: 0.82rem; color: #4b5563; margin: 0; }
	.retry-btn {
		background: rgba(255,255,255,0.08);
		border: 1px solid rgba(255,255,255,0.15);
		border-radius: 12px;
		padding: 14px 28px;
		color: #e5e5e5;
		font-size: 0.95rem;
		font-weight: 600;
		cursor: pointer;
	}
</style>
