import Link from 'next/link';

export default function NotFound() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-14 pb-20">
      <p className="font-mono text-[11px] tracking-[0.3em] text-brass">404</p>
      <h1 className="mt-4 text-2xl font-medium tracking-tight md:text-3xl">
        This page is not in the record.
      </h1>
      <p className="mt-4 max-w-xl text-sm leading-relaxed text-mist">
        The inspector only shows pages that correspond to recorded runs and artifacts.
      </p>
      <p className="mt-8">
        <Link
          href="/"
          className="font-mono text-[11px] tracking-[0.08em] uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-deck-text"
        >
          Back to runs
        </Link>
      </p>
    </section>
  );
}
