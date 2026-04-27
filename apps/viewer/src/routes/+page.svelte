<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { db } from '$lib/firebase';
	import { collection, onSnapshot, orderBy, query, addDoc, getDocs, deleteDoc, doc } from 'firebase/firestore';
	import type { Match, Field } from 'shared-types';
	import { Play, Clock, CheckCircle, PlusCircle, MapPin, Trash2 } from 'lucide-svelte';

	let matches = $state<(Match & { id: string })[]>([]);
	let fields = $state<(Field & { id: string })[]>([]);
	// fieldId → field名 のキャッシュ
	let fieldNameMap = $state<Record<string, string>>({});
	let loading = $state(true);
	let unsubscribe: () => void;

	// 新規試合作成用
	let showCreateModal = $state(false);
	let selectedFieldId = $state('');
	let creating = $state(false);
	let loadingFields = $state(false);

	// 削除確認
	let deleteTargetId = $state<string | null>(null);
	let deleting = $state(false);

	onMount(async () => {
		// フィールド名マップを先読み
		try {
			const snap = await getDocs(collection(db, 'fields'));
			const map: Record<string, string> = {};
			snap.docs.forEach(d => { map[d.id] = (d.data().name as string) || d.id; });
			fieldNameMap = map;
		} catch (e) {
			console.warn('Failed to load field names:', e);
		}

		const q = query(collection(db, 'matches'), orderBy('createdAt', 'desc'));
		unsubscribe = onSnapshot(q, (snapshot) => {
			matches = snapshot.docs.map(d => ({
				id: d.id,
				...d.data()
			} as Match & { id: string }));
			loading = false;
		}, () => {
			loading = false;
		});
	});

	async function confirmDelete() {
		if (!deleteTargetId) return;
		deleting = true;
		try {
			await deleteDoc(doc(db, 'matches', deleteTargetId));
		} catch (e) {
			console.error('Delete failed:', e);
		} finally {
			deleting = false;
			deleteTargetId = null;
		}
	}

	onDestroy(() => {
		if (unsubscribe) unsubscribe();
	});

	async function openCreateModal() {
		showCreateModal = true;
		selectedFieldId = '';
		loadingFields = true;
		try {
			const snap = await getDocs(collection(db, 'fields'));
			fields = snap.docs.map(d => ({ id: d.id, ...d.data() } as Field & { id: string }));
		} catch (e) {
			console.error(e);
		} finally {
			loadingFields = false;
		}
	}

	async function createMatch() {
		if (!selectedFieldId) return;
		creating = true;
		try {
			await addDoc(collection(db, 'matches'), {
				fieldId: selectedFieldId,
				createdAt: Date.now(),
				status: 'waiting'
			});
			showCreateModal = false;
		} catch (e) {
			console.error(e);
		} finally {
			creating = false;
		}
	}

	const statusConfig: Record<string, { label: string; color: string }> = {
		waiting:  { label: '待機中', color: '#facc15' },
		playing:  { label: '試合中', color: '#4ade80' },
		finished: { label: '終了',   color: '#6b7280' }
	};

	function formatDate(ts: number) {
		if (!ts) return '';
		return new Date(ts).toLocaleString('ja-JP', {
			month: 'short', day: 'numeric',
			hour: '2-digit', minute: '2-digit'
		});
	}
</script>

<svelte:head>
	<title>Sabage Tracker</title>
</svelte:head>

<div class="page">
	<header>
		<div class="header-inner">
			<div class="logo">
				<span class="dot"></span>
				<h1>Sabage Tracker</h1>
			</div>
			<nav class="nav">
				<a href="/fields/new" class="nav-link">
					<MapPin size={14} />
					フィールド作成
				</a>
				<button class="create-btn" onclick={openCreateModal}>
					<PlusCircle size={16} />
					新規試合
				</button>
			</nav>
		</div>
	</header>

	<main>
		{#if loading}
			<div class="empty">
				<p class="muted">読み込み中...</p>
			</div>
		{:else if matches.length === 0}
			<div class="empty">
				<p class="muted">試合データがありません</p>
				<p class="muted small">
					まず「フィールド作成」でフィールドを登録してから「新規試合」を作成してください
				</p>
				<a href="/fields/new" class="empty-cta">フィールドを作成する →</a>
			</div>
		{:else}
			<ul class="match-list">
				{#each matches as match}
					{@const cfg = statusConfig[match.status] ?? statusConfig.finished}
					<li class="match-card">
						<div class="card-left">
							<div class="status-badge" style="--c: {cfg.color}">
								{#if match.status === 'playing'}
									<Play size={11} fill={cfg.color} />
								{:else if match.status === 'waiting'}
									<Clock size={11} />
								{:else}
									<CheckCircle size={11} />
								{/if}
								{cfg.label}
							</div>
							<div class="match-info">
								<span class="match-id">{match.id}</span>
								<span class="field-id muted">
									<MapPin size={10} />
									{fieldNameMap[match.fieldId] ?? match.fieldId}
								</span>
							</div>
							<span class="date muted">{formatDate(match.createdAt)}</span>
						</div>
						<div class="card-actions">
							<button
								class="delete-btn"
								onclick={() => deleteTargetId = match.id}
								title="削除"
							>
								<Trash2 size={14} />
							</button>
							<a class="replay-btn" href="/{match.id}">
								<Play size={14} fill="currentColor" />
								リプレイ
							</a>
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</main>
</div>

<!-- 削除確認モーダル -->
{#if deleteTargetId}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => deleteTargetId = null}>
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<h2>試合を削除</h2>
			<p class="modal-desc">この試合データを削除しますか？この操作は取り消せません。</p>
			<p class="delete-target-id">{deleteTargetId}</p>
			<div class="modal-actions">
				<button class="cancel-btn" onclick={() => deleteTargetId = null} disabled={deleting}>
					キャンセル
				</button>
				<button class="delete-confirm-btn" onclick={confirmDelete} disabled={deleting}>
					{deleting ? '削除中...' : '削除する'}
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- 新規試合モーダル -->
{#if showCreateModal}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => showCreateModal = false}>
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<h2>新規試合を作成</h2>
			<p class="modal-desc">使用するフィールドを選択してください</p>

			{#if loadingFields}
				<div class="field-loading">読み込み中...</div>
			{:else if fields.length === 0}
				<div class="no-fields">
					<p>登録済みのフィールドがありません。</p>
					<a href="/fields/new" class="create-field-link">
						<MapPin size={14} />
						フィールドを作成する
					</a>
				</div>
			{:else}
				<ul class="field-list">
					{#each fields as field}
						<li>
							<button
								class="field-card"
								class:selected={selectedFieldId === field.id}
								onclick={() => selectedFieldId = field.id ?? ''}
							>
								<div class="field-icon">
									<MapPin size={16} />
								</div>
								<div class="field-info">
									<span class="field-name">{field.name}</span>
									<span class="field-meta">
										{#if field.mapImage?.url}
											🗺 仮想マップあり{field.spawnPoints && field.spawnPoints.length >= 2 ? ` · スポーン ${field.spawnPoints.length}点` : ' · スポーン未設定'}
										{:else if field.boundary.length > 0}
											📍 GPS境界線 {field.boundary.length}点
										{:else}
											マップ未設定
										{/if}
									</span>
								</div>
								{#if selectedFieldId === field.id}
									<span class="check">✓</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>

				{#if selectedFieldId}
					{@const sel = fields.find(f => f.id === selectedFieldId)}
					{#if sel?.mapImage?.url && (!sel.spawnPoints || sel.spawnPoints.length < 2)}
						<a href="/fields/{selectedFieldId}/edit" class="setup-spawn-link">
							<MapPin size={13} />
							スポーン地点を設定してから試合を作成する（推奨）
						</a>
					{/if}
				{/if}

				<a href="/fields/new" class="add-field-link">
					<PlusCircle size={13} />
					新しいフィールドを作成
				</a>
			{/if}

			<div class="modal-actions">
				<button class="cancel-btn" onclick={() => showCreateModal = false}>キャンセル</button>
				<button
					class="confirm-btn"
					onclick={createMatch}
					disabled={creating || !selectedFieldId}
				>
					{creating ? '作成中...' : '試合を作成'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		background: #0a0a0a;
		color: #e5e5e5;
		font-family: 'Inter', system-ui, -apple-system, sans-serif;
		min-height: 100vh;
	}

	.page { min-height: 100vh; }

	header {
		border-bottom: 1px solid rgba(255,255,255,0.07);
		background: rgba(15,15,15,0.95);
		backdrop-filter: blur(10px);
		position: sticky;
		top: 0;
		z-index: 10;
	}

	.header-inner {
		max-width: 720px;
		margin: 0 auto;
		padding: 18px 20px;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.logo {
		display: flex;
		align-items: center;
		gap: 10px;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: #4ade80;
		box-shadow: 0 0 8px #4ade80;
	}

	h1 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 700;
		letter-spacing: -0.02em;
	}

	.nav {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.nav-link {
		display: flex;
		align-items: center;
		gap: 5px;
		color: rgba(255,255,255,0.4);
		text-decoration: none;
		font-size: 0.82rem;
		padding: 7px 12px;
		border-radius: 8px;
		border: 1px solid transparent;
		transition: all 0.15s;
	}
	.nav-link:hover {
		color: #e5e5e5;
		border-color: rgba(255,255,255,0.1);
		background: rgba(255,255,255,0.05);
	}

	.create-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		background: rgba(255,255,255,0.06);
		color: #e5e5e5;
		border: 1px solid rgba(255,255,255,0.12);
		padding: 8px 14px;
		border-radius: 8px;
		font-size: 0.85rem;
		cursor: pointer;
		transition: background 0.15s;
	}
	.create-btn:hover { background: rgba(255,255,255,0.1); }

	main {
		max-width: 720px;
		margin: 0 auto;
		padding: 32px 20px;
	}

	.empty {
		text-align: center;
		padding: 80px 0;
	}

	.muted {
		color: rgba(255,255,255,0.35);
		margin: 0 0 6px;
	}

	.small { font-size: 0.85rem; }

	.empty-cta {
		display: inline-block;
		margin-top: 20px;
		color: #4ade80;
		text-decoration: none;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.match-list {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.match-card {
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 12px;
		padding: 16px 20px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		transition: border-color 0.15s, background 0.15s;
	}
	.match-card:hover {
		background: rgba(255,255,255,0.05);
		border-color: rgba(255,255,255,0.15);
	}

	.card-left {
		display: flex;
		align-items: center;
		gap: 14px;
		flex: 1;
		min-width: 0;
	}

	.status-badge {
		display: flex;
		align-items: center;
		gap: 4px;
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--c);
		background: color-mix(in srgb, var(--c) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--c) 30%, transparent);
		padding: 3px 8px;
		border-radius: 20px;
		white-space: nowrap;
	}

	.match-info {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.match-id {
		font-size: 0.9rem;
		font-weight: 500;
		font-family: 'SF Mono', 'Fira Code', monospace;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.field-id {
		font-size: 0.78rem;
		display: flex;
		align-items: center;
		gap: 3px;
	}

	.date {
		font-size: 0.78rem;
		white-space: nowrap;
		margin-left: auto;
	}

	.replay-btn {
		display: flex;
		align-items: center;
		gap: 6px;
		background: #4ade80;
		color: #000;
		text-decoration: none;
		padding: 8px 14px;
		border-radius: 8px;
		font-size: 0.82rem;
		font-weight: 700;
		white-space: nowrap;
		transition: opacity 0.15s;
	}
	.replay-btn:hover { opacity: 0.85; }

	.card-actions {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.delete-btn {
		background: transparent;
		border: 1px solid transparent;
		color: rgba(255,255,255,0.2);
		padding: 6px 8px;
		border-radius: 7px;
		cursor: pointer;
		display: flex;
		align-items: center;
		transition: all 0.15s;
	}
	.delete-btn:hover {
		color: #ef4444;
		border-color: rgba(239,68,68,0.3);
		background: rgba(239,68,68,0.08);
	}

	.delete-target-id {
		font-family: 'SF Mono', 'Fira Code', monospace;
		font-size: 0.8rem;
		color: rgba(255,255,255,0.4);
		background: rgba(255,255,255,0.04);
		border-radius: 6px;
		padding: 8px 12px;
		margin: 0 0 16px;
		word-break: break-all;
	}

	.delete-confirm-btn {
		background: #ef4444;
		color: #fff;
		border: none;
		padding: 8px 20px;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 700;
		transition: opacity 0.15s;
	}
	.delete-confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.delete-confirm-btn:not(:disabled):hover { opacity: 0.85; }

	/* モーダル */
	.modal-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0,0,0,0.75);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 100;
		backdrop-filter: blur(4px);
	}

	.modal {
		background: #1a1a1a;
		border: 1px solid rgba(255,255,255,0.12);
		border-radius: 16px;
		padding: 24px;
		width: 420px;
		max-width: 92vw;
		max-height: 80vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0;
	}

	.modal h2 {
		margin: 0 0 4px;
		font-size: 1rem;
		font-weight: 600;
	}

	.modal-desc {
		font-size: 0.82rem;
		color: rgba(255,255,255,0.35);
		margin: 0 0 16px;
	}

	.field-loading {
		color: rgba(255,255,255,0.3);
		font-size: 0.85rem;
		padding: 20px 0;
		text-align: center;
	}

	.no-fields {
		text-align: center;
		padding: 20px 0;
		color: rgba(255,255,255,0.35);
		font-size: 0.85rem;
	}

	.no-fields p { margin: 0 0 12px; }

	.create-field-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: #4ade80;
		text-decoration: none;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.field-list {
		list-style: none;
		margin: 0 0 10px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.field-card {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 10px;
		cursor: pointer;
		text-align: left;
		color: #e5e5e5;
		transition: all 0.15s;
	}
	.field-card:hover {
		background: rgba(255,255,255,0.07);
		border-color: rgba(255,255,255,0.15);
	}
	.field-card.selected {
		border-color: #4ade80;
		background: rgba(74,222,128,0.08);
	}

	.field-icon {
		color: rgba(255,255,255,0.3);
		flex-shrink: 0;
	}
	.field-card.selected .field-icon { color: #4ade80; }

	.field-info {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.field-name {
		font-size: 0.9rem;
		font-weight: 500;
	}

	.field-meta {
		font-size: 0.75rem;
		color: rgba(255,255,255,0.35);
	}

	.check {
		color: #4ade80;
		font-weight: 700;
		font-size: 1rem;
	}

	.setup-spawn-link {
		display: flex; align-items: center; gap: 5px;
		color: #4ade80; text-decoration: none;
		font-size: 0.78rem; font-weight: 600;
		background: rgba(74,222,128,0.06); border: 1px solid rgba(74,222,128,0.2);
		border-radius: 8px; padding: 8px 12px; margin-bottom: 4px;
		transition: all 0.15s;
	}
	.setup-spawn-link:hover { background: rgba(74,222,128,0.12); }

	.add-field-link {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		color: rgba(255,255,255,0.35);
		text-decoration: none;
		font-size: 0.78rem;
		margin-bottom: 16px;
		transition: color 0.15s;
	}
	.add-field-link:hover { color: rgba(255,255,255,0.7); }

	.modal-actions {
		display: flex;
		gap: 10px;
		justify-content: flex-end;
		margin-top: 4px;
	}

	.cancel-btn {
		background: transparent;
		color: rgba(255,255,255,0.5);
		border: 1px solid rgba(255,255,255,0.12);
		padding: 8px 16px;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.85rem;
		transition: color 0.15s;
	}
	.cancel-btn:hover { color: #e5e5e5; }

	.confirm-btn {
		background: #4ade80;
		color: #000;
		border: none;
		padding: 8px 20px;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.85rem;
		font-weight: 700;
		transition: opacity 0.15s;
	}
	.confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.confirm-btn:not(:disabled):hover { opacity: 0.85; }
</style>
