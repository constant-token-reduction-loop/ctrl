import { Link } from "react-router-dom";

export function Navbar() {
  return (
    <nav className="keycap-panel mx-auto mb-2 flex w-full items-center justify-start px-4 py-2">
      <Link to="/" className="font-mono text-lg font-bold tracking-widest">
        CTRL
      </Link>
    </nav>
  );
}
