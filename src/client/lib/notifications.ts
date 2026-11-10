// Notifications on this device (Selfhost Kit: src/client/kit/push.ts): taps on a notification
// route in-app, and the app-icon badge follows the Review count.
import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { onPushOpen, syncBadge } from '../kit/push';

/** Mount once inside the router. `review`: the Review tab's count, so the badge follows it. */
export function useNotifications(review: number | undefined) {
  const nav = useNavigate();
  useEffect(() => onPushOpen((url) => nav(url)), [nav]);
  // On open, and whenever the Review count changes (a document read, reviewed or discarded).
  useEffect(() => {
    void syncBadge();
  }, [review]);
  // Back in the foreground.
  useEffect(() => {
    const onShow = () => document.visibilityState === 'visible' && void syncBadge();
    document.addEventListener('visibilitychange', onShow);
    return () => document.removeEventListener('visibilitychange', onShow);
  }, []);
}
