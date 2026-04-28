<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { db, storage } from '$lib/firebase';
	import { collection, addDoc, doc, setDoc } from 'firebase/firestore';
	import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
	import type { SpawnPoint } from 'shared-types';
	import { ArrowLeft, ArrowRight, Check, MapPin, Plus, Trash2 } from 'lucide-svelte';

	// ウィザードステップ
	type Step = 'info' | 'map' | 'field' | 'saving';
	let step = $state<Step>('info');

	// Step 1: イベント情報
	let eventName = $state('');
	let eventDate = $state(new Date().toISOString().slice(0, 10)); // YYYY-MM-DD

	// Step 2: マップ画像
	let mapFile = $state<File | null>(null);
	let mapPreviewUrl = $state('');
	let uploadingMap = $state(false);
	let uploadedMapUrl = $state('');

	// Step 3: フィールド設定
	// --- GPS外周計測 ---
	let measuring = $state(false);
	let measurePts = $state<{lat: number; lng: number}[]>([]);
	let measureWatchId = $state<number | null>(null);
	let fieldWidthMeters = $state<number>(80);
	let measureDone = $state(false);

	// --- スポーン地点 ---
	let spawnPoints = $state<SpawnPoint[]>([]);
	let addMode = $state(false);
	let mapEl: HTMLDivElement;
	let leafletMap: any = null;
	let L: any = null;
	let markerObjects: any[] = [];
	let imgW = 1;
	let imgH = 1;

	// Saving
	let saveError = $state('');

	// -------------------------------------------------------
	// Step 2: 画像選択
	// -------------------------------------------------------
	function onFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		mapFile = file;
		mapPreviewUrl = URL.createObjectURL(file);
	}

	// -------------------------------------------------------
	// Step 3: Leafletマップ初期化
	// -------------------------------------------------------
	async function initLeaflet() {
		if (!uploadedMapUrl && !mapPreviewUrl) return;
		const url = uploadedMapUrl || mapPreviewUrl;

		await new Promise<void>(resolve => {
			const img = new Image();
			img.onload = () => { imgW = img.naturalWidth || 800; imgH = img.naturalHeight || 600; resolve(); };
			img.onerror = () => { imgW = 800; imgH = 600; resolve(); };
			img.src = url;
		});

		const leaflet = await import('leaflet');
		await import('leaflet/dist/leaflet.css');
		L = leaflet.default;

		if (leafletMap) { leafletMap.remove(); leafletMap = null; }

		leafletMap = L.map(mapEl, {
			crs: L.CRS.Simple,
			minZoom: -5, maxZoom: 5, zoomSnap: 0.25, attributionControl: false,
		});

		L.imageOverlay(url, [[0, 0], [imgH, imgW]], { opacity: 0.7 }).addTo(leafletMap);
		leafletMap.fitBounds([[0, 0], [imgH, imgW]], { padding: [20, 20] });

		leafletMap.on('click', (e: any) => {
			if (!addMode) return;
			const x = Math.max(0, Math.min(1, e.latlng.lng / imgW));
			const y = Math.max(0, Math.min(1, 1 - e.latlng.lat / imgH));
			const newSpawn: SpawnPoint = {
				id: `spawn-${Date.now()}`,
				label: `スポーン ${spawnPoints.length + 1}`,
				x, y,
			};
			spawnPoints = [...spawnPoints, newSpawn];
			renderMarkers();
		});

		renderMarkers();
	}

	function renderMarkers() {
		if (!leafletMap || !L) return;
		markerObjects.forEach(m => m.remove());
		markerObjects = [];
		spawnPoints.forEach((sp, i) => {
			const icon = L.divIcon({
				html: `<div style="width:28px;height:28px;border-radius:50%;background:#4ade80;border:2px solid #fff;color:#000;font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.6)">${i + 1}</div>`,
				iconSize: [28, 28], iconAnchor: [14, 14], className: '',
			});
			const m = L.marker([(1 - sp.y) * imgH, sp.x * imgW], { icon, draggable: true });
			m.addTo(leafletMap);
			m.bindTooltip(sp.label, { permanent: true, direction: 'top', offset: [0, -16], className: 'spawn-tooltip' });
			m.on('dragend', (ev: any) => {
				const ll = ev.target.getLatLng();
				const nx = Math.max(0, Math.min(1, ll.lng / imgW));
				const ny = Math.max(0, Math.min(1, 1 - ll.lat / imgH));
				spawnPoints = spawnPoints.map((s, idx) => idx === i ? { ...s, x: nx, y: ny } : s);
			});
			markerObjects.push(m);
		});
	}

	$effect(() => {
		const _ = spawnPoints.length;
		if (leafletMap && L) renderMarkers();
	});

	// -------------------------------------------------------
	// GPS外周計測
	// -------------------------------------------------------
	function haversineM(a: {lat:number;lng:number}, b: {lat:number;lng:number}): number {
		const R = 6371000;
		const dLat = (b.lat - a.lat) * Math.PI / 180;
		const dLng = (b.lng - a.lng) * Math.PI / 180;
		const aa = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
		return R * 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1-aa));
	}

	function startMeasure() {
		if (!navigator.geolocation) { alert('このブラウザはGPS非対応です'); return; }
		measurePts = [];
		measuring = true;
		measureDone = false;
		let last: {lat:number;lng:number} | null = null;
		measureWatchId = navigator.geolocation.watchPosition(
			(pos) => {
				const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
				if (!last || haversineM(last, pt) > 1) { measurePts = [...measurePts, pt]; last = pt; }
			},
			(err) => console.warn(err),
			{ enableHighAccuracy: true, maximumAge: 0 }
		);
	}

	function stopMeasure() {
		if (measureWatchId !== null) { navigator.geolocation.clearWatch(measureWatchId); measureWatchId = null; }
		measuring = false;
		if (measurePts.length < 2) { alert('GPS点が少なすぎます'); return; }
		let maxD = 0;
		for (let i = 0; i < measurePts.length; i++)
			for (let j = i+1; j < measurePts.length; j++) {
				const d = haversineM(measurePts[i], measurePts[j]);
				if (d > maxD) maxD = d;
			}
		fieldWidthMeters = Math.round(maxD);
		measureDone = true;
	}

	// -------------------------------------------------------
	// ステップ遷移
	// -------------------------------------------------------
	async function goToField() {
		// 画像アップロード（ある場合）
		if (mapFile) {
			uploadingMap = true;
			try {
				const path = `fields/${Date.now()}_${mapFile.name}`;
				const sref = storageRef(storage, path);
				await uploadBytes(sref, mapFile);
				uploadedMapUrl = await getDownloadURL(sref);
			} catch (e) {
				console.error(e);
				alert('画像アップロードに失敗しました');
				uploadingMap = false;
				return;
			}
			uploadingMap = false;
		}
		step = 'field';
		// DOMがレンダリングされた後にLeaflet初期化
		await new Promise(r => setTimeout(r, 100));
		initLeaflet();
	}

	// -------------------------------------------------------
	// 保存
	// -------------------------------------------------------
	async function save() {
		step = 'saving';
		saveError = '';
		try {
			// 1. Field ドキュメントを作成
			const fieldData: Record<string, unknown> = {
				name: eventName,
				boundary: [],
				fieldWidthMeters: Number(fieldWidthMeters) || 80,
				spawnPoints: spawnPoints.map(({ id, label, x, y }) => ({ id, label, x, y })),
			};
			if (uploadedMapUrl) {
				fieldData.mapImage = { url: uploadedMapUrl };
			}
			const fieldRef = await addDoc(collection(db, 'fields'), fieldData);

			// 2. Event ドキュメントを作成
			const dateMs = new Date(eventDate).getTime();
			await addDoc(collection(db, 'events'), {
				name: eventName,
				date: dateMs,
				fieldId: fieldRef.id,
				createdAt: Date.now(),
			});

			// 3. Event一覧へ
			goto('/');
		} catch (e: unknown) {
			console.error(e);
			saveError = e instanceof Error ? e.message : '保存に失敗しました';
			step = 'field';
		}
	}

	onDestroy(() => {
		if (measureWatchId !== null) navigator.geolocation.clearWatch(measureWatchId);
		if (leafletMap) { leafletMap.remove(); leafletMap = null; }
		if (mapPreviewUrl) URL.revokeObjectURL(mapPreviewUrl);
	});

	function removeSpawn(i: number) { spawnPoints = spawnPoints.filter((_, idx) => idx !== i); }
	function updateLabel(i: number, v: string) { spawnPoints = spawnPoints.map((s, idx) => idx === i ? { ...s, label: v } : s); }
</script>

<svelte:head>
	<title>イベントを作成 – Sabage Tracker</title>
</svelte:head>

<div class="page">
	<header>
		<button class="back" onclick={() => goto('/')}>
			<ArrowLeft size={16} />戻る
		</button>
		<h1>イベントを作成</h1>
		<!-- ステップ表示 -->
		<div class="steps">
			<span class="step" class:active={step === 'info'} class:done={step !== 'info'}>①</span>
			<span class="step-line"></span>
			<span class="step" class:active={step === 'map'} class:done={step === 'field' || step === 'saving'}>②</span>
			<span class="step-line"></span>
			<span class="step" class:active={step === 'field' || step === 'saving'}>③</span>
		</div>
	</header>

	<!-- ================= STEP 1: イベント情報 ================= -->
	{#if step === 'info'}
		<div class="card">
			<h2>📅 イベント情報</h2>
			<p class="desc">今日のゲームデーの名前と日付を入力してください</p>

			<label class="field-label">イベント名</label>
			<input
				class="text-input"
				type="text"
				placeholder="例: 第1回〇〇サバゲー"
				bind:value={eventName}
				maxlength="50"
			/>

			<label class="field-label" style="margin-top:16px">開催日</label>
			<input class="text-input" type="date" bind:value={eventDate} />

			<button
				class="next-btn"
				onclick={() => step = 'map'}
				disabled={eventName.trim().length === 0}
			>
				次へ（フィールドマップ設定）<ArrowRight size={16} />
			</button>
		</div>
	{/if}

	<!-- ================= STEP 2: マップ画像 ================= -->
	{#if step === 'map'}
		<div class="card">
			<h2>🗺 フィールドマップ</h2>
			<p class="desc">フィールドの航空写真や地図画像をアップロードします。あとで設定することもできます。</p>

			{#if mapPreviewUrl}
				<img src={mapPreviewUrl} alt="map preview" class="map-preview" />
				<button class="sub-btn" onclick={() => { mapFile = null; mapPreviewUrl = ''; uploadedMapUrl = ''; }}>
					<Trash2 size={13} />画像を削除
				</button>
			{:else}
				<label class="upload-area">
					<input type="file" accept="image/*" onchange={onFileChange} style="display:none" />
					<div class="upload-icon">📷</div>
					<div class="upload-text">タップして画像を選択</div>
					<div class="upload-sub">JPG / PNG / WebP</div>
				</label>
			{/if}

			<div class="btn-row">
				<button class="back-btn" onclick={() => step = 'info'}>
					<ArrowLeft size={15} />戻る
				</button>
				<button class="next-btn" onclick={goToField} disabled={uploadingMap}>
					{#if uploadingMap}
						アップロード中...
					{:else if mapPreviewUrl}
						次へ（フィールド設定）<ArrowRight size={16} />
					{:else}
						スキップして次へ<ArrowRight size={16} />
					{/if}
				</button>
			</div>
		</div>
	{/if}

	<!-- ================= STEP 3: フィールド設定 ================= -->
	{#if step === 'field'}
		<div class="field-step">
			<!-- 左: スポーン設定マップ -->
			<div class="map-wrap">
				{#if uploadedMapUrl || mapPreviewUrl}
					<div bind:this={mapEl} class="map"></div>
					<div class="map-hint" class:active={addMode}>
						{#if addMode}
							📍 地図をタップしてスポーン追加
							<button class="hint-done" onclick={() => addMode = false}>完了</button>
						{:else}
							スポーン地点を設定
						{/if}
					</div>
				{:else}
					<div class="no-map">
						<p>マップ画像なし</p>
						<p class="no-map-sub">マップ画像がないと仮想マップは使えません</p>
					</div>
				{/if}
			</div>

			<!-- 右: 設定パネル -->
			<aside class="panel">
				<!-- GPS外周計測 -->
				<section class="section">
					<h3>📐 フィールド実寸計測</h3>
					<p class="section-desc">スマホでフィールドを1周歩くと横幅を自動計算します</p>

					{#if !measuring}
						<button class="measure-btn" onclick={startMeasure}>
							🚶 外周を歩いて計測開始
						</button>
					{:else}
						<div class="measuring">
							<div class="pulse">● 計測中 — {measurePts.length}点</div>
							<button class="stop-btn" onclick={stopMeasure}>✅ 計測完了</button>
						</div>
					{/if}

					{#if measureDone}
						<p class="measure-ok">✓ 計測完了: {fieldWidthMeters} m</p>
					{/if}

					<div class="manual-row">
						<input class="num-input" type="number" min="10" max="2000" bind:value={fieldWidthMeters} />
						<span class="unit">m（手動入力も可）</span>
					</div>
				</section>

				<!-- スポーン地点 -->
				{#if uploadedMapUrl || mapPreviewUrl}
					<section class="section">
						<h3><MapPin size={13} />スポーン地点</h3>
						<button class="add-spawn-btn" class:active={addMode} onclick={() => addMode = !addMode}>
							<Plus size={13} />{addMode ? '追加中（地図をタップ）' : 'スポーンを追加'}
						</button>

						{#if spawnPoints.length > 0}
							<ul class="spawn-list">
								{#each spawnPoints as sp, i}
									<li class="spawn-item">
										<div class="spawn-num">{i+1}</div>
										<input
											class="spawn-label"
											type="text"
											value={sp.label}
											oninput={(e) => updateLabel(i, (e.target as HTMLInputElement).value)}
										/>
										<button class="del-btn" onclick={() => removeSpawn(i)}><Trash2 size={12} /></button>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="empty-spawn">まだスポーン地点がありません</p>
						{/if}
					</section>
				{/if}

				{#if saveError}
					<p class="error">{saveError}</p>
				{/if}

				<div class="btn-row">
					<button class="back-btn" onclick={() => step = 'map'}>
						<ArrowLeft size={15} />戻る
					</button>
					<button class="save-btn" onclick={save}>
						<Check size={15} />イベントを作成
					</button>
				</div>
			</aside>
		</div>
	{/if}

	<!-- ================= SAVING ================= -->
	{#if step === 'saving'}
		<div class="saving-screen">
			<div class="spinner"></div>
			<p>作成中...</p>
		</div>
	{/if}
</div>

<style>
	:global(body) {
		margin: 0; padding: 0;
		background: #0a0a0a; color: #e5e5e5;
		font-family: 'Inter', system-ui, -apple-system, sans-serif;
		min-height: 100vh;
	}
	:global(.spawn-tooltip) {
		background: rgba(0,0,0,0.75) !important;
		border: 1px solid rgba(74,222,128,0.4) !important;
		color: #4ade80 !important;
		font-size: 11px !important; font-weight: 600 !important;
		padding: 2px 7px !important; border-radius: 4px !important;
		box-shadow: none !important; white-space: nowrap !important;
	}
	:global(.spawn-tooltip::before) { display: none !important; }
	:global(.leaflet-container) { background: #111 !important; }

	.page { min-height: 100vh; display: flex; flex-direction: column; }

	header {
		display: flex; align-items: center; gap: 16px;
		padding: 14px 20px;
		border-bottom: 1px solid rgba(255,255,255,0.07);
		background: rgba(15,15,15,0.97);
		position: sticky; top: 0; z-index: 100;
	}
	.back {
		display: flex; align-items: center; gap: 5px;
		background: transparent; border: none;
		color: rgba(255,255,255,0.4); font-size: 0.85rem; cursor: pointer;
		padding: 6px 10px; border-radius: 8px;
	}
	.back:hover { color: #fff; }
	h1 { margin: 0; font-size: 0.95rem; font-weight: 600; flex: 1; }

	.steps { display: flex; align-items: center; gap: 4px; }
	.step {
		width: 26px; height: 26px; border-radius: 50%;
		background: rgba(255,255,255,0.07);
		border: 1px solid rgba(255,255,255,0.12);
		display: flex; align-items: center; justify-content: center;
		font-size: 0.72rem; font-weight: 700; color: rgba(255,255,255,0.3);
	}
	.step.active { background: #4ade80; color: #000; border-color: #4ade80; }
	.step.done { background: rgba(74,222,128,0.15); color: #4ade80; border-color: rgba(74,222,128,0.4); }
	.step-line { width: 16px; height: 1px; background: rgba(255,255,255,0.1); }

	/* Cards (step 1 & 2) */
	.card {
		max-width: 480px; margin: 40px auto; padding: 32px 28px;
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px;
		display: flex; flex-direction: column; gap: 10px;
		width: calc(100% - 40px);
	}
	.card h2 { margin: 0 0 2px; font-size: 1.1rem; }
	.desc { margin: 0 0 8px; font-size: 0.82rem; color: rgba(255,255,255,0.35); }

	.field-label { font-size: 0.75rem; font-weight: 600; color: #9ca3af; }
	.text-input {
		width: 100%; box-sizing: border-box;
		background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
		border-radius: 10px; color: #e5e5e5; font-size: 0.95rem;
		padding: 12px 14px; outline: none;
	}
	.text-input:focus { border-color: rgba(74,222,128,0.5); }

	.upload-area {
		display: flex; flex-direction: column; align-items: center;
		gap: 8px; padding: 32px 20px;
		border: 2px dashed rgba(255,255,255,0.12);
		border-radius: 12px; cursor: pointer;
		transition: border-color 0.15s;
	}
	.upload-area:hover { border-color: rgba(74,222,128,0.4); }
	.upload-icon { font-size: 2rem; }
	.upload-text { font-size: 0.9rem; font-weight: 600; }
	.upload-sub { font-size: 0.75rem; color: rgba(255,255,255,0.3); }

	.map-preview { width: 100%; border-radius: 10px; max-height: 200px; object-fit: cover; }
	.sub-btn {
		display: flex; align-items: center; gap: 5px;
		background: transparent; border: 1px solid rgba(255,255,255,0.1);
		color: rgba(255,255,255,0.4); font-size: 0.78rem; padding: 5px 10px;
		border-radius: 7px; cursor: pointer; align-self: flex-start;
	}

	.btn-row { display: flex; gap: 10px; justify-content: flex-end; margin-top: 8px; }
	.back-btn {
		display: flex; align-items: center; gap: 5px;
		background: transparent; border: 1px solid rgba(255,255,255,0.12);
		color: rgba(255,255,255,0.5); font-size: 0.85rem;
		padding: 10px 16px; border-radius: 10px; cursor: pointer;
	}
	.next-btn, .save-btn {
		display: flex; align-items: center; gap: 6px;
		background: #4ade80; color: #000; border: none;
		font-size: 0.88rem; font-weight: 700;
		padding: 10px 20px; border-radius: 10px; cursor: pointer;
		transition: opacity 0.15s;
	}
	.next-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.next-btn:not(:disabled):hover, .save-btn:hover { opacity: 0.85; }

	/* Step 3: field layout */
	.field-step {
		flex: 1; display: grid; grid-template-columns: 1fr 300px;
		height: calc(100vh - 57px); min-height: 0;
	}
	@media (max-width: 700px) {
		.field-step { grid-template-columns: 1fr; grid-template-rows: 50vh auto; height: auto; }
	}

	.map-wrap { position: relative; background: #111; }
	.map { width: 100%; height: 100%; }
	.no-map {
		display: flex; flex-direction: column; align-items: center; justify-content: center;
		height: 100%; color: rgba(255,255,255,0.25);
	}
	.no-map p { margin: 0; }
	.no-map-sub { font-size: 0.78rem; margin-top: 6px !important; }

	.map-hint {
		position: absolute; bottom: 14px; left: 50%; transform: translateX(-50%);
		background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 20px; padding: 7px 14px;
		font-size: 0.78rem; color: rgba(255,255,255,0.5);
		z-index: 10; white-space: nowrap;
		display: flex; align-items: center; gap: 10px;
	}
	.map-hint.active { border-color: rgba(74,222,128,0.5); color: #4ade80; }
	.hint-done {
		background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.4);
		border-radius: 10px; color: #4ade80; font-size: 0.74rem; font-weight: 600;
		padding: 2px 9px; cursor: pointer;
	}

	aside.panel {
		background: rgba(255,255,255,0.02);
		border-left: 1px solid rgba(255,255,255,0.07);
		overflow-y: auto; padding: 16px;
		display: flex; flex-direction: column; gap: 0;
	}

	.section { margin-bottom: 18px; padding-bottom: 18px; border-bottom: 1px solid rgba(255,255,255,0.06); }
	.section:last-of-type { border-bottom: none; }
	.section h3 {
		margin: 0 0 6px; font-size: 0.82rem; font-weight: 700; color: #9ca3af;
		display: flex; align-items: center; gap: 5px;
	}
	.section-desc { font-size: 0.74rem; color: rgba(255,255,255,0.3); margin: 0 0 10px; }

	.measure-btn {
		width: 100%; padding: 10px;
		background: rgba(96,165,250,0.08); border: 1px solid rgba(96,165,250,0.3);
		border-radius: 10px; color: #60a5fa; font-size: 0.82rem; font-weight: 600;
		cursor: pointer; transition: all 0.15s;
	}
	.measure-btn:hover { background: rgba(96,165,250,0.16); }
	.measuring {
		background: rgba(96,165,250,0.05); border: 1px solid rgba(96,165,250,0.25);
		border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px;
	}
	.pulse { font-size: 0.8rem; color: #60a5fa; font-weight: 600; animation: pulse 1.2s ease-in-out infinite; }
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
	.stop-btn {
		background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.4);
		border-radius: 8px; color: #4ade80; font-size: 0.82rem; font-weight: 700;
		padding: 7px; cursor: pointer;
	}
	.measure-ok { font-size: 0.8rem; color: #4ade80; margin: 6px 0 0; }
	.manual-row {
		display: flex; align-items: center; gap: 6px; margin-top: 8px;
	}
	.num-input {
		width: 70px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
		border-radius: 8px; color: #e5e5e5; font-size: 0.9rem; padding: 6px 8px; text-align: center;
	}
	.unit { font-size: 0.75rem; color: #6b7280; }

	.add-spawn-btn {
		display: flex; align-items: center; justify-content: center; gap: 5px;
		width: 100%; padding: 9px;
		background: rgba(74,222,128,0.06); border: 1px solid rgba(74,222,128,0.25);
		border-radius: 10px; color: #4ade80; font-size: 0.8rem; font-weight: 600;
		cursor: pointer; transition: all 0.15s;
	}
	.add-spawn-btn:hover, .add-spawn-btn.active {
		background: rgba(74,222,128,0.14); border-color: rgba(74,222,128,0.5);
	}

	.spawn-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	.spawn-item {
		display: flex; align-items: center; gap: 6px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
		border-radius: 8px; padding: 8px 10px;
	}
	.spawn-num {
		width: 20px; height: 20px; border-radius: 50%;
		background: #4ade80; color: #000; font-size: 10px; font-weight: 700;
		display: flex; align-items: center; justify-content: center; flex-shrink: 0;
	}
	.spawn-label {
		flex: 1; background: transparent; border: none; outline: none;
		color: #e5e5e5; font-size: 0.8rem;
		border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 1px;
	}
	.del-btn {
		background: transparent; border: none; color: rgba(255,255,255,0.2);
		cursor: pointer; padding: 2px; display: flex; align-items: center;
		border-radius: 4px;
	}
	.del-btn:hover { color: #ef4444; }
	.empty-spawn { font-size: 0.75rem; color: rgba(255,255,255,0.2); margin: 8px 0 0; }

	.error { font-size: 0.8rem; color: #ef4444; margin: 0; }

	.saving-screen {
		flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 20px;
	}
	.spinner {
		width: 40px; height: 40px; border-radius: 50%;
		border: 3px solid rgba(255,255,255,0.1);
		border-top-color: #4ade80;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
