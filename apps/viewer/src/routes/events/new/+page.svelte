<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { db } from '$lib/firebase';
	import { collection, addDoc } from 'firebase/firestore';
	import { ArrowLeft, Check, QrCode, MapPin } from 'lucide-svelte';

	let eventName = $state('');
	let eventDate = $state(new Date().toISOString().slice(0, 10));
	let saving = $state(false);
	let error = $state('');

	// 保存後
	let step = $state<'form' | 'done'>('form');
	let savedFieldId = $state('');
	let savedEventId = $state('');
	let origin = $state('');

	onMount(() => { origin = window.location.origin; });

	async function create() {
		if (!eventName.trim()) return;
		saving = true;
		error = '';
		try {
			// フィールドを先に作成
			const fieldRef = await addDoc(collection(db, 'fields'), {
				name: eventName.trim(),
				boundary: [],
				spawnPoints: [],
			});
			// イベントを作成
			const eventRef = await addDoc(collection(db, 'events'), {
				name: eventName.trim(),
				date: new Date(eventDate).getTime(),
				fieldId: fieldRef.id,
				createdAt: Date.now(),
			});
			savedFieldId = fieldRef.id;
			savedEventId = eventRef.id;
			step = 'done';
		} catch (e) {
			error = `作成失敗: ${(e as Error).message}`;
		} finally {
			saving = false;
		}
	}
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
	</header>

	<!-- ═══════════ STEP: フォーム ═══════════ -->
	{#if step === 'form'}
	<div class="card">
		<h2>📅 イベント情報</h2>
		<p class="desc">イベント名と日付を入力して作成します。フィールドのGPS設定はスマホから行います。</p>

		<label class="lbl" for="ename">イベント名</label>
		<input
			id="ename"
			class="txt-input"
			type="text"
			placeholder="例: 第1回〇〇サバゲー"
			bind:value={eventName}
			maxlength="50"
			onkeydown={(e) => e.key === 'Enter' && create()}
		/>

		<label class="lbl" for="edate" style="margin-top:16px">開催日</label>
		<input id="edate" class="txt-input" type="date" bind:value={eventDate} />

		{#if error}
			<p class="error">{error}</p>
		{/if}

		<button class="create-btn" onclick={create} disabled={saving || !eventName.trim()}>
			{#if saving}
				<div class="spinner-sm"></div>作成中…
			{:else}
				<Check size={16} />イベントを作成
			{/if}
		</button>
	</div>

	<!-- ═══════════ STEP: 完了 + QR ═══════════ -->
	{:else}
	<div class="done-wrap">
		<div class="done-card">
			<div class="done-icon">✅</div>
			<h2>イベントを作成しました</h2>
			<p class="done-name">「{eventName}」</p>

			<div class="qr-section">
				<div class="qr-label">
					<MapPin size={14} />フィールドのGPS設定（スマホで開く）
				</div>
				<p class="qr-sub">スマホのカメラでスキャンして外周とスポーン地点を記録してください</p>
				{#if origin && savedFieldId}
					<img
						src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&color=4ade80&bgcolor=141414&data={encodeURIComponent(`${origin}/fields/${savedFieldId}/edit`)}"
						alt="フィールド設定QR"
						class="qr-img"
					/>
					<div class="qr-url">/fields/{savedFieldId}/edit</div>
				{/if}
			</div>

			<div class="done-actions">
				<button class="skip-btn" onclick={() => goto(`/events/${savedEventId}`)}>
					あとで設定する →
				</button>
				<button class="event-btn" onclick={() => goto(`/events/${savedEventId}`)}>
					<QrCode size={15} />イベントページへ
				</button>
			</div>
		</div>
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

	.page { min-height: 100vh; display: flex; flex-direction: column; }

	header {
		display: flex; align-items: center; gap: 12px;
		padding: 13px 18px;
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
	h1 { margin: 0; font-size: 0.95rem; font-weight: 600; }

	/* フォームカード */
	.card {
		max-width: 460px; margin: 48px auto; padding: 32px 28px;
		background: rgba(255,255,255,0.02);
		border: 1px solid rgba(255,255,255,0.08);
		border-radius: 16px;
		display: flex; flex-direction: column; gap: 10px;
		width: calc(100% - 40px);
	}
	.card h2 { margin: 0 0 2px; font-size: 1.1rem; }
	.desc { margin: 0 0 8px; font-size: 0.82rem; color: rgba(255,255,255,0.35); line-height: 1.5; }
	.lbl { font-size: 0.74rem; font-weight: 600; color: #9ca3af; }
	.txt-input {
		width: 100%; box-sizing: border-box;
		background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
		border-radius: 10px; color: #e5e5e5; font-size: 0.95rem;
		padding: 12px 14px; outline: none;
	}
	.txt-input:focus { border-color: rgba(74,222,128,0.5); }
	.error { font-size: 0.8rem; color: #ef4444; margin: 0; }
	.create-btn {
		display: flex; align-items: center; justify-content: center; gap: 7px;
		background: #4ade80; color: #000; border: none;
		font-size: 0.92rem; font-weight: 700;
		padding: 13px; border-radius: 10px; cursor: pointer;
		margin-top: 6px; transition: opacity 0.15s;
	}
	.create-btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.create-btn:not(:disabled):hover { opacity: 0.85; }
	.spinner-sm {
		width: 14px; height: 14px; border-radius: 50%;
		border: 2px solid rgba(0,0,0,0.2); border-top-color: #000;
		animation: spin 0.7s linear infinite; flex-shrink: 0;
	}
	@keyframes spin { to { transform: rotate(360deg) } }

	/* 完了画面 */
	.done-wrap {
		flex: 1; display: flex; align-items: flex-start; justify-content: center;
		padding: 40px 20px;
	}
	.done-card {
		max-width: 400px; width: 100%;
		display: flex; flex-direction: column; align-items: center; gap: 16px;
		text-align: center;
	}
	.done-icon { font-size: 2.4rem; }
	.done-card h2 { margin: 0; font-size: 1.1rem; font-weight: 700; }
	.done-name { margin: 0; font-size: 0.9rem; color: rgba(255,255,255,0.4); }

	/* QRセクション */
	.qr-section {
		width: 100%;
		background: rgba(74,222,128,0.03);
		border: 1px solid rgba(74,222,128,0.15);
		border-radius: 16px; padding: 20px;
		display: flex; flex-direction: column; align-items: center; gap: 10px;
	}
	.qr-label {
		display: flex; align-items: center; gap: 6px;
		font-size: 0.82rem; font-weight: 700; color: #4ade80;
	}
	.qr-sub {
		margin: 0; font-size: 0.76rem; color: rgba(255,255,255,0.35);
		line-height: 1.5;
	}
	.qr-img {
		width: 180px; height: 180px;
		border-radius: 12px; border: 1px solid rgba(74,222,128,0.2);
	}
	.qr-url {
		font-size: 0.62rem; font-family: monospace;
		color: rgba(74,222,128,0.4);
		background: rgba(74,222,128,0.05); border: 1px solid rgba(74,222,128,0.1);
		border-radius: 6px; padding: 5px 10px; word-break: break-all;
	}

	.done-actions {
		display: flex; gap: 10px; width: 100%;
	}
	.skip-btn {
		flex: 1; background: transparent;
		border: 1px solid rgba(255,255,255,0.12);
		color: rgba(255,255,255,0.4); font-size: 0.85rem;
		padding: 11px; border-radius: 10px; cursor: pointer;
		transition: all 0.15s;
	}
	.skip-btn:hover { color: #e5e5e5; border-color: rgba(255,255,255,0.25); }
	.event-btn {
		flex: 2; display: flex; align-items: center; justify-content: center; gap: 7px;
		background: #4ade80; color: #000; border: none;
		font-size: 0.88rem; font-weight: 700;
		padding: 11px; border-radius: 10px; cursor: pointer;
		transition: opacity 0.15s;
	}
	.event-btn:hover { opacity: 0.85; }
</style>
