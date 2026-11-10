import { useEffect, useState } from 'react';
import { GhostButton } from './ui';

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function InstallHint() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  return (
    <div className="flex flex-col gap-2 text-sm text-soft">
      {prompt && (
        <GhostButton
          icon="download"
          className="-ml-3 self-start text-accent"
          onClick={() => prompt.prompt()}
        >
          Install HSA Locker
        </GhostButton>
      )}
      {isIOS() ? (
        <p>In Safari, tap Share, then “Add to Home Screen”.</p>
      ) : (
        <p>
          On iPhone: open this page in Safari, tap Share, then “Add to Home Screen”. On Android:
          open the Chrome menu and tap “Install app”.
        </p>
      )}
    </div>
  );
}
