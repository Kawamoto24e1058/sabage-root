<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { db } from '$lib/firebase';
	import { doc, getDoc, updateDoc, setDoc } from 'firebase/firestore';
	import type { Field, GeoPoint, SpawnPoint } from 'shared-types';
	import { MapPin, Navigation, Trash2, CheckCircle, Plus, ArrowLeft } from 'lucide-svelte';

	const fieldId = page.params.fieldId ?? '';

	let field = $state<Field | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let saveMsg = $state('');

	// フィールド名
	let fieldName = $state('');

	// 外周記録
	let boundaryPoints = $state<GeoPoint[]>([]);
	let isRecordingBoundary = $state(false);
	let lastRecordedPos: GeoPoint | null = null;
	const BOUNDARY_INTERVAL_M = 5; // 5m進んだら自動追加

	// スポーン地点
	let spawnPoints = $state<SpawnPoint[]>([]);
	let newSpawnLabel = $state('');
	let addingSpawn = $state(false);

	// 現在地
	let currentPos = $state<GeolocationPosition | null>(null);
	let gpsWatchId: number | null = null;
	let gpsError = $state('');

	// ステータス
	let status = $state('');

	function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
		const R = 6371000;
		const dLat = (lat2 - lat1) * Math.PI / 180;
		const dLng = (lng2 - lng1) * Math.PI / 180;
		const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
		return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
	}

	onMount(async () => {
		// フィールドデータ読み込み
		if (fieldId && fieldId !== 'new') {
			const snap = await getDoc(doc(db, 'fields', fieldId));
			if (snap.exists()) {
				field = { id: snap.id, ...snap.data() } as Field;
				fieldName = field.name;
				boundaryPoints = [...(field.boundary ?? [])];
				spawnPoints = [...(field.spawnPoints ?? [])];
			}
		}
		loading = false;

		// GPS常時取得（現在地表示 + 外周自動記録）
		if (navigator.geolocation) {
			gpsWatchId = navigator.geolocation.watchPosition(
				(pos) => {
					currentPos = pos;
					gpsError = '';

					// 外周記録中：5m進んだら自動追加
					if (isRecordingBoundary) {
						const lat = pos.coords.latitude;
						const lng = pos.coords.longitude;
						if (!lastRecordedPos || haversineM(lastRecordedPos.lat, lastRecordedPos.lng, lat, lng) >= BOUNDARY_INTERVAL_M) {
							boundaryPoints = [...boundaryPoints, { lat, lng }];
							lastRecordedPos = { lat, lng };
							status = `外周点 ${boundaryPoints.length} 個記録中…`;
						}
					}
				},
				(err) => { gpsError = `GPS取得失敗: ${err.message}`; },
				{ enableHighAccuracy: true, timeout: 15000, maximumAge: 2000 }
			);
		}
	});

	onDestroy(() => {
		if (gpsWatchId !== null) navigator.geolocation.clearWatch(gpsWatchId);
	});

	// ── 外周記録 ────────────────────────────────────────────────────────
	function startBoundaryRecord() {
		boundaryPoints = [];
		lastRecordedPos = null;
		isRecordingBoundary = true;
		status = 'フィールドの外周を歩いてください — 自動で記録します';
	}

	function stopBoundaryRecord() {
		isRecordingBoundary = false;
		status = boundaryPoints.length >= 3
			? `✅ 外周 ${boundaryPoints.length} 点記録完了`
			: '⚠ 点が少なすぎます（3点以上必要）';
	}

	function clearBoundary() {
		boundaryPoints = [];
		lastRecordedPos = null;
		isRecordingBoundary = false;
		status = '外周をリセットしました';
	}

	// ── スポーン追加 ─────────────────────────────────────────────────────
	function addSpawnAtCurrentPos() {
		if (!currentPos) {
			status = '⚠ GPS未取得です。しばらくお待ちください';
			return;
		}
		const label = newSpawnLabel.trim() || `スポーン ${spawnPoints.length + 1}`;
		const id = `spawn-${Date.now()}`;
		spawnPoints = [
			...spawnPoints,
			{
				id,
				label,
				lat: currentPos.coords.latitude,
				lng: currentPos.coords.longitude,
			},
		];
		newSpawnLabel = '';
		addingSpawn = false;
		status = `✅ "${label}" を現在地に追加しました`;
	}

	function removeSpawn(id: string) {
		spawnPoints = spawnPoints.filter(s => s.id !== id);
	}

	// ── 保存 ─────────────────────────────────────────────────────────────
	async function save() {
		if (!fieldName.trim()) { status = '⚠ フィールド名を入力してください'; return; }
		saving = true;
		const data: Omit<Field, 'id'> = {
			name: fieldName.trim(),
			boundary: boundaryPoints,
			spawnPoints,
		};
		try {
			if (fieldId && fieldId !== 'new') {
				await updateDoc(doc(db, 'fields', fieldId), data as Record<string, unknown>);
			} else {
				const newRef = doc(db, 'fields', crypto.randomUUID());
				await setDoc(newRef, data);
			}
			saveMsg = '✅ 保存しました';
			setTimeout(() => saveMsg = '', 3000);
		} catch (e) {
			saveMsg = `❌ 保存失敗: ${(e as Error).message}`;
		}
		saving = false;
	}

	function accuracyLabel(acc: number): string {
		if (acc < 5)  return '高精度';
		if (acc < 15) return '良好';
		if (acc < 30) return '普通';
		return '低精度';
	}
</script>

<svelte:head>
	<title>フィールド編集</title>
</svelte:head>

<div class="page">
	<!-- ヘッダー -->
	<div class="header">
		<a href="/fields" class="back-link">
			<ArrowLeft size={18} />
		</a>
		<h1 class="title">フィールド設定</h1>
		<button class="save-btn" onclick={save} disabled={saving}>
			{saving ? '保存中…' : '保存'}
		</button>
	</div>

	{#if loading}
		<div class="loading">読み込み中…</div>
	{:else}

	<!-- GPS状態バー -->
	<div class="gps-bar {currentPos ? 'gps-ok' : 'gps-wait'}">
		<Navigation size={13} />
		{#if currentPos}
			精度 {Math.round(currentPos.coords.accuracy)}m（{accuracyLabel(currentPos.coords.accuracy)}）
			— {currentPos.coords.latitude.toFixed(6)}, {currentPos.coords.longitude.toFixed(6)}
		{:else if gpsError}
			{gpsError}
		{:else}
			GPS取得中…
		{/if}
	</div>

	<!-- ステータス -->
	{#if status}
		<div class="status-msg">{status}</div>
	{/if}
	{#if saveMsg}
		<div class="save-msg">{saveMsg}</div>
	{/if}

	<!-- フィールド名 -->
	<section class="section">
		<label class="section-label" for="fname">フィールド名</label>
		<input
			id="fname"
			class="text-input"
			type="text"
			placeholder="例: ○○サバゲーフィールド"
			bind:value={fieldName}
		/>
	</section>

	<!-- ── 外周記録セクション ── -->
	<section class="section">
		<div class="section-header">
			<div>
				<div class="section-label">フィールド外周</div>
				<div class="section-sub">外周を歩くだけで自動記録（5m間隔）</div>
			</div>
			<span class="count-badge">{boundaryPoints.length} 点</span>
		</div>

		{#if !isRecordingBoundary}
			<div class="btn-row">
				<button
					class="btn btn-primary"
					onclick={startBoundaryRecord}
					disabled={!currentPos}
				>
					<Navigation size={15} />
					{boundaryPoints.length > 0 ? '外周を再記録' : '外周を記録開始'}
				</button>
				{#if boundaryPoints.length > 0}
					<button class="btn btn-danger-outline" onclick={clearBoundary}>
						<Trash2 size={14} />
						リセット
					</button>
				{/if}
			</div>

			{#if boundaryPoints.length >= 3}
				<div class="boundary-ok">
					<CheckCircle size={14} />
					外周 {boundaryPoints.length} 点を記録済み
				</div>
			{:else if boundaryPoints.length > 0}
				<div class="boundary-warn">⚠ 3点以上必要です（現在 {boundaryPoints.length} 点）</div>
			{/if}
		{:else}
			<!-- 記録中UI -->
			<div class="recording-card">
				<div class="recording-pulse"></div>
				<div class="recording-info">
					<span class="recording-label">記録中</span>
					<span class="recording-count">{boundaryPoints.length} 点</span>
				</div>
				<p class="recording-hint">外周に沿って歩いてください<br>5m進むたびに自動で点を追加します</p>
				<button class="btn btn-stop" onclick={stopBoundaryRecord}>
					■ 記録を停止
				</button>
			</div>
		{/if}

		<!-- 記録済み点のリスト（最新5件） -->
		{#if boundaryPoints.length > 0 && !isRecordingBoundary}
			<div class="point-list">
				<div class="point-list-title">記録した外周点（{boundaryPoints.length}点）</div>
				{#each boundaryPoints.slice(-5).reverse() as pt, i}
					<div class="point-item">
						<span class="point-num">#{boundaryPoints.length - i}</span>
						<span class="point-coord">{pt.lat.toFixed(6)}, {pt.lng.toFixed(6)}</span>
					</div>
				{/each}
				{#if boundaryPoints.length > 5}
					<div class="point-more">… 他 {boundaryPoints.length - 5} 点</div>
				{/if}
			</div>
		{/if}
	</section>

	<!-- ── スポーン地点セクション ── -->
	<section class="section">
		<div class="section-header">
			<div>
				<div class="section-label">スポーン地点</div>
				<div class="section-sub">スポーン地点に立って現在地を記録</div>
			</div>
			<span class="count-badge">{spawnPoints.length} 箇所</span>
		</div>

		<!-- 既存スポーン一覧 -->
		{#if spawnPoints.length > 0}
			<div class="spawn-list">
				{#each spawnPoints as sp, i}
					<div class="spawn-item">
						<span class="spawn-num">{i + 1}</span>
						<div class="spawn-info">
							<span class="spawn-label-text">{sp.label}</span>
							<span class="spawn-coord">{sp.lat.toFixed(6)}, {sp.lng.toFixed(6)}</span>
						</div>
						<button class="spawn-remove" onclick={() => removeSpawn(sp.id)} aria-label="削除">
							<Trash2 size={13} />
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<!-- スポーン追加フォーム -->
		{#if addingSpawn}
			<div class="spawn-add-card">
				<div class="spawn-add-gps">
					<MapPin size={13} />
					{#if currentPos}
						現在地: {currentPos.coords.latitude.toFixed(6)}, {currentPos.coords.longitude.toFixed(6)}
					{:else}
						GPS取得中…
					{/if}
				</div>
				<input
					class="text-input"
					type="text"
					placeholder="スポーン名（例: チームAスポーン）"
					bind:value={newSpawnLabel}
					autofocus
				/>
				<div class="btn-row">
					<button class="btn btn-primary" onclick={addSpawnAtCurrentPos} disabled={!currentPos}>
						<CheckCircle size={14} />
						この場所をスポーンに設定
					</button>
					<button class="btn btn-ghost" onclick={() => { addingSpawn = false; newSpawnLabel = ''; }}>
						キャンセル
					</button>
				</div>
			</div>
		{:else}
			<button
				class="btn btn-secondary"
				onclick={() => addingSpawn = true}
				disabled={!currentPos}
			>
				<Plus size={15} />
				スポーン地点を追加（今いる場所）
			</button>
		{/if}
	</section>

	<!-- 保存ボタン（ページ下部） -->
	<div class="bottom-save">
		<button class="btn btn-primary btn-large" onclick={save} disabled={saving}>
			{saving ? '保存中…' : '💾 保存する'}
		</button>
	</div>

	{/if}
</div>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background: #050f05;
		color: #4ade80;
		font-family: 'Inter', system-ui, sans-serif;
		font-size: 15px;
	}

	.page {
		max-width: 480px;
		margin: 0 auto;
		padding-bottom: 80px;
	}

	/* ── ヘッダー ── */
	.header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 14px 16px 10px;
		border-bottom: 1px solid rgba(74,222,128,0.1);
		position: sticky;
		top: 0;
		background: rgba(5,15,5,0.98);
		z-index: 100;
		backdrop-filter: blur(10px);
	}
	.back-link {
		display: flex;
		align-items: center;
		color: rgba(74,222,128,0.5);
		text-decoration: none;
		padding: 4px;
	}
	.back-link:hover { color: #4ade80; }
	.title {
		flex: 1;
		font-size: 1rem;
		font-weight: 800;
		color: #4ade80;
		margin: 0;
		text-shadow: 0 0 12px rgba(74,222,128,0.3);
		font-family: monospace;
		letter-spacing: 0.04em;
	}
	.save-btn {
		background: #4ade80;
		color: #020c02;
		border: none;
		border-radius: 8px;
		padding: 6px 16px;
		font-size: 0.82rem;
		font-weight: 800;
		cursor: pointer;
		box-shadow: 0 0 10px rgba(74,222,128,0.35);
	}
	.save-btn:hover:not(:disabled) { box-shadow: 0 0 18px rgba(74,222,128,0.55); }
	.save-btn:disabled { opacity: 0.4; cursor: not-allowed; }

	.loading {
		text-align: center;
		padding: 40px;
		color: rgba(74,222,128,0.4);
		font-family: monospace;
	}

	/* ── GPS状態バー ── */
	.gps-bar {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 9px 16px;
		font-size: 0.7rem;
		font-family: monospace;
		border-bottom: 1px solid rgba(74,222,128,0.08);
	}
	.gps-ok { color: #4ade80; background: rgba(74,222,128,0.05); }
	.gps-wait { color: rgba(74,222,128,0.35); }

	/* ── ステータス ── */
	.status-msg {
		margin: 10px 16px 0;
		padding: 9px 14px;
		background: rgba(74,222,128,0.07);
		border: 1px solid rgba(74,222,128,0.2);
		border-radius: 8px;
		font-size: 0.76rem;
		color: rgba(74,222,128,0.85);
	}
	.save-msg {
		margin: 10px 16px 0;
		padding: 9px 14px;
		background: rgba(74,222,128,0.1);
		border: 1px solid rgba(74,222,128,0.3);
		border-radius: 8px;
		font-size: 0.8rem;
		color: #4ade80;
		font-weight: 600;
		text-align: center;
	}

	/* ── セクション ── */
	.section {
		margin: 14px 16px 0;
		background: rgba(74,222,128,0.03);
		border: 1px solid rgba(74,222,128,0.1);
		border-radius: 14px;
		padding: 14px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.section-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 8px;
	}
	.section-label {
		font-size: 0.82rem;
		font-weight: 800;
		color: #4ade80;
		letter-spacing: 0.04em;
		display: block;
	}
	.section-sub {
		font-size: 0.66rem;
		color: rgba(74,222,128,0.4);
		margin-top: 2px;
	}
	.count-badge {
		background: rgba(74,222,128,0.1);
		border: 1px solid rgba(74,222,128,0.25);
		border-radius: 20px;
		padding: 2px 10px;
		font-size: 0.7rem;
		font-weight: 700;
		color: #4ade80;
		white-space: nowrap;
		font-family: monospace;
		flex-shrink: 0;
	}

	/* ── 入力フィールド ── */
	.text-input {
		width: 100%;
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.2);
		border-radius: 9px;
		color: #4ade80;
		font-size: 0.88rem;
		padding: 10px 12px;
		outline: none;
		box-sizing: border-box;
		transition: border-color 0.15s;
	}
	.text-input::placeholder { color: rgba(74,222,128,0.25); }
	.text-input:focus { border-color: rgba(74,222,128,0.5); background: rgba(74,222,128,0.07); }

	/* ── ボタン ── */
	.btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
	.btn {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 16px;
		border-radius: 10px;
		font-size: 0.82rem;
		font-weight: 700;
		cursor: pointer;
		border: none;
		transition: all 0.15s;
		white-space: nowrap;
	}
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn-primary {
		background: #4ade80;
		color: #020c02;
		box-shadow: 0 0 12px rgba(74,222,128,0.3);
	}
	.btn-primary:hover:not(:disabled) { box-shadow: 0 0 20px rgba(74,222,128,0.5); background: #22c55e; }
	.btn-secondary {
		background: rgba(74,222,128,0.1);
		color: #4ade80;
		border: 1px solid rgba(74,222,128,0.3);
		width: 100%;
		justify-content: center;
	}
	.btn-secondary:hover:not(:disabled) { background: rgba(74,222,128,0.18); }
	.btn-ghost {
		background: transparent;
		color: rgba(74,222,128,0.4);
		border: 1px solid rgba(74,222,128,0.15);
	}
	.btn-ghost:hover { color: #4ade80; background: rgba(74,222,128,0.05); }
	.btn-danger-outline {
		background: transparent;
		color: rgba(255,80,80,0.7);
		border: 1px solid rgba(255,80,80,0.25);
	}
	.btn-danger-outline:hover { background: rgba(255,80,80,0.08); }
	.btn-stop {
		background: rgba(255,80,80,0.15);
		color: #f87171;
		border: 1px solid rgba(255,80,80,0.3);
		width: 100%;
		justify-content: center;
		font-size: 0.85rem;
	}
	.btn-stop:hover { background: rgba(255,80,80,0.25); }
	.btn-large { width: 100%; justify-content: center; font-size: 0.95rem; padding: 13px; }

	/* ── 外周記録UI ── */
	.recording-card {
		background: rgba(74,222,128,0.06);
		border: 1px solid rgba(74,222,128,0.25);
		border-radius: 12px;
		padding: 16px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 10px;
		animation: border-glow 2s ease-in-out infinite;
	}
	@keyframes border-glow {
		0%,100% { border-color: rgba(74,222,128,0.25); box-shadow: none; }
		50%      { border-color: rgba(74,222,128,0.5);  box-shadow: 0 0 12px rgba(74,222,128,0.12); }
	}
	.recording-pulse {
		width: 14px; height: 14px;
		border-radius: 50%;
		background: #4ade80;
		box-shadow: 0 0 8px #4ade80;
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse {
		0%,100% { transform: scale(1); opacity: 1; }
		50% { transform: scale(1.35); opacity: 0.7; }
	}
	.recording-info { display: flex; align-items: center; gap: 10px; }
	.recording-label {
		font-size: 0.7rem;
		font-weight: 700;
		color: rgba(74,222,128,0.5);
		text-transform: uppercase;
		letter-spacing: 0.1em;
		font-family: monospace;
	}
	.recording-count {
		font-size: 1.4rem;
		font-weight: 800;
		color: #4ade80;
		font-family: monospace;
		text-shadow: 0 0 12px rgba(74,222,128,0.5);
	}
	.recording-hint {
		font-size: 0.7rem;
		color: rgba(74,222,128,0.45);
		text-align: center;
		margin: 0;
		line-height: 1.5;
	}

	.boundary-ok {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.75rem;
		color: #4ade80;
		font-weight: 600;
	}
	.boundary-warn { font-size: 0.72rem; color: #fbbf24; font-weight: 600; }

	.point-list {
		background: rgba(0,0,0,0.2);
		border-radius: 8px;
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.point-list-title {
		font-size: 0.63rem;
		font-weight: 700;
		color: rgba(74,222,128,0.35);
		text-transform: uppercase;
		letter-spacing: 0.08em;
		margin-bottom: 4px;
		font-family: monospace;
	}
	.point-item {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.65rem;
		font-family: monospace;
	}
	.point-num { color: rgba(74,222,128,0.3); min-width: 30px; font-size: 0.6rem; }
	.point-coord { color: rgba(74,222,128,0.6); }
	.point-more { font-size: 0.6rem; color: rgba(74,222,128,0.25); font-family: monospace; padding-left: 4px; }

	/* ── スポーン一覧 ── */
	.spawn-list { display: flex; flex-direction: column; gap: 6px; }
	.spawn-item {
		display: flex;
		align-items: center;
		gap: 10px;
		background: rgba(74,222,128,0.04);
		border: 1px solid rgba(74,222,128,0.12);
		border-radius: 9px;
		padding: 9px 12px;
	}
	.spawn-num {
		width: 24px; height: 24px;
		border-radius: 50%;
		background: rgba(5,15,5,0.9);
		border: 1.5px solid rgba(74,222,128,0.4);
		color: #4ade80;
		font-size: 0.72rem;
		font-weight: 800;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		font-family: monospace;
		box-shadow: 0 0 6px rgba(74,222,128,0.2);
	}
	.spawn-info { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
	.spawn-label-text { font-size: 0.82rem; font-weight: 700; color: #4ade80; }
	.spawn-coord {
		font-size: 0.62rem;
		color: rgba(74,222,128,0.4);
		font-family: monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.spawn-remove {
		background: transparent;
		border: none;
		color: rgba(255,80,80,0.4);
		cursor: pointer;
		padding: 4px;
		display: flex;
		align-items: center;
		flex-shrink: 0;
	}
	.spawn-remove:hover { color: #f87171; }

	.spawn-add-card {
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.2);
		border-radius: 11px;
		padding: 12px;
		display: flex;
		flex-direction: column;
		gap: 9px;
	}
	.spawn-add-gps {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.68rem;
		color: rgba(74,222,128,0.55);
		font-family: monospace;
	}

	.bottom-save { margin: 20px 16px 0; }
</style>
