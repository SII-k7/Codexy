import { useEffect, useState } from 'react';
import { SafeAreaView, View, Text, TextInput, Pressable } from 'react-native';
import FleetApp from './FleetApp';
import { createLiveSync } from './liveSync';
import { bindForegroundSync } from './foregroundSync';
import type { SavedDevice } from './types';

const KEY = 'codexy.hub-access.v1';
const storage = () => (globalThis as { localStorage?: Storage }).localStorage;
const origin = () => (globalThis as { location?: { origin: string } }).location?.origin ?? '';
export default function HubApp() {
  const [token, setToken] = useState(() => { try { return storage()?.getItem(KEY) || ''; } catch { return ''; } });
  const [draft, setDraft] = useState('');
  const [hosts, setHosts] = useState<SavedDevice[]>([]);
  const [error, setError] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  useEffect(() => {
    if (!token) return;
    let active = true;
    async function request(path: string, signal?: AbortSignal) {
      const result = await fetch(`${origin()}/v1/hub/${path}`, { headers: { Authorization: `Bearer ${token}` },
        signal: signal ?? AbortSignal.timeout(10_000), cache: 'no-store' });
      if (!result.ok) {
        if (result.status === 401 && active) { setAuthenticated(false); storage()?.removeItem(KEY); }
        throw new Error(result.status === 401 ? '访问密钥无效或已撤销。' : '暂时无法连接中枢，请检查 Tailscale。');
      }
      return result.json();
    }
    const feed = createLiveSync({
      watch: (revision, signal) => request(`changes${revision ? `?after=${encodeURIComponent(revision)}` : ''}`, signal),
      refresh: async () => {
        const result = await request('hosts');
        if (!active) return;
        const next: SavedDevice[] = result.hosts.map((host: { id: string; label: string }) => ({
          label: host.label, deviceId: host.id, deviceSecret: token, relayUrl: `${origin()}/h/${host.id}`,
        }));
        setHosts((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
        setAuthenticated(true); setError(''); storage()?.setItem(KEY, token);
      },
      onError: (cause) => { if (active) setError(cause.message); },
    });
    const unbind = bindForegroundSync((enabled) => feed.setActive(enabled));
    return () => { active = false; unbind(); feed.close(); };
  }, [token]);
  if (authenticated) return <View style={{ flex: 1 }}>
    {error ? <Text accessibilityRole="alert" style={{ padding: 12, color: '#a52a2a' }}>{error}</Text> : null}
    <FleetApp managedHosts={hosts} onLogout={() => { storage()?.removeItem(KEY); setToken(''); setAuthenticated(false); setHosts([]); }} />
  </View>;
  return <SafeAreaView style={{ flex: 1, backgroundColor: '#FFFFFF', padding: 24, justifyContent: 'center', gap: 18 }}>
    <Text style={{ fontSize: 30, fontWeight: '700' }}>Codexy 中枢</Text>
    <Text>连接一次，查看所有电脑的任务，并发送下一条指令。</Text>
    <TextInput accessibilityLabel="中枢访问密钥" placeholder="粘贴中枢访问密钥" secureTextEntry autoCapitalize="none" autoCorrect={false}
      value={draft} onChangeText={setDraft} style={{ backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#DDE0E4', padding: 16, fontSize: 16 }} />
    {error ? <Text accessibilityRole="alert" style={{ color: '#a52a2a' }}>{error}</Text> : null}
    <Pressable accessibilityRole="button" disabled={!draft.trim()} onPress={() => { setError(''); setToken(draft.trim()); setDraft(''); }} style={{ padding: 16, borderRadius: 12, backgroundColor: '#25292F', alignItems: 'center' }}>
      <Text style={{ color: '#FFF', fontSize: 16 }}>连接中枢</Text>
    </Pressable>
    <Text>手机需要开启 Tailscale。访问密钥保存在此设备，退出后清除。</Text>
  </SafeAreaView>;
}
