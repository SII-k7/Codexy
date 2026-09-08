import webpush from 'web-push';

import { notificationForEvent } from './notifications.mjs';

export function webPushPayloadForEvent(event, preferences = {}) {
  return notificationForEvent(event, preferences);
}

export function normalizeVapidConfig(value = {}) {
  const subject =
    typeof value.subject === 'string' ? value.subject.trim() : '';
  const publicKey =
    typeof value.publicKey === 'string' ? value.publicKey.trim() : '';
  const privateKey =
    typeof value.privateKey === 'string' ? value.privateKey.trim() : '';
  if (!subject || !publicKey || !privateKey) {
    return { configured: false, subject, publicKey, privateKey };
  }
  if (!subject.startsWith('mailto:') && !subject.startsWith('https://')) {
    throw new Error('VAPID subject must start with mailto: or https://');
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return { configured: true, subject, publicKey, privateKey };
}

export function createWebPushSender(vapidConfig) {
  if (!vapidConfig.configured) {
    return async () => ({
      status: 'not_configured',
      sent: 0,
      expiredEndpoints: [],
    });
  }

  return async (subscriptions, event, preferences = {}) => {
    if (!subscriptions?.length) {
      return { status: 'not_subscribed', sent: 0, expiredEndpoints: [] };
    }

    const payload = JSON.stringify(
      webPushPayloadForEvent(event, preferences),
    );
    const results = await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, payload, {
            TTL: 300,
            urgency: event.state === 'needs_you' ? 'high' : 'normal',
          });
          return { endpoint: subscription.endpoint, status: 'sent' };
        } catch (error) {
          const statusCode = Number(error?.statusCode);
          return {
            endpoint: subscription.endpoint,
            status:
              statusCode === 404 || statusCode === 410 ? 'expired' : 'failed',
          };
        }
      }),
    );
    const sent = results.filter((result) => result.status === 'sent').length;
    const expiredEndpoints = results
      .filter((result) => result.status === 'expired')
      .map((result) => result.endpoint);
    return {
      status:
        sent > 0
          ? 'sent'
          : expiredEndpoints.length > 0
            ? 'expired'
            : 'failed',
      sent,
      expiredEndpoints,
    };
  };
}
