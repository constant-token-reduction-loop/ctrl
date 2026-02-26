import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";

const LOOP_STEPS = [
  { step: "01", icon: "ðŸ’°", title: "CLAIM REWARDS", desc: "Creator rewards from pump.fun are claimed automatically." },
  { step: "02", icon: "ðŸ›’", title: "BUY BACK TOKENS", desc: "All claimed SOL is used to buy CTRL tokens on the open market." },
  { step: "03", icon: "ðŸ”¥", title: "BURN", desc: "Purchased tokens are sent to the incinerator, permanently removing them from supply." },
  { step: "04", icon: "â±ï¸", title: "REPEAT", desc: "Wait 69 seconds. Do it again. Forever." },
];

const About = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="p-4 lg:p-6">
        <Navbar />
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="keycap-inset p-4">
            <h2 className="mb-3 font-mono text-sm font-bold uppercase tracking-[0.2em]">What Is CTRL?</h2>
            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
              <strong className="text-foreground">CTRL (Continuous Token Reduction Loop)</strong> is a fully automated, on-chain
              burn mechanism that runs every <strong className="text-foreground">69 seconds</strong>.
              It creates continuous deflationary pressure on the token supply by executing
              a simple, transparent loop:
            </p>
          </div>

          <div className="keycap-inset p-4">
            <h2 className="mb-3 font-mono text-sm font-bold uppercase tracking-[0.2em]">The Loop</h2>
            <div className="space-y-3">
              {LOOP_STEPS.map((item) => (
                <div key={item.step} className="flex items-start gap-3">
                  <span className="shrink-0 font-mono text-base font-bold text-muted-foreground">{item.step}</span>
                  <span className="shrink-0 text-lg">{item.icon}</span>
                  <div>
                    <div className="font-mono text-xs font-bold uppercase tracking-wider">{item.title}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="keycap-inset p-4">
            <h2 className="mb-3 font-mono text-sm font-bold uppercase tracking-[0.2em]">Transparency</h2>
            <p className="font-mono text-xs leading-relaxed text-muted-foreground">
              Total transparency. No trust required. Every transaction is verifiable on-chain.
              The bot runs publicly, the dashboard is live, and every burn is linked to a Solscan
              transaction.
            </p>
          </div>
        </div>
        <Footer />
      </div>
    </div>
  );
};

export default About;

