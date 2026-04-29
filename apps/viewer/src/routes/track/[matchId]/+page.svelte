<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { db, auth } from '$lib/firebase';
	import { signInAnonymously } from 'firebase/auth';
	import { doc, setDoc, updateDoc, serverTimestamp, getDoc, collection, addDoc } from 'firebase/firestore';
	import type { RoutePoint, Field, SpawnPoint, GameMode, TeamConfig } from 'shared-types';

	const matchId = page.params.matchId;

	const TEAM_COLORS = [
		{ label: 'レッド',   value: '#ef4444' },
		{ label: 'ブルー',   value: '#3b82f6' },
		{ label: 'グリーン', value: '#22c55e' },
		{ label: 'イエロー', value: '#eab308' },
		{ label: 'パープル', value: '#a855f7' },
		{ label: 'オレンジ', value: '#f97316' },
	];

	type Screen = 'setup' | 'spawn' | 'tracking' | 'respawn' | 'done';
	let screen = $state<Screen>('setup');

	// Match settings (fetched from Firestore)
	let gameMode = $state<GameMode>('elimination');
	let matchTeams = $state<TeamConfig[]>([
		{ id: 'A', name: 'チームA' },
		{ id: 'B', name: 'チームB' },
	]);
	let respawnCooldownSec = $state(30);
	let respawnCountdown = $state(0);
	let respawnTimer: ReturnType<typeof setInterval> | null = null;
	let deathCount = $state(0);

	// Setup
	let playerName = $state('');
	let selectedTeam = $state('A');
	let selectedColor = $state(TEAM_COLORS[0].value);

	// Spawn selection
	let field = $state<Field | null>(null);
	let spawnPoints = $state<SpawnPoint[]>([]);
	let selectedSpawnId = $state<string | null>(null);
	let pendingSpawn = $state<SpawnPoint | null>(null); // 選択中（まだ確定していない）
	let spawnGpsLat = $state<number | null>(null);
	let spawnGpsLng = $state<number | null>(null);
	let spawnGpsAccuracy = $state<number | null>(null);
	let spawnConfirming = $state(false);
	let spawnRecorded = $state(false); // GPS記録完了フラグ
	let spawnWatchId: number | null = null;

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
	let trackingError = $state<string | null>(null);

	// ヒット演出
	let hitFlashing = $state(false);
	function triggerHitFlash() {
		hitFlashing = true;
		if (navigator.vibrate) navigator.vibrate([150, 80, 300]);
		setTimeout(() => { hitFlashing = false; }, 1500);
	}

	// テスト用仮想ジョイスティック
	let showJoystick = $state(false);
	let joystickLat = $state(35.6895);
	let joystickLng = $state(139.6917);
	let joystickReady = $state(false);

	const STEP = 0.000009; // ≈ 1m per tap

	async function moveJoystick(dLat: number, dLng: number) {
		if (!uid) return;
		joystickLat += dLat;
		joystickLng += dLng;
		const newPoint: RoutePoint = { lat: joystickLat, lng: joystickLng, timestamp: Date.now() };
		routeRef = [...routeRef, newPoint];
		routeDisplay = routeRef;
		gpsStatus = 'ok';
		// 即時Firestore同期
		const logRef = doc(db, 'matches', matchId, 'player_logs', uid);
		try {
			const { updateDoc: upd, serverTimestamp: sts } = await import('firebase/firestore');
			await upd(logRef, { route: routeRef, lastPosition: newPoint, updatedAt: sts() });
		} catch(e) { console.warn(e); }
	}

	// ── Kalmanフィルター（GPS平滑化）──────────────────────────────────────
	// GPS座標のノイズをベイズ的に抑える。lat/lngそれぞれに1インスタンス使う。
	// q: プロセスノイズ（小さいほど「前の推定」を信頼）
	// r: 観測ノイズ（大きいほどGPS測定値を疑う）
	class KalmanFilter1D {
		private q: number;
		private r: number;
		private p = 1;
		private x = 0;
		private initialized = false;

		constructor(q = 0.000001, r = 0.0001) {
			this.q = q;
			this.r = r;
		}

		filter(measurement: number, accuracy = 10): number {
			if (!this.initialized) {
				this.x = measurement;
				this.initialized = true;
				return measurement;
			}
			// GPS精度が悪いほど観測ノイズを増やす（測定値を信じにくくする）
			const r = this.r * Math.max(1, accuracy / 5);
			this.p += this.q;
			const k = this.p / (this.p + r);
			this.x += k * (measurement - this.x);
			this.p *= (1 - k);
			return this.x;
		}

		reset() { this.initialized = false; }
	}

	// Refs (outside reactive state to avoid stale closures)
	let routeRef: RoutePoint[] = [];
	let lastRoutePoint: RoutePoint | null = null;
	let watchId: number | null = null;
	let syncInterval: ReturnType<typeof setInterval> | null = null;
	let timerInterval: ReturnType<typeof setInterval> | null = null;
	let kalmanLat = new KalmanFilter1D();
	let kalmanLng = new KalmanFilter1D();

	const MAX_JUMP_METERS = 80; // Kalmanで平滑化するので少し緩める

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

	// ── プロフィール（localStorage永続化）──────────────────────────────────
	const PROFILE_KEY = 'sabage-profile';

	function loadProfile() {
		try {
			const raw = localStorage.getItem(PROFILE_KEY);
			if (!raw) return;
			const p = JSON.parse(raw);
			if (p.name) playerName = p.name;
			if (p.color && TEAM_COLORS.some(c => c.value === p.color)) selectedColor = p.color;
		} catch (e) { /* ignore */ }
	}

	function saveProfile() {
		try {
			localStorage.setItem(PROFILE_KEY, JSON.stringify({
				name: playerName.trim(),
				color: selectedColor,
			}));
		} catch (e) { /* ignore */ }
	}

	onMount(async () => {
		loadProfile();
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

	// セットアップ完了 → スポーン選択 or 直接トラッキング
	async function handleSetupNext() {
		if (!uid) return;
		// マッチ＋フィールド取得
		try {
			const matchDoc = await getDoc(doc(db, 'matches', matchId));
			if (matchDoc.exists()) {
				const matchData = matchDoc.data();
				// ゲームモード・チーム設定を反映
				if (matchData.gameMode) gameMode = matchData.gameMode;
				if (matchData.teams && matchData.teams.length > 0) matchTeams = matchData.teams;
				if (matchData.respawnCooldownSec) respawnCooldownSec = matchData.respawnCooldownSec;
				if (matchData.fieldId) {
					const fieldDoc = await getDoc(doc(db, 'fields', matchData.fieldId));
					if (fieldDoc.exists()) {
						field = fieldDoc.data() as Field;
						spawnPoints = field.spawnPoints ?? [];
					}
				}
			}
		} catch (e) {
			console.warn('Field fetch failed:', e);
		}

		if (spawnPoints.length > 0) {
			screen = 'spawn';
			// GPS先読み開始（スポーンに到着してからタップするとき精度が出やすい）
			spawnWatchId = navigator.geolocation.watchPosition(
				(pos) => {
					spawnGpsLat = pos.coords.latitude;
					spawnGpsLng = pos.coords.longitude;
					spawnGpsAccuracy = Math.round(pos.coords.accuracy);
				},
				() => {},
				{ enableHighAccuracy: true, maximumAge: 0 }
			);
		} else {
			startTracking();
		}
	}

	// Step1: スポーンを選択（確認画面へ遷移するだけ）
	function chooseSpawn(spawn: SpawnPoint) {
		pendingSpawn = spawn;
		spawnRecorded = false;
	}

	// Step2: 「ここで記録して開始」→ GPS書き込み → トラッキング開始
	async function confirmSpawn() {
		if (!uid || !pendingSpawn || spawnConfirming) return;
		spawnConfirming = true;

		if (spawnGpsLat !== null && spawnGpsLng !== null) {
			try {
				await addDoc(collection(db, 'matches', matchId, 'calibrations'), {
					spawnId: pendingSpawn.id,
					lat: spawnGpsLat,
					lng: spawnGpsLng,
					uid,
					timestamp: serverTimestamp(),
				});
				spawnRecorded = true;
			} catch (e) {
				console.warn('Calibration write failed:', e);
			}
		}

		selectedSpawnId = pendingSpawn.id;
		if (spawnWatchId !== null) {
			navigator.geolocation.clearWatch(spawnWatchId);
			spawnWatchId = null;
		}
		spawnConfirming = false;
		startTracking();
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
		saveProfile(); // プロフィールをlocalStorageに保存
		screen = 'tracking';
		routeRef = [];
		lastRoutePoint = null;
		elapsed = 0;
		gpsStatus = 'waiting';
		kalmanLat.reset();
		kalmanLng.reset();

		await requestWakeLock();

		// Firestoreドキュメント初期化
		const logRef = doc(db, 'matches', matchId, 'player_logs', uid);
		try {
			await setDoc(logRef, {
				name: playerName.trim() || `Player_${uid.slice(0, 4).toUpperCase()}`,
				teamColor: selectedColor,
				team: selectedTeam,
				route: [],
				lastPosition: null,
				...(selectedSpawnId ? { spawnId: selectedSpawnId } : {}),
				startedAt: serverTimestamp(),
				updatedAt: serverTimestamp(),
			});
			trackingError = null;
		} catch (e: any) {
			trackingError = e?.message ?? String(e);
			console.error('setDoc failed:', e);
		}

		// GPS追跡開始
		watchId = navigator.geolocation.watchPosition(
			async (pos) => {
				gpsStatus = 'ok';
				const accuracy = pos.coords.accuracy;
				lastAccuracy = Math.round(accuracy);

				// Kalmanフィルターでノイズ除去
				const smoothedLat = kalmanLat.filter(pos.coords.latitude, accuracy);
				const smoothedLng = kalmanLng.filter(pos.coords.longitude, accuracy);

				const newPoint: RoutePoint = {
					lat: smoothedLat,
					lng: smoothedLng,
					timestamp: pos.timestamp,
				};

				// 急ジャンプ除去（Kalman後でも稀に発生するアウトライアーを弾く）
				if (lastRoutePoint) {
					const d = haversineM(lastRoutePoint.lat, lastRoutePoint.lng, newPoint.lat, newPoint.lng);
					if (d > MAX_JUMP_METERS) return;
				}
				lastRoutePoint = newPoint;
				routeRef = [...routeRef, newPoint];
				routeDisplay = routeRef;

				// ジョイスティック初期位置を実GPS座標に合わせる
				if (!joystickReady) {
					joystickLat = smoothedLat;
					joystickLng = smoothedLng;
					joystickReady = true;
				}

				// 初回GPS取得時はすぐにFirestoreへ書き込む（Viewerにリアルタイム表示）
				if (routeRef.length === 1) {
					try {
						await updateDoc(logRef, {
							route: routeRef,
							lastPosition: newPoint,
							updatedAt: serverTimestamp(),
						});
					} catch (e) {
						console.warn('First position sync failed:', e);
					}

					// スポーンを選択していれば最初のGPS点でキャリブを自動記録
					// 明示的に「到着ボタン」を押さなくても2人以上参加すれば変換が成立する
					if (selectedSpawnId && uid) {
						try {
							await addDoc(collection(db, 'matches', matchId, 'calibrations'), {
								spawnId: selectedSpawnId,
								lat: smoothedLat,
								lng: smoothedLng,
								uid,
								auto: true, // 自動記録フラグ（手動記録より重みを下げる用途に使える）
								timestamp: serverTimestamp(),
							});
						} catch (e) {
							console.warn('Auto calibration write failed:', e);
						}
					}
				}
			},
			(err) => {
				gpsStatus = 'error';
				console.warn('GPS error:', err);
			},
			{ enableHighAccuracy: true, timeout: 30000, maximumAge: 0 }
		);

		// 3秒ごとにFirestoreへ同期（初回は watchPosition コールバック内で即時送信）
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
		}, 3000);

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

	function cleanup() {
		if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
		if (spawnWatchId !== null) { navigator.geolocation.clearWatch(spawnWatchId); spawnWatchId = null; }
		if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
		if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
		if (respawnTimer) { clearInterval(respawnTimer); respawnTimer = null; }
		if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; wakeLockActive = false; }
	}

	async function handleHit() {
		triggerHitFlash();
		const last = routeRef[routeRef.length - 1];
		const hitPos = last ? { lat: last.lat, lng: last.lng } : undefined;

		if (gameMode === 'elimination') {
			// 殲滅戦: そのまま終了
			isHit = true;
			finishTracking(hitPos);
		} else {
			// 復活あり: ヒットを記録しつつ tracking 継続 or 待機
			deathCount++;
			if (hitPos && uid) {
				const logRef = doc(db, 'matches', matchId, 'player_logs', uid);
				try {
					const { arrayUnion } = await import('firebase/firestore');
					await updateDoc(logRef, {
						hitEvent: { ...hitPos, timestamp: Date.now() },
						hitEvents: arrayUnion({ ...hitPos, timestamp: Date.now() }),
					});
				} catch(e) { console.warn(e); }
			}

			if (gameMode === 'unlimited_respawn') {
				screen = 'respawn';
			} else {
				// timed_respawn: カウントダウン
				respawnCountdown = respawnCooldownSec;
				screen = 'respawn';
				respawnTimer = setInterval(() => {
					respawnCountdown--;
					if (respawnCountdown <= 0) {
						clearInterval(respawnTimer!);
						respawnTimer = null;
						handleRespawn();
					}
				}, 1000);
			}
		}
	}

	async function handleRespawn() {
		if (respawnTimer) { clearInterval(respawnTimer); respawnTimer = null; }
		// 復活: hitEvent をクリアして追跡再開
		if (uid) {
			const logRef = doc(db, 'matches', matchId, 'player_logs', uid);
			try {
				await updateDoc(logRef, { hitEvent: null });
			} catch(e) { console.warn(e); }
		}
		screen = 'tracking';
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
		{#if playerName}
			<p class="profile-saved-hint">✓ 前回の設定を引き継ぎました</p>
		{/if}
	</div>

	<div class="form-group">
		<label class="form-label">チーム</label>
		<div class="team-row">
			{#each matchTeams as t}
				<button
					class="team-btn {selectedTeam === t.id ? 'team-btn-active' : ''}"
					onclick={() => selectedTeam = t.id}
				>{t.name}</button>
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
		onclick={handleSetupNext}
		disabled={!uid}
	>
		{uid ? '次へ →' : '接続中…'}
	</button>

	<p class="wake-note">📱 画面は自動的にオフになりません<br>ポケットに入れても記録されます</p>
</div>

<!-- ══════════════════════════════════════════ -->
<!-- Spawn Selection Screen                     -->
<!-- ══════════════════════════════════════════ -->
{:else if screen === 'spawn'}
<div class="screen spawn-screen">

	{#if !pendingSpawn}
	<!-- ── STEP 1: スポーン選択 ── -->
	<div class="spawn-header">
		<div class="spawn-title">📍 スポーンに立って選択</div>
		<div class="spawn-sub">今いるスポーン地点を選ぶと、GPS位置が記録されてマップ上の追跡が正確になります</div>
	</div>

	<!-- ミニマップ（参考表示） -->
	{#if field?.virtualBoundary && field.virtualBoundary.length >= 3}
	<div class="spawn-map-wrap">
		<svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" class="spawn-map-svg"
			style="width:100%;height:100%;">
			<polygon
				points={field.virtualBoundary.map((p: {x:number;y:number}) => `${p.x*100},${p.y*100}`).join(' ')}
				fill="rgba(74,222,128,0.08)" stroke="#4ade80" stroke-width="0.7" />
			{#each spawnPoints as sp, i}
				<g onclick={() => chooseSpawn(sp)} style="cursor:pointer;">
					<circle cx={sp.x*100} cy={sp.y*100} r="8" fill="transparent" />
					<circle cx={sp.x*100} cy={sp.y*100} r="4.5"
						fill="rgba(10,10,10,0.92)" stroke="#4ade80" stroke-width="0.7" />
					<text x={sp.x*100} y={sp.y*100} fill="#4ade80"
						font-size="3.2" font-weight="bold"
						text-anchor="middle" dominant-baseline="central"
						pointer-events="none">{i+1}</text>
				</g>
			{/each}
		</svg>
	</div>
	{/if}

	<!-- スポーンボタンリスト（メイン操作） -->
	<div class="spawn-btn-list">
		{#each spawnPoints as sp, i}
			<button class="spawn-list-btn" onclick={() => chooseSpawn(sp)}>
				<div class="spawn-list-num">{i + 1}</div>
				<div class="spawn-list-label">{sp.label}</div>
				<div class="spawn-list-arrow">→</div>
			</button>
		{/each}
	</div>

	<button class="skip-btn" onclick={() => startTracking()}>
		スキップ（スポーン選択なし）
	</button>

	{:else}
	<!-- ── STEP 2: GPS確認 → 記録して開始 ── -->
	<div class="spawn-confirm-screen">
		<button class="spawn-back-btn" onclick={() => pendingSpawn = null}>← 選び直す</button>

		<div class="spawn-confirm-title">
			<div class="spawn-confirm-num">{spawnPoints.indexOf(pendingSpawn) + 1}</div>
			<div>
				<div class="spawn-confirm-name">{pendingSpawn.label}</div>
				<div class="spawn-confirm-sub">このスポーン地点に立っていますか？</div>
			</div>
		</div>

		<!-- GPS精度（大きく表示） -->
		<div class="gps-accuracy-card">
			{#if spawnGpsAccuracy === null}
				<div class="gps-acc-icon gps-waiting-icon">📡</div>
				<div class="gps-acc-label">GPS取得中…</div>
				<div class="gps-acc-hint">屋外に出て少し待ってください</div>
			{:else if spawnGpsAccuracy <= 10}
				<div class="gps-acc-icon">✅</div>
				<div class="gps-acc-value">±{spawnGpsAccuracy}m</div>
				<div class="gps-acc-label" style="color:#4ade80">GPS良好 — 記録可能</div>
			{:else if spawnGpsAccuracy <= 25}
				<div class="gps-acc-icon">🟡</div>
				<div class="gps-acc-value">±{spawnGpsAccuracy}m</div>
				<div class="gps-acc-label" style="color:#facc15">GPS普通 — 記録可能</div>
			{:else}
				<div class="gps-acc-icon">⚠️</div>
				<div class="gps-acc-value">±{spawnGpsAccuracy}m</div>
				<div class="gps-acc-label" style="color:#f87171">GPS精度低め — 待つと改善します</div>
			{/if}
		</div>

		<!-- 説明 -->
		<div class="spawn-confirm-info">
			<div class="info-row">📍 スポーン地点に正確に立つと精度が上がります</div>
			<div class="info-row">👥 2人が別々のスポーンで記録するとマップ追跡が最も正確になります</div>
		</div>

		<!-- 記録して開始ボタン -->
		<button
			class="spawn-go-btn"
			onclick={confirmSpawn}
			disabled={spawnConfirming}
		>
			{#if spawnConfirming}
				記録中…
			{:else if spawnGpsAccuracy === null}
				GPS未取得でもここから開始する
			{:else}
				✓ ここで記録して開始する
			{/if}
		</button>
	</div>
	{/if}

</div>

<!-- ══════════════════════════════════════════ -->
<!-- Tracking Screen                            -->
<!-- ══════════════════════════════════════════ -->
{:else if screen === 'tracking'}
<div class="screen tracking-screen">

	<!-- ヒットフラッシュオーバーレイ -->
	{#if hitFlashing}
		<div class="hit-flash-overlay">
			<div class="hit-flash-text">HIT!</div>
		</div>
	{/if}

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

	<!-- Firestoreエラー -->
	{#if trackingError}
		<div class="wake-warn" style="border-color:rgba(239,68,68,0.4);background:rgba(239,68,68,0.1);color:#f87171;">
			⚠ データ送信エラー: {trackingError}
		</div>
	{/if}

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

	<!-- テスト用ジョイスティック -->
	<div class="joystick-toggle-row">
		<button class="joystick-toggle" onclick={() => showJoystick = !showJoystick}>
			🕹 テスト移動 {showJoystick ? '▲' : '▼'}
		</button>
	</div>

	{#if showJoystick}
		<div class="dpad">
			<div class="dpad-row">
				<button class="dpad-btn" onclick={() => moveJoystick(STEP * 5, 0)}>↑↑</button>
			</div>
			<div class="dpad-row">
				<button class="dpad-btn" onclick={() => moveJoystick(STEP, 0)}>↑</button>
			</div>
			<div class="dpad-mid">
				<button class="dpad-btn" onclick={() => moveJoystick(0, -STEP * 5)}>←←</button>
				<button class="dpad-btn" onclick={() => moveJoystick(0, -STEP)}>←</button>
				<div class="dpad-center">{routeDisplay.length}pt</div>
				<button class="dpad-btn" onclick={() => moveJoystick(0, STEP)}>→</button>
				<button class="dpad-btn" onclick={() => moveJoystick(0, STEP * 5)}>→→</button>
			</div>
			<div class="dpad-row">
				<button class="dpad-btn" onclick={() => moveJoystick(-STEP, 0)}>↓</button>
			</div>
			<div class="dpad-row">
				<button class="dpad-btn" onclick={() => moveJoystick(-STEP * 5, 0)}>↓↓</button>
			</div>
		</div>
	{/if}

	<!-- 停止ボタン -->
	<button class="stop-btn" onclick={handleStop}>
		試合終了・データ送信
	</button>
</div>

<!-- ══════════════════════════════════════════ -->
<!-- Respawn Screen                            -->
<!-- ══════════════════════════════════════════ -->
{:else if screen === 'respawn'}
<div class="screen respawn-screen">
	<div class="respawn-icon">💀</div>
	<div class="respawn-title">ヒット！</div>
	<div class="respawn-deaths">{deathCount}回目</div>

	{#if gameMode === 'timed_respawn'}
		<div class="respawn-countdown">
			<div class="respawn-sec">{respawnCountdown}</div>
			<div class="respawn-sec-label">秒後に復活</div>
		</div>
	{:else}
		<button class="respawn-btn" onclick={handleRespawn}>
			🔄 復活する
		</button>
	{/if}

	<button class="stop-btn" style="margin-top:auto;" onclick={handleStop}>
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
	<button class="retry-btn" onclick={() => { loadProfile(); screen = 'setup'; routeDisplay = []; elapsed = 0; isHit = false; deathCount = 0; selectedSpawnId = null; pendingSpawn = null; spawnRecorded = false; }}>
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
	.profile-saved-hint {
		margin: 0;
		font-size: 0.72rem;
		color: rgba(74,222,128,0.6);
		padding-left: 4px;
	}

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

	/* ── Respawn ── */
	.respawn-screen {
		align-items: center;
		justify-content: center;
		gap: 16px;
		background: rgba(239,68,68,0.05);
	}
	.respawn-icon { font-size: 4rem; }
	.respawn-title { font-size: 2rem; font-weight: 900; color: #ef4444; }
	.respawn-deaths { font-size: 0.85rem; color: #6b7280; }
	.respawn-countdown { text-align: center; }
	.respawn-sec {
		font-size: 5rem;
		font-weight: 900;
		font-variant-numeric: tabular-nums;
		color: #f87171;
		line-height: 1;
	}
	.respawn-sec-label { font-size: 0.9rem; color: #9ca3af; margin-top: 4px; }
	.respawn-btn {
		padding: 18px 40px;
		background: #4ade80;
		color: #000;
		border: none;
		border-radius: 16px;
		font-size: 1.1rem;
		font-weight: 800;
		cursor: pointer;
	}

	/* ── Spawn ── */
	.spawn-screen {
		gap: 16px;
		padding-top: max(env(safe-area-inset-top), 32px);
	}
	.spawn-header { text-align: center; }
	.spawn-title { font-size: 1.2rem; font-weight: 800; }
	.spawn-sub { font-size: 0.8rem; color: #6b7280; margin-top: 4px; }

	.spawn-gps-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.82rem;
		color: #9ca3af;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 10px;
		padding: 10px 14px;
	}

	.spawn-map-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px;
		overflow: hidden;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.spawn-map-img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		display: block;
	}
	.spawn-map-svg {
		width: 100%;
		height: 100%;
	}
	.spawn-no-map {
		color: #4b5563;
		font-size: 0.85rem;
	}

	.spawn-marker {
		position: absolute;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
		z-index: 10;
	}
	.spawn-circle {
		width: 44px;
		height: 44px;
		border-radius: 50%;
		background: rgba(10,10,10,0.9);
		border: 2.5px solid #4ade80;
		color: #4ade80;
		font-size: 16px;
		font-weight: 800;
		display: flex;
		align-items: center;
		justify-content: center;
		box-shadow: 0 0 0 6px rgba(74,222,128,0.15), 0 4px 12px rgba(0,0,0,0.7);
		transition: transform 0.15s, box-shadow 0.15s;
	}
	.spawn-marker:active .spawn-circle {
		transform: scale(0.92);
		box-shadow: 0 0 0 10px rgba(74,222,128,0.25);
	}
	.spawn-marker-done .spawn-circle {
		background: #4ade80;
		color: #000;
		box-shadow: 0 0 0 8px rgba(74,222,128,0.3);
	}
	.spawn-label {
		font-size: 0.65rem;
		font-weight: 700;
		color: #e5e5e5;
		background: rgba(10,10,10,0.85);
		border: 1px solid rgba(74,222,128,0.4);
		border-radius: 5px;
		padding: 2px 6px;
		white-space: nowrap;
	}

	.spawn-confirming {
		position: absolute;
		inset: 0;
		background: rgba(10,10,10,0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 1rem;
		font-weight: 700;
		color: #4ade80;
	}

	/* ── Step2: GPS確認画面 ── */
	.spawn-confirm-screen {
		display: flex;
		flex-direction: column;
		gap: 16px;
		width: 100%;
		flex: 1;
	}
	.spawn-back-btn {
		background: none;
		border: none;
		color: rgba(255,255,255,0.35);
		font-size: 0.85rem;
		cursor: pointer;
		text-align: left;
		padding: 0;
	}
	.spawn-confirm-title {
		display: flex;
		align-items: center;
		gap: 16px;
		background: rgba(74,222,128,0.06);
		border: 1px solid rgba(74,222,128,0.2);
		border-radius: 16px;
		padding: 18px 20px;
	}
	.spawn-confirm-num {
		width: 44px; height: 44px;
		border-radius: 50%;
		background: rgba(74,222,128,0.15);
		border: 2px solid #4ade80;
		color: #4ade80;
		font-size: 1.3rem; font-weight: 800;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.spawn-confirm-name {
		font-size: 1.1rem; font-weight: 700; color: #e5e5e5;
	}
	.spawn-confirm-sub {
		font-size: 0.78rem; color: rgba(255,255,255,0.4); margin-top: 3px;
	}
	.gps-accuracy-card {
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 16px;
		padding: 24px 20px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		text-align: center;
	}
	.gps-acc-icon { font-size: 2rem; }
	.gps-acc-value { font-size: 1.8rem; font-weight: 800; color: #e5e5e5; }
	.gps-acc-label { font-size: 0.82rem; font-weight: 600; }
	.gps-acc-hint { font-size: 0.75rem; color: rgba(255,255,255,0.3); margin-top: 2px; }
	.gps-waiting-icon { animation: pulse 1.5s ease-in-out infinite; }
	@keyframes gps-pulse { 0%,100%{opacity:1}50%{opacity:0.4} }

	.spawn-confirm-info {
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 12px;
		padding: 14px 16px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.info-row {
		font-size: 0.78rem;
		color: rgba(255,255,255,0.4);
		line-height: 1.5;
	}
	.spawn-go-btn {
		background: #4ade80;
		color: #000;
		border: none;
		border-radius: 16px;
		padding: 18px;
		font-size: 1rem;
		font-weight: 800;
		cursor: pointer;
		width: 100%;
		transition: opacity 0.15s;
		margin-top: auto;
	}
	.spawn-go-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.spawn-go-btn:not(:disabled):hover { opacity: 0.88; }

	.spawn-list-arrow {
		color: rgba(255,255,255,0.25);
		font-size: 1rem;
	}

	.skip-btn {
		background: none;
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 12px;
		padding: 14px;
		color: #6b7280;
		font-size: 0.85rem;
		cursor: pointer;
		width: 100%;
	}

	/* スポーンボタンリスト */
	.spawn-btn-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
		padding: 0 4px;
	}
	.spawn-btn-hint {
		font-size: 0.72rem;
		color: rgba(255,255,255,0.25);
		text-align: center;
		margin-bottom: 2px;
	}
	.spawn-list-btn {
		display: flex;
		align-items: center;
		gap: 14px;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 14px;
		padding: 14px 18px;
		cursor: pointer;
		transition: all 0.15s;
		width: 100%;
		text-align: left;
	}
	.spawn-list-btn:hover:not(:disabled) {
		border-color: rgba(74,222,128,0.4);
		background: rgba(74,222,128,0.06);
	}
	.spawn-list-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.spawn-list-btn-done {
		border-color: #4ade80 !important;
		background: rgba(74,222,128,0.12) !important;
	}
	.spawn-list-num {
		width: 32px; height: 32px;
		border-radius: 50%;
		background: rgba(74,222,128,0.15);
		border: 1.5px solid #4ade80;
		color: #4ade80;
		font-size: 0.9rem; font-weight: 700;
		display: flex; align-items: center; justify-content: center;
		flex-shrink: 0;
	}
	.spawn-list-label {
		flex: 1;
		font-size: 0.95rem; font-weight: 600;
		color: #e5e5e5;
	}
	.spawn-list-gps {
		font-size: 0.72rem;
		color: #4ade80;
	}
	.spawn-list-gps.gps-loading {
		color: rgba(255,255,255,0.25);
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

	/* ── ヒットフラッシュ ── */
	.hit-flash-overlay {
		position: fixed; inset: 0; z-index: 999;
		background: rgba(239, 68, 68, 0.85);
		display: flex; align-items: center; justify-content: center;
		animation: flash-in-out 1.5s ease forwards;
		pointer-events: none;
	}
	.hit-flash-text {
		font-size: 5rem; font-weight: 900; color: #fff;
		text-shadow: 0 0 40px rgba(255,255,255,0.8);
		animation: flash-text 1.5s ease forwards;
		letter-spacing: 0.1em;
	}
	@keyframes flash-in-out {
		0%   { opacity: 0; }
		15%  { opacity: 1; }
		70%  { opacity: 1; }
		100% { opacity: 0; }
	}
	@keyframes flash-text {
		0%   { transform: scale(0.5); opacity: 0; }
		20%  { transform: scale(1.15); opacity: 1; }
		35%  { transform: scale(1); }
		80%  { transform: scale(1); opacity: 1; }
		100% { transform: scale(1.3); opacity: 0; }
	}

	/* ── テストジョイスティック ── */
	.joystick-toggle-row {
		display: flex; justify-content: center;
		margin-top: 4px;
	}
	.joystick-toggle {
		background: rgba(255,255,255,0.05);
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 10px; padding: 8px 18px;
		color: #9ca3af; font-size: 0.8rem; cursor: pointer;
		transition: all 0.15s;
	}
	.joystick-toggle:active { background: rgba(255,255,255,0.1); }

	.dpad {
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px; padding: 12px;
		display: flex; flex-direction: column; gap: 4px; align-items: center;
	}
	.dpad-row { display: flex; justify-content: center; }
	.dpad-mid { display: flex; align-items: center; gap: 4px; }
	.dpad-btn {
		min-width: 48px; padding: 10px 8px;
		background: rgba(255,255,255,0.07);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 10px;
		color: #e5e5e5; font-size: 0.9rem; font-weight: 700;
		cursor: pointer; transition: all 0.1s;
		user-select: none; -webkit-user-select: none;
	}
	.dpad-btn:active { background: rgba(74,222,128,0.25); border-color: #4ade80; transform: scale(0.92); }
	.dpad-center {
		min-width: 48px; text-align: center;
		font-size: 0.68rem; color: #4b5563; padding: 0 4px;
	}

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
