import { useState, useEffect } from 'react';
import { socket } from '../socket';
import { CumulativeStat } from '../types';
import { useLocale, t, setLocale } from '../i18n';
import RulesModal from './RulesModal';
import LegalModal from './LegalModal';
import WelcomeModal from './WelcomeModal';

const ONBOARDED_KEY = 'hit101-onboarded';

interface Props {
  onCreateRoom: (name: string, avatar: string) => void;
  onJoinRoom: (name: string, roomId: string, avatar: string) => void;
  onJoinMatchmaking: (name: string, avatar: string) => void;
  error: string;
  onClearError: () => void;
  myUUID: string;
  onOpenLeaderboard: () => void;
}

type Mode = 'menu' | 'create' | 'join' | 'matchmaking';

const sanitizeName = (n: string) => n.replace(/[\x00-\x1F\x7F]/g, '').trim();
const AVATAR_OPTIONS = ['🃏', '🎴', '👑', '🎩', '🦊', '🐯', '🐺', '🦁', '🐉', '🦅', '🦈', '🐙', '🦄', '🤖', '👻', '😎', '🥸', '🤠'];
const AVATAR_KEY = 'hit101-avatar';

export default function Lobby({ onCreateRoom, onJoinRoom, onJoinMatchmaking, error, onClearError, myUUID, onOpenLeaderboard }: Props) {
  const [locale] = useLocale();
  const [mode, setMode] = useState<Mode>('menu');
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState('');
  const [myStats, setMyStats] = useState<CumulativeStat | null>(null);
  const [showRules, setShowRules] = useState(false);
  const [legalTab, setLegalTab] = useState<'privacy' | 'terms' | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [avatar, setAvatar] = useState('🃏');

  // 送信時のみサニタイズ (入力中は変換しない = iOS Safari が制御inputと干渉しない)
  const normalizeRoomId = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

  // 招待リンク経由 (?room=XXX) なら自動でルーム参加モードに移行
  // 初回訪問なら WelcomeModal 表示
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const invited = params.get('room');
      if (invited && /^[A-Z0-9]{4,6}$/i.test(invited)) {
        setRoomId(invited.toUpperCase());
        setMode('join');
      }
      if (!localStorage.getItem(ONBOARDED_KEY)) {
        setShowWelcome(true);
      }
      const savedAvatar = localStorage.getItem(AVATAR_KEY);
      if (savedAvatar && AVATAR_OPTIONS.includes(savedAvatar)) setAvatar(savedAvatar);
    } catch {}
  }, []);

  function chooseAvatar(a: string) {
    setAvatar(a);
    try { localStorage.setItem(AVATAR_KEY, a); } catch {}
  }

  function dismissWelcome() {
    try { localStorage.setItem(ONBOARDED_KEY, '1'); } catch {}
    setShowWelcome(false);
  }

  useEffect(() => {
    if (mode !== 'matchmaking' || !myUUID) return;

    const fetchStats = () => {
      socket.emit('get-player-stats', { uuid: myUUID }, (stats: CumulativeStat | null) => {
        setMyStats(stats);
      });
    };

    if (socket.connected) {
      fetchStats();
    } else {
      socket.connect();
      socket.once('connect', fetchStats);
    }

    return () => { socket.off('connect', fetchStats); };
  }, [mode, myUUID]);

  function handleModeChange(m: Mode) {
    onClearError();
    setMode(m);
  }

  return (
    <div className="flex flex-col" style={{ minHeight: '100dvh' }}>
      {/* 言語切替: viewport 固定 (リロード時の高さ揺れに影響されない) */}
      <div className="fixed right-3 flex gap-1 text-xs z-20" style={{ top: 'calc(0.75rem + env(safe-area-inset-top))' }}>
        <button
          onClick={() => setLocale('ja')}
          className={`px-2.5 py-1 rounded-lg backdrop-blur-sm ${locale === 'ja' ? 'bg-yellow-500 text-black font-bold' : 'bg-green-800/70 text-green-200'}`}
        >🇯🇵 JA</button>
        <button
          onClick={() => setLocale('en')}
          className={`px-2.5 py-1 rounded-lg backdrop-blur-sm ${locale === 'en' ? 'bg-yellow-500 text-black font-bold' : 'bg-green-800/70 text-green-200'}`}
        >🇺🇸 EN</button>
      </div>

      {/* メインエリア: flex-1 で残り高さを取る + 内側で中央寄せ */}
      <main className="flex-1 flex items-center justify-center p-4 relative">
        {/* 装飾: スポットライト風オーラ */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute top-1/3 left-1/2 -translate-x-1/2 w-[40rem] h-[40rem] rounded-full opacity-25 blur-3xl" style={{ background: 'radial-gradient(circle, rgba(250,204,21,0.5) 0%, transparent 70%)' }} />
        </div>

      <div className="bg-green-800 rounded-3xl p-8 shadow-2xl w-full max-w-sm border border-yellow-500/20 relative z-10">
        {/* タイトル */}
        <div className="text-center mb-7">
          <div className="text-6xl mb-3 drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)]">🃏</div>
          <h1 className="text-5xl font-black tracking-tight">
            <span className="gold-shimmer">{t('lobby.title')}101</span>
          </h1>
          <p className="text-green-300 mt-2 text-sm tracking-wide">{t('lobby.tagline')}</p>
        </div>

        {mode === 'menu' && (
          <div className="space-y-3">
            <button
              onClick={() => handleModeChange('create')}
              className="group w-full bg-yellow-500 text-black font-bold py-4 rounded-xl text-base shadow-lg flex items-center justify-center gap-3"
            >
              <span className="text-2xl group-hover:rotate-12 transition-transform">🎴</span>
              {t('lobby.create')}
            </button>
            <button
              onClick={() => handleModeChange('join')}
              className="group w-full bg-gradient-to-b from-blue-400 to-blue-600 hover:brightness-110 text-white font-bold py-4 rounded-xl text-base shadow-lg flex items-center justify-center gap-3"
              style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15)' }}
            >
              <span className="text-2xl group-hover:translate-x-1 transition-transform">🚪</span>
              {t('lobby.join')}
            </button>
            <button
              onClick={() => handleModeChange('matchmaking')}
              className="group w-full bg-gradient-to-b from-purple-500 to-purple-700 hover:brightness-110 text-white font-bold py-4 rounded-xl text-base shadow-lg flex items-center justify-center gap-3"
              style={{ boxShadow: '0 2px 8px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.15)' }}
            >
              <span className="text-2xl group-hover:scale-110 transition-transform">🔍</span>
              {t('lobby.matchmaking')}
            </button>
            <button
              onClick={() => setShowRules(true)}
              className="w-full bg-green-700/60 hover:bg-green-700 text-green-200 font-bold py-2.5 rounded-xl text-sm transition-all border border-green-600/50"
            >
              {t('lobby.rules')}
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="space-y-4">
            <h2 className="text-white text-xl font-bold">{t('lobby.create.title')}</h2>
            <div>
              <label className="text-green-300 text-sm block mb-1">{t('lobby.playerName')}</label>
              <input
                type="text"
                placeholder={t('lobby.playerName.placeholder')}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sanitizeName(name) && onCreateRoom(sanitizeName(name), avatar)}
                className="w-full px-4 py-3 rounded-lg bg-green-700 text-white placeholder-green-500 focus:outline-none focus:ring-2 focus:ring-yellow-400 transition"
                maxLength={20}
                autoFocus
              />
            </div>
            <AvatarPicker avatar={avatar} onChoose={chooseAvatar} />
            <button
              onClick={() => sanitizeName(name) && onCreateRoom(sanitizeName(name), avatar)}
              disabled={!sanitizeName(name)}
              className="w-full bg-yellow-500 hover:bg-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 text-black font-bold py-3 rounded-xl transition-all duration-150"
            >
              {t('lobby.create.button')}
            </button>
            <button
              onClick={() => handleModeChange('menu')}
              className="w-full text-green-400 hover:text-white text-sm transition py-1"
            >
              {t('lobby.back')}
            </button>
          </div>
        )}

        {mode === 'join' && (
          <div className="space-y-4">
            <h2 className="text-white text-xl font-bold">{t('lobby.join.title')}</h2>
            <div>
              <label className="text-green-300 text-sm block mb-1">{t('lobby.playerName')}</label>
              <input
                type="text"
                placeholder={t('lobby.playerName.placeholder')}
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full px-4 py-3 rounded-lg bg-green-700 text-white placeholder-green-500 focus:outline-none focus:ring-2 focus:ring-blue-400 transition"
                maxLength={20}
                autoFocus
              />
            </div>
            <div>
              <label className="text-green-300 text-sm block mb-1">{t('lobby.roomId')}</label>
              <input
                type="text"
                placeholder={t('lobby.roomId.placeholder')}
                value={roomId}
                onChange={e => setRoomId(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sanitizeName(name) && normalizeRoomId(roomId).length >= 4 && onJoinRoom(sanitizeName(name), normalizeRoomId(roomId), avatar)}
                className="w-full px-4 py-3 rounded-lg bg-green-700 text-white placeholder-green-500 focus:outline-none focus:ring-2 focus:ring-blue-400 transition font-mono tracking-widest text-center text-lg uppercase"
                maxLength={6}
              />
            </div>
            <AvatarPicker avatar={avatar} onChoose={chooseAvatar} />
            <button
              onClick={() => sanitizeName(name) && normalizeRoomId(roomId).length >= 4 && onJoinRoom(sanitizeName(name), normalizeRoomId(roomId), avatar)}
              disabled={!sanitizeName(name) || normalizeRoomId(roomId).length < 4}
              className="w-full bg-blue-500 hover:bg-blue-400 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 text-white font-bold py-3 rounded-xl transition-all duration-150"
            >
              {t('lobby.join.button')}
            </button>
            <button
              onClick={() => handleModeChange('menu')}
              className="w-full text-green-400 hover:text-white text-sm transition py-1"
            >
              {t('lobby.back')}
            </button>
          </div>
        )}

        {mode === 'matchmaking' && (
          <div className="space-y-4">
            <h2 className="text-white text-xl font-bold">{t('lobby.matchmaking.title')}</h2>

            {/* 累計ポイント表示 */}
            {myStats ? (
              <div className="bg-green-700/50 rounded-xl px-4 py-2.5">
                <p className="text-green-400 text-xs mb-0.5">{t('lobby.matchmaking.cumulative')}</p>
                <p className="text-yellow-300 font-bold text-lg">{myStats.totalPoints >= 0 ? '+' : ''}{myStats.totalPoints}pt <span className="text-green-400 text-sm font-normal">{myStats.gamesPlayed} {t('mm.gamesUnit')}</span></p>
              </div>
            ) : (
              <div className="bg-green-700/30 rounded-xl px-4 py-2.5">
                <p className="text-green-500 text-sm">{t('lobby.matchmaking.firstTime')}</p>
              </div>
            )}

            <div>
              <label className="text-green-300 text-sm block mb-1">{t('lobby.playerName')}</label>
              <input
                type="text"
                placeholder={t('lobby.playerName.placeholder')}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sanitizeName(name) && onJoinMatchmaking(sanitizeName(name), avatar)}
                className="w-full px-4 py-3 rounded-lg bg-green-700 text-white placeholder-green-500 focus:outline-none focus:ring-2 focus:ring-purple-400 transition"
                maxLength={20}
                autoFocus
              />
            </div>
            <AvatarPicker avatar={avatar} onChoose={chooseAvatar} />
            <p className="text-green-500 text-xs">{t('lobby.matchmaking.note')}</p>
            <button
              onClick={() => sanitizeName(name) && onJoinMatchmaking(sanitizeName(name), avatar)}
              disabled={!sanitizeName(name)}
              className="w-full bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 text-white font-bold py-3 rounded-xl transition-all duration-150"
            >
              {t('lobby.matchmaking.button')}
            </button>
            <button
              onClick={onOpenLeaderboard}
              className="w-full bg-yellow-600/80 hover:bg-yellow-500 active:scale-95 text-white font-bold py-2.5 rounded-xl transition-all duration-150 text-sm"
            >
              {t('lobby.leaderboard')}
            </button>
            <button
              onClick={() => handleModeChange('menu')}
              className="w-full text-green-400 hover:text-white text-sm transition py-1"
            >
              {t('lobby.back')}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-red-500/20 border border-red-500/50 text-red-300 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}

        </div>
      </main>

      {/* フッター: flex column の自然な末尾 (リロード時の viewport 揺れで隠れない) */}
      <footer
        className="flex justify-center gap-4 text-xs text-green-500 flex-wrap px-2 py-3"
        style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
      >
        <button onClick={() => setLegalTab('privacy')} className="hover:text-green-300 underline-offset-2 hover:underline transition">
          {t('lobby.privacy')}
        </button>
        <span className="text-green-700">·</span>
        <button onClick={() => setLegalTab('terms')} className="hover:text-green-300 underline-offset-2 hover:underline transition">
          {t('lobby.terms')}
        </button>
        <span className="text-green-700">·</span>
        <a
          href="https://ofuse.me/solabstudiojp"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-green-300 underline-offset-2 hover:underline transition"
        >
          {t('lobby.support')}
        </a>
      </footer>

      {/* ルール確認モーダル */}
      {showRules && <RulesModal onClose={() => setShowRules(false)} />}

      {/* 法的情報モーダル */}
      {legalTab && <LegalModal initialTab={legalTab} onClose={() => setLegalTab(null)} />}

      {/* 初回ウェルカムモーダル */}
      {showWelcome && <WelcomeModal onClose={dismissWelcome} />}
    </div>
  );
}

function AvatarPicker({ avatar, onChoose }: { avatar: string; onChoose: (a: string) => void }) {
  return (
    <div>
      <label className="text-green-300 text-sm block mb-1">{t('lobby.avatar')}</label>
      <div className="grid grid-cols-6 gap-1">
        {AVATAR_OPTIONS.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => onChoose(a)}
            aria-label={t('lobby.avatarAria', { avatar: a })}
            aria-pressed={avatar === a}
            className={`text-xl aspect-square rounded transition ${
              avatar === a ? 'bg-yellow-600 ring-2 ring-yellow-400' : 'bg-green-700 hover:bg-green-600'
            }`}
          >
            {a}
          </button>
        ))}
      </div>
    </div>
  );
}
