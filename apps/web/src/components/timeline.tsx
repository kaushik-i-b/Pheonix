'use client';

import { useMemo, useState } from 'react';
import type { StageGroup, TimelineEvent } from '../data/events';
import { shortTaskId } from '../lib/format';
import { StampChip } from './stamp-chip';

export function Timeline({ groups }: { groups: StageGroup[] }) {
  const typeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of groups) {
      for (const event of group.events) {
        counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) =>
      b[1] !== a[1] ? b[1] - a[1] : compare(a[0], b[0]),
    );
  }, [groups]);

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.events.length, 0),
    [groups],
  );

  const [hiddenTypes, setHiddenTypes] = useState<ReadonlySet<string>>(() => new Set());

  const visibleCount = useMemo(() => {
    let visible = 0;
    for (const group of groups) {
      for (const event of group.events) {
        if (!hiddenTypes.has(event.type)) visible += 1;
      }
    }
    return visible;
  }, [groups, hiddenTypes]);

  const toggle = (type: string): void => {
    setHiddenTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  if (total === 0) {
    return <p className="px-4 py-6 text-sm text-ink-soft">No events are recorded in this run.</p>;
  }

  return (
    <div>
      <fieldset className="border-b border-ink/10 px-4 py-3">
        <legend className="sr-only">Event types shown in the timeline</legend>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="font-mono text-[10px] tracking-[0.14em] text-ink-soft uppercase">
            Filter
          </span>
          {typeCounts.map(([type, count]) => (
            <label
              key={type}
              className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-ink-soft"
            >
              <input
                type="checkbox"
                checked={!hiddenTypes.has(type)}
                onChange={() => toggle(type)}
                className="accent-brass"
              />
              <span className="text-ink">{type}</span>
              <span>{count}</span>
            </label>
          ))}
          <span className="ml-auto font-mono text-[10px] text-ink-soft">
            {visibleCount} / {total} events
          </span>
          {hiddenTypes.size > 0 && (
            <button
              type="button"
              onClick={() => setHiddenTypes(new Set())}
              className="font-mono text-[10px] tracking-[0.08em] text-ink uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-ink"
            >
              Reset filter
            </button>
          )}
        </div>
      </fieldset>
      {visibleCount === 0 && (
        <p className="border-b border-ink/10 px-4 py-3 font-mono text-[11px] text-ink-soft">
          All {total} events are hidden by the current filter.
        </p>
      )}
      <div>
        {groups.map((group) => (
          <StageSection key={group.stage} group={group} hiddenTypes={hiddenTypes} />
        ))}
      </div>
    </div>
  );
}

function StageSection({
  group,
  hiddenTypes,
}: {
  group: StageGroup;
  hiddenTypes: ReadonlySet<string>;
}) {
  let visible = 0;
  for (const event of group.events) {
    if (!hiddenTypes.has(event.type)) visible += 1;
  }
  return (
    <section className="border-t border-ink/10 first:border-t-0">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-ink/[0.03] px-4 py-2">
        <h3 className="font-mono text-[11px] tracking-[0.14em] text-brass uppercase">
          {group.label}
        </h3>
        <span className="font-mono text-[10px] text-ink-soft">
          {visible} / {group.events.length} events
        </span>
      </header>
      <ol>
        {group.events.map((event, index) => (
          <TimelineRow key={index} event={event} hidden={hiddenTypes.has(event.type)} />
        ))}
      </ol>
    </section>
  );
}

function TimelineRow({ event, hidden }: { event: TimelineEvent; hidden: boolean }) {
  return (
    <li hidden={hidden} tabIndex={0} className="border-t border-ink/5 px-4 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] text-ink-soft">{eventTime(event.at)}</span>
        <StampChip tone="neutral">{event.type}</StampChip>
        {event.role !== null && (
          <span className="font-mono text-[11px] text-ink-soft">{event.role}</span>
        )}
        {event.taskId !== null && (
          <span className="font-mono text-[11px] text-ink-soft">{shortTaskId(event.taskId)}</span>
        )}
      </div>
      {event.fields.length > 0 && (
        <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
          {event.fields.map((field, index) => (
            <div key={index} className="contents">
              <dt className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
                {field.label}
              </dt>
              <dd className="min-w-0 font-mono text-[11px] break-all text-ink">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  );
}

function eventTime(at: string): string {
  if (at.length < 19) return at;
  return `${at.slice(5, 10)} ${at.slice(11, 19)}`;
}

function compare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
