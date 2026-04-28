<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { db } from '$lib/firebase';
	import { collection, onSnapshot, orderBy, query } from 'firebase/firestore';
	import type { GameEvent } from 'shared-types';
	import { PlusCircle, Calendar, ChevronRight } from 'lucide-svelte';

	let events = $state<(GameEvent & { id: string })[]>([]);
	let loading = $state(true);
	let unsubscribe: () => void;

	onMount(() => {
		const q = query(collection(db, 'events'), orderBy('date', 'desc'));
		unsubscribe = onSnapshot(q, (snap) => {
			events = snap.docs.map(d => ({ id: d.id, ...d.data() } as GameEvent & { id: string }));
			loading = false;
		}, () => { loading = false; });
	});

	onDestroy(() => { if (unsubscribe) unsubscribe(); });

	function formatDay(ts: number) {
		return new Date(ts).toLocaleDateString('ja-JP', {
			year: 'numeric', month: 'long', day: 'numeric', weekday: 'short'
		});
	}

	function isToday(ts: number) {
		const d = new Date(ts);
		const t = new Date();
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
			<a href="/events/new" class="create-btn">
				<PlusCircle size={16} />
				イベントを作成
			</a>
		</div>
	</header>

	<main>
		{#if loading}
			<div class="empty"><p class="muted">読み込み中...</p></div>
		{:else if events.length === 0}
			<div class="empty">
				<div class="empty-icon">🎮</div>
				<p class="empty-title">まだイベントがありません</p>
				<p class="muted">サバゲーの開催日ごとにイベントを作成すると、フィールドの設定や試合の管理ができます。</p>
				<a href="/events/new" class="empty-cta">
					<PlusCircle size={16} />
					最初のイベントを作成する
				</a>
			</div>
		{:else}
			<ul class="event-list">
				{#each events as ev}
					<li>
						<a class="event-card" href="/events/{ev.id}">
							<div class="event-icon">
								<Calendar size={18} />
							</div>
							<div class="event-body">
								<div class="event-name">
									{ev.name}
									{#if isToday(ev.date)}
										<span class="today-badge">今日</span>
									{/if}
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
		background: rgba(15,15,15,0.95);
		backdrop-filter: blur(10px);
		position: sticky; top: 0; z-index: 10;
	}
	.header-inner {
		max-width: 600px; margin: 0 auto;
		padding: 18px 20px;
		display: flex; align-items: center; justify-content: space-between;
	}
	.logo { display: flex; align-items: center; gap: 10px; }
	.dot {
		width: 8px; height: 8px; border-radius: 50%;
		background: #4ade80; box-shadow: 0 0 8px #4ade80;
	}
	h1 { margin: 0; font-size: 1.1rem; font-weight: 700; letter-spacing: -0.02em; }

	.create-btn {
		display: flex; align-items: center; gap: 6px;
		background: #4ade80; color: #000; text-decoration: none;
		padding: 9px 18px; border-radius: 10px;
		font-size: 0.85rem; font-weight: 700;
		transition: opacity 0.15s;
	}
	.create-btn:hover { opacity: 0.85; }

	main { max-width: 600px; margin: 0 auto; padding: 32px 20px; }

	.empty {
		text-align: center; padding: 80px 20px;
		display: flex; flex-direction: column; align-items: center; gap: 12px;
	}
	.empty-icon { font-size: 3rem; }
	.empty-title { font-size: 1.1rem; font-weight: 600; margin: 0; }
	.muted { color: rgba(255,255,255,0.35); margin: 0; font-size: 0.88rem; line-height: 1.6; }
	.empty-cta {
		display: inline-flex; align-items: center; gap: 7px;
		margin-top: 8px;
		background: #4ade80; color: #000; text-decoration: none;
		padding: 12px 24px; border-radius: 12px;
		font-size: 0.9rem; font-weight: 700;
		transition: opacity 0.15s;
	}
	.empty-cta:hover { opacity: 0.85; }

	.event-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
	.event-card {
		display: flex; align-items: center; gap: 14px;
		background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08);
		border-radius: 14px; padding: 18px 20px;
		text-decoration: none; color: inherit;
		transition: all 0.15s;
	}
	.event-card:hover {
		background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.16);
	}
	.event-icon {
		width: 40px; height: 40px; border-radius: 10px;
		background: rgba(74,222,128,0.1); border: 1px solid rgba(74,222,128,0.2);
		display: flex; align-items: center; justify-content: center;
		color: #4ade80; flex-shrink: 0;
	}
	.event-body { flex: 1; min-width: 0; }
	.event-name {
		font-size: 0.95rem; font-weight: 600;
		display: flex; align-items: center; gap: 8px;
		overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
	}
	.today-badge {
		background: #4ade80; color: #000; border-radius: 20px;
		padding: 2px 8px; font-size: 0.68rem; font-weight: 700; flex-shrink: 0;
	}
	.event-date { font-size: 0.78rem; color: rgba(255,255,255,0.35); margin-top: 3px; }
	:global(.chevron) { color: rgba(255,255,255,0.2); flex-shrink: 0; }
</style>
