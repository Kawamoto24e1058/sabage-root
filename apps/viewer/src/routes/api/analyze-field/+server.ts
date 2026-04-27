import { env } from '$env/dynamic/private';
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

const GEMINI_URL =
	'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const PROMPT = `あなたはサバゲーフィールドの図面解析AIです。
以下の手順で画像を分析し、JSONのみ返してください（説明文・コードブロック不要）。

【手順1: 図面領域の特定】
画像内に地図や図面が描かれた紙・画面が含まれる場合、その紙自体の端ではなく、
紙の中に描かれた「プレイエリアを囲む最も外側の壁・フェンス・境界線」を探してください。
紙の縁・余白・グリッド線は境界ではありません。

【手順2: 外周の抽出】
フィールドの外周（プレイヤーが歩ける範囲を囲む最外壁）を多角形で表します。
- 角や突起に合わせてなるべく忠実にトレースする
- 点数は形状の複雑さに応じて 10〜30 点
- 時計回り

【手順3: 主要な障害物の抽出】
プレイヤーが隠れられる大きな壁・バリケードのみ（最大10件）。
細かい家具・文字・グリッド線は含めない。

返却フォーマット（座標は画像全体の左上=0,0 右下=1,1 の正規化値）:
{
  "boundary": [{"x": 0.15, "y": 0.10}, ...],
  "obstacles": [
    {"points": [{"x": 0.30, "y": 0.40}, {"x": 0.50, "y": 0.40}]}
  ]
}

認識できない場合: {"boundary": [], "obstacles": []}`;

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (!body?.imageBase64 || !body?.mimeType) {
		throw error(400, 'imageBase64 and mimeType are required');
	}

	const GEMINI_API_KEY = env.GEMINI_API_KEY;
	if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
		throw error(500, 'GEMINI_API_KEY is not configured. Add it to .env');
	}

	const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			contents: [
				{
					parts: [
						{ text: PROMPT },
						{ inlineData: { mimeType: body.mimeType, data: body.imageBase64 } }
					]
				}
			],
			generationConfig: {
				temperature: 0,
				responseMimeType: 'application/json'
			}
		})
	});

	if (!res.ok) {
		const errText = await res.text();
		console.error('Gemini API error:', errText);
		throw error(502, `Gemini API returned ${res.status}`);
	}

	const geminiRes = await res.json();
	const rawText: string =
		geminiRes?.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

	// JSON部分だけ抽出（```json ... ``` ブロックが返ることがある）
	const jsonMatch = rawText.match(/\{[\s\S]*\}/);
	const jsonStr = jsonMatch ? jsonMatch[0] : '{}';

	try {
		const parsed = JSON.parse(jsonStr);
		return json({
			boundary: Array.isArray(parsed.boundary) ? parsed.boundary : [],
			obstacles: Array.isArray(parsed.obstacles) ? parsed.obstacles : []
		});
	} catch {
		return json({ boundary: [], obstacles: [] });
	}
};
