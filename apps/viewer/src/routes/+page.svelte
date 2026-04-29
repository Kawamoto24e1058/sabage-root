<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { db } from '$lib/firebase';
	import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
	import type { GameEvent } from 'shared-types';
	import { PlusCircle, Calendar, ChevronRight, Monitor, Smartphone } from 'lucide-svelte';

	// ── デバイス判定 ──────────────────────────────────────────────────────
	// coarse pointer（タッチ）かつ幅768px未満をスマホと判定
	type Mode = 'auto' | 'pc' | 'mobile';
	let mode = $state<Mode>('auto');
	let isMobile = $state(false);
	let mounted = $state(false);

	onMount(() => {
		const coarse = window.matchMedia('(pointer: coarse)').matches;
		const narrow = window.innerWidth < 768;
		isMobile = coarse || narrow;
		const saved = localStorage.getItem('sabage-mode') as Mode | null;
		mode = (saved === 'pc' || saved === 'mobile') ? saved : 'auto';
		mounted = true;
	});

	function setMode(m: 'pc' | 'mobile') {
		mode = m;
		localStorage.setItem('sabage-mode', m);
	}

	const effectiveMode = $derived(mode === 'auto' ? (isMobile ? 'mobile' : 'pc') : mode);

	// ── イベント一覧（両モード共通） ───────────────────────────────────────
	let events = $state<(GameEvent & { id: string })[]>([]);
	let loading = $state(true);
	let unsubscribe: (() => void) | undefined;

	onMount(() => {
		const q = query(collection(db, 'events'), orderBy('date', 'desc'));
		unsubscribe = onSnapshot(q, (snap) => {
			events = snap.docs.map(d => ({ id: d.id, ...d.data() } as GameEvent & { id: string }));
			loading = false;
		}, () => { loading = false; });
	});

	onDestroy(() => { if (unsubscribe) unsubscribe(); });

	// ── スマホモード: 試合ID入力 ──────────────────────────────────────────
	let matchIdInput = $state('');
	function joinMatch() {
		const id = matchIdInput.trim();
		if (id) window.location.href = `/track/${id}`;
	}

	function formatDay(ts: number) {
		return new Date(ts).toLocaleDateString('ja-JP', {
			year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
		});
	}
	function isToday(ts: number) {
		const d = new Date(ts), t = new Date();
		return d.getFullYear() === t.getFullYear() &&
			d.getMonth() === t.getMonth() &&
			d.getDate() === t.getDate();
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
			<div class="mode-toggle">
				<button
					class="mode-btn {effectiveMode === 'mobile' ? 'active' : ''}"
					onclick={() => setMode('mobile')}
				><Smartphone size={13} />スマホ</button>
				<button
					class="mode-btn {effectiveMode === 'pc' ? 'active' : ''}"
					onclick={() => setMode('pc')}
				><Monitor size={13} />モニター</button>
			</div>
		</div>
	</header>

	<!-- ════════════════════════════════════════════════ -->
	<!-- スマホモード — 全機能（作成・管理・参加）       -->
	<!-- ════════════════════════════════════════════════ -->
	{#if !mounted || effectiveMode === 'mobile'}
	<main class="main">

		<!-- 試合IDで直接参加 -->
		<div class="join-bar">
			<input
				class="join-input"
				type="text"
				placeholder="試合IDを入力して直接参加"
				bind:value={matchIdInput}
				onkeydown={(e) => e.key === 'Enter' && joinMatch()}
			/>
			<button class="join-btn" onclick={joinMatch} disabled={!matchIdInput.trim()}>参加</button>
		</div>

		<!-- イベント一覧 -->
		<div class="section-header">
			<span class="section-label">イベント</span>
			<a href="/events/new" class="create-btn">
				<PlusCircle size={14} />作成
			</a>
		</div>

		{#if loading}
			<div class="empty"><p class="muted">読み込み中...</p></div>
		{:else if events.length === 0}
			<div class="empty">
				<div class="empty-icon">🎮</div>
				<p class="empty-title">まだイベントがありません</p>
				<p class="muted">開催日ごとにイベントを作成して、フィールド設定や試合の管理をします。</p>
				<a href="/events/new" class="empty-cta">
					<PlusCircle size={16} />最初のイベントを作成する
				</a>
			</div>
		{:else}
			<ul class="event-list">
				{#each events as ev}
					<li>
						<a class="event-card" href="/events/{ev.id}">
							<div class="event-icon"><Calendar size={18} /></div>
							<div class="event-body">
								<div class="event-name">
									{ev.name}
									{#if isToday(ev.date)}<span class="today-badge">今日</span>{/if}
								</div>
								<div class="event-date">{formatDay(ev.date)}</div>
							</div>
							<ChevronRight size={18} class="chevron" />
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</main>

	<!-- ════════════════════════════════════════════════ -->
	<!-- PCモード — モニター（見るだけ）                 -->
	<!-- ════════════════════════════════════════════════ -->
	{:else}
	<main class="main pc-main">
		<div class="monitor-badge">
			<Monitor size={14} />モニターモード — 試合を選んでマップを表示
		</div>

		{#if loading}
			<div class="empty"><p class="muted">読み込み中...</p></div>
		{:else if events.length === 0}
			<div class="empty">
				<div class="empty-icon">📺</div>
				<p class="empty-title">表示できるイベントがありません</p>
				<p class="muted">スマホモードでイベントを作成してください。</p>
			</div>
		{:else}
			<ul class="event-list">
				{#each events as ev}
					<li>
						<a class="event-card" href="/events/{ev.id}">
							<div class="event-icon"><Calendar size={18} /></div>
							<div class="event-body">
								<div class="event-name">
									{ev.name}
									{#if isToday(ev.date)}<span class="today-badge">今日</span>{/if}
								</div>
								<div class="event-date">{formatDay(ev.date)}</div>
							</div>
							<ChevronRight size={18} class="chevron" />
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	</main>
	{/if}
</div>

<style>
	:global(body) {
		margin: 0; padding: 0;
		background: #0a0a0a; color: #e5e5e5;
		font-family: 'Inter', system-ui, -apple-system, sans-serif;
		min-height: 100vh;
	}
	.page { min-height: 100vh; display: flex; flex-direction: column; }

	header {
		border-bottom: 1px solid rgba(255,255,255,0.07);
		background: rgba(15,15,15,0.97);
		backdrop-filter: blur(10px);
		position: sticky; top: 0; z-index: 10;
	}
	.header-inner {
		max-width: 700px; margin: 0 auto;
		padding: 14px 20px;
		display: flex; align-items: center; justify-content: space-between;
	}
	.logo { display: flex; align-items: center; gap: 10px; }
	.dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: #4ade80; box-shadow: 0 0 8px #4ade80;
	}
	h1 { margin: 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -0.02em; }

	.mode-toggle {
		display: flex;
		background: rgba(255,255,255,0.06);
		border: 1px solid rgba(255,255,255,0.1);
		border-radius: 10px;
		padding: 3px; gap: 2px;
	}
	.mode-btn {
		display: flex; align-items: center; gap: 5px;
		background: transparent; border: none;
		color: rgba(255,255,255,0.35);
		font-size: 0.78rem; font-weight: 600;
		padding: 6px 12px; border-radius: 7px;
		cursor: pointer; transition: all 0.15s;
	}
	.mode-btn.active { background: rgba(255,255,255,0.1); color: #e5e5e5; }

	.main {
		max-width: 600px; margin: 0 auto;
		padding: 20px 20px 40px;
		width: 100%; box-sizing: border-box;
		display: flex; flex-direction: column; gap: 14px;
	}
	.pc-main { max-width: 700px; }

	/* 試合ID入力バー */
	.join-bar {
		display: flex; gap: 8px;
		background: rgba(255,255,255,0.03);
		border: 1px solid rgba(255,255,255,0.09);
		border-radius: 14px;
		padding: 10px 10px 10px 14px;
		align-items: center;
	}
	.join-input {
		flex: 1; background: transparent; border: none;
		color: #e5e5e5; font-size: 0.88rem;
		outline: none; min-width: 0;
	}
	.join-input::placeholder { color: rgba(255,255,255,0.2); }
	.join-btn {
		background: #4ade80; color: #000; border: none;
		border-radius: 8px; padding: 8px 16px;
		font-size: 0.85rem; font-weight: 700;
		cursor: pointer; white-space: nowrap; transition: opacity 0.15s; flex-shrink: 0;
	}
	.join-btn:disabled { opacity: 0.3; cursor: not-allowed; }
	.join-btn:not(:disabled):hover { opacity: 0.85; }

	/* セクションヘッダー */
	.section-header {
		display: flex; align-items: center; justify-content: space-between;
	}
	.section-label {
		font-size: 0.72rem; font-weight: 700;
		color: rgba(255,255,255,0.3); letter-spacing: 0.06em; text-transform: uppercase;
	}
	.create-btn {
		display: flex; align-items: center; gap: 5px;
		background: #4ade80; color: #000; text-decoration: none;
		padding: 7px 14px; border-radius: 8px;
		font-size: 0.82rem; font-weight: 700; transition: opacity 0.15s;
	}
	.create-btn:hover { opacity: 0.85; }

	/* モニターバッジ */
	.monitor-badge {
		display: flex; align-items: center; gap: 7px;
		background: rgba(255,255,255,0.04);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 10px; padding: 10px 14px;
		font-size: 0.8rem; color: rgba(255,255,255,0.35);
	}

	/* イベントリスト */
	.event-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.event-card {
		display: flex; align-items: center; gap: 14px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
		border-radius: 14px; padding: 16px 18px;
		text-decoration: none; color: inherit; transition: all 0.15s;
	}
	.event-card:hover { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.16); }
	.event-icon {
		width: 38px; height: 38px; border-radius: 10px;
		background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.2);
		display: flex; align-items: center; justify-content: center;
		color: #4ade80; flex-shrink: 0;
	}
	.event-body { flex: 1; min-width: 0; }
	.event-name {
		font-size: 0.92rem; font-weight: 600;
		display: flex; align-items: center; gap: 8px;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.today-badge {
		background: #4ade80; color: #000; border-radius: 20px;
		padding: 2px 8px; font-size: 0.66rem; font-weight: 700; flex-shrink: 0;
	}
	.event-date { font-size: 0.76rem; color: rgba(255,255,255,0.35); margin-top: 3px; }
	:global(.chevron) { color: rgba(255,255,255,0.2); flex-shrink: 0; }

	/* 空状態 */
	.empty {
		text-align: center; padding: 60px 20px;
		display: flex; flex-direction: column; align-items: center; gap: 12px;
	}
	.empty-icon { font-size: 2.8rem; }
	.empty-title { font-size: 1rem; font-weight: 600; margin: 0; }
	.muted { color: rgba(255,255,255,0.3); margin: 0; font-size: 0.84rem; line-height: 1.6; }
	.empty-cta {
		display: inline-flex; align-items: center; gap: 7px; margin-top: 8px;
		background: #4ade80; color: #000; text-decoration: none;
		padding: 11px 22px; border-radius: 12px;
		font-size: 0.88rem; font-weight: 700; transition: opacity 0.15s;
	}
	.empty-cta:hover { opacity: 0.85; }
</style>
