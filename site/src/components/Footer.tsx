import { GitBranch, FileText, Bug, CircleDot } from "lucide-react";

const LINKS = [
  {
    icon: GitBranch,
    label: "ntxinh/jira2ggsheet",
    href: "https://github.com/ntxinh/jira2ggsheet",
  },
  {
    icon: FileText,
    label: "SETUP.md",
    href: "https://github.com/ntxinh/jira2ggsheet/blob/main/SETUP.md",
  },
  {
    icon: Bug,
    label: "issues",
    href: "https://github.com/ntxinh/jira2ggsheet/issues",
  },
];

export default function Footer() {
  return (
    <footer className="relative border-t border-white/10">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="font-mono text-xs text-white/40">
          <span className="font-semibold text-white/70">jira2ggsheet</span>
          <span className="mx-2 text-white/20">/</span>© 2026 ntxinh
        </div>

        <nav className="flex flex-wrap items-center gap-x-7 gap-y-3">
          {LINKS.map((l) => (
            <a
              key={l.label}
              href={l.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 font-mono text-xs text-white/45 transition-colors hover:text-neon-cyan"
            >
              <l.icon className="h-3.5 w-3.5" />
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5 font-mono text-[11px] text-white/30">
          <CircleDot className="h-3 w-3 text-neon-cyan" />
          cloudflare workers · durable objects · hono
        </div>
      </div>
    </footer>
  );
}
