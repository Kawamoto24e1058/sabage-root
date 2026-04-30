<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { db } from '$lib/firebase';
	import {
		doc, getDoc, collection, query, where, orderBy, onSnapshot, addDoc
	} from 'firebase/firestore';
	import type { GameEvent, Field, Match, TeamConfig, GameMode } from 'shared-types';
	import { ArrowLeft, Play, Clock, CheckCircle, Plus, Settings, MapPin, QrCode } from 'lucide-svelte';

	const eventId = page.params.eventId ?? '';

	// PCモード判定（localStorageから）
	let isMobile = $state(true); // デフォルトはスマホ（SSRで safe）
	onMount(() => {
		const saved = localStorage.getItem('sabage-mode');
		if (saved === 'pc') {
			isMobile = false;
		} else if (saved === 'mobile') {
			isMobile = true;
		} else {
			// auto: pointer: coarse または幅768px未満
			isMobile = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
		}
		origin = window.location.origin;
	});

	let event = $state<(GameEvent & { id: string }) | null>(null);
	let field = $state<(Field & { id: string }) | null>(null);
	let matches = $state<(Match & { id: string })[]>([]);
	let loading = $state(true);
	let unsubscribe: (() => void) | null = null;

	// 試合作成モーダル
	let showCreate = $state(false);
	let creating = $state(false);

	// フィールド設定QRモーダル
	let showFieldQR = $state(false);
	let origin = $state('');

	// ゲーム設定
	let gameMode = $state<GameMode>('elimination');
	let teamCount = $state(2);
	let teamNames = $state(['チームA', 'チームB', 'チームC', 'チームD']);
	let respawnSec = $state(30);

	onMount(async () => {
		// イベント取得
		const evSnap = await getDoc(doc(db, 'events', eventId));
		if (!evSnap.exists()) { loading = false; return; }
		event = { id: evSnap.id, ...evSnap.data() } as GameEvent & { id: string };

		// フィールド取得
		const fSnap = await getDoc(doc(db, 'fields', event.fieldId));
		if (fSnap.exists()) {
			field = { id: fSnap.id, ...fSnap.data() } as Field & { id: string };
		}

		// 試合リスト（リアルタイム）
		const q = query(
			collection(db, 'matches'),
			where('eventId', '==', eventId),
			orderBy('createdAt', 'desc')
		);
		unsubscribe = onSnapshot(q, (snap) => {
			matches = snap.docs.map(d => ({ id: d.id, ...d.data() } as Match & { id: string }));
			loading = false;
		}, (err) => { console.error('matches snapshot error:', err); loading = false; });
	});

	onDestroy(() => { if (unsubscribe) unsubscribe(); });

	async function createMatch() {
		if (!event || !field) return;
		creating = true;
		try {
			const teams: TeamConfig[] = teamNames.slice(0, teamCount).map((name, i) => ({
				id: String.fromCharCode(65 + i), // A, B, C, D
				name,
			}));
			await addDoc(collection(db, 'matches'), {
				fieldId: event.fieldId,
				eventId,
				createdAt: Date.now(),
				status: 'waiting',
				gameMode,
				teams,
				...(gameMode === 'timed_respawn' ? { respawnCooldownSec: respawnSec } : {}),
			});
			showCreate = false;
		} catch (e) {
			console.error(e);
			alert('試合作成に失敗しました');
		} finally {
			creating = false;
		}
	}

	const statusCfg: Record<string, { label: string; color: string }> = {
		waiting:  { label: '待機中', color: '#facc15' },
		playing:  { label: '試合中', color: '#4ade80' },
		finished: { label: '終了',   color: '#6b7280' },
	};

	function formatDate(ts: number) {
		return new Date(ts).toLocaleString('ja-JP', {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
		});
	}

	function formatDay(ts: number) {
		return new Date(ts).toLocaleDateString('ja-JP', {
			year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
		});
	}

	const gameModeLabel: Record<GameMode, string> = {
		elimination: '殲滅戦',
		unlimited_respawn: '無制限復活',
		timed_respawn: '制限時間復活',
	};
</script>

<svelte:head>
	<title>{event?.name ?? 'イベント'} – Sabage Tracker</title>
</svelte:head>

<div class="page">
	<header>
		<div class="header-inner">
			<button class="back" onclick={() => goto('/')}>
				<ArrowLeft size={16} />戻る
			</button>
			<div class="header-center">
				<h1>{event?.name ?? '読み込み中...'}</h1>
				{#if event}
					<span class="date">{formatDay(event.date)}</span>
				{/if}
			</div>
			<div class="header-actions">
				{#if field}
					{#if isMobile}
						<a href="/fields/{event?.fieldId}/edit" class="edit-field-btn" title="フィールド設定">
							<Settings size={15} />フィールド設定
						</a>
					{:else}
						<button class="edit-field-btn" onclick={() => showFieldQR = true} title="フィールド設定（QR）">
							<QrCode size={15} />フィールド設定
						</button>
					{/if}
				{/if}
				<button class="create-btn" onclick={() => showCreate = true}>
					<Plus size={15} />試合を作成
				</button>
			</div>
		</div>
	</header>

	<main>
		<!-- フィールド情報 -->
		{#if field}
			<div class="field-info-bar">
				<MapPin size={13} />
				<span>{field.name}</span>
				{#if field.spawnPoints && field.spawnPoints.length > 0}
					<span class="tag">スポーン {field.spawnPoints.length}点</span>
				{:else}
					{#if isMobile}
						<a href="/fields/{event?.fieldId}/edit" class="tag warn">スポーン未設定 →</a>
					{:else}
						<button class="tag warn tag-btn" onclick={() => showFieldQR = true}>⚠ スポーン未設定 — QRで設定</button>
					{/if}
				{/if}
				{#if field.boundary && field.boundary.length >= 3}
					<span class="tag">外周 {field.boundary.length}点</span>
				{:else}
					{#if !isMobile}
						<button class="tag warn tag-btn" onclick={() => showFieldQR = true}>⚠ 外周未設定 — QRで設定</button>
					{/if}
				{/if}
			</div>
		{/if}

		{#if loading}
			<div class="empty"><p class="muted">読み込み中...</p></div>
		{:else if matches.length === 0}
			<div class="empty">
				<p class="muted">まだ試合がありません</p>
				<button class="cta-btn" onclick={() => showCreate = true}>
					<Plus size={16} />最初の試合を作成する
				</button>
			</div>
		{:else}
			<ul class="match-list">
				{#each matches as match}
					{@const cfg = statusCfg[match.status] ?? statusCfg.finished}
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
								<span class="match-label">
									{gameModeLabel[match.gameMode ?? 'elimination']}
									{#if match.teams}— {match.teams.map(t => t.name).join(' vs ')}{/if}
								</span>
								<span class="match-date muted">{formatDate(match.createdAt)}</span>
							</div>
						</div>
						<div class="card-actions">
							{#if isMobile}
								<!-- スマホ: 参加（プレイヤートラッカーへ） -->
								{#if match.status !== 'finished'}
									<a class="join-btn" href="/track/{match.id}">
										参加する →
									</a>
								{:else}
									<a class="view-btn" href="/{match.id}">
										<Play size={14} fill="currentColor" />リプレイ
									</a>
								{/if}
							{:else}
								<!-- PC: マップモニターへ -->
								<a class="view-btn" href="/{match.id}">
									<Play size={14} fill="currentColor" />
									{match.status === 'finished' ? 'リプレイ' : 'モニター'}
								</a>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		{/if}
	</main>
</div>

<!-- フィールド設定QRモーダル -->
{#if showFieldQR}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => showFieldQR = false}>
		<div class="modal fqr-modal" onclick={(e) => e.stopPropagation()}>
			<h2>📱 フィールド設定 — スマホで開く</h2>
			<p class="fqr-sub">スマホのカメラでQRをスキャンしてGPS設定ページを開いてください</p>
			{#if origin && event?.fieldId}
				<img
					src="https://api.qrserver.com/v1/create-qr-code/?size=220x220&color=4ade80&bgcolor=141414&data={encodeURIComponent(`${origin}/fields/${event.fieldId}/edit`)}"
					alt="Field Edit QR"
					class="fqr-img"
				/>
				<div class="fqr-url">/fields/{event.fieldId}/edit</div>
			{/if}
			<div class="modal-actions">
				<button class="cancel-btn" onclick={() => showFieldQR = false}>閉じる</button>
			</div>
		</div>
	</div>
{/if}

<!-- 試合作成モーダル -->
{#if showCreate}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-backdrop" onclick={() => showCreate = false}>
		<div class="modal" onclick={(e) => e.stopPropagation()}>
			<h2>新しい試合を作成</h2>

			<label class="modal-label">ゲームモード</label>
			<div class="mode-grid">
				{#each ([['elimination', '殲滅戦', '死んだら終わり'], ['unlimited_respawn', '無制限復活', '何度でも復活'], ['timed_respawn', '制限時間復活', '一定秒後に復活']] as const) as [mode, label, desc]}
					<button
						class="mode-btn"
						class:selected={gameMode === mode}
						onclick={() => gameMode = mode}
					>
						<span class="mode-label">{label}</span>
						<span class="mode-desc">{desc}</span>
					</button>
				{/each}
			</div>

			{#if gameMode === 'timed_respawn'}
				<div class="respawn-row">
					<label class="modal-label">復活待機秒数</label>
					<div class="respawn-input-row">
						<input class="num-input" type="number" min="5" max="300" bind:value={respawnSec} />
						<span class="unit">秒</span>
					</div>
				</div>
			{/if}

			<label class="modal-label">チーム数</label>
			<div class="team-count-row">
				{#each [2, 3, 4] as n}
					<button class="count-btn" class:selected={teamCount === n} onclick={() => teamCount = n}>{n}チーム</button>
				{/each}
			</div>

			<div class="team-names">
				{#each Array(teamCount) as _, i}
					<input
						class="team-name-input"
						type="text"
						placeholder="チーム名"
						bind:value={teamNames[i]}
					/>
				{/each}
			</div>

			<div class="modal-actions">
				<button class="cancel-btn" onclick={() => showCreate = false}>キャンセル</button>
				<button class="confirm-btn" onclick={createMatch} disabled={creating}>
					{creating ? '作成中...' : '試合を作成'}
				</button>
			</div>
		</div>
	</div>
{/if}

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
		max-width: 760px; margin: 0 auto;
		padding: 14px 20px;
		display: flex; align-items: center; gap: 16px;
	}
	.back {
		display: flex; align-items: center; gap: 5px;
		background: transparent; border: none;
		color: rgba(255,255,255,0.4); font-size: 0.85rem; cursor: pointer;
		padding: 6px 10px; border-radius: 8px; flex-shrink: 0;
	}
	.back:hover { color: #fff; }
	.header-center { flex: 1; min-width: 0; }
	h1 { margin: 0; font-size: 1rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.date { font-size: 0.75rem; color: rgba(255,255,255,0.35); }
	.header-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }

	.edit-field-btn {
		display: flex; align-items: center; gap: 5px;
		color: rgba(255,255,255,0.4); text-decoration: none;
		font-size: 0.8rem; padding: 7px 12px;
		border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
		transition: all 0.15s;
	}
	.edit-field-btn:hover { color: #e5e5e5; border-color: rgba(255,255,255,0.2); }

	.create-btn {
		display: flex; align-items: center; gap: 5px;
		background: #4ade80; color: #000; border: none;
		font-size: 0.85rem; font-weight: 700;
		padding: 8px 16px; border-radius: 8px; cursor: pointer;
		transition: opacity 0.15s;
	}
	.create-btn:hover { opacity: 0.85; }

	main { max-width: 760px; margin: 0 auto; padding: 24px 20px; }

	.field-info-bar {
		display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
		background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.07);
		border-radius: 10px; padding: 10px 14px; margin-bottom: 20px;
		font-size: 0.8rem; color: rgba(255,255,255,0.5);
	}
	.tag {
		background: rgba(255,255,255,0.06); border-radius: 20px;
		padding: 2px 8px; font-size: 0.72rem; color: rgba(255,255,255,0.4);
	}
	.tag.warn { color: #facc15; background: rgba(250,204,21,0.08); text-decoration: none; }

	.empty { text-align: center; padding: 80px 20px; }
	.muted { color: rgba(255,255,255,0.3); margin: 0 0 16px; }
	.cta-btn {
		display: inline-flex; align-items: center; gap: 7px;
		background: #4ade80; color: #000; border: none;
		padding: 12px 24px; border-radius: 10px;
		font-size: 0.9rem; font-weight: 700; cursor: pointer;
	}

	.match-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
	.match-card {
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
		border-radius: 12px; padding: 16px 20px;
		display: flex; align-items: center; justify-content: space-between; gap: 16px;
		transition: all 0.15s;
	}
	.match-card:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.15); }
	.card-left { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0; }
	.status-badge {
		display: flex; align-items: center; gap: 4px;
		font-size: 0.75rem; font-weight: 600; color: var(--c);
		background: color-mix(in srgb, var(--c) 12%, transparent);
		border: 1px solid color-mix(in srgb, var(--c) 30%, transparent);
		padding: 3px 8px; border-radius: 20px; white-space: nowrap; flex-shrink: 0;
	}
	.match-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.match-label { font-size: 0.88rem; font-weight: 500; }
	.match-date { font-size: 0.75rem; }
	.card-actions { flex-shrink: 0; }
	.view-btn {
		display: flex; align-items: center; gap: 6px;
		background: #4ade80; color: #000; text-decoration: none;
		padding: 8px 16px; border-radius: 8px;
		font-size: 0.82rem; font-weight: 700; white-space: nowrap;
		transition: opacity 0.15s;
	}
	.view-btn:hover { opacity: 0.85; }
	.join-btn {
		display: inline-flex; align-items: center;
		background: rgba(74,222,128,0.12); color: #4ade80;
		border: 1px solid rgba(74,222,128,0.35); text-decoration: none;
		padding: 8px 18px; border-radius: 8px;
		font-size: 0.82rem; font-weight: 700; white-space: nowrap;
		transition: all 0.15s;
	}
	.join-btn:hover { background: rgba(74,222,128,0.22); border-color: rgba(74,222,128,0.6); }

	/* モーダル */
	.modal-backdrop {
		position: fixed; inset: 0; background: rgba(0,0,0,0.75);
		display: flex; align-items: center; justify-content: center;
		z-index: 100; backdrop-filter: blur(4px);
	}
	.modal {
		background: #1a1a1a; border: 1px solid rgba(255,255,255,0.12);
		border-radius: 16px; padding: 24px; width: 400px;
		max-width: 92vw; max-height: 85vh; overflow-y: auto;
		display: flex; flex-direction: column; gap: 14px;
	}
	.modal h2 { margin: 0; font-size: 1rem; font-weight: 600; }
	.modal-label { font-size: 0.75rem; font-weight: 600; color: #9ca3af; }

	.mode-grid { display: grid; grid-template-columns: 1fr; gap: 6px; }
	.mode-btn {
		display: flex; flex-direction: column; gap: 2px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
		border-radius: 10px; padding: 10px 14px; cursor: pointer; text-align: left;
		transition: all 0.15s;
	}
	.mode-btn:hover { border-color: rgba(255,255,255,0.2); }
	.mode-btn.selected { border-color: #4ade80; background: rgba(74,222,128,0.08); }
	.mode-label { font-size: 0.88rem; font-weight: 600; color: #e5e5e5; }
	.mode-desc { font-size: 0.75rem; color: rgba(255,255,255,0.35); }

	.respawn-row { display: flex; flex-direction: column; gap: 6px; }
	.respawn-input-row { display: flex; align-items: center; gap: 8px; }

	.team-count-row { display: flex; gap: 8px; }
	.count-btn {
		flex: 1; padding: 9px;
		background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
		border-radius: 8px; color: #e5e5e5; font-size: 0.85rem; cursor: pointer;
		transition: all 0.15s;
	}
	.count-btn:hover { border-color: rgba(255,255,255,0.2); }
	.count-btn.selected { border-color: #4ade80; background: rgba(74,222,128,0.08); color: #4ade80; font-weight: 700; }

	.team-names { display: flex; flex-direction: column; gap: 6px; }
	.team-name-input {
		width: 100%; box-sizing: border-box;
		background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
		border-radius: 8px; color: #e5e5e5; font-size: 0.88rem;
		padding: 9px 12px; outline: none;
	}
	.team-name-input:focus { border-color: rgba(74,222,128,0.5); }

	.num-input {
		width: 70px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
		border-radius: 8px; color: #e5e5e5; font-size: 0.9rem; padding: 6px 8px; text-align: center;
	}
	.unit { font-size: 0.8rem; color: #6b7280; }

	.modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
	.cancel-btn {
		background: transparent; color: rgba(255,255,255,0.5);
		border: 1px solid rgba(255,255,255,0.12);
		padding: 9px 18px; border-radius: 8px; cursor: pointer; font-size: 0.85rem;
	}
	.confirm-btn {
		background: #4ade80; color: #000; border: none;
		padding: 9px 22px; border-radius: 8px;
		font-size: 0.85rem; font-weight: 700; cursor: pointer; transition: opacity 0.15s;
	}
	.confirm-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.confirm-btn:not(:disabled):hover { opacity: 0.85; }

	/* フィールドQRモーダル */
	.fqr-modal { align-items: center; text-align: center; max-width: 320px; }
	.fqr-sub { font-size: 0.78rem; color: rgba(255,255,255,0.35); margin: 0; line-height: 1.5; }
	.fqr-img { width: 200px; height: 200px; border-radius: 12px; border: 1px solid rgba(74,222,128,0.25); }
	.fqr-url {
		font-size: 0.65rem; font-family: monospace;
		color: rgba(74,222,128,0.5);
		background: rgba(74,222,128,0.05); border: 1px solid rgba(74,222,128,0.12);
		border-radius: 6px; padding: 6px 10px; word-break: break-all;
	}

	/* タグボタン（警告タグをボタン化） */
	.tag-btn {
		cursor: pointer; background: rgba(250,204,21,0.08);
		border: 1px solid rgba(250,204,21,0.25); color: #facc15;
		font-size: 0.72rem; border-radius: 20px; padding: 2px 8px;
		transition: all 0.15s;
	}
	.tag-btn:hover { background: rgba(250,204,21,0.15); border-color: rgba(250,204,21,0.5); }
</style>
