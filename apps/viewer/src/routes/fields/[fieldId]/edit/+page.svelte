<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { db } from '$lib/firebase';
	import { doc, getDoc, updateDoc } from 'firebase/firestore';
	import type { Field, SpawnPoint } from 'shared-types';
	import { ArrowLeft, Save, Trash2, MapPin, Plus } from 'lucide-svelte';

	const fieldId = page.params.fieldId;

	let field = $state<Field | null>(null);
	let loading = $state(true);
	let saving = $state(false);
	let loadError = $state('');
	let addMode = $state(false);

	let spawnPoints = $state<SpawnPoint[]>([]);
	let fieldWidthMeters = $state<number>(80); // フィールド横幅（実寸m）

	// 外周GPS計測
	let measuring = $state(false);
	let measurePts = $state<{lat: number; lng: number}[]>([]);
	let measureWatchId = $state<number | null>(null);
	let measureStatus = $state(''); // 'recording' | 'done' | ''

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
		measureStatus = 'recording';
		let lastPt: {lat:number;lng:number} | null = null;
		measureWatchId = navigator.geolocation.watchPosition(
			(pos) => {
				const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
				if (!lastPt || haversineM(lastPt, pt) > 1) { // 1m以上動いたら記録
					measurePts = [...measurePts, pt];
					lastPt = pt;
				}
			},
			(err) => { console.warn('GPS error', err); },
			{ enableHighAccuracy: true, maximumAge: 0 }
		);
	}

	function stopMeasure() {
		if (measureWatchId !== null) { navigator.geolocation.clearWatch(measureWatchId); measureWatchId = null; }
		measuring = false;
		if (measurePts.length < 2) { measureStatus = ''; alert('GPS点が少なすぎます。もう少し歩いてください。'); return; }
		// 全点ペア間の最大距離を横幅とする
		let maxD = 0;
		for (let i = 0; i < measurePts.length; i++) {
			for (let j = i+1; j < measurePts.length; j++) {
				const d = haversineM(measurePts[i], measurePts[j]);
				if (d > maxD) maxD = d;
			}
		}
		fieldWidthMeters = Math.round(maxD);
		measureStatus = 'done';
	}

	let mapElement: HTMLDivElement;
	let map: any = null;
	let L: any = null;
	let markers: any[] = [];
	let imgW = 1;
	let imgH = 1;

	onMount(async () => {
		// フィールドデータ取得
		try {
			const snap = await getDoc(doc(db, 'fields', fieldId));
			if (!snap.exists()) { loadError = 'フィールドが見つかりません'; loading = false; return; }
			field = { id: snap.id, ...snap.data() } as Field & { id: string };
			spawnPoints = [...(field.spawnPoints ?? [])];
			if (field.fieldWidthMeters) fieldWidthMeters = field.fieldWidthMeters;
		} catch (e) {
			loadError = '読み込みに失敗しました';
			loading = false;
			return;
		}
		loading = false;

		if (!field?.mapImage?.url) return;

		// 画像サイズ取得
		await new Promise<void>(resolve => {
			const img = new Image();
			img.onload = () => { imgW = img.naturalWidth || 1; imgH = img.naturalHeight || 1; resolve(); };
			img.onerror = () => resolve();
			img.src = field!.mapImage!.url;
		});

		// Leaflet 初期化
		const leaflet = await import('leaflet');
		await import('leaflet/dist/leaflet.css');
		L = leaflet.default;

		map = L.map(mapElement, {
			crs: L.CRS.Simple,
			minZoom: -5,
			maxZoom: 5,
			zoomSnap: 0.25,
			attributionControl: false,
		});

		// 画像オーバーレイ（半透明）
		L.imageOverlay(field!.mapImage!.url, [[0, 0], [imgH, imgW]], { opacity: 0.65 }).addTo(map);
		map.fitBounds([[0, 0], [imgH, imgW]], { padding: [30, 30] });

		// AI検出の仮想境界線（参考表示・薄め）
		const vb = field?.virtualBoundary;
		if (vb && vb.length >= 3) {
			const pts = vb.map(p => [(1 - p.y) * imgH, p.x * imgW] as [number, number]);
			L.polygon(pts, {
				color: '#4ade80', weight: 1.5, opacity: 0.35,
				fillOpacity: 0.04, dashArray: '6 4'
			}).addTo(map);
		}

		// AI検出の障害物（参考表示・薄め）
		field?.obstacles?.forEach(obs => {
			const pts = obs.points.map(p => [(1 - p.y) * imgH, p.x * imgW] as [number, number]);
			L.polyline(pts, { color: '#fbbf24', weight: 1.5, opacity: 0.3 }).addTo(map);
		});

		// 既存スポーンピンを描画
		renderMarkers();

		// クリックでスポーン追加
		map.on('click', (e: any) => {
			if (!addMode) return;
			const x = Math.max(0, Math.min(1, e.latlng.lng / imgW));
			const y = Math.max(0, Math.min(1, 1 - e.latlng.lat / imgH)); // Leaflet y軸反転補正
			const newSpawn: SpawnPoint = {
				id: `spawn-${Date.now()}`,
				label: `スポーン ${spawnPoints.length + 1}`,
				x, y,
			};
			spawnPoints = [...spawnPoints, newSpawn];
			renderMarkers();
		});
	});

	onDestroy(() => {
		if (map) { map.remove(); map = null; }
		if (measureWatchId !== null) { navigator.geolocation.clearWatch(measureWatchId); }
	});

	function renderMarkers() {
		if (!map || !L) return;
		markers.forEach(m => m.remove());
		markers = [];

		spawnPoints.forEach((sp, i) => {
			const icon = L.divIcon({
				html: `<div style="
					width:32px;height:32px;border-radius:50%;
					background:#4ade80;border:3px solid #fff;
					color:#000;font-size:13px;font-weight:700;
					display:flex;align-items:center;justify-content:center;
					box-shadow:0 2px 10px rgba(0,0,0,0.7);
					cursor:grab;
				">${i + 1}</div>`,
				iconSize: [32, 32],
				iconAnchor: [16, 16],
				className: '',
			});

			const marker = L.marker([(1 - sp.y) * imgH, sp.x * imgW], { icon, draggable: true });
			marker.addTo(map);

			// ツールチップ（ラベル表示）
			marker.bindTooltip(sp.label, {
				permanent: true,
				direction: 'top',
				offset: [0, -18],
				className: 'spawn-tooltip',
			});

			// ドラッグで座標更新
			marker.on('dragend', (e: any) => {
				const latlng = e.target.getLatLng();
				const x = Math.max(0, Math.min(1, latlng.lng / imgW));
				const y = Math.max(0, Math.min(1, 1 - latlng.lat / imgH)); // Leaflet y軸反転補正
				spawnPoints = spawnPoints.map((s, idx) => idx === i ? { ...s, x, y } : s);
				// ツールチップ位置は自動更新されるのでrenderMarkersは不要
			});

			markers.push(marker);
		});
	}

	// spawnPoints が変わったらマーカーを再描画（ラベル変更・削除に対応）
	$effect(() => {
		// spawnPointsへの依存を登録
		const _ = spawnPoints.length;
		if (map && L) renderMarkers();
	});

	function removeSpawn(index: number) {
		spawnPoints = spawnPoints.filter((_, i) => i !== index);
	}

	function updateLabel(index: number, label: string) {
		spawnPoints = spawnPoints.map((sp, i) => i === index ? { ...sp, label } : sp);
	}

	async function save() {
		if (!fieldId) return;
		saving = true;
		try {
			await updateDoc(doc(db, 'fields', fieldId), {
				spawnPoints: spawnPoints.map(({ id, label, x, y }) => ({ id, label, x, y })),
				fieldWidthMeters: Number(fieldWidthMeters) || 80,
			});
			goto('/');
		} catch (e) {
			console.error(e);
			alert('保存に失敗しました');
		} finally {
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>スポーン地点を編集 – Sabage Tracker</title>
</svelte:head>

<div class="page">
	<header>
		<div class="header-inner">
			<button class="back-btn" onclick={() => goto('/')}>
				<ArrowLeft size={16} />戻る
			</button>
			<h1>スポーン地点を設定</h1>
			<button class="save-btn" onclick={save} disabled={saving || loading}>
				<Save size={15} />
				{saving ? '保存中...' : '保存'}
			</button>
		</div>
	</header>

	{#if loading}
		<div class="center-msg">読み込み中...</div>
	{:else if loadError}
		<div class="center-msg error">{loadError}</div>
	{:else if !field?.mapImage?.url}
		<div class="center-msg">
			<p>このフィールドにはマップ画像がありません。</p>
			<a href="/fields/new" class="link">フィールドを再作成する →</a>
		</div>
	{:else}
		<div class="layout">
			<!-- 地図エリア -->
			<div class="map-wrap">
				<div bind:this={mapElement} class="map"></div>

				<!-- 操作ヒント -->
				<div class="map-hint" class:add-active={addMode}>
					{#if addMode}
						📍 地図上をクリックしてスポーンを追加　<button class="hint-cancel" onclick={() => addMode = false}>完了</button>
					{:else}
						ズーム・パンで位置を確認してから追加してください
					{/if}
				</div>
			</div>

			<!-- サイドパネル -->
			<aside class="panel">
				<div class="panel-header">
					<h2><MapPin size={14} />スポーン地点</h2>
					<span class="spawn-count">{spawnPoints.length}点</span>
				</div>

				<button
					class="add-btn"
					class:active={addMode}
					onclick={() => addMode = !addMode}
				>
					<Plus size={14} />
					{addMode ? '追加モード中（地図をクリック）' : 'スポーンを追加'}
				</button>

				{#if spawnPoints.length === 0}
					<p class="empty-hint">
						「スポーンを追加」を押して地図上をクリックすると、スポーン地点を設置できます。
					</p>
				{:else}
					<ul class="spawn-list">
						{#each spawnPoints as sp, i}
							<li class="spawn-item">
								<div class="spawn-num">{i + 1}</div>
								<div class="spawn-body">
									<input
										class="spawn-label-input"
										type="text"
										value={sp.label}
										oninput={(e) => updateLabel(i, (e.target as HTMLInputElement).value)}
										placeholder="例: チームAスポーン"
										maxlength="24"
									/>
									<span class="spawn-coords">
										x: {sp.x.toFixed(3)} / y: {sp.y.toFixed(3)}
									</span>
								</div>
								<button class="del-btn" onclick={() => removeSpawn(i)} title="削除">
									<Trash2 size={13} />
								</button>
							</li>
						{/each}
					</ul>

					{#if spawnPoints.length < 2}
						<p class="warn">仮想マップのGPS変換には2点以上必要です</p>
					{:else}
						<p class="ok">✓ {spawnPoints.length}点設定済み — 精度向上には離れた2点が重要です</p>
					{/if}
				{/if}

				<!-- フィールド横幅設定 -->
				<div class="field-width-row">
					<label class="field-width-label">📐 フィールド実寸（最大幅）</label>

					<!-- GPS計測ボタン -->
					{#if !measuring}
						<button class="measure-btn" onclick={startMeasure}>
							🚶 外周を歩いて自動計測
						</button>
					{:else}
						<div class="measuring-state">
							<div class="measure-pulse">● 計測中 — {measurePts.length}点取得</div>
							<button class="measure-stop-btn" onclick={stopMeasure}>
								✅ 計測完了
							</button>
						</div>
					{/if}

					{#if measureStatus === 'done'}
						<p class="measure-result">✓ 計測結果: <strong>{fieldWidthMeters} m</strong> を設定しました</p>
					{/if}

					<div class="field-width-input-wrap">
						<input class="field-width-input" type="number" min="10" max="2000" bind:value={fieldWidthMeters} />
						<span class="field-width-unit">m（手動入力も可）</span>
					</div>
					<p class="field-width-hint">スポーン1点でのGPS位置推定に使います。スマホで外周を1周歩くと自動計算されます。</p>
				</div>

				<div class="how-to">
					<p class="how-to-title">使い方</p>
					<ol>
						<li>「スポーンを追加」→ 地図上のスポーン位置をクリック</li>
						<li>ドラッグで微調整（ズームすると精確に）</li>
						<li>ラベルをチームに合わせて編集</li>
						<li>「保存」後、trackerアプリで管理者がスポーンに立ってGPS記録</li>
					</ol>
				</div>
			</aside>
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
		font-size: 11px !important;
		font-weight: 600 !important;
		padding: 2px 7px !important;
		border-radius: 4px !important;
		box-shadow: none !important;
		white-space: nowrap !important;
	}
	:global(.spawn-tooltip::before) { display: none !important; }
	:global(.leaflet-container) { background: #111 !important; }

	.page { min-height: 100vh; display: flex; flex-direction: column; }

	header {
		border-bottom: 1px solid rgba(255,255,255,0.07);
		background: rgba(15,15,15,0.97);
		position: sticky; top: 0; z-index: 100;
		flex-shrink: 0;
	}
	.header-inner {
		max-width: 100%; padding: 12px 20px;
		display: flex; align-items: center; justify-content: space-between; gap: 16px;
	}
	h1 { margin: 0; font-size: 0.95rem; font-weight: 600; }

	.back-btn {
		display: flex; align-items: center; gap: 6px;
		background: transparent; border: none;
		color: rgba(255,255,255,0.4); font-size: 0.85rem; cursor: pointer;
		padding: 6px 10px; border-radius: 8px; transition: color 0.15s;
	}
	.back-btn:hover { color: #fff; }

	.save-btn {
		display: flex; align-items: center; gap: 6px;
		background: #4ade80; color: #000; border: none;
		padding: 8px 18px; border-radius: 8px;
		font-size: 0.85rem; font-weight: 700; cursor: pointer; transition: opacity 0.15s;
	}
	.save-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.save-btn:not(:disabled):hover { opacity: 0.85; }

	.center-msg {
		flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
		color: rgba(255,255,255,0.35); font-size: 0.9rem; gap: 12px;
	}
	.center-msg.error { color: #f87171; }
	.link { color: #4ade80; text-decoration: none; font-size: 0.85rem; }

	.layout {
		flex: 1; display: grid; grid-template-columns: 1fr 300px;
		min-height: 0; height: calc(100vh - 57px);
	}
	@media (max-width: 700px) {
		.layout { grid-template-columns: 1fr; grid-template-rows: 55vh auto; height: auto; }
	}

	.map-wrap { position: relative; }
	.map { width: 100%; height: 100%; }

	.map-hint {
		position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
		background: rgba(0,0,0,0.7); backdrop-filter: blur(8px);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 20px; padding: 7px 16px;
		font-size: 0.78rem; color: rgba(255,255,255,0.5);
		z-index: 10; white-space: nowrap;
		display: flex; align-items: center; gap: 10px;
		transition: border-color 0.2s;
	}
	.map-hint.add-active {
		border-color: rgba(74,222,128,0.5); color: #4ade80;
	}
	.hint-cancel {
		background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.4);
		border-radius: 12px; color: #4ade80; font-size: 0.75rem; font-weight: 600;
		padding: 3px 10px; cursor: pointer; transition: background 0.15s;
	}
	.hint-cancel:hover { background: rgba(74,222,128,0.25); }

	aside.panel {
		background: rgba(255,255,255,0.02);
		border-left: 1px solid rgba(255,255,255,0.07);
		overflow-y: auto; padding: 20px 16px;
		display: flex; flex-direction: column; gap: 14px;
	}

	.panel-header {
		display: flex; align-items: center; justify-content: space-between;
	}
	.panel-header h2 {
		margin: 0; font-size: 0.88rem; font-weight: 600;
		display: flex; align-items: center; gap: 6px; color: #e5e5e5;
	}
	.spawn-count {
		font-size: 0.75rem; font-weight: 600;
		background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.25);
		color: #4ade80; border-radius: 20px; padding: 2px 8px;
	}

	.add-btn {
		display: flex; align-items: center; justify-content: center; gap: 6px;
		width: 100%; padding: 10px;
		background: rgba(74,222,128,0.06); border: 1px solid rgba(74,222,128,0.25);
		border-radius: 10px; color: #4ade80; font-size: 0.82rem; font-weight: 600;
		cursor: pointer; transition: all 0.15s;
	}
	.add-btn:hover, .add-btn.active {
		background: rgba(74,222,128,0.14); border-color: rgba(74,222,128,0.5);
	}

	.empty-hint {
		font-size: 0.78rem; color: rgba(255,255,255,0.25); text-align: center;
		line-height: 1.6; margin: 0; padding: 12px 0;
	}

	.spawn-list {
		list-style: none; margin: 0; padding: 0;
		display: flex; flex-direction: column; gap: 8px;
	}
	.spawn-item {
		display: flex; align-items: center; gap: 8px;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.07);
		border-radius: 10px; padding: 10px 10px 10px 12px;
	}
	.spawn-num {
		width: 22px; height: 22px; border-radius: 50%;
		background: #4ade80; color: #000;
		font-size: 11px; font-weight: 700;
		display: flex; align-items: center; justify-content: center; flex-shrink: 0;
	}
	.spawn-body {
		flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0;
	}
	.spawn-label-input {
		background: transparent; border: none; outline: none;
		color: #e5e5e5; font-size: 0.83rem; font-weight: 500;
		border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 2px;
		width: 100%;
	}
	.spawn-label-input:focus { border-bottom-color: rgba(74,222,128,0.5); }
	.spawn-coords {
		font-size: 0.68rem; color: rgba(255,255,255,0.25);
		font-family: 'SF Mono', 'Fira Code', monospace;
	}
	.del-btn {
		background: transparent; border: none; color: rgba(255,255,255,0.2);
		cursor: pointer; padding: 4px; display: flex; align-items: center;
		border-radius: 6px; transition: all 0.15s; flex-shrink: 0;
	}
	.del-btn:hover { color: #ef4444; background: rgba(239,68,68,0.1); }

	.warn { font-size: 0.75rem; color: #facc15; margin: 0; }
	.ok { font-size: 0.75rem; color: #4ade80; margin: 0; line-height: 1.5; }

	.field-width-row { display: flex; flex-direction: column; gap: 6px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.06); }
	.field-width-label { font-size: 0.75rem; font-weight: 700; color: #9ca3af; }

	.measure-btn {
		width: 100%; padding: 10px;
		background: rgba(96,165,250,0.08); border: 1px solid rgba(96,165,250,0.3);
		border-radius: 10px; color: #60a5fa; font-size: 0.82rem; font-weight: 600;
		cursor: pointer; transition: all 0.15s;
	}
	.measure-btn:hover { background: rgba(96,165,250,0.16); }

	.measuring-state {
		display: flex; flex-direction: column; gap: 6px;
		background: rgba(96,165,250,0.05); border: 1px solid rgba(96,165,250,0.25);
		border-radius: 10px; padding: 10px;
	}
	.measure-pulse {
		font-size: 0.8rem; color: #60a5fa; font-weight: 600;
		animation: pulse 1.2s ease-in-out infinite;
	}
	@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
	.measure-stop-btn {
		background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.4);
		border-radius: 8px; color: #4ade80; font-size: 0.82rem; font-weight: 700;
		padding: 7px; cursor: pointer; transition: all 0.15s;
	}
	.measure-stop-btn:hover { background: rgba(74,222,128,0.2); }

	.measure-result { font-size: 0.78rem; color: #4ade80; margin: 0; }
	.measure-result strong { font-size: 0.9rem; }

	.field-width-input-wrap { display: flex; align-items: center; gap: 6px; }
	.field-width-input {
		width: 80px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
		border-radius: 8px; color: #e5e5e5; font-size: 0.9rem; padding: 6px 10px; text-align: center;
	}
	.field-width-unit { font-size: 0.78rem; color: #6b7280; }
	.field-width-hint { font-size: 0.7rem; color: #4b5563; margin: 0; }

	.how-to {
		margin-top: auto; padding-top: 14px;
		border-top: 1px solid rgba(255,255,255,0.06);
		font-size: 0.72rem; color: rgba(255,255,255,0.25); line-height: 1.7;
	}
	.how-to-title { font-weight: 600; color: rgba(255,255,255,0.35); margin: 0 0 6px; }
	.how-to ol { margin: 0; padding-left: 16px; }
	.how-to li { margin-bottom: 4px; }
</style>
