import { Rocket, ArrowUpRight } from "lucide-react";
import { motion } from "framer-motion";

export default function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-white/10 bg-white/5 backdrop-blur-xl">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="#" className="text-lg font-extrabold tracking-tight">
          jira2ggsheet
        </a>

        <div className="hidden items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-[11px] text-white/70 sm:flex">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-neon-cyan opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-neon-cyan" />
          </span>
          cron */5 · sync live
        </div>

        <motion.a
          href="https://github.com/ntxinh/jira2ggsheet"
          target="_blank"
          rel="noreferrer"
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          transition={{ type: "spring", stiffness: 100, damping: 20 }}
          className="inline-flex items-center gap-2 rounded-2xl border border-neon-cyan/40 bg-neon-cyan/10 px-4 py-2 text-sm font-semibold text-white shadow-[0_0_24px_rgba(0,240,255,0.25),inset_0_0_12px_rgba(0,240,255,0.15)]"
        >
          <Rocket className="h-4 w-4" />
          Deploy your own
          <ArrowUpRight className="h-3.5 w-3.5 text-neon-cyan" />
        </motion.a>
      </nav>
    </header>
  );
}
