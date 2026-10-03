import { motion } from "framer-motion";
import { Rocket } from "lucide-react";

const HEADLINE = ["Jira", "issues.", "Google", "Sheets.", "Live."];

const ROWS: [string, string, string, string][] = [
  ["OPS-412", "In Progress", "kieu.linh", "bg-neon-cyan"],
  ["OPS-409", "To Do", "minh.tuan", "bg-white/50"],
  ["OPS-404", "Done", "anh.pham", "bg-emerald-400"],
  ["OPS-397", "In Review", "kieu.linh", "bg-neon-purple"],
  ["OPS-391", "Done", "quang.huy", "bg-emerald-400"],
];

const spring = { type: "spring", stiffness: 100, damping: 20 } as const;

export default function Hero() {
  return (
    <section className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-16 px-6 pt-40 pb-24 lg:grid-cols-2 lg:pt-48">
      <div>
        <h1 className="text-5xl font-black leading-[1.05] tracking-tight sm:text-6xl lg:text-7xl">
          {HEADLINE.map((word, i) => (
            <motion.span
              key={word}
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...spring, delay: 0.08 * i }}
              className="mr-[0.28em] inline-block bg-gradient-to-r from-neon-cyan via-neon-purple to-neon-orange bg-clip-text text-transparent"
            >
              {word}
            </motion.span>
          ))}
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring, delay: 0.5 }}
          className="mt-6 max-w-md text-lg leading-relaxed text-white/60"
        >
          A Cloudflare Worker turns Jira webhooks into rows — one Google Sheet
          tab per sprint, updated in near real-time. No servers, no bill.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...spring, delay: 0.65 }}
          className="mt-10"
        >
          <motion.a
            href="https://github.com/ntxinh/jira2ggsheet/blob/main/SETUP.md"
            target="_blank"
            rel="noreferrer"
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            transition={spring}
            className="inline-flex items-center gap-2 rounded-2xl border border-neon-cyan/50 bg-gradient-to-r from-neon-cyan/20 via-neon-purple/20 to-neon-orange/20 px-7 py-3.5 font-semibold shadow-[0_0_40px_rgba(176,38,255,0.35),inset_0_0_16px_rgba(0,240,255,0.2)]"
          >
            <Rocket className="h-5 w-5" />
            Deploy your own
          </motion.a>
        </motion.div>
      </div>

      {/* floating glass sprint-tab mockup */}
      <div className="[perspective:1200px]">
        <motion.div
          initial={{ opacity: 0, y: 60, rotateX: 14, rotateZ: -5 }}
          animate={{ opacity: 1, y: 0, rotateX: 14, rotateZ: -5 }}
          transition={{ ...spring, delay: 0.4 }}
        >
          <motion.div
            animate={{ y: [0, -15, 0] }}
            transition={{ duration: 5, repeat: Infinity, ease: "easeInOut" }}
            className="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-[0_40px_80px_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-xl"
          >
            <div className="mb-4 flex items-center justify-between border-b border-white/10 pb-3">
              <span className="font-mono text-xs text-white/80">
                690_Sprint 42
              </span>
              <span className="flex items-center gap-1.5 font-mono text-[10px] text-neon-cyan">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-neon-cyan" />
                webhook synced
              </span>
            </div>
            <div className="space-y-2">
              {ROWS.map(([key, status, assignee, dot]) => (
                <div
                  key={key}
                  className="flex items-center justify-between rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2.5 font-mono text-xs"
                >
                  <span className="text-white/85">{key}</span>
                  <span className="flex items-center gap-1.5 text-white/60">
                    <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                    {status}
                  </span>
                  <span className="hidden text-white/40 sm:block">
                    {assignee}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-between font-mono text-[10px] text-white/30">
              <span>KEY · STATUS · ASSIGNEE</span>
              <span>values:batchUpdate ✓</span>
            </div>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
