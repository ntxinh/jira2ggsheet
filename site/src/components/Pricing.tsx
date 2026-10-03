import { motion } from "framer-motion";
import { Check, Rocket } from "lucide-react";

type Tier = {
  name: string;
  price: string;
  unit: string;
  tag: string;
  features: string[];
  featured?: boolean;
};

const TIERS: Tier[] = [
  {
    name: "Cloudflare Free",
    price: "$0",
    unit: "forever",
    tag: "the default",
    features: [
      "100k requests/day",
      "cron + webhooks covered",
      "DO alarms billed only while running",
      "zero ops",
    ],
  },
  {
    name: "Workers Paid",
    price: "$5",
    unit: "/month",
    tag: "headroom",
    featured: true,
    features: [
      "10M requests included",
      "30s wall-clock per tick",
      "huge boards, many sprints",
      "same code, one flag",
    ],
  },
  {
    name: "GAS legacy",
    price: "$0",
    unit: "deprecated",
    tag: "kept for reference",
    features: [
      "Google Apps Script",
      "no Durable Object resync",
      "slower upserts",
      "no new features",
    ],
  },
];

export default function Pricing() {
  return (
    <section className="mx-auto max-w-6xl px-6 py-28">
      <motion.h2
        initial={{ opacity: 0, y: 50 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-80px" }}
        transition={{ type: "spring", stiffness: 100, damping: 20 }}
        className="mb-14 text-3xl font-extrabold tracking-tight sm:text-4xl"
      >
        What it{" "}
        <span className="bg-gradient-to-r from-neon-purple to-neon-orange bg-clip-text text-transparent">
          costs to run
        </span>
      </motion.h2>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
        {TIERS.map((t, i) => (
          <motion.div
            key={t.name}
            initial={{ opacity: 0, y: 50 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{
              type: "spring",
              stiffness: 100,
              damping: 20,
              delay: i * 0.1,
            }}
            className={
              t.featured
                ? "relative rounded-3xl bg-gradient-to-r from-neon-cyan via-neon-purple to-neon-orange p-px shadow-[0_0_50px_rgba(176,38,255,0.3)]"
                : "rounded-3xl border border-white/10"
            }
          >
            <div
              className={`flex h-full flex-col rounded-3xl p-7 backdrop-blur-xl ${
                t.featured
                  ? "bg-[#0a0a0f]/90"
                  : "border border-transparent bg-white/5"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs tracking-widest text-white/50 uppercase">
                  {t.name}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                    t.featured
                      ? "border-neon-purple/50 text-neon-purple"
                      : "border-white/10 text-white/40"
                  }`}
                >
                  {t.tag}
                </span>
              </div>

              <div className="mt-6 flex items-baseline gap-2">
                <span className="font-mono text-5xl font-bold tracking-tight">
                  {t.price}
                </span>
                <span className="font-mono text-sm text-white/40">
                  {t.unit}
                </span>
              </div>

              <ul className="mt-7 flex-1 space-y-3">
                {t.features.map((f) => (
                  <li
                    key={f}
                    className="flex items-start gap-2.5 text-sm text-white/65"
                  >
                    <Check
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        t.featured ? "text-neon-cyan" : "text-white/30"
                      }`}
                    />
                    <span className="font-mono text-[13px]">{f}</span>
                  </li>
                ))}
              </ul>

              {t.featured && (
                <motion.a
                  href="https://github.com/ntxinh/jira2ggsheet/blob/main/SETUP.md"
                  target="_blank"
                  rel="noreferrer"
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 100, damping: 20 }}
                  className="mt-8 inline-flex items-center justify-center gap-2 rounded-2xl border border-neon-purple/50 bg-neon-purple/15 px-5 py-3 text-sm font-semibold shadow-[0_0_30px_rgba(176,38,255,0.35),inset_0_0_12px_rgba(176,38,255,0.2)]"
                >
                  <Rocket className="h-4 w-4" />
                  Deploy your own
                </motion.a>
              )}
            </div>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
