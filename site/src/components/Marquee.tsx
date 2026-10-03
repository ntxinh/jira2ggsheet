const STACK = [
  "Jira Cloud",
  "Google Sheets API v4",
  "Cloudflare Workers",
  "Durable Objects",
  "Hono",
  "JQL",
  "Web Crypto",
  "OAuth2 JWT",
];

export default function Marquee() {
  const row = [...STACK, ...STACK];
  return (
    <div className="relative overflow-hidden border-y border-white/10 py-5 opacity-40 [mask-image:linear-gradient(to_right,transparent,black_15%,black_85%,transparent)]">
      <div className="flex w-max animate-marquee gap-12">
        {row.map((name, i) => (
          <span
            key={i}
            className="whitespace-nowrap font-mono text-sm tracking-widest text-white/70 uppercase"
          >
            {name}
            <span className="ml-12 text-neon-cyan">·</span>
          </span>
        ))}
      </div>
    </div>
  );
}
