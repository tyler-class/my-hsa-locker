// Mail providers send a confirmation message to a forwarding destination before they'll
// auto-forward. These must not become documents; the app shows the code/link in Settings → Receipt forwarding address.
// Add providers by adding a pattern.

export interface VerificationPattern {
  provider: string;
  from: RegExp;
  subject: RegExp;
  /** Pulls the confirmation code from the subject or body. */
  code?: RegExp;
  /** Pulls the confirmation link from the body (text or HTML). */
  link?: RegExp;
}

export const VERIFICATION_PATTERNS: VerificationPattern[] = [
  {
    provider: 'Gmail',
    from: /^(forwarding-noreply|mail-noreply)@google\.com$/i,
    subject: /gmail forwarding confirmation/i,
    code: /\(#(\d{6,12})\)|confirmation code:\s*(\d{6,12})/i,
    link: /https:\/\/(?:isolated\.)?mail(?:-settings)?\.google\.com\/mail\/vf-[^\s"'<>)]+/i,
  },
  {
    provider: 'iCloud Mail',
    from: /@(icloud|apple|me)\.com$/i,
    subject: /verify.*(forward|email address)|forwarding.*verif/i,
    code: /\b(\d{6})\b/,
    link: /https:\/\/[^\s"'<>)]*(apple|icloud)\.com[^\s"'<>)]*verif[^\s"'<>)]*/i,
  },
  {
    provider: 'Outlook',
    from: /@(microsoft|outlook|accountprotection\.microsoft)\.com$/i,
    subject: /verify.*(forward|email)|forwarding.*(confirm|verif)/i,
    code: /\b(\d{6,8})\b/,
    link: /https:\/\/[^\s"'<>)]*(live|microsoft|outlook)\.com[^\s"'<>)]*/i,
  },
  {
    provider: 'Fastmail',
    from: /@fastmail\.(com|fm)$/i,
    subject: /verif.*(forward|address)|confirm.*forward/i,
    code: /\b(\d{6,8})\b/,
    link: /https:\/\/[^\s"'<>)]*fastmail\.com[^\s"'<>)]*/i,
  },
];

export interface VerificationHit {
  provider: string;
  code: string | null;
  link: string | null;
}

/** Recognizes a forwarding-confirmation message and pulls out its code and link. */
export function detectVerification(
  msg: { from: string; subject: string; text?: string | null; html?: string | null },
  patterns: VerificationPattern[] = VERIFICATION_PATTERNS,
): VerificationHit | null {
  const from = msg.from.trim().toLowerCase();
  for (const p of patterns) {
    if (!p.from.test(from) || !p.subject.test(msg.subject)) continue;
    const hay = `${msg.subject}\n${msg.text ?? ''}\n${msg.html ?? ''}`;
    const cm = p.code ? p.code.exec(hay) : null;
    const lm = p.link ? p.link.exec(`${msg.text ?? ''}\n${msg.html ?? ''}`) : null;
    return {
      provider: p.provider,
      code: cm ? (cm.slice(1).find(Boolean) ?? null) : null,
      link: lm ? lm[0].replace(/&amp;/g, '&') : null,
    };
  }
  return null;
}
