import { motion } from "framer-motion";
import { Zap, RefreshCw, FilePen, Gauge, type LucideIcon } from "lucide-react";

type Feature = {
  icon: LucideIcon;
  accent: string;
  title: string;
  body: string;
  code: string;
  span: string;
};

const FEATURES: Feature[] = [
  {
    icon: Zap,
    accent: "text-neon-cyan",
    title: "Webhook → row, instantly",
    body: "Jira fires on issue create, update and delete. The Worker upserts the row into the issue's sprint tab — found by key, appended if new, removed from every other sprint tab first.",
    code: "upsertIssue() / deleteIssue()",
    span: "md:col-span-4",
  },
  {
    icon: RefreshCw,
    accent: "text-neon-purple",
    title: "Full-sprint resync",
    body: "A */5 cron kicks a Durable Object alarm chain — one Jira page (100 issues) per tick, cursor persisted, exponential backoff on failure.",
    code: "GET /sync · /sync/status",
    span: "md:col-span-2",
  },
  {
    icon: FilePen,
    accent: "text-neon-orange",
    title: "Tabs rename themselves",
    body: "Jira's rename webhooks are unreliable, so every kick diffs {sprintId}_* tabs against the Agile API and fixes mismatches in one batchUpdate.",
    code: "syncTabNames()",
    span: "md:col-span-2",
  },
  {
    icon: Gauge,
    accent: "text-neon-cyan",
    title: "Built for the free tier",
    body: "One page of work per tick keeps every invocation inside Cloudflare's 10ms CPU limit. The Google OAuth JWT is signed once an hour, not per request — cached in DO storage.",
    code: "≤10ms CPU / tick",
    span: "md:col-span-4",
  },
];

export default function Bento() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-28">
      <motion.h2
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ type: "spring", stiffness: 100, damping: 20 }}
        className="mb-14 text-3xl font-extrabold tracking-tight sm:text-4xl"
      >
        The sync,{" "}
        <span className="bg-gradient-to-r from-neon-cyan to-neon-purple bg-clip-text text-transparent">
          end to end
        </span>
      </motion.h2>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-6">
        {FEATURES.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 50 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{
              type: "spring",
              stiffness: 100,
              damping: 20,
              delay: i * 0.08,
            }}
            whileHover={{ rotate: -0.6 }}
            className={`group relative overflow-hidden rounded-3xl border border-white/10 bg-white/5 p-7 backdrop-blur-xl transition-colors duration-300 hover:border-white/25 ${f.span}`}
          >
            <div className="pointer-events-none absolute -top-20 -right-20 h-48 w-48 rounded-full bg-neon-cyan/0 blur-3xl transition-all duration-500 group-hover:bg-neon-cyan/15" />
            <f.icon className={`h-7 w-7 ${f.accent}`} strokeWidth={1.5} />
            <h3 className="mt-5 text-xl font-bold">{f.title}</h3>
            <p className="mt-3 text-sm leading-relaxed text-white/55">
              {f.body}
            </p>
            <p className="mt-5 font-mono text-[11px] tracking-wider text-white/35">
              {f.code}
            </p>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
