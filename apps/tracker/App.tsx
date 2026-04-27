import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Alert,
  ScrollView,
  ActivityIndicator,
  Animated,
} from 'react-native';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system';
import { useKeepAwake } from 'expo-keep-awake';
import { StatusBar } from 'expo-status-bar';
import { RoutePoint, HitEvent, SpawnPoint } from 'shared-types';
import { auth, db } from './firebaseConfig';
import { signInAnonymously } from 'firebase/auth';
import {
  doc, setDoc, serverTimestamp, collection, getDocs, query, where,
  updateDoc, getDoc, addDoc,
} from 'firebase/firestore';

// オフライン保存パス
const OFFLINE_CACHE_PATH = FileSystem.documentDirectory + 'offline_route.json';

// ─────────────────────────────────────────────
// 定数
// ─────────────────────────────────────────────
const TEAM_COLORS = [
  { label: 'レッド',   value: '#ef4444' },
  { label: 'ブルー',   value: '#3b82f6' },
  { label: 'グリーン', value: '#22c55e' },
  { label: 'イエロー', value: '#eab308' },
  { label: 'パープル', value: '#a855f7' },
  { label: 'オレンジ', value: '#f97316' },
];

const MAX_JUMP_METERS = 50;

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 画面の種類
// setup: 初期設定
// spawn-select: プレイヤーが自分のスポーンを選んでGPS記録
// admin-calibration: 管理者が全スポーンのGPSを記録
// tracking: GPS記録（プレイヤー or 管理者外周スキャン）
type AppScreen = 'setup' | 'spawn-select' | 'admin-calibration' | 'tracking';

// 管理者のサブモード
type AdminSubMode = 'calibration' | 'boundary';

// ─────────────────────────────────────────────
// Setup Screen
// ─────────────────────────────────────────────
interface SetupProps {
  onComplete: (name: string, color: string, team: 'A' | 'B', matchId: string, fieldId: string, spawnPoints: SpawnPoint[]) => void;
  isAdminMode: boolean;
}

function SetupScreen({ onComplete, isAdminMode }: SetupProps) {
  const [playerName, setPlayerName] = useState('');
  const [selectedColor, setSelectedColor] = useState(TEAM_COLORS[0].value);
  const [selectedTeam, setSelectedTeam] = useState<'A' | 'B'>('A');
  const [matchId, setMatchId] = useState('');
  const [activeMatches, setActiveMatches] = useState<{ id: string; fieldId: string }[]>([]);
  const [loadingMatches, setLoadingMatches] = useState(false);

  // 管理者モード
  const [adminSubMode, setAdminSubMode] = useState<AdminSubMode>('calibration');
  const [existingFields, setExistingFields] = useState<{ id: string; name: string }[]>([]);
  const [selectedFieldId, setSelectedFieldId] = useState('');
  const [newFieldName, setNewFieldName] = useState('');
  const [loadingFields, setLoadingFields] = useState(false);

  // 試合選択時にスポーン地点を自動ロード（管理者キャリブレーションモード）
  const [loadedSpawnPoints, setLoadedSpawnPoints] = useState<SpawnPoint[]>([]);
  const [loadingSpawns, setLoadingSpawns] = useState(false);

  // 試合一覧をロード（プレイヤー or 管理者キャリブレーション）
  const loadMatches = async () => {
    setLoadingMatches(true);
    try {
      const q = query(collection(db, 'matches'), where('status', 'in', ['waiting', 'playing']));
      const snap = await getDocs(q);
      const matches = snap.docs.map(d => ({ id: d.id, fieldId: (d.data().fieldId as string) || '' }));
      setActiveMatches(matches);
      if (matches.length > 0) setMatchId(matches[0].id);
    } catch (e) {
      console.warn('Failed to fetch matches:', e);
    } finally {
      setLoadingMatches(false);
    }
  };

  // フィールド一覧をロード（管理者外周スキャンモード）
  const loadFields = async () => {
    setLoadingFields(true);
    try {
      const snap = await getDocs(collection(db, 'fields'));
      const list = snap.docs.map(d => ({ id: d.id, name: (d.data().name as string) || d.id }));
      setExistingFields(list);
    } catch (e) {
      console.warn('Failed to fetch fields:', e);
    } finally {
      setLoadingFields(false);
    }
  };

  useEffect(() => {
    if (!isAdminMode) {
      loadMatches();
    }
  }, [isAdminMode]);

  useEffect(() => {
    if (isAdminMode) {
      if (adminSubMode === 'calibration') {
        loadMatches();
      } else {
        loadFields();
      }
    }
  }, [isAdminMode, adminSubMode]);

  // 試合が選択されたらスポーン地点をロード（管理者キャリブレーション用）
  const onMatchSelect = async (mid: string) => {
    setMatchId(mid);
    if (!isAdminMode || adminSubMode !== 'calibration') return;
    const match = activeMatches.find(m => m.id === mid);
    if (!match?.fieldId) return;
    setLoadingSpawns(true);
    try {
      const fieldSnap = await getDoc(doc(db, 'fields', match.fieldId));
      if (fieldSnap.exists()) {
        setLoadedSpawnPoints((fieldSnap.data().spawnPoints as SpawnPoint[]) || []);
      }
    } catch (e) {
      console.warn('Failed to load spawn points:', e);
    } finally {
      setLoadingSpawns(false);
    }
  };

  const handleStart = async () => {
    if (isAdminMode) {
      if (adminSubMode === 'calibration') {
        const mid = matchId.trim();
        if (!mid) { Alert.alert('エラー', '試合を選択してください'); return; }
        const match = activeMatches.find(m => m.id === mid);
        const fid = match?.fieldId || '';
        onComplete('admin', '#4ade80', 'A', mid, fid, loadedSpawnPoints);
      } else {
        // 外周スキャン（既存の動作）
        const fieldId = selectedFieldId || newFieldName.trim();
        if (!fieldId) { Alert.alert('エラー', 'フィールドを選択または入力してください'); return; }
        onComplete('admin', '#4ade80', 'A', fieldId, fieldId, []);
      }
    } else {
      // プレイヤー: スポーン地点を取得してからスポーン選択画面へ
      const name = playerName.trim() || `Player_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const mid = matchId.trim();
      if (!mid) { Alert.alert('エラー', '試合IDを入力してください'); return; }
      const matchEntry = activeMatches.find(m => m.id === mid);
      const fid = matchEntry?.fieldId || '';
      let spawns: SpawnPoint[] = [];
      if (fid) {
        try {
          const fieldSnap = await getDoc(doc(db, 'fields', fid));
          if (fieldSnap.exists()) {
            spawns = (fieldSnap.data().spawnPoints as SpawnPoint[]) || [];
          }
        } catch (e) {
          console.warn('Failed to fetch spawn points:', e);
        }
      }
      onComplete(name, selectedColor, selectedTeam, mid, fid, spawns);
    }
  };

  return (
    <ScrollView
      contentContainerStyle={styles.setupContainer}
      keyboardShouldPersistTaps="handled"
    >
      <StatusBar style="light" hidden={false} />

      <View style={styles.setupHeader}>
        <View style={styles.setupDot} />
        <Text style={styles.setupTitle}>Sabage Tracker</Text>
        {isAdminMode && (
          <View style={styles.adminBadge}>
            <Text style={styles.adminBadgeText}>管理者</Text>
          </View>
        )}
      </View>

      {/* 管理者モード */}
      {isAdminMode ? (
        <>
          {/* サブモード切り替え */}
          <View style={styles.subModeTabs}>
            <TouchableOpacity
              style={[styles.subModeTab, adminSubMode === 'calibration' && styles.subModeTabActive]}
              onPress={() => setAdminSubMode('calibration')}
            >
              <Text style={[styles.subModeTabText, adminSubMode === 'calibration' && styles.subModeTabTextActive]}>
                📍 スポーン記録
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.subModeTab, adminSubMode === 'boundary' && styles.subModeTabActive]}
              onPress={() => setAdminSubMode('boundary')}
            >
              <Text style={[styles.subModeTabText, adminSubMode === 'boundary' && styles.subModeTabTextActive]}>
                🗺 外周スキャン
              </Text>
            </TouchableOpacity>
          </View>

          {adminSubMode === 'calibration' ? (
            // スポーン記録モード
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>試合を選択</Text>
              <Text style={styles.fieldHint}>
                スポーン地点に立って、各スポーンのGPS位置を記録します。{'\n'}
                プレイヤーが到着する前に実施してください。
              </Text>
              {loadingMatches ? (
                <ActivityIndicator color="#4ade80" style={{ marginVertical: 8 }} />
              ) : activeMatches.length > 0 ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.matchChips}>
                  {activeMatches.map(m => (
                    <TouchableOpacity
                      key={m.id}
                      style={[styles.matchChip, matchId === m.id && styles.matchChipSelected]}
                      onPress={() => onMatchSelect(m.id)}
                    >
                      <Text style={[styles.matchChipText, matchId === m.id && styles.matchChipTextSelected]}>
                        {m.id}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              ) : (
                <Text style={styles.fieldHint}>アクティブな試合がありません。</Text>
              )}
              {loadingSpawns && <ActivityIndicator color="#4ade80" style={{ marginTop: 8 }} />}
              {loadedSpawnPoints.length > 0 && (
                <Text style={styles.spawnLoadedHint}>
                  ✓ スポーン {loadedSpawnPoints.length} 点を読み込みました
                </Text>
              )}
            </View>
          ) : (
            // 外周スキャンモード（既存）
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>境界線を登録するフィールド</Text>
              {loadingFields ? (
                <ActivityIndicator color="#4ade80" style={{ marginVertical: 8 }} />
              ) : existingFields.length > 0 ? (
                <>
                  <Text style={styles.fieldHint}>既存フィールドの境界線を上書き更新:</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.matchChips}>
                    {existingFields.map(f => (
                      <TouchableOpacity
                        key={f.id}
                        style={[styles.matchChip, selectedFieldId === f.id && styles.matchChipSelected]}
                        onPress={() => { setSelectedFieldId(f.id); setNewFieldName(''); }}
                      >
                        <Text style={[styles.matchChipText, selectedFieldId === f.id && styles.matchChipTextSelected]}>
                          {f.name}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  <Text style={styles.fieldHint}>または新規フィールド名で作成:</Text>
                </>
              ) : (
                <Text style={styles.fieldHint}>登録済みのフィールドがありません。</Text>
              )}
              <TextInput
                style={styles.input}
                value={newFieldName}
                onChangeText={text => { setNewFieldName(text); setSelectedFieldId(''); }}
                placeholder="例: 北エリア"
                placeholderTextColor="rgba(255,255,255,0.25)"
                maxLength={30}
              />
              <Text style={[styles.fieldHint, { marginTop: 12 }]}>
                スキャン開始後、フィールドの外周を歩いてください。{'\n'}
                歩き終わったら長押しで停止 → 境界線として保存されます。
              </Text>
            </View>
          )}
        </>
      ) : (
        // プレイヤーモード
        <>
          <View style={styles.field}>
            <Text style={styles.fieldLabel}>試合ID</Text>
            {loadingMatches ? (
              <ActivityIndicator color="#4ade80" style={{ marginVertical: 8 }} />
            ) : activeMatches.length > 0 ? (
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.matchChips}>
                  {activeMatches.map(m => (
                    <TouchableOpacity
                      key={m.id}
                      style={[styles.matchChip, matchId === m.id && styles.matchChipSelected]}
                      onPress={() => setMatchId(m.id)}
                    >
                      <Text style={[styles.matchChipText, matchId === m.id && styles.matchChipTextSelected]}>
                        {m.id}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
                <Text style={styles.fieldHint}>または手動入力:</Text>
              </>
            ) : (
              <Text style={styles.fieldHint}>アクティブな試合が見つかりません。IDを手動入力してください。</Text>
            )}
            <TextInput
              style={styles.input}
              value={matchId}
              onChangeText={setMatchId}
              placeholder="例: match-20240426"
              placeholderTextColor="rgba(255,255,255,0.25)"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>プレイヤー名（省略可）</Text>
            <TextInput
              style={styles.input}
              value={playerName}
              onChangeText={setPlayerName}
              placeholder="例: ハルくん"
              placeholderTextColor="rgba(255,255,255,0.25)"
              maxLength={20}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>チーム</Text>
            <View style={styles.teamRow}>
              {(['A', 'B'] as const).map(t => (
                <TouchableOpacity
                  key={t}
                  style={[styles.teamBtn, selectedTeam === t && styles.teamBtnActive]}
                  onPress={() => setSelectedTeam(t)}
                >
                  <Text style={[styles.teamBtnText, selectedTeam === t && styles.teamBtnTextActive]}>
                    チーム {t}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          <View style={styles.field}>
            <Text style={styles.fieldLabel}>チームカラー</Text>
            <View style={styles.colorGrid}>
              {TEAM_COLORS.map(c => (
                <TouchableOpacity
                  key={c.value}
                  style={[styles.colorBtn, { backgroundColor: c.value }, selectedColor === c.value && styles.colorBtnSelected]}
                  onPress={() => setSelectedColor(c.value)}
                >
                  {selectedColor === c.value && <Text style={styles.colorCheck}>✓</Text>}
                  <Text style={styles.colorLabel}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </>
      )}

      <TouchableOpacity style={styles.startBtn} onPress={handleStart}>
        <Text style={styles.startBtnText}>
          {isAdminMode
            ? (adminSubMode === 'calibration' ? 'スポーン記録を開始' : '外周スキャンを開始')
            : 'トラッキング開始'}
        </Text>
      </TouchableOpacity>

      <Text style={styles.hint}>
        {isAdminMode
          ? (adminSubMode === 'calibration'
            ? '各スポーン地点に立ってGPSを記録します\nプレイヤーが到着する前に完了させてください'
            : 'フィールドの外周を歩いてスキャンし、境界線を記録します')
          : '試合開始後、画面をタップでGPS記録を開始します\n長押しで記録を終了＆アップロードします'}
      </Text>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────
// Spawn Select Screen（プレイヤー用）
// ─────────────────────────────────────────────
interface SpawnSelectProps {
  matchId: string;
  spawnPoints: SpawnPoint[];
  playerName: string;
  teamColor: string;
  user: any;
  onComplete: (spawnId: string) => void;
}

function SpawnSelectScreen({ matchId, spawnPoints, playerName, teamColor, user, onComplete }: SpawnSelectProps) {
  const [selectedSpawnId, setSelectedSpawnId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [done, setDone] = useState(false);

  const handleRecord = async () => {
    if (!selectedSpawnId || !user) return;
    setRecording(true);
    try {
      const SAMPLES = 5;
      const lats: number[] = [];
      const lngs: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        lats.push(loc.coords.latitude);
        lngs.push(loc.coords.longitude);
        if (i < SAMPLES - 1) await new Promise(r => setTimeout(r, 800));
      }
      const avgLat = lats.reduce((a, b) => a + b, 0) / SAMPLES;
      const avgLng = lngs.reduce((a, b) => a + b, 0) / SAMPLES;

      await addDoc(collection(db, 'matches', matchId, 'calibrations'), {
        spawnId: selectedSpawnId,
        lat: avgLat,
        lng: avgLng,
        recordedAt: Date.now(),
        playerUid: user.uid,
      });

      setDone(true);
    } catch (e) {
      console.error('Spawn GPS error:', e);
      Alert.alert('エラー', 'GPS記録に失敗しました。');
    } finally {
      setRecording(false);
    }
  };

  const selectedSpawn = spawnPoints.find(s => s.id === selectedSpawnId);

  return (
    <ScrollView contentContainerStyle={styles.setupContainer} keyboardShouldPersistTaps="handled">
      <StatusBar style="light" hidden={false} />

      <View style={styles.setupHeader}>
        <View style={[styles.setupDot, { backgroundColor: teamColor }]} />
        <Text style={styles.setupTitle}>{playerName}</Text>
      </View>

      <Text style={styles.spawnSelectTitle}>自分のスポーンを選択</Text>
      <Text style={styles.spawnSelectDesc}>
        今いるスポーン地点を選んで「GPS記録」を押してください。{'\n'}
        スポーンに立った状態で押すと位置精度が上がります。
      </Text>

      <View style={styles.field}>
        {spawnPoints.map(sp => {
          const isSelected = selectedSpawnId === sp.id;
          return (
            <TouchableOpacity
              key={sp.id}
              style={[styles.spawnItem, isSelected && styles.spawnItemSelected]}
              onPress={() => { setSelectedSpawnId(sp.id); setDone(false); }}
            >
              <View style={[styles.spawnDot, isSelected && { backgroundColor: teamColor }]} />
              <Text style={[styles.spawnLabel, isSelected && styles.spawnLabelSelected]}>
                {sp.label}
              </Text>
              {isSelected && <Text style={[styles.spawnCheck, { color: teamColor }]}>✓</Text>}
            </TouchableOpacity>
          );
        })}
      </View>

      {!done ? (
        <TouchableOpacity
          style={[styles.recordBtn, (!selectedSpawnId || recording) && styles.recordBtnDisabled]}
          onPress={handleRecord}
          disabled={!selectedSpawnId || recording}
        >
          {recording ? (
            <>
              <ActivityIndicator color="#000" />
              <Text style={[styles.recordBtnText, { marginLeft: 8 }]}>5回サンプリング中...</Text>
            </>
          ) : (
            <Text style={styles.recordBtnText}>
              📍 {selectedSpawn ? `「${selectedSpawn.label}」` : 'スポーン'}のGPSを記録
            </Text>
          )}
        </TouchableOpacity>
      ) : (
        <View style={styles.doneCard}>
          <Text style={styles.doneIcon}>✓</Text>
          <Text style={styles.doneText}>「{selectedSpawn?.label}」のGPSを記録しました</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.startBtn, { marginTop: 16, opacity: done ? 1 : 0.4 }]}
        onPress={() => done && selectedSpawnId && onComplete(selectedSpawnId)}
        disabled={!done || !selectedSpawnId}
      >
        <Text style={styles.startBtnText}>トラッキング開始 →</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.skipBtn} onPress={() => onComplete(selectedSpawnId ?? '')}>
        <Text style={styles.skipBtnText}>スキップして開始</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────
// Admin Calibration Screen
// ─────────────────────────────────────────────
interface AdminCalibrationProps {
  matchId: string;
  spawnPoints: SpawnPoint[];
  user: any;
  onDone: () => void;
}

function AdminCalibrationScreen({ matchId, spawnPoints, user, onDone }: AdminCalibrationProps) {
  const [selectedSpawnId, setSelectedSpawnId] = useState<string | null>(
    spawnPoints.length > 0 ? spawnPoints[0].id : null
  );
  const [recording, setRecording] = useState(false);
  const [recorded, setRecorded] = useState<Set<string>>(new Set());

  const handleRecord = async () => {
    if (!selectedSpawnId || !user) return;
    setRecording(true);
    try {
      const SAMPLES = 5;
      const lats: number[] = [];
      const lngs: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        lats.push(loc.coords.latitude);
        lngs.push(loc.coords.longitude);
        if (i < SAMPLES - 1) await new Promise(r => setTimeout(r, 800));
      }
      const avgLat = lats.reduce((a, b) => a + b, 0) / SAMPLES;
      const avgLng = lngs.reduce((a, b) => a + b, 0) / SAMPLES;

      await addDoc(collection(db, 'matches', matchId, 'calibrations'), {
        spawnId: selectedSpawnId,
        lat: avgLat,
        lng: avgLng,
        recordedAt: Date.now(),
        playerUid: user.uid,
      });

      const newRecorded = new Set([...recorded, selectedSpawnId]);
      setRecorded(newRecorded);

      // 次の未記録スポーンを自動選択
      const next = spawnPoints.find(sp => !newRecorded.has(sp.id));
      if (next) {
        setSelectedSpawnId(next.id);
        Alert.alert('記録完了 ✓', `「${spawnPoints.find(s => s.id === selectedSpawnId)?.label}」を記録しました。\n次のスポーンへ移動してください。`);
      } else {
        Alert.alert('全スポーン記録完了！', 'すべてのスポーンのGPSを記録しました。');
      }
    } catch (e) {
      console.error('Calibration error:', e);
      Alert.alert('エラー', 'GPS記録に失敗しました。');
    } finally {
      setRecording(false);
    }
  };

  const allDone = spawnPoints.length > 0 && recorded.size >= spawnPoints.length;

  return (
    <ScrollView
      contentContainerStyle={styles.setupContainer}
      keyboardShouldPersistTaps="handled"
    >
      <StatusBar style="light" hidden={false} />

      <View style={styles.setupHeader}>
        <View style={styles.setupDot} />
        <Text style={styles.setupTitle}>スポーン記録</Text>
        <View style={styles.adminBadge}>
          <Text style={styles.adminBadgeText}>管理者</Text>
        </View>
      </View>

      <View style={styles.calibProgress}>
        <Text style={styles.calibProgressText}>
          {recorded.size} / {spawnPoints.length} スポーン記録済み
        </Text>
        <View style={styles.calibProgressBar}>
          <View style={[
            styles.calibProgressFill,
            { width: spawnPoints.length > 0 ? `${(recorded.size / spawnPoints.length) * 100}%` : '0%' }
          ]} />
        </View>
      </View>

      <Text style={styles.calibDesc}>
        各スポーン地点に実際に立って「GPS記録」を押してください。{'\n'}
        5回サンプリングして平均を取るので数秒かかります。
      </Text>

      <View style={styles.field}>
        <Text style={styles.fieldLabel}>スポーン地点を選択</Text>
        {spawnPoints.length === 0 ? (
          <Text style={styles.fieldHint}>このフィールドにはスポーン地点が設定されていません。{'\n'}viewer でフィールドを編集してスポーンを追加してください。</Text>
        ) : (
          spawnPoints.map(sp => {
            const isSelected = selectedSpawnId === sp.id;
            const isDone = recorded.has(sp.id);
            return (
              <TouchableOpacity
                key={sp.id}
                style={[styles.spawnItem, isSelected && styles.spawnItemSelected, isDone && styles.spawnItemDone]}
                onPress={() => setSelectedSpawnId(sp.id)}
              >
                <View style={[styles.spawnDot, isDone && styles.spawnDotDone]} />
                <Text style={[styles.spawnLabel, isSelected && styles.spawnLabelSelected]}>
                  {sp.label}
                </Text>
                {isDone && <Text style={styles.spawnCheck}>✓</Text>}
              </TouchableOpacity>
            );
          })
        )}
      </View>

      {spawnPoints.length > 0 && (
        <TouchableOpacity
          style={[styles.recordBtn, (!selectedSpawnId || recording) && styles.recordBtnDisabled]}
          onPress={handleRecord}
          disabled={!selectedSpawnId || recording}
        >
          {recording ? (
            <>
              <ActivityIndicator color="#000" />
              <Text style={[styles.recordBtnText, { marginLeft: 8 }]}>5回サンプリング中...</Text>
            </>
          ) : (
            <Text style={styles.recordBtnText}>
              📍 {spawnPoints.find(s => s.id === selectedSpawnId)?.label ?? 'スポーン'}のGPSを記録
            </Text>
          )}
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={[styles.startBtn, { marginTop: 16, opacity: recorded.size === 0 ? 0.4 : 1 }]}
        onPress={onDone}
        disabled={recorded.size === 0}
      >
        <Text style={styles.startBtnText}>
          {allDone ? '✓ 記録完了 — 設定に戻る' : `記録済み ${recorded.size}点で完了する`}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.skipBtn} onPress={onDone}>
        <Text style={styles.skipBtnText}>キャンセルして戻る</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

// ─────────────────────────────────────────────
// Tracking Screen
// ─────────────────────────────────────────────
interface TrackingProps {
  playerName: string;
  teamColor: string;
  team: 'A' | 'B';
  matchId: string;
  spawnId?: string;
  isAdminMode: boolean;
  user: any;
  onBack: () => void;
}

function TrackingScreen({ playerName, teamColor, team, matchId, spawnId, isAdminMode, user, onBack }: TrackingProps) {
  useKeepAwake();

  const [isTracking, setIsTracking] = useState(false);
  const [route, setRoute] = useState<RoutePoint[]>([]);
  const [lastLocation, setLastLocation] = useState<Location.LocationObject | null>(null);
  const subscription = useRef<Location.LocationSubscription | null>(null);
  const lastRoutePoint = useRef<RoutePoint | null>(null);

  // リアルタイム同期用
  const routeRef = useRef<RoutePoint[]>([]);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hintOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    return () => {
      if (subscription.current) subscription.current.remove();
    };
  }, []);

  useEffect(() => {
    if (!isTracking) {
      hintOpacity.setValue(0);
      return;
    }
    const fadeIn = Animated.timing(hintOpacity, { toValue: 1, duration: 800, delay: 3000, useNativeDriver: true });
    const fadeOut = Animated.timing(hintOpacity, { toValue: 0, duration: 800, delay: 5000, useNativeDriver: true });
    Animated.sequence([fadeIn, fadeOut]).start();
  }, [isTracking]);

  const startTracking = async () => {
    setIsTracking(true);
    setRoute([]);
    routeRef.current = [];
    lastRoutePoint.current = null;

    // プレイヤーモードのみ: Firestoreにドキュメントを初期化して定期同期開始
    if (!isAdminMode && user) {
      const logRef = doc(db, 'matches', matchId, 'player_logs', user.uid);
      try {
        await setDoc(logRef, {
          name: playerName,
          teamColor,
          team,
          route: [],
          lastPosition: null,
          ...(spawnId ? { spawnId } : {}),
          startedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // 5秒ごとにルートと最新位置をFirestoreへ同期、オフラインキャッシュも更新
        syncIntervalRef.current = setInterval(async () => {
          const currentRoute = routeRef.current;
          if (currentRoute.length === 0) return;
          const lastPoint = currentRoute[currentRoute.length - 1];
          // オフラインキャッシュ保存
          try {
            await FileSystem.writeAsStringAsync(
              OFFLINE_CACHE_PATH,
              JSON.stringify({ matchId, playerName, teamColor, team, spawnId, route: currentRoute }),
            );
          } catch (_) {}
          // Firestoreへ同期
          try {
            await updateDoc(logRef, {
              route: currentRoute,
              lastPosition: lastPoint,
              updatedAt: serverTimestamp(),
            });
          } catch (e) {
            console.warn('Sync failed (offline?):', e);
          }
        }, 5000);
      } catch (e) {
        console.warn('Failed to init player log:', e);
      }
    }

    subscription.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 3 },
      (location) => {
        setLastLocation(location);
        const newPoint: RoutePoint = {
          lat: location.coords.latitude,
          lng: location.coords.longitude,
          timestamp: location.timestamp,
        };
        if (lastRoutePoint.current) {
          const d = haversineDistance(
            lastRoutePoint.current.lat, lastRoutePoint.current.lng,
            newPoint.lat, newPoint.lng
          );
          if (d > MAX_JUMP_METERS) return;
        }
        lastRoutePoint.current = newPoint;
        routeRef.current = [...routeRef.current, newPoint];
        setRoute(routeRef.current);
      }
    );
  };

  const stopSubscription = () => {
    if (subscription.current) {
      subscription.current.remove();
      subscription.current = null;
    }
    if (syncIntervalRef.current) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    setIsTracking(false);
  };

  const uploadData = async (hitEvent?: HitEvent) => {
    if (!user) { Alert.alert('Error', 'Not authenticated'); return; }
    const finalRoute = routeRef.current.length > 0 ? routeRef.current : route;
    if (finalRoute.length === 0) { Alert.alert('Info', 'No route data'); return; }

    const logRef = doc(db, 'matches', matchId, 'player_logs', user.uid);
    const lastPoint = finalRoute[finalRoute.length - 1];
    try {
      await setDoc(logRef, {
        name: playerName,
        teamColor,
        team,
        route: finalRoute,
        lastPosition: lastPoint,
        ...(spawnId ? { spawnId } : {}),
        ...(hitEvent ? { hitEvent } : {}),
        finishedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      // アップロード成功 → オフラインキャッシュを削除
      try { await FileSystem.deleteAsync(OFFLINE_CACHE_PATH, { idempotent: true }); } catch (_) {}
      if (hitEvent) {
        Alert.alert('💀 ヒット記録完了', 'データを保存しました。', [{ text: 'OK', onPress: onBack }]);
      } else {
        Alert.alert('完了', 'ルートを保存しました！', [{ text: 'OK', onPress: onBack }]);
      }
    } catch (error) {
      console.error('Upload Error:', error);
      Alert.alert('エラー', 'アップロードに失敗しました。\nオフラインの場合は再接続後にリトライしてください。');
    }
  };

  const saveField = async () => {
    if (route.length < 3) { Alert.alert('エラー', '境界線には3点以上必要です。'); return; }
    const boundary = route.map(p => ({ lat: p.lat, lng: p.lng }));
    try {
      const fieldRef = doc(db, 'fields', matchId);
      await setDoc(fieldRef, {
        name: matchId,
        boundary,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      Alert.alert('完了', `${route.length}点の境界線を保存しました！`, [{ text: 'OK', onPress: onBack }]);
    } catch {
      Alert.alert('エラー', '保存に失敗しました。');
    }
  };

  const stopTracking = () => {
    stopSubscription();
    if (isAdminMode) {
      Alert.alert('スキャン完了', `${route.length}点を記録しました。`, [
        { text: '破棄', style: 'destructive', onPress: () => setRoute([]) },
        { text: '境界線として保存', onPress: saveField },
      ]);
    } else {
      Alert.alert('トラッキング完了', `${route.length}点を記録しました。アップロードしますか？`, [
        { text: '破棄', style: 'destructive', onPress: () => setRoute([]) },
        { text: 'アップロード', onPress: () => uploadData() },
      ]);
    }
  };

  const handleHit = () => {
    if (!isTracking) return;
    Alert.alert(
      '💀 ヒット',
      '撃たれましたか？ヒットを記録してトラッキングを終了します。',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: 'ヒット確定',
          style: 'destructive',
          onPress: () => {
            const hitEvent: HitEvent = {
              lat: lastLocation?.coords.latitude ?? route[route.length - 1]?.lat ?? 0,
              lng: lastLocation?.coords.longitude ?? route[route.length - 1]?.lng ?? 0,
              timestamp: Date.now(),
            };
            stopSubscription();
            uploadData(hitEvent);
          },
        },
      ]
    );
  };

  return (
    <View style={styles.trackingContainer}>
      <StatusBar style="light" hidden={true} />

      <TouchableOpacity
        style={styles.upperZone}
        onPress={isTracking ? undefined : startTracking}
        onLongPress={isTracking ? stopTracking : undefined}
        delayLongPress={600}
        activeOpacity={1}
      >
        {isTracking && (
          <View style={[styles.indicator, isAdminMode && styles.adminIndicator]} />
        )}
        {!isTracking && (
          <Text style={styles.tapHint}>タップして開始</Text>
        )}
        {isTracking && (
          <Animated.Text style={[styles.longPressHint, { opacity: hintOpacity }]}>
            長押しで終了
          </Animated.Text>
        )}
      </TouchableOpacity>

      {isTracking && !isAdminMode && (
        <TouchableOpacity
          style={styles.hitZone}
          onLongPress={handleHit}
          delayLongPress={600}
          activeOpacity={1}
        >
          <Text style={styles.hitIcon}>💀</Text>
          <Text style={styles.hitLabel}>長押し: ヒット</Text>
        </TouchableOpacity>
      )}

      {!isTracking && (
        <TouchableOpacity style={styles.backBtn} onPress={onBack}>
          <Text style={styles.backBtnText}>← 設定に戻る</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState<AppScreen>('setup');
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [user, setUser] = useState<any>(null);

  const [playerName, setPlayerName] = useState('');
  const [teamColor, setTeamColor] = useState(TEAM_COLORS[0].value);
  const [playerTeam, setPlayerTeam] = useState<'A' | 'B'>('A');
  const [matchId, setMatchId] = useState('');
  const [fieldId, setFieldId] = useState('');
  const [spawnPoints, setSpawnPoints] = useState<SpawnPoint[]>([]);
  const [selectedSpawnId, setSelectedSpawnId] = useState<string>('');

  useEffect(() => {
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Error', 'Location permission is required for tracking.');
      }
      try {
        const cred = await signInAnonymously(auth);
        setUser(cred.user);
      } catch (error) {
        Alert.alert('Auth Error', 'Failed to login to Firebase.');
      }
      // オフラインキャッシュの確認
      try {
        const info = await FileSystem.getInfoAsync(OFFLINE_CACHE_PATH);
        if (info.exists) {
          Alert.alert(
            '未送信データあり',
            '前回の試合データが保存されています。アップロードしますか？',
            [
              { text: '破棄', style: 'destructive', onPress: () => FileSystem.deleteAsync(OFFLINE_CACHE_PATH, { idempotent: true }) },
              { text: 'アップロード', onPress: async () => {
                try {
                  const raw = await FileSystem.readAsStringAsync(OFFLINE_CACHE_PATH);
                  const cached = JSON.parse(raw);
                  const cred2 = await signInAnonymously(auth);
                  const logRef = doc(db, 'matches', cached.matchId, 'player_logs', cred2.user.uid);
                  await setDoc(logRef, {
                    name: cached.playerName,
                    teamColor: cached.teamColor,
                    team: cached.team ?? 'A',
                    route: cached.route,
                    lastPosition: cached.route[cached.route.length - 1] ?? null,
                    ...(cached.spawnId ? { spawnId: cached.spawnId } : {}),
                    updatedAt: serverTimestamp(),
                  });
                  await FileSystem.deleteAsync(OFFLINE_CACHE_PATH, { idempotent: true });
                  Alert.alert('完了', 'オフラインデータをアップロードしました。');
                } catch (e) {
                  Alert.alert('エラー', 'アップロードに失敗しました。');
                }
              }},
            ]
          );
        }
      } catch (_) {}
    })();
  }, []);

  const handleSetupComplete = (
    name: string, color: string, team: 'A' | 'B', mid: string, fid: string, spawns: SpawnPoint[]
  ) => {
    setPlayerName(name);
    setTeamColor(color);
    setPlayerTeam(team);
    setMatchId(mid);
    setFieldId(fid);
    setSpawnPoints(spawns);

    if (isAdminMode && spawns.length >= 1) {
      // 管理者 + スポーン地点あり → 管理者キャリブレーション画面へ
      setScreen('admin-calibration');
    } else if (!isAdminMode && spawns.length >= 1) {
      // プレイヤー + スポーン地点あり → スポーン選択画面へ
      setScreen('spawn-select');
    } else {
      // 管理者外周スキャン or スポーン未設定 → 直接トラッキングへ
      setScreen('tracking');
    }
  };

  const handleSpawnSelected = (spawnId: string) => {
    setSelectedSpawnId(spawnId);
    setScreen('tracking');
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <TouchableOpacity
        style={styles.adminToggle}
        onLongPress={() => {
          setIsAdminMode(prev => !prev);
          Alert.alert('モード切替', `${!isAdminMode ? '管理者' : 'プレイヤー'}モードに切り替えました`);
        }}
      />

      {screen === 'setup' && (
        <SetupScreen
          onComplete={handleSetupComplete}
          isAdminMode={isAdminMode}
        />
      )}
      {screen === 'spawn-select' && (
        <SpawnSelectScreen
          matchId={matchId}
          spawnPoints={spawnPoints}
          playerName={playerName}
          teamColor={teamColor}
          user={user}
          onComplete={handleSpawnSelected}
        />
      )}
      {screen === 'admin-calibration' && (
        <AdminCalibrationScreen
          matchId={matchId}
          spawnPoints={spawnPoints}
          user={user}
          onDone={() => setScreen('setup')}
        />
      )}
      {screen === 'tracking' && (
        <TrackingScreen
          playerName={playerName}
          teamColor={teamColor}
          team={playerTeam}
          matchId={matchId}
          spawnId={selectedSpawnId}
          isAdminMode={isAdminMode}
          user={user}
          onBack={() => setScreen('setup')}
        />
      )}
    </View>
  );
}

// ─────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────
const styles = StyleSheet.create({
  // ── Setup ──────────────────────────────────
  setupContainer: {
    flexGrow: 1,
    backgroundColor: '#0a0a0a',
    padding: 28,
    paddingTop: 70,
    paddingBottom: 48,
  },
  setupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 32,
  },
  setupDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#4ade80',
  },
  setupTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  adminBadge: {
    backgroundColor: 'rgba(74, 222, 128, 0.15)',
    borderColor: 'rgba(74, 222, 128, 0.4)',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginLeft: 4,
  },
  adminBadgeText: {
    color: '#4ade80',
    fontSize: 11,
    fontWeight: '600',
  },

  // ── サブモードタブ ────────────────────────
  subModeTabs: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  subModeTab: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  subModeTabActive: {
    backgroundColor: 'rgba(74,222,128,0.1)',
    borderColor: 'rgba(74,222,128,0.4)',
  },
  subModeTabText: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    fontWeight: '600',
  },
  subModeTabTextActive: {
    color: '#4ade80',
  },

  field: {
    marginBottom: 24,
  },
  fieldLabel: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  fieldHint: {
    color: 'rgba(255,255,255,0.3)',
    fontSize: 12,
    marginTop: 4,
    marginBottom: 8,
    lineHeight: 18,
  },
  spawnLoadedHint: {
    color: '#4ade80',
    fontSize: 12,
    marginTop: 8,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 10,
    color: '#fff',
    fontSize: 15,
    padding: 14,
  },
  matchChips: {
    flexDirection: 'row',
    marginBottom: 6,
  },
  matchChip: {
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
    marginRight: 8,
  },
  matchChipSelected: {
    borderColor: '#4ade80',
    backgroundColor: 'rgba(74, 222, 128, 0.12)',
  },
  matchChipText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    fontFamily: 'Courier',
  },
  matchChipTextSelected: {
    color: '#4ade80',
  },
  teamRow: {
    flexDirection: 'row',
    gap: 10,
  },
  teamBtn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  teamBtnActive: {
    borderColor: '#4ade80',
    backgroundColor: 'rgba(74,222,128,0.12)',
  },
  teamBtnText: {
    fontSize: 15,
    fontWeight: '700',
    color: 'rgba(255,255,255,0.4)',
  },
  teamBtnTextActive: {
    color: '#4ade80',
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  colorBtn: {
    width: 80,
    height: 52,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorBtnSelected: {
    borderColor: '#fff',
  },
  colorCheck: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    position: 'absolute',
    top: 4,
    right: 6,
  },
  colorLabel: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 16,
  },
  startBtn: {
    backgroundColor: '#4ade80',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
    marginBottom: 16,
  },
  startBtnText: {
    color: '#000',
    fontSize: 16,
    fontWeight: '700',
  },
  hint: {
    color: 'rgba(255,255,255,0.25)',
    fontSize: 12,
    textAlign: 'center',
    lineHeight: 18,
  },

  // ── Spawn Select ───────────────────────────
  spawnSelectTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 8,
  },
  spawnSelectDesc: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 28,
  },
  doneCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(74,222,128,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(74,222,128,0.35)',
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
  },
  doneIcon: {
    color: '#4ade80',
    fontSize: 18,
    fontWeight: '700',
  },
  doneText: {
    color: '#4ade80',
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
  },

  // ── Admin Calibration ───────────────────────
  calibProgress: {
    marginBottom: 16,
    gap: 8,
  },
  calibProgressText: {
    color: '#4ade80',
    fontSize: 13,
    fontWeight: '600',
  },
  calibProgressBar: {
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  calibProgressFill: {
    height: '100%',
    backgroundColor: '#4ade80',
    borderRadius: 2,
  },
  calibDesc: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 24,
  },
  spawnItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 12,
    marginBottom: 10,
  },
  spawnItemSelected: {
    borderColor: '#4ade80',
    backgroundColor: 'rgba(74,222,128,0.08)',
  },
  spawnItemDone: {
    borderColor: 'rgba(74,222,128,0.35)',
    backgroundColor: 'rgba(74,222,128,0.04)',
  },
  spawnDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  spawnDotDone: {
    backgroundColor: '#4ade80',
  },
  spawnLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    flex: 1,
  },
  spawnLabelSelected: {
    color: '#4ade80',
    fontWeight: '600',
  },
  spawnCheck: {
    color: '#4ade80',
    fontSize: 16,
    fontWeight: '700',
  },
  recordBtn: {
    backgroundColor: '#4ade80',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
  recordBtnDisabled: {
    opacity: 0.35,
  },
  recordBtnText: {
    color: '#000',
    fontSize: 15,
    fontWeight: '700',
  },
  skipBtn: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  skipBtnText: {
    color: 'rgba(255,255,255,0.2)',
    fontSize: 12,
  },

  // ── Tracking ───────────────────────────────
  trackingContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  upperZone: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#000',
  },
  tapHint: {
    color: 'rgba(255,255,255,0.12)',
    fontSize: 14,
    letterSpacing: 1,
  },
  longPressHint: {
    color: 'rgba(255,255,255,0.15)',
    fontSize: 13,
    letterSpacing: 0.5,
    position: 'absolute',
    bottom: 20,
  },
  hitZone: {
    height: '35%',
    alignItems: 'center',
    justifyContent: 'center',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.04)',
    backgroundColor: '#000',
    gap: 8,
  },
  hitIcon: {
    fontSize: 32,
    opacity: 0.15,
  },
  hitLabel: {
    color: 'rgba(255,255,255,0.1)',
    fontSize: 12,
    letterSpacing: 1,
  },
  indicator: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#330000',
    position: 'absolute',
    top: 40,
    right: 20,
  },
  adminIndicator: {
    backgroundColor: '#003300',
  },
  backBtn: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
  },
  backBtnText: {
    color: 'rgba(255,255,255,0.2)',
    fontSize: 13,
  },

  // ── 共通 ───────────────────────────────────
  adminToggle: {
    height: 60,
    width: '100%',
    position: 'absolute',
    top: 0,
    zIndex: 10,
  },
});
