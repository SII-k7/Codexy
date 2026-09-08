import { AppState, Platform } from 'react-native';

export function bindForegroundSync(setActive: (active: boolean) => void) {
  const doc = (globalThis as { document?: Document }).document;
  const update = () => setActive(Platform.OS === 'web' ? !doc?.hidden : AppState.currentState === 'active');
  const subscription = AppState.addEventListener('change', update);
  doc?.addEventListener('visibilitychange', update);
  update();
  return () => { subscription.remove(); doc?.removeEventListener('visibilitychange', update); setActive(false); };
}
