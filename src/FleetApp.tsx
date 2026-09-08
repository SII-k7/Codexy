import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Image, Platform, Pressable, RefreshControl, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import App from '../App';
import { sessionPhase, sessionLabel, type SessionPhase } from './sessionPresentation';
import { createLiveSync } from './liveSync';
import { bindForegroundSync } from './foregroundSync';
import { watchRelayChanges } from './relay';
import { createFleetPoller, fleetTasks, hostKey, hostOnline, type HostSnapshot } from './fleet';
import { deleteDevice, getRelaySnapshot, normalizeRelayUrl, registerDevice, renewPairingCode, RelayError } from './relay';
import { loadHiddenSessionRefs, loadHosts, saveHosts } from './storage';
import { disableWebPush, requiresStandaloneInstall } from './webPush';
import { getInitialNotificationSessionRef, listenForNotificationSession, registerForPushNotifications } from './notifications';
import type { AgentSession, AgentState, SavedDevice } from './types';

const labels: Record<AgentState, string> = {
  needs_you: '需要你决定', failed: '运行失败', interrupted: '已中断',
  working: '正在推进', completed: '目标完成 · 待验收', turn_finished: '本轮结束 · 待复核',
  subtask_completed: '子任务完成', background_ended: '后台结束', session_ended: '会话结束',
};
const nextSteps: Record<AgentState, string> = {
  needs_you: '查看上下文，处理授权或选择', failed: '查看失败原因，发送修复指令',
  interrupted: '确认是否继续，发送下一步', working: '查看进展，排队下一轮或补充当前回合',
  completed: '核对产出与验证结果', turn_finished: '查看本轮回复，决定下一步',
  subtask_completed: '查看产出，接回主线', background_ended: '确认是否恢复', session_ended: '确认是否恢复',
};
const origin = () => (globalThis as { location?: { origin: string } }).location?.origin ?? '';
function age(value: number | null): string {
  if (value === null) return '尚未同步';
  const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
  return seconds < 10 ? '刚刚同步' : seconds < 60 ? `${seconds} 秒前同步` : `${Math.floor(seconds / 60)} 分钟前同步`;
}
function validRelay(value: string): string {
  const url = new URL(normalizeRelayUrl(value));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请输入电脑的 Relay 地址，不含路径、密码或参数。');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('远程电脑请使用私有 HTTPS 地址；HTTP 仅用于本机调试。');
  }
  return url.origin;
}

export default function FleetApp({ managedHosts, onLogout }: { managedHosts?: SavedDevice[]; onLogout?: () => void } = {}) {
  const [hosts, setHosts] = useState<SavedDevice[]>([]);
  const [entries, setEntries] = useState<HostSnapshot[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState(false);
  const [label, setLabel] = useState('');
  const [url, setUrl] = useState(origin);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState('all');
  const [hostFilter, setHostFilter] = useState('all');
  const [remove, setRemove] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ host: SavedDevice; session?: AgentSession } | null>(null);
  const [demo, setDemo] = useState(false);
  const [clock, setClock] = useState(Date.now());
  const [hidden, setHidden] = useState<Record<string, string[]>>({});
  const pendingLink = useRef<string | null>(
    (() => { const query = new URLSearchParams((globalThis as { location?: { search: string } }).location?.search ?? ''); return query.get('session') || query.get('session_ref'); })(),
  );
  const poller = useMemo(() => createFleetPoller(getRelaySnapshot, setEntries), []);

  useEffect(() => {
    const receive = (ref: string) => { pendingLink.current = ref; setClock(Date.now()); };
    void getInitialNotificationSessionRef().then((ref) => { if (ref) receive(ref); });
    return listenForNotificationSession(receive);
  }, []);

  useEffect(() => {
    if (managedHosts) { setHosts(managedHosts); setLoaded(true); return; }
    let active = true;
    void loadHosts().then((saved) => { if (active) setHosts(saved); })
      .catch(() => { if (active) setError('无法读取已保存的电脑，请检查浏览器存储权限。'); })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, [managedHosts]);
  useEffect(() => { poller.setHosts(hosts); }, [hosts, poller]);
  useEffect(() => {
    if (selected || demo) return;
    const feeds = hosts.map((host) => createLiveSync({
      watch: (revision, signal) => watchRelayChanges(host, revision, signal),
      refresh: () => poller.refresh(host), onError: (error) => poller.markError(host, error),
    }));
    const unbind = bindForegroundSync((active) => feeds.forEach((feed) => feed.setActive(active)));
    return () => { unbind(); feeds.forEach((feed) => feed.close()); };
  }, [hosts, poller, selected, demo]);
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => { clearInterval(timer); poller.close(); };
  }, [poller]);

  useEffect(() => {
    let active = true;
    void Promise.all(hosts.map(async (host) => [hostKey(host), await loadHiddenSessionRefs(hostKey(host))] as const))
      .then((values) => { if (active) setHidden(Object.fromEntries(values)); }).catch(() => undefined);
    return () => { active = false; };
  }, [hosts, selected]);
  const tasks = useMemo(() => fleetTasks(entries, clock).filter((task) =>
    !hidden[hostKey(task.host)]?.includes(task.session.session_ref) || ['needs_you', 'failed'].includes(task.session.state)), [entries, clock, hidden]);
  useEffect(() => {
    if (!pendingLink.current) return;
    const matches = tasks.filter((task) => task.session.session_ref === pendingLink.current);
    const deviceRef = new URLSearchParams((globalThis as { location?: { search: string } }).location?.search ?? '').get('device');
    const candidates = deviceRef ? matches.filter((task) => task.host.deviceId === deviceRef)
      : Platform.OS === 'web' ? matches.filter((task) => task.host.relayUrl === origin()) : matches;
    const local = candidates.length === 1 ? candidates[0] : undefined;
    if (!local) return; // Never guess the host from a thread hash shared by backups.
    pendingLink.current = null;
    setSelected({ host: local.host, session: local.session });
  }, [tasks]);

  const updateHosts = async (next: SavedDevice[]) => { await saveHosts(next); setHosts(next); };
  const addHost = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (requiresStandaloneInstall()) throw new Error('请先在 Safari 点“分享 → 添加到主屏幕”，再从主屏幕打开 Codexy 进行配对。');
      const relayUrl = validRelay(url);
      if (!label.trim()) throw new Error('为电脑起一个容易辨认的名字。');
      const existing = hosts.find((host) => host.relayUrl === relayUrl);
      const push = await registerForPushNotifications();
      const registration = await registerDevice({ relayUrl,
        deviceId: existing?.deviceId ?? `codexy-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
        deviceSecret: existing?.deviceSecret, expoPushToken: push.token, platform: Platform.OS });
      const host = { relayUrl, deviceId: registration.device_id, deviceSecret: registration.device_secret, label: label.trim().slice(0, 40) };
      await updateHosts([...hosts.filter((item) => item.relayUrl !== relayUrl), host]);
      setAdding(false); setLabel(''); setUrl('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '添加电脑失败'); }
    finally { setBusy(false); }
  };
  const removeHost = async (host: SavedDevice) => {
    setBusy(true); setError('');
    try {
      try { await deleteDevice(host); } catch (cause) { if (!(cause instanceof RelayError && cause.status === 404)) throw cause; }
      await updateHosts(hosts.filter((item) => hostKey(item) !== hostKey(host)));
      await disableWebPush(host);
      setRemove(null); setHostFilter('all');
    } catch { setError('无法在电脑撤销配对，连接已保留。请恢复网络后再移除。'); }
    finally { setBusy(false); }
  };
  const refresh = async () => { setRefreshing(true); try { await poller.refresh(); } finally { setRefreshing(false); } };

  if (demo || selected) return (
    <View style={{ flex: 1 }}>
      {!selected?.session ? <SafeAreaView style={styles.detailHeader}><Pressable accessibilityRole="button" onPress={() => { setDemo(false); setSelected(null); void poller.refresh(); }} style={styles.button}>
        <Text style={styles.link}>‹ 全部设备{selected ? ` / ${selected.host.label || '电脑'}` : ' / 体验'}</Text>
      </Pressable></SafeAreaView> : null}
      <App key={selected ? hostKey(selected.host) : 'demo'} initialDevice={selected?.host}
        initialSession={selected?.session} onExit={() => setSelected(null)}
        onDeviceRemoved={selected ? async () => { await updateHosts(hosts.filter((host) => hostKey(host) !== hostKey(selected.host))); setSelected(null); } : undefined} />
    </View>
  );

  const online = entries.filter((entry) => hostOnline(entry, clock)).length;
  const running = tasks.filter((task) => sessionPhase(task.session, task.online) === 'running').length;
  const waiting = tasks.filter((task) => sessionPhase(task.session, task.online) === 'waiting').length;
  const groups: { id: SessionPhase; title: string; hint?: string }[] = [
    { id: 'attention', title: '需要你处理' },
    { id: 'waiting', title: '等待指令', hint: '本轮已结束' },
    { id: 'running', title: '正在推进' },
    { id: 'unknown', title: '状态待确认' },
  ];
  return <SafeAreaView style={styles.page}><ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}>
    <View style={styles.row}><Text style={styles.brand}>Codexy</Text>
      <Pressable accessibilityRole="button" onPress={() => { setManaging(!managing); setAdding(false); }} style={styles.button}><Text style={styles.muted}>{managing ? '返回会话' : '设置'}</Text></Pressable>
    </View>
    <Text accessibilityRole="header" style={styles.hero}>{managing ? '设置' : '会话'}</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {!loaded ? <Text style={styles.muted}>正在同步会话…</Text> : null}
    {!managing ? <View style={styles.stats}>
      {[['running', running, '正在推进'], ['waiting', waiting, '等待指令']].map(([id, count, title]) => <Pressable key={id} accessibilityRole="button"
        accessibilityLabel={title + ' ' + count + ' 个会话'} accessibilityState={{ selected: filter === id }}
        onPress={() => setFilter(filter === id ? 'all' : String(id))} style={[styles.stat, filter === id && styles.statSelected]}>
        <Text style={styles.count}>{count}</Text><Text style={styles.muted}>{title}</Text>
      </Pressable>)}
    </View> : <Text style={styles.muted}>{online}/{hosts.length} 台电脑在线</Text>}
    {(!managedHosts && (adding || (loaded && !hosts.length))) ? <View style={styles.card}>
      <Text style={styles.title}>连接电脑</Text>
      <TextInput accessibilityLabel="电脑名称" placeholder="电脑名称" value={label} onChangeText={setLabel} maxLength={40} style={styles.input} />
      <TextInput accessibilityLabel="电脑 Relay 地址" placeholder="电脑的私有 HTTPS 地址" value={url} onChangeText={setUrl} autoCapitalize="none" autoCorrect={false} style={styles.input} />
      <Pressable accessibilityRole="button" disabled={busy} onPress={() => void addHost()} style={styles.primary}><Text style={styles.primaryText}>{busy ? '连接中…' : '连接电脑'}</Text></Pressable>
    </View> : null}
    {managedHosts && loaded && !hosts.length ? <Text style={styles.muted}>还没有电脑接入中枢。</Text> : null}
    {entries.filter((entry) => managing || entry.snapshot?.status.paired === false).map((entry) => <View key={hostKey(entry.host)} style={styles.card}>
      <View style={styles.row}><Text style={styles.title}>{entry.host.label || '电脑'}</Text><Text style={styles.small}>{hostOnline(entry, clock) ? entry.snapshot?.status.paired ? '在线' : '待配对' : '离线'}</Text></View>
      {entry.snapshot?.status.paired === false ? <View style={{ gap: 8 }}>
        <Text selectable style={styles.body}>codexy pair {entry.snapshot.status.pairing_code || '------'}</Text>
        <Text style={styles.small}>在这台电脑的终端执行，完成配对。</Text>
        <Pressable accessibilityRole="button" style={styles.button} disabled={busy} onPress={() => {
          setBusy(true); void renewPairingCode(entry.host).then(() => poller.refresh()).catch(() => setError('配对码刷新失败')).finally(() => setBusy(false));
        }}><Text style={styles.link}>刷新配对码</Text></Pressable>
      </View> : null}
      {managing && !managedHosts ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => setRemove(hostKey(entry.host))}><Text style={styles.muted}>移除电脑</Text></Pressable> : null}
      {remove === hostKey(entry.host) ? <View style={styles.row}><Text style={styles.small}>撤销这台电脑的配对？</Text>
        <Pressable accessibilityRole="button" style={styles.button} disabled={busy} onPress={() => void removeHost(entry.host)}><Text style={styles.error}>确认移除</Text></Pressable>
        <Pressable accessibilityRole="button" style={styles.button} onPress={() => setRemove(null)}><Text style={styles.link}>取消</Text></Pressable>
      </View> : null}
    </View>)}
    {managing && !managedHosts ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => setAdding(!adding)}><Text style={styles.link}>添加电脑</Text></Pressable> : null}
    {managing && onLogout ? <Pressable accessibilityRole="button" style={styles.button} onPress={onLogout}><Text style={styles.muted}>退出中枢</Text></Pressable> : null}
    {!managing && filter !== 'all' ? <Pressable accessibilityRole="button" style={styles.button} onPress={() => setFilter('all')}><Text style={styles.link}>查看全部会话</Text></Pressable> : null}
    {!managing ? groups.map((group) => {
      if (filter !== 'all' && filter !== group.id) return null;
      const items = tasks.filter((task) => sessionPhase(task.session, task.online) === group.id);
      if (!items.length) return null;
      return <View key={group.id} style={styles.group}>
        <View style={styles.row}><Text accessibilityRole="header" style={styles.section}>{group.title} · {items.length}</Text>{group.hint ? <Text style={styles.small}>{group.hint}</Text> : null}</View>
        {items.map((task) => <Pressable key={task.key} accessibilityRole="button" onPress={() => setSelected({ host: task.host, session: task.session })} style={styles.sessionRow}>
          <View style={styles.row}><Text style={styles.title}>{task.session.project_alias}</Text><Text style={[styles.status, group.id === 'attention' && styles.error, group.id === 'running' && styles.online]}>{group.id === 'waiting' ? '等待指令' : sessionLabel(task.session, task.online)} ›</Text></View>
          <Text style={styles.small}>{task.host.label || '电脑'} · 会话 {task.session.session_ref.slice(-6)}</Text>
          <Text numberOfLines={2} style={styles.body}>{task.session.summary}</Text>
          {group.id === 'unknown' ? <Text style={styles.small}>{task.online ? '运行状态尚未确认' : '电脑离线，显示上次同步内容'}</Text> : null}
        </Pressable>)}
      </View>;
    }) : null}
    {!managing && loaded && hosts.length > 0 && !tasks.some((task) => filter === 'all' || sessionPhase(task.session, task.online) === filter) ? <Text style={styles.empty}>{filter === 'running' ? '目前没有确认正在推进的会话。' : filter === 'waiting' ? '目前没有等待下一条指令的会话。' : '还没有会话。在电脑上运行 codexy 后，会自动出现在这里。'}</Text> : null}
  </ScrollView></SafeAreaView>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#FFFFFF' },
  content: { paddingHorizontal: 20, paddingTop: 12, gap: 12, maxWidth: 640, width: '100%', alignSelf: 'center', paddingBottom: 40 },
  brand: { fontSize: 15, fontWeight: '600', color: '#202124' },
  hero: { fontSize: 30, fontWeight: '600', color: '#202124', marginTop: 4, marginBottom: 10 },
  stats: { flexDirection: 'row', gap: 12, marginBottom: 8 },
  stat: { flex: 1, gap: 8, padding: 18, backgroundColor: '#F6F7F8', borderRadius: 12, borderWidth: 1, borderColor: '#F6F7F8' },
  statSelected: { borderColor: '#62676F', backgroundColor: '#EEF0F2' },
  count: { fontSize: 32, fontWeight: '600', color: '#202124' },
  title: { fontSize: 16, fontWeight: '600', color: '#202124', flexShrink: 1 },
  section: { fontSize: 14, fontWeight: '600', color: '#575D65' },
  group: { marginTop: 18 },
  sessionRow: { paddingVertical: 18, gap: 8, borderBottomWidth: 1, borderBottomColor: '#ECEEF0' },
  muted: { fontSize: 14, color: '#666C74', lineHeight: 21 },
  small: { fontSize: 12, lineHeight: 19, color: '#737982', flexShrink: 1 },
  body: { fontSize: 14, color: '#535962', lineHeight: 22 },
  status: { fontSize: 12, color: '#737982', flexShrink: 1 },
  card: { backgroundColor: '#F6F7F8', borderRadius: 12, padding: 16, gap: 10 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  button: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  link: { fontSize: 14, fontWeight: '500', color: '#343A42' },
  online: { color: '#347451' }, error: { color: '#A34435', fontSize: 14, lineHeight: 22 },
  input: { borderWidth: 1, borderColor: '#DDE0E4', borderRadius: 10, minHeight: 48, padding: 12, fontSize: 16, color: '#202124', backgroundColor: '#FFF' },
  primary: { backgroundColor: '#25292F', borderRadius: 10, padding: 14, alignItems: 'center', minHeight: 48 },
  primaryText: { color: '#FFFFFF', fontSize: 15, fontWeight: '500' },
  empty: { fontSize: 14, color: '#737982', lineHeight: 23, paddingVertical: 30 },
  detailHeader: { backgroundColor: '#FFF', paddingHorizontal: 16 },
});
