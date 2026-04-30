<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import { db, storage } from '$lib/firebase';
	import { collection, addDoc } from 'firebase/firestore';
	import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
	import type { SpawnPoint } from 'shared-types';
	// Legacy types (virtual map removed — kept as any for backwards compatibility)
	type VirtualPoint = { x: number; y: number };
	type ObstacleLine = { points: VirtualPoint[] };
	import { ArrowLeft, ArrowRight, Check, MapPin, Plus, Trash2, Pencil } from 'lucide-svelte';

	// ウィザードステップ
	type Step = 'info' | 'map' | 'field' | 'saving';
	let step = $state<Step>('info');

	// Step 1
	let eventName = $state('');
	let eventDate = $state(new Date().toISOString().slice(0, 10));

	// Step 2: 画像
	let mapFile = $state<File | null>(null);
	let mapPreviewUrl = $state('');
	let analyzing = $state(false);
	let analyzeError = $state('');
	let analyzeDone = $state(false);

	// AI結果
	let virtualBoundary = $state<VirtualPoint[]>([]);
	let obstacles = $state<ObstacleLine[]>([]);

	// Step 3: フィールド編集
	type EditMode = 'none' | 'add-vertex' | 'add-spawn';
	let editMode = $state<EditMode>('none');
	let spawnPoints = $state<SpawnPoint[]>([]);

	// GPS計測
	let measuring = $state(false);
	let measurePts = $state<{lat:number;lng:number}[]>([]);
	let measureWatchId = $state<number|null>(null);
	let fieldWidthMeters = $state<number>(80);
	let measureDone = $state(false);

	// Leaflet
	let mapEl: HTMLDivElement;
	let leafletMap: any = null;
	let L: any = null;
	let imgW = 1, imgH = 1;

	// 最後に初期化した画像URL。同じURLでの二重初期化を防ぐ
	let lastInitUrl = '';

	// step と mapPreviewUrl を監視。URLが変わったときだけ再初期化する
	$effect(() => {
		if (step === 'field' && mapPreviewUrl && mapPreviewUrl !== lastInitUrl) {
			lastInitUrl = mapPreviewUrl;
			initLeaflet();
		}
	});

	// Leaflet objects
	let boundaryPolygon: any = null;
	let boundaryVertexMarkers: any[] = [];
	let obstaclePolylines: any[] = [];
	let spawnMarkerObjects: any[] = [];

	// Saving
	let saveError = $state('');

	// -------------------------------------------------------
	// ファイル選択 → AI解析
	// -------------------------------------------------------
	async function onFileChange(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		mapFile = file;
		if (mapPreviewUrl) URL.revokeObjectURL(mapPreviewUrl);
		mapPreviewUrl = URL.createObjectURL(file);
		analyzeDone = false;
		analyzeError = '';
		virtualBoundary = [];
		obstacles = [];
		await runAnalysis(file);
	}

	async function fileToBase64(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve((reader.result as string).split(',')[1]);
			reader.onerror = reject;
			reader.readAsDataURL(file);
		});
	}

	async function runAnalysis(file: File) {
		analyzing = true;
		analyzeError = '';
		try {
			const base64 = await fileToBase64(file);
			const res = await fetch('/api/analyze-field', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageBase64: base64, mimeType: file.type })
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			virtualBoundary = Array.isArray(data.boundary) ? data.boundary : [];
			obstacles = Array.isArray(data.obstacles) ? data.obstacles : [];
			analyzeDone = true;
		} catch (e: unknown) {
			analyzeError = e instanceof Error ? e.message : '解析に失敗しました';
			analyzeDone = false;
		} finally {
			analyzing = false;
		}
	}

	// -------------------------------------------------------
	// Step 3: Leaflet 初期化
	// -------------------------------------------------------
	async function initLeaflet() {
		const el = mapEl; // 非同期await中に参照が変わらないよう最初にキャプチャ
		const url = mapPreviewUrl;
		if (!url || !el) return;

		// 既存マップをクリーンアップ
		if (leafletMap) { try { leafletMap.remove(); } catch(_){} leafletMap = null; }

		await new Promise<void>(resolve => {
			const img = new Image();
			img.onload = () => { imgW = img.naturalWidth || 800; imgH = img.naturalHeight || 600; resolve(); };
			img.onerror = () => { imgW = 800; imgH = 600; resolve(); };
			img.src = url; // キャプチャしたurlを使用
		});

		// await後にコンテナがまだDOMに存在するか確認
		if (!el.isConnected) return;

		const leaflet = await import('leaflet');
		await import('leaflet/dist/leaflet.css');
		L = leaflet.default;

		// await後も再確認
		if (!el.isConnected) return;

		leafletMap = L.map(el, { // キャプチャしたelを使用
			crs: L.CRS.Simple,
			minZoom: -5, maxZoom: 5,
			zoomSnap: 0.25,
			attributionControl: false,
			doubleClickZoom: false,
		});

		L.imageOverlay(url, [[0,0],[imgH,imgW]], { opacity: 0.72 }).addTo(leafletMap);
		leafletMap.fitBounds([[0,0],[imgH,imgW]], { padding: [20,20] });

		// マップクリック
		leafletMap.on('click', (e: any) => {
			const x = Math.max(0, Math.min(1, e.latlng.lng / imgW));
			const y = Math.max(0, Math.min(1, 1 - e.latlng.lat / imgH));

			if (editMode === 'add-vertex') {
				const idx = findNearestEdge({x, y});
				virtualBoundary = [
					...virtualBoundary.slice(0, idx+1),
					{x, y},
					...virtualBoundary.slice(idx+1)
				];
				renderBoundary();
			} else if (editMode === 'add-spawn') {
				const sp: SpawnPoint = {
					id: `spawn-${Date.now()}`,
					label: `スポーン ${spawnPoints.length+1}`,
					lat: 0, lng: 0,
				};
				(sp as any).x = x; (sp as any).y = y; // legacy virtual coords
				spawnPoints = [...spawnPoints, sp];
				renderSpawns();
			}
		});

		renderBoundary();
		renderObstacles();
		renderSpawns();
	}

	// -------------------------------------------------------
	// 境界線描画・編集
	// -------------------------------------------------------
	function toLL(p: VirtualPoint): [number, number] {
		return [(1-p.y)*imgH, p.x*imgW];
	}

	function renderBoundary() {
		if (!leafletMap || !L) return;
		boundaryVertexMarkers.forEach(m => m.remove());
		boundaryVertexMarkers = [];
		if (boundaryPolygon) { boundaryPolygon.remove(); boundaryPolygon = null; }
		if (virtualBoundary.length < 3) return;

		const latlngs = virtualBoundary.map(toLL);

		boundaryPolygon = L.polygon(latlngs, {
			color: '#4ade80', weight: 2, opacity: 0.9,
			fillColor: '#4ade80', fillOpacity: 0.06,
		}).addTo(leafletMap);

		// 辺クリックで頂点追加（add-vertex mode）
		boundaryPolygon.on('click', (e: any) => {
			if (editMode !== 'add-vertex') return;
			L.DomEvent.stopPropagation(e);
			const x = Math.max(0, Math.min(1, e.latlng.lng / imgW));
			const y = Math.max(0, Math.min(1, 1 - e.latlng.lat / imgH));
			const idx = findNearestEdge({x, y});
			virtualBoundary = [
				...virtualBoundary.slice(0, idx+1),
				{x, y},
				...virtualBoundary.slice(idx+1)
			];
			renderBoundary();
		});

		// 頂点マーカー
		virtualBoundary.forEach((pt, i) => {
			const isEdit = editMode === 'add-vertex';
			const icon = L.divIcon({
				html: `<div style="
					width:${isEdit ? 16 : 12}px;height:${isEdit ? 16 : 12}px;
					border-radius:50%;background:#4ade80;
					border:2px solid #fff;cursor:${isEdit ? 'pointer' : 'grab'};
					box-shadow:0 1px 5px rgba(0,0,0,0.6);
					transition:transform 0.1s;
				"></div>`,
				iconSize: [isEdit ? 16 : 12, isEdit ? 16 : 12],
				iconAnchor: [isEdit ? 8 : 6, isEdit ? 8 : 6],
				className: '',
			});
			const marker = L.marker(toLL(pt), {
				icon,
				draggable: true,
				zIndexOffset: 200,
			}).addTo(leafletMap);

			// ドラッグ: 位置更新
			marker.on('drag', (e: any) => {
				const ll = e.target.getLatLng();
				const nx = Math.max(0, Math.min(1, ll.lng / imgW));
				const ny = Math.max(0, Math.min(1, 1 - ll.lat / imgH));
				virtualBoundary = virtualBoundary.map((p, idx) => idx === i ? {x:nx, y:ny} : p);
				if (boundaryPolygon) boundaryPolygon.setLatLngs(virtualBoundary.map(toLL));
			});

			// クリック: 頂点削除（add-vertex mode）
			marker.on('click', (e: any) => {
				if (editMode !== 'add-vertex') return;
				L.DomEvent.stopPropagation(e);
				if (virtualBoundary.length > 3) {
					virtualBoundary = virtualBoundary.filter((_, idx) => idx !== i);
					renderBoundary();
				}
			});

			boundaryVertexMarkers.push(marker);
		});
	}

	// editModeが変わったら頂点マーカーを再描画（サイズ変更）
	$effect(() => {
		const _ = editMode;
		if (leafletMap && L && virtualBoundary.length > 0) renderBoundary();
	});

	// -------------------------------------------------------
	// 障害物描画（参考表示のみ）
	// -------------------------------------------------------
	function renderObstacles() {
		if (!leafletMap || !L) return;
		obstaclePolylines.forEach(l => l.remove());
		obstaclePolylines = [];
		obstacles.forEach(obs => {
			const pts = obs.points.map((p: VirtualPoint) => toLL(p));
			const line = L.polyline(pts, {
				color: '#fbbf24', weight: 2, opacity: 0.4, dashArray: '5 4'
			}).addTo(leafletMap);
			obstaclePolylines.push(line);
		});
	}

	// -------------------------------------------------------
	// スポーン描画
	// -------------------------------------------------------
	function renderSpawns() {
		if (!leafletMap || !L) return;
		spawnMarkerObjects.forEach(m => m.remove());
		spawnMarkerObjects = [];
		spawnPoints.forEach((sp, i) => {
			const icon = L.divIcon({
				html: `<div style="
					width:28px;height:28px;border-radius:50%;
					background:#f97316;border:2px solid #fff;
					color:#fff;font-size:12px;font-weight:800;
					display:flex;align-items:center;justify-content:center;
					box-shadow:0 2px 8px rgba(0,0,0,0.7)
				">${i+1}</div>`,
				iconSize: [28,28], iconAnchor: [14,14], className: ''
			});
			const m = L.marker(toLL(sp as unknown as VirtualPoint), { icon, draggable: true });
			m.addTo(leafletMap);
			m.bindTooltip(sp.label, {
				permanent: true, direction: 'top', offset: [0,-16], className: 'spawn-tooltip'
			});
			m.on('dragend', (e: any) => {
				const ll = e.target.getLatLng();
				const nx = Math.max(0, Math.min(1, ll.lng / imgW));
				const ny = Math.max(0, Math.min(1, 1 - ll.lat / imgH));
				spawnPoints = spawnPoints.map((s, idx) => idx === i ? {...s, x:nx, y:ny} : s);
			});
			spawnMarkerObjects.push(m);
		});
	}

	$effect(() => {
		const _ = spawnPoints.length;
		if (leafletMap && L) renderSpawns();
	});

	// -------------------------------------------------------
	// 最近傍辺インデックス
	// -------------------------------------------------------
	function findNearestEdge(pt: VirtualPoint): number {
		let minDist = Infinity, minIdx = 0;
		const n = virtualBoundary.length;
		for (let i = 0; i < n; i++) {
			const a = virtualBoundary[i];
			const b = virtualBoundary[(i+1) % n];
			const d = segDist(pt.x, pt.y, a.x, a.y, b.x, b.y);
			if (d < minDist) { minDist = d; minIdx = i; }
		}
		return minIdx;
	}
	function segDist(px:number,py:number,ax:number,ay:number,bx:number,by:number): number {
		const dx=bx-ax, dy=by-ay;
		if (dx===0&&dy===0) return Math.hypot(px-ax,py-ay);
		const t = Math.max(0, Math.min(1, ((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy)));
		return Math.hypot(px-(ax+t*dx), py-(ay+t*dy));
	}

	// -------------------------------------------------------
	// GPS外周計測
	// -------------------------------------------------------
	function haversineM(a:{lat:number;lng:number}, b:{lat:number;lng:number}): number {
		const R=6371000;
		const dLat=(b.lat-a.lat)*Math.PI/180;
		const dLng=(b.lng-a.lng)*Math.PI/180;
		const aa=Math.sin(dLat/2)**2+Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
		return R*2*Math.atan2(Math.sqrt(aa),Math.sqrt(1-aa));
	}
	function startMeasure() {
		if (!navigator.geolocation) { alert('GPS非対応'); return; }
		measurePts = []; measuring = true; measureDone = false;
		let last: {lat:number;lng:number}|null = null;
		measureWatchId = navigator.geolocation.watchPosition(
			(pos) => {
				const pt = {lat:pos.coords.latitude, lng:pos.coords.longitude};
				if (!last || haversineM(last,pt) > 1) { measurePts = [...measurePts, pt]; last = pt; }
			},
			(e) => console.warn(e),
			{ enableHighAccuracy: true, maximumAge: 0 }
		);
	}
	function stopMeasure() {
		if (measureWatchId!==null) { navigator.geolocation.clearWatch(measureWatchId); measureWatchId=null; }
		measuring = false;
		if (measurePts.length < 2) { alert('GPS点が少なすぎます'); return; }
		let maxD = 0;
		for (let i=0;i<measurePts.length;i++)
			for (let j=i+1;j<measurePts.length;j++) {
				const d = haversineM(measurePts[i],measurePts[j]);
				if (d>maxD) maxD=d;
			}
		fieldWidthMeters = Math.round(maxD);
		measureDone = true;
	}

	// -------------------------------------------------------
	// ステップ遷移
	// -------------------------------------------------------
	function goToField() {
		step = 'field'; // $effect が step と mapPreviewUrl を監視して initLeaflet を呼ぶ
	}

	function removeSpawn(i: number) { spawnPoints = spawnPoints.filter((_,idx) => idx !== i); }
	function updateLabel(i: number, v: string) { spawnPoints = spawnPoints.map((s,idx) => idx===i ? {...s,label:v} : s); }

	// -------------------------------------------------------
	// 保存
	// -------------------------------------------------------
	async function save() {
		step = 'saving';
		saveError = '';
		try {
			let uploadedUrl = '';
			if (mapFile) {
				const path = `fields/${Date.now()}_${mapFile.name}`;
				const sref = storageRef(storage, path);
				await uploadBytes(sref, mapFile);
				uploadedUrl = await getDownloadURL(sref);
			}

			const fieldData: Record<string, unknown> = {
				name: eventName,
				boundary: [],
				fieldWidthMeters: Number(fieldWidthMeters) || 80,
				spawnPoints: spawnPoints.map(({id,label}) => ({id,label,lat:0,lng:0})),
				virtualBoundary: virtualBoundary,
				obstacles: obstacles,
				...(uploadedUrl ? { mapImage: { url: uploadedUrl } } : {}),
			};

			const fieldRef = await addDoc(collection(db, 'fields'), fieldData);
			const dateMs = new Date(eventDate).getTime();
			await addDoc(collection(db, 'events'), {
				name: eventName,
				date: dateMs,
				fieldId: fieldRef.id,
				createdAt: Date.now(),
			});

			goto('/');
		} catch (e: unknown) {
			saveError = e instanceof Error ? e.message : '保存に失敗しました';
			step = 'field';
		}
	}

	onDestroy(() => {
		if (measureWatchId!==null) navigator.geolocation.clearWatch(measureWatchId);
		if (leafletMap) { leafletMap.remove(); leafletMap = null; }
		if (mapPreviewUrl) URL.revokeObjectURL(mapPreviewUrl);
	});
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
		<div class="steps">
			<span class="step" class:active={step==='info'} class:done={step!=='info'}>①</span>
			<span class="step-line"></span>
			<span class="step" class:active={step==='map'} class:done={step==='field'||step==='saving'}>②</span>
			<span class="step-line"></span>
			<span class="step" class:active={step==='field'||step==='saving'}>③</span>
		</div>
	</header>

	<!-- ═══════════ STEP 1: イベント情報 ═══════════ -->
	{#if step === 'info'}
	<div class="card">
		<h2>📅 イベント情報</h2>
		<p class="desc">今日のゲームデーの名前と日付を入力してください</p>

		<label class="lbl">イベント名</label>
		<input class="txt-input" type="text" placeholder="例: 第1回〇〇サバゲー"
			bind:value={eventName} maxlength="50" />

		<label class="lbl" style="margin-top:16px">開催日</label>
		<input class="txt-input" type="date" bind:value={eventDate} />

		<button class="next-btn" onclick={() => step='map'} disabled={eventName.trim().length===0}>
			次へ（フィールドマップ）<ArrowRight size={16} />
		</button>
	</div>

	<!-- ═══════════ STEP 2: マップ + AI解析 ═══════════ -->
	{:else if step === 'map'}
	<div class="card">
		<h2>🗺 フィールドマップ</h2>
		<p class="desc">画像をアップロードするとAIが外周を自動検知します</p>

		{#if !mapPreviewUrl}
			<label class="upload-area">
				<input type="file" accept="image/*" onchange={onFileChange} style="display:none" />
				<div class="upload-icon">📷</div>
				<div class="upload-text">タップして画像を選択</div>
				<div class="upload-sub">JPG / PNG / WebP — 10MB 以下</div>
			</label>
		{:else}
			<div class="preview-wrap">
				<img src={mapPreviewUrl} alt="preview" class="map-preview" />

				<!-- AI解析ステータス -->
				{#if analyzing}
					<div class="ai-badge analyzing">
						<div class="spinner-sm"></div> AIが外周を解析中…
					</div>
				{:else if analyzeDone}
					<div class="ai-badge done">
						✓ 解析完了 — 外周 {virtualBoundary.length}点
						{#if obstacles.length > 0}· 障害物 {obstacles.length}件{/if}
					</div>
				{:else if analyzeError}
					<div class="ai-badge error">⚠ {analyzeError}</div>
				{/if}
			</div>

			<div class="preview-actions">
				<button class="sub-btn" onclick={() => { mapFile=null; mapPreviewUrl=''; analyzeDone=false; virtualBoundary=[]; obstacles=[]; }}>
					<Trash2 size={13} />画像を削除
				</button>
				{#if !analyzing && mapFile}
					<button class="sub-btn" onclick={() => runAnalysis(mapFile!)}>
						🔄 再解析
					</button>
				{/if}
			</div>
		{/if}

		<div class="btn-row">
			<button class="back-btn" onclick={() => step='info'}><ArrowLeft size={15} />戻る</button>
			{#if !mapPreviewUrl}
				<button class="next-btn-ghost" onclick={goToField}>
					スキップ<ArrowRight size={15} />
				</button>
			{:else}
				<button class="next-btn" onclick={goToField} disabled={analyzing}>
					{analyzing ? '解析中…' : '次へ（フィールド編集）'}<ArrowRight size={16} />
				</button>
			{/if}
		</div>
	</div>

	<!-- ═══════════ SAVING ═══════════ -->
	{:else if step === 'saving'}
	<div class="saving-screen">
		<div class="spinner"></div>
		<p>画像をアップロードして保存中…</p>
	</div>
	{/if}

	<!--
		STEP 3: フィールド編集
		{#if} の外に常時レンダリング → mapEl が mount 時から確実にDOMに存在する
		step !== 'field' の間は display:none で非表示
	-->
	<div class="field-step" style:display={step === 'field' ? 'grid' : 'none'}>
		<div class="map-wrap">
			<!-- bind:this は常に有効。{#if} で囲まないことでLeafletが確実に掴める -->
			<div bind:this={mapEl} class="map" style:visibility={mapPreviewUrl ? 'visible' : 'hidden'}></div>

			{#if !mapPreviewUrl}
				<div class="no-map">マップ画像なし — スポーン設定は省略されます</div>
			{:else}
				<div class="edit-hud">
					{#if editMode === 'none'}
						<span class="hud-idle">🖱 頂点ドラッグで調整</span>
					{:else if editMode === 'add-vertex'}
						<span class="hud-active">✏ クリックで頂点追加 / 頂点タップで削除</span>
						<button class="hud-done" onclick={() => editMode='none'}>完了</button>
					{:else if editMode === 'add-spawn'}
						<span class="hud-active" style="color:#fb923c">📍 クリックでスポーン追加</span>
						<button class="hud-done" onclick={() => editMode='none'}>完了</button>
					{/if}
				</div>
			{/if}
		</div>

		<aside class="panel">
			{#if mapPreviewUrl}
			<section class="section">
				<h3>🟢 外周境界線</h3>
				<p class="sec-note">
					{virtualBoundary.length > 0 ? `${virtualBoundary.length}頂点で認識済み` : 'AI解析で外周が検知されませんでした'}
				</p>
				<div class="edit-btns">
					<button
						class="edit-mode-btn"
						class:active={editMode==='add-vertex'}
						onclick={() => editMode = editMode==='add-vertex' ? 'none' : 'add-vertex'}
					>
						<Pencil size={12} />頂点を編集
					</button>
				</div>
				<p class="hint-text">頂点はドラッグで移動。編集モードでクリック→追加・タップ→削除</p>
			</section>

			<section class="section">
				<h3><MapPin size={12} />スポーン地点</h3>
				<button
					class="edit-mode-btn"
					class:active={editMode==='add-spawn'}
					style={editMode==='add-spawn' ? 'border-color:#fb923c;color:#fb923c;background:rgba(249,115,22,0.1)' : ''}
					onclick={() => editMode = editMode==='add-spawn' ? 'none' : 'add-spawn'}
				>
					<Plus size={12} />{editMode==='add-spawn' ? '追加中（地図をクリック）' : 'スポーンを追加'}
				</button>
				{#if spawnPoints.length > 0}
					<ul class="spawn-list">
						{#each spawnPoints as sp, i}
							<li class="spawn-item">
								<div class="spawn-num" style="background:#f97316">{i+1}</div>
								<input class="spawn-label" type="text" value={sp.label}
									oninput={(e) => updateLabel(i, (e.target as HTMLInputElement).value)} />
								<button class="del-btn" onclick={() => removeSpawn(i)}><Trash2 size={12} /></button>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="sec-note">まだスポーン地点がありません</p>
				{/if}
			</section>
			{/if}

			<section class="section">
				<h3>📐 フィールド実寸</h3>
				<p class="sec-note">スマホで外周を歩いて実際の広さを計測します</p>
				{#if !measuring}
					<button class="measure-btn" onclick={startMeasure}>🚶 外周を歩いて計測開始</button>
				{:else}
					<div class="measuring">
						<div class="pulse">● 計測中 — {measurePts.length}点取得</div>
						<button class="stop-btn-m" onclick={stopMeasure}>✅ 計測完了</button>
					</div>
				{/if}
				{#if measureDone}<p class="measure-ok">✓ {fieldWidthMeters} m を設定しました</p>{/if}
				<div class="manual-row">
					<input class="num-input" type="number" min="10" max="2000" bind:value={fieldWidthMeters} />
					<span class="unit">m（手動入力も可）</span>
				</div>
			</section>

			{#if saveError}<p class="error">{saveError}</p>{/if}

			<div class="btn-row">
				<button class="back-btn" onclick={() => step='map'}><ArrowLeft size={15} />戻る</button>
				<button class="save-btn" onclick={save}><Check size={15} />イベントを作成</button>
			</div>
		</aside>
	</div>
</div>

<style>
	:global(body) {
		margin:0;padding:0;
		background:#0a0a0a;color:#e5e5e5;
		font-family:'Inter',system-ui,-apple-system,sans-serif;
		min-height:100vh;
	}
	:global(.spawn-tooltip) {
		background:rgba(0,0,0,0.8)!important;
		border:1px solid rgba(249,115,22,0.5)!important;
		color:#fb923c!important;
		font-size:11px!important;font-weight:600!important;
		padding:2px 7px!important;border-radius:4px!important;
		box-shadow:none!important;white-space:nowrap!important;
	}
	:global(.spawn-tooltip::before){display:none!important;}
	:global(.leaflet-container){background:#111!important;}

	.page{min-height:100vh;display:flex;flex-direction:column;}

	header{
		display:flex;align-items:center;gap:12px;
		padding:13px 18px;
		border-bottom:1px solid rgba(255,255,255,0.07);
		background:rgba(15,15,15,0.97);
		position:sticky;top:0;z-index:100;
	}
	.back{
		display:flex;align-items:center;gap:5px;
		background:transparent;border:none;
		color:rgba(255,255,255,0.4);font-size:0.85rem;cursor:pointer;
		padding:6px 10px;border-radius:8px;
	}
	.back:hover{color:#fff;}
	h1{margin:0;font-size:0.95rem;font-weight:600;flex:1;}

	.steps{display:flex;align-items:center;gap:4px;margin-left:auto;}
	.step{
		width:26px;height:26px;border-radius:50%;
		background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
		display:flex;align-items:center;justify-content:center;
		font-size:0.72rem;font-weight:700;color:rgba(255,255,255,0.3);
	}
	.step.active{background:#4ade80;color:#000;border-color:#4ade80;}
	.step.done{background:rgba(74,222,128,0.12);color:#4ade80;border-color:rgba(74,222,128,0.35);}
	.step-line{width:14px;height:1px;background:rgba(255,255,255,0.1);}

	/* Cards */
	.card{
		max-width:480px;margin:36px auto;padding:28px 24px;
		background:rgba(255,255,255,0.02);
		border:1px solid rgba(255,255,255,0.08);
		border-radius:16px;
		display:flex;flex-direction:column;gap:10px;
		width:calc(100% - 40px);
	}
	.card h2{margin:0 0 2px;font-size:1.05rem;}
	.desc{margin:0 0 8px;font-size:0.82rem;color:rgba(255,255,255,0.35);}
	.lbl{font-size:0.74rem;font-weight:600;color:#9ca3af;}
	.txt-input{
		width:100%;box-sizing:border-box;
		background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
		border-radius:10px;color:#e5e5e5;font-size:0.95rem;
		padding:12px 14px;outline:none;
	}
	.txt-input:focus{border-color:rgba(74,222,128,0.5);}

	.upload-area{
		display:flex;flex-direction:column;align-items:center;gap:8px;
		padding:32px 20px;border:2px dashed rgba(255,255,255,0.12);
		border-radius:12px;cursor:pointer;transition:border-color 0.15s;
	}
	.upload-area:hover{border-color:rgba(74,222,128,0.4);}
	.upload-icon{font-size:2rem;}
	.upload-text{font-size:0.9rem;font-weight:600;}
	.upload-sub{font-size:0.75rem;color:rgba(255,255,255,0.3);}

	.preview-wrap{position:relative;border-radius:10px;overflow:hidden;}
	.map-preview{width:100%;border-radius:10px;max-height:220px;object-fit:cover;display:block;}
	.ai-badge{
		position:absolute;bottom:8px;left:50%;transform:translateX(-50%);
		border-radius:20px;padding:5px 14px;font-size:0.76rem;font-weight:600;
		white-space:nowrap;display:flex;align-items:center;gap:6px;
		backdrop-filter:blur(8px);
	}
	.ai-badge.analyzing{background:rgba(0,0,0,0.7);border:1px solid rgba(96,165,250,0.4);color:#93c5fd;}
	.ai-badge.done{background:rgba(0,0,0,0.7);border:1px solid rgba(74,222,128,0.4);color:#4ade80;}
	.ai-badge.error{background:rgba(0,0,0,0.7);border:1px solid rgba(239,68,68,0.4);color:#f87171;}
	.spinner-sm{
		width:14px;height:14px;border-radius:50%;
		border:2px solid rgba(147,197,253,0.2);border-top-color:#93c5fd;
		animation:spin 0.7s linear infinite;flex-shrink:0;
	}
	.preview-actions{display:flex;gap:8px;}
	.sub-btn{
		display:flex;align-items:center;gap:5px;
		background:transparent;border:1px solid rgba(255,255,255,0.1);
		color:rgba(255,255,255,0.4);font-size:0.78rem;padding:5px 10px;
		border-radius:7px;cursor:pointer;
	}
	.sub-btn:hover{color:#fff;border-color:rgba(255,255,255,0.2);}

	.btn-row{display:flex;gap:10px;justify-content:flex-end;margin-top:8px;}
	.back-btn{
		display:flex;align-items:center;gap:5px;
		background:transparent;border:1px solid rgba(255,255,255,0.12);
		color:rgba(255,255,255,0.5);font-size:0.85rem;
		padding:10px 16px;border-radius:10px;cursor:pointer;
	}
	.next-btn{
		display:flex;align-items:center;gap:6px;
		background:#4ade80;color:#000;border:none;
		font-size:0.88rem;font-weight:700;
		padding:10px 20px;border-radius:10px;cursor:pointer;transition:opacity 0.15s;
	}
	.next-btn:disabled{opacity:0.4;cursor:not-allowed;}
	.next-btn:not(:disabled):hover{opacity:0.85;}
	.next-btn-ghost{
		display:flex;align-items:center;gap:6px;
		background:transparent;color:rgba(255,255,255,0.4);
		border:1px solid rgba(255,255,255,0.12);
		font-size:0.85rem;padding:10px 16px;border-radius:10px;cursor:pointer;
	}
	.save-btn{
		display:flex;align-items:center;gap:6px;
		background:#4ade80;color:#000;border:none;
		font-size:0.88rem;font-weight:700;
		padding:10px 20px;border-radius:10px;cursor:pointer;transition:opacity 0.15s;
	}
	.save-btn:hover{opacity:0.85;}

	/* Step 3 layout */
	.field-step{
		flex:1;display:grid;grid-template-columns:1fr 300px;
		height:calc(100vh - 57px);min-height:0;
	}
	@media(max-width:700px){
		.field-step{grid-template-columns:1fr;grid-template-rows:50vh auto;height:auto;}
	}

	.map-wrap{position:relative;background:#111;}
	.map{width:100%;height:100%;}
	.no-map{
		display:flex;align-items:center;justify-content:center;height:100%;
		color:rgba(255,255,255,0.2);font-size:0.85rem;
	}

	.edit-hud{
		position:absolute;bottom:14px;left:50%;transform:translateX(-50%);
		background:rgba(0,0,0,0.72);backdrop-filter:blur(8px);
		border:1px solid rgba(255,255,255,0.1);
		border-radius:20px;padding:7px 14px;
		font-size:0.78rem;color:rgba(255,255,255,0.5);
		z-index:10;white-space:nowrap;
		display:flex;align-items:center;gap:10px;
	}
	.hud-active{color:#4ade80;}
	.hud-done{
		background:rgba(74,222,128,0.15);border:1px solid rgba(74,222,128,0.4);
		border-radius:10px;color:#4ade80;font-size:0.74rem;font-weight:600;
		padding:2px 9px;cursor:pointer;
	}

	aside.panel{
		background:rgba(255,255,255,0.02);
		border-left:1px solid rgba(255,255,255,0.07);
		overflow-y:auto;padding:16px;
		display:flex;flex-direction:column;gap:0;
	}
	.section{
		margin-bottom:16px;padding-bottom:16px;
		border-bottom:1px solid rgba(255,255,255,0.06);
	}
	.section:last-of-type{border-bottom:none;}
	.section h3{
		margin:0 0 6px;font-size:0.8rem;font-weight:700;color:#9ca3af;
		display:flex;align-items:center;gap:5px;
	}
	.sec-note{font-size:0.74rem;color:rgba(255,255,255,0.3);margin:0 0 8px;}
	.hint-text{font-size:0.68rem;color:#4b5563;margin:6px 0 0;line-height:1.5;}

	.edit-btns{display:flex;gap:6px;flex-wrap:wrap;}
	.edit-mode-btn{
		display:flex;align-items:center;gap:5px;
		background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.12);
		border-radius:8px;color:rgba(255,255,255,0.6);
		font-size:0.78rem;font-weight:600;padding:7px 10px;cursor:pointer;
		transition:all 0.15s;
	}
	.edit-mode-btn:hover{border-color:rgba(255,255,255,0.25);color:#e5e5e5;}
	.edit-mode-btn.active{
		border-color:rgba(74,222,128,0.5);color:#4ade80;
		background:rgba(74,222,128,0.08);
	}

	.spawn-list{list-style:none;margin:8px 0 0;padding:0;display:flex;flex-direction:column;gap:5px;}
	.spawn-item{
		display:flex;align-items:center;gap:6px;
		background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
		border-radius:8px;padding:7px 9px;
	}
	.spawn-num{
		width:20px;height:20px;border-radius:50%;
		color:#fff;font-size:10px;font-weight:700;
		display:flex;align-items:center;justify-content:center;flex-shrink:0;
	}
	.spawn-label{
		flex:1;background:transparent;border:none;outline:none;
		color:#e5e5e5;font-size:0.8rem;
		border-bottom:1px solid rgba(255,255,255,0.1);padding-bottom:1px;
	}
	.del-btn{
		background:transparent;border:none;color:rgba(255,255,255,0.2);
		cursor:pointer;padding:2px;display:flex;align-items:center;border-radius:4px;
	}
	.del-btn:hover{color:#ef4444;}

	.measure-btn{
		width:100%;padding:10px;
		background:rgba(96,165,250,0.08);border:1px solid rgba(96,165,250,0.3);
		border-radius:10px;color:#60a5fa;font-size:0.82rem;font-weight:600;
		cursor:pointer;transition:all 0.15s;
	}
	.measure-btn:hover{background:rgba(96,165,250,0.16);}
	.measuring{
		background:rgba(96,165,250,0.05);border:1px solid rgba(96,165,250,0.25);
		border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px;
	}
	.pulse{font-size:0.8rem;color:#60a5fa;font-weight:600;animation:pulse 1.2s ease-in-out infinite;}
	@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
	.stop-btn-m{
		background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.4);
		border-radius:8px;color:#4ade80;font-size:0.82rem;font-weight:700;
		padding:7px;cursor:pointer;
	}
	.measure-ok{font-size:0.78rem;color:#4ade80;margin:6px 0 0;}
	.manual-row{display:flex;align-items:center;gap:6px;margin-top:8px;}
	.num-input{
		width:70px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);
		border-radius:8px;color:#e5e5e5;font-size:0.9rem;padding:6px 8px;text-align:center;
	}
	.unit{font-size:0.74rem;color:#6b7280;}

	.error{font-size:0.8rem;color:#ef4444;margin:0;}

	.saving-screen{
		flex:1;display:flex;flex-direction:column;
		align-items:center;justify-content:center;gap:20px;
	}
	.spinner{
		width:40px;height:40px;border-radius:50%;
		border:3px solid rgba(255,255,255,0.1);border-top-color:#4ade80;
		animation:spin 0.8s linear infinite;
	}
	@keyframes spin{to{transform:rotate(360deg)}}
</style>
