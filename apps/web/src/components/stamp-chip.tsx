import type { ReactNode } from 'react';

export type StampTone =
  | 'matched'
  | 'drifted'
  | 'relocated'
  | 'danger'
  | 'brass'
  | 'neutral'
  | 'equivalent'
  | 'not-equivalent';

const paperTones: Record<StampTone, string> = {
  matched: 'border-matched/40 bg-matched/10 text-[#1f7a4d]',
  equivalent: 'border-matched/40 bg-matched/10 text-[#1f7a4d]',
  drifted: 'border-drifted/45 bg-drifted/10 text-[#a05c12]',
  relocated: 'border-relocated/45 bg-relocated/10 text-[#48597c]',
  danger: 'border-vermilion/45 bg-vermilion/10 text-[#a83a3a]',
  'not-equivalent': 'border-vermilion/45 bg-vermilion/10 text-[#a83a3a]',
  brass: 'border-brass/50 bg-brass/10 text-[#8f6413]',
  neutral: 'border-ink/15 bg-ink/5 text-ink-soft',
};

const deckTones: Record<StampTone, string> = {
  matched: 'border-matched/40 bg-matched/10 text-matched',
  equivalent: 'border-matched/40 bg-matched/10 text-matched',
  drifted: 'border-drifted/45 bg-drifted/10 text-drifted',
  relocated: 'border-relocated/45 bg-relocated/10 text-relocated',
  danger: 'border-vermilion/50 bg-vermilion/10 text-[#d97070]',
  'not-equivalent': 'border-vermilion/50 bg-vermilion/10 text-[#d97070]',
  brass: 'border-brass/50 bg-brass/10 text-brass',
  neutral: 'border-mist/30 bg-mist/10 text-mist',
};

export function StampChip({
  tone,
  surface = 'paper',
  children,
}: {
  tone: StampTone;
  surface?: 'paper' | 'deck';
  children: ReactNode;
}) {
  const tones = surface === 'deck' ? deckTones : paperTones;
  return (
    <span
      className={`inline-flex items-center rounded-[3px] border px-1.5 py-0.5 font-mono text-[11px] leading-none tracking-[0.08em] uppercase ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
