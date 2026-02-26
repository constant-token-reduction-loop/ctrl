import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { ExternalLink } from "lucide-react";
import { MOCK_DATA } from "@/data/mockData";

const LINKS = [
  { label: "Burn Wallet", url: `https://solscan.io/account/${MOCK_DATA.wallets.burnWalletAddress}` },
  { label: "Token on Solscan", url: "https://solscan.io/token/CTRL_TOKEN_ADDRESS" },
  { label: "pump.fun Page", url: "https://pump.fun/CTRL" },
];

const Transparency = () => {
  return (
    <div className="min-h-screen bg-background">
      <div className="p-4 lg:p-6">
        <Navbar />
        <div className="mx-auto max-w-3xl space-y-4">
          <div className="keycap-inset p-4">
            <h2 className="mb-2 font-mono text-sm font-bold uppercase tracking-[0.2em]">Burn Wallet Address</h2>
            <div className="flex items-center justify-between">
              <span className="font-mono text-sm font-bold">{MOCK_DATA.wallets.burnWalletAddress}</span>
              <a
                href={`https://solscan.io/account/${MOCK_DATA.wallets.burnWalletAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs text-ctrl-blue hover:underline"
              >
                View on Solscan <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <div className="mt-3 border-t border-border/60 pt-3">
              <div className="mb-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">Contract Address</div>
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold">{MOCK_DATA.wallets.burnWalletAddress}</span>
                <a
                  href={`https://solscan.io/account/${MOCK_DATA.wallets.burnWalletAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 font-mono text-xs text-ctrl-blue hover:underline"
                >
                  View on Solscan <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          </div>

          <div className="keycap-inset p-4">
            <h2 className="mb-2 font-mono text-sm font-bold uppercase tracking-[0.2em]">Key Links</h2>
            <div className="space-y-2">
              {LINKS.map((link) => (
                <a
                  key={link.label}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between rounded-sm p-2 transition-colors hover:bg-accent"
                >
                  <span className="font-mono text-xs uppercase tracking-wider">{link.label}</span>
                  <ExternalLink className="h-3.5 w-3.5 text-ctrl-blue" />
                </a>
              ))}
            </div>
          </div>

          <div className="keycap-inset p-4">
            <h2 className="mb-2 font-mono text-sm font-bold uppercase tracking-[0.2em]">How to Verify</h2>
            <div className="space-y-2 font-mono text-xs leading-relaxed text-muted-foreground">
              <p><strong className="text-foreground">Step 1:</strong> Copy the burn wallet address above.</p>
              <p><strong className="text-foreground">Step 2:</strong> Go to Solscan.io and search for the address.</p>
              <p><strong className="text-foreground">Step 3:</strong> Review all incoming transactions — every CTRL token sent there is permanently burned.</p>
              <p><strong className="text-foreground">Step 4:</strong> Cross-reference with the dashboard's cycle counter and terminal feed.</p>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    </div>
  );
};

export default Transparency;

