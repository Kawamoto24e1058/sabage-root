<script lang="ts">
	import { db } from '$lib/firebase';
	import { collection, addDoc } from 'firebase/firestore';
	import { goto } from '$app/navigation';
	import { ArrowLeft } from 'lucide-svelte';

	let fieldName = $state('');
	let saving = $state(false);
	let error = $state('');

	async function create() {
		if (!fieldName.trim()) { error = 'フィールド名を入力してください'; return; }
		saving = true;
		try {
			const ref = await addDoc(collection(db, 'fields'), {
				name: fieldName.trim(),
				boundary: [],
				spawnPoints: [],
			});
			await goto(`/fields/${ref.id}/edit`);
		} catch (e) {
			error = `作成失敗: ${(e as Error).message}`;
			saving = false;
		}
	}
</script>

<svelte:head>
	<title>新規フィールド作成</title>
</svelte:head>

<div class="page">
	<div class="header">
		<a href="/fields" class="back">
			<ArrowLeft size={18} />
		</a>
		<h1 class="title">新規フィールド作成</h1>
	</div>

	<div class="card">
		<p class="hint">フィールド名を入力して「作成」すると、GPS外周記録ページへ移動します。</p>

		<label class="label" for="fname">フィールド名</label>
		<input
			id="fname"
			class="input"
			type="text"
			placeholder="例: ○○サバゲーフィールド"
			bind:value={fieldName}
			onkeydown={(e) => e.key === 'Enter' && create()}
		/>

		{#if error}
			<p class="error">{error}</p>
		{/if}

		<button class="btn" onclick={create} disabled={saving}>
			{saving ? '作成中…' : 'フィールドを作成 →'}
		</button>
	</div>
</div>

<style>
	:global(body) {
		margin: 0; padding: 0;
		background: #050f05;
		color: #4ade80;
		font-family: 'Inter', system-ui, sans-serif;
	}
	.page { max-width: 480px; margin: 0 auto; padding: 0 0 40px; }
	.header {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 16px;
		border-bottom: 1px solid rgba(74,222,128,0.1);
		position: sticky; top: 0;
		background: rgba(5,15,5,0.98);
		backdrop-filter: blur(10px);
	}
	.back {
		display: flex;
		align-items: center;
		color: rgba(74,222,128,0.5);
		text-decoration: none;
	}
	.back:hover { color: #4ade80; }
	.title {
		font-size: 1rem;
		font-weight: 800;
		color: #4ade80;
		margin: 0;
		font-family: monospace;
	}
	.card {
		margin: 20px 16px;
		background: rgba(74,222,128,0.03);
		border: 1px solid rgba(74,222,128,0.12);
		border-radius: 14px;
		padding: 20px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.hint {
		font-size: 0.78rem;
		color: rgba(74,222,128,0.45);
		margin: 0;
		line-height: 1.5;
	}
	.label {
		font-size: 0.78rem;
		font-weight: 700;
		color: rgba(74,222,128,0.6);
		letter-spacing: 0.04em;
	}
	.input {
		width: 100%;
		background: rgba(74,222,128,0.05);
		border: 1px solid rgba(74,222,128,0.2);
		border-radius: 9px;
		color: #4ade80;
		font-size: 0.95rem;
		padding: 12px 14px;
		outline: none;
		box-sizing: border-box;
	}
	.input::placeholder { color: rgba(74,222,128,0.25); }
	.input:focus { border-color: rgba(74,222,128,0.5); }
	.error { font-size: 0.78rem; color: #f87171; margin: 0; }
	.btn {
		background: #4ade80;
		color: #020c02;
		border: none;
		border-radius: 10px;
		padding: 13px;
		font-size: 0.92rem;
		font-weight: 800;
		cursor: pointer;
		box-shadow: 0 0 12px rgba(74,222,128,0.3);
	}
	.btn:hover:not(:disabled) { box-shadow: 0 0 20px rgba(74,222,128,0.5); }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
</style>
