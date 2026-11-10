// Email setup: what the app can tell about the person's domain, and their answer to "do you have
// a domain on Cloudflare?", remembered per device (it only decides which help to show).
import { useSyncExternalStore } from 'react';
import { appDomain } from '@shared/logic';

/** The Cloudflare dashboard's Email Routing page (Compute → Email Service → Email Routing). */
export const EMAIL_ROUTING_URL = 'https://dash.cloudflare.com/?to=/:account/email-service/routing';

const ANSWER_KEY = 'hsa-locker-email-domain';
/** Dev only: pretend the app is on this host, to see the custom-domain setup locally. */
const HOST_OVERRIDE_KEY = 'hsa-locker-host-override';

export type DomainAnswer = 'yes' | 'no';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The registrable domain the app is served on, when it isn't workers.dev or local. A Worker
 * custom domain or route is necessarily on this Cloudflare account.
 */
export function hostDomain(): string | null {
  const host = (import.meta.env.DEV && read(HOST_OVERRIDE_KEY)) || location.hostname;
  return appDomain(host);
}

const listeners = new Set<() => void>();

function getAnswer(): DomainAnswer | null {
  const v = read(ANSWER_KEY);
  return v === 'yes' || v === 'no' ? v : null;
}

export function setDomainAnswer(a: DomainAnswer) {
  try {
    localStorage.setItem(ANSWER_KEY, a);
  } catch {
    /* Private mode: still applies until the page reloads. */
  }
  memory = a;
  listeners.forEach((l) => l());
}

let memory: DomainAnswer | null = null;

/** The "do you have a domain?" answer, shared by every place that asks it. */
export function useDomainAnswer(): [DomainAnswer | null, (a: DomainAnswer) => void] {
  const answer = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => getAnswer() ?? memory,
  );
  return [answer, setDomainAnswer];
}

/**
 * Whether to show the setup steps: the app's own custom domain answers "do you have a domain?";
 * on workers.dev the person does.
 */
export function useEmailPath() {
  const host = hostDomain();
  const [answer, setAnswer] = useDomainAnswer();
  return { host, answer, setAnswer, go: !!host || answer === 'yes' };
}

export type EmailPath = ReturnType<typeof useEmailPath>;
