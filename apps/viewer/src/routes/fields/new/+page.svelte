<script lang="ts">
	import { db, storage } from '$lib/firebase';
	import { collection, addDoc } from 'firebase/firestore';
	import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
	import {
		ArrowLeft, Smartphone, Image as ImageIcon, CheckCircle,
		Upload, Link, X, MapPin, Trash2, Sparkles, RotateCcw
	} from 'lucide-svelte';
	import type { SpawnPoint, VirtualPoint, ObstacleLine } from 'shared-types';
	import { goto } from '$app/navigation';

	// ── 基本情報 ────────────────────────────────────────────────────────
	let fieldName = $state('');

	// ── 画像 ─────────────────────────────────────────────────────────
	type ImageMode = 'none' | 'upload' | 'url';
	let imageMode = $state<ImageMode>('none');
	let uploadFile = $state<File | null>(null);
	let uploadPreview = $state(''); // data URL（アップロードプレビュー用）
	let mapImageUrl = $state('');   // URL入力
	let uploadProgress = $state(0);
	let uploading = $state(false);
	let dragOver = $state(false);
	let fileInput: HTMLInputElement;

	// 画像の自然サイズ（SVG viewBox 用）
	let imgNW = $state(1);
	let imgNH = $state(1);
	let imgEl: HTMLImageElement;

	function onFileSelect(e: Event) {
		const file = (e.target as HTMLInputElement).files?.[0];
		if (file) applyFile(file);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const file = e.dataTransfer?.files[0];
		if (file && file.type.startsWith('image/')) applyFile(file);
	}

	function applyFile(file: File) {
		uploadFile = file;
		mapImageUrl = '';
		imageMode = 'upload';
		spawnPoints = [];
		aiBoundary = [];
		aiObstacles = [];
		analyzeError = '';
		const reader = new FileReader();
		reader.onload = (e) => { uploadPreview = e.target?.result as string; };
		reader.readAsDataURL(file);
	}

	function clearImage() {
		uploadFile = null;
		uploadPreview = '';
		mapImageUrl = '';
		imageMode = 'none';
		uploadProgress = 0;
		spawnPoints = [];
		aiBoundary = [];
		aiObstacles = [];
		editMode = 'spawn';
	}

	function onImgLoad() {
		if (imgEl) {
			imgNW = imgEl.naturalWidth  || 1;
			imgNH = imgEl.naturalHeight || 1;
		}
	}

	const currentImageUrl = $derived(uploadPreview || mapImageUrl.trim());

	async function uploadToStorage(): Promise<string> {
		if (!uploadFile) return mapImageUrl;
		const ext = uploadFile.name.split('.').pop() ?? 'jpg';
		const path = `field-images/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
		const storageRef = ref(storage, path);
		return new Promise((resolve, reject) => {
			const task = uploadBytesResumable(storageRef, uploadFile!);
			task.on('state_changed',
				(snap) => { uploadProgress = (snap.bytesTransferred / snap.totalBytes) * 100; },
				reject,
				async () => { resolve(await getDownloadURL(task.snapshot.ref)); }
			);
		});
	}

	// ── AI解析 ────────────────────────────────────────────────────────
	let analyzing = $state(false);
	let analyzeError = $state('');
	let aiBoundary = $state<VirtualPoint[]>([]);
	let aiObstacles = $state<ObstacleLine[]>([]);

	async function analyzeImage() {
		if (!uploadFile || !uploadPreview) return;
		analyzing = true;
		analyzeError = '';
		try {
			// data URL から base64 部分だけ取り出す
			const base64 = uploadPreview.split(',')[1];
			const mimeType = uploadFile.type || 'image/jpeg';

			const res = await fetch('/api/analyze-field', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ imageBase64: base64, mimeType })
			});

			if (!res.ok) {
				const msg = await res.text();
				throw new Error(msg);
			}
			const data = await res.json();
			aiBoundary  = (data.boundary  ?? []) as VirtualPoint[];
			aiObstacles = (data.obstacles ?? []) as ObstacleLine[];
			editMode = 'boundary';
			if (aiBoundary.length === 0) {
				analyzeError = 'フィールドの外周を検出できませんでした。別の画像を試してください。';
			}
		} catch (e) {
			analyzeError = `AI解析に失敗しました: ${(e as Error).message}`;
			console.error(e);
		} finally {
			analyzing = false;
		}
	}

	// ── ポリゴン編集（ドラッグ） ───────────────────────────────────────
	type EditMode = 'spawn' | 'boundary';
	let editMode = $state<EditMode>('spawn');
	let draggingIdx = $state(-1);
	let boundarySvg: SVGSVGElement;

	function onBoundaryPtDown(e: PointerEvent, idx: number) {
		if (editMode !== 'boundary') return;
		e.stopPropagation();
		draggingIdx = idx;
		(e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId);
	}

	function onSvgMove(e: PointerEvent) {
		if (draggingIdx < 0) return;
		const rect = boundarySvg.getBoundingClientRect();
		const x = Math.max(0, Math.min(1, (e.clientX - rect.left)  / rect.width));
		const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
		aiBoundary = aiBoundary.map((pt, i) => i === draggingIdx ? { x, y } : pt);
	}

	function onSvgUp() { draggingIdx = -1; }

	function removeBoundaryPt(idx: number) {
		aiBoundary = aiBoundary.filter((_, i) => i !== idx);
	}

	// ── スポーン地点 ──────────────────────────────────────────────────
	let spawnPoints = $state<SpawnPoint[]>([]);
	let spawnMode = $state(false);

	function onImageClick(e: MouseEvent) {
		if (editMode !== 'spawn' || !spawnMode) return;
		const img = e.currentTarget as HTMLImageElement;
		const rect = img.getBoundingClientRect();
		const x = (e.clientX - rect.left) / rect.width;
		const y = (e.clientY - rect.top)  / rect.height;
		spawnPoints = [...spawnPoints, {
			id: `spawn-${Date.now()}`,
			label: `スポーン ${spawnPoints.length + 1}`,
			x, y
		}];
	}

	function removeSpawn(index: number) {
		spawnPoints = spawnPoints.filter((_, i) => i !== index);
	}

	function updateSpawnLabel(index: number, label: string) {
		spawnPoints = spawnPoints.map((sp, i) => i === index ? { ...sp, label } : sp);
	}

	// ── 保存 ──────────────────────────────────────────────────────────
	let saving = $state(false);
	let saved = $state(false);
	let savedName = $state('');
	let savedImageUrl = $state('');
	let savedFieldId = $state('');
	let creatingMatch = $state(false);

	async function save() {
		if (!fieldName.trim()) return;
		saving = true;
		try {
			let finalUrl = mapImageUrl.trim();
			if (uploadFile) {
				uploading = true;
				finalUrl = await uploadToStorage();
				uploading = false;
			}

			const data: Record<string, unknown> = {
				name: fieldName.trim(),
				boundary: [],
				createdAt: Date.now(),
			};

			if (finalUrl) data.mapImage = { url: finalUrl };

			if (spawnPoints.length >= 2) {
				data.spawnPoints = spawnPoints.map(({ id, label, x, y }) => ({ id, label, x, y }));
			}

			if (aiBoundary.length >= 3) {
				data.virtualBoundary = aiBoundary;
			}

			if (aiObstacles.length > 0) {
				data.obstacles = aiObstacles;
			}

			const docRef = await addDoc(collection(db, 'fields'), data);
			savedFieldId = docRef.id;
			savedName = fieldName.trim();
			savedImageUrl = finalUrl;
			saved = true;
		} catch (e) {
			console.error(e);
			alert('保存に失敗しました');
			uploading = false;
		} finally {
			saving = false;
		}
	}

	async function createMatchAndGo() {
		if (!savedFieldId) return;
		creatingMatch = true;
		try {
			const matchRef = await addDoc(collection(db, 'matches'), {
				fieldId: savedFieldId,
				createdAt: Date.now(),
				status: 'waiting'
			});
			await goto(`/${matchRef.id}`);
		} catch (e) {
			console.error(e);
			alert('試合の作成に失敗しました');
		} finally {
			creatingMatch = false;
		}
	}

	const canSave = $derived(fieldName.trim().length > 0);
</script>

<svelte:head>
	<title>フィールドを作成 – Sabage Tracker</title>
</svelte:head>

<div class="page">
	<header>
		<div class="header-inner">
			<a href="/" class="back-link"><ArrowLeft size={16} />試合一覧に戻る</a>
			<h1>フィールドを作成</h1>
			<div></div>
		</div>
	</header>

	<main>
		{#if saved}
			<!-- ── 保存完了 ── -->
			<div class="success-card">
				<CheckCircle size={40} color="#4ade80" />
				<h2>「{savedName}」を作成しました</h2>
				{#if savedImageUrl}
					<div class="saved-image-wrap">
						<img src={savedImageUrl} alt="マップ画像" class="saved-image" />
						<span class="saved-image-label">
							{#if aiBoundary.length >= 3}✓ 外周 {aiBoundary.length}点 ·{/if}
							{#if aiObstacles.length > 0} 障害物 {aiObstacles.length}件 ·{/if}
							{#if spawnPoints.length >= 2} スポーン {spawnPoints.length}点{/if}
							が登録されました
						</span>
					</div>
				{/if}
				<p>そのまま試合を作成するか、後から試合一覧で新規作成できます。</p>
				<div class="success-actions">
					<a href="/fields/{savedFieldId}/edit" class="edit-spawn-btn">
						📍 スポーン地点をマップ上で設定
					</a>
					<button class="create-match-btn" onclick={createMatchAndGo} disabled={creatingMatch}>
						{creatingMatch ? '作成中...' : '🎮 このフィールドで試合を作成'}
					</button>
				</div>
				<div class="success-secondary-actions">
					<button class="secondary-btn" onclick={() => {
						saved = false; fieldName = ''; mapImageUrl = '';
						spawnPoints = []; aiBoundary = []; aiObstacles = [];
					}}>
						続けて別のフィールドを作成
					</button>
					<a href="/" class="text-link">試合一覧に戻る</a>
				</div>
			</div>
		{:else}
			<div class="form-layout">
				<!-- ── フォーム ── -->
				<div class="form-card">

					<!-- フィールド名 -->
					<section class="form-section">
						<h2>基本設定</h2>
						<label>
							<span class="label-text">フィールド名 <span class="required">*</span></span>
							<input class="input" type="text" bind:value={fieldName}
								placeholder="例: 山田フィールド 北エリア" maxlength="40" />
						</label>
					</section>

					<!-- マップ画像 -->
					<section class="form-section">
						<h2><ImageIcon size={16} />マップ画像<span class="optional">任意</span></h2>
						<p class="section-desc">
							フィールドの図面や見取り図を設定すると、AI が外周・障害物を自動検出できます。
						</p>

						{#if imageMode === 'none'}
							<div class="image-mode-btns">
								<button class="mode-btn" onclick={() => imageMode = 'upload'}>
									<Upload size={16} />画像をアップロード
								</button>
								<button class="mode-btn" onclick={() => imageMode = 'url'}>
									<Link size={16} />URLで指定
								</button>
							</div>
						{:else}
							<div class="image-source">
								<div class="image-source-header">
									<span class="image-source-label">
										{imageMode === 'upload' ? '📁 ファイルアップロード' : '🔗 URL指定'}
									</span>
									<button class="clear-btn" onclick={clearImage}><X size={13} />変更</button>
								</div>

								{#if imageMode === 'upload'}
									{#if !uploadPreview}
										<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
										<div class="dropzone" class:drag-over={dragOver}
											onclick={() => fileInput.click()}
											ondragover={(e) => { e.preventDefault(); dragOver = true; }}
											ondragleave={() => dragOver = false}
											ondrop={onDrop}>
											<Upload size={24} />
											<p>クリックまたはドラッグ&ドロップ</p>
											<span>PNG, JPG, WebP など (最大 10MB)</span>
										</div>
										<input bind:this={fileInput} type="file" accept="image/*"
											style="display:none" onchange={onFileSelect} />
									{:else}
										<span class="file-name">{uploadFile?.name}</span>
										{#if uploading}
											<div class="progress-bar">
												<div class="progress-fill" style="width:{uploadProgress}%"></div>
											</div>
										{/if}
									{/if}
								{:else}
									<input class="input" type="url" bind:value={mapImageUrl} placeholder="https://..." />
								{/if}
							</div>
						{/if}

						<!-- 画像プレビュー + AI解析 + 編集オーバーレイ -->
						{#if currentImageUrl}
							<!-- AI解析ボタン -->
							{#if imageMode === 'upload' && uploadFile}
								<div class="ai-bar">
									<button class="ai-btn" onclick={analyzeImage} disabled={analyzing}>
										{#if analyzing}
											<span class="spinner"></span>解析中...
										{:else}
											<Sparkles size={14} />AI で外周・障害物を検出
										{/if}
									</button>
									{#if aiBoundary.length > 0}
										<button class="reanalyze-btn" onclick={analyzeImage} disabled={analyzing} title="再解析">
											<RotateCcw size={13} />
										</button>
									{/if}
								</div>
								{#if analyzeError}
									<p class="analyze-error">{analyzeError}</p>
								{/if}
							{/if}

							<!-- モード切り替え -->
							{#if aiBoundary.length > 0}
								<div class="mode-tabs">
									<button class="mode-tab" class:active={editMode === 'boundary'}
										onclick={() => { editMode = 'boundary'; spawnMode = false; }}>
										🗺 外周・障害物を修正
									</button>
									<button class="mode-tab" class:active={editMode === 'spawn'}
										onclick={() => editMode = 'spawn'}>
										📍 スポーン地点を設定
									</button>
								</div>
							{/if}

							<!-- 画像 + オーバーレイ -->
							<div class="map-img-container">
								<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
								<img
									bind:this={imgEl}
									src={currentImageUrl}
									alt="フィールドマップ"
									class="map-img"
									class:spawn-cursor={editMode === 'spawn' && spawnMode}
									onclick={onImageClick}
									onload={onImgLoad}
									onerror={(e) => (e.currentTarget as HTMLImageElement).style.display='none'}
								/>

								<!-- 境界線・障害物 SVG オーバーレイ -->
								{#if aiBoundary.length > 0 || aiObstacles.length > 0}
									<svg
										bind:this={boundarySvg}
										class="boundary-svg"
										class:interactive={editMode === 'boundary'}
										viewBox="0 0 {imgNW} {imgNH}"
										preserveAspectRatio="none"
										onpointermove={onSvgMove}
										onpointerup={onSvgUp}
										onpointerleave={onSvgUp}
									>
										<!-- 障害物（黄色線） -->
										{#each aiObstacles as obs}
											<polyline
												points={obs.points.map(p => `${p.x * imgNW},${p.y * imgNH}`).join(' ')}
												fill="none"
												stroke="rgba(251,191,36,0.85)"
												stroke-width={imgNW * 0.006}
												stroke-linecap="round"
												stroke-linejoin="round"
											/>
										{/each}

										<!-- 外周ポリゴン（緑） -->
										{#if aiBoundary.length >= 3}
											<polygon
												points={aiBoundary.map(p => `${p.x * imgNW},${p.y * imgNH}`).join(' ')}
												fill="rgba(74,222,128,0.12)"
												stroke="#4ade80"
												stroke-width={imgNW * 0.005}
											/>
										{/if}

										<!-- ドラッグハンドル（境界修正モードのみ） -->
										{#if editMode === 'boundary'}
											{#each aiBoundary as pt, i}
												<circle
													cx={pt.x * imgNW}
													cy={pt.y * imgNH}
													r={imgNW * 0.022}
													fill="#4ade80"
													stroke="white"
													stroke-width={imgNW * 0.005}
													style="cursor:grab;touch-action:none"
													onpointerdown={(e) => onBoundaryPtDown(e, i)}
												/>
											{/each}
										{/if}
									</svg>
								{/if}

								<!-- スポーンピン（HTML - 常に表示） -->
								{#each spawnPoints as sp, i}
									<div class="spawn-pin" style="left:{sp.x*100}%;top:{sp.y*100}%">{i+1}</div>
								{/each}
							</div>

							<!-- 境界線修正モードのコントロール -->
							{#if editMode === 'boundary' && aiBoundary.length > 0}
								<div class="boundary-controls">
									<span class="boundary-info">
										✓ {aiBoundary.length}点の外周
										{#if aiObstacles.length > 0}· 障害物 {aiObstacles.length}件{/if}
									</span>
									<span class="boundary-hint">ドラッグで頂点を移動できます</span>
								</div>
								{#if aiBoundary.length > 3}
									<div class="pt-list">
										{#each aiBoundary as _, i}
											<button class="pt-del-btn" onclick={() => removeBoundaryPt(i)} title="点 {i+1} を削除">
												{i+1}<X size={9} />
											</button>
										{/each}
									</div>
								{/if}
							{/if}

							<!-- スポーン地点セクション（スポーンモード or 境界なし） -->
							{#if editMode === 'spawn' || aiBoundary.length === 0}
								<div class="spawn-section">
									<div class="spawn-section-header">
										<div class="spawn-section-title">
											<MapPin size={14} />
											<span>スポーン地点</span>
											<span class="optional">任意 — 仮想マップ使用時に必要</span>
										</div>
										<button class="spawn-mode-btn" class:active={spawnMode}
											onclick={() => spawnMode = !spawnMode}>
											{spawnMode ? '✓ ピン追加中' : '+ ピンを追加'}
										</button>
									</div>
									{#if spawnMode}
										<p class="spawn-hint">画像上をクリックしてスポーン地点を追加</p>
									{/if}
									{#if spawnPoints.length > 0}
										<div class="spawn-list">
											{#each spawnPoints as sp, i}
												<div class="spawn-list-item">
													<span class="spawn-pin-num">{i+1}</span>
													<input class="input spawn-label-input" type="text"
														value={sp.label}
														oninput={(e) => updateSpawnLabel(i, (e.target as HTMLInputElement).value)}
														placeholder="例: チームAスポーン" maxlength="20" />
													<button class="delete-spawn-btn" onclick={() => removeSpawn(i)}>
														<Trash2 size={13} />
													</button>
												</div>
											{/each}
										</div>
										{#if spawnPoints.length < 2}
											<p class="spawn-warn">仮想マップを使うには2点以上必要です</p>
										{:else}
											<p class="spawn-ok">✓ {spawnPoints.length} 点設定済み</p>
										{/if}
									{:else}
										<p class="spawn-empty">スポーン地点が設定されていません（スキップ可）</p>
									{/if}
								</div>
							{/if}
						{/if}
					</section>

					<button class="save-btn" onclick={save} disabled={saving || !canSave}>
						{saving ? '作成中...' : 'フィールドを作成'}
					</button>
				</div>

				<!-- 説明カード -->
				<div class="info-card">
					<div class="info-header"><Smartphone size={18} /><h3>セットアップの流れ</h3></div>
					<ol class="how-to">
						<li>
							<span class="how-num">1</span>
							<div>
								<strong>このページでフィールドを作成</strong>
								<p>マップ画像をアップロードして「AI で検出」を押すと外周・障害物が自動認識されます。点をドラッグして修正できます。</p>
							</div>
						</li>
						<li>
							<span class="how-num">2</span>
							<div>
								<strong>スポーン地点を2点以上設定</strong>
								<p>画像上の各スポーン位置をクリック。当日GPS と対応させることで仮想マップが有効になります。</p>
							</div>
						</li>
						<li>
							<span class="how-num">3</span>
							<div>
								<strong>tracker で外周をスキャン（任意）</strong>
								<p>GPS境界線を使う場合は管理者モードで外周を歩いて登録します。</p>
							</div>
						</li>
						<li>
							<span class="how-num">4</span>
							<div>
								<strong>試合当日：スポーンでGPS記録</strong>
								<p>各プレイヤーが tracker で自分のスポーンに立ってGPSを記録すると仮想マップに位置が表示されます。</p>
							</div>
						</li>
					</ol>
					<div class="info-note">
						AIは図面・見取り図・航空写真などに対応しています。<br>
						GEMINI_API_KEY を .env に設定してください。
					</div>
				</div>
			</div>
		{/if}
	</main>
</div>

<style>
	:global(body) {
		margin: 0; padding: 0;
		background: #0a0a0a; color: #e5e5e5;
		font-family: 'Inter', system-ui, -apple-system, sans-serif;
		min-height: 100vh;
	}
	.page { min-height: 100vh; }

	header {
		border-bottom: 1px solid rgba(255,255,255,0.07);
		background: rgba(15,15,15,0.97);
		position: sticky; top: 0; z-index: 10;
	}
	.header-inner {
		max-width: 900px; margin: 0 auto; padding: 14px 20px;
		display: grid; grid-template-columns: 1fr auto 1fr; align-items: center;
	}
	.back-link {
		display: flex; align-items: center; gap: 6px;
		color: rgba(255,255,255,0.4); text-decoration: none;
		font-size: 0.85rem; transition: color 0.15s;
	}
	.back-link:hover { color: #fff; }
	h1 { margin: 0; font-size: 1rem; font-weight: 600; text-align: center; letter-spacing: -0.02em; }

	main { max-width: 900px; margin: 0 auto; padding: 32px 20px 60px; }

	.form-layout {
		display: grid; grid-template-columns: 1fr 340px; gap: 24px; align-items: start;
	}
	@media (max-width: 720px) { .form-layout { grid-template-columns: 1fr; } }

	.form-card {
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px; padding: 28px;
		display: flex; flex-direction: column; gap: 28px;
	}
	.form-section { display: flex; flex-direction: column; gap: 12px; }
	.form-section h2 {
		margin: 0; font-size: 0.9rem; font-weight: 600;
		display: flex; align-items: center; gap: 6px; color: #e5e5e5;
	}
	.optional { font-weight: 400; font-size: 0.75rem; color: rgba(255,255,255,0.3); }
	.required { color: #ef4444; }
	.section-desc { font-size: 0.8rem; color: rgba(255,255,255,0.35); margin: 0; line-height: 1.6; }

	label { display: flex; flex-direction: column; gap: 6px; }
	.label-text { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: rgba(255,255,255,0.4); }
	.input {
		background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
		border-radius: 8px; color: #e5e5e5; font-size: 0.875rem; padding: 10px 12px;
		outline: none; transition: border-color 0.15s; width: 100%; box-sizing: border-box;
	}
	.input:focus { border-color: rgba(255,255,255,0.25); }

	/* 画像入力 */
	.image-mode-btns { display: flex; gap: 10px; }
	.mode-btn {
		flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
		padding: 12px; background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.1); border-radius: 10px;
		color: rgba(255,255,255,0.55); font-size: 0.83rem; cursor: pointer; transition: all 0.15s;
	}
	.mode-btn:hover { background: rgba(255,255,255,0.08); color: #e5e5e5; border-color: rgba(255,255,255,0.2); }
	.image-source { display: flex; flex-direction: column; gap: 10px; }
	.image-source-header { display: flex; align-items: center; justify-content: space-between; }
	.image-source-label { font-size: 0.78rem; color: rgba(255,255,255,0.4); }
	.clear-btn {
		display: flex; align-items: center; gap: 4px;
		background: transparent; border: 1px solid rgba(255,255,255,0.1);
		border-radius: 6px; color: rgba(255,255,255,0.35); font-size: 0.75rem;
		padding: 3px 8px; cursor: pointer; transition: all 0.15s;
	}
	.clear-btn:hover { color: #fff; border-color: rgba(255,255,255,0.25); }
	.dropzone {
		border: 1.5px dashed rgba(255,255,255,0.15); border-radius: 10px; padding: 32px 20px;
		display: flex; flex-direction: column; align-items: center; gap: 8px;
		cursor: pointer; color: rgba(255,255,255,0.3); transition: all 0.15s; text-align: center;
	}
	.dropzone:hover, .dropzone.drag-over { border-color: #4ade80; background: rgba(74,222,128,0.05); color: #4ade80; }
	.dropzone p { margin: 0; font-size: 0.85rem; }
	.dropzone span { font-size: 0.75rem; }
	.file-name { font-size: 0.75rem; color: rgba(255,255,255,0.35); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.progress-bar { height: 4px; background: rgba(255,255,255,0.08); border-radius: 2px; overflow: hidden; }
	.progress-fill { height: 100%; background: #4ade80; border-radius: 2px; transition: width 0.2s; }

	/* AI解析 */
	.ai-bar { display: flex; align-items: center; gap: 8px; }
	.ai-btn {
		flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
		padding: 10px 16px;
		background: linear-gradient(135deg, rgba(139,92,246,0.2), rgba(74,222,128,0.15));
		border: 1px solid rgba(139,92,246,0.4); border-radius: 10px;
		color: #c4b5fd; font-size: 0.85rem; font-weight: 600; cursor: pointer; transition: all 0.15s;
	}
	.ai-btn:hover:not(:disabled) { background: linear-gradient(135deg, rgba(139,92,246,0.3), rgba(74,222,128,0.2)); }
	.ai-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.reanalyze-btn {
		padding: 8px; background: transparent;
		border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
		color: rgba(255,255,255,0.4); cursor: pointer; display: flex; align-items: center; transition: all 0.15s;
	}
	.reanalyze-btn:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
	.reanalyze-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.analyze-error { font-size: 0.78rem; color: #f87171; margin: 0; }
	.spinner {
		width: 14px; height: 14px; border: 2px solid rgba(196,181,253,0.3);
		border-top-color: #c4b5fd; border-radius: 50%;
		animation: spin 0.7s linear infinite; flex-shrink: 0;
	}
	@keyframes spin { to { transform: rotate(360deg); } }

	/* モードタブ */
	.mode-tabs { display: flex; gap: 6px; }
	.mode-tab {
		flex: 1; padding: 7px 10px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
		border-radius: 8px; color: rgba(255,255,255,0.45); font-size: 0.78rem;
		cursor: pointer; transition: all 0.15s; white-space: nowrap;
	}
	.mode-tab:hover { background: rgba(255,255,255,0.08); color: #e5e5e5; }
	.mode-tab.active {
		background: rgba(74,222,128,0.12); border-color: rgba(74,222,128,0.4); color: #4ade80; font-weight: 600;
	}

	/* 画像コンテナ */
	.map-img-container { position: relative; width: 100%; line-height: 0; }
	.map-img {
		width: 100%; height: auto; display: block;
		border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);
		background: rgba(255,255,255,0.03);
	}
	.map-img.spawn-cursor { cursor: crosshair; border-color: rgba(74,222,128,0.5); }

	/* SVGオーバーレイ */
	.boundary-svg {
		position: absolute; top: 0; left: 0; width: 100%; height: 100%;
		pointer-events: none; border-radius: 8px;
	}
	.boundary-svg.interactive { pointer-events: all; cursor: default; }

	/* スポーンピン（HTML） */
	.spawn-pin {
		position: absolute; transform: translate(-50%, -50%);
		width: 22px; height: 22px;
		background: #4ade80; border: 2px solid #fff; border-radius: 50%;
		color: #000; font-size: 10px; font-weight: 700;
		display: flex; align-items: center; justify-content: center;
		pointer-events: none; box-shadow: 0 2px 6px rgba(0,0,0,0.5);
	}

	/* 境界線コントロール */
	.boundary-controls {
		display: flex; align-items: center; justify-content: space-between; gap: 8px;
		font-size: 0.75rem;
	}
	.boundary-info { color: #4ade80; font-weight: 600; }
	.boundary-hint { color: rgba(255,255,255,0.3); }
	.pt-list { display: flex; flex-wrap: wrap; gap: 5px; }
	.pt-del-btn {
		display: flex; align-items: center; gap: 3px; padding: 3px 7px;
		background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
		border-radius: 6px; color: rgba(255,255,255,0.4); font-size: 0.72rem; cursor: pointer;
		transition: all 0.15s;
	}
	.pt-del-btn:hover { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.3); color: #f87171; }

	/* スポーン地点 */
	.spawn-section {
		background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.07);
		border-radius: 12px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
	}
	.spawn-section-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
	.spawn-section-title { display: flex; align-items: center; gap: 6px; font-size: 0.82rem; font-weight: 600; color: rgba(255,255,255,0.7); }
	.spawn-mode-btn {
		padding: 5px 12px; background: rgba(74,222,128,0.08);
		border: 1px solid rgba(74,222,128,0.25); border-radius: 8px;
		color: #4ade80; font-size: 0.78rem; font-weight: 600; cursor: pointer; transition: all 0.15s; flex-shrink: 0;
	}
	.spawn-mode-btn:hover { background: rgba(74,222,128,0.15); }
	.spawn-mode-btn.active { background: rgba(74,222,128,0.2); border-color: #4ade80; }
	.spawn-hint { font-size: 0.75rem; color: #4ade80; margin: 0; text-align: center; }
	.spawn-list { display: flex; flex-direction: column; gap: 6px; }
	.spawn-list-item { display: flex; align-items: center; gap: 8px; }
	.spawn-pin-num {
		width: 20px; height: 20px; background: #4ade80; border-radius: 50%;
		color: #000; font-size: 10px; font-weight: 700;
		display: flex; align-items: center; justify-content: center; flex-shrink: 0;
	}
	.spawn-label-input { flex: 1; padding: 7px 10px; font-size: 0.8rem; }
	.delete-spawn-btn {
		background: transparent; border: none; color: rgba(255,255,255,0.3);
		cursor: pointer; padding: 4px; display: flex; align-items: center; transition: color 0.15s; flex-shrink: 0;
	}
	.delete-spawn-btn:hover { color: #ef4444; }
	.spawn-warn { font-size: 0.75rem; color: #facc15; margin: 0; }
	.spawn-ok { font-size: 0.75rem; color: #4ade80; margin: 0; }
	.spawn-empty { font-size: 0.75rem; color: rgba(255,255,255,0.25); margin: 0; text-align: center; padding: 8px 0; }

	/* 保存ボタン */
	.save-btn {
		padding: 13px; background: #4ade80; color: #000;
		border: none; border-radius: 10px; font-size: 0.9rem; font-weight: 700; cursor: pointer; transition: opacity 0.15s;
	}
	.save-btn:disabled { opacity: 0.35; cursor: not-allowed; }
	.save-btn:not(:disabled):hover { opacity: 0.85; }

	/* インフォカード */
	.info-card {
		background: rgba(74,222,128,0.04); border: 1px solid rgba(74,222,128,0.15);
		border-radius: 16px; padding: 24px; display: flex; flex-direction: column; gap: 16px;
	}
	.info-header { display: flex; align-items: center; gap: 8px; color: #4ade80; }
	.info-header h3 { margin: 0; font-size: 0.95rem; font-weight: 600; }
	.how-to { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
	.how-to li { display: flex; gap: 12px; align-items: flex-start; }
	.how-num {
		width: 22px; height: 22px; border-radius: 50%;
		background: rgba(74,222,128,0.15); border: 1px solid rgba(74,222,128,0.3);
		color: #4ade80; font-size: 11px; font-weight: 700;
		display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px;
	}
	.how-to strong { display: block; font-size: 0.82rem; color: #e5e5e5; margin-bottom: 2px; }
	.how-to p { font-size: 0.75rem; color: rgba(255,255,255,0.35); margin: 0; line-height: 1.5; }
	.info-note {
		font-size: 0.75rem; color: rgba(255,255,255,0.25);
		border-top: 1px solid rgba(255,255,255,0.05); padding-top: 14px; line-height: 1.6;
	}

	/* 保存完了 */
	.success-card {
		max-width: 520px; margin: 60px auto 0; text-align: center;
		display: flex; flex-direction: column; align-items: center; gap: 16px;
	}
	.success-card h2 { margin: 0; font-size: 1.2rem; font-weight: 600; }
	.saved-image-wrap { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 8px; }
	.saved-image { width: 100%; max-height: 220px; object-fit: contain; border-radius: 10px; border: 1px solid rgba(255,255,255,0.08); background: rgba(255,255,255,0.03); }
	.saved-image-label { font-size: 0.75rem; color: rgba(74,222,128,0.7); }
	.success-card > p { color: rgba(255,255,255,0.45); font-size: 0.9rem; margin: 0; line-height: 1.7; }
	.success-actions { display: flex; flex-direction: column; align-items: stretch; gap: 10px; margin-top: 8px; width: 100%; max-width: 340px; }
	.edit-spawn-btn {
		display: block; padding: 13px 24px;
		background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.4);
		border-radius: 10px; color: #4ade80; font-size: 0.9rem; font-weight: 700;
		text-decoration: none; text-align: center; transition: all 0.15s;
	}
	.edit-spawn-btn:hover { background: rgba(74,222,128,0.18); }
	.create-match-btn {
		padding: 13px 24px; background: rgba(255,255,255,0.06); color: #e5e5e5;
		border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; font-size: 0.9rem; font-weight: 700; cursor: pointer; transition: all 0.15s;
	}
	.create-match-btn:disabled { opacity: 0.5; cursor: not-allowed; }
	.create-match-btn:not(:disabled):hover { opacity: 0.85; }
	.success-secondary-actions { display: flex; align-items: center; gap: 16px; }
	.secondary-btn {
		padding: 10px 16px; background: transparent;
		border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
		color: rgba(255,255,255,0.5); font-size: 0.82rem; cursor: pointer; transition: all 0.15s;
	}
	.secondary-btn:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
	.text-link {
		color: rgba(255,255,255,0.3); font-size: 0.82rem; text-decoration: underline; text-underline-offset: 3px; transition: color 0.15s;
	}
	.text-link:hover { color: rgba(255,255,255,0.6); }
</style>
